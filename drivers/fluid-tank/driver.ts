import Homey from 'homey';
import { SignalKAuthManager } from '../../lib/SignalKAuthManager';
import { PathDiscoveryService } from '../../lib/PathDiscoveryService';
import { UnitConverter } from '../../lib/UnitConverter';
import {
  attachM3PairHandlers,
  attachM3RepairHandlers,
  resolveActiveServerId,
  resolveConnectionPool,
  resolveDiscoveryService,
} from '../electrical-bank/M3DriverHelper';

export interface FluidTankPairDescriptor {
  name: string;
  data: {
    id: string;
    serverId: string;
    tankType: string;
    tankId: string;
    basePath: string;
  };
  store: {
    serverId: string;
    host?: string;
    port?: number;
    useTls?: boolean;
    allowSelfSigned?: boolean;
    token?: string;
    clientId?: string;
    tankType: string;
    tankId: string;
    basePath: string;
    capacityLiters: number | null;
  };
  settings: {
    capacity_liters: number;
    alarmThresholdPercent: number;
  };
  capabilities: string[];
}

export class FluidTankDriver extends Homey.Driver {
  private readonly fallbackAuth = new SignalKAuthManager();
  private readonly fallbackDiscovery = new PathDiscoveryService();
  private readonly unitConverter = new UnitConverter();

  public override async onInit(): Promise<void> {
    this.log('FluidTankDriver initialized');
  }

  public override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    attachM3PairHandlers(this, session, this.fallbackAuth, async (state) => {
      return this.discoverFluidTankDescriptors(state.serverId, {
        host: state.host,
        port: state.port,
        useTls: state.useTls,
        allowSelfSigned: state.allowSelfSigned,
        token: state.token,
        clientId: state.clientId,
      });
    });
  }

  public override async onPairListDevices(
    serverId?: string,
  ): Promise<FluidTankPairDescriptor[]> {
    const effectiveServerId = resolveActiveServerId(this.homey, serverId);
    return this.discoverFluidTankDescriptors(effectiveServerId);
  }

  public override async onRepair(
    session: Homey.Driver.PairSession,
    device?: Homey.Device,
  ): Promise<void> {
    attachM3RepairHandlers(this, session, device, this.fallbackAuth);
  }

  public async discoverFluidTankDescriptors(
    serverId: string,
    connMeta?: {
      host?: string;
      port?: number;
      useTls?: boolean;
      allowSelfSigned?: boolean;
      token?: string;
      clientId?: string;
    },
  ): Promise<FluidTankPairDescriptor[]> {
    const pool = resolveConnectionPool(this.homey);
    const discovery = resolveDiscoveryService(this.homey, this.fallbackDiscovery);

    if (!pool) {
      return [];
    }

    const selfTree = await pool.getVesselSubtree(serverId);
    const instances = discovery.discoverFluidTanks(selfTree);

    return instances.map((inst) => {
      const tankType = inst.category;
      const parts = inst.instanceKey.split('.');
      const tankId = parts.length > 1 ? parts.slice(1).join('.') : inst.instanceKey;

      const capM3 = selfTree?.tanks?.[tankType]?.[tankId]?.capacity?.value;
      const capLiters =
        this.unitConverter.fromSignalK(capM3, 'volume_m3_to_l', 1) ?? 200;

      const isWaste = tankType === 'blackWater' || tankType === 'wasteWater';
      const isFreshWater = tankType === 'freshWater';

      const capabilities = ['measure_tank_level', 'measure_tank_volume', 'alarm_generic'];
      if (isFreshWater) {
        capabilities.push('meter_water');
      }
      if (isFreshWater || isWaste) {
        capabilities.push('alarm_water');
      }

      return {
        name: inst.name,
        data: {
          id: `${serverId}::tank::${tankType}.${tankId}`,
          serverId,
          tankType,
          tankId,
          basePath: inst.basePath,
        },
        store: {
          serverId,
          ...(connMeta?.host ? { host: connMeta.host } : {}),
          ...(connMeta?.port ? { port: connMeta.port } : {}),
          ...(connMeta?.useTls !== undefined ? { useTls: connMeta.useTls } : {}),
          ...(connMeta?.allowSelfSigned !== undefined
            ? { allowSelfSigned: connMeta.allowSelfSigned }
            : {}),
          ...(connMeta?.token ? { token: connMeta.token } : {}),
          ...(connMeta?.clientId ? { clientId: connMeta.clientId } : {}),
          tankType,
          tankId,
          basePath: inst.basePath,
          capacityLiters: capLiters,
        },
        settings: {
          capacity_liters: capLiters,
          alarmThresholdPercent: isWaste ? 85 : 15,
        },
        capabilities,
      };
    });
  }
}

export default FluidTankDriver;
module.exports = FluidTankDriver;
module.exports.FluidTankDriver = FluidTankDriver;
