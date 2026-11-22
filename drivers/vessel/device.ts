import Homey from 'homey';
import {
  AnchorDriftStatus,
  AnchorWatchCalculator,
  GeoPosition,
  isValidGeoPosition,
} from '../../lib/AnchorWatchCalculator';
import { UnitConverter, SpeedUnit } from '../../lib/UnitConverter';
import type {
  ISignalKConnectionPool,
  PathUpdateEvent,
  ThrottleTier,
} from '../../lib/SignalKConnectionPool';
import { resolveThrottleTier } from './SignalKDriverHelper';

const VESSEL_MEDIUM_PATHS = [
  'navigation.speedOverGround',
  'navigation.speedThroughWater',
  'navigation.courseOverGroundTrue',
  'navigation.headingTrue',
  'navigation.position',
  'navigation.state',
  'environment.depth.belowTransducer',
  'environment.wind.speedApparent',
  'environment.wind.angleApparent',
  'environment.wind.speedTrue',
  'environment.wind.angleTrueWater',
  'environment.outside.pressure',
  'environment.outside.temperature',
  'environment.water.temperature',
  'steering.autopilot.state',
  'steering.autopilot.target.headingTrue',
];

const VESSEL_FAST_PATHS = [
  'navigation.anchor.position',
  'navigation.anchor.currentRadius',
  'navigation.anchor.maxRadius',
  'navigation.anchor.rodeLength',
  'notifications.navigation.anchor',
];

const VALID_NAV_STATES = new Set([
  'moored',
  'anchored',
  'motoring',
  'sailing',
  'drifting',
  'towing',
  'unknown',
]);

const VALID_AUTOPILOT_STATES = new Set(['standby', 'auto', 'wind', 'route', 'off']);

export interface AnchorState {
  armed: boolean;
  anchorPosition: GeoPosition | null;
  vesselPosition: GeoPosition | null;
  pluginCurrentRadiusMeters: number | null;
  pluginAlarmState: string | null;
  maxRadiusMeters: number;
  rodeLengthMeters: number;
}

export default class VesselDevice extends Homey.Device {
  private readonly unitConverter = new UnitConverter();
  private readonly anchorCalculator = new AnchorWatchCalculator();
  private unsubs: Array<() => void> = [];
  private poolListeners: Array<{ event: string; fn: (...args: any[]) => void }> = [];
  private serverId = 'default';
  private anchorState: AnchorState = {
    armed: false,
    anchorPosition: null,
    vesselPosition: null,
    pluginCurrentRadiusMeters: null,
    pluginAlarmState: null,
    maxRadiusMeters: 40,
    rodeLengthMeters: 30,
  };
  private lastDriftStatus: AnchorDriftStatus | null = null;
  private lastRawSogMps: number | null = null;
  private lastRawStwMps: number | null = null;
  private lastRawAwsMps: number | null = null;

  public override async onInit(): Promise<void> {
    this.unsubs = [];
    this.poolListeners = [];

    this.serverId =
      String(this.getStoreValue('serverId') || this.getData()?.serverId || 'default');

    const settingMaxRadius = Number(this.getSetting('anchor_max_radius'));
    const settingRodeLength = Number(this.getSetting('anchor_rode_length'));
    this.anchorState = {
      armed: Boolean(this.getCapabilityValue('onoff.anchor_armed')),
      anchorPosition: null,
      vesselPosition: null,
      pluginCurrentRadiusMeters: null,
      pluginAlarmState: null,
      maxRadiusMeters:
        Number.isFinite(settingMaxRadius) && settingMaxRadius > 0 ? settingMaxRadius : 40,
      rodeLengthMeters:
        Number.isFinite(settingRodeLength) && settingRodeLength >= 0 ? settingRodeLength : 30,
    };

    if (this.hasCapability('measure_anchor_radius')) {
      await this.setCapabilityValue('measure_anchor_radius', this.anchorState.maxRadiusMeters);
    }

    await this.ensureServerConnection();
    this.setupPoolEventHandlers();
    this.bindSubscriptions();

    // Writable Anchor Watch Armed toggle (onoff.anchor_armed)
    if (this.hasCapability('onoff.anchor_armed')) {
      this.registerCapabilityListener('onoff.anchor_armed', async (armed: boolean) => {
        if (armed) {
          await this.armAnchorWatch({
            maxRadius: this.anchorState.maxRadiusMeters,
            rodeLength: this.anchorState.rodeLengthMeters,
          });
        } else {
          await this.disarmAnchorWatch();
        }
      });
    }

    // Writable Anchor Max Radius capability (measure_anchor_radius)
    if (this.hasCapability('measure_anchor_radius')) {
      this.registerCapabilityListener('measure_anchor_radius', async (radius: number) => {
        await this.setAnchorMaxRadius(Number(radius));
      });
    }

    // NOTE: steering.autopilot.* and navigation.state are STRICTLY READ-ONLY —
    // zero capability listeners registered for autopilot_state or navigation_state.
  }

  private getPool(): ISignalKConnectionPool | undefined {
    return (this.homey?.app as any)?.connectionPool;
  }

  private getUnitConverter(): UnitConverter {
    return (this.homey?.app as any)?.unitConverter ?? this.unitConverter;
  }

  private getAnchorCalculator(): AnchorWatchCalculator {
    return (this.homey?.app as any)?.anchorCalculator ?? this.anchorCalculator;
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
        this.error('Initial vessel connection attempt failed:', err?.message || err);
      }
    }
  }

  private setupPoolEventHandlers(): void {
    const pool = this.getPool() as any;
    if (!pool || typeof pool.on !== 'function') return;

    const onAuthError = (evt: { serverId?: string; statusCode?: number; message?: string }) => {
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
        // ignore unsubscribe cleanup errors
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

    const telemetryTier: ThrottleTier = resolveThrottleTier(
      this.getSetting('throttleTier'),
      'medium',
    );
    const subscriberId = String(this.getData()?.id || `vessel:${this.serverId}`);

    for (const skPath of VESSEL_MEDIUM_PATHS) {
      const pathTier: ThrottleTier =
        skPath.startsWith('environment.outside.') || skPath.startsWith('environment.water.')
          ? telemetryTier === 'fast'
            ? 'fast'
            : 'slow'
          : telemetryTier;

      this.unsubs.push(
        pool.subscribe(this.serverId, {
          subscriberId,
          path: skPath,
          tier: pathTier,
          sourceFilter,
          onUpdate: (update: PathUpdateEvent) => {
            void this.handleTelemetryUpdate(update);
          },
        }),
      );
    }

    for (const skPath of VESSEL_FAST_PATHS) {
      this.unsubs.push(
        pool.subscribe(this.serverId, {
          subscriberId,
          path: skPath,
          tier: 'fast',
          sourceFilter,
          onUpdate: (update: PathUpdateEvent) => {
            void this.handleAnchorUpdate(update);
          },
        }),
      );
    }
  }

  private getSpeedUnit(): SpeedUnit {
    const raw = this.getSetting('speed_unit');
    if (raw === 'm/s' || raw === 'km/h' || raw === 'kn') {
      return raw;
    }
    return 'kn';
  }

  public async handleTelemetryUpdate(update: PathUpdateEvent): Promise<void> {
    const { path: skPath, value } = update;
    const uc = this.getUnitConverter();
    const speedUnit = this.getSpeedUnit();

    try {
      if (skPath === 'navigation.speedOverGround') {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.lastRawSogMps = value;
        }
        const conv = uc.convertSpeedFromSI(value, speedUnit, 2);
        if (conv !== null && this.hasCapability('measure_sog')) {
          await this.setCapabilityValue('measure_sog', conv);
        }
      } else if (skPath === 'navigation.speedThroughWater') {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.lastRawStwMps = value;
        }
        const conv = uc.convertSpeedFromSI(value, speedUnit, 2);
        if (conv !== null && this.hasCapability('measure_stw')) {
          await this.setCapabilityValue('measure_stw', conv);
        }
      } else if (skPath === 'navigation.courseOverGroundTrue') {
        const conv = uc.fromSignalK(value, 'angle_rad_to_deg_unsigned', 1);
        if (conv !== null && this.hasCapability('measure_cog')) {
          await this.setCapabilityValue('measure_cog', conv);
        }
      } else if (skPath === 'navigation.headingTrue') {
        const conv = uc.fromSignalK(value, 'angle_rad_to_deg_unsigned', 1);
        if (conv !== null && this.hasCapability('measure_heading')) {
          await this.setCapabilityValue('measure_heading', conv);
        }
      } else if (skPath === 'environment.depth.belowTransducer') {
        const conv = uc.fromSignalK(value, 'distance_m', 2);
        if (conv !== null && this.hasCapability('measure_depth')) {
          await this.setCapabilityValue('measure_depth', conv);
        }
      } else if (skPath === 'environment.wind.speedApparent') {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this.lastRawAwsMps = value;
        }
        const conv = uc.convertSpeedFromSI(value, speedUnit, 2);
        if (conv !== null && this.hasCapability('measure_wind_strength')) {
          await this.setCapabilityValue('measure_wind_strength', conv);
        }
      } else if (skPath === 'environment.wind.angleApparent') {
        const conv = uc.fromSignalK(value, 'angle_rad_to_deg_signed', 1);
        if (conv !== null && this.hasCapability('measure_wind_angle')) {
          await this.setCapabilityValue('measure_wind_angle', conv);
        }
      } else if (skPath === 'environment.outside.pressure') {
        const conv = uc.fromSignalK(value, 'pressure_pa_to_hpa', 2);
        if (conv !== null && this.hasCapability('measure_pressure')) {
          await this.setCapabilityValue('measure_pressure', conv);
        }
      } else if (
        skPath === 'environment.outside.temperature' ||
        skPath === 'environment.water.temperature'
      ) {
        const conv = uc.fromSignalK(value, 'temperature_k_to_c', 2);
        if (conv !== null && this.hasCapability('measure_temperature')) {
          await this.setCapabilityValue('measure_temperature', conv);
        }
      } else if (skPath === 'navigation.state' && typeof value === 'string') {
        const normalizedState = VALID_NAV_STATES.has(value) ? value : 'unknown';
        const prevState = this.getCapabilityValue('navigation_state') || 'unknown';
        if (this.hasCapability('navigation_state')) {
          await this.setCapabilityValue('navigation_state', normalizedState);
        }
        if (prevState !== normalizedState) {
          await this.triggerFlowCard('navigation_state_changed', {
            state: normalizedState,
            previousState: String(prevState),
          });
        }
      } else if (skPath === 'steering.autopilot.state' && typeof value === 'string') {
        // Strictly read-only telemetry
        const normalizedAp = VALID_AUTOPILOT_STATES.has(value) ? value : 'standby';
        if (this.hasCapability('autopilot_state')) {
          await this.setCapabilityValue('autopilot_state', normalizedAp);
        }
      } else if (skPath === 'steering.autopilot.target.headingTrue') {
        // Strictly read-only telemetry cached in store for inspection/Flows
        const targetDeg = uc.fromSignalK(value, 'angle_rad_to_deg_unsigned', 1);
        if (targetDeg !== null) {
          await this.setStoreValue('autopilotTargetHeading', targetDeg).catch(() => {});
        }
      } else if (skPath === 'navigation.position') {
        if (isValidGeoPosition(value)) {
          this.anchorState.vesselPosition = {
            latitude: value.latitude,
            longitude: value.longitude,
          };
          if (this.anchorState.armed && !this.anchorState.anchorPosition) {
            this.anchorState.anchorPosition = { ...this.anchorState.vesselPosition };
          }
          await this.recomputeAnchorDrift();
        } else if (value === null) {
          this.anchorState.vesselPosition = null;
          await this.recomputeAnchorDrift();
        }
      }
    } catch (err: any) {
      this.error(`Error handling vessel telemetry for ${skPath}:`, err?.message || err);
    }
  }

  public async handleAnchorUpdate(update: PathUpdateEvent): Promise<void> {
    const { path: skPath, value } = update;

    try {
      if (skPath === 'navigation.anchor.position') {
        if (isValidGeoPosition(value)) {
          this.anchorState.anchorPosition = {
            latitude: value.latitude,
            longitude: value.longitude,
          };
          this.anchorState.armed = true;
          if (this.hasCapability('onoff.anchor_armed')) {
            await this.setCapabilityValue('onoff.anchor_armed', true);
          }
        } else if (value === null) {
          this.anchorState.anchorPosition = null;
          this.anchorState.armed = false;
          this.anchorState.pluginCurrentRadiusMeters = null;
          this.anchorState.pluginAlarmState = null;
          if (this.hasCapability('onoff.anchor_armed')) {
            await this.setCapabilityValue('onoff.anchor_armed', false);
          }
          if (this.hasCapability('alarm_generic')) {
            await this.setCapabilityValue('alarm_generic', false);
          }
        }
      } else if (skPath === 'navigation.anchor.currentRadius') {
        this.anchorState.pluginCurrentRadiusMeters =
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
      } else if (skPath === 'navigation.anchor.maxRadius') {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
          this.anchorState.maxRadiusMeters = value;
          if (this.hasCapability('measure_anchor_radius')) {
            await this.setCapabilityValue('measure_anchor_radius', value);
          }
        }
      } else if (skPath === 'navigation.anchor.rodeLength') {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          this.anchorState.rodeLengthMeters = value;
        }
      } else if (skPath === 'notifications.navigation.anchor') {
        if (value === null) {
          this.anchorState.pluginAlarmState = 'normal';
        } else if (value && typeof value === 'object' && typeof (value as any).state === 'string') {
          this.anchorState.pluginAlarmState = (value as any).state;
        }
      }

      await this.recomputeAnchorDrift();
    } catch (err: any) {
      this.error(`Error handling anchor update for ${skPath}:`, err?.message || err);
    }
  }

  public async recomputeAnchorDrift(): Promise<AnchorDriftStatus> {
    const calc = this.getAnchorCalculator();
    const useHaversineFallback = this.getSetting('anchor_haversine_fallback') !== false;

    const status = calc.evaluateDrift({
      armed: this.anchorState.armed,
      anchorPosition: this.anchorState.anchorPosition,
      vesselPosition: this.anchorState.vesselPosition,
      pluginCurrentRadiusMeters: this.anchorState.pluginCurrentRadiusMeters,
      pluginAlarmState: this.anchorState.pluginAlarmState,
      maxRadiusMeters: this.anchorState.maxRadiusMeters,
      rodeLengthMeters: this.anchorState.rodeLengthMeters,
    });

    // If Haversine fallback is disabled and no plugin radius is available, avoid computing fallback distance
    const effectiveDistance =
      status.source === 'haversine_fallback' && !useHaversineFallback
        ? null
        : status.currentRadiusMeters;

    this.lastDriftStatus = status;

    if (effectiveDistance !== null && this.hasCapability('measure_anchor_distance')) {
      const roundedDist = Math.round(effectiveDistance * 100) / 100;
      await this.setCapabilityValue('measure_anchor_distance', roundedDist);
    }

    const wasAlarm = Boolean(this.getCapabilityValue('alarm_generic'));
    if (this.hasCapability('alarm_generic')) {
      await this.setCapabilityValue('alarm_generic', status.isDragging);
    }

    if (status.isDragging && !wasAlarm) {
      const tokens = {
        distance: Math.round((status.currentRadiusMeters ?? 0) * 10) / 10,
        currentRadius: Math.round((status.currentRadiusMeters ?? 0) * 10) / 10,
        maxRadius: status.maxRadiusMeters,
        bearing: Math.round((status.bearingTrueDegrees ?? 0) * 10) / 10,
      };
      await this.triggerFlowCard('anchor_drag_alarm', tokens);
    }

    return status;
  }

  public async armAnchorWatch(options?: {
    maxRadius?: number;
    rodeLength?: number;
  }): Promise<void> {
    const maxRadius =
      options?.maxRadius !== undefined ? options.maxRadius : this.anchorState.maxRadiusMeters;
    const rodeLength =
      options?.rodeLength !== undefined ? options.rodeLength : this.anchorState.rodeLengthMeters;

    if (typeof maxRadius !== 'number' || !Number.isFinite(maxRadius) || maxRadius <= 0) {
      throw new Error('Anchor max radius must be a positive number in meters');
    }

    const pool = this.getPool();

    if (!this.anchorState.vesselPosition && pool) {
      try {
        const posNode = await pool.getVesselSubtree(this.serverId, 'navigation/position');
        const candidate = posNode?.value ?? posNode;
        if (isValidGeoPosition(candidate)) {
          this.anchorState.vesselPosition = {
            latitude: candidate.latitude,
            longitude: candidate.longitude,
          };
        }
      } catch {
        // Use fallback coordinate below if live GPS position is unavailable
      }
    }

    const dropPos: GeoPosition = this.anchorState.vesselPosition
      ? { ...this.anchorState.vesselPosition }
      : { latitude: 59.3293, longitude: 18.0686 };

    this.anchorState.anchorPosition = { ...dropPos };
    this.anchorState.armed = true;
    this.anchorState.maxRadiusMeters = maxRadius;
    this.anchorState.rodeLengthMeters =
      typeof rodeLength === 'number' && Number.isFinite(rodeLength) && rodeLength >= 0
        ? rodeLength
        : this.anchorState.rodeLengthMeters;
    this.anchorState.pluginCurrentRadiusMeters = null;
    this.anchorState.pluginAlarmState = null;

    if (pool) {
      const posPut = await pool.putPath(this.serverId, 'navigation.anchor.position', dropPos);
      if (posPut.state === 'FAILED') {
        throw new Error(posPut.message || 'Failed to drop anchor via Signal K');
      }
      const radPut = await pool.putPath(this.serverId, 'navigation.anchor.maxRadius', maxRadius);
      if (radPut.state === 'FAILED') {
        throw new Error(radPut.message || 'Failed to set anchor max radius via Signal K');
      }
      if (this.anchorState.rodeLengthMeters > 0) {
        await pool
          .putPath(this.serverId, 'navigation.anchor.rodeLength', this.anchorState.rodeLengthMeters)
          .catch(() => {});
      }
    }

    if (this.hasCapability('onoff.anchor_armed')) {
      await this.setCapabilityValue('onoff.anchor_armed', true);
    }
    if (this.hasCapability('measure_anchor_radius')) {
      await this.setCapabilityValue('measure_anchor_radius', maxRadius);
    }
    await this.recomputeAnchorDrift();
  }

  public async disarmAnchorWatch(): Promise<void> {
    const pool = this.getPool();
    this.anchorState.armed = false;
    this.anchorState.anchorPosition = null;
    this.anchorState.pluginCurrentRadiusMeters = null;
    this.anchorState.pluginAlarmState = null;

    if (pool) {
      const raisePut = await pool.putPath(this.serverId, 'navigation.anchor.position', null);
      if (raisePut.state === 'FAILED') {
        throw new Error(raisePut.message || 'Failed to raise anchor via Signal K');
      }
    }

    if (this.hasCapability('onoff.anchor_armed')) {
      await this.setCapabilityValue('onoff.anchor_armed', false);
    }
    if (this.hasCapability('alarm_generic')) {
      await this.setCapabilityValue('alarm_generic', false);
    }
  }

  public async setAnchorMaxRadius(maxRadius: number): Promise<void> {
    if (typeof maxRadius !== 'number' || !Number.isFinite(maxRadius) || maxRadius <= 0) {
      throw new Error('Anchor max radius must be a positive number in meters');
    }

    const pool = this.getPool();
    if (pool) {
      const res = await pool.putPath(this.serverId, 'navigation.anchor.maxRadius', maxRadius);
      if (res.state === 'FAILED') {
        throw new Error(res.message || 'Failed to update anchor max radius via Signal K');
      }
    }

    this.anchorState.maxRadiusMeters = maxRadius;
    if (this.hasCapability('measure_anchor_radius')) {
      await this.setCapabilityValue('measure_anchor_radius', maxRadius);
    }
    await this.recomputeAnchorDrift();
  }

  public getLastDriftStatus(): AnchorDriftStatus | null {
    return this.lastDriftStatus;
  }

  private async triggerFlowCard(cardId: string, tokens: Record<string, any>): Promise<void> {
    try {
      const card = this.homey?.flow?.getTriggerCard?.(cardId) as any;
      if (card && typeof card.trigger === 'function') {
        await card.trigger(tokens, tokens);
      }
    } catch {
      // Trigger card may not yet be registered before M4 FlowCardManager
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
    if (changedKeys.includes('anchor_max_radius')) {
      const r = Number(newSettings.anchor_max_radius);
      if (!Number.isFinite(r) || r <= 0) {
        throw new Error('Anchor max radius must be greater than 0 meters');
      }
      this.anchorState.maxRadiusMeters = r;
      if (this.hasCapability('measure_anchor_radius')) {
        await this.setCapabilityValue('measure_anchor_radius', r);
      }
      await this.recomputeAnchorDrift();
    }

    if (changedKeys.includes('anchor_rode_length')) {
      const len = Number(newSettings.anchor_rode_length);
      if (!Number.isFinite(len) || len < 0) {
        throw new Error('Anchor rode length must be 0 or greater');
      }
      this.anchorState.rodeLengthMeters = len;
    }

    if (changedKeys.includes('speed_unit')) {
      const newUnit =
        newSettings.speed_unit === 'm/s' ||
        newSettings.speed_unit === 'km/h' ||
        newSettings.speed_unit === 'kn'
          ? newSettings.speed_unit
          : 'kn';
      const uc = this.getUnitConverter();
      if (this.lastRawSogMps !== null && this.hasCapability('measure_sog')) {
        const val = uc.convertSpeedFromSI(this.lastRawSogMps, newUnit, 2);
        if (val !== null) await this.setCapabilityValue('measure_sog', val);
      }
      if (this.lastRawStwMps !== null && this.hasCapability('measure_stw')) {
        const val = uc.convertSpeedFromSI(this.lastRawStwMps, newUnit, 2);
        if (val !== null) await this.setCapabilityValue('measure_stw', val);
      }
      if (this.lastRawAwsMps !== null && this.hasCapability('measure_wind_strength')) {
        const val = uc.convertSpeedFromSI(this.lastRawAwsMps, newUnit, 2);
        if (val !== null) await this.setCapabilityValue('measure_wind_strength', val);
      }
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
      changedKeys.includes('throttleTier') ||
      changedKeys.includes('sourceFilter') ||
      changedKeys.includes('source_filter')
    ) {
      this.bindSubscriptions();
    }
  }

  public override onDiscoveryResult(discoveryResult: Homey.DiscoveryResult): boolean {
    const dataId = String(this.getData()?.id || '');
    const resultId = String(discoveryResult.id || '');
    const txtSelf = String((discoveryResult as any)?.txt?.self || '');
    const strippedDataId = dataId.replace(/^vessel\./, '');
    return (
      resultId === dataId ||
      resultId === `vessel.${dataId}` ||
      resultId === strippedDataId ||
      (txtSelf.length > 0 &&
        (txtSelf === dataId || `vessel.${txtSelf}` === dataId || txtSelf === strippedDataId))
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
