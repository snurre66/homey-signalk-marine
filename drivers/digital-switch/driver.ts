import Homey from 'homey';
import { SignalKAuthManager } from '../../lib/SignalKAuthManager';
import { PathDiscoveryService } from '../../lib/PathDiscoveryService';
import {
  attachM3PairHandlers,
  attachM3RepairHandlers,
  resolveActiveServerId,
  resolveConnectionPool,
  resolveDiscoveryService,
} from '../electrical-bank/M3DriverHelper';

export interface DigitalSwitchPairDescriptor {
  name: string;
  data: {
    id: string;
    serverId: string;
    switchId: string;
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
    switchId: string;
    basePath: string;
    hasDim: boolean;
    sourceFilter?: string;
    presetMatchId?: string;
  };
  capabilities: string[];
}

export class DigitalSwitchDriver extends Homey.Driver {
  private readonly fallbackAuth = new SignalKAuthManager();
  private readonly fallbackDiscovery = new PathDiscoveryService();

  public override async onInit(): Promise<void> {
    this.log('DigitalSwitchDriver initialized');
  }

  public override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    attachM3PairHandlers(this, session, this.fallbackAuth, async (state) => {
      return this.discoverDigitalSwitchDescriptors(state.serverId, {
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
  ): Promise<DigitalSwitchPairDescriptor[]> {
    const effectiveServerId = resolveActiveServerId(this.homey, serverId);
    return this.discoverDigitalSwitchDescriptors(effectiveServerId);
  }

  public override async onRepair(
    session: Homey.Driver.PairSession,
    device?: Homey.Device,
  ): Promise<void> {
    attachM3RepairHandlers(this, session, device, this.fallbackAuth);
  }

  public async discoverDigitalSwitchDescriptors(
    serverId: string,
    connMeta?: {
      host?: string;
      port?: number;
      useTls?: boolean;
      allowSelfSigned?: boolean;
      token?: string;
      clientId?: string;
    },
  ): Promise<DigitalSwitchPairDescriptor[]> {
    const pool = resolveConnectionPool(this.homey);
    const discovery = resolveDiscoveryService(this.homey, this.fallbackDiscovery);

    if (!pool) {
      return [];
    }

    const selfTree = await pool.getVesselSubtree(serverId);
    const instances = discovery.discoverDigitalSwitches(selfTree);

    return instances.map((inst) => {
      const switchId = inst.instanceKey.startsWith('bank.')
        ? inst.instanceKey.slice('bank.'.length)
        : inst.instanceKey;
      const hasDim = Boolean(inst.supportsDim);
      const capabilities = hasDim ? ['onoff', 'dim'] : ['onoff'];

      return {
        name: inst.name,
        data: {
          id: `${serverId}::switch::${inst.basePath}`,
          serverId,
          switchId,
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
          switchId,
          basePath: inst.basePath,
          hasDim,
          presetMatchId: inst.presetMatchId,
        },
        capabilities,
      };
    });
  }
}

export default DigitalSwitchDriver;
module.exports = DigitalSwitchDriver;
module.exports.DigitalSwitchDriver = DigitalSwitchDriver;
