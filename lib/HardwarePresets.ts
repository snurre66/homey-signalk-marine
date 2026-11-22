/**
 * Onboard Hardware Presets & Standard Signal K Path Templates (`PROJECT.md § 1.2 #6`).
 *
 * Covers all 6 onboard hardware families:
 *  1. Victron VE.Direct / Venus OS (`signalk-venus-plugin`: SmartShunt/BMV-712, SmartSolar MPPT, MultiPlus Inverter/Charger, GX Relays)
 *  2. NMEA 2000 / SeaTalkNG Raymarine / B&G / Garmin Instruments (Depth, Speed, Wind, GPS, Autopilot state, Anchor Watch)
 *  3. NMEA 2000 / SeaTalkNG Engine Gateway & Fluid Tank Senders
 *  4. 1-Wire / I2C / GPIO on OpenPlotter Raspberry Pi (DS18B20 temps, BME280 barometer/humidity, GPIO bilge float switch & hatch contact)
 *  5. Diesel Heater (Autoterm / Shelly 12V Relay / Victron Relay) & Cabin Dimmers
 *  6. RuuviTag BLE Environmental Sensors
 */

import { UnitCategory } from './UnitConverter';

export type HardwareFamilyId =
  | 'victron_energy'
  | 'nmea2000_instruments'
  | 'nmea2000_propulsion'
  | 'openplotter_1wire_i2c_gpio'
  | 'diesel_heater_relays'
  | 'ruuvitag_ble';

export type DriverTargetId =
  | 'vessel'
  | 'electrical-bank'
  | 'fluid-tank'
  | 'digital-switch'
  | 'propulsion'
  | 'custom-sensor';

export type PresetThrottleTier = 'fast' | 'medium' | 'slow';

export interface HardwarePathMapping {
  signalKPathTemplate: string;
  examplePath: string;
  homeyCapability: string;
  unitCategory: UnitCategory;
  throttleTier: PresetThrottleTier;
  writable: boolean;
  description: string;
}

export interface HardwarePreset {
  id: string;
  family: HardwareFamilyId;
  name: string;
  driverId: DriverTargetId;
  defaultSourcePattern?: string;
  instanceId?: string;
  energyConfig?: Record<string, unknown>;
  paths: HardwarePathMapping[];
}

export const INDOOR_ENVIRONMENT_ZONES = [
  'mainCabin',
  'saloon',
  'forwardCabin',
  'aftCabin',
  'galley',
  'engineRoom',
  'heads',
  'lazarette',
] as const;

export type IndoorEnvironmentZone = (typeof INDOOR_ENVIRONMENT_ZONES)[number];

export const FLUID_TANK_TYPES = [
  'freshWater',
  'fuel',
  'blackWater',
  'wasteWater',
  'liveWell',
  'lubrication',
  'ballast',
] as const;

export type FluidTankType = (typeof FLUID_TANK_TYPES)[number];

export const HARDWARE_PRESETS: HardwarePreset[] = [
  // ============================================================================
  // FAMILY 1: Victron VE.Direct / Venus OS (signalk-venus-plugin)
  // ============================================================================
  {
    id: 'victron_smartshunt_house',
    family: 'victron_energy',
    name: 'Victron SmartShunt / BMV-712 House Battery Bank',
    driverId: 'electrical-bank',
    defaultSourcePattern: 'venus.com.victronenergy.battery.*',
    instanceId: 'house',
    energyConfig: { batteries: ['INTERNAL'] },
    paths: [
      {
        signalKPathTemplate: 'electrical.batteries.{id}.voltage',
        examplePath: 'electrical.batteries.house.voltage',
        homeyCapability: 'measure_voltage',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'House battery terminal voltage (V)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.current',
        examplePath: 'electrical.batteries.house.current',
        homeyCapability: 'measure_current',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'House battery net charge/discharge current (A)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.power',
        examplePath: 'electrical.batteries.house.power',
        homeyCapability: 'measure_power',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'House battery DC power (W)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.capacity.stateOfCharge',
        examplePath: 'electrical.batteries.house.capacity.stateOfCharge',
        homeyCapability: 'measure_battery',
        unitCategory: 'ratio_to_percent',
        throttleTier: 'slow',
        writable: false,
        description: 'State of Charge (0..1 -> 0..100%)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.capacity.remaining',
        examplePath: 'electrical.batteries.house.capacity.remaining',
        homeyCapability: 'measure_remaining_ah',
        unitCategory: 'charge_c_to_ah',
        throttleTier: 'slow',
        writable: false,
        description: 'Remaining capacity (Coulombs -> Ah)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.capacity.timeRemaining',
        examplePath: 'electrical.batteries.house.capacity.timeRemaining',
        homeyCapability: 'measure_time_remaining',
        unitCategory: 'duration_s_to_min',
        throttleTier: 'slow',
        writable: false,
        description: 'Time-to-go at current discharge rate (s -> min)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.temperature',
        examplePath: 'electrical.batteries.house.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
        writable: false,
        description: 'Battery bank temperature (K -> °C)',
      },
    ],
  },
  {
    id: 'victron_bmv712_starter',
    family: 'victron_energy',
    name: 'Victron BMV-712 Starter / Bow Thruster Battery Bank',
    driverId: 'electrical-bank',
    defaultSourcePattern: 'venus.com.victronenergy.battery.*',
    instanceId: 'starter',
    energyConfig: { batteries: ['INTERNAL'] },
    paths: [
      {
        signalKPathTemplate: 'electrical.batteries.{id}.voltage',
        examplePath: 'electrical.batteries.starter.voltage',
        homeyCapability: 'measure_voltage',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'Starter battery terminal voltage (V)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.current',
        examplePath: 'electrical.batteries.starter.current',
        homeyCapability: 'measure_current',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'Starter battery current (A)',
      },
      {
        signalKPathTemplate: 'electrical.batteries.{id}.temperature',
        examplePath: 'electrical.batteries.starter.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
        writable: false,
        description: 'Starter battery temperature (K -> °C)',
      },
    ],
  },
  {
    id: 'victron_smartsolar_mppt',
    family: 'victron_energy',
    name: 'Victron SmartSolar MPPT Solar Charge Controller',
    driverId: 'electrical-bank',
    defaultSourcePattern: 'venus.com.victronenergy.solarcharger.*',
    instanceId: '0',
    paths: [
      {
        signalKPathTemplate: 'electrical.solar.{id}.voltage',
        examplePath: 'electrical.solar.0.voltage',
        homeyCapability: 'measure_voltage',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'Solar charger output voltage (V)',
      },
      {
        signalKPathTemplate: 'electrical.solar.{id}.current',
        examplePath: 'electrical.solar.0.current',
        homeyCapability: 'measure_current',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'Solar charger output current (A)',
      },
      {
        signalKPathTemplate: 'electrical.solar.{id}.panelPower',
        examplePath: 'electrical.solar.0.panelPower',
        homeyCapability: 'measure_power',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'PV solar array power (W)',
      },
      {
        signalKPathTemplate: 'electrical.solar.{id}.yieldToday',
        examplePath: 'electrical.solar.0.yieldToday',
        homeyCapability: 'meter_power',
        unitCategory: 'energy_j_to_kwh',
        throttleTier: 'slow',
        writable: false,
        description: 'Solar energy yield today (Joules -> kWh)',
      },
    ],
  },
  {
    id: 'victron_multiplus_inverter_charger',
    family: 'victron_energy',
    name: 'Victron MultiPlus / Quattro Inverter & Shore Charger',
    driverId: 'electrical-bank',
    defaultSourcePattern: 'venus.com.victronenergy.vebus.*',
    instanceId: '0',
    paths: [
      {
        signalKPathTemplate: 'electrical.chargers.{id}.voltage',
        examplePath: 'electrical.chargers.0.voltage',
        homeyCapability: 'measure_voltage',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'Charger DC output voltage (V)',
      },
      {
        signalKPathTemplate: 'electrical.chargers.{id}.current',
        examplePath: 'electrical.chargers.0.current',
        homeyCapability: 'measure_current',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'Charger DC output current (A)',
      },
      {
        signalKPathTemplate: 'electrical.chargers.{id}.mode',
        examplePath: 'electrical.chargers.0.mode',
        homeyCapability: 'charger_inverter_mode',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: true,
        description: 'Writable Charger operating mode (on, charger_only, inverter_only, eco, off)',
      },
      {
        signalKPathTemplate: 'electrical.inverters.{id}.inverterMode',
        examplePath: 'electrical.inverters.0.inverterMode',
        homeyCapability: 'charger_inverter_mode',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: true,
        description: 'Writable Inverter operating mode for battery load shedding',
      },
      {
        signalKPathTemplate: 'electrical.ac.{id}.phaseA.realPower',
        examplePath: 'electrical.ac.0.phaseA.realPower',
        homeyCapability: 'measure_power',
        unitCategory: 'passthrough',
        throttleTier: 'slow',
        writable: false,
        description: 'AC Shore / Inverter real power (W)',
      },
    ],
  },
  {
    id: 'victron_gx_relays',
    family: 'victron_energy',
    name: 'Victron Cerbo GX / Venus OS Digital Relays',
    driverId: 'digital-switch',
    defaultSourcePattern: 'venus.com.victronenergy.system.*',
    instanceId: 'venusRelay0',
    paths: [
      {
        signalKPathTemplate: 'electrical.switches.{id}.state',
        examplePath: 'electrical.switches.venusRelay0.state',
        homeyCapability: 'onoff',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: true,
        description: 'Victron GX Relay 0 switch state',
      },
      {
        signalKPathTemplate: 'electrical.switches.venusRelay1.state',
        examplePath: 'electrical.switches.venusRelay1.state',
        homeyCapability: 'onoff',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: true,
        description: 'Victron GX Relay 1 switch state',
      },
    ],
  },

  // ============================================================================
  // FAMILY 2: NMEA 2000 / SeaTalkNG Raymarine / B&G / Garmin Instruments
  // ============================================================================
  {
    id: 'n2k_vessel_navigation_wind_depth',
    family: 'nmea2000_instruments',
    name: 'NMEA 2000 / SeaTalkNG Sailing Instruments & Anchor Watch',
    driverId: 'vessel',
    defaultSourcePattern: 'n2k-on-ve.can-device.*',
    instanceId: 'self',
    paths: [
      {
        signalKPathTemplate: 'navigation.speedOverGround',
        examplePath: 'navigation.speedOverGround',
        homeyCapability: 'measure_sog',
        unitCategory: 'speed_ms_to_kn',
        throttleTier: 'medium',
        writable: false,
        description: 'GPS Speed Over Ground (m/s -> kn)',
      },
      {
        signalKPathTemplate: 'navigation.speedThroughWater',
        examplePath: 'navigation.speedThroughWater',
        homeyCapability: 'measure_stw',
        unitCategory: 'speed_ms_to_kn',
        throttleTier: 'medium',
        writable: false,
        description: 'Paddlewheel Speed Through Water (m/s -> kn)',
      },
      {
        signalKPathTemplate: 'navigation.courseOverGroundTrue',
        examplePath: 'navigation.courseOverGroundTrue',
        homeyCapability: 'measure_cog',
        unitCategory: 'angle_rad_to_deg_unsigned',
        throttleTier: 'medium',
        writable: false,
        description: 'Course Over Ground True (rad -> 0..360°)',
      },
      {
        signalKPathTemplate: 'navigation.headingTrue',
        examplePath: 'navigation.headingTrue',
        homeyCapability: 'measure_heading',
        unitCategory: 'angle_rad_to_deg_unsigned',
        throttleTier: 'medium',
        writable: false,
        description: 'Vessel Heading True (rad -> 0..360°)',
      },
      {
        signalKPathTemplate: 'environment.depth.belowTransducer',
        examplePath: 'environment.depth.belowTransducer',
        homeyCapability: 'measure_depth',
        unitCategory: 'distance_m',
        throttleTier: 'medium',
        writable: false,
        description: 'Water Depth Below Transducer (m)',
      },
      {
        signalKPathTemplate: 'environment.wind.speedApparent',
        examplePath: 'environment.wind.speedApparent',
        homeyCapability: 'measure_wind_strength',
        unitCategory: 'speed_ms_to_kn',
        throttleTier: 'medium',
        writable: false,
        description: 'Apparent Wind Speed (m/s -> kn/kmh)',
      },
      {
        signalKPathTemplate: 'environment.wind.angleApparent',
        examplePath: 'environment.wind.angleApparent',
        homeyCapability: 'measure_wind_angle',
        unitCategory: 'angle_rad_to_deg_signed',
        throttleTier: 'medium',
        writable: false,
        description: 'Apparent Wind Angle (rad -> -180..+180°)',
      },
      {
        signalKPathTemplate: 'environment.outside.pressure',
        examplePath: 'environment.outside.pressure',
        homeyCapability: 'measure_pressure',
        unitCategory: 'pressure_pa_to_hpa',
        throttleTier: 'slow',
        writable: false,
        description: 'Barometric Pressure (Pa -> hPa)',
      },
      {
        signalKPathTemplate: 'environment.water.temperature',
        examplePath: 'environment.water.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
        writable: false,
        description: 'Sea Water Temperature (K -> °C)',
      },
      {
        signalKPathTemplate: 'navigation.state',
        examplePath: 'navigation.state',
        homeyCapability: 'navigation_state',
        unitCategory: 'passthrough',
        throttleTier: 'medium',
        writable: false,
        description: 'Vessel Navigation State (moored, anchored, motoring, sailing)',
      },
      {
        signalKPathTemplate: 'steering.autopilot.state',
        examplePath: 'steering.autopilot.state',
        homeyCapability: 'autopilot_state',
        unitCategory: 'passthrough',
        throttleTier: 'medium',
        writable: false,
        description: 'Read-Only Autopilot Mode (standby, auto, wind, route)',
      },
      {
        signalKPathTemplate: 'steering.autopilot.target.headingTrue',
        examplePath: 'steering.autopilot.target.headingTrue',
        homeyCapability: 'measure_heading',
        unitCategory: 'angle_rad_to_deg_unsigned',
        throttleTier: 'medium',
        writable: false,
        description: 'Read-Only Autopilot Target Heading (rad -> 0..360°)',
      },
      {
        signalKPathTemplate: 'navigation.anchor.currentRadius',
        examplePath: 'navigation.anchor.currentRadius',
        homeyCapability: 'measure_anchor_distance',
        unitCategory: 'distance_m',
        throttleTier: 'fast',
        writable: false,
        description: 'Current Distance from Anchor Drop Position (m)',
      },
      {
        signalKPathTemplate: 'navigation.anchor.maxRadius',
        examplePath: 'navigation.anchor.maxRadius',
        homeyCapability: 'measure_anchor_radius',
        unitCategory: 'distance_m',
        throttleTier: 'fast',
        writable: true,
        description: 'Writable Anchor Watch Max Swing Radius (m)',
      },
      {
        signalKPathTemplate: 'navigation.anchor.position',
        examplePath: 'navigation.anchor.position',
        homeyCapability: 'onoff',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: true,
        description: 'Writable Anchor Drop / Raise Position Actuation',
      },
    ],
  },

  // ============================================================================
  // FAMILY 3: NMEA 2000 / SeaTalkNG Engine Gateway & Fluid Tank Senders
  // ============================================================================
  {
    id: 'n2k_engine_gateway',
    family: 'nmea2000_propulsion',
    name: 'NMEA 2000 / SeaTalkNG Propulsion Engine Gateway (Read-Only)',
    driverId: 'propulsion',
    defaultSourcePattern: 'n2k-on-ve.can-device.*',
    instanceId: 'port',
    paths: [
      {
        signalKPathTemplate: 'propulsion.{id}.revolutions',
        examplePath: 'propulsion.port.revolutions',
        homeyCapability: 'measure_engine_rpm',
        unitCategory: 'frequency_hz_to_rpm',
        throttleTier: 'medium',
        writable: false,
        description: 'Engine Speed (Hz -> RPM, strictly read-only)',
      },
      {
        signalKPathTemplate: 'propulsion.{id}.temperature',
        examplePath: 'propulsion.port.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'medium',
        writable: false,
        description: 'Engine Coolant / Block Temperature (K -> °C, strictly read-only)',
      },
      {
        signalKPathTemplate: 'propulsion.{id}.oilPressure',
        examplePath: 'propulsion.port.oilPressure',
        homeyCapability: 'measure_oil_pressure',
        unitCategory: 'pressure_pa_to_bar',
        throttleTier: 'medium',
        writable: false,
        description: 'Engine Oil Pressure (Pa -> bar, strictly read-only)',
      },
      {
        signalKPathTemplate: 'propulsion.{id}.runTime',
        examplePath: 'propulsion.port.runTime',
        homeyCapability: 'measure_engine_hours',
        unitCategory: 'duration_s_to_h',
        throttleTier: 'slow',
        writable: false,
        description: 'Total Engine Operating Hours (s -> h, strictly read-only)',
      },
      {
        signalKPathTemplate: 'propulsion.{id}.fuel.rate',
        examplePath: 'propulsion.port.fuel.rate',
        homeyCapability: 'measure_fuel_rate',
        unitCategory: 'flow_m3s_to_lh',
        throttleTier: 'medium',
        writable: false,
        description: 'Engine Fuel Consumption Rate (m³/s -> L/h, strictly read-only)',
      },
    ],
  },
  {
    id: 'n2k_fluid_tanks',
    family: 'nmea2000_propulsion',
    name: 'NMEA 2000 / Resistive Fluid Tank Senders (Fresh Water, Fuel, Black Water)',
    driverId: 'fluid-tank',
    defaultSourcePattern: 'n2k-on-ve.can-device.*',
    instanceId: 'freshWater.0',
    paths: [
      {
        signalKPathTemplate: 'tanks.{type}.{id}.currentLevel',
        examplePath: 'tanks.freshWater.0.currentLevel',
        homeyCapability: 'measure_tank_level',
        unitCategory: 'ratio_to_percent',
        throttleTier: 'slow',
        writable: false,
        description: 'Fluid Tank Fill Percentage (0..1 -> 0..100%)',
      },
      {
        signalKPathTemplate: 'tanks.{type}.{id}.currentVolume',
        examplePath: 'tanks.freshWater.0.currentVolume',
        homeyCapability: 'measure_tank_volume',
        unitCategory: 'volume_m3_to_l',
        throttleTier: 'slow',
        writable: false,
        description: 'Fluid Tank Current Volume (m³ -> L)',
      },
      {
        signalKPathTemplate: 'tanks.{type}.{id}.capacity',
        examplePath: 'tanks.freshWater.0.capacity',
        homeyCapability: 'measure_tank_volume',
        unitCategory: 'volume_m3_to_l',
        throttleTier: 'slow',
        writable: false,
        description: 'Fluid Tank Total Capacity (m³ -> L)',
      },
    ],
  },

  // ============================================================================
  // FAMILY 4: 1-Wire / I2C / GPIO on OpenPlotter Raspberry Pi
  // ============================================================================
  {
    id: 'openplotter_1wire_i2c_gpio_sensors',
    family: 'openplotter_1wire_i2c_gpio',
    name: 'OpenPlotter 1-Wire DS18B20, I2C BME280 & GPIO Bilge Float Switch',
    driverId: 'custom-sensor',
    defaultSourcePattern: 'openplotter.*',
    instanceId: 'engineRoom',
    paths: [
      {
        signalKPathTemplate: 'environment.inside.engineRoom.temperature',
        examplePath: 'environment.inside.engineRoom.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
        writable: false,
        description: '1-Wire DS18B20 Engine Room Temperature (K -> °C)',
      },
      {
        signalKPathTemplate: 'environment.inside.saloon.temperature',
        examplePath: 'environment.inside.saloon.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
        writable: false,
        description: '1-Wire DS18B20 Saloon Cabin Temperature (K -> °C)',
      },
      {
        signalKPathTemplate: 'environment.outside.pressure',
        examplePath: 'environment.outside.pressure',
        homeyCapability: 'measure_pressure',
        unitCategory: 'pressure_pa_to_hpa',
        throttleTier: 'slow',
        writable: false,
        description: 'I2C BME280 Barometric Pressure (Pa -> hPa)',
      },
      {
        signalKPathTemplate: 'notifications.bilge.main',
        examplePath: 'notifications.bilge.main',
        homeyCapability: 'alarm_water',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: false,
        description: 'GPIO Bilge High-Water Float Switch Notification Alarm',
      },
      {
        signalKPathTemplate: 'electrical.switches.bilgePump.state',
        examplePath: 'electrical.switches.bilgePump.state',
        homeyCapability: 'onoff',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: true,
        description: 'GPIO / Relay Bilge Pump Manual Override Switch',
      },
    ],
  },

  // ============================================================================
  // FAMILY 5: Diesel Heater (Autoterm / Shelly 12V / Victron Relay)
  // ============================================================================
  {
    id: 'diesel_heater_autoterm_shelly',
    family: 'diesel_heater_relays',
    name: 'Autoterm / Shelly 12V Diesel Cabin Heater & Dimmer Relays',
    driverId: 'digital-switch',
    defaultSourcePattern: 'shelly.*',
    instanceId: 'dieselHeater',
    paths: [
      {
        signalKPathTemplate: 'electrical.switches.dieselHeater.state',
        examplePath: 'electrical.switches.dieselHeater.state',
        homeyCapability: 'onoff',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: true,
        description: '12V Diesel Cabin Heater Relay On/Off Control',
      },
      {
        signalKPathTemplate: 'electrical.switches.cabinLights.state',
        examplePath: 'electrical.switches.cabinLights.state',
        homeyCapability: 'onoff',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: true,
        description: '12V Cabin Lighting Relay On/Off Control',
      },
      {
        signalKPathTemplate: 'electrical.switches.cabinLights.dimmingLevel',
        examplePath: 'electrical.switches.cabinLights.dimmingLevel',
        homeyCapability: 'dim',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        writable: true,
        description: '12V Cabin Lighting PWM Dimming Level (0..1)',
      },
      {
        signalKPathTemplate: 'environment.inside.aftCabin.temperature',
        examplePath: 'environment.inside.aftCabin.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
        writable: false,
        description: 'Diesel Heater Aft Cabin Duct / Room Temperature (K -> °C)',
      },
    ],
  },

  // ============================================================================
  // FAMILY 6: RuuviTag BLE Environmental Sensors
  // ============================================================================
  {
    id: 'ruuvitag_ble_cabin_sensors',
    family: 'ruuvitag_ble',
    name: 'RuuviTag BLE Cabin Temperature, Humidity & Pressure Sensors',
    driverId: 'custom-sensor',
    defaultSourcePattern: 'ruuvitag.*',
    instanceId: 'forwardCabin',
    paths: [
      {
        signalKPathTemplate: 'environment.inside.{zone}.temperature',
        examplePath: 'environment.inside.forwardCabin.temperature',
        homeyCapability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
        writable: false,
        description: 'RuuviTag BLE Cabin Temperature (K -> °C)',
      },
      {
        signalKPathTemplate: 'environment.inside.{zone}.relativeHumidity',
        examplePath: 'environment.inside.forwardCabin.relativeHumidity',
        homeyCapability: 'measure_humidity',
        unitCategory: 'ratio_to_percent',
        throttleTier: 'slow',
        writable: false,
        description: 'RuuviTag BLE Cabin Relative Humidity (0..1 -> 0..100%)',
      },
      {
        signalKPathTemplate: 'environment.inside.{zone}.pressure',
        examplePath: 'environment.inside.forwardCabin.pressure',
        homeyCapability: 'measure_pressure',
        unitCategory: 'pressure_pa_to_hpa',
        throttleTier: 'slow',
        writable: false,
        description: 'RuuviTag BLE Cabin Atmospheric Pressure (Pa -> hPa)',
      },
    ],
  },
];

/**
 * Helper functions to query hardware presets by family, driver, or ID.
 */
export function getHardwarePresetsByFamily(family: HardwareFamilyId): HardwarePreset[] {
  return HARDWARE_PRESETS.filter((preset) => preset.family === family);
}

export function getHardwarePresetsByDriver(driverId: DriverTargetId): HardwarePreset[] {
  return HARDWARE_PRESETS.filter((preset) => preset.driverId === driverId);
}

export function getHardwarePresetById(id: string): HardwarePreset | undefined {
  return HARDWARE_PRESETS.find((preset) => preset.id === id);
}
