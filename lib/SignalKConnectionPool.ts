/**
 * Shared Multiplexed WebSocket & REST Connection Pool (`lib/SignalKConnectionPool.ts`).
 *
 * Implements Feature F5 (`PROJECT.md § 4.4`):
 *  - Multiplexes a single shared WebSocket per `serverId` connecting to `/signalk/v1/stream?subscribe=none`
 *  - Captures `hello.self` URN and normalizes incoming delta `context` (`vessels.self`, `self`, `hello.self`, or omitted)
 *    while ignoring non-self AIS target contexts
 *  - Tiered subscription & client-side throttling policies (`ThrottleTier`):
 *      - `fast`: `policy: "instant"`, `minPeriod: 200`
 *      - `medium`: `policy: "ideal"`, `period: 2000`, `minPeriod: 1000`
 *      - `slow`: `policy: "ideal"`, `period: 5000`, `minPeriod: 2500`
 *  - Wildcard `*` and `**` path matching + `$source` filtering (`sourceFilter`)
 *  - Exponential backoff auto-reconnect on unexpected close/error with automatic re-subscription
 *  - Dynamic mDNS IP/port update (`updateServerAddress`)
 *  - Bidirectional WebSocket delta publishing (`publishDelta` with `$source: "homey.<source>"`)
 *  - Safety-boundary enforced `putPath` delegation and authenticated REST `getVesselSubtree`
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';
import WebSocket from 'ws';
import {
  SignalKAuthManager,
  SignalKAuthError,
  DiscoveredEndpoints,
  performHttpRequest,
} from './SignalKAuthManager';
import { SignalKPutController, PutOptions, PutResult } from './SignalKPutController';
import { SafetyBoundary, ISafetyBoundary } from './SafetyBoundary';

export type ThrottleTier = 'fast' | 'medium' | 'slow';

export interface ServerConnectionConfig {
  serverId: string;
  host: string;
  port: number;
  useTls: boolean;
  allowSelfSigned?: boolean;
  token?: string;
  clientId?: string;
}

export interface PathUpdateEvent {
  path: string;
  value: unknown;
  $source: string;
  timestamp: string;
  source?: Record<string, any>;
  meta?: Record<string, any>;
}

export interface PathSubscription {
  subscriberId: string;
  path: string;
  tier: ThrottleTier;
  customMinPeriodMs?: number;
  sourceFilter?: string;
  onUpdate: (update: PathUpdateEvent) => void;
}

export interface ISignalKConnectionPool {
  acquireConnection(config: ServerConnectionConfig): Promise<void>;
  subscribe(serverId: string, sub: PathSubscription): () => void;
  updateServerAddress(serverId: string, host: string, port: number): Promise<void>;
  publishDelta(
    serverId: string,
    updates: Array<{
      path: string;
      value: unknown;
      $source?: string;
      sourceLabel?: string;
    }>,
  ): Promise<void>;
  putPath(
    serverId: string,
    path: string,
    value: unknown,
    options?: {
      source?: string;
      timeoutMs?: number;
    },
  ): Promise<{ state: 'COMPLETED' | 'PENDING' | 'FAILED'; statusCode: number; message?: string }>;
  getVesselSubtree(serverId: string, subPath?: string): Promise<Record<string, any>>;
  releaseConnection(serverId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface ConnectionPoolOptions {
  authManager?: SignalKAuthManager;
  putController?: SignalKPutController;
  safetyBoundary?: ISafetyBoundary;
  baseReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  handshakeTimeoutMs?: number;
}

export const TIER_POLICIES: Record<
  ThrottleTier,
  {
    policy: 'instant' | 'ideal';
    period?: number;
    minPeriod: number;
  }
> = {
  fast: { policy: 'instant', minPeriod: 200 },
  medium: { policy: 'ideal', period: 2000, minPeriod: 1000 },
  slow: { policy: 'ideal', period: 5000, minPeriod: 2500 },
};

interface InternalSubscription extends PathSubscription {
  handleId: string;
  matcher: (actualPath: string) => boolean;
  effectiveMinPeriodMs: number;
  lastEmitByPath: Map<string, number>;
  lastNotificationStateByPath: Map<string, string>;
}

interface ManagedServerEntry {
  config: ServerConnectionConfig;
  endpoints: DiscoveredEndpoints;
  ws: WebSocket | null;
  connectingPromise: Promise<void> | null;
  selfUrn: string;
  helloReceived: boolean;
  connected: boolean;
  closedExplicitly: boolean;
  reconnectAttempt: number;
  reconnectTimer: NodeJS.Timeout | null;
  subscriptions: Map<string, InternalSubscription>;
}

/**
 * Matches an actual Signal K dot-path against a subscription pattern supporting `*` and `**`.
 * Trailing `.*` matches the entire subtree under that prefix (per Signal K subscription spec),
 * while mid-path `*` matches a single dot-separated segment.
 */
export function matchesPathPattern(pattern: string, actualPath: string): boolean {
  if (pattern === '*' || pattern === '**' || pattern === actualPath) {
    return true;
  }
  if (!pattern.includes('*')) {
    return false;
  }

  const segments = pattern.split('.');
  const regexParts = segments.map((seg, idx) => {
    if (seg === '**') {
      return '.+';
    }
    if (seg === '*') {
      return idx === segments.length - 1 ? '.+' : '[^.]+';
    }
    return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  });

  const regex = new RegExp(`^${regexParts.join('\\.')}$`);
  return regex.test(actualPath);
}

/**
 * Checks whether an incoming delta `context` targets the own vessel (`self`).
 */
export function isSelfContext(context: unknown, selfUrn: string): boolean {
  if (context === undefined || context === null || context === '') {
    return true;
  }
  if (typeof context !== 'string') {
    return false;
  }
  const trimmed = context.trim();
  if (trimmed === 'vessels.self' || trimmed === 'self' || trimmed === selfUrn) {
    return true;
  }
  if (selfUrn.startsWith('vessels.') && trimmed === selfUrn.slice('vessels.'.length)) {
    return true;
  }
  if (!selfUrn.startsWith('vessels.') && trimmed === `vessels.${selfUrn}`) {
    return true;
  }
  return false;
}

/**
 * Extracts normalized `$source` identifier from a Signal K delta update entry.
 */
export function resolveUpdateSource(update: Record<string, any>): string {
  if (typeof update.$source === 'string' && update.$source.trim().length > 0) {
    return update.$source.trim();
  }
  if (update.source && typeof update.source === 'object') {
    const label = update.source.label ? String(update.source.label).trim() : '';
    const src =
      update.source.src !== undefined && update.source.src !== null
        ? `.${String(update.source.src).trim()}`
        : '';
    if (label) {
      return `${label}${src}`;
    }
  }
  return 'unknown';
}

function buildDefaultEndpoints(config: ServerConnectionConfig): DiscoveredEndpoints {
  const httpScheme = config.useTls ? 'https' : 'http';
  const wsScheme = config.useTls ? 'wss' : 'ws';
  return {
    httpUrl: `${httpScheme}://${config.host}:${config.port}/signalk/v1/api/`,
    wsUrl: `${wsScheme}://${config.host}:${config.port}/signalk/v1/stream`,
    version: '1.7.0',
  };
}

export class SignalKConnectionPool extends EventEmitter implements ISignalKConnectionPool {
  private readonly servers = new Map<string, ManagedServerEntry>();
  private readonly authManager: SignalKAuthManager;
  private readonly putController: SignalKPutController;
  private readonly safetyBoundary: ISafetyBoundary;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly handshakeTimeoutMs: number;

  constructor(options?: ConnectionPoolOptions) {
    super();
    this.safetyBoundary = options?.safetyBoundary ?? new SafetyBoundary();
    this.authManager = options?.authManager ?? new SignalKAuthManager();
    this.putController = options?.putController ?? new SignalKPutController(this.safetyBoundary);
    this.baseReconnectDelayMs = options?.baseReconnectDelayMs ?? 500;
    this.maxReconnectDelayMs = options?.maxReconnectDelayMs ?? 30000;
    this.handshakeTimeoutMs = options?.handshakeTimeoutMs ?? 5000;
  }

  /**
   * Acquires or reuses the single shared WebSocket connection for `config.serverId`.
   */
  public async acquireConnection(config: ServerConnectionConfig): Promise<void> {
    const existing = this.servers.get(config.serverId);

    if (existing) {
      const sameTarget =
        existing.config.host === config.host &&
        existing.config.port === config.port &&
        Boolean(existing.config.useTls) === Boolean(config.useTls) &&
        (existing.config.token || '') === (config.token || '');

      existing.config = { ...existing.config, ...config };
      existing.closedExplicitly = false;

      if (sameTarget) {
        if (existing.connected && existing.ws && existing.ws.readyState === WebSocket.OPEN) {
          return;
        }
        if (existing.connectingPromise) {
          return existing.connectingPromise;
        }
      } else {
        await this.teardownSocket(existing, false);
        existing.endpoints = await this.resolveEndpointsWithFallback(existing.config);
      }

      return this.connectWebSocket(existing);
    }

    const endpoints = await this.resolveEndpointsWithFallback(config);
    const entry: ManagedServerEntry = {
      config: { ...config },
      endpoints,
      ws: null,
      connectingPromise: null,
      selfUrn: 'vessels.self',
      helloReceived: false,
      connected: false,
      closedExplicitly: false,
      reconnectAttempt: 0,
      reconnectTimer: null,
      subscriptions: new Map(),
    };

    this.servers.set(config.serverId, entry);
    return this.connectWebSocket(entry);
  }

  /**
   * Registers a path subscription on the shared server connection and returns an `unsubscribe` callback.
   */
  public subscribe(serverId: string, sub: PathSubscription): () => void {
    let entry = this.servers.get(serverId);
    if (!entry) {
      // Allow pre-registering subscriptions before acquireConnection is called
      const placeholderConfig: ServerConnectionConfig = {
        serverId,
        host: '127.0.0.1',
        port: 3000,
        useTls: false,
      };
      entry = {
        config: placeholderConfig,
        endpoints: buildDefaultEndpoints(placeholderConfig),
        ws: null,
        connectingPromise: null,
        selfUrn: 'vessels.self',
        helloReceived: false,
        connected: false,
        closedExplicitly: false,
        reconnectAttempt: 0,
        reconnectTimer: null,
        subscriptions: new Map(),
      };
      this.servers.set(serverId, entry);
    }

    const tierPolicy = TIER_POLICIES[sub.tier] ?? TIER_POLICIES.medium;
    const effectiveMinPeriodMs =
      typeof sub.customMinPeriodMs === 'number' &&
      Number.isFinite(sub.customMinPeriodMs) &&
      sub.customMinPeriodMs >= 0
        ? sub.customMinPeriodMs
        : tierPolicy.minPeriod;

    const handleId = `${sub.subscriberId}:${sub.path}:${crypto.randomUUID()}`;
    const internalSub: InternalSubscription = {
      ...sub,
      handleId,
      matcher: (actualPath: string) => matchesPathPattern(sub.path, actualPath),
      effectiveMinPeriodMs,
      lastEmitByPath: new Map(),
      lastNotificationStateByPath: new Map(),
    };

    entry.subscriptions.set(handleId, internalSub);

    if (entry.connected && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      this.sendSubscribeMessage(entry, [internalSub]);
    }

    return () => {
      const currentEntry = this.servers.get(serverId);
      if (!currentEntry) {
        return;
      }
      const removed = currentEntry.subscriptions.delete(handleId);
      if (!removed) {
        return;
      }

      // Only send unsubscribe to server if no other subscriber on this connection uses the same path
      const stillSubscribedToPath = Array.from(currentEntry.subscriptions.values()).some(
        (s) => s.path === sub.path,
      );
      if (
        !stillSubscribedToPath &&
        currentEntry.connected &&
        currentEntry.ws &&
        currentEntry.ws.readyState === WebSocket.OPEN
      ) {
        try {
          currentEntry.ws.send(
            JSON.stringify({
              context: 'vessels.self',
              unsubscribe: [{ path: sub.path }],
            }),
          );
        } catch {
          // Ignore send errors on closing socket
        }
      }
    };
  }

  /**
   * Handles mDNS `onDiscoveryAddressChanged` by migrating the server connection to the new `host:port`
   * and automatically re-subscribing all active device subscriptions.
   */
  public async updateServerAddress(serverId: string, host: string, port: number): Promise<void> {
    let entry = this.servers.get(serverId);
    if (!entry) {
      await this.acquireConnection({
        serverId,
        host,
        port,
        useTls: false,
      });
      return;
    }

    entry.config.host = host.trim();
    entry.config.port = port;
    entry.closedExplicitly = false;
    entry.reconnectAttempt = 0;

    await this.teardownSocket(entry, false);
    entry.endpoints = await this.resolveEndpointsWithFallback(entry.config);
    await this.connectWebSocket(entry);
  }

  /**
   * Publishes Homey sensor values or notification alarms back into Signal K over the WebSocket delta stream.
   */
  public async publishDelta(
    serverId: string,
    updates: Array<{
      path: string;
      value: unknown;
      $source?: string;
      sourceLabel?: string;
    }>,
  ): Promise<void> {
    if (!Array.isArray(updates) || updates.length === 0) {
      return;
    }

    const entry = this.servers.get(serverId);
    if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Signal K WebSocket is not connected for server "${serverId}"`);
    }

    const timestamp = new Date().toISOString();
    const groupedBySource = new Map<
      string,
      {
        $source: string;
        sourceLabel: string;
        values: Array<{ path: string; value: unknown }>;
      }
    >();

    for (const item of updates) {
      if (!item || typeof item.path !== 'string' || !item.path.trim()) {
        continue;
      }
      let rawSource =
        typeof item.$source === 'string' && item.$source.trim().length > 0
          ? item.$source.trim()
          : 'homey.bridge';
      if (!rawSource.toLowerCase().startsWith('homey')) {
        rawSource = `homey.${rawSource}`;
      }

      const sourceLabel =
        typeof item.sourceLabel === 'string' && item.sourceLabel.trim().length > 0
          ? item.sourceLabel.trim()
          : 'Homey Pro Smart Boat Bridge';

      let group = groupedBySource.get(rawSource);
      if (!group) {
        group = {
          $source: rawSource,
          sourceLabel,
          values: [],
        };
        groupedBySource.set(rawSource, group);
      }

      group.values.push({
        path: item.path.trim(),
        value: item.value,
      });
    }

    if (groupedBySource.size === 0) {
      return;
    }

    const deltaPayload = {
      context: 'vessels.self',
      updates: Array.from(groupedBySource.values()).map((g) => ({
        $source: g.$source,
        source: {
          label: g.sourceLabel,
          type: 'Homey',
        },
        timestamp,
        values: g.values,
      })),
    };

    const jsonString = JSON.stringify(deltaPayload);
    await new Promise<void>((resolve, reject) => {
      entry.ws!.send(jsonString, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Executes a safety-validated PUT request for `path` with `value` via `SignalKPutController`.
   */
  public async putPath(
    serverId: string,
    path: string,
    value: unknown,
    options?: PutOptions,
  ): Promise<PutResult> {
    // SafetyBoundary is enforced inside putController.putPath before inspecting server connection
    this.safetyBoundary.assertWritablePath(path);

    const entry = this.servers.get(serverId);
    if (!entry) {
      return {
        state: 'FAILED',
        statusCode: 404,
        message: `Unknown Signal K server connection "${serverId}"`,
      };
    }

    return this.putController.putPath(
      {
        ...entry.config,
        httpEndpoint: entry.endpoints.httpUrl,
      },
      path,
      value,
      options,
    );
  }

  /**
   * Queries `GET /signalk/v1/api/vessels/self[/<subPath>]` and returns the parsed JSON subtree.
   */
  public async getVesselSubtree(
    serverId: string,
    subPath?: string,
  ): Promise<Record<string, any>> {
    const entry = this.servers.get(serverId);
    if (!entry) {
      throw new Error(`Unknown Signal K server connection "${serverId}"`);
    }

    const baseApiUrl = entry.endpoints.httpUrl.endsWith('/')
      ? entry.endpoints.httpUrl
      : `${entry.endpoints.httpUrl}/`;

    let slashSuffix = '';
    if (typeof subPath === 'string' && subPath.trim().length > 0) {
      const cleaned = subPath
        .trim()
        .replace(/^\/?vessels\/self\/?/i, '')
        .replace(/^vessels\.self\./i, '')
        .replace(/\./g, '/')
        .replace(/^\/+|\/+$/g, '');
      if (cleaned.length > 0) {
        slashSuffix = `/${cleaned}`;
      }
    }

    const url = `${baseApiUrl}vessels/self${slashSuffix}`;
    const headers: Record<string, string> = {};
    if (entry.config.token && entry.config.token.trim().length > 0) {
      headers.Authorization = `Bearer ${entry.config.token.trim()}`;
    }

    const res = await performHttpRequest({
      method: 'GET',
      url,
      headers,
      allowSelfSigned: entry.config.allowSelfSigned,
      timeoutMs: 8000,
    });

    if (res.statusCode === 200) {
      return res.data && typeof res.data === 'object' ? res.data : {};
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      this.emit('authError', { serverId, statusCode: res.statusCode });
      throw new SignalKAuthError(
        `Authentication failed (${res.statusCode}) fetching vessel subtree`,
        'UNAUTHORIZED',
        res.statusCode,
      );
    }

    if (res.statusCode === 404 && slashSuffix.length > 0) {
      return {};
    }

    throw new Error(`Failed to fetch Signal K vessel subtree (${url}): HTTP ${res.statusCode}`);
  }

  /**
   * Closes and removes a specific server connection from the pool.
   */
  public async releaseConnection(serverId: string): Promise<void> {
    const entry = this.servers.get(serverId);
    if (!entry) {
      return;
    }
    entry.closedExplicitly = true;
    await this.teardownSocket(entry, true);
    this.servers.delete(serverId);
  }

  /**
   * Gracefully closes all managed WebSocket connections and clears all reconnect timers.
   */
  public async closeAll(): Promise<void> {
    const serverIds = Array.from(this.servers.keys());
    await Promise.all(serverIds.map((id) => this.releaseConnection(id)));
  }

  /**
   * Returns diagnostic status for a managed `serverId` (used by drivers and tests).
   */
  public getConnectionStatus(serverId: string): {
    connected: boolean;
    selfUrn: string;
    subscriptionCount: number;
    host?: string;
    port?: number;
  } {
    const entry = this.servers.get(serverId);
    if (!entry) {
      return {
        connected: false,
        selfUrn: 'vessels.self',
        subscriptionCount: 0,
      };
    }
    return {
      connected: entry.connected && entry.ws?.readyState === WebSocket.OPEN,
      selfUrn: entry.selfUrn,
      subscriptionCount: entry.subscriptions.size,
      host: entry.config.host,
      port: entry.config.port,
    };
  }

  private async resolveEndpointsWithFallback(
    config: ServerConnectionConfig,
  ): Promise<DiscoveredEndpoints> {
    try {
      return await this.authManager.discoverEndpoints(
        config.host,
        config.port,
        config.useTls,
        Boolean(config.allowSelfSigned),
        this.handshakeTimeoutMs,
      );
    } catch {
      return buildDefaultEndpoints(config);
    }
  }

  private connectWebSocket(entry: ManagedServerEntry): Promise<void> {
    if (entry.connectingPromise) {
      return entry.connectingPromise;
    }

    const promise = new Promise<void>((resolve, reject) => {
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
      }

      let wsUrlObj: URL;
      try {
        wsUrlObj = new URL(entry.endpoints.wsUrl);
      } catch {
        const defaults = buildDefaultEndpoints(entry.config);
        wsUrlObj = new URL(defaults.wsUrl);
      }
      wsUrlObj.searchParams.set('subscribe', 'none');
      const finalWsUrl = wsUrlObj.toString();

      const headers: Record<string, string> = {};
      if (entry.config.token && entry.config.token.trim().length > 0) {
        headers.Authorization = `Bearer ${entry.config.token.trim()}`;
      }

      const ws = new WebSocket(finalWsUrl, {
        headers,
        rejectUnauthorized: !entry.config.allowSelfSigned,
        handshakeTimeout: this.handshakeTimeoutMs,
      });

      entry.ws = ws;
      let settled = false;

      const onUnexpectedResponse = (_req: any, res: any) => {
        const statusCode: number = res?.statusCode ?? 0;
        if (statusCode === 401 || statusCode === 403) {
          this.emit('authError', {
            serverId: entry.config.serverId,
            statusCode,
          });
          entry.closedExplicitly = true; // Do not spin reconnect loop on revoked token
          if (!settled) {
            settled = true;
            entry.connectingPromise = null;
            reject(
              new SignalKAuthError(
                `WebSocket authentication failed with HTTP ${statusCode}`,
                'UNAUTHORIZED',
                statusCode,
              ),
            );
          }
          try {
            ws.terminate();
          } catch {
            // ignore
          }
        }
      };

      ws.on('unexpected-response', onUnexpectedResponse);

      ws.on('open', () => {
        if (entry.ws !== ws) {
          return;
        }
        entry.connected = true;
        entry.reconnectAttempt = 0;
        entry.connectingPromise = null;

        // Re-send consolidated subscribe message for all active subscriptions
        if (entry.subscriptions.size > 0) {
          this.sendSubscribeMessage(entry, Array.from(entry.subscriptions.values()));
        }

        this.emit('connected', {
          serverId: entry.config.serverId,
          host: entry.config.host,
          port: entry.config.port,
        });

        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (rawData: WebSocket.RawData) => {
        if (entry.ws !== ws) {
          return;
        }
        this.handleIncomingFrame(entry, rawData);
      });

      ws.on('error', (err: Error) => {
        if (entry.ws !== ws) {
          return;
        }
        this.emit('connectionError', {
          serverId: entry.config.serverId,
          error: err,
        });
        if (!settled) {
          settled = true;
          entry.connectingPromise = null;
          reject(err);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (entry.ws !== ws) {
          return;
        }
        entry.connected = false;
        entry.ws = null;
        entry.connectingPromise = null;

        this.emit('disconnected', {
          serverId: entry.config.serverId,
          code,
          reason: reason ? reason.toString('utf8') : '',
        });

        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before open (code ${code})`));
        }

        if (!entry.closedExplicitly && this.servers.has(entry.config.serverId)) {
          this.scheduleReconnect(entry);
        }
      });
    });

    entry.connectingPromise = promise;
    return promise;
  }

  private scheduleReconnect(entry: ManagedServerEntry): void {
    if (entry.closedExplicitly || entry.reconnectTimer) {
      return;
    }

    const attempt = entry.reconnectAttempt++;
    const delayMs = Math.min(
      this.maxReconnectDelayMs,
      this.baseReconnectDelayMs * Math.pow(2, attempt),
    );

    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      if (entry.closedExplicitly || !this.servers.has(entry.config.serverId)) {
        return;
      }
      this.connectWebSocket(entry).catch(() => {
        // Error is handled by close/error handlers which schedule next backoff attempt
      });
    }, delayMs);

    if (typeof entry.reconnectTimer.unref === 'function') {
      entry.reconnectTimer.unref();
    }
  }

  private sendSubscribeMessage(entry: ManagedServerEntry, subs: InternalSubscription[]): void {
    if (!entry.ws || entry.ws.readyState !== WebSocket.OPEN || subs.length === 0) {
      return;
    }

    // Consolidate by path choosing the fastest tier (minimum minPeriod)
    const byPath = new Map<
      string,
      {
        path: string;
        policy: 'instant' | 'ideal';
        period?: number;
        minPeriod: number;
        format: 'delta';
      }
    >();

    for (const sub of subs) {
      const tierObj = TIER_POLICIES[sub.tier] ?? TIER_POLICIES.medium;
      const minPeriod = sub.effectiveMinPeriodMs;
      const existing = byPath.get(sub.path);
      if (!existing || minPeriod < existing.minPeriod) {
        byPath.set(sub.path, {
          path: sub.path,
          policy: tierObj.policy,
          ...(tierObj.period !== undefined ? { period: tierObj.period } : {}),
          minPeriod,
          format: 'delta',
        });
      }
    }

    const payload = {
      context: 'vessels.self',
      subscribe: Array.from(byPath.values()),
    };

    try {
      entry.ws.send(JSON.stringify(payload));
    } catch {
      // Ignore send errors on closing socket
    }
  }

  private handleIncomingFrame(entry: ManagedServerEntry, rawData: WebSocket.RawData): void {
    let text: string;
    if (typeof rawData === 'string') {
      text = rawData;
    } else if (Buffer.isBuffer(rawData)) {
      text = rawData.toString('utf8');
    } else if (Array.isArray(rawData)) {
      text = Buffer.concat(rawData).toString('utf8');
    } else {
      text = Buffer.from(rawData as ArrayBuffer).toString('utf8');
    }

    if (!text || text.trim().length === 0) {
      return;
    }

    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') {
      return;
    }

    // 1. Check for initial Signal K hello message
    if (
      typeof msg.self === 'string' &&
      !Array.isArray(msg.updates) &&
      (typeof msg.version === 'string' || typeof msg.name === 'string' || Array.isArray(msg.roles))
    ) {
      entry.selfUrn = msg.self.trim();
      entry.helloReceived = true;
      this.emit('hello', {
        serverId: entry.config.serverId,
        self: entry.selfUrn,
        version: msg.version,
        name: msg.name,
      });
      return;
    }

    // 2. Check for Signal K delta message targeting own vessel
    if (!Array.isArray(msg.updates)) {
      return;
    }

    if (!isSelfContext(msg.context, entry.selfUrn)) {
      // Ignore AIS targets / other vessels
      return;
    }

    const nowMs = Date.now();
    const activeSubs = Array.from(entry.subscriptions.values());
    if (activeSubs.length === 0) {
      return;
    }

    for (const updateBlock of msg.updates) {
      if (!updateBlock || typeof updateBlock !== 'object') {
        continue;
      }

      const resolvedSource = resolveUpdateSource(updateBlock);
      const timestamp =
        typeof updateBlock.timestamp === 'string' && updateBlock.timestamp.length > 0
          ? updateBlock.timestamp
          : new Date(nowMs).toISOString();

      if (!Array.isArray(updateBlock.values)) {
        continue;
      }

      for (const valueEntry of updateBlock.values) {
        if (!valueEntry || typeof valueEntry !== 'object') {
          continue;
        }
        const actualPath = typeof valueEntry.path === 'string' ? valueEntry.path : '';
        if (!actualPath) {
          continue;
        }

        const value = valueEntry.value;

        for (const sub of activeSubs) {
          if (!sub.matcher(actualPath)) {
            continue;
          }

          // Optional $source filtering
          if (sub.sourceFilter && sub.sourceFilter.trim().length > 0) {
            const filter = sub.sourceFilter.trim();
            const rawLabel =
              updateBlock.source && typeof updateBlock.source.label === 'string'
                ? updateBlock.source.label
                : '';
            const matchesSource =
              resolvedSource === filter ||
              rawLabel === filter ||
              resolvedSource.startsWith(`${filter}.`);
            if (!matchesSource) {
              continue;
            }
          }

          // Client-side rate limiting with immediate bypass for:
          //  - First value received for this path
          //  - value === null (lost sensor fix or alarm cleared)
          //  - notifications.* state changes
          const lastEmit = sub.lastEmitByPath.get(actualPath);
          const isNotification = actualPath.startsWith('notifications.');
          let notificationStateChanged = false;
          if (isNotification && value && typeof value === 'object' && 'state' in (value as any)) {
            const newState = String((value as any).state ?? '');
            const prevState = sub.lastNotificationStateByPath.get(actualPath);
            if (prevState !== newState) {
              notificationStateChanged = true;
              sub.lastNotificationStateByPath.set(actualPath, newState);
            }
          }

          const shouldBypassThrottle =
            lastEmit === undefined ||
            value === null ||
            notificationStateChanged ||
            sub.effectiveMinPeriodMs <= 0;

          if (!shouldBypassThrottle && nowMs - lastEmit! < sub.effectiveMinPeriodMs) {
            continue;
          }

          sub.lastEmitByPath.set(actualPath, nowMs);

          try {
            sub.onUpdate({
              path: actualPath,
              value,
              $source: resolvedSource,
              timestamp,
              source:
                updateBlock.source && typeof updateBlock.source === 'object'
                  ? updateBlock.source
                  : undefined,
            });
          } catch {
            // Isolate subscriber callback errors so one device cannot disrupt others
          }
        }
      }
    }
  }

  private async teardownSocket(entry: ManagedServerEntry, clearSubscriptions: boolean): Promise<void> {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }

    if (clearSubscriptions) {
      entry.subscriptions.clear();
    }

    const ws = entry.ws;
    entry.ws = null;
    entry.connected = false;
    entry.connectingPromise = null;

    if (!ws) {
      return;
    }

    await new Promise<void>((resolve) => {
      const done = () => {
        ws.removeAllListeners();
        resolve();
      };
      if (ws.readyState === WebSocket.CLOSED) {
        return done();
      }
      const timeout = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        done();
      }, 300);
      if (typeof timeout.unref === 'function') {
        timeout.unref();
      }
      ws.once('close', () => {
        clearTimeout(timeout);
        done();
      });
      try {
        ws.close();
      } catch {
        clearTimeout(timeout);
        done();
      }
    });
  }
}

export const signalKConnectionPool = new SignalKConnectionPool();
export default SignalKConnectionPool;
