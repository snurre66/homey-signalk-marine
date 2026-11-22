import Homey from 'homey';
import type {
  ISignalKConnectionPool,
  ServerConnectionConfig,
} from '../../lib/SignalKConnectionPool';
import type { SignalKAuthManager } from '../../lib/SignalKAuthManager';
import type { PathDiscoveryService } from '../../lib/PathDiscoveryService';

export interface SignalKAppServices {
  connectionPool?: ISignalKConnectionPool;
  authManager?: SignalKAuthManager;
  discoveryService?: PathDiscoveryService;
  pathDiscoveryService?: PathDiscoveryService;
}

export interface ConnectServerPayload {
  serverId?: string;
  host: string;
  port?: number;
  useTls?: boolean;
  allowSelfSigned?: boolean;
  token?: string;
  clientId?: string;
  requestAccessIfNeeded?: boolean;
  permissions?: 'readonly' | 'readwrite' | 'admin';
  description?: string;
}

export interface ConnectServerResult {
  ok: boolean;
  state: 'CONNECTED' | 'PENDING' | 'DENIED' | 'EXPIRED' | 'UNSUPPORTED_READONLY';
  serverId: string;
  host: string;
  port: number;
  useTls: boolean;
  allowSelfSigned: boolean;
  token?: string;
  clientId?: string;
  href?: string;
  requestId?: string;
  message?: string;
}

export interface DiscoveredServerSummary {
  id: string;
  name: string;
  address: string;
  host?: string;
  port: number;
  txt?: Record<string, string>;
}

export interface PairServerState {
  serverId: string;
  host: string;
  port: number;
  useTls: boolean;
  allowSelfSigned: boolean;
  token?: string;
  clientId?: string;
}

export function getAppServices(homey: any): SignalKAppServices {
  return (homey?.app as SignalKAppServices) ?? {};
}

export function getDiscoveredSignalKServers(homey: any): DiscoveredServerSummary[] {
  try {
    const strategy = homey?.discovery?.getStrategy?.('signalk');
    if (!strategy || typeof strategy.getDiscoveryResults !== 'function') {
      return [];
    }
    const results = strategy.getDiscoveryResults() || {};
    return Object.values(results).map((r: any) => ({
      id: String(r.id || r.txt?.self || `${r.address}:${r.port || 3000}`),
      name: String(r.name || r.txt?.name || 'Signal K Server'),
      address: String(r.address || r.host || 'openplotter.local'),
      host: typeof r.host === 'string' ? r.host : undefined,
      port: typeof r.port === 'number' && Number.isFinite(r.port) ? r.port : 3000,
      txt: r.txt && typeof r.txt === 'object' ? r.txt : undefined,
    }));
  } catch {
    return [];
  }
}

export function getOrCreateClientId(homey: any, authManager: SignalKAuthManager): string {
  const existing = homey?.settings?.get?.('signalk_client_id');
  if (typeof existing === 'string' && authManager.isValidUuidV4(existing)) {
    return existing;
  }
  const generated = authManager.generateClientId();
  try {
    homey?.settings?.set?.('signalk_client_id', generated);
  } catch {
    // Ignore if settings store is read-only in unit test mocks
  }
  return generated;
}

export async function connectToSignalKServer(
  homey: any,
  payload: ConnectServerPayload,
  fallbackAuthManager: SignalKAuthManager,
): Promise<ConnectServerResult> {
  const services = getAppServices(homey);
  const pool = services.connectionPool;
  const authManager = services.authManager ?? fallbackAuthManager;

  const host = typeof payload?.host === 'string' ? payload.host.trim() : '';
  if (!host) {
    throw new Error('Signal K server host is required');
  }
  const port =
    typeof payload?.port === 'number' &&
    Number.isInteger(payload.port) &&
    payload.port >= 1 &&
    payload.port <= 65535
      ? payload.port
      : Number(payload?.port) || 3000;
  const useTls = Boolean(payload?.useTls);
  const allowSelfSigned = payload?.allowSelfSigned !== false;
  const serverId =
    typeof payload?.serverId === 'string' && payload.serverId.trim().length > 0
      ? payload.serverId.trim()
      : `${host}:${port}`;

  let token =
    typeof payload?.token === 'string' && payload.token.trim().length > 0
      ? payload.token.trim()
      : undefined;
  const clientId = payload?.clientId
    ? authManager.ensureClientId(payload.clientId)
    : getOrCreateClientId(homey, authManager);

  if (!token && payload?.requestAccessIfNeeded) {
    try {
      const validation = await authManager.validateToken({
        host,
        port,
        useTls,
        allowSelfSigned,
      });
      if (!validation.valid && (validation.statusCode === 401 || validation.statusCode === 403)) {
        const reqRes = await authManager.requestAccess({
          host,
          port,
          useTls,
          allowSelfSigned,
          clientId,
          description: payload.description || 'Homey Pro Smart Boat Hub',
          permissions: payload.permissions || 'readwrite',
        });

        if (reqRes.state === 'PENDING') {
          return {
            ok: false,
            state: 'PENDING',
            serverId,
            host,
            port,
            useTls,
            allowSelfSigned,
            clientId,
            href: reqRes.href,
            requestId: reqRes.requestId,
            message:
              reqRes.message || 'Access request pending administrator approval in Signal K',
          };
        }
        if (reqRes.state === 'DENIED') {
          return {
            ok: false,
            state: 'DENIED',
            serverId,
            host,
            port,
            useTls,
            allowSelfSigned,
            clientId,
            message: reqRes.message || 'Access request denied by Signal K administrator',
          };
        }
        if (reqRes.state === 'APPROVED' && reqRes.token) {
          token = reqRes.token;
        }
      }
    } catch {
      // Fall through to direct pool connection if auth probe is unsupported
    }
  }

  const connConfig: ServerConnectionConfig = {
    serverId,
    host,
    port,
    useTls,
    allowSelfSigned,
    token,
    clientId,
  };

  if (typeof (homey?.app as any)?.connectServer === 'function') {
    await (homey.app as any).connectServer(connConfig);
  } else if (pool) {
    await pool.acquireConnection(connConfig);
    if (typeof (homey?.app as any)?.flowCardManager?.attachServerSubscriptions === 'function') {
      (homey.app as any).flowCardManager.attachServerSubscriptions(serverId);
    }
  }

  return {
    ok: true,
    state: 'CONNECTED',
    serverId,
    host,
    port,
    useTls,
    allowSelfSigned,
    token,
    clientId,
  };
}

export function attachM3PairHandlers(
  driver: Homey.Driver,
  session: any,
  authManager: SignalKAuthManager,
  getDevicesForServer: (state: PairServerState) => Promise<any[]>,
): void {
  const discovered = getDiscoveredSignalKServers(driver.homey);
  const firstDiscovered = discovered[0];

  const sessionState: PairServerState = {
    serverId:
      typeof (driver.homey?.app as any)?.getDefaultServerId === 'function'
        ? (driver.homey.app as any).getDefaultServerId()
        : 'default',
    host: firstDiscovered?.address || 'openplotter.local',
    port: firstDiscovered?.port || 3000,
    useTls: false,
    allowSelfSigned: true,
  };

  session.setHandler('discover_servers', async () => {
    return getDiscoveredSignalKServers(driver.homey);
  });

  session.setHandler('connect_server', async (payload: ConnectServerPayload) => {
    const result = await connectToSignalKServer(driver.homey, payload, authManager);
    sessionState.serverId = result.serverId;
    sessionState.host = result.host;
    sessionState.port = result.port;
    sessionState.useTls = result.useTls;
    sessionState.allowSelfSigned = result.allowSelfSigned;
    sessionState.token = result.token;
    sessionState.clientId = result.clientId;
    return result;
  });

  session.setHandler(
    'poll_access_request',
    async (data: {
      host?: string;
      port?: number;
      useTls?: boolean;
      allowSelfSigned?: boolean;
      href?: string;
      requestId?: string;
      serverId?: string;
    }) => {
      const services = getAppServices(driver.homey);
      const activeAuth = services.authManager ?? authManager;
      const host = data?.host || sessionState.host;
      const port = data?.port || sessionState.port;
      const useTls = data?.useTls ?? sessionState.useTls;
      const allowSelfSigned = data?.allowSelfSigned ?? sessionState.allowSelfSigned;
      const href =
        data?.href ||
        (data?.requestId ? `/signalk/v1/access/requests/${data.requestId}` : '');

      if (!href) {
        throw new Error('Access request href or requestId is required');
      }

      const pollResult = await activeAuth.waitForApproval({
        host,
        port,
        useTls,
        allowSelfSigned,
        href,
        pollIntervalMs: 500,
        maxWaitMs: 60000,
      });

      if (pollResult.state === 'APPROVED') {
        sessionState.token = pollResult.token;
        const serverId = data?.serverId || sessionState.serverId;
        const connConfig: ServerConnectionConfig = {
          serverId,
          host,
          port,
          useTls,
          allowSelfSigned,
          token: pollResult.token,
          clientId: sessionState.clientId,
        };
        if (typeof (driver.homey?.app as any)?.connectServer === 'function') {
          await (driver.homey.app as any).connectServer(connConfig);
        } else if (services.connectionPool) {
          await services.connectionPool.acquireConnection(connConfig);
        }
        return { ok: true, ...pollResult };
      }

      return { ok: false, ...pollResult };
    },
  );

  session.setHandler('list_devices', async () => {
    return getDevicesForServer(sessionState);
  });
}

export function attachM3RepairHandlers(
  driver: Homey.Driver,
  session: any,
  device: any,
  authManager: SignalKAuthManager,
): void {
  const services = getAppServices(driver.homey);
  const activeAuth = services.authManager ?? authManager;
  const pool = services.connectionPool;

  const getDeviceConfig = () => {
    const serverId =
      device?.getStoreValue?.('serverId') || device?.getData?.()?.serverId || 'default';
    const host =
      device?.getStoreValue?.('host') ||
      device?.getSetting?.('host') ||
      'openplotter.local';
    const port =
      Number(device?.getStoreValue?.('port') || device?.getSetting?.('port')) || 3000;
    const useTls = Boolean(
      device?.getStoreValue?.('useTls') ?? device?.getSetting?.('useTls'),
    );
    const allowSelfSigned =
      (device?.getStoreValue?.('allowSelfSigned') ?? device?.getSetting?.('allowSelfSigned')) !==
      false;
    const token =
      device?.getStoreValue?.('token') || device?.getSetting?.('token') || undefined;
    const clientId =
      device?.getStoreValue?.('clientId') || getOrCreateClientId(driver.homey, activeAuth);
    return { serverId, host, port, useTls, allowSelfSigned, token, clientId };
  };

  session.setHandler('get_current_config', async () => {
    return getDeviceConfig();
  });

  const applyNewCredentials = async (cfg: {
    host?: string;
    port?: number;
    useTls?: boolean;
    allowSelfSigned?: boolean;
    token?: string;
  }) => {
    const current = getDeviceConfig();
    const nextHost =
      typeof cfg?.host === 'string' && cfg.host.trim() ? cfg.host.trim() : current.host;
    const nextPort =
      typeof cfg?.port === 'number' &&
      Number.isInteger(cfg.port) &&
      cfg.port >= 1 &&
      cfg.port <= 65535
        ? cfg.port
        : Number(cfg?.port) || current.port;
    const nextUseTls = cfg?.useTls !== undefined ? Boolean(cfg.useTls) : current.useTls;
    const nextAllowSelfSigned =
      cfg?.allowSelfSigned !== undefined
        ? Boolean(cfg.allowSelfSigned)
        : current.allowSelfSigned;
    const nextToken =
      typeof cfg?.token === 'string' ? cfg.token.trim() : current.token;

    if (typeof device?.setStoreValue === 'function') {
      await device.setStoreValue('host', nextHost);
      await device.setStoreValue('port', nextPort);
      await device.setStoreValue('useTls', nextUseTls);
      await device.setStoreValue('allowSelfSigned', nextAllowSelfSigned);
      if (nextToken !== undefined) {
        await device.setStoreValue('token', nextToken);
      }
    }

    if (typeof device?.setSettings === 'function') {
      await device
        .setSettings({
          host: nextHost,
          port: nextPort,
          useTls: nextUseTls,
          allowSelfSigned: nextAllowSelfSigned,
          ...(nextToken !== undefined ? { token: nextToken } : {}),
        })
        .catch(() => {});
    }

    if (pool) {
      await pool.acquireConnection({
        serverId: current.serverId,
        host: nextHost,
        port: nextPort,
        useTls: nextUseTls,
        allowSelfSigned: nextAllowSelfSigned,
        token: nextToken,
        clientId: current.clientId,
      });
    }

    if (typeof device?.setAvailable === 'function') {
      await device.setAvailable();
    }

    return { ok: true, serverId: current.serverId, host: nextHost, port: nextPort };
  };

  session.setHandler('reconnect_server', async (payload: any) => {
    return applyNewCredentials(payload || {});
  });

  session.setHandler('set_token', async (payload: any) => {
    return applyNewCredentials(payload || {});
  });

  session.setHandler('request_access', async (payload: any) => {
    const current = getDeviceConfig();
    const host = payload?.host || current.host;
    const port = Number(payload?.port) || current.port;
    const useTls =
      payload?.useTls !== undefined ? Boolean(payload.useTls) : current.useTls;
    const allowSelfSigned =
      payload?.allowSelfSigned !== undefined
        ? Boolean(payload.allowSelfSigned)
        : current.allowSelfSigned;

    const res = await activeAuth.requestAccess({
      host,
      port,
      useTls,
      allowSelfSigned,
      clientId: current.clientId,
      description: 'Homey Pro Smart Boat Hub',
      permissions: 'readwrite',
    });

    if (res.state === 'APPROVED' && res.token) {
      await applyNewCredentials({
        host,
        port,
        useTls,
        allowSelfSigned,
        token: res.token,
      });
    }
    return res;
  });

  session.setHandler('poll_access_request', async (payload: any) => {
    const current = getDeviceConfig();
    const host = payload?.host || current.host;
    const port = Number(payload?.port) || current.port;
    const useTls =
      payload?.useTls !== undefined ? Boolean(payload.useTls) : current.useTls;
    const allowSelfSigned =
      payload?.allowSelfSigned !== undefined
        ? Boolean(payload.allowSelfSigned)
        : current.allowSelfSigned;
    const href =
      payload?.href ||
      (payload?.requestId ? `/signalk/v1/access/requests/${payload.requestId}` : '');

    if (!href) {
      throw new Error('Access request href or requestId is required');
    }

    const pollRes = await activeAuth.pollAccessRequest({
      host,
      port,
      useTls,
      allowSelfSigned,
      href,
    });

    if (pollRes.state === 'APPROVED' && pollRes.token) {
      await applyNewCredentials({
        host,
        port,
        useTls,
        allowSelfSigned,
        token: pollRes.token,
      });
    }
    return pollRes;
  });
}

export function resolveThrottleTier(
  raw: unknown,
  fallback: 'fast' | 'medium' | 'slow',
): 'fast' | 'medium' | 'slow' {
  if (raw === 'fast' || raw === 'medium' || raw === 'slow') {
    return raw;
  }
  return fallback;
}

export function resolveConnectionPool(homey: any): ISignalKConnectionPool | undefined {
  return getAppServices(homey).connectionPool;
}

export function resolveDiscoveryService(
  homey: any,
  fallback: PathDiscoveryService,
): PathDiscoveryService {
  const services = getAppServices(homey);
  return services.discoveryService ?? services.pathDiscoveryService ?? fallback;
}

export function resolveActiveServerId(homey: any, explicitServerId?: string): string {
  if (typeof explicitServerId === 'string' && explicitServerId.trim().length > 0) {
    return explicitServerId.trim();
  }
  const app = homey?.app as any;
  if (typeof app?.getDefaultServerId === 'function') {
    const def = app.getDefaultServerId();
    if (typeof def === 'string' && def.trim().length > 0) {
      return def.trim();
    }
  }
  if (typeof app?.getRegisteredServerIds === 'function') {
    const ids = app.getRegisteredServerIds();
    if (Array.isArray(ids) && ids.length > 0) {
      return ids[0];
    }
  }
  const poolConns: Map<string, any> | undefined = app?.connectionPool?._connections;
  if (poolConns && poolConns.size > 0) {
    const first = poolConns.keys().next().value;
    if (typeof first === 'string' && first.length > 0) {
      return first;
    }
  }
  return 'default';
}
