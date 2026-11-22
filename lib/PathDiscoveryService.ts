/**
 * Vessel Self Tree Auto-Discovery Service (`lib/PathDiscoveryService.ts`).
 *
 * Inspects the full Signal K data model returned by `GET /signalk/v1/api/vessels/self`
 * to automatically discover:
 *  - Vessel & Anchor Watch telemetry (`vessel`)
 *  - Victron / NMEA 2000 Electrical Banks (`electrical-bank`: batteries, solar MPPT, chargers, inverters, alternators, AC)
 *  - Fluid Tank Monitors (`fluid-tank`: freshWater, fuel, blackWater, wasteWater, liveWell, lubrication, ballast)
 *  - Digital Switches & Relays (`digital-switch`: direct switches & NMEA 2000 banked switches, Victron GX relays, Shelly/diesel heater relays)
 *  - Propulsion Engines (`propulsion`: port, starboard, main, etc. — strictly read-only)
 *  - All leaf paths for Custom Sensor pairing & Flow Card autocomplete (`custom-sensor`)
 */

import { UnitCategory } from './UnitConverter';
import { SafetyBoundary, ISafetyBoundary } from './SafetyBoundary';
import {
  DriverTargetId,
  FLUID_TANK_TYPES,
  HARDWARE_PRESETS,
  HardwarePreset,
} from './HardwarePresets';

export interface DiscoveredSubsystemInstance {
  driverId: DriverTargetId;
  id: string;
  instanceKey: string;
  name: string;
  category: string;
  basePath: string;
  availablePaths: string[];
  sources: string[];
  supportsPut: boolean;
  supportsDim: boolean;
  presetMatchId?: string;
}

export interface DiscoveredLeafPath {
  path: string;
  value: unknown;
  $source?: string;
  timestamp?: string;
  units?: string;
  description?: string;
  displayName?: string;
  inferredUnitCategory: UnitCategory;
  writable: boolean;
}

export interface IPathDiscoveryService {
  discoverVessel(selfTree: Record<string, any> | null | undefined): DiscoveredSubsystemInstance;
  discoverElectricalBanks(selfTree: Record<string, any> | null | undefined): DiscoveredSubsystemInstance[];
  discoverFluidTanks(selfTree: Record<string, any> | null | undefined): DiscoveredSubsystemInstance[];
  discoverDigitalSwitches(selfTree: Record<string, any> | null | undefined): DiscoveredSubsystemInstance[];
  discoverPropulsionEngines(selfTree: Record<string, any> | null | undefined): DiscoveredSubsystemInstance[];
  discoverAllLeafPaths(selfTree: Record<string, any> | null | undefined): DiscoveredLeafPath[];
  inferUnitCategory(path: string, units?: string): UnitCategory;
}

const RESERVED_METADATA_KEYS = new Set([
  'meta',
  'values',
  '$source',
  'source',
  'timestamp',
  'pgn',
  'sentence',
]);

/**
 * Converts camelCase or snake_case identifier into a human-friendly title.
 */
function formatDisplayName(rawKey: string, prefix?: string): string {
  const spaced = rawKey
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  const titled = spaced.charAt(0).toUpperCase() + spaced.slice(1);
  return prefix ? `${prefix} (${titled})` : titled;
}

/**
 * Determines whether an object in the Signal K full tree represents a leaf data node.
 */
export function isSignalKLeafNode(node: unknown): node is Record<string, any> {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return false;
  }
  const obj = node as Record<string, any>;
  if ('value' in obj) {
    return true;
  }
  // A node with meta/timestamp/$source and no non-metadata object children is also a leaf
  if ('meta' in obj || '$source' in obj || 'timestamp' in obj) {
    const nonMetaKeys = Object.keys(obj).filter((k) => !RESERVED_METADATA_KEYS.has(k));
    if (nonMetaKeys.length === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Extracts `$source` string from a Signal K leaf node if present.
 */
function extractNodeSource(node: Record<string, any>): string | undefined {
  if (typeof node.$source === 'string' && node.$source.length > 0) {
    return node.$source;
  }
  if (node.source && typeof node.source === 'object') {
    const label = node.source.label ? String(node.source.label) : '';
    const src = node.source.src !== undefined ? `.${node.source.src}` : '';
    if (label) {
      return `${label}${src}`;
    }
  }
  return undefined;
}

export class PathDiscoveryService implements IPathDiscoveryService {
  private readonly safetyBoundary: ISafetyBoundary;

  constructor(safetyBoundaryInstance: ISafetyBoundary = new SafetyBoundary()) {
    this.safetyBoundary = safetyBoundaryInstance;
  }

  /**
   * Infers the appropriate `UnitCategory` from Signal K `meta.units` and/or dot-path naming conventions.
   */
  public inferUnitCategory(path: string, units?: string): UnitCategory {
    const cleanUnits = typeof units === 'string' ? units.trim() : '';
    const lowerPath = path.toLowerCase();

    if (cleanUnits === 'K') {
      return 'temperature_k_to_c';
    }
    if (cleanUnits === 'm/s') {
      return 'speed_ms_to_kn';
    }
    if (cleanUnits === 'Pa') {
      if (
        lowerPath.startsWith('propulsion.') ||
        lowerPath.includes('oilpressure') ||
        lowerPath.includes('coolantpressure') ||
        lowerPath.includes('fuelpressure')
      ) {
        return 'pressure_pa_to_bar';
      }
      return 'pressure_pa_to_hpa';
    }
    if (cleanUnits === 'rad') {
      if (
        lowerPath.includes('angleapparent') ||
        lowerPath.includes('angletrue') ||
        lowerPath.includes('attitude') ||
        lowerPath.endsWith('.roll') ||
        lowerPath.endsWith('.pitch') ||
        lowerPath.includes('rudderangle')
      ) {
        return 'angle_rad_to_deg_signed';
      }
      return 'angle_rad_to_deg_unsigned';
    }
    if (cleanUnits === 'rad/s') {
      return 'angular_velocity_rads_to_degs';
    }
    if (cleanUnits === 'ratio') {
      return 'ratio_to_percent';
    }
    if (cleanUnits === 'Hz') {
      return 'frequency_hz_to_rpm';
    }
    if (cleanUnits === 'C') {
      return 'charge_c_to_ah';
    }
    if (cleanUnits === 'J') {
      return 'energy_j_to_kwh';
    }
    if (cleanUnits === 'm3' || cleanUnits === 'm^3' || cleanUnits === 'm³') {
      return 'volume_m3_to_l';
    }
    if (cleanUnits === 'm3/s' || cleanUnits === 'm^3/s' || cleanUnits === 'm³/s') {
      return 'flow_m3s_to_lh';
    }
    if (cleanUnits === 's') {
      if (lowerPath.includes('timeremaining')) {
        return 'duration_s_to_min';
      }
      if (lowerPath.includes('runtime') || lowerPath.includes('hours')) {
        return 'duration_s_to_h';
      }
    }
    if (cleanUnits === 'm') {
      return 'distance_m';
    }

    // Fallback inference from path suffix / semantics
    if (lowerPath.includes('temperature') || lowerPath.endsWith('.temp')) {
      return 'temperature_k_to_c';
    }
    if (
      lowerPath.includes('speedoverground') ||
      lowerPath.includes('speedthroughwater') ||
      lowerPath.includes('wind.speed')
    ) {
      return 'speed_ms_to_kn';
    }
    if (
      lowerPath.startsWith('propulsion.') &&
      (lowerPath.includes('pressure') || lowerPath.endsWith('.oilpressure'))
    ) {
      return 'pressure_pa_to_bar';
    }
    if (lowerPath.endsWith('.pressure')) {
      return 'pressure_pa_to_hpa';
    }
    if (
      lowerPath.includes('stateofcharge') ||
      lowerPath.includes('relativehumidity') ||
      lowerPath.includes('humidity') ||
      lowerPath.endsWith('.currentlevel')
    ) {
      return 'ratio_to_percent';
    }
    if (
      lowerPath.includes('wind.angle') ||
      lowerPath.endsWith('.roll') ||
      lowerPath.endsWith('.pitch') ||
      lowerPath.includes('rudderangle')
    ) {
      return 'angle_rad_to_deg_signed';
    }
    if (
      lowerPath.includes('heading') ||
      lowerPath.includes('courseoverground') ||
      lowerPath.includes('bearing')
    ) {
      return 'angle_rad_to_deg_unsigned';
    }
    if (lowerPath.endsWith('.rateofturn')) {
      return 'angular_velocity_rads_to_degs';
    }
    if (lowerPath.endsWith('.revolutions')) {
      return 'frequency_hz_to_rpm';
    }
    if (lowerPath.endsWith('capacity.remaining') || lowerPath.endsWith('capacity.nominal')) {
      return 'charge_c_to_ah';
    }
    if (lowerPath.includes('yieldtoday') || lowerPath.endsWith('capacity.actual')) {
      return 'energy_j_to_kwh';
    }
    if (lowerPath.endsWith('.currentvolume') || lowerPath.endsWith('.capacity')) {
      return 'volume_m3_to_l';
    }
    if (lowerPath.endsWith('.fuel.rate')) {
      return 'flow_m3s_to_lh';
    }
    if (lowerPath.endsWith('.runtime')) {
      return 'duration_s_to_h';
    }
    if (lowerPath.endsWith('.timeremaining')) {
      return 'duration_s_to_min';
    }
    if (
      lowerPath.startsWith('environment.depth.') ||
      lowerPath.includes('anchor.currentradius') ||
      lowerPath.includes('anchor.maxradius') ||
      lowerPath.includes('anchor.rodelength')
    ) {
      return 'distance_m';
    }

    return 'passthrough';
  }

  /**
   * Recursively collects all leaf paths under a given sub-object.
   */
  public discoverAllLeafPaths(
    selfTree: Record<string, any> | null | undefined,
    prefix = '',
  ): DiscoveredLeafPath[] {
    const results: DiscoveredLeafPath[] = [];
    if (!selfTree || typeof selfTree !== 'object' || Array.isArray(selfTree)) {
      return results;
    }

    const walk = (node: Record<string, any>, currentPath: string) => {
      if (currentPath && isSignalKLeafNode(node)) {
        const units = typeof node.meta?.units === 'string' ? node.meta.units : undefined;
        const description =
          typeof node.meta?.description === 'string' ? node.meta.description : undefined;
        const displayName =
          typeof node.meta?.displayName === 'string'
            ? node.meta.displayName
            : typeof node.meta?.shortName === 'string'
              ? node.meta.shortName
              : undefined;
        const source = extractNodeSource(node);
        const writable =
          Boolean(node.meta?.supportsPut) && this.safetyBoundary.isWritablePath(currentPath)
            ? true
            : this.safetyBoundary.isWritablePath(currentPath);

        results.push({
          path: currentPath,
          value: 'value' in node ? node.value : null,
          $source: source,
          timestamp: typeof node.timestamp === 'string' ? node.timestamp : undefined,
          units,
          description,
          displayName,
          inferredUnitCategory: this.inferUnitCategory(currentPath, units),
          writable,
        });
        return;
      }

      for (const [key, child] of Object.entries(node)) {
        if (RESERVED_METADATA_KEYS.has(key)) {
          continue;
        }
        if (!child || typeof child !== 'object' || Array.isArray(child)) {
          continue;
        }
        const nextPath = currentPath ? `${currentPath}.${key}` : key;
        walk(child as Record<string, any>, nextPath);
      }
    };

    walk(selfTree, prefix);
    return results;
  }

  /**
   * Discovers the primary Vessel & Anchor Watch instance (`driverId: 'vessel'`).
   */
  public discoverVessel(
    selfTree: Record<string, any> | null | undefined,
  ): DiscoveredSubsystemInstance {
    const safeTree = selfTree && typeof selfTree === 'object' ? selfTree : {};
    const vesselName =
      typeof safeTree.name === 'string' && safeTree.name.trim().length > 0
        ? safeTree.name.trim()
        : 'Signal K Vessel';
    const uuid =
      typeof safeTree.uuid === 'string'
        ? safeTree.uuid
        : typeof safeTree.mmsi === 'string'
          ? `mmsi:${safeTree.mmsi}`
          : 'self';

    const allLeaves = this.discoverAllLeafPaths(safeTree);
    const vesselPrefixes = [
      'navigation.',
      'environment.wind.',
      'environment.depth.',
      'environment.outside.',
      'environment.water.',
      'steering.autopilot.',
      'notifications.navigation.anchor',
    ];
    const vesselLeaves = allLeaves.filter((l) =>
      vesselPrefixes.some((p) => l.path.startsWith(p)),
    );
    const sources = Array.from(
      new Set(vesselLeaves.map((l) => l.$source).filter((s): s is string => Boolean(s))),
    );

    return {
      driverId: 'vessel',
      id: `vessel.${uuid}`,
      instanceKey: 'self',
      name: vesselName,
      category: 'vessel',
      basePath: '',
      availablePaths: vesselLeaves.map((l) => l.path),
      sources,
      supportsPut: true, // Anchor Watch drop/raise/maxRadius supports PUT / REST fallback
      supportsDim: false,
      presetMatchId: 'n2k_vessel_navigation_wind_depth',
    };
  }

  /**
   * Discovers all Electrical Banks (`driverId: 'electrical-bank'`):
   * batteries, solar MPPT controllers, chargers, inverters, alternators, and AC buses.
   */
  public discoverElectricalBanks(
    selfTree: Record<string, any> | null | undefined,
  ): DiscoveredSubsystemInstance[] {
    const results: DiscoveredSubsystemInstance[] = [];
    const electrical = selfTree?.electrical;
    if (!electrical || typeof electrical !== 'object') {
      return results;
    }

    const sections: Array<{
      key: string;
      category: string;
      labelPrefix: string;
      defaultPresetId: string;
    }> = [
      {
        key: 'batteries',
        category: 'battery',
        labelPrefix: 'Battery Bank',
        defaultPresetId: 'victron_smartshunt_house',
      },
      {
        key: 'solar',
        category: 'solar',
        labelPrefix: 'Solar MPPT',
        defaultPresetId: 'victron_smartsolar_mppt',
      },
      {
        key: 'chargers',
        category: 'charger',
        labelPrefix: 'Shore Charger',
        defaultPresetId: 'victron_multiplus_inverter_charger',
      },
      {
        key: 'inverters',
        category: 'inverter',
        labelPrefix: 'Inverter',
        defaultPresetId: 'victron_multiplus_inverter_charger',
      },
      {
        key: 'alternators',
        category: 'alternator',
        labelPrefix: 'Alternator',
        defaultPresetId: 'victron_bmv712_starter',
      },
      {
        key: 'ac',
        category: 'ac_bus',
        labelPrefix: 'AC Bus',
        defaultPresetId: 'victron_multiplus_inverter_charger',
      },
    ];

    for (const section of sections) {
      const groupObj = electrical[section.key];
      if (!groupObj || typeof groupObj !== 'object' || Array.isArray(groupObj)) {
        continue;
      }

      for (const [instanceKey, instanceNode] of Object.entries(groupObj)) {
        if (RESERVED_METADATA_KEYS.has(instanceKey)) {
          continue;
        }
        if (!instanceNode || typeof instanceNode !== 'object' || Array.isArray(instanceNode)) {
          continue;
        }

        const basePath = `electrical.${section.key}.${instanceKey}`;
        const leaves = this.discoverAllLeafPaths(instanceNode as Record<string, any>, basePath);
        if (leaves.length === 0) {
          continue;
        }

        const customName =
          typeof (instanceNode as any).name?.value === 'string'
            ? (instanceNode as any).name.value
            : typeof (instanceNode as any).meta?.displayName === 'string'
              ? (instanceNode as any).meta.displayName
              : formatDisplayName(instanceKey, section.labelPrefix);

        const sources = Array.from(
          new Set(leaves.map((l) => l.$source).filter((s): s is string => Boolean(s))),
        );
        const supportsPut = leaves.some((l) => l.writable);

        let presetMatchId = section.defaultPresetId;
        if (section.key === 'batteries' && instanceKey.toLowerCase().includes('starter')) {
          presetMatchId = 'victron_bmv712_starter';
        }

        results.push({
          driverId: 'electrical-bank',
          id: basePath,
          instanceKey,
          name: customName,
          category: section.category,
          basePath,
          availablePaths: leaves.map((l) => l.path),
          sources,
          supportsPut,
          supportsDim: false,
          presetMatchId,
        });
      }
    }

    return results;
  }

  /**
   * Discovers all Fluid Tank Monitors (`driverId: 'fluid-tank'`).
   */
  public discoverFluidTanks(
    selfTree: Record<string, any> | null | undefined,
  ): DiscoveredSubsystemInstance[] {
    const results: DiscoveredSubsystemInstance[] = [];
    const tanks = selfTree?.tanks;
    if (!tanks || typeof tanks !== 'object') {
      return results;
    }

    for (const tankType of FLUID_TANK_TYPES) {
      const typeGroup = tanks[tankType];
      if (!typeGroup || typeof typeGroup !== 'object' || Array.isArray(typeGroup)) {
        continue;
      }

      for (const [tankId, tankNode] of Object.entries(typeGroup)) {
        if (RESERVED_METADATA_KEYS.has(tankId)) {
          continue;
        }
        if (!tankNode || typeof tankNode !== 'object' || Array.isArray(tankNode)) {
          continue;
        }

        const basePath = `tanks.${tankType}.${tankId}`;
        const leaves = this.discoverAllLeafPaths(tankNode as Record<string, any>, basePath);
        if (leaves.length === 0) {
          continue;
        }

        const customName =
          typeof (tankNode as any).name?.value === 'string'
            ? (tankNode as any).name.value
            : typeof (tankNode as any).meta?.displayName === 'string'
              ? (tankNode as any).meta.displayName
              : `${formatDisplayName(tankType)} Tank (${tankId})`;

        const sources = Array.from(
          new Set(leaves.map((l) => l.$source).filter((s): s is string => Boolean(s))),
        );

        results.push({
          driverId: 'fluid-tank',
          id: basePath,
          instanceKey: `${tankType}.${tankId}`,
          name: customName,
          category: tankType,
          basePath,
          availablePaths: leaves.map((l) => l.path),
          sources,
          supportsPut: false,
          supportsDim: false,
          presetMatchId: 'n2k_fluid_tanks',
        });
      }
    }

    return results;
  }

  /**
   * Discovers all Digital Switches & Relays (`driverId: 'digital-switch'`),
   * handling both direct switches (`electrical.switches.<id>`) and banked switches
   * (`electrical.switches.bank.<bankId>.<switchId>`).
   */
  public discoverDigitalSwitches(
    selfTree: Record<string, any> | null | undefined,
  ): DiscoveredSubsystemInstance[] {
    const results: DiscoveredSubsystemInstance[] = [];
    const switches = selfTree?.electrical?.switches;
    if (!switches || typeof switches !== 'object' || Array.isArray(switches)) {
      return results;
    }

    const processSwitchInstance = (
      instanceKey: string,
      basePath: string,
      switchNode: Record<string, any>,
    ) => {
      const leaves = this.discoverAllLeafPaths(switchNode, basePath);
      if (leaves.length === 0) {
        return;
      }

      const customName =
        typeof switchNode.name?.value === 'string'
          ? switchNode.name.value
          : typeof switchNode.state?.meta?.displayName === 'string'
            ? switchNode.state.meta.displayName
            : typeof switchNode.meta?.displayName === 'string'
              ? switchNode.meta.displayName
              : formatDisplayName(instanceKey, 'Switch');

      const sources = Array.from(
        new Set(leaves.map((l) => l.$source).filter((s): s is string => Boolean(s))),
      );
      const supportsDim = leaves.some((l) => l.path.endsWith('.dimmingLevel'));

      let presetMatchId: string | undefined;
      if (instanceKey.toLowerCase().includes('venusrelay')) {
        presetMatchId = 'victron_gx_relays';
      } else if (
        instanceKey.toLowerCase().includes('heater') ||
        instanceKey.toLowerCase().includes('cabin')
      ) {
        presetMatchId = 'diesel_heater_autoterm_shelly';
      }

      results.push({
        driverId: 'digital-switch',
        id: basePath,
        instanceKey,
        name: customName,
        category: supportsDim ? 'dimmer_switch' : 'relay_switch',
        basePath,
        availablePaths: leaves.map((l) => l.path),
        sources,
        supportsPut: true,
        supportsDim,
        presetMatchId,
      });
    };

    for (const [key, node] of Object.entries(switches)) {
      if (RESERVED_METADATA_KEYS.has(key)) {
        continue;
      }
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        continue;
      }

      if (key === 'bank') {
        // Nested NMEA 2000 switch banks: electrical.switches.bank.<bankId>.<switchId>
        for (const [bankId, bankNode] of Object.entries(node as Record<string, any>)) {
          if (RESERVED_METADATA_KEYS.has(bankId)) continue;
          if (!bankNode || typeof bankNode !== 'object' || Array.isArray(bankNode)) continue;

          for (const [swId, swNode] of Object.entries(bankNode as Record<string, any>)) {
            if (RESERVED_METADATA_KEYS.has(swId)) continue;
            if (!swNode || typeof swNode !== 'object' || Array.isArray(swNode)) continue;

            const instanceKey = `bank.${bankId}.${swId}`;
            const basePath = `electrical.switches.bank.${bankId}.${swId}`;
            processSwitchInstance(instanceKey, basePath, swNode as Record<string, any>);
          }
        }
      } else {
        const basePath = `electrical.switches.${key}`;
        processSwitchInstance(key, basePath, node as Record<string, any>);
      }
    }

    return results;
  }

  /**
   * Discovers all Propulsion Engines (`driverId: 'propulsion'`, strictly read-only).
   */
  public discoverPropulsionEngines(
    selfTree: Record<string, any> | null | undefined,
  ): DiscoveredSubsystemInstance[] {
    const results: DiscoveredSubsystemInstance[] = [];
    const propulsion = selfTree?.propulsion;
    if (!propulsion || typeof propulsion !== 'object' || Array.isArray(propulsion)) {
      return results;
    }

    for (const [engineId, engineNode] of Object.entries(propulsion)) {
      if (RESERVED_METADATA_KEYS.has(engineId)) {
        continue;
      }
      if (!engineNode || typeof engineNode !== 'object' || Array.isArray(engineNode)) {
        continue;
      }

      const basePath = `propulsion.${engineId}`;
      const leaves = this.discoverAllLeafPaths(engineNode as Record<string, any>, basePath);
      if (leaves.length === 0) {
        continue;
      }

      const customName =
        typeof (engineNode as any).name?.value === 'string'
          ? (engineNode as any).name.value
          : typeof (engineNode as any).meta?.displayName === 'string'
            ? (engineNode as any).meta.displayName
            : `${formatDisplayName(engineId)} Engine`;

      const sources = Array.from(
        new Set(leaves.map((l) => l.$source).filter((s): s is string => Boolean(s))),
      );

      results.push({
        driverId: 'propulsion',
        id: basePath,
        instanceKey: engineId,
        name: customName,
        category: 'engine',
        basePath,
        availablePaths: leaves.map((l) => l.path),
        sources,
        supportsPut: false, // Propulsion is strictly read-only per marine safety boundary
        supportsDim: false,
        presetMatchId: 'n2k_engine_gateway',
      });
    }

    return results;
  }

  /**
   * Returns all static HardwarePresets defined for the system.
   */
  public getHardwarePresets(): HardwarePreset[] {
    return HARDWARE_PRESETS;
  }
}

export const pathDiscoveryService = new PathDiscoveryService();
export default PathDiscoveryService;
