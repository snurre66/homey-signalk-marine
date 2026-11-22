import Homey from 'homey';
import { UnitConverter } from '../../lib/UnitConverter';
import type { PathUpdateEvent, ThrottleTier } from '../../lib/SignalKConnectionPool';
import {
  resolveActiveServerId,
  resolveConnectionPool,
  resolveThrottleTier,
} from './M3DriverHelper';

const STANDARD_SOC_THRESHOLDS = [50, 40, 30, 25, 20, 15, 10];
const ALLOWED_MODES = new Set(['on', 'charger_only', 'inverter_only', 'eco', 'off']);

function roundValue(val: number, decimals = 2): number {
  const factor = 10 ** decimals;
  const rounded = Math.round((val + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) || rounded === 0 ? 0 : rounded;
}

export class ElectricalBankDevice extends Homey.Device {
  private readonly fallbackUnitConverter = new UnitConverter();
  private unsubs: Array<() => void> = [];
  private authUnsub: (() => void) | null = null;
  private serverId = 'default';
  private bankType = 'battery';
  private bankId = 'house';
  private basePath = 'electrical.batteries.house';

  private lastVoltage: number | null = null;
  private lastCurrent: number | null = null;
  private hasExplicitPower = false;
  private readonly socBelowTriggered = new Set<number>();

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
    this.bankType = String(this.getStoreValue('bankType') || data.bankType || 'battery');
    this.bankId = String(this.getStoreValue('bankId') ?? data.bankId ?? 'house');
    this.basePath = String(
      this.getStoreValue('basePath') || data.basePath || this.defaultBasePath(this.bankType, this.bankId),
    );

    this.lastVoltage = null;
    this.lastCurrent = null;
    this.hasExplicitPower = false;
    this.socBelowTriggered.clear();

    this.registerModeListener();
    this.bindSubscriptions();
    this.bindAuthErrorListener();
  }

  private defaultBasePath(bankType: string, bankId: string): string {
    switch (bankType) {
      case 'solar':
        return `electrical.solar.${bankId}`;
      case 'charger':
        return `electrical.chargers.${bankId}`;
      case 'inverter':
        return `electrical.inverters.${bankId}`;
      case 'alternator':
        return `electrical.alternators.${bankId}`;
      case 'ac_bus':
        return `electrical.ac.${bankId}`;
      case 'battery':
      default:
        return `electrical.batteries.${bankId}`;
    }
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

    const subPath = (
      fullPath: string,
      pathTier: ThrottleTier,
      handler: (update: PathUpdateEvent) => Promise<void> | void,
    ) => {
      this.unsubs.push(
        pool.subscribe(this.serverId, {
          subscriberId: this.getData()?.id || `${this.serverId}::${this.basePath}`,
          path: fullPath,
          tier: pathTier,
          sourceFilter,
          onUpdate: (update) => {
            Promise.resolve(handler(update)).catch((err) => {
              this.error(`Error handling electrical-bank update on ${update.path}:`, err);
            });
          },
        }),
      );
    };

    const subRel = (
      relPath: string,
      pathTier: ThrottleTier,
      handler: (update: PathUpdateEvent) => Promise<void> | void,
    ) => {
      subPath(`${this.basePath}.${relPath}`, pathTier, handler);
    };

    if (this.bankType === 'battery') {
      subRel('voltage', tier, async ({ value }) => this.handleVoltage(value));
      subRel('current', tier, async ({ value }) => this.handleCurrent(value));
      subRel('power', tier, async ({ value }) => this.handlePower(value));
      subRel('temperature', tier, async ({ value }) => this.handleTemperature(value));
      subRel('capacity.stateOfCharge', tier, async ({ value }) => this.handleSoc(value));
      subRel('capacity.remaining', tier, async ({ value }) => this.handleRemainingAh(value));
      subRel('capacity.timeRemaining', tier, async ({ value }) => this.handleTimeRemaining(value));
      subRel('lifetimeDischarge', tier, async ({ value }) => this.handleEnergyJoules(value));
    } else if (this.bankType === 'solar') {
      subRel('panelVoltage', tier, async ({ value }) => this.handleVoltage(value));
      subRel('voltage', tier, async ({ value }) => {
        if (!this.hasCapability('measure_voltage')) return;
        if (this.getCapabilityValue('measure_voltage') === null && typeof value === 'number') {
          await this.handleVoltage(value);
        }
      });
      subRel('current', tier, async ({ value }) => this.handleCurrent(value));
      subRel('panelPower', tier, async ({ value }) => this.handlePower(value));
      subRel('yieldToday', tier, async ({ value }) => this.handleEnergyJoules(value));
    } else if (this.bankType === 'inverter') {
      subRel('dc.voltage', tier, async ({ value }) => this.handleVoltage(value));
      subRel('dc.current', tier, async ({ value }) => this.handleCurrent(value));
      subRel('ac.voltage', tier, async ({ value }) => {
        if (this.lastVoltage === null) {
          await this.handleVoltage(value);
        }
      });
      subRel('ac.power', tier, async ({ value }) => this.handlePower(value));
      subRel('inverterMode', 'fast', async ({ value }) => this.handleModeUpdate(value));
    } else if (this.bankType === 'charger') {
      subRel('voltage', tier, async ({ value }) => this.handleVoltage(value));
      subRel('current', tier, async ({ value }) => this.handleCurrent(value));
      subRel('power', tier, async ({ value }) => this.handlePower(value));
      subRel('mode', 'fast', async ({ value }) => this.handleModeUpdate(value));
    } else if (this.bankType === 'ac_bus') {
      subRel('phaseA.voltage', tier, async ({ value }) => this.handleVoltage(value));
      subRel('phaseA.current', tier, async ({ value }) => this.handleCurrent(value));
      subRel('phaseA.realPower', tier, async ({ value }) => this.handlePower(value));
    } else if (this.bankType === 'alternator') {
      subRel('voltage', tier, async ({ value }) => this.handleVoltage(value));
      subRel('current', tier, async ({ value }) => this.handleCurrent(value));
      subRel('power', tier, async ({ value }) => this.handlePower(value));
      subRel('temperature', tier, async ({ value }) => this.handleTemperature(value));
    }
  }

  private async handleVoltage(value: unknown): Promise<void> {
    if (value === null) {
      this.lastVoltage = null;
      return;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.lastVoltage = value;
    if (this.hasCapability('measure_voltage')) {
      await this.setCapabilityValue('measure_voltage', roundValue(value, 2));
    }
    if (!this.hasExplicitPower && this.lastCurrent !== null && this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', roundValue(this.lastVoltage * this.lastCurrent, 2));
    }
    await this.evaluateBatteryAlarm();
  }

  private async handleCurrent(value: unknown): Promise<void> {
    if (value === null) {
      this.lastCurrent = null;
      return;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.lastCurrent = value;
    if (this.hasCapability('measure_current')) {
      await this.setCapabilityValue('measure_current', roundValue(value, 2));
    }
    if (!this.hasExplicitPower && this.lastVoltage !== null && this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', roundValue(this.lastVoltage * this.lastCurrent, 2));
    }
  }

  private async handlePower(value: unknown): Promise<void> {
    if (value === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    this.hasExplicitPower = true;
    if (this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', roundValue(value, 2));
    }
  }

  private async handleTemperature(value: unknown): Promise<void> {
    const tempC = this.getUnitConverter().fromSignalK(value, 'temperature_k_to_c', 1);
    if (tempC !== null && this.hasCapability('measure_temperature')) {
      await this.setCapabilityValue('measure_temperature', tempC);
    }
  }

  private async handleSoc(value: unknown): Promise<void> {
    if (value === null) {
      if (this.hasCapability('measure_battery')) {
        await this.setCapabilityValue('measure_battery', null);
      }
      return;
    }
    const pct = this.getUnitConverter().fromSignalK(value, 'ratio_to_percent', 1);
    if (pct === null) return;

    const clamped = Math.max(0, Math.min(100, pct));
    const prevSoc = this.hasCapability('measure_battery')
      ? this.getCapabilityValue('measure_battery')
      : null;

    if (this.hasCapability('measure_battery')) {
      await this.setCapabilityValue('measure_battery', clamped);
    }

    await this.evaluateBatteryAlarm();
    await this.evaluateSocThresholds(typeof prevSoc === 'number' ? prevSoc : null, clamped);
  }

  private async handleRemainingAh(value: unknown): Promise<void> {
    if (value === null) {
      if (this.hasCapability('measure_remaining_ah')) {
        await this.setCapabilityValue('measure_remaining_ah', null);
      }
      return;
    }
    const ah = this.getUnitConverter().fromSignalK(value, 'charge_c_to_ah', 1);
    if (ah !== null && this.hasCapability('measure_remaining_ah')) {
      await this.setCapabilityValue('measure_remaining_ah', Math.max(0, ah));
    }
  }

  private async handleTimeRemaining(value: unknown): Promise<void> {
    if (value === null) {
      if (this.hasCapability('measure_time_remaining')) {
        await this.setCapabilityValue('measure_time_remaining', null);
      }
      return;
    }
    const mins = this.getUnitConverter().fromSignalK(value, 'duration_s_to_min', 0);
    if (mins !== null && this.hasCapability('measure_time_remaining')) {
      await this.setCapabilityValue('measure_time_remaining', Math.max(0, mins));
    }
  }

  private async handleEnergyJoules(value: unknown): Promise<void> {
    if (value === null) return;
    const kwh = this.getUnitConverter().fromSignalK(value, 'energy_j_to_kwh', 2);
    if (kwh !== null && this.hasCapability('meter_power')) {
      await this.setCapabilityValue('meter_power', Math.max(0, kwh));
    }
  }

  private async handleModeUpdate(value: unknown): Promise<void> {
    if (typeof value === 'string' && this.hasCapability('charger_inverter_mode')) {
      const normalized = value.trim();
      if (normalized.length > 0) {
        await this.setCapabilityValue('charger_inverter_mode', normalized);
      }
    }
  }

  private registerModeListener(): void {
    if (!this.hasCapability('charger_inverter_mode')) {
      return;
    }

    this.registerCapabilityListener('charger_inverter_mode', async (mode: string) => {
      if (this.bankType !== 'inverter' && this.bankType !== 'charger') {
        const err = new Error('405 PUT not supported on passive battery/solar bank') as Error & {
          statusCode?: number;
        };
        err.statusCode = 405;
        throw err;
      }

      const cleanMode = String(mode ?? '').trim();
      if (!ALLOWED_MODES.has(cleanMode)) {
        throw new Error(`Invalid charger/inverter mode "${cleanMode}"`);
      }

      const pool = resolveConnectionPool(this.homey);
      if (!pool) {
        throw new Error('Signal K connection pool is not initialized');
      }

      const targetPath =
        this.bankType === 'inverter'
          ? `electrical.inverters.${this.bankId}.inverterMode`
          : `electrical.chargers.${this.bankId}.mode`;

      const settings = this.getSettings() || {};
      const source =
        typeof settings.sourceFilter === 'string' && settings.sourceFilter.trim().length > 0
          ? settings.sourceFilter.trim()
          : this.getStoreValue('sourceFilter') || undefined;

      const prevMode = this.getCapabilityValue('charger_inverter_mode');
      await this.setCapabilityValue('charger_inverter_mode', cleanMode);

      try {
        const result = await pool.putPath(this.serverId, targetPath, cleanMode, { source });
        if (result.state === 'FAILED') {
          const err = new Error(
            result.message || `PUT ${targetPath} failed with HTTP ${result.statusCode}`,
          ) as Error & { statusCode?: number; state?: string };
          err.statusCode = result.statusCode;
          err.state = result.state;
          throw err;
        }
        if (result.statusCode === 401 || result.statusCode === 403) {
          await this.setUnavailable(result.message || 'Authentication required').catch(() => {});
          const err = new Error(result.message || 'Authentication required') as Error & {
            statusCode?: number;
          };
          err.statusCode = result.statusCode;
          throw err;
        }
      } catch (err) {
        await this.setCapabilityValue('charger_inverter_mode', prevMode ?? null).catch(() => {});
        throw err;
      }
    });
  }

  private async evaluateBatteryAlarm(): Promise<void> {
    if (!this.hasCapability('alarm_battery')) {
      return;
    }
    const lowSocRaw = this.getSetting('lowSocThreshold');
    const lowVoltRaw = this.getSetting('lowVoltageThreshold');
    const lowSocThreshold =
      typeof lowSocRaw === 'number' && Number.isFinite(lowSocRaw) ? lowSocRaw : 20;
    const lowVoltThreshold =
      typeof lowVoltRaw === 'number' && Number.isFinite(lowVoltRaw) ? lowVoltRaw : 11.8;

    const soc = this.hasCapability('measure_battery')
      ? this.getCapabilityValue('measure_battery')
      : null;
    const volt = this.hasCapability('measure_voltage')
      ? this.getCapabilityValue('measure_voltage')
      : null;

    const isLowSoc = typeof soc === 'number' && Number.isFinite(soc) && soc <= lowSocThreshold;
    const isLowVolt =
      typeof volt === 'number' && Number.isFinite(volt) && volt <= lowVoltThreshold;
    await this.setCapabilityValue('alarm_battery', Boolean(isLowSoc || isLowVolt));
  }

  private async evaluateSocThresholds(prevSoc: number | null, newSoc: number): Promise<void> {
    const thresholds = [...STANDARD_SOC_THRESHOLDS];
    const configuredThreshold = Number(this.getSetting('lowSocThreshold') ?? 20);
    if (Number.isFinite(configuredThreshold) && !thresholds.includes(configuredThreshold)) {
      thresholds.push(configuredThreshold);
    }

    for (const t of Array.from(this.socBelowTriggered)) {
      if (newSoc > t) {
        this.socBelowTriggered.delete(t);
      }
    }

    const triggerCard = this.homey?.flow?.getTriggerCard?.('battery_soc_below_threshold');
    if (!triggerCard) return;

    const voltage =
      typeof this.lastVoltage === 'number' && Number.isFinite(this.lastVoltage)
        ? this.lastVoltage
        : 0;

    for (const threshold of thresholds) {
      const crossedDown = (prevSoc === null || prevSoc >= threshold) && newSoc < threshold;
      if (crossedDown && !this.socBelowTriggered.has(threshold)) {
        this.socBelowTriggered.add(threshold);
        const tokens = {
          bank_name: this.bankId,
          bankId: this.bankId,
          soc: newSoc,
          voltage,
          threshold,
        };
        try {
          await triggerCard.trigger(tokens, tokens);
        } catch {
          // Trigger card may not have listeners registered in unit mocks
        }
      }
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
    if (changedKeys.includes('lowSocThreshold')) {
      const val = Number(newSettings.lowSocThreshold);
      if (!Number.isFinite(val) || val < 0 || val > 100) {
        throw new Error('Low SOC threshold must be between 0 and 100%');
      }
    }
    if (changedKeys.includes('lowVoltageThreshold')) {
      const val = Number(newSettings.lowVoltageThreshold);
      if (!Number.isFinite(val) || val < 0) {
        throw new Error('Low voltage threshold must be a positive number');
      }
    }

    if (
      changedKeys.includes('throttleTier') ||
      changedKeys.includes('sourceFilter')
    ) {
      this.bindSubscriptions();
    }

    await this.evaluateBatteryAlarm();
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

export default ElectricalBankDevice;
module.exports = ElectricalBankDevice;
module.exports.ElectricalBankDevice = ElectricalBankDevice;
