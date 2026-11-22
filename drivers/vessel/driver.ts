import Homey from 'homey';
import { SignalKAuthManager } from '../../lib/SignalKAuthManager';
import { PathDiscoveryService } from '../../lib/PathDiscoveryService';
import {
  attachStandardPairHandlers,
  attachStandardRepairHandlers,
  getDiscoveredSignalKServers,
} from './SignalKDriverHelper';

export default class VesselDriver extends Homey.Driver {
  private readonly authManager = new SignalKAuthManager();
  private readonly discoveryService = new PathDiscoveryService();
  private lastPairedServerId = 'default';

  public override async onInit(): Promise<void> {
    this.log('Vessel & Anchor Watch Driver initialized');
  }

  public override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    attachStandardPairHandlers(this, session, this.authManager, async (serverState) => {
      this.lastPairedServerId = serverState.serverId;
      return this.discoverVesselDevices(serverState.serverId, serverState);
    });
  }

  public override async onPairListDevices(): Promise<any[]> {
    const discoveredServers = getDiscoveredSignalKServers(this.homey);
    const fallbackServerId =
      discoveredServers[0]?.id || this.lastPairedServerId || 'default';
    return this.discoverVesselDevices(fallbackServerId);
  }

  public async discoverVesselDevices(
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

    const vesselInfo = pathDiscovery.discoverVessel(selfTree);
    const defaultCapabilities = [
      'measure_sog',
      'measure_stw',
      'measure_cog',
      'measure_heading',
      'measure_depth',
      'measure_wind_strength',
      'measure_wind_angle',
      'measure_pressure',
      'measure_temperature',
      'navigation_state',
      'autopilot_state',
      'onoff.anchor_armed',
      'measure_anchor_distance',
      'measure_anchor_radius',
      'alarm_generic',
    ];

    return [
      {
        name: vesselInfo.name,
        data: {
          id: vesselInfo.id,
          serverId,
        },
        store: {
          serverId,
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
          speed_unit: 'kn',
          anchor_max_radius: 40,
          anchor_rode_length: 30,
          anchor_haversine_fallback: true,
        },
        capabilities: Array.isArray(this.manifest?.capabilities)
          ? [...this.manifest.capabilities]
          : defaultCapabilities,
      },
    ];
  }

  public override async onRepair(
    session: Homey.Driver.PairSession,
    device?: Homey.Device,
  ): Promise<void> {
    attachStandardRepairHandlers(this, session, device, this.authManager);
  }
}
