import type Homey from 'homey';
import type { SignalKConnectionPool } from './SignalKConnectionPool';
import type { PathDiscoveryService } from './PathDiscoveryService';
import type { UnitConverter } from './UnitConverter';
import type { SafetyBoundary } from './SafetyBoundary';
import { INDOOR_ENVIRONMENT_ZONES } from './HardwarePresets';

export interface SignalKFlowAppHost {
  connectionPool: SignalKConnectionPool;
  unitConverter: UnitConverter;
  safetyBoundary: SafetyBoundary;
  discoveryService: PathDiscoveryService;
  getDefaultServerId?: () => string;
  getRegisteredServerIds?: () => string[];
}

export type NotificationSeverity = 'normal' | 'alert' | 'warn' | 'alarm' | 'emergency';

const NOTIFICATION_RANK: Record<NotificationSeverity, number> = {
  normal: 0,
  alert: 1,
  warn: 2,
  alarm: 3,
  emergency: 4,
};

const VALID_DOT_PATH_REGEX = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/;
const STANDARD_SOC_THRESHOLDS = [50, 40, 30, 25, 20, 15, 10];

export class FlowCardManager {
  private readonly homey: Homey.Homey;
  private readonly app: SignalKFlowAppHost;

  private readonly unsubs: Array<() => void> = [];
  private readonly attachedServers = new Set<string>();
  private readonly latestPathValues = new Map<string, unknown>();
  private readonly activeAlarms = new Map<string, boolean>();
  private readonly lastNavStateByServer = new Map<string, string>();
  private readonly lastShorePowerByServer = new Map<string, boolean>();
  private readonly socTriggeredByBank = new Map<string, Set<number>>();
  private readonly lastSocByBank = new Map<string, number>();

  private registered = false;

  constructor(homey: Homey.Homey, app: SignalKFlowAppHost) {
    this.homey = homey;
    this.app = app;
  }

  /**
   * Registers all Homey Flow Trigger, Condition, and Action cards and
   * autocomplete argument listeners.
   */
  public registerAll(): void {
    if (this.registered) {
      return;
    }
    this.registered = true;

    this.registerTriggers();
    this.registerConditions();
    this.registerActions();
  }

  /**
   * Attaches Signal K WebSocket subscriptions for a given `serverId` so Flow triggers
   * (`signalk_notification_raised`, `path_value_updated`, `shore_power_status_changed`,
   * `navigation_state_changed`, `battery_soc_below_threshold`) and condition caches stay live.
   */
  public attachServerSubscriptions(serverId: string): void {
    if (!serverId || this.attachedServers.has(serverId)) {
      return;
    }
    this.attachedServers.add(serverId);

    const pool = this.app.connectionPool;

    // 1. Notifications subscription (fast tier) -> signalk_notification_raised & is_alarm_active cache
    this.unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: `flow_manager_notifications_${serverId}`,
        path: 'notifications.**',
        tier: 'fast',
        onUpdate: async ({ path: skPath, value }) => {
          if (value === null || !value || typeof value !== 'object') {
            this.activeAlarms.set(skPath, false);
            return;
          }
          const notifObj = value as Record<string, unknown>;
          const rawState = String(notifObj.state ?? 'normal').trim().toLowerCase();
          if (rawState === 'normal' || rawState === '') {
            this.activeAlarms.set(skPath, false);
            return;
          }

          this.activeAlarms.set(skPath, true);
          const message = String(notifObj.message ?? '');
          const tokens = {
            path: skPath,
            state: rawState,
            message,
          };
          try {
            await this.homey.flow
              .getTriggerCard('signalk_notification_raised')
              .trigger(tokens, tokens);
          } catch {
            // Card may not be registered in minimal test harnesses
          }
        },
      }),
    );

    // 2. General wildcard subscription -> path cache, path_value_updated, shore_power, nav state, battery SOC
    this.unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: `flow_manager_wildcard_${serverId}`,
        path: '**',
        tier: 'fast',
        onUpdate: async ({ path: skPath, value, $source }) => {
          this.latestPathValues.set(skPath, value);

          // Shore power status detection (AC phase voltage or connected flag)
          if (
            skPath === 'electrical.ac.0.phaseA.voltage' ||
            skPath === 'electrical.ac.0.phase.A.voltage' ||
            skPath === 'electrical.ac.0.phaseA.connected' ||
            skPath === 'electrical.ac.0.connected'
          ) {
            const connected =
              typeof value === 'boolean'
                ? value
                : typeof value === 'number' && Number.isFinite(value) && value > 50;
            const prev = this.lastShorePowerByServer.get(serverId);
            if (prev === undefined || prev !== connected) {
              this.lastShorePowerByServer.set(serverId, connected);
              if (prev !== undefined) {
                const power =
                  typeof this.latestPathValues.get('electrical.ac.0.phaseA.realPower') === 'number'
                    ? (this.latestPathValues.get('electrical.ac.0.phaseA.realPower') as number)
                    : 0;
                const voltage =
                  typeof value === 'number' && Number.isFinite(value)
                    ? value
                    : connected
                      ? 230
                      : 0;
                try {
                  await this.homey.flow
                    .getTriggerCard('shore_power_status_changed')
                    .trigger({ connected, power, voltage }, { connected });
                } catch {
                  // Ignore if card not available
                }
              }
            }
          }

          // Navigation state change trigger (when handled at app level or if vessel device absent)
          if (skPath === 'navigation.state' && typeof value === 'string' && value.trim()) {
            const nextState = value.trim();
            const prevState = this.lastNavStateByServer.get(serverId);
            this.lastNavStateByServer.set(serverId, nextState);
            if (prevState !== undefined && prevState !== nextState) {
              try {
                await this.homey.flow
                  .getTriggerCard('navigation_state_changed')
                  .trigger(
                    { state: nextState, previous_state: prevState, previousState: prevState },
                    { state: nextState, previous_state: prevState, previousState: prevState },
                  );
              } catch {
                // Ignore if card not available
              }
            }
          }

          // Battery SOC below threshold trigger with hysteresis when no driver already emitted
          const socMatch = /^electrical\.batteries\.([^.]+)\.capacity\.stateOfCharge$/.exec(skPath);
          if (socMatch && typeof value === 'number' && Number.isFinite(value)) {
            const bankId = socMatch[1];
            const pct = this.app.unitConverter.fromSignalK(value, 'ratio_to_percent', 1);
            if (pct !== null) {
              await this.evaluateBatterySocThresholds(bankId, Math.max(0, Math.min(100, pct)));
            }
          }

          // Generic path_value_updated trigger for primitive values
          if (
            typeof value === 'number' ||
            typeof value === 'string' ||
            typeof value === 'boolean'
          ) {
            try {
              await this.homey.flow.getTriggerCard('path_value_updated').trigger(
                {
                  path: skPath,
                  value: String(value),
                  numericValue: typeof value === 'number' && Number.isFinite(value) ? value : 0,
                  source: $source,
                },
                { path: skPath, value, source: $source },
              );
            } catch {
              // Ignore if card not available
            }
          }
        },
      }),
    );
  }

  /**
   * Returns the latest cached raw value for a Signal K path.
   */
  public getLatestPathValue(path: string): unknown {
    return this.latestPathValues.get(path);
  }

  /**
   * Returns whether a notification path is currently active in the cache.
   */
  public isAlarmPathActive(path: string): boolean {
    return Boolean(this.activeAlarms.get(path));
  }

  /**
   * Unsubscribes all Flow subscriptions and clears internal caches.
   */
  public destroy(): void {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // Ignore teardown errors
      }
    }
    this.unsubs.length = 0;
    this.attachedServers.clear();
    this.latestPathValues.clear();
    this.activeAlarms.clear();
    this.lastNavStateByServer.clear();
    this.lastShorePowerByServer.clear();
    this.socTriggeredByBank.clear();
    this.lastSocByBank.clear();
    this.registered = false;
  }

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------

  private registerTriggers(): void {
    const flow = this.homey.flow;

    this.safeGetTriggerCard('signalk_notification_raised')?.registerRunListener(
      async (args: Record<string, any>, state: Record<string, any>) => {
        if (args?.pathPrefix && !String(state?.path ?? '').startsWith(String(args.pathPrefix))) {
          return false;
        }
        if (args?.minState && state?.state) {
          const actualRank = NOTIFICATION_RANK[String(state.state).toLowerCase() as NotificationSeverity] ?? 0;
          const minRank = NOTIFICATION_RANK[String(args.minState).toLowerCase() as NotificationSeverity] ?? 1;
          if (actualRank < minRank) {
            return false;
          }
        }
        return true;
      },
    );

    this.safeGetTriggerCard('anchor_drag_alarm')?.registerRunListener(async () => true);

    this.safeGetTriggerCard('navigation_state_changed')?.registerRunListener(
      async (args: Record<string, any>, state: Record<string, any>) => {
        if (args?.state && String(args.state) !== 'any' && args.state !== state?.state) {
          return false;
        }
        return true;
      },
    );

    this.safeGetTriggerCard('battery_soc_below_threshold')?.registerRunListener(
      async (args: Record<string, any>, state: Record<string, any>) => {
        if (args?.bank_id && state?.bank_id && args.bank_id !== state.bank_id) {
          return false;
        }
        if (typeof args?.threshold === 'number' && typeof state?.threshold === 'number') {
          return state.threshold === args.threshold || (typeof state.soc === 'number' && state.soc < args.threshold);
        }
        if (typeof args?.threshold === 'number' && typeof state?.soc === 'number') {
          return state.soc < args.threshold;
        }
        return true;
      },
    );

    this.safeGetTriggerCard('shore_power_status_changed')?.registerRunListener(
      async (args: Record<string, any>, state: Record<string, any>) => {
        if (args?.status === 'connected') {
          return Boolean(state?.connected) === true;
        }
        if (args?.status === 'disconnected') {
          return Boolean(state?.connected) === false;
        }
        return true;
      },
    );

    const pathUpdatedCard = this.safeGetTriggerCard('path_value_updated');
    if (pathUpdatedCard) {
      pathUpdatedCard.registerRunListener(
        async (args: Record<string, any>, state: Record<string, any>) => {
          const argPath = this.extractPathArg(args?.path);
          if (argPath && argPath !== state?.path) {
            return false;
          }
          return true;
        },
      );
      this.registerPathAutocomplete(pathUpdatedCard, 'path', false);
    }

    void flow;
  }

  // ---------------------------------------------------------------------------
  // Conditions
  // ---------------------------------------------------------------------------

  private registerConditions(): void {
    this.safeGetConditionCard('is_vessel_state')?.registerRunListener(
      async (args: Record<string, any>) => {
        const device = args?.device || this.getFirstDriverDevice('vessel');
        const current = device
          ? device.getCapabilityValue('navigation_state')
          : this.latestPathValues.get('navigation.state');
        return current === args?.state;
      },
    );

    const isAlarmCard = this.safeGetConditionCard('is_alarm_active');
    if (isAlarmCard) {
      isAlarmCard.registerRunListener(async (args: Record<string, any>) => {
        const skPath = this.extractPathArg(args?.path);
        if (skPath) {
          return Boolean(this.activeAlarms.get(skPath));
        }
        if (args?.device) {
          return Boolean(
            args.device.getCapabilityValue?.('alarm_generic') ||
              args.device.getCapabilityValue?.('alarm_battery') ||
              args.device.getCapabilityValue?.('alarm_water') ||
              args.device.getCapabilityValue?.('alarm_contact'),
          );
        }
        return Array.from(this.activeAlarms.values()).some(Boolean);
      });
      this.registerNotificationPathAutocomplete(isAlarmCard, 'path');
    }

    this.safeGetConditionCard('is_battery_soc_below')?.registerRunListener(
      async (args: Record<string, any>) => {
        const threshold = Number(args?.threshold ?? 50);
        if (!Number.isFinite(threshold)) {
          return false;
        }

        const bankId = typeof args?.bank_id === 'string' && args.bank_id.trim() ? args.bank_id.trim() : undefined;
        let device = args?.device;
        if (!device) {
          const bankDevices = this.getDriverDevices('electrical-bank');
          if (bankId) {
            device = bankDevices.find((d) => d.getStoreValue?.('bankId') === bankId);
          }
          if (!device) {
            device =
              bankDevices.find((d) => d.getStoreValue?.('bankType') === 'battery') ||
              bankDevices[0];
          }
        }

        let soc: unknown = device?.getCapabilityValue?.('measure_battery');
        if (typeof soc !== 'number' || !Number.isFinite(soc)) {
          const key = `electrical.batteries.${bankId || 'house'}.capacity.stateOfCharge`;
          const rawRatio = this.latestPathValues.get(key);
          if (typeof rawRatio === 'number' && Number.isFinite(rawRatio)) {
            soc = this.app.unitConverter.fromSignalK(rawRatio, 'ratio_to_percent', 1);
          }
        }

        return typeof soc === 'number' && Number.isFinite(soc) && soc < threshold;
      },
    );

    this.safeGetConditionCard('is_anchor_armed')?.registerRunListener(
      async (args: Record<string, any>) => {
        const device = args?.device || this.getFirstDriverDevice('vessel');
        if (device) {
          return Boolean(device.getCapabilityValue?.('onoff.anchor_armed'));
        }
        const anchorPos = this.latestPathValues.get('navigation.anchor.position');
        return Boolean(anchorPos && typeof anchorPos === 'object');
      },
    );

    const pathCmpCard = this.safeGetConditionCard('path_value_comparison');
    if (pathCmpCard) {
      pathCmpCard.registerRunListener(async (args: Record<string, any>) => {
        const skPath = this.extractPathArg(args?.path);
        const rawActual = skPath ? this.latestPathValues.get(skPath) : undefined;
        const actual = typeof rawActual === 'number' ? rawActual : Number(rawActual);
        const target = Number(args?.value);
        if (!Number.isFinite(actual) || !Number.isFinite(target)) {
          return false;
        }
        switch (String(args?.operator ?? '')) {
          case '>':
            return actual > target;
          case '>=':
            return actual >= target;
          case '<':
            return actual < target;
          case '<=':
            return actual <= target;
          case '==':
          case '===':
            return actual === target;
          case '!=':
          case '!==':
            return actual !== target;
          default:
            return false;
        }
      });
      this.registerPathAutocomplete(pathCmpCard, 'path', false);
    }
  }

  // ---------------------------------------------------------------------------
  // Actions (Homey -> Signal K Bridge with SI conversion + Control)
  // ---------------------------------------------------------------------------

  private registerActions(): void {
    const uc = this.app.unitConverter;
    const pool = this.app.connectionPool;

    // 1. publish_temperature_to_signalk (°C -> K)
    this.safeGetActionCard('publish_temperature_to_signalk')?.registerRunListener(
      async (args: Record<string, any>) => {
        const rawVal = args?.temperature_c ?? args?.value ?? args?.temperature;
        const val = typeof rawVal === 'number' ? rawVal : Number(rawVal);
        if (rawVal === undefined || rawVal === null || !Number.isFinite(val)) {
          throw new Error('Invalid numeric sensor value: temperature must be a finite number');
        }
        if (val < -273.15) {
          throw new Error('Temperature cannot be below absolute zero (-273.15°C)');
        }
        const zone = this.resolveZone(args?.zone, 'mainCabin');
        const customPath = this.extractPathArg(args?.path);
        const skPath = customPath || `environment.inside.${zone}.temperature`;
        const kelvin = uc.toSignalK(val, 'temperature_k_to_c');
        if (kelvin === null) {
          throw new Error('Invalid numeric sensor value: temperature conversion failed');
        }

        await pool.publishDelta(this.resolveTargetServerId(args), [
          {
            path: skPath,
            value: kelvin,
            $source: this.resolveSourceTag(args?.source, 'zigbee.temperature'),
          },
        ]);
        return true;
      },
    );

    // 2. publish_humidity_to_signalk (% -> ratio 0..1)
    this.safeGetActionCard('publish_humidity_to_signalk')?.registerRunListener(
      async (args: Record<string, any>) => {
        const rawVal = args?.humidity_pct ?? args?.value ?? args?.humidity;
        const val = typeof rawVal === 'number' ? rawVal : Number(rawVal);
        if (rawVal === undefined || rawVal === null || !Number.isFinite(val)) {
          throw new Error('Invalid numeric sensor value: humidity must be a finite number');
        }
        if (val < 0 || val > 100) {
          throw new Error('Relative humidity percentage must be between 0% and 100%');
        }
        const zone = this.resolveZone(args?.zone, 'mainCabin');
        const customPath = this.extractPathArg(args?.path);
        const skPath = customPath || `environment.inside.${zone}.relativeHumidity`;
        const ratio = uc.toSignalK(val, 'ratio_to_percent');
        if (ratio === null) {
          throw new Error('Invalid numeric sensor value: humidity conversion failed');
        }

        await pool.publishDelta(this.resolveTargetServerId(args), [
          {
            path: skPath,
            value: ratio,
            $source: this.resolveSourceTag(args?.source, 'ble.humidity'),
          },
        ]);
        return true;
      },
    );

    // 3. publish_pressure_to_signalk (hPa -> Pa)
    this.safeGetActionCard('publish_pressure_to_signalk')?.registerRunListener(
      async (args: Record<string, any>) => {
        const rawVal = args?.pressure_hpa ?? args?.value ?? args?.pressure;
        const val = typeof rawVal === 'number' ? rawVal : Number(rawVal);
        if (rawVal === undefined || rawVal === null || !Number.isFinite(val) || val <= 0) {
          throw new Error('Invalid numeric sensor value: pressure must be a positive finite number');
        }
        const zone = this.resolveZone(args?.zone, 'saloon');
        const customPath = this.extractPathArg(args?.path);
        const skPath = customPath || `environment.inside.${zone}.pressure`;
        const pascals = uc.toSignalK(val, 'pressure_pa_to_hpa');
        if (pascals === null) {
          throw new Error('Invalid numeric sensor value: pressure conversion failed');
        }

        await pool.publishDelta(this.resolveTargetServerId(args), [
          {
            path: skPath,
            value: pascals,
            $source: this.resolveSourceTag(args?.source, 'i2c.pressure'),
          },
        ]);
        return true;
      },
    );

    // 4. publish_switch_contact_to_signalk (and alias publish_switch_state_to_signalk if queried)
    const publishSwitchHandler = async (args: Record<string, any>) => {
      const customPath = this.extractPathArg(args?.path);
      const switchId = typeof args?.switchId === 'string'
        ? args.switchId.trim()
        : typeof args?.id === 'string'
          ? args.id.trim()
          : '';
      const skPath = customPath || (switchId ? `electrical.switches.${switchId}.state` : '');
      if (!skPath || !VALID_DOT_PATH_REGEX.test(skPath)) {
        throw new Error('Valid Signal K switch/contact path or switchId is required');
      }
      const rawState = args?.state ?? args?.value;
      const boolState =
        typeof rawState === 'boolean'
          ? rawState
          : rawState === 'true' || rawState === '1' || rawState === 1;

      await pool.publishDelta(this.resolveTargetServerId(args), [
        {
          path: skPath,
          value: boolState,
          $source: this.resolveSourceTag(args?.source, 'homey.switch'),
        },
      ]);
      return true;
    };

    const switchContactCard = this.safeGetActionCard('publish_switch_contact_to_signalk');
    if (switchContactCard) {
      switchContactCard.registerRunListener(publishSwitchHandler);
      this.registerPathAutocomplete(switchContactCard, 'path', false);
    }

    // 5. publish_notification_alarm
    const notifCard = this.safeGetActionCard('publish_notification_alarm');
    if (notifCard) {
      notifCard.registerRunListener(async (args: Record<string, any>) => {
        const customPath = this.extractPathArg(args?.path);
        const category = typeof args?.category === 'string' ? args.category.trim() : 'security';
        const item = typeof args?.item === 'string' ? args.item.trim() : 'general';
        const skPath = customPath || `notifications.${category}.${item}`;
        if (!VALID_DOT_PATH_REGEX.test(skPath)) {
          throw new Error(`Invalid Signal K notification path: "${skPath}"`);
        }

        const state = String(args?.state || 'alarm').trim().toLowerCase() as NotificationSeverity;
        if (!(state in NOTIFICATION_RANK)) {
          throw new Error(
            `Invalid notification state "${state}". Must be normal, alert, warn, alarm, or emergency.`,
          );
        }

        const method = Array.isArray(args?.method)
          ? args.method
          : state === 'normal'
            ? []
            : ['visual', 'sound'];
        const message =
          typeof args?.message === 'string' && args.message.trim().length > 0
            ? args.message
            : state === 'normal'
              ? 'Normal'
              : `${skPath} (${state})`;

        await pool.publishDelta(this.resolveTargetServerId(args), [
          {
            path: skPath,
            value: { state, method, message },
            $source: this.resolveSourceTag(args?.source, 'homey.notification'),
          },
        ]);
        return true;
      });
      this.registerNotificationPathAutocomplete(notifCard, 'path');
    }

    // 6. publish_custom_value_to_signalk
    const customValCard = this.safeGetActionCard('publish_custom_value_to_signalk');
    if (customValCard) {
      customValCard.registerRunListener(async (args: Record<string, any>) => {
        const skPath = this.extractPathArg(args?.path);
        if (!skPath || !VALID_DOT_PATH_REGEX.test(skPath)) {
          throw new Error(`Invalid Signal K dot-path: "${skPath}"`);
        }

        let val: unknown = args?.value;
        if (typeof val === 'number' && !Number.isFinite(val)) {
          throw new Error('Invalid numeric sensor value');
        }
        if (typeof val === 'string') {
          val = this.parseTypedValue(val);
          if (typeof val === 'number' && !Number.isFinite(val)) {
            throw new Error('Invalid numeric sensor value');
          }
        }

        await pool.publishDelta(this.resolveTargetServerId(args), [
          {
            path: skPath,
            value: val,
            $source: this.resolveSourceTag(args?.source, 'homey.custom'),
          },
        ]);
        return true;
      });
      this.registerPathAutocomplete(customValCard, 'path', false);
    }

    // 7. arm_anchor_watch
    this.safeGetActionCard('arm_anchor_watch')?.registerRunListener(
      async (args: Record<string, any>) => {
        const rawRadius = args?.max_radius ?? args?.maxRadius ?? 40;
        const maxRadius = Number(rawRadius);
        if (!Number.isFinite(maxRadius) || maxRadius <= 0) {
          throw new Error('Anchor max radius must be a positive number in meters');
        }

        const rawRode = args?.rode_length ?? args?.rodeLength;
        const rodeLength =
          rawRode !== undefined && rawRode !== null && Number.isFinite(Number(rawRode))
            ? Number(rawRode)
            : undefined;

        const vesselDevice = args?.device || this.getFirstDriverDevice('vessel');
        if (vesselDevice && typeof vesselDevice.armAnchorWatch === 'function') {
          await vesselDevice.armAnchorWatch({ maxRadius, rodeLength });
          return true;
        }

        const serverId = this.resolveTargetServerId(args);
        let dropPosition = this.latestPathValues.get('navigation.position');
        if (!dropPosition || typeof dropPosition !== 'object') {
          try {
            const subtree = await pool.getVesselSubtree(serverId, 'navigation.position');
            if (subtree?.value && typeof subtree.value === 'object') {
              dropPosition = subtree.value;
            }
          } catch {
            // Fall through to fallback
          }
        }
        if (!dropPosition || typeof dropPosition !== 'object') {
          dropPosition = { latitude: 0, longitude: 0 };
        }

        const posResult = await pool.putPath(serverId, 'navigation.anchor.position', dropPosition);
        if (posResult.state === 'FAILED') {
          throw new Error(posResult.message || 'Failed to arm anchor watch');
        }
        const radiusResult = await pool.putPath(serverId, 'navigation.anchor.maxRadius', maxRadius);
        if (radiusResult.state === 'FAILED') {
          throw new Error(radiusResult.message || 'Failed to set anchor max radius');
        }
        if (rodeLength !== undefined && rodeLength >= 0) {
          await pool.putPath(serverId, 'navigation.anchor.rodeLength', rodeLength).catch(() => {});
        }
        return true;
      },
    );

    // 8. disarm_anchor_watch
    this.safeGetActionCard('disarm_anchor_watch')?.registerRunListener(
      async (args: Record<string, any>) => {
        const vesselDevice = args?.device || this.getFirstDriverDevice('vessel');
        if (vesselDevice && typeof vesselDevice.disarmAnchorWatch === 'function') {
          await vesselDevice.disarmAnchorWatch();
          return true;
        }

        const serverId = this.resolveTargetServerId(args);
        const result = await pool.putPath(serverId, 'navigation.anchor.position', null);
        if (result.state === 'FAILED') {
          throw new Error(result.message || 'Failed to disarm anchor watch');
        }
        return true;
      },
    );

    // 9. set_anchor_max_radius
    this.safeGetActionCard('set_anchor_max_radius')?.registerRunListener(
      async (args: Record<string, any>) => {
        const rawRadius = args?.max_radius ?? args?.maxRadius ?? args?.radius;
        const maxRadius = Number(rawRadius);
        if (!Number.isFinite(maxRadius) || maxRadius <= 0) {
          throw new Error('Anchor max radius must be a positive number in meters');
        }

        const vesselDevice = args?.device || this.getFirstDriverDevice('vessel');
        if (vesselDevice && typeof vesselDevice.setAnchorMaxRadius === 'function') {
          await vesselDevice.setAnchorMaxRadius(maxRadius);
          return true;
        }

        const serverId = this.resolveTargetServerId(args);
        const result = await pool.putPath(serverId, 'navigation.anchor.maxRadius', maxRadius);
        if (result.state === 'FAILED') {
          throw new Error(result.message || 'Failed to update anchor max radius');
        }
        return true;
      },
    );

    // 10. set_charger_inverter_mode
    const chargerModeCard = this.safeGetActionCard('set_charger_inverter_mode');
    if (chargerModeCard) {
      chargerModeCard.registerRunListener(async (args: Record<string, any>) => {
        const mode = String(args?.mode || 'eco').trim();
        const customPath = this.extractPathArg(args?.path);
        const bankId =
          typeof args?.bank_id === 'string' && args.bank_id.trim()
            ? args.bank_id.trim()
            : typeof args?.bankId === 'string' && args.bankId.trim()
              ? args.bankId.trim()
              : '0';
        const targetPath = customPath || `electrical.inverters.${bankId}.inverterMode`;

        // Enforce SafetyBoundary prior to PUT
        this.app.safetyBoundary.assertWritablePath(targetPath);

        const result = await pool.putPath(this.resolveTargetServerId(args), targetPath, mode);
        if (result.state === 'FAILED') {
          throw new Error(result.message || `Failed to set charger/inverter mode on ${targetPath}`);
        }
        return true;
      });
      this.registerWritablePathAutocomplete(chargerModeCard, 'path', [
        'electrical.inverters.',
        'electrical.chargers.',
      ]);
    }

    // 11. put_signalk_path (MUST enforce SafetyBoundary.assertWritablePath and throw SafetyBoundaryError)
    const putCard = this.safeGetActionCard('put_signalk_path');
    if (putCard) {
      putCard.registerRunListener(async (args: Record<string, any>) => {
        const skPath = this.extractPathArg(args?.path);

        // Mandatory safety boundary assertion BEFORE any network or server lookup
        this.app.safetyBoundary.assertWritablePath(skPath);

        const parsedValue =
          typeof args?.value === 'string' ? this.parseTypedValue(args.value) : args?.value;
        const result = await pool.putPath(
          this.resolveTargetServerId(args),
          skPath,
          parsedValue,
          { source: typeof args?.source === 'string' ? args.source : undefined },
        );
        if (result.state === 'FAILED') {
          throw new Error(result.message || `Signal K PUT failed for "${skPath}"`);
        }
        return true;
      });
      this.registerPathAutocomplete(putCard, 'path', true);
    }
  }

  // ---------------------------------------------------------------------------
  // Autocomplete & Helper Methods
  // ---------------------------------------------------------------------------

  private registerPathAutocomplete(
    card: Homey.FlowCard,
    argName: string,
    writableOnly: boolean,
  ): void {
    try {
      card.registerArgumentAutocompleteListener(argName, async (query: string) => {
        const q = String(query ?? '').trim().toLowerCase();
        const candidates = await this.collectDiscoveredPaths(writableOnly);
        return candidates
          .filter(
            (item) =>
              !q ||
              item.name.toLowerCase().includes(q) ||
              (item.description && item.description.toLowerCase().includes(q)),
          )
          .slice(0, 50);
      });
    } catch {
      // Ignore if mock card doesn't implement autocomplete registration
    }
  }

  private registerNotificationPathAutocomplete(card: Homey.FlowCard, argName: string): void {
    try {
      card.registerArgumentAutocompleteListener(argName, async (query: string) => {
        const q = String(query ?? '').trim().toLowerCase();
        const defaults = [
          {
            id: 'notifications.security.companionwayHatch',
            name: 'notifications.security.companionwayHatch',
            description: 'Cabin companionway hatch intrusion alert',
          },
          {
            id: 'notifications.security.forwardHatch',
            name: 'notifications.security.forwardHatch',
            description: 'Forward hatch intrusion alert',
          },
          {
            id: 'notifications.bilge.main',
            name: 'notifications.bilge.main',
            description: 'Main bilge high-water alarm',
          },
          {
            id: 'notifications.navigation.anchor',
            name: 'notifications.navigation.anchor',
            description: 'Anchor drag watch notification',
          },
          {
            id: 'notifications.electrical.lowBattery',
            name: 'notifications.electrical.lowBattery',
            description: 'Low battery alarm notification',
          },
        ];

        const dynamic = Array.from(this.activeAlarms.keys())
          .concat(
            Array.from(this.latestPathValues.keys()).filter((p) => p.startsWith('notifications.')),
          )
          .map((p) => ({
            id: p,
            name: p,
            description: 'Live Signal K notification path',
          }));

        const merged = new Map<string, { id: string; name: string; description: string }>();
        for (const item of [...defaults, ...dynamic]) {
          merged.set(item.name, item);
        }

        return Array.from(merged.values())
          .filter(
            (item) =>
              !q ||
              item.name.toLowerCase().includes(q) ||
              item.description.toLowerCase().includes(q),
          )
          .slice(0, 50);
      });
    } catch {
      // Ignore
    }
  }

  private registerWritablePathAutocomplete(
    card: Homey.FlowCard,
    argName: string,
    prefixes: string[],
  ): void {
    try {
      card.registerArgumentAutocompleteListener(argName, async (query: string) => {
        const q = String(query ?? '').trim().toLowerCase();
        const defaults = [
          'electrical.inverters.0.inverterMode',
          'electrical.chargers.0.mode',
          'electrical.chargers.0.currentLimit',
        ];
        const all = await this.collectDiscoveredPaths(true);
        const filtered = all.filter((item) =>
          prefixes.some((prefix) => item.name.startsWith(prefix)),
        );
        const merged = new Map<string, Homey.FlowCard.ArgumentAutocompleteResult>();
        for (const d of defaults) {
          merged.set(d, { id: d, name: d, description: 'Writable charger/inverter control path' });
        }
        for (const f of filtered) {
          merged.set(f.name, f);
        }
        return Array.from(merged.values())
          .filter((item) => !q || item.name.toLowerCase().includes(q))
          .slice(0, 50);
      });
    } catch {
      // Ignore
    }
  }

  private async collectDiscoveredPaths(
    writableOnly: boolean,
  ): Promise<Homey.FlowCard.ArgumentAutocompleteResult[]> {
    const map = new Map<string, Homey.FlowCard.ArgumentAutocompleteResult>();

    // Seed from HardwarePresets
    for (const preset of this.app.discoveryService.getHardwarePresets()) {
      for (const p of preset.paths) {
        if (writableOnly && !this.app.safetyBoundary.isWritablePath(p.examplePath)) {
          continue;
        }
        map.set(p.examplePath, {
          id: p.examplePath,
          name: p.examplePath,
          description: p.description,
        });
      }
    }

    // Seed from live cached paths
    for (const livePath of this.latestPathValues.keys()) {
      if (writableOnly && !this.app.safetyBoundary.isWritablePath(livePath)) {
        continue;
      }
      if (!map.has(livePath)) {
        map.set(livePath, {
          id: livePath,
          name: livePath,
          description: writableOnly ? 'Writable Signal K path' : 'Live Signal K path',
        });
      }
    }

    // Query /vessels/self if connected
    const serverId = this.resolveTargetServerId({});
    try {
      const status = this.app.connectionPool.getConnectionStatus(serverId);
      if (status.connected) {
        const tree = await this.app.connectionPool.getVesselSubtree(serverId);
        const leaves = this.app.discoveryService.discoverAllLeafPaths(tree);
        for (const leaf of leaves) {
          if (writableOnly && !leaf.writable) {
            continue;
          }
          map.set(leaf.path, {
            id: leaf.path,
            name: leaf.path,
            description: leaf.description || leaf.displayName || (leaf.units ? `Unit: ${leaf.units}` : undefined),
          });
        }
      }
    } catch {
      // Fall back cleanly to presets + live cache if server query fails
    }

    return Array.from(map.values());
  }

  private async evaluateBatterySocThresholds(bankId: string, newSoc: number): Promise<void> {
    let triggeredSet = this.socTriggeredByBank.get(bankId);
    if (!triggeredSet) {
      triggeredSet = new Set<number>();
      this.socTriggeredByBank.set(bankId, triggeredSet);
    }

    const prevSoc = this.lastSocByBank.get(bankId) ?? null;
    this.lastSocByBank.set(bankId, newSoc);

    for (const t of Array.from(triggeredSet)) {
      if (newSoc > t) {
        triggeredSet.delete(t);
      }
    }

    const rawVoltage = this.latestPathValues.get(`electrical.batteries.${bankId}.voltage`);
    const voltage = typeof rawVoltage === 'number' && Number.isFinite(rawVoltage) ? rawVoltage : 0;

    for (const threshold of STANDARD_SOC_THRESHOLDS) {
      const crossedDown = (prevSoc === null || prevSoc >= threshold) && newSoc < threshold;
      if (crossedDown && !triggeredSet.has(threshold)) {
        triggeredSet.add(threshold);
        const tokens = {
          bank_name: bankId,
          bankId,
          soc: newSoc,
          voltage,
          threshold,
        };
        try {
          await this.homey.flow
            .getTriggerCard('battery_soc_below_threshold')
            .trigger(tokens, tokens);
        } catch {
          // Ignore if card not available
        }
      }
    }
  }

  private resolveTargetServerId(args: Record<string, any> | undefined): string {
    if (typeof args?.serverId === 'string' && args.serverId.trim()) {
      return args.serverId.trim();
    }
    const deviceServerId = args?.device?.getStoreValue?.('serverId');
    if (typeof deviceServerId === 'string' && deviceServerId.trim()) {
      return deviceServerId.trim();
    }
    if (typeof this.app.getDefaultServerId === 'function') {
      return this.app.getDefaultServerId();
    }
    const firstRegistered = this.app.getRegisteredServerIds?.()[0];
    return firstRegistered || 'default';
  }

  private resolveZone(rawZone: unknown, fallback: string): string {
    if (typeof rawZone !== 'string' || !rawZone.trim()) {
      return fallback;
    }
    const clean = rawZone.trim();
    if ((INDOOR_ENVIRONMENT_ZONES as readonly string[]).includes(clean)) {
      return clean;
    }
    if (/^[a-zA-Z0-9_-]+$/.test(clean)) {
      return clean;
    }
    throw new Error(`Invalid environment zone "${clean}"`);
  }

  private resolveSourceTag(rawSource: unknown, fallbackSuffix: string): string {
    if (typeof rawSource === 'string' && rawSource.trim().length > 0) {
      const trimmed = rawSource.trim();
      return trimmed.toLowerCase().startsWith('homey') ? trimmed : `homey.${trimmed}`;
    }
    return `homey.${fallbackSuffix}`;
  }

  private extractPathArg(rawArg: unknown): string {
    if (typeof rawArg === 'string') {
      return rawArg.trim();
    }
    if (rawArg && typeof rawArg === 'object') {
      const obj = rawArg as Record<string, unknown>;
      if (typeof obj.id === 'string' && obj.id.trim()) {
        return obj.id.trim();
      }
      if (typeof obj.name === 'string' && obj.name.trim()) {
        return obj.name.trim();
      }
    }
    return '';
  }

  private parseTypedValue(raw: string): unknown {
    const trimmed = raw.trim();
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;
    if (trimmed !== '' && !Number.isNaN(Number(trimmed))) {
      return Number(trimmed);
    }
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return raw;
      }
    }
    return raw;
  }

  private getFirstDriverDevice(driverId: string): any | undefined {
    return this.getDriverDevices(driverId)[0];
  }

  private getDriverDevices(driverId: string): any[] {
    try {
      const driver = this.homey.drivers?.getDriver?.(driverId);
      return driver?.getDevices?.() || [];
    } catch {
      return [];
    }
  }

  private safeGetTriggerCard(id: string): Homey.FlowCardTrigger | null {
    try {
      return this.homey.flow.getTriggerCard(id);
    } catch {
      return null;
    }
  }

  private safeGetConditionCard(id: string): Homey.FlowCardCondition | null {
    try {
      return this.homey.flow.getConditionCard(id);
    } catch {
      return null;
    }
  }

  private safeGetActionCard(id: string): Homey.FlowCardAction | null {
    try {
      return this.homey.flow.getActionCard(id);
    } catch {
      return null;
    }
  }
}

export default FlowCardManager;
