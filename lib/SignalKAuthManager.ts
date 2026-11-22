/**
 * Signal K Discovery, Authentication & Access Request Manager (`lib/SignalKAuthManager.ts`).
 *
 * Implements Feature F4:
 *  - `GET /signalk` endpoint discovery (`discoverEndpoints`) with NAT / `.local` hostname normalization
 *    and fallback to standard `/signalk/v1/api/` and `/signalk/v1/stream`
 *  - Persistent RFC 4122 UUIDv4 `clientId` generation & validation (`generateClientId`, `isValidUuidV4`, `ensureClientId`)
 *  - `POST /signalk/v1/access/requests` (`requestAccess`) with `permissions: "readwrite"`, handling:
 *      - `202 Accepted` (`PENDING` with `href`)
 *      - `200 OK` (`APPROVED` with immediate token)
 *      - `501 Not Implemented` / `404 Not Found` (`UNSUPPORTED_READONLY` fallback)
 *      - `400 Bad Request` / `403 Forbidden` (`SignalKAuthError`)
 *  - `GET <href>` approval polling (`pollAccessRequest`, `waitForApproval`) enforcing the Signal K
 *    specification minimum poll interval `>= 500ms`
 *  - `validateToken` against `/signalk/v1/api/vessels/self`
 *  - Self-signed HTTPS TLS certificate support (`allowSelfSigned`) using native `node:http` / `node:https`
 */

import * as http from 'node:http';
import * as https from 'node:https';
import * as crypto from 'node:crypto';
import { URL } from 'node:url';

export class SignalKAuthError extends Error {
  public readonly statusCode?: number;
  public readonly code: string;

  constructor(message: string, code: string = 'AUTH_ERROR', statusCode?: number) {
    super(message);
    this.name = 'SignalKAuthError';
    this.code = code;
    this.statusCode = statusCode;
    Object.setPrototypeOf(this, SignalKAuthError.prototype);
  }
}

export interface HttpRequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  allowSelfSigned?: boolean;
  timeoutMs?: number;
}

export interface HttpResponseResult<T = any> {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  data: T;
  rawText: string;
}

export interface DiscoveredEndpoints {
  httpUrl: string;
  wsUrl: string;
  version: string;
  serverId?: string;
  serverVersion?: string;
}

export interface AccessRequestInput {
  host: string;
  port: number;
  useTls?: boolean;
  allowSelfSigned?: boolean;
  clientId?: string;
  description?: string;
  permissions?: 'readonly' | 'readwrite' | 'admin';
  timeoutMs?: number;
}

export interface AccessRequestSubmissionResult {
  state: 'PENDING' | 'APPROVED' | 'DENIED' | 'UNSUPPORTED_READONLY';
  statusCode: number;
  clientId: string;
  requestId?: string;
  href?: string;
  token?: string;
  readonlyFallback?: boolean;
  message?: string;
}

export interface PollAccessRequestInput {
  host: string;
  port: number;
  useTls?: boolean;
  allowSelfSigned?: boolean;
  href: string;
  timeoutMs?: number;
}

export interface AccessRequestPollResult {
  state: 'PENDING' | 'APPROVED' | 'DENIED' | 'EXPIRED';
  statusCode: number;
  token?: string;
  permission?: 'APPROVED' | 'DENIED';
  message?: string;
}

export interface WaitForApprovalInput extends AccessRequestInput {
  href?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  signal?: AbortSignal;
  onTick?: (pollResult: AccessRequestPollResult) => void;
}

export interface ValidateTokenInput {
  host: string;
  port: number;
  useTls?: boolean;
  allowSelfSigned?: boolean;
  token?: string;
  timeoutMs?: number;
}

export interface ValidateTokenResult {
  valid: boolean;
  statusCode: number;
  vesselName?: string;
  vesselSelf?: string;
  message?: string;
}

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Executes an HTTP or HTTPS request using Node's native `http` / `https` modules,
 * supporting `allowSelfSigned` TLS certificates without modifying global process flags.
 */
export function performHttpRequest<T = any>(
  options: HttpRequestOptions,
): Promise<HttpResponseResult<T>> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.url);
    } catch {
      return reject(new Error(`Invalid URL: ${options.url}`));
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const bodyString = options.body !== undefined ? JSON.stringify(options.body) : undefined;

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(bodyString !== undefined
        ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyString, 'utf8').toString(),
          }
        : {}),
      ...(options.headers || {}),
    };

    const reqOptions: https.RequestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method: options.method,
      headers,
      timeout: options.timeoutMs ?? 8000,
      ...(isHttps ? { rejectUnauthorized: !options.allowSelfSigned } : {}),
    };

    const req = transport.request(reqOptions, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const rawText = Buffer.concat(chunks).toString('utf8');
        let data: any = rawText;
        if (rawText.trim().length > 0) {
          try {
            data = JSON.parse(rawText);
          } catch {
            // Keep rawText if non-JSON response
          }
        } else {
          data = {};
        }
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          data: data as T,
          rawText,
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(
        new Error(
          `Request timed out after ${options.timeoutMs ?? 8000}ms: ${options.method} ${options.url}`,
        ),
      );
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (bodyString !== undefined) {
      req.write(bodyString);
    }
    req.end();
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new SignalKAuthError('Operation aborted', 'ABORTED', 499));
    }
    const timer = setTimeout(() => {
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SignalKAuthError('Operation aborted', 'ABORTED', 499));
    };
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Normalizes an endpoint URL discovered from `/signalk` so that its pathname is preserved
 * while binding to the reachable `host`, `port`, and TLS scheme used by the client.
 */
function normalizeDiscoveredUrl(
  rawUrl: unknown,
  host: string,
  port: number,
  useTls: boolean,
  isWebSocket: boolean,
  ensureTrailingSlash: boolean,
): string {
  const scheme = isWebSocket ? (useTls ? 'wss' : 'ws') : useTls ? 'https' : 'http';
  const defaultPath = isWebSocket ? '/signalk/v1/stream' : '/signalk/v1/api/';

  let pathname = defaultPath;
  let search = '';
  if (typeof rawUrl === 'string' && rawUrl.trim().length > 0) {
    try {
      const parsed = new URL(rawUrl.trim(), `${scheme}://${host}:${port}`);
      pathname = parsed.pathname || defaultPath;
      search = parsed.search || '';
    } catch {
      pathname = defaultPath;
    }
  }

  if (ensureTrailingSlash && !pathname.endsWith('/')) {
    pathname = `${pathname}/`;
  }

  return `${scheme}://${host}:${port}${pathname}${search}`;
}

export class SignalKAuthManager {
  /**
   * Returns true if `value` is a valid RFC 4122 version 4 UUID.
   */
  public static isValidUuidV4(value: unknown): value is string {
    return typeof value === 'string' && UUID_V4_REGEX.test(value.trim());
  }

  /**
   * Generates a new cryptographically random RFC 4122 v4 UUID.
   */
  public static generateClientId(): string {
    return crypto.randomUUID().toLowerCase();
  }

  /**
   * Validates an existing `clientId` (throwing `SignalKAuthError` if malformed)
   * or generates a new UUIDv4 if omitted/empty.
   */
  public static ensureClientId(clientId?: string): string {
    if (clientId === undefined || clientId === null || clientId.trim() === '') {
      return SignalKAuthManager.generateClientId();
    }
    const trimmed = clientId.trim();
    if (!SignalKAuthManager.isValidUuidV4(trimmed)) {
      throw new SignalKAuthError(
        `Invalid clientId "${clientId}": must be a valid RFC 4122 v4 UUID.`,
        'INVALID_CLIENT_ID',
        400,
      );
    }
    return trimmed.toLowerCase();
  }

  public isValidUuidV4(value: unknown): value is string {
    return SignalKAuthManager.isValidUuidV4(value);
  }

  public generateClientId(): string {
    return SignalKAuthManager.generateClientId();
  }

  public ensureClientId(clientId?: string): string {
    return SignalKAuthManager.ensureClientId(clientId);
  }

  /**
   * Queries `GET /signalk` to discover REST and WebSocket v1 endpoints.
   * Falls back to `/signalk/v1/api/` and `/signalk/v1/stream` if `endpoints.v1` is omitted.
   */
  public async discoverEndpoints(
    host: string,
    port: number,
    useTls: boolean = false,
    allowSelfSigned: boolean = false,
    timeoutMs: number = 5000,
  ): Promise<DiscoveredEndpoints> {
    const cleanHost = typeof host === 'string' ? host.trim() : '';
    if (!cleanHost) {
      throw new SignalKAuthError('Host is required for Signal K discovery', 'INVALID_HOST', 400);
    }
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SignalKAuthError(`Invalid port: ${port}`, 'INVALID_PORT', 400);
    }

    const httpScheme = useTls ? 'https' : 'http';
    const discoveryUrl = `${httpScheme}://${cleanHost}:${port}/signalk`;

    let res: HttpResponseResult<any>;
    try {
      res = await performHttpRequest({
        method: 'GET',
        url: discoveryUrl,
        allowSelfSigned,
        timeoutMs,
      });
    } catch (err: any) {
      throw new SignalKAuthError(
        `Failed to connect to Signal K server at ${discoveryUrl}: ${err?.message || String(err)}`,
        'DISCOVERY_NETWORK_ERROR',
      );
    }

    if (res.statusCode >= 400) {
      throw new SignalKAuthError(
        `Signal K discovery endpoint returned HTTP ${res.statusCode}`,
        'DISCOVERY_HTTP_ERROR',
        res.statusCode,
      );
    }

    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const v1 = data?.endpoints?.v1;

    const httpUrl = normalizeDiscoveredUrl(
      v1?.['signalk-http'],
      cleanHost,
      port,
      useTls,
      false,
      true,
    );
    const wsUrl = normalizeDiscoveredUrl(
      v1?.['signalk-ws'],
      cleanHost,
      port,
      useTls,
      true,
      false,
    );

    return {
      httpUrl,
      wsUrl,
      version: typeof v1?.version === 'string' ? v1.version : '1.7.0',
      serverId: typeof data?.server?.id === 'string' ? data.server.id : undefined,
      serverVersion: typeof data?.server?.version === 'string' ? data.server.version : undefined,
    };
  }

  /**
   * Submits an access request to `POST /signalk/v1/access/requests`.
   * Gracefully falls back to `UNSUPPORTED_READONLY` on HTTP 501 / 404 for unauthenticated servers.
   */
  public async requestAccess(input: AccessRequestInput): Promise<AccessRequestSubmissionResult> {
    const clientId = SignalKAuthManager.ensureClientId(input.clientId);
    const cleanHost = typeof input.host === 'string' ? input.host.trim() : '';
    if (!cleanHost) {
      throw new SignalKAuthError('Host is required', 'INVALID_HOST', 400);
    }

    const useTls = Boolean(input.useTls);
    const httpScheme = useTls ? 'https' : 'http';
    const url = `${httpScheme}://${cleanHost}:${input.port}/signalk/v1/access/requests`;

    const payload = {
      clientId,
      description: input.description || 'Homey Pro Smart Boat Hub',
      permissions: input.permissions || 'readwrite',
    };

    const res = await performHttpRequest({
      method: 'POST',
      url,
      body: payload,
      allowSelfSigned: input.allowSelfSigned,
      timeoutMs: input.timeoutMs ?? 8000,
    });

    const data = res.data && typeof res.data === 'object' ? res.data : {};

    // 202 Accepted / PENDING
    if (res.statusCode === 202 || data.state === 'PENDING') {
      const href: string | undefined =
        typeof data.href === 'string'
          ? data.href
          : typeof data.requestId === 'string'
            ? `/signalk/v1/access/requests/${data.requestId}`
            : undefined;
      const requestId: string | undefined =
        typeof data.requestId === 'string'
          ? data.requestId
          : href
            ? href.split('/').filter(Boolean).pop()
            : undefined;

      return {
        state: 'PENDING',
        statusCode: 202,
        clientId,
        requestId,
        href,
        message: typeof data.message === 'string' ? data.message : undefined,
      };
    }

    // 200 OK (immediate approval or pre-approved token)
    if (res.statusCode === 200) {
      const token = data.accessRequest?.token ?? data.token;
      const perm = data.accessRequest?.permission ?? data.permission;
      if (perm === 'DENIED' || data.state === 'DENIED') {
        return {
          state: 'DENIED',
          statusCode: 200,
          clientId,
          message: data.message || 'Access request was denied',
        };
      }
      return {
        state: 'APPROVED',
        statusCode: 200,
        clientId,
        token: typeof token === 'string' ? token : undefined,
        message: typeof data.message === 'string' ? data.message : undefined,
      };
    }

    // 501 Not Implemented or 404 Not Found -> Unauthenticated Read-Only Server Fallback
    if (res.statusCode === 501 || res.statusCode === 404) {
      return {
        state: 'UNSUPPORTED_READONLY',
        statusCode: res.statusCode,
        clientId,
        readonlyFallback: true,
        message:
          typeof data.message === 'string'
            ? data.message
            : 'Signal K server does not require authentication; using unauthenticated read-only mode.',
      };
    }

    if (res.statusCode === 400) {
      throw new SignalKAuthError(
        data.message || 'Bad Request submitting Signal K access request',
        'BAD_REQUEST',
        400,
      );
    }

    if (res.statusCode === 403) {
      throw new SignalKAuthError(
        data.message || 'Access requests are disabled on this Signal K server',
        'ACCESS_REQUEST_FORBIDDEN',
        403,
      );
    }

    throw new SignalKAuthError(
      data.message || `Unexpected HTTP ${res.statusCode} from Signal K access request`,
      'ACCESS_REQUEST_ERROR',
      res.statusCode,
    );
  }

  /**
   * Polls `GET <href>` once for the current status of a pending Signal K access request.
   */
  public async pollAccessRequest(input: PollAccessRequestInput): Promise<AccessRequestPollResult> {
    const cleanHost = typeof input.host === 'string' ? input.host.trim() : '';
    const useTls = Boolean(input.useTls);
    const httpScheme = useTls ? 'https' : 'http';
    const baseOrigin = `${httpScheme}://${cleanHost}:${input.port}`;

    let pollUrl: string;
    try {
      const parsed = new URL(input.href, baseOrigin);
      pollUrl = `${baseOrigin}${parsed.pathname}${parsed.search}`;
    } catch {
      throw new SignalKAuthError(`Invalid access request href: ${input.href}`, 'INVALID_HREF', 400);
    }

    const res = await performHttpRequest({
      method: 'GET',
      url: pollUrl,
      allowSelfSigned: input.allowSelfSigned,
      timeoutMs: input.timeoutMs ?? 8000,
    });

    const data = res.data && typeof res.data === 'object' ? res.data : {};

    if (res.statusCode === 404 || res.statusCode === 410) {
      return {
        state: 'EXPIRED',
        statusCode: res.statusCode,
        message: data.message || 'Access request expired or not found',
      };
    }

    if (res.statusCode === 202 || data.state === 'PENDING') {
      return {
        state: 'PENDING',
        statusCode: 202,
        message: typeof data.message === 'string' ? data.message : undefined,
      };
    }

    if (res.statusCode === 200 || data.state === 'COMPLETED' || data.state === 'DENIED') {
      const permission = data.accessRequest?.permission ?? data.permission;
      const token = data.accessRequest?.token ?? data.token;

      if (permission === 'APPROVED' || (typeof token === 'string' && token.length > 0)) {
        return {
          state: 'APPROVED',
          statusCode: 200,
          permission: 'APPROVED',
          token: typeof token === 'string' ? token : undefined,
          message: typeof data.message === 'string' ? data.message : undefined,
        };
      }

      if (permission === 'DENIED' || data.state === 'DENIED') {
        return {
          state: 'DENIED',
          statusCode: 200,
          permission: 'DENIED',
          message:
            typeof data.message === 'string'
              ? data.message
              : 'Access request denied by administrator',
        };
      }

      if (permission === 'EXPIRED' || data.state === 'EXPIRED') {
        return {
          state: 'EXPIRED',
          statusCode: 200,
          message: typeof data.message === 'string' ? data.message : 'Access request expired',
        };
      }
    }

    throw new SignalKAuthError(
      data.message || `Unexpected poll status HTTP ${res.statusCode}`,
      'POLL_ERROR',
      res.statusCode,
    );
  }

  /**
   * Submits an access request (if `href` is not already provided) and polls until
   * `APPROVED`, `DENIED`, `EXPIRED`, or `maxWaitMs` timeout.
   *
   * Strictly enforces a minimum poll interval of `>= 500ms` per the Signal K specification.
   */
  public async waitForApproval(input: WaitForApprovalInput): Promise<AccessRequestPollResult> {
    const effectiveIntervalMs = Math.max(500, input.pollIntervalMs ?? 2000);
    const maxWaitMs = input.maxWaitMs ?? 120000;
    const startedAt = Date.now();

    let href = input.href;
    if (!href) {
      const submission = await this.requestAccess(input);
      if (submission.state === 'APPROVED') {
        return {
          state: 'APPROVED',
          statusCode: submission.statusCode,
          permission: 'APPROVED',
          token: submission.token,
          message: submission.message,
        };
      }
      if (submission.state === 'UNSUPPORTED_READONLY') {
        return {
          state: 'APPROVED',
          statusCode: submission.statusCode,
          permission: 'APPROVED',
          token: undefined,
          message: submission.message,
        };
      }
      if (submission.state === 'DENIED') {
        return {
          state: 'DENIED',
          statusCode: submission.statusCode,
          permission: 'DENIED',
          message: submission.message,
        };
      }
      href = submission.href;
      if (!href) {
        throw new SignalKAuthError(
          'Signal K server returned PENDING without an access request polling href',
          'MISSING_HREF',
          500,
        );
      }
    }

    while (Date.now() - startedAt < maxWaitMs) {
      await sleep(effectiveIntervalMs, input.signal);

      const pollResult = await this.pollAccessRequest({
        host: input.host,
        port: input.port,
        useTls: input.useTls,
        allowSelfSigned: input.allowSelfSigned,
        href,
        timeoutMs: input.timeoutMs,
      });

      if (input.onTick) {
        input.onTick(pollResult);
      }

      if (
        pollResult.state === 'APPROVED' ||
        pollResult.state === 'DENIED' ||
        pollResult.state === 'EXPIRED'
      ) {
        return pollResult;
      }
    }

    return {
      state: 'EXPIRED',
      statusCode: 408,
      message: `Timed out after ${maxWaitMs}ms waiting for Signal K access request approval`,
    };
  }

  /**
   * Validates whether a stored JWT token (or unauthenticated access) can read `/signalk/v1/api/vessels/self`.
   */
  public async validateToken(input: ValidateTokenInput): Promise<ValidateTokenResult> {
    const cleanHost = typeof input.host === 'string' ? input.host.trim() : '';
    const useTls = Boolean(input.useTls);
    const httpScheme = useTls ? 'https' : 'http';
    const url = `${httpScheme}://${cleanHost}:${input.port}/signalk/v1/api/vessels/self`;

    const headers: Record<string, string> = {};
    if (input.token && input.token.trim().length > 0) {
      headers.Authorization = `Bearer ${input.token.trim()}`;
    }

    const res = await performHttpRequest({
      method: 'GET',
      url,
      headers,
      allowSelfSigned: input.allowSelfSigned,
      timeoutMs: input.timeoutMs ?? 6000,
    });

    if (res.statusCode === 200) {
      const data = res.data && typeof res.data === 'object' ? res.data : {};
      return {
        valid: true,
        statusCode: 200,
        vesselName: typeof data.name === 'string' ? data.name : undefined,
        vesselSelf: typeof data.uuid === 'string' ? data.uuid : undefined,
      };
    }

    return {
      valid: false,
      statusCode: res.statusCode,
      message:
        typeof res.data?.message === 'string'
          ? res.data.message
          : `HTTP ${res.statusCode}`,
    };
  }
}

export const signalKAuthManager = new SignalKAuthManager();
export default SignalKAuthManager;
