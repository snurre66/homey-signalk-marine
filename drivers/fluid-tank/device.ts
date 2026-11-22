import Homey from 'homey';
import { UnitConverter } from '../../lib/UnitConverter';
import type { ThrottleTier } from '../../lib/SignalKConnectionPool';
import {
  resolveActiveServerId,
  resolveConnectionPool,
  resolveThrottleTier,
} from '../electrical-bank/M3DriverHelper';

function roundValue(val: number, decimals = 1): number {
  const factor = 10 ** decimals;
  const rounded = Math.round((val + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
}

export class FluidTankDevice extends Homey.Device {
  private readonly fallbackUnitConverter = new UnitConverter();
  private unsubs: Array<() => void> = [];
  private authUnsub: (() => void) | null = null;
  private serverId = 'default';
  private tankType = 'freshWater';
  private tankId = '0';
  private basePath = 'tanks.freshWater.0';
  private capacityLiters: number | null = null;
  private hasExplicitVolume = false;
  private lastLevelPct: number | null = null;

  private getUnitConverter(): UnitConverter {
    return (this.homey?.app as any)?.unitConverter ?? this.fallbackUnitConverter;
  }

  public override async onInit(): Promise<void> {
    this.clearSubscriptions();

    const data = this.getData() || {};
    this.serverId = resolveActiveServerId(
      this.homey,
      this.getStoreValue('serverId') || data.serverId,
    );
    this.tankType = String(this.getStoreValue('tankType') || data.tankType || 'freshWater');
    this.tankId = String(this.getStoreValue('tankId') ?? data.tankId ?? '0');
    this.basePath = String(
      this.getStoreValue('basePath') || data.basePath || `tanks.${this.tankType}.${this.tankId}`,
    );

    const rawCap =
      this.getSetting('capacity_liters') ?? this.getStoreValue('capacityLiters') ?? null;
    this.capacityLiters =
      typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap > 0 ? rawCap : null;
    this.hasExplicitVolume = false;
    this.lastLevelPct = null;

    this.bindSubscriptions();
    this.bindAuthErrorListener();
  }

  private bindAuthErrorListener(): void {
    const pool = resolveConnectionPool(this.homey) as any;
    if (!pool) return;

    if (typeof pool.onAuthFailure === 'function') {
      this.authUnsub = pool.onAuthFailure(this.serverId, ({ message }: { message?: string }) => {
        this.setUnavailable(
          message || 'Authentication required — please use Repair Device to reconnect.',
        ).catch(() => {});
      });
    } else if (typeof pool.on === 'function') {
      const handler = ({ serverId, statusCode }: { serverId: string; statusCode?: number }) => {
        if (serverId === this.serverId) {
          this.setUnavailable(
            `Signal K authentication error (HTTP ${statusCode ?? 401}) — please use Repair Device.`,
          ).catch(() => {});
        }
      };
      pool.on('authError', handler);
      this.authUnsub = () => {
        if (typeof pool.off === 'function') {
          pool.off('authError', handler);
        } else if (typeof pool.removeListener === 'function') {
          pool.removeListener('authError', handler);
        }
      };
    }
  }

  private bindSubscriptions(): void {
    this.clearPathSubscriptions();

    const pool = resolveConnectionPool(this.homey);
    if (!pool) return;

    const settings = this.getSettings() || {};
    const tier: ThrottleTier = resolveThrottleTier(settings.throttleTier, 'slow');
    const sourceFilter =
      typeof settings.sourceFilter === 'string' && settings.sourceFilter.trim().length > 0
        ? settings.sourceFilter.trim()
        : this.getStoreValue('sourceFilter') || undefined;

    const subId = this.getData()?.id || `${this.serverId}::${this.basePath}`;

    this.unsubs.push(
      pool.subscribe(this.serverId, {
        subscriberId: subId,
        path: `${this.basePath}.capacity`,
        tier,
        sourceFilter,
        onUpdate: ({ value }) => {
          const capL = this.getUnitConverter().fromSignalK(value, 'volume_m3_to_l', 1);
          if (capL !== null && capL > 0) {
            this.capacityLiters = capL;
          }
        },
      }),
    );

    this.unsubs.push(
      pool.subscribe(this.serverId, {
        subscriberId: subId,
        path: `${this.basePath}.currentVolume`,
        tier,
        sourceFilter,
        onUpdate: ({ value }) => {
          this.handleCurrentVolume(value).catch((err) => {
            this.error(`Error handling fluid-tank currentVolume update:`, err);
          });
        },
      }),
    );

    this.unsubs.push(
      pool.subscribe(this.serverId, {
        subscriberId: subId,
        path: `${this.basePath}.currentLevel`,
        tier,
        sourceFilter,
        onUpdate: ({ value }) => {
          this.handleCurrentLevel(value).catch((err) => {
            this.error(`Error handling fluid-tank currentLevel update:`, err);
          });
        },
      }),
    );
  }

  private async handleCurrentVolume(value: unknown): Promise<void> {
    if (value === null) {
      if (this.hasCapability('measure_tank_volume')) {
        await this.setCapabilityValue('measure_tank_volume', null);
      }
      if (this.tankType === 'freshWater' && this.hasCapability('meter_water')) {
        await this.setCapabilityValue('meter_water', null);
      }
      return;
    }

    const volL = this.getUnitConverter().fromSignalK(value, 'volume_m3_to_l', 1);
    if (volL === null) return;

    this.hasExplicitVolume = true;
    const nonNegativeL = Math.max(0, volL);
    if (this.hasCapability('measure_tank_volume')) {
      await this.setCapabilityValue('measure_tank_volume', nonNegativeL);
    }

    if (
      this.tankType === 'freshWater' &&
      this.hasCapability('meter_water') &&
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      await this.setCapabilityValue('meter_water', roundValue(Math.max(0, value), 3));
    }
  }

  private async handleCurrentLevel(value: unknown): Promise<void> {
    if (value === null) {
      this.lastLevelPct = null;
      if (this.hasCapability('measure_tank_level')) {
        await this.setCapabilityValue('measure_tank_level', null);
      }
      if (!this.hasExplicitVolume && this.hasCapability('measure_tank_volume')) {
        await this.setCapabilityValue('measure_tank_volume', null);
      }
      return;
    }

    const rawPct = this.getUnitConverter().fromSignalK(value, 'ratio_to_percent', 1);
    if (rawPct === null) return;

    const levelPct = Math.max(0, Math.min(100, rawPct));
    this.lastLevelPct = levelPct;

    if (this.hasCapability('measure_tank_level')) {
      await this.setCapabilityValue('measure_tank_level', levelPct);
    }

    if (
      !this.hasExplicitVolume &&
      typeof this.capacityLiters === 'number' &&
      this.capacityLiters > 0
    ) {
      const derivedLiters = roundValue((levelPct / 100) * this.capacityLiters, 1);
      if (this.hasCapability('measure_tank_volume')) {
        await this.setCapabilityValue('measure_tank_volume', derivedLiters);
      }
      if (this.tankType === 'freshWater' && this.hasCapability('meter_water')) {
        await this.setCapabilityValue('meter_water', roundValue(derivedLiters / 1000, 3));
      }
    }

    await this.evaluateTankAlarm(levelPct);
  }

  private async evaluateTankAlarm(levelPct: number): Promise<void> {
    const isWaste = this.tankType === 'blackWater' || this.tankType === 'wasteWater';
    const defaultThreshold = isWaste ? 85 : 15;

    const rawThreshold =
      this.getSetting('alarmThresholdPercent') ??
      this.getSetting('alarm_threshold_percent');
    const threshold =
      typeof rawThreshold === 'number' && Number.isFinite(rawThreshold)
        ? rawThreshold
        : rawThreshold !== undefined && rawThreshold !== null && rawThreshold !== '' && Number.isFinite(Number(rawThreshold))
          ? Number(rawThreshold)
          : defaultThreshold;

    const isAlarm = isWaste ? levelPct >= threshold : levelPct <= threshold;

    if (this.hasCapability('alarm_generic')) {
      await this.setCapabilityValue('alarm_generic', isAlarm);
    }
    if (this.hasCapability('alarm_water') && isWaste) {
      await this.setCapabilityValue('alarm_water', isAlarm);
    }
  }

  public override async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    const rawThreshold =
      newSettings.alarmThresholdPercent !== undefined
        ? newSettings.alarmThresholdPercent
        : newSettings.alarm_threshold_percent;

    if (rawThreshold !== undefined && rawThreshold !== null) {
      const val = Number(rawThreshold);
      if (!Number.isFinite(val) || val < 0 || val > 100) {
        throw new Error('Tank alarm threshold must be between 0 and 100%');
      }
    }

    if (changedKeys.includes('capacity_liters')) {
      const cap = Number(newSettings.capacity_liters);
      if (!Number.isFinite(cap) || cap < 0) {
        throw new Error('Tank capacity must be a non-negative number in liters');
      }
      this.capacityLiters = cap > 0 ? cap : null;
    }

    if (
      changedKeys.includes('throttleTier') ||
      changedKeys.includes('sourceFilter')
    ) {
      this.bindSubscriptions();
    }

    if (this.lastLevelPct !== null) {
      await this.evaluateTankAlarm(this.lastLevelPct);
    }
  }

  public override onDiscoveryResult(discoveryResult: any): boolean {
    const dataId = this.getData()?.id;
    const storeServerId = this.getStoreValue('serverId');
    return (
      discoveryResult?.id === dataId ||
      discoveryResult?.id === storeServerId ||
      discoveryResult?.txt?.self === storeServerId
    );
  }

  public override async onDiscoveryAddressChanged(discoveryResult: any): Promise<void> {
    const nextHost = discoveryResult?.address || discoveryResult?.host;
    const nextPort = Number(discoveryResult?.port) || 3000;
    if (nextHost) {
      await this.setStoreValue('host', nextHost);
    }
    await this.setStoreValue('port', nextPort);
    const pool = resolveConnectionPool(this.homey);
    if (pool && nextHost) {
      await pool.updateServerAddress(this.serverId, nextHost, nextPort);
    }
    await this.setAvailable();
  }

  private clearPathSubscriptions(): void {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // Ignore teardown errors
      }
    }
    this.unsubs = [];
  }

  private clearSubscriptions(): void {
    this.clearPathSubscriptions();
    if (this.authUnsub) {
      try {
        this.authUnsub();
      } catch {
        // Ignore
      }
      this.authUnsub = null;
    }
  }

  public override async onUninit(): Promise<void> {
    this.clearSubscriptions();
  }
}

export default FluidTankDevice;
module.exports = FluidTankDevice;
module.exports.FluidTankDevice = FluidTankDevice;
