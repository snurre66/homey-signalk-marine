import Homey from 'homey';
import { SignalKAuthManager } from '../../lib/SignalKAuthManager';
import { PathDiscoveryService } from '../../lib/PathDiscoveryService';
import {
  attachM3PairHandlers,
  attachM3RepairHandlers,
  resolveActiveServerId,
  resolveConnectionPool,
  resolveDiscoveryService,
} from './M3DriverHelper';

export interface ElectricalBankPairDescriptor {
  name: string;
  data: {
    id: string;
    serverId: string;
    bankType: string;
    bankId: string;
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
    bankType: string;
    bankId: string;
    basePath: string;
    category?: string;
    presetMatchId?: string;
  };
  capabilities: string[];
  energy?: Record<string, unknown>;
}

const CAPABILITIES_BY_BANK_TYPE: Record<string, string[]> = {
  battery: [
    'measure_battery',
    'measure_voltage',
    'measure_current',
    'measure_power',
    'meter_power',
    'measure_remaining_ah',
    'measure_time_remaining',
    'measure_temperature',
    'alarm_battery',
  ],
  solar: ['measure_voltage', 'measure_current', 'measure_power', 'meter_power'],
  charger: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
  inverter: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
  alternator: ['measure_voltage', 'measure_current', 'measure_power', 'measure_temperature'],
  ac_bus: ['measure_voltage', 'measure_current', 'measure_power'],
};

const ENERGY_BY_BANK_TYPE: Record<string, Record<string, unknown>> = {
  battery: { homeBattery: true, batteries: ['INTERNAL'] },
  solar: { cumulative: false },
};

export class ElectricalBankDriver extends Homey.Driver {
  private readonly fallbackAuth = new SignalKAuthManager();
  private readonly fallbackDiscovery = new PathDiscoveryService();

  public override async onInit(): Promise<void> {
    this.log('ElectricalBankDriver initialized');
  }

  public override async onPair(session: Homey.Driver.PairSession): Promise<void> {
    attachM3PairHandlers(this, session, this.fallbackAuth, async (state) => {
      return this.discoverElectricalBankDescriptors(state.serverId, {
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
  ): Promise<ElectricalBankPairDescriptor[]> {
    const effectiveServerId = resolveActiveServerId(this.homey, serverId);
    return this.discoverElectricalBankDescriptors(effectiveServerId);
  }

  public override async onRepair(
    session: Homey.Driver.PairSession,
    device?: Homey.Device,
  ): Promise<void> {
    attachM3RepairHandlers(this, session, device, this.fallbackAuth);
  }

  public async discoverElectricalBankDescriptors(
    serverId: string,
    connMeta?: {
      host?: string;
      port?: number;
      useTls?: boolean;
      allowSelfSigned?: boolean;
      token?: string;
      clientId?: string;
    },
  ): Promise<ElectricalBankPairDescriptor[]> {
    const pool = resolveConnectionPool(this.homey);
    const discovery = resolveDiscoveryService(this.homey, this.fallbackDiscovery);

    if (!pool) {
      return [];
    }

    const selfTree = await pool.getVesselSubtree(serverId);
    const instances = discovery.discoverElectricalBanks(selfTree);

    return instances.map((inst) => {
      const bankType = inst.category;
      const bankId = inst.instanceKey;
      const capabilities = [
        ...(CAPABILITIES_BY_BANK_TYPE[bankType] || [
          'measure_voltage',
          'measure_current',
          'measure_power',
        ]),
      ];

      // Include charger_inverter_mode if writable mode path is present
      if (
        inst.supportsPut &&
        !capabilities.includes('charger_inverter_mode') &&
        (bankType === 'charger' || bankType === 'inverter')
      ) {
        capabilities.push('charger_inverter_mode');
      }

      const energy = ENERGY_BY_BANK_TYPE[bankType];

      return {
        name: inst.name,
        data: {
          id: `${serverId}::${bankType}::${bankId}`,
          serverId,
          bankType,
          bankId,
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
          bankType,
          bankId,
          basePath: inst.basePath,
          category: inst.category,
          presetMatchId: inst.presetMatchId,
        },
        capabilities,
        ...(energy ? { energy } : {}),
      };
    });
  }
}

export default ElectricalBankDriver;
module.exports = ElectricalBankDriver;
module.exports.ElectricalBankDriver = ElectricalBankDriver;
