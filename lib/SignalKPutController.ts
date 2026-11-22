/**
 * Safety-Boundary Enforced Signal K PUT Controller (`lib/SignalKPutController.ts`).
 *
 * Implements Feature F6-Part2:
 *  - Pre-flight safety assertion via `SafetyBoundary.assertWritablePath(path)` BEFORE any network I/O
 *  - REST `PUT /signalk/v1/api/vessels/self/<slashPath>` with `{ value, source? }` & Bearer JWT token
 *  - Optional WebSocket `put` transport (`{ context: "vessels.self", requestId, put: [{ path, value, source }] }`)
 *  - Asynchronous Signal K Request/Response state machine:
 *      - `200 OK` / `COMPLETED` -> `{ state: 'COMPLETED', statusCode: 200 }`
 *      - `202 Accepted` / `PENDING` -> polls `GET <actionResult.href | href>` until `COMPLETED`, `FAILED`, or timeout
 *      - Inspects inner payload `statusCode` on `COMPLETED` (e.g. `502 Bad Gateway` hardware NACK -> `FAILED`)
 *      - Handles `405 Method Not Allowed`, `400 Bad Request` (multi-source disambiguation), `401`/`403` Auth, `502`
 *  - Automatic Anchor Watch Plugin REST Fallback:
 *      - When `PUT` to `navigation.anchor.*` returns HTTP `405` or `404`, automatically executes an authenticated
 *        `POST /plugins/anchoralarm/{dropAnchor,raiseAnchor,setRadius,setRodeLength}`
 */

import * as crypto from 'node:crypto';
import { URL } from 'node:url';
import { SafetyBoundary, ISafetyBoundary, SafetyBoundaryError } from './SafetyBoundary';
import { performHttpRequest } from './SignalKAuthManager';

export interface PutServerConfig {
  serverId?: string;
  host: string;
  port: number;
  useTls?: boolean;
  allowSelfSigned?: boolean;
  token?: string;
  httpEndpoint?: string;
}

export interface PutOptions {
  source?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  depth?: number;
  transport?: 'rest' | 'ws';
  wsSendPut?: (
    payload: {
      context: string;
      requestId: string;
      put: Array<{ path: string; value: unknown; source?: string }>;
    },
    timeoutMs: number,
  ) => Promise<PutResult>;
}

export interface PutResult {
  state: 'COMPLETED' | 'PENDING' | 'FAILED';
  statusCode: number;
  requestId?: string;
  message?: string;
  fallbackUsed?: 'anchoralarm-plugin';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SignalKPutController {
  private readonly safetyBoundary: ISafetyBoundary;

  constructor(safetyBoundaryInstance: ISafetyBoundary = new SafetyBoundary()) {
    this.safetyBoundary = safetyBoundaryInstance;
  }

  /**
   * Executes a safety-validated Signal K PUT command for `path` with `value`.
   *
   * Throws `SafetyBoundaryError` synchronously prior to any network call if `path`
   * targets a read-only namespace (`steering.**`, `propulsion.**`, `navigation.**` except `navigation.anchor.**`).
   */
  public async putPath(
    config: PutServerConfig,
    path: string,
    value: unknown,
    options?: PutOptions,
  ): Promise<PutResult> {
    // 1. Mandatory pre-flight marine safety boundary check (zero network I/O on violation)
    this.safetyBoundary.assertWritablePath(path);
    const normalizedPath = this.safetyBoundary.normalizePath(path);

    if (!config || typeof config.host !== 'string' || !config.host.trim()) {
      return {
        state: 'FAILED',
        statusCode: 400,
        message: 'Signal K server host configuration is missing',
      };
    }

    const timeoutMs = options?.timeoutMs ?? 10000;
    const pollIntervalMs = Math.max(25, options?.pollIntervalMs ?? 250);

    // Optional WebSocket PUT transport if explicitly requested and available
    if (options?.transport === 'ws' && typeof options.wsSendPut === 'function') {
      const requestId = crypto.randomUUID();
      return options.wsSendPut(
        {
          context: 'vessels.self',
          requestId,
          put: [
            {
              path: normalizedPath,
              value,
              ...(options.source ? { source: options.source } : {}),
            },
          ],
        },
        timeoutMs,
      );
    }

    const useTls = Boolean(config.useTls);
    const scheme = useTls ? 'https' : 'http';
    const rootOrigin = `${scheme}://${config.host.trim()}:${config.port}`;
    const baseApiUrl =
      typeof config.httpEndpoint === 'string' && config.httpEndpoint.trim().length > 0
        ? config.httpEndpoint.endsWith('/')
          ? config.httpEndpoint
          : `${config.httpEndpoint}/`
        : `${rootOrigin}/signalk/v1/api/`;

    const slashPath = normalizedPath
      .split('.')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const putUrl = `${baseApiUrl}vessels/self/${slashPath}`;

    const headers: Record<string, string> = {};
    if (config.token && config.token.trim().length > 0) {
      headers.Authorization = `Bearer ${config.token.trim()}`;
    }

    const body: Record<string, unknown> = { value };
    if (options?.source && options.source.trim().length > 0) {
      body.source = options.source.trim();
    }

    let res;
    try {
      res = await performHttpRequest({
        method: 'PUT',
        url: putUrl,
        headers,
        body,
        allowSelfSigned: config.allowSelfSigned,
        timeoutMs,
      });
    } catch (err: any) {
      return {
        state: 'FAILED',
        statusCode: 503,
        message: err?.message || 'Network error executing Signal K PUT request',
      };
    }

    const data = res.data && typeof res.data === 'object' ? res.data : {};
    const innerStatusCode: number =
      typeof data.statusCode === 'number' ? data.statusCode : res.statusCode;

    // 2. Automatic Anchor Watch Plugin REST Fallback on 405 / 404 for navigation.anchor.*
    if (
      normalizedPath.startsWith('navigation.anchor.') &&
      (res.statusCode === 405 ||
        res.statusCode === 404 ||
        innerStatusCode === 405 ||
        innerStatusCode === 404)
    ) {
      const fallbackResult = await this.executeAnchorPluginFallback(
        rootOrigin,
        config,
        normalizedPath,
        value,
        options,
      );
      if (fallbackResult) {
        return fallbackResult;
      }
    }

    // 3. Asynchronous 202 PENDING state machine
    if (res.statusCode === 202 || data.state === 'PENDING') {
      const href: string | undefined =
        typeof data.actionResult?.href === 'string'
          ? data.actionResult.href
          : typeof data.href === 'string'
            ? data.href
            : undefined;
      const requestId: string | undefined =
        typeof data.requestId === 'string' ? data.requestId : undefined;

      if (!href) {
        return {
          state: 'PENDING',
          statusCode: 202,
          requestId,
          message: typeof data.message === 'string' ? data.message : undefined,
        };
      }

      return this.pollPendingAction(
        rootOrigin,
        href,
        headers,
        Boolean(config.allowSelfSigned),
        requestId,
        timeoutMs,
        pollIntervalMs,
      );
    }

    // 4. Synchronous 200 COMPLETED (verify inner statusCode and state)
    if (res.statusCode >= 200 && res.statusCode < 300) {
      if (data.state === 'FAILED' || innerStatusCode >= 400) {
        return {
          state: 'FAILED',
          statusCode: innerStatusCode >= 400 ? innerStatusCode : 500,
          requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
          message:
            typeof data.message === 'string' ? data.message : 'Signal K PUT reported failure',
        };
      }

      return {
        state: 'COMPLETED',
        statusCode: innerStatusCode || 200,
        requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
        message: typeof data.message === 'string' ? data.message : undefined,
      };
    }

    // 5. Error responses (400, 401, 403, 405, 500, 502)
    return {
      state: 'FAILED',
      statusCode: innerStatusCode >= 400 ? innerStatusCode : res.statusCode || 500,
      requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
      message:
        typeof data.message === 'string'
          ? data.message
          : typeof res.rawText === 'string' && res.rawText.trim().length > 0
            ? res.rawText.trim()
            : `HTTP ${res.statusCode}`,
    };
  }

  /**
   * Polls `GET <actionResult.href>` until the asynchronous PUT transitions to `COMPLETED` or `FAILED`.
   */
  private async pollPendingAction(
    rootOrigin: string,
    href: string,
    headers: Record<string, string>,
    allowSelfSigned: boolean,
    initialRequestId: string | undefined,
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<PutResult> {
    let pollUrl: string;
    try {
      const parsed = new URL(href, rootOrigin);
      pollUrl = `${rootOrigin}${parsed.pathname}${parsed.search}`;
    } catch {
      return {
        state: 'FAILED',
        statusCode: 400,
        requestId: initialRequestId,
        message: `Invalid actionResult polling href: ${href}`,
      };
    }

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await sleep(pollIntervalMs);

      let pollRes;
      try {
        pollRes = await performHttpRequest({
          method: 'GET',
          url: pollUrl,
          headers,
          allowSelfSigned,
          timeoutMs: Math.min(5000, timeoutMs),
        });
      } catch (err: any) {
        return {
          state: 'FAILED',
          statusCode: 503,
          requestId: initialRequestId,
          message: err?.message || 'Error polling pending PUT request',
        };
      }

      const pollData = pollRes.data && typeof pollRes.data === 'object' ? pollRes.data : {};
      const pollState = pollData.state;
      const pollStatusCode: number =
        typeof pollData.statusCode === 'number' ? pollData.statusCode : pollRes.statusCode;
      const requestId =
        typeof pollData.requestId === 'string' ? pollData.requestId : initialRequestId;

      if (pollState === 'PENDING' || pollRes.statusCode === 202) {
        continue;
      }

      if (pollState === 'COMPLETED') {
        if (pollStatusCode >= 400) {
          return {
            state: 'FAILED',
            statusCode: pollStatusCode,
            requestId,
            message:
              typeof pollData.message === 'string'
                ? pollData.message
                : `Hardware actuation failed with status ${pollStatusCode}`,
          };
        }
        return {
          state: 'COMPLETED',
          statusCode: pollStatusCode || 200,
          requestId,
          message: typeof pollData.message === 'string' ? pollData.message : undefined,
        };
      }

      if (pollState === 'FAILED' || pollRes.statusCode >= 400 || pollStatusCode >= 400) {
        return {
          state: 'FAILED',
          statusCode: pollStatusCode >= 400 ? pollStatusCode : 500,
          requestId,
          message:
            typeof pollData.message === 'string'
              ? pollData.message
              : 'Asynchronous PUT operation failed',
        };
      }
    }

    return {
      state: 'FAILED',
      statusCode: 408,
      requestId: initialRequestId,
      message: `Asynchronous PUT operation timed out after ${timeoutMs}ms`,
    };
  }

  /**
   * Translates a `navigation.anchor.*` PUT command into a `POST /plugins/anchoralarm/*`
   * REST call when the server's anchor plugin does not register a v1 PUT handler.
   */
  private async executeAnchorPluginFallback(
    rootOrigin: string,
    config: PutServerConfig,
    normalizedPath: string,
    value: unknown,
    options?: PutOptions,
  ): Promise<PutResult | null> {
    let endpointPath: string | null = null;
    let payload: Record<string, unknown> = {};

    if (normalizedPath === 'navigation.anchor.position') {
      const isRaise =
        value === null ||
        value === false ||
        (typeof value === 'object' && value !== null && Object.keys(value).length === 0);
      if (isRaise) {
        endpointPath = '/plugins/anchoralarm/raiseAnchor';
        payload = {};
      } else {
        endpointPath = '/plugins/anchoralarm/dropAnchor';
        payload =
          typeof value === 'object' && value !== null ? { position: value } : {};
      }
    } else if (
      normalizedPath === 'navigation.anchor.drop' ||
      normalizedPath === 'navigation.anchor.dropAnchor'
    ) {
      endpointPath = '/plugins/anchoralarm/dropAnchor';
      payload = typeof value === 'object' && value !== null ? { position: value } : {};
    } else if (
      normalizedPath === 'navigation.anchor.raise' ||
      normalizedPath === 'navigation.anchor.raiseAnchor'
    ) {
      endpointPath = '/plugins/anchoralarm/raiseAnchor';
      payload = {};
    } else if (
      normalizedPath === 'navigation.anchor.maxRadius' ||
      normalizedPath === 'navigation.anchor.setRadius'
    ) {
      endpointPath = '/plugins/anchoralarm/setRadius';
      payload = { radius: Number(value) };
    } else if (
      normalizedPath === 'navigation.anchor.rodeLength' ||
      normalizedPath === 'navigation.anchor.setRodeLength'
    ) {
      endpointPath = '/plugins/anchoralarm/setRodeLength';
      payload = {
        length: Number(value),
        ...(options?.depth !== undefined ? { depth: options.depth } : {}),
      };
    }

    if (!endpointPath) {
      return null;
    }

    const headers: Record<string, string> = {};
    if (config.token && config.token.trim().length > 0) {
      headers.Authorization = `Bearer ${config.token.trim()}`;
    }

    try {
      const res = await performHttpRequest({
        method: 'POST',
        url: `${rootOrigin}${endpointPath}`,
        headers,
        body: payload,
        allowSelfSigned: config.allowSelfSigned,
        timeoutMs: options?.timeoutMs ?? 8000,
      });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return {
          state: 'COMPLETED',
          statusCode: 200,
          fallbackUsed: 'anchoralarm-plugin',
          message:
            typeof res.data?.message === 'string'
              ? res.data.message
              : `Executed via ${endpointPath}`,
        };
      }

      return {
        state: 'FAILED',
        statusCode: res.statusCode || 500,
        fallbackUsed: 'anchoralarm-plugin',
        message:
          typeof res.data?.message === 'string'
            ? res.data.message
            : `Anchor plugin fallback ${endpointPath} returned HTTP ${res.statusCode}`,
      };
    } catch (err: any) {
      return {
        state: 'FAILED',
        statusCode: 503,
        fallbackUsed: 'anchoralarm-plugin',
        message: err?.message || `Anchor plugin fallback ${endpointPath} failed`,
      };
    }
  }
}

export const signalKPutController = new SignalKPutController();
export default SignalKPutController;
