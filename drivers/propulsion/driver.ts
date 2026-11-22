import Homey from 'homey';
import { SignalKAuthManager } from '../../lib/SignalKAuthManager';
import { PathDiscoveryService } from '../../lib/PathDiscoveryService';
import {
  attachStandardPairHandlers,
  attachStandardRepairHandlers,
  getDiscoveredSignalKServers,
} from '../vessel/SignalKDriverHelper';

export default class PropulsionDriver extends Homey.Driver {
  private readonly authManager = new SignalKAuthManager();
  private readonly discoveryService = new PathDiscoveryService();
  private lastPairedServerId = 'default';

  public override async onInit(): Promise<void> {
    this.log('Propulsion & Engine Driver (Read-Only) initialized');
  }

  public override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    attachStandardPairHandlers(this, session, this.authManager, async (serverState) => {
      this.lastPairedServerId = serverState.serverId;
      return this.discoverPropulsionDevices(serverState.serverId, serverState);
    });
  }

  public override async onPairListDevices(serverIdOverride?: string): Promise<any[]> {
    const discoveredServers = getDiscoveredSignalKServers(this.homey);
    const effectiveServerId =
      serverIdOverride ||
      discoveredServers[0]?.id ||
      this.lastPairedServerId ||
      'default';
    return this.discoverPropulsionDevices(effectiveServerId);
  }

  public async discoverPropulsionDevices(
    serverId: string,
    serverState?: {
      host: string;
      port: number;
      useTls: boolean;
      allowSelfSigned: boolean;
      token?: string;
      clientId?: string;
    },
  ): Promise<any[]> {
    const app = this.homey.app as any;
    const pool = app?.connectionPool;
    const pathDiscovery: PathDiscoveryService =
      app?.pathDiscoveryService ?? this.discoveryService;

    let selfTree: Record<string, any> = {};
    if (pool && typeof pool.getVesselSubtree === 'function') {
      try {
        selfTree = await pool.getVesselSubtree(serverId);
      } catch {
        selfTree = {};
      }
    }

    const engines = pathDiscovery.discoverPropulsionEngines(selfTree);
    const defaultCapabilities = [
      'measure_engine_rpm',
      'measure_temperature',
      'measure_oil_pressure',
      'measure_engine_hours',
      'measure_fuel_rate',
      'alarm_generic',
    ];

    return engines.map((engine) => ({
      name: engine.name,
      data: {
        id: `${serverId}::propulsion::${engine.instanceKey}`,
        serverId,
        engineId: engine.instanceKey,
        basePath: engine.basePath,
      },
      store: {
        serverId,
        engineId: engine.instanceKey,
        basePath: engine.basePath,
        ...(serverState
          ? {
              host: serverState.host,
              port: serverState.port,
              useTls: serverState.useTls,
              allowSelfSigned: serverState.allowSelfSigned,
              ...(serverState.token ? { token: serverState.token } : {}),
              ...(serverState.clientId ? { clientId: serverState.clientId } : {}),
            }
          : {}),
      },
      settings: {
        ...(serverState
          ? {
              host: serverState.host,
              port: serverState.port,
              useTls: serverState.useTls,
              allowSelfSigned: serverState.allowSelfSigned,
              ...(serverState.token ? { token: serverState.token } : {}),
            }
          : {}),
        engineId: engine.instanceKey,
        throttleTier: 'medium',
      },
      capabilities: Array.isArray(this.manifest?.capabilities)
        ? [...this.manifest.capabilities]
        : defaultCapabilities,
    }));
  }

  public override async onRepair(
    session: Homey.Driver.PairSession,
    device?: Homey.Device,
  ): Promise<void> {
    attachStandardRepairHandlers(this, session, device, this.authManager);
  }
}
