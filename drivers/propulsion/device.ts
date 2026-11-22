import Homey from 'homey';
import { UnitConverter } from '../../lib/UnitConverter';
import type {
  ISignalKConnectionPool,
  PathUpdateEvent,
  ThrottleTier,
} from '../../lib/SignalKConnectionPool';
import { resolveThrottleTier } from '../vessel/SignalKDriverHelper';

const ACTIVE_ALARM_STATES = new Set(['alert', 'warn', 'alarm', 'emergency']);

export default class PropulsionDevice extends Homey.Device {
  private readonly unitConverter = new UnitConverter();
  private unsubs: Array<() => void> = [];
  private poolListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private serverId = 'default';
  private engineId = 'port';
  private activeNotificationAlarms = new Map<string, boolean>();

  public override async onInit(): Promise<void> {
    this.unsubs = [];
    this.poolListeners = [];
    this.activeNotificationAlarms.clear();

    this.serverId =
      String(this.getStoreValue('serverId') || this.getData()?.serverId || 'default');
    this.engineId = String(
      this.getSetting('engineId') ||
        this.getData()?.engineId ||
        this.getStoreValue('engineId') ||
        'port',
    ).trim();

    await this.ensureServerConnection();
    this.setupPoolEventHandlers();
    this.bindSubscriptions();

    // STRICTLY READ-ONLY: Do NOT register any capability listeners.
    // Safety boundary leaves all propulsion.* paths read-only.
  }

  private getPool(): ISignalKConnectionPool | undefined {
    return (this.homey?.app as any)?.connectionPool;
  }

  private getUnitConverter(): UnitConverter {
    return (this.homey?.app as any)?.unitConverter ?? this.unitConverter;
  }

  private async ensureServerConnection(): Promise<void> {
    const pool = this.getPool();
    if (!pool) return;

    const host = this.getStoreValue('host') || this.getSetting('host');
    const port = Number(this.getStoreValue('port') ?? this.getSetting('port'));
    if (typeof host === 'string' && host.trim().length > 0 && Number.isInteger(port) && port > 0) {
      const useTls = Boolean(this.getStoreValue('useTls') ?? this.getSetting('useTls'));
      const allowSelfSigned =
        (this.getStoreValue('allowSelfSigned') ?? this.getSetting('allowSelfSigned')) !== false;
      const token = this.getStoreValue('token') || this.getSetting('token') || undefined;
      const clientId = this.getStoreValue('clientId') || undefined;

      try {
        await pool.acquireConnection({
          serverId: this.serverId,
          host: host.trim(),
          port,
          useTls,
          allowSelfSigned,
          token,
          clientId,
        });
      } catch (err: any) {
        this.error('Initial propulsion connection attempt failed:', err?.message || err);
      }
    }
  }

  private setupPoolEventHandlers(): void {
    const pool = this.getPool() as any;
    if (!pool || typeof pool.on !== 'function') return;

    const onAuthError = (evt: { serverId?: string; message?: string }) => {
      if (evt?.serverId && evt.serverId !== this.serverId) return;
      this.setUnavailable(
        evt?.message ||
          this.homey.__('errors.auth_required') ||
          'Authentication required — please use Repair Device to request a new Signal K token.',
      ).catch(() => {});
    };

    const onConnected = (evt: { serverId?: string }) => {
      if (evt?.serverId && evt.serverId !== this.serverId) return;
      this.setAvailable().catch(() => {});
    };

    pool.on('authError', onAuthError);
    pool.on('connected', onConnected);
    this.poolListeners.push({ event: 'authError', fn: onAuthError });
    this.poolListeners.push({ event: 'connected', fn: onConnected });

    if (typeof pool.onAuthFailure === 'function') {
      this.unsubs.push(
        pool.onAuthFailure(this.serverId, ({ message }: { message?: string }) => {
          this.setUnavailable(
            message || 'Authentication required — please use Repair Device',
          ).catch(() => {});
        }),
      );
    }
  }

  private clearSubscriptions(): void {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // ignore cleanup error
      }
    }
    this.unsubs = [];
  }

  private bindSubscriptions(): void {
    this.clearSubscriptions();
    const pool = this.getPool();
    if (!pool) return;

    const rawSourceFilter =
      this.getSetting('sourceFilter') ?? this.getSetting('source_filter') ?? '';
    const sourceFilter =
      typeof rawSourceFilter === 'string' && rawSourceFilter.trim().length > 0
        ? rawSourceFilter.trim()
        : undefined;

    const baseTier: ThrottleTier = resolveThrottleTier(
      this.getSetting('throttleTier'),
      'medium',
    );
    const subscriberId = String(
      this.getData()?.id || `propulsion:${this.serverId}:${this.engineId}`,
    );
    const basePath = `propulsion.${this.engineId}`;

    const subPaths = [
      `${basePath}.state`,
      `${basePath}.revolutions`,
      `${basePath}.temperature`,
      `${basePath}.coolantTemperature`,
      `${basePath}.exhaustTemperature`,
      `${basePath}.oilPressure`,
      `${basePath}.coolantPressure`,
      `${basePath}.runTime`,
      `${basePath}.fuel.rate`,
      `${basePath}.transmission.gear`,
      `notifications.propulsion.${this.engineId}.*`,
    ];

    for (const skPath of subPaths) {
      const tier: ThrottleTier = skPath.startsWith('notifications.')
        ? 'fast'
        : skPath.endsWith('.runTime') && baseTier !== 'fast'
          ? 'slow'
          : baseTier;

      this.unsubs.push(
        pool.subscribe(this.serverId, {
          subscriberId,
          path: skPath,
          tier,
          sourceFilter,
          onUpdate: (update: PathUpdateEvent) => {
            void this.handlePropulsionUpdate(update);
          },
        }),
      );
    }
  }

  public async handlePropulsionUpdate(update: PathUpdateEvent): Promise<void> {
    const { path: skPath, value } = update;
    const basePath = `propulsion.${this.engineId}`;
    const uc = this.getUnitConverter();

    try {
      if (skPath === `${basePath}.revolutions`) {
        const rpm = uc.fromSignalK(value, 'frequency_hz_to_rpm', 0);
        if (rpm !== null && this.hasCapability('measure_engine_rpm')) {
          await this.setCapabilityValue('measure_engine_rpm', rpm);
        }
      } else if (
        skPath === `${basePath}.temperature` ||
        skPath === `${basePath}.coolantTemperature`
      ) {
        const tempC = uc.fromSignalK(value, 'temperature_k_to_c', 1);
        if (tempC !== null && this.hasCapability('measure_temperature')) {
          await this.setCapabilityValue('measure_temperature', tempC);
        }
      } else if (skPath === `${basePath}.exhaustTemperature`) {
        const exhaustC = uc.fromSignalK(value, 'temperature_k_to_c', 1);
        if (exhaustC !== null) {
          await this.setStoreValue('exhaustTemperatureC', exhaustC).catch(() => {});
        }
      } else if (skPath === `${basePath}.oilPressure`) {
        const bar = uc.fromSignalK(value, 'pressure_pa_to_bar', 2);
        if (bar !== null && this.hasCapability('measure_oil_pressure')) {
          await this.setCapabilityValue('measure_oil_pressure', bar);
        }
      } else if (skPath === `${basePath}.coolantPressure`) {
        const coolantBar = uc.fromSignalK(value, 'pressure_pa_to_bar', 2);
        if (coolantBar !== null) {
          await this.setStoreValue('coolantPressureBar', coolantBar).catch(() => {});
        }
      } else if (skPath === `${basePath}.runTime`) {
        const hrs = uc.fromSignalK(value, 'duration_s_to_h', 1);
        if (hrs !== null && this.hasCapability('measure_engine_hours')) {
          await this.setCapabilityValue('measure_engine_hours', hrs);
        }
      } else if (skPath === `${basePath}.fuel.rate`) {
        const lph = uc.fromSignalK(value, 'flow_m3s_to_lh', 2);
        if (lph !== null && this.hasCapability('measure_fuel_rate')) {
          await this.setCapabilityValue('measure_fuel_rate', lph);
        }
      } else if (skPath === `${basePath}.state` && typeof value === 'string') {
        await this.setStoreValue('engineState', value);
        if (this.hasCapability('engine_state')) {
          await this.setCapabilityValue('engine_state', value);
        }
      } else if (skPath === `${basePath}.transmission.gear` && typeof value === 'string') {
        await this.setStoreValue('transmissionGear', value);
        if (this.hasCapability('transmission_gear')) {
          await this.setCapabilityValue('transmission_gear', value);
        }
      } else if (skPath.startsWith(`notifications.propulsion.${this.engineId}.`)) {
        const isAlarm =
          value !== null &&
          typeof value === 'object' &&
          ACTIVE_ALARM_STATES.has(String((value as any).state || '').trim().toLowerCase());
        this.activeNotificationAlarms.set(skPath, isAlarm);
        const anyActive = Array.from(this.activeNotificationAlarms.values()).some(Boolean);
        if (this.hasCapability('alarm_generic')) {
          await this.setCapabilityValue('alarm_generic', anyActive);
        }
      }
    } catch (err: any) {
      this.error(`Error handling propulsion update for ${skPath}:`, err?.message || err);
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
    if (changedKeys.includes('engineId')) {
      const nextEngineId = String(newSettings.engineId || '').trim();
      if (!nextEngineId || !/^[A-Za-z0-9_-]+$/.test(nextEngineId)) {
        throw new Error('Engine instance ID must be alphanumeric');
      }
      this.engineId = nextEngineId;
      await this.setStoreValue('engineId', nextEngineId);
      this.activeNotificationAlarms.clear();
    }

    if (
      changedKeys.includes('host') ||
      changedKeys.includes('port') ||
      changedKeys.includes('useTls') ||
      changedKeys.includes('allowSelfSigned') ||
      changedKeys.includes('token')
    ) {
      const pool = this.getPool();
      const host = String(newSettings.host || this.getStoreValue('host') || 'openplotter.local').trim();
      const port = Number(newSettings.port || this.getStoreValue('port') || 3000);
      if (!host) {
        throw new Error('Server host cannot be empty');
      }
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Server port must be between 1 and 65535');
      }
      await this.setStoreValue('host', host);
      await this.setStoreValue('port', port);
      if (newSettings.useTls !== undefined) {
        await this.setStoreValue('useTls', Boolean(newSettings.useTls));
      }
      if (newSettings.allowSelfSigned !== undefined) {
        await this.setStoreValue('allowSelfSigned', Boolean(newSettings.allowSelfSigned));
      }
      if (typeof newSettings.token === 'string') {
        await this.setStoreValue('token', newSettings.token);
      }
      if (pool) {
        await pool.acquireConnection({
          serverId: this.serverId,
          host,
          port,
          useTls: Boolean(newSettings.useTls),
          allowSelfSigned: newSettings.allowSelfSigned !== false,
          token: typeof newSettings.token === 'string' ? newSettings.token : undefined,
        });
      }
    }

    if (
      changedKeys.includes('engineId') ||
      changedKeys.includes('throttleTier') ||
      changedKeys.includes('sourceFilter') ||
      changedKeys.includes('source_filter')
    ) {
      this.bindSubscriptions();
    }
  }

  public override onDiscoveryResult(discoveryResult: Homey.DiscoveryResult): boolean {
    const serverHost = this.getStoreValue('host');
    const dataServerId = this.getData()?.serverId || this.serverId;
    return (
      discoveryResult.id === dataServerId ||
      (typeof serverHost === 'string' && discoveryResult.address === serverHost)
    );
  }

  public override async onDiscoveryAvailable(discoveryResult: Homey.DiscoveryResult): Promise<void> {
    await this.applyDiscoveredAddress(discoveryResult);
  }

  public override async onDiscoveryAddressChanged(
    discoveryResult: Homey.DiscoveryResult,
  ): Promise<void> {
    await this.applyDiscoveredAddress(discoveryResult);
  }

  private async applyDiscoveredAddress(discoveryResult: Homey.DiscoveryResult): Promise<void> {
    const mdns = discoveryResult as any;
    const address = String(mdns.address || mdns.host || '').trim();
    const port = typeof mdns.port === 'number' && Number.isFinite(mdns.port) ? mdns.port : 3000;
    if (!address) return;

    await this.setStoreValue('host', address);
    await this.setStoreValue('port', port);
    await this.setSettings({ host: address, port }).catch(() => {});

    const pool = this.getPool();
    if (pool) {
      await pool.updateServerAddress(this.serverId, address, port);
    }
    await this.setAvailable();
  }

  public override async onDeleted(): Promise<void> {
    this.cleanup();
  }

  public override async onUninit(): Promise<void> {
    this.cleanup();
  }

  private cleanup(): void {
    this.clearSubscriptions();
    const pool = this.getPool() as any;
    if (pool && typeof pool.removeListener === 'function') {
      for (const { event, fn } of this.poolListeners) {
        pool.removeListener(event, fn);
      }
    }
    this.poolListeners = [];
  }
}
