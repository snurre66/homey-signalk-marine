import Homey from 'homey';
import { SignalKAuthManager } from '../../lib/SignalKAuthManager';
import { PathDiscoveryService, DiscoveredLeafPath } from '../../lib/PathDiscoveryService';
import { UnitCategory } from '../../lib/UnitConverter';
import {
  attachStandardPairHandlers,
  attachStandardRepairHandlers,
  getDiscoveredSignalKServers,
} from '../vessel/SignalKDriverHelper';

export function mapLeafToCapability(leaf: DiscoveredLeafPath): {
  capability: string;
  unitCategory: UnitCategory;
  throttleTier: 'fast' | 'medium' | 'slow';
} {
  const lowerPath = leaf.path.toLowerCase();

  if (lowerPath.startsWith('notifications.')) {
    if (lowerPath.includes('bilge')) {
      return { capability: 'alarm_water', unitCategory: 'passthrough', throttleTier: 'fast' };
    }
    if (lowerPath.includes('security') || lowerPath.includes('hatch') || lowerPath.includes('door')) {
      return { capability: 'alarm_contact', unitCategory: 'passthrough', throttleTier: 'fast' };
    }
    return { capability: 'alarm_generic', unitCategory: 'passthrough', throttleTier: 'fast' };
  }

  switch (leaf.inferredUnitCategory) {
    case 'temperature_k_to_c':
      return {
        capability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
      };
    case 'ratio_to_percent':
      if (lowerPath.includes('humidity')) {
        return {
          capability: 'measure_humidity',
          unitCategory: 'ratio_to_percent',
          throttleTier: 'slow',
        };
      }
      return {
        capability: 'measure_battery',
        unitCategory: 'ratio_to_percent',
        throttleTier: 'slow',
      };
    case 'pressure_pa_to_hpa':
    case 'pressure_pa_to_bar':
    case 'pressure_pa_to_kpa':
      return {
        capability: 'measure_pressure',
        unitCategory: leaf.inferredUnitCategory,
        throttleTier: 'slow',
      };
    case 'distance_m':
      return {
        capability: 'measure_depth',
        unitCategory: 'distance_m',
        throttleTier: 'medium',
      };
    case 'speed_ms_to_kn':
    case 'speed_ms_to_kmh':
    case 'speed_ms':
      return {
        capability: 'measure_sog',
        unitCategory: leaf.inferredUnitCategory,
        throttleTier: 'medium',
      };
    default:
      if (typeof leaf.value === 'boolean') {
        return { capability: 'alarm_generic', unitCategory: 'passthrough', throttleTier: 'fast' };
      }
      return {
        capability: 'measure_temperature',
        unitCategory: leaf.inferredUnitCategory,
        throttleTier: 'slow',
      };
  }
}

export default class CustomSensorDriver extends Homey.Driver {
  private readonly authManager = new SignalKAuthManager();
  private readonly discoveryService = new PathDiscoveryService();
  private lastPairedServerId = 'default';

  public override async onInit(): Promise<void> {
    this.log('Custom Signal K Path Sensor Driver initialized');
  }

  public override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    attachStandardPairHandlers(this, session, this.authManager, async (serverState) => {
      this.lastPairedServerId = serverState.serverId;
      return this.discoverCustomSensorDevices(serverState.serverId, serverState);
    });
  }

  public override async onPairListDevices(serverIdOverride?: string): Promise<any[]> {
    const discoveredServers = getDiscoveredSignalKServers(this.homey);
    const effectiveServerId =
      serverIdOverride ||
      discoveredServers[0]?.id ||
      this.lastPairedServerId ||
      'default';
    return this.discoverCustomSensorDevices(effectiveServerId);
  }

  public async discoverCustomSensorDevices(
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

    const leaves = pathDiscovery.discoverAllLeafPaths(selfTree);
    const candidateLeaves = leaves.filter(
      (leaf) =>
        leaf.path.startsWith('environment.inside.') ||
        leaf.path.startsWith('environment.outside.') ||
        leaf.path.startsWith('environment.water.') ||
        leaf.path.startsWith('notifications.bilge.') ||
        leaf.path.startsWith('notifications.security.'),
    );

    return candidateLeaves.map((leaf) => {
      const mapping = mapLeafToCapability(leaf);
      const displayName =
        leaf.displayName ||
        leaf.description ||
        leaf.path.split('.').slice(-2).join(' ');

      return {
        name: displayName,
        data: {
          id: `${serverId}::sensor::${leaf.path}`,
          serverId,
          path: leaf.path,
        },
        store: {
          serverId,
          path: leaf.path,
          capability: mapping.capability,
          unitCategory: mapping.unitCategory,
          throttleTier: mapping.throttleTier,
          ...(leaf.$source ? { sourceFilter: leaf.$source } : {}),
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
          path: leaf.path,
          capability: mapping.capability,
          unitCategory: mapping.unitCategory,
          throttleTier: mapping.throttleTier,
          sourceFilter: '',
        },
        capabilities: [mapping.capability],
      };
    });
  }

  public override async onRepair(
    session: Homey.Driver.PairSession,
    device?: Homey.Device,
  ): Promise<void> {
    attachStandardRepairHandlers(this, session, device, this.authManager);
  }
}
