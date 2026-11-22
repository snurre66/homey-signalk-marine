import Homey from 'homey';
import { UnitConverter, UnitCategory } from '../../lib/UnitConverter';
import type {
  ISignalKConnectionPool,
  PathUpdateEvent,
  ThrottleTier,
} from '../../lib/SignalKConnectionPool';
import { resolveThrottleTier } from '../vessel/SignalKDriverHelper';

const VALID_DOT_PATH_REGEX = /^[a-zA-Z0-9_.*-]+(\.[a-zA-Z0-9_.*-]+)+$/;
const ACTIVE_NOTIFICATION_STATES = new Set(['alert', 'warn', 'alarm', 'emergency']);

const VALID_UNIT_CATEGORIES = new Set<UnitCategory>([
  'temperature_k_to_c',
  'speed_ms_to_kn',
  'speed_ms_to_kmh',
  'speed_ms',
  'pressure_pa_to_hpa',
  'pressure_pa_to_bar',
  'pressure_pa_to_kpa',
  'ratio_to_percent',
  'angle_rad_to_deg_unsigned',
  'angle_rad_to_deg_signed',
  'angular_velocity_rads_to_degs',
  'frequency_hz_to_rpm',
  'charge_c_to_ah',
  'energy_j_to_kwh',
  'volume_m3_to_l',
  'flow_m3s_to_lh',
  'duration_s_to_h',
  'duration_s_to_min',
  'distance_m',
  'distance_m_to_nm',
  'passthrough',
]);

export function isValidSignalKDotPath(rawPath: unknown): rawPath is string {
  if (typeof rawPath !== 'string') {
    return false;
  }
  const trimmed = rawPath.trim();
  if (
    !trimmed ||
    trimmed.includes('..') ||
    trimmed.includes('//') ||
    trimmed.includes('/') ||
    trimmed.includes('\\')
  ) {
    return false;
  }
  return VALID_DOT_PATH_REGEX.test(trimmed);
}

export default class CustomSensorDevice extends Homey.Device {
  private readonly unitConverter = new UnitConverter();
  private unsub: (() => void) | null = null;
  private authUnsub: (() => void) | null = null;
  private poolListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private serverId = 'default';

  public override async onInit(): Promise<void> {
    this.unsub = null;
    this.authUnsub = null;
    this.poolListeners = [];

    this.serverId =
      String(this.getStoreValue('serverId') || this.getData()?.serverId || 'default');

    await this.ensureServerConnection();
    this.setupPoolEventHandlers();
    await this.bindSubscription();
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
        this.error('Initial custom-sensor connection attempt failed:', err?.message || err);
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
      this.authUnsub = pool.onAuthFailure(this.serverId, ({ message }: { message?: string }) => {
        this.setUnavailable(
          message || 'Authentication required — please use Repair Device',
        ).catch(() => {});
      });
    }
  }

  private clearSubscription(): void {
    if (this.unsub) {
      try {
        this.unsub();
      } catch {
        // ignore unsubscribe errors
      }
      this.unsub = null;
    }
  }

  private resolveBindingConfig(settingsOverride?: Record<string, any>): {
    path: string;
    capability: string;
    unitCategory: UnitCategory;
    throttleTier: ThrottleTier;
    sourceFilter?: string;
  } {
    const skPath = String(
      settingsOverride?.path ??
        this.getSetting('path') ??
        this.getStoreValue('path') ??
        this.getData()?.path ??
        'environment.inside.engineRoom.temperature',
    ).trim();

    const capability = String(
      settingsOverride?.capability ??
        this.getSetting('capability') ??
        this.getStoreValue('capability') ??
        this.getCapabilities()[0] ??
        'measure_temperature',
    ).trim();

    const rawUnit =
      settingsOverride?.unitCategory ??
      this.getSetting('unitCategory') ??
      this.getStoreValue('unitCategory') ??
      'temperature_k_to_c';
    const unitCategory: UnitCategory = VALID_UNIT_CATEGORIES.has(rawUnit as UnitCategory)
      ? (rawUnit as UnitCategory)
      : 'passthrough';

    const throttleTier: ThrottleTier = resolveThrottleTier(
      settingsOverride?.throttleTier ??
        this.getSetting('throttleTier') ??
        this.getStoreValue('throttleTier'),
      'slow',
    );

    const rawSource =
      settingsOverride?.sourceFilter ??
      settingsOverride?.source_filter ??
      this.getSetting('sourceFilter') ??
      this.getSetting('source_filter') ??
      this.getStoreValue('sourceFilter');
    const sourceFilter =
      typeof rawSource === 'string' && rawSource.trim().length > 0
        ? rawSource.trim()
        : undefined;

    return {
      path: skPath,
      capability,
      unitCategory,
      throttleTier,
      sourceFilter,
    };
  }

  public async bindSubscription(settingsOverride?: Record<string, any>): Promise<void> {
    this.clearSubscription();

    const cfg = this.resolveBindingConfig(settingsOverride);

    if (!this.hasCapability(cfg.capability)) {
      await this.addCapability(cfg.capability);
    }

    const pool = this.getPool();
    if (!pool) return;

    const subscriberId = String(this.getData()?.id || `custom-sensor:${this.serverId}:${cfg.path}`);

    this.unsub = pool.subscribe(this.serverId, {
      subscriberId,
      path: cfg.path,
      tier: cfg.throttleTier,
      sourceFilter: cfg.sourceFilter,
      onUpdate: (update: PathUpdateEvent) => {
        void this.handleSensorUpdate(update, cfg.capability, cfg.unitCategory);
      },
    });
  }

  public async handleSensorUpdate(
    update: PathUpdateEvent,
    capability: string,
    unitCategory: UnitCategory,
  ): Promise<void> {
    const { value } = update;
    const uc = this.getUnitConverter();

    try {
      // Boolean / Alarm capabilities
      if (capability.startsWith('alarm_') || capability.startsWith('onoff')) {
        if (value === null) {
          await this.setCapabilityValue(capability, false);
        } else if (typeof value === 'boolean') {
          await this.setCapabilityValue(capability, value);
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          await this.setCapabilityValue(capability, value !== 0);
        } else if (
          typeof value === 'object' &&
          value !== null &&
          typeof (value as any).state === 'string'
        ) {
          const active = ACTIVE_NOTIFICATION_STATES.has(
            (value as any).state.trim().toLowerCase(),
          );
          await this.setCapabilityValue(capability, active);
        }
        return;
      }

      // Numeric capabilities via UnitConverter (strictly ignores null / NaN / non-numeric objects)
      const converted = uc.fromSignalK(value, unitCategory, 2);
      if (converted !== null) {
        await this.setCapabilityValue(capability, converted);
      }
    } catch (err: any) {
      this.error(`Error updating custom-sensor capability "${capability}":`, err?.message || err);
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
    if (changedKeys.includes('path')) {
      if (!isValidSignalKDotPath(newSettings.path)) {
        throw new Error(
          `Invalid Signal K path "${String(newSettings.path || '')}": must be a valid dot-separated path`,
        );
      }
      await this.setStoreValue('path', String(newSettings.path).trim());
    }

    if (changedKeys.includes('capability')) {
      const cap = String(newSettings.capability || '').trim();
      if (!cap || !/^[a-z0-9_]+(\.[a-z0-9_]+)?$/.test(cap)) {
        throw new Error(`Invalid Homey capability ID "${cap}"`);
      }
      await this.setStoreValue('capability', cap);
    }

    if (changedKeys.includes('unitCategory')) {
      const uc = String(newSettings.unitCategory || '').trim();
      if (!VALID_UNIT_CATEGORIES.has(uc as UnitCategory)) {
        throw new Error(`Unsupported unitCategory "${uc}"`);
      }
      await this.setStoreValue('unitCategory', uc);
    }

    if (changedKeys.includes('throttleTier')) {
      const tier = resolveThrottleTier(newSettings.throttleTier, 'slow');
      await this.setStoreValue('throttleTier', tier);
    }

    if (changedKeys.includes('sourceFilter') || changedKeys.includes('source_filter')) {
      const sf = String(newSettings.sourceFilter ?? newSettings.source_filter ?? '').trim();
      await this.setStoreValue('sourceFilter', sf);
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

    await this.bindSubscription(newSettings);
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
    this.clearSubscription();
    if (this.authUnsub) {
      try {
        this.authUnsub();
      } catch {
        // ignore
      }
      this.authUnsub = null;
    }
    const pool = this.getPool() as any;
    if (pool && typeof pool.removeListener === 'function') {
      for (const { event, fn } of this.poolListeners) {
        pool.removeListener(event, fn);
      }
    }
    this.poolListeners = [];
  }
}
