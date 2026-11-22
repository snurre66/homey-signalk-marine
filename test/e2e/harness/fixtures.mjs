/**
 * Comprehensive Signal K v1 vessel data tree (`vessels.self`) with strict SI base units,
 * `$source` + `values` multi-source entries, and `meta` blocks covering all 6 hardware families
 * from `ORIGINAL_REQUEST.md` and all 6 Homey drivers from `PROJECT.md`.
 */

export const VESSEL_UUID = 'c0d79334-4e25-4245-8892-54e8ccc8021d';
export const VESSEL_SELF_URN = `vessels.urn:mrn:signalk:uuid:${VESSEL_UUID}`;
export const DEFAULT_TIMESTAMP = '2026-11-22T00:00:00.000Z';

export const SERVER_INFO = {
  id: 'signalk-server-node',
  version: '2.8.2',
};

/**
 * Helper to construct a Signal K leaf value object with `$source`, `timestamp`, `values`, and `meta`.
 */
export function makeLeaf(value, $source, meta = {}, extraSources = null, timestamp = DEFAULT_TIMESTAMP) {
  const values = {
    [$source]: {
      value,
      timestamp,
    },
  };
  if (extraSources && typeof extraSources === 'object') {
    for (const [srcKey, srcVal] of Object.entries(extraSources)) {
      values[srcKey] = {
        value: srcVal,
        timestamp,
      };
    }
  }
  return {
    value,
    $source,
    timestamp,
    values,
    meta: {
      ...meta,
    },
  };
}

/**
 * Creates a fresh deep-cloned default Signal K v1 `vessels.self` object containing all 6 hardware families:
 * 1. Victron VE.Direct / Venus OS (SmartShunt/BMV batteries, SmartSolar MPPT, MultiPlus Charger/Inverter, GX Relays)
 * 2. NMEA 2000 / SeaTalkNG (Navigation, Wind, Depth, Read-Only Autopilot, Port/Starboard/Main Propulsion)
 * 3. OpenPlotter 1-Wire / I2C / GPIO (Engine Room & Saloon DS18B20 temps, BME280 baro/humidity, GPIO bilge float & pump)
 * 4. Diesel Heater (Autoterm / Shelly 12V relay) & RuuviTag BLE sensors
 * 5. Fluid Tanks (freshWater, fuel, blackWater, wasteWater, liveWell, lubrication, ballast)
 * 6. Notifications tree (anchor, bilge, security, propulsion, electrical)
 */
export function createDefaultVesselTree() {
  return {
    name: 'S/Y Northern Star',
    uuid: `urn:mrn:signalk:uuid:${VESSEL_UUID}`,
    mmsi: '265555123',

    // =========================================================================
    // Family 1: Victron VE.Direct / Venus OS & Digital Switches
    // =========================================================================
    electrical: {
      batteries: {
        house: {
          name: 'House LiFePO4 Bank (Victron SmartShunt 500A)',
          location: 'Under Saloon Settee',
          voltage: makeLeaf(13.25, 'venus.com.victronenergy.battery.288', {
            units: 'V',
            description: 'DC Bus Voltage',
            displayName: 'House Battery Voltage',
          }),
          current: makeLeaf(-4.8, 'venus.com.victronenergy.battery.288', {
            units: 'A',
            description: 'Battery Current (+charge / -discharge)',
            displayName: 'House Battery Current',
          }),
          power: makeLeaf(-63.6, 'venus.com.victronenergy.battery.288', {
            units: 'W',
            description: 'Battery DC Power',
            displayName: 'House Battery Power',
          }),
          temperature: makeLeaf(295.65, 'venus.com.victronenergy.battery.288', {
            units: 'K',
            description: 'Battery Temperature (22.5 °C)',
            displayName: 'House Battery Temperature',
          }),
          capacity: {
            stateOfCharge: makeLeaf(0.85, 'venus.com.victronenergy.battery.288', {
              units: 'ratio',
              description: 'State of Charge (0..1 -> 85%)',
              displayName: 'House Battery SOC',
            }),
            remaining: makeLeaf(1224000, 'venus.com.victronenergy.battery.288', {
              units: 'C',
              description: 'Remaining Capacity in Coulombs (340 Ah)',
              displayName: 'House Remaining Capacity',
            }),
            nominal: makeLeaf(1440000, 'venus.com.victronenergy.battery.288', {
              units: 'C',
              description: 'Nominal Capacity in Coulombs (400 Ah)',
              displayName: 'House Nominal Capacity',
            }),
            dischargeSinceFull: makeLeaf(216000, 'venus.com.victronenergy.battery.288', {
              units: 'C',
              description: 'Consumed Coulombs Since Full (60 Ah)',
              displayName: 'House Consumed Capacity',
            }),
            timeRemaining: makeLeaf(255000, 'venus.com.victronenergy.battery.288', {
              units: 's',
              description: 'Time Remaining at Current Discharge Rate',
              displayName: 'House Time Remaining',
            }),
          },
          lifetimeDischarge: makeLeaf(180000000, 'venus.com.victronenergy.battery.288', {
            units: 'J',
            description: 'Cumulative Lifetime Energy Discharged (50 kWh)',
            displayName: 'House Lifetime Discharge',
          }),
        },
        starter: {
          name: 'Engine Starter Battery (Victron BMV-712 Aux)',
          location: 'Engine Room',
          voltage: makeLeaf(12.85, 'venus.com.victronenergy.battery.289', {
            units: 'V',
            displayName: 'Starter Battery Voltage',
          }),
          current: makeLeaf(0.0, 'venus.com.victronenergy.battery.289', {
            units: 'A',
            displayName: 'Starter Battery Current',
          }),
          power: makeLeaf(0.0, 'venus.com.victronenergy.battery.289', {
            units: 'W',
            displayName: 'Starter Battery Power',
          }),
          temperature: makeLeaf(296.15, 'venus.com.victronenergy.battery.289', {
            units: 'K',
            displayName: 'Starter Battery Temperature',
          }),
          capacity: {
            stateOfCharge: makeLeaf(0.98, 'venus.com.victronenergy.battery.289', {
              units: 'ratio',
              displayName: 'Starter Battery SOC',
            }),
            remaining: makeLeaf(352800, 'venus.com.victronenergy.battery.289', {
              units: 'C',
              displayName: 'Starter Remaining Capacity (98 Ah)',
            }),
            nominal: makeLeaf(360000, 'venus.com.victronenergy.battery.289', {
              units: 'C',
              displayName: 'Starter Nominal Capacity (100 Ah)',
            }),
          },
        },
        bowThruster: {
          name: 'Bow Thruster AGM Bank',
          location: 'Forward Locker',
          voltage: makeLeaf(12.75, 'venus.com.victronenergy.battery.290', {
            units: 'V',
            displayName: 'Bow Thruster Voltage',
          }),
          current: makeLeaf(0.0, 'venus.com.victronenergy.battery.290', {
            units: 'A',
            displayName: 'Bow Thruster Current',
          }),
          power: makeLeaf(0.0, 'venus.com.victronenergy.battery.290', {
            units: 'W',
            displayName: 'Bow Thruster Power',
          }),
          temperature: makeLeaf(294.15, 'venus.com.victronenergy.battery.290', {
            units: 'K',
            displayName: 'Bow Thruster Temperature',
          }),
          capacity: {
            stateOfCharge: makeLeaf(0.95, 'venus.com.victronenergy.battery.290', {
              units: 'ratio',
              displayName: 'Bow Thruster SOC',
            }),
            remaining: makeLeaf(307800, 'venus.com.victronenergy.battery.290', {
              units: 'C',
              displayName: 'Bow Thruster Remaining Capacity (85.5 Ah)',
            }),
            nominal: makeLeaf(324000, 'venus.com.victronenergy.battery.290', {
              units: 'C',
              displayName: 'Bow Thruster Nominal Capacity (90 Ah)',
            }),
          },
        },
      },

      solar: {
        0: {
          name: 'Victron SmartSolar MPPT 100/30 Port Arch',
          panelVoltage: makeLeaf(36.4, 'venus.com.victronenergy.solarcharger.291', {
            units: 'V',
            displayName: 'Solar 0 PV Voltage',
          }),
          panelPower: makeLeaf(215.0, 'venus.com.victronenergy.solarcharger.291', {
            units: 'W',
            displayName: 'Solar 0 PV Power',
          }),
          voltage: makeLeaf(13.35, 'venus.com.victronenergy.solarcharger.291', {
            units: 'V',
            displayName: 'Solar 0 Charge Voltage',
          }),
          current: makeLeaf(16.1, 'venus.com.victronenergy.solarcharger.291', {
            units: 'A',
            displayName: 'Solar 0 Charge Current',
          }),
          chargingMode: makeLeaf('bulk', 'venus.com.victronenergy.solarcharger.291', {
            displayName: 'Solar 0 Controller Mode',
          }),
          yieldToday: makeLeaf(3060000, 'venus.com.victronenergy.solarcharger.291', {
            units: 'J',
            description: 'Yield Today in Joules (0.85 kWh)',
            displayName: 'Solar 0 Yield Today',
          }),
        },
        1: {
          name: 'Victron SmartSolar MPPT 75/15 Coachroof',
          panelVoltage: makeLeaf(28.2, 'venus.com.victronenergy.solarcharger.292', {
            units: 'V',
            displayName: 'Solar 1 PV Voltage',
          }),
          panelPower: makeLeaf(85.0, 'venus.com.victronenergy.solarcharger.292', {
            units: 'W',
            displayName: 'Solar 1 PV Power',
          }),
          voltage: makeLeaf(13.32, 'venus.com.victronenergy.solarcharger.292', {
            units: 'V',
            displayName: 'Solar 1 Charge Voltage',
          }),
          current: makeLeaf(6.38, 'venus.com.victronenergy.solarcharger.292', {
            units: 'A',
            displayName: 'Solar 1 Charge Current',
          }),
          chargingMode: makeLeaf('absorption', 'venus.com.victronenergy.solarcharger.292', {
            displayName: 'Solar 1 Controller Mode',
          }),
          yieldToday: makeLeaf(1440000, 'venus.com.victronenergy.solarcharger.292', {
            units: 'J',
            description: 'Yield Today in Joules (0.40 kWh)',
            displayName: 'Solar 1 Yield Today',
          }),
        },
      },

      chargers: {
        0: {
          name: 'Victron MultiPlus 12/3000/120 Charger',
          state: makeLeaf('float', 'venus.com.victronenergy.vebus.276', {
            displayName: 'MultiPlus Charger State',
          }),
          mode: makeLeaf('on', 'venus.com.victronenergy.vebus.276', {
            displayName: 'MultiPlus Charger Mode',
          }),
          voltage: makeLeaf(13.8, 'venus.com.victronenergy.vebus.276', {
            units: 'V',
            displayName: 'MultiPlus Charger Output Voltage',
          }),
          current: makeLeaf(15.0, 'venus.com.victronenergy.vebus.276', {
            units: 'A',
            displayName: 'MultiPlus Charger Output Current',
          }),
          currentLimit: makeLeaf(16.0, 'venus.com.victronenergy.vebus.276', {
            units: 'A',
            displayName: 'Shore Input Current Limit',
          }),
        },
      },

      inverters: {
        0: {
          name: 'Victron MultiPlus 12/3000/120 Inverter',
          state: makeLeaf('inverting', 'venus.com.victronenergy.vebus.276', {
            displayName: 'MultiPlus Inverter State',
          }),
          inverterMode: makeLeaf('on', 'venus.com.victronenergy.vebus.276', {
            displayName: 'MultiPlus Inverter Mode',
          }),
          dc: {
            voltage: makeLeaf(13.25, 'venus.com.victronenergy.vebus.276', {
              units: 'V',
              displayName: 'Inverter DC Voltage',
            }),
            current: makeLeaf(-18.5, 'venus.com.victronenergy.vebus.276', {
              units: 'A',
              displayName: 'Inverter DC Current',
            }),
          },
          ac: {
            voltage: makeLeaf(230.0, 'venus.com.victronenergy.vebus.276', {
              units: 'V',
              displayName: 'Inverter AC Voltage',
            }),
            current: makeLeaf(1.05, 'venus.com.victronenergy.vebus.276', {
              units: 'A',
              displayName: 'Inverter AC Current',
            }),
            power: makeLeaf(241.5, 'venus.com.victronenergy.vebus.276', {
              units: 'W',
              displayName: 'Inverter AC Load Power',
            }),
            frequency: makeLeaf(50.0, 'venus.com.victronenergy.vebus.276', {
              units: 'Hz',
              displayName: 'Inverter AC Frequency',
            }),
          },
        },
      },

      ac: {
        0: {
          phaseA: {
            voltage: makeLeaf(230.2, 'venus.com.victronenergy.vebus.276', {
              units: 'V',
              displayName: 'Shore Power AC Voltage',
            }),
            current: makeLeaf(5.4, 'venus.com.victronenergy.vebus.276', {
              units: 'A',
              displayName: 'Shore Power AC Current',
            }),
            realPower: makeLeaf(1243.0, 'venus.com.victronenergy.vebus.276', {
              units: 'W',
              displayName: 'Shore Power Real Power',
            }),
            frequency: makeLeaf(50.0, 'venus.com.victronenergy.vebus.276', {
              units: 'Hz',
              displayName: 'Shore Power Frequency',
            }),
            connected: makeLeaf(true, 'venus.com.victronenergy.vebus.276', {
              displayName: 'Shore Power Connected',
            }),
          },
        },
      },

      alternators: {
        0: {
          name: 'Balmar 100A Engine Alternator',
          voltage: makeLeaf(14.1, 'n2k.actisense.127508', {
            units: 'V',
            displayName: 'Alternator Voltage',
          }),
          current: makeLeaf(45.0, 'n2k.actisense.127508', {
            units: 'A',
            displayName: 'Alternator Current',
          }),
          revolutions: makeLeaf(50.0, 'n2k.actisense.127508', {
            units: 'Hz',
            displayName: 'Alternator Speed (3000 RPM)',
          }),
          temperature: makeLeaf(338.15, 'n2k.actisense.127508', {
            units: 'K',
            displayName: 'Alternator Temperature (65.0 °C)',
          }),
        },
      },

      switches: {
        venusRelay0: {
          name: 'Victron GX Relay 1 (Water Heater)',
          state: makeLeaf(true, 'venus.com.victronenergy.system.relay0', {
            displayName: 'Victron GX Relay 1 (Water Heater)',
          }),
          meta: { displayName: 'Victron GX Relay 1 (Water Heater)' },
        },
        venusRelay1: {
          name: 'Victron GX Relay 2 (Fridge Compressor)',
          state: makeLeaf(false, 'venus.com.victronenergy.system.relay1', {
            displayName: 'Victron GX Relay 2 (Fridge Compressor)',
          }),
          meta: { displayName: 'Victron GX Relay 2 (Fridge Compressor)' },
        },
        waterHeater: {
          name: 'Isotherm 230V/12V Water Heater Boiler',
          state: makeLeaf(true, 'venus.com.victronenergy.system.relay0', {
            displayName: 'Water Heater Boiler Relay',
          }),
          meta: { displayName: 'Water Heater Boiler Relay' },
        },
        cockpitFridge: {
          name: 'Cockpit 12V Fridge Compressor',
          state: makeLeaf(true, 'venus.com.victronenergy.system.relay1', {
            displayName: 'Cockpit Fridge Relay',
          }),
          meta: { displayName: 'Cockpit Fridge Relay' },
        },
        anchorLight: {
          name: 'Masthead Anchor Light',
          state: makeLeaf(true, 'n2k.empirbus.switch1', {
            displayName: 'Masthead Anchor Light',
          }),
          meta: { displayName: 'Masthead Anchor Light' },
        },
        cabinRedAlarmLight: {
          name: 'Cabin Red Night Alarm Light',
          state: makeLeaf(false, 'n2k.empirbus.switch2', {
            displayName: 'Cabin Red Night Alarm Light',
          }),
          meta: { displayName: 'Cabin Red Night Alarm Light' },
        },
        deckLight: {
          name: 'Foredeck Flood Light',
          state: makeLeaf(false, 'n2k.empirbus.switch3', {
            displayName: 'Foredeck Flood Light',
          }),
          meta: { displayName: 'Foredeck Flood Light' },
        },
        navLights: {
          name: 'Navigation Lights',
          state: makeLeaf(false, 'n2k.empirbus.switch4', {
            displayName: 'Navigation Lights',
          }),
          meta: { displayName: 'Navigation Lights' },
        },
        cabinLights: {
          name: 'Saloon Cabin Dimmable Lights',
          state: makeLeaf(true, 'n2k.empirbus.dimmer1', {
            displayName: 'Saloon Cabin Dimmable Lights',
          }),
          dimmingLevel: makeLeaf(0.75, 'n2k.empirbus.dimmer1', {
            units: 'ratio',
            displayName: 'Saloon Cabin Dimming Level',
          }),
          meta: { displayName: 'Saloon Cabin Dimmable Lights' },
        },
        saloonDimmer: {
          name: 'Saloon Overhead LED Dimmer',
          state: makeLeaf(true, 'n2k.empirbus.dimmer2', {
            displayName: 'Saloon Overhead LED Dimmer',
          }),
          dimmingLevel: makeLeaf(0.8, 'n2k.empirbus.dimmer2', {
            units: 'ratio',
            displayName: 'Saloon Overhead Dimming Level',
          }),
          meta: { displayName: 'Saloon Overhead LED Dimmer' },
        },
        waterPump: {
          name: 'Fresh Water Pressure Pump',
          state: makeLeaf(true, 'n2k.empirbus.switch5', {
            displayName: 'Fresh Water Pressure Pump',
          }),
          meta: { displayName: 'Fresh Water Pressure Pump' },
        },
        freshWaterPump: {
          name: 'Fresh Water Pressure Pump',
          state: makeLeaf(true, 'n2k.empirbus.switch5', {
            displayName: 'Fresh Water Pressure Pump',
          }),
          meta: { displayName: 'Fresh Water Pressure Pump' },
        },
        bilgePump: {
          name: 'Main Rule 2000 Bilge Pump',
          state: makeLeaf(false, 'openplotter.gpio.pin27', {
            displayName: 'Main Bilge Pump Relay',
          }),
          meta: { displayName: 'Main Bilge Pump Relay' },
        },
        dieselHeater: {
          name: 'Autoterm 4D / Shelly 12V Diesel Heater Relay',
          state: makeLeaf(false, 'shelly.12v.dieselHeater', {
            displayName: 'Diesel Cabin Heater Relay',
          }),
          meta: { displayName: 'Diesel Cabin Heater Relay' },
        },
        multiSourceSwitch: {
          name: 'Dual-Source Switch (Multi-Source Disambiguation Test)',
          state: makeLeaf(
            false,
            'n2k.switchbank.1',
            { displayName: 'Multi-Source Test Switch' },
            { 'venus.relay.99': false },
          ),
          meta: { displayName: 'Multi-Source Test Switch' },
        },
        bank: {
          main: {
            navLights: {
              name: 'Main Switch Bank — Navigation Lights',
              state: makeLeaf(false, 'n2k.empirbus.bank1', {
                displayName: 'Main Bank Navigation Lights',
              }),
            },
            waterPump: {
              name: 'Main Switch Bank — Water Pump',
              state: makeLeaf(false, 'n2k.empirbus.bank1', {
                displayName: 'Main Bank Water Pump',
              }),
            },
          },
        },
      },
    },

    // =========================================================================
    // Family 2: NMEA 2000 / SeaTalkNG Navigation, Wind, Depth, Autopilot, Propulsion
    // =========================================================================
    navigation: {
      position: makeLeaf(
        { latitude: 59.3293, longitude: 18.0686, altitude: 0 },
        'n2k.actisense.115',
        { description: 'Vessel GPS Position (WGS84)', displayName: 'GPS Position' },
      ),
      speedOverGround: makeLeaf(
        3.601111111111111,
        'n2k.actisense.115',
        { units: 'm/s', description: 'Speed Over Ground (7.00 kn)', displayName: 'SOG' },
        { 'n2k.gps2.116': 3.55 },
      ),
      speedThroughWater: makeLeaf(
        3.343888888888889,
        'n2k.actisense.115',
        { units: 'm/s', description: 'Speed Through Water (6.50 kn)', displayName: 'STW' },
      ),
      courseOverGroundTrue: makeLeaf(
        1.5707963267948966,
        'n2k.actisense.115',
        { units: 'rad', description: 'Course Over Ground True (90.0 deg)', displayName: 'COG (T)' },
      ),
      headingTrue: makeLeaf(
        1.6580627893946132,
        'n2k.actisense.115',
        { units: 'rad', description: 'True Heading (95.0 deg)', displayName: 'Heading (T)' },
      ),
      headingMagnetic: makeLeaf(
        1.5882496193148399,
        'n2k.actisense.115',
        { units: 'rad', description: 'Magnetic Heading (91.0 deg)', displayName: 'Heading (M)' },
      ),
      rateOfTurn: makeLeaf(
        0.017453292519943295,
        'n2k.actisense.115',
        { units: 'rad/s', description: 'Rate of Turn (1.0 deg/s)', displayName: 'ROT' },
      ),
      attitude: makeLeaf(
        { roll: 0.08726646259971647, pitch: 0.03490658503988659, yaw: 1.6580627893946132 },
        'n2k.actisense.115',
        { units: 'rad', description: 'Vessel Roll (+5 deg) and Pitch (+2 deg)', displayName: 'Attitude' },
      ),
      state: makeLeaf('sailing', 'signalk.vesselstate', {
        description: 'Current Navigation State',
        displayName: 'Navigation State',
      }),
      anchor: {
        position: makeLeaf(
          { latitude: 59.3293, longitude: 18.0686 },
          'signalk-anchoralarm-plugin',
          { description: 'Anchor Drop GPS Coordinate', displayName: 'Anchor Position' },
        ),
        currentRadius: makeLeaf(14.2, 'signalk-anchoralarm-plugin', {
          units: 'm',
          description: 'Current Distance from Anchor',
          displayName: 'Anchor Distance',
        }),
        maxRadius: makeLeaf(40.0, 'signalk-anchoralarm-plugin', {
          units: 'm',
          description: 'Maximum Allowed Anchor Swing Radius',
          displayName: 'Anchor Max Radius',
        }),
        rodeLength: makeLeaf(25.0, 'signalk-anchoralarm-plugin', {
          units: 'm',
          description: 'Deployed Anchor Chain/Rode Length',
          displayName: 'Anchor Rode Length',
        }),
        bearingTrue: makeLeaf(3.141592653589793, 'signalk-anchoralarm-plugin', {
          units: 'rad',
          description: 'True Bearing from Anchor to Vessel (180.0 deg)',
          displayName: 'Anchor Bearing',
        }),
      },
    },

    // =========================================================================
    // Family 2 + 3 + 4: Environment (Wind, Depth, Water, 1-Wire, I2C, RuuviTag, Diesel Heater)
    // =========================================================================
    environment: {
      wind: {
        speedApparent: makeLeaf(7.716666666666667, 'n2k.actisense.115', {
          units: 'm/s',
          description: 'Apparent Wind Speed (15.0 kn)',
          displayName: 'AWS',
        }),
        angleApparent: makeLeaf(-0.7853981633974483, 'n2k.actisense.115', {
          units: 'rad',
          description: 'Apparent Wind Angle (-45.0 deg port)',
          displayName: 'AWA',
        }),
        speedTrue: makeLeaf(6.173333333333334, 'n2k.actisense.115', {
          units: 'm/s',
          description: 'True Wind Speed (12.0 kn)',
          displayName: 'TWS',
        }),
        angleTrueWater: makeLeaf(-1.0471975511965976, 'n2k.actisense.115', {
          units: 'rad',
          description: 'True Wind Angle (-60.0 deg port)',
          displayName: 'TWA',
        }),
      },
      depth: {
        belowTransducer: makeLeaf(
          12.4,
          'n2k.actisense.115',
          { units: 'm', description: 'Depth Below Transducer', displayName: 'DBT' },
          { 'n2k.triducer.120': 12.6 },
        ),
        belowKeel: makeLeaf(10.6, 'n2k.actisense.115', {
          units: 'm',
          description: 'Depth Below Keel',
          displayName: 'DBK',
        }),
        belowSurface: makeLeaf(12.9, 'n2k.actisense.115', {
          units: 'm',
          description: 'Depth Below Surface',
          displayName: 'DBS',
        }),
      },
      water: {
        temperature: makeLeaf(289.65, 'n2k.actisense.115', {
          units: 'K',
          description: 'Sea Water Temperature (16.5 °C)',
          displayName: 'Water Temperature',
        }),
      },
      outside: {
        temperature: makeLeaf(291.15, 'n2k.actisense.115', {
          units: 'K',
          description: 'Outside Air Temperature (18.0 °C)',
          displayName: 'Outside Temperature',
        }),
        pressure: makeLeaf(101325, 'openplotter.i2c.bme280', {
          units: 'Pa',
          description: 'Barometric Pressure (1013.25 hPa)',
          displayName: 'Barometric Pressure',
        }),
      },
      inside: {
        engineRoom: {
          temperature: makeLeaf(308.15, 'openplotter.1wire.28-00000a1b2c3d', {
            units: 'K',
            description: '1-Wire DS18B20 Engine Room Temperature (35.0 °C)',
            displayName: 'Engine Room Temperature',
          }),
        },
        saloon: {
          temperature: makeLeaf(294.65, 'openplotter.1wire.28-00000e4f5a6b', {
            units: 'K',
            description: '1-Wire DS18B20 Saloon Temperature (21.5 °C)',
            displayName: 'Saloon Temperature',
          }),
          relativeHumidity: makeLeaf(0.58, 'openplotter.i2c.bme280', {
            units: 'ratio',
            description: 'I2C BME280 Saloon Relative Humidity (58%)',
            displayName: 'Saloon Humidity',
          }),
          pressure: makeLeaf(101325, 'openplotter.i2c.bme280', {
            units: 'Pa',
            description: 'I2C BME280 Saloon Atmospheric Pressure',
            displayName: 'Saloon Pressure',
          }),
        },
        mainCabin: {
          temperature: makeLeaf(294.15, 'openplotter.1wire.28-00000c1d2e3f', {
            units: 'K',
            description: 'Main Cabin Temperature (21.0 °C)',
            displayName: 'Main Cabin Temperature',
          }),
        },
        aftCabin: {
          temperature: makeLeaf(292.65, 'autoterm.heater.sensor', {
            units: 'K',
            description: 'Autoterm Diesel Heater Aft Cabin Temperature (19.5 °C)',
            displayName: 'Aft Cabin Temperature',
          }),
        },
        forwardCabin: {
          temperature: makeLeaf(293.65, 'ble.ruuvitag.f4a2', {
            units: 'K',
            description: 'RuuviTag BLE Forward Cabin Temperature (20.5 °C)',
            displayName: 'Forward Cabin Temperature',
          }),
          relativeHumidity: makeLeaf(0.62, 'ble.ruuvitag.f4a2', {
            units: 'ratio',
            description: 'RuuviTag BLE Forward Cabin Relative Humidity (62%)',
            displayName: 'Forward Cabin Humidity',
          }),
          pressure: makeLeaf(101280, 'ble.ruuvitag.f4a2', {
            units: 'Pa',
            description: 'RuuviTag BLE Forward Cabin Pressure (1012.80 hPa)',
            displayName: 'Forward Cabin Pressure',
          }),
        },
      },
    },

    // =========================================================================
    // Family 2: Read-Only Autopilot & Steering
    // =========================================================================
    steering: {
      autopilot: {
        state: makeLeaf('auto', 'n2k.raymarine.ev1', {
          description: 'Autopilot Operating State (Read-Only)',
          displayName: 'Autopilot State',
        }),
        mode: makeLeaf('compass', 'n2k.raymarine.ev1', {
          description: 'Autopilot Steering Mode (Read-Only)',
          displayName: 'Autopilot Mode',
        }),
        target: {
          headingTrue: makeLeaf(1.6580627893946132, 'n2k.raymarine.ev1', {
            units: 'rad',
            description: 'Autopilot Target True Heading (95.0 deg)',
            displayName: 'Autopilot Target Heading',
          }),
          windAngleApparent: makeLeaf(-0.7853981633974483, 'n2k.raymarine.ev1', {
            units: 'rad',
            description: 'Autopilot Target Apparent Wind Angle (-45.0 deg)',
            displayName: 'Autopilot Target Wind Angle',
          }),
        },
      },
      rudderAngle: makeLeaf(0.05235987755982989, 'n2k.raymarine.ev1', {
        units: 'rad',
        description: 'Rudder Angle (+3.0 deg)',
        displayName: 'Rudder Angle',
      }),
    },

    // =========================================================================
    // Family 2: Propulsion / Engines (Strictly Read-Only)
    // =========================================================================
    propulsion: {
      port: {
        name: 'Port Engine (Yanmar 4JH45)',
        state: makeLeaf('started', 'n2k.engine.port', {
          displayName: 'Port Engine State',
        }),
        revolutions: makeLeaf(36.666666666666664, 'n2k.engine.port', {
          units: 'Hz',
          description: 'Engine Speed in Hz (2200 RPM)',
          displayName: 'Port Engine RPM',
        }),
        temperature: makeLeaf(358.15, 'n2k.engine.port', {
          units: 'K',
          description: 'Engine Temperature (85.0 °C)',
          displayName: 'Port Engine Temperature',
        }),
        coolantTemperature: makeLeaf(356.15, 'n2k.engine.port', {
          units: 'K',
          description: 'Coolant Temperature (83.0 °C)',
          displayName: 'Port Coolant Temperature',
        }),
        exhaustTemperature: makeLeaf(623.15, 'n2k.engine.port', {
          units: 'K',
          description: 'Exhaust Temperature (350.0 °C)',
          displayName: 'Port Exhaust Temperature',
        }),
        oilPressure: makeLeaf(340000, 'n2k.engine.port', {
          units: 'Pa',
          description: 'Oil Pressure (3.4 bar)',
          displayName: 'Port Oil Pressure',
        }),
        coolantPressure: makeLeaf(120000, 'n2k.engine.port', {
          units: 'Pa',
          description: 'Coolant Pressure (1.2 bar)',
          displayName: 'Port Coolant Pressure',
        }),
        runTime: makeLeaf(1530000, 'n2k.engine.port', {
          units: 's',
          description: 'Total Engine Hours in Seconds (425.0 h)',
          displayName: 'Port Engine Hours',
        }),
        fuel: {
          rate: makeLeaf(0.0000010555555555555556, 'n2k.engine.port', {
            units: 'm3/s',
            description: 'Fuel Flow Rate (3.8 L/h)',
            displayName: 'Port Fuel Rate',
          }),
        },
        transmission: {
          gear: makeLeaf('Forward', 'n2k.engine.port', {
            displayName: 'Port Transmission Gear',
          }),
        },
      },
      starboard: {
        name: 'Starboard Engine (Yanmar 4JH45)',
        state: makeLeaf('stopped', 'n2k.engine.starboard', {
          displayName: 'Starboard Engine State',
        }),
        revolutions: makeLeaf(0, 'n2k.engine.starboard', {
          units: 'Hz',
          displayName: 'Starboard Engine RPM',
        }),
        temperature: makeLeaf(298.15, 'n2k.engine.starboard', {
          units: 'K',
          displayName: 'Starboard Engine Temperature',
        }),
        coolantTemperature: makeLeaf(298.15, 'n2k.engine.starboard', {
          units: 'K',
          displayName: 'Starboard Coolant Temperature',
        }),
        oilPressure: makeLeaf(0, 'n2k.engine.starboard', {
          units: 'Pa',
          displayName: 'Starboard Oil Pressure',
        }),
        coolantPressure: makeLeaf(0, 'n2k.engine.starboard', {
          units: 'Pa',
          displayName: 'Starboard Coolant Pressure',
        }),
        runTime: makeLeaf(1512000, 'n2k.engine.starboard', {
          units: 's',
          displayName: 'Starboard Engine Hours (420.0 h)',
        }),
        fuel: {
          rate: makeLeaf(0, 'n2k.engine.starboard', {
            units: 'm3/s',
            displayName: 'Starboard Fuel Rate',
          }),
        },
        transmission: {
          gear: makeLeaf('Neutral', 'n2k.engine.starboard', {
            displayName: 'Starboard Transmission Gear',
          }),
        },
      },
    },

    // =========================================================================
    // Family 5: Fluid Tanks (`tanks.*`)
    // =========================================================================
    tanks: {
      freshWater: {
        0: {
          name: 'Fresh Water Tank 0 (Bow)',
          currentLevel: makeLeaf(0.75, 'n2k.tanks.fw0', {
            units: 'ratio',
            displayName: 'Bow Fresh Water Level (75%)',
          }),
          currentVolume: makeLeaf(0.15, 'n2k.tanks.fw0', {
            units: 'm3',
            displayName: 'Bow Fresh Water Volume (150 L)',
          }),
          capacity: makeLeaf(0.2, 'n2k.tanks.fw0', {
            units: 'm3',
            displayName: 'Bow Fresh Water Capacity (200 L)',
          }),
        },
        1: {
          name: 'Fresh Water Tank 1 (Midships)',
          currentLevel: makeLeaf(0.5, 'n2k.tanks.fw1', {
            units: 'ratio',
            displayName: 'Midships Fresh Water Level (50%)',
          }),
          currentVolume: makeLeaf(0.075, 'n2k.tanks.fw1', {
            units: 'm3',
            displayName: 'Midships Fresh Water Volume (75 L)',
          }),
          capacity: makeLeaf(0.15, 'n2k.tanks.fw1', {
            units: 'm3',
            displayName: 'Midships Fresh Water Capacity (150 L)',
          }),
        },
      },
      fuel: {
        0: {
          name: 'Main Diesel Fuel Tank 0',
          currentLevel: makeLeaf(0.6, 'n2k.tanks.fuel0', {
            units: 'ratio',
            displayName: 'Main Diesel Fuel Level (60%)',
          }),
          currentVolume: makeLeaf(0.12, 'n2k.tanks.fuel0', {
            units: 'm3',
            displayName: 'Main Diesel Fuel Volume (120 L)',
          }),
          capacity: makeLeaf(0.2, 'n2k.tanks.fuel0', {
            units: 'm3',
            displayName: 'Main Diesel Fuel Capacity (200 L)',
          }),
        },
      },
      blackWater: {
        0: {
          name: 'Black Water Holding Tank 0',
          currentLevel: makeLeaf(0.2, 'n2k.tanks.bw0', {
            units: 'ratio',
            displayName: 'Black Water Level (20%)',
          }),
          currentVolume: makeLeaf(0.016, 'n2k.tanks.bw0', {
            units: 'm3',
            displayName: 'Black Water Volume (16 L)',
          }),
          capacity: makeLeaf(0.08, 'n2k.tanks.bw0', {
            units: 'm3',
            displayName: 'Black Water Capacity (80 L)',
          }),
        },
      },
      wasteWater: {
        0: {
          name: 'Grey Waste Water Tank 0',
          currentLevel: makeLeaf(0.3, 'n2k.tanks.ww0', {
            units: 'ratio',
            displayName: 'Grey Water Level (30%)',
          }),
          currentVolume: makeLeaf(0.024, 'n2k.tanks.ww0', {
            units: 'm3',
            displayName: 'Grey Water Volume (24 L)',
          }),
          capacity: makeLeaf(0.08, 'n2k.tanks.ww0', {
            units: 'm3',
            displayName: 'Grey Water Capacity (80 L)',
          }),
        },
      },
      liveWell: {
        0: {
          name: 'Live Well Tank 0',
          currentLevel: makeLeaf(0.0, 'n2k.tanks.lw0', { units: 'ratio', displayName: 'Live Well Level' }),
          currentVolume: makeLeaf(0.0, 'n2k.tanks.lw0', { units: 'm3', displayName: 'Live Well Volume' }),
          capacity: makeLeaf(0.05, 'n2k.tanks.lw0', { units: 'm3', displayName: 'Live Well Capacity (50 L)' }),
        },
      },
      lubrication: {
        0: {
          name: 'Engine Lubrication Oil Tank 0',
          currentLevel: makeLeaf(0.85, 'n2k.tanks.lube0', { units: 'ratio', displayName: 'Lube Oil Level' }),
          currentVolume: makeLeaf(0.0085, 'n2k.tanks.lube0', { units: 'm3', displayName: 'Lube Oil Volume (8.5 L)' }),
          capacity: makeLeaf(0.01, 'n2k.tanks.lube0', { units: 'm3', displayName: 'Lube Oil Capacity (10 L)' }),
        },
      },
      ballast: {
        0: {
          name: 'Water Ballast Tank 0',
          currentLevel: makeLeaf(0.0, 'n2k.tanks.ballast0', { units: 'ratio', displayName: 'Ballast Level' }),
          currentVolume: makeLeaf(0.0, 'n2k.tanks.ballast0', { units: 'm3', displayName: 'Ballast Volume' }),
          capacity: makeLeaf(0.3, 'n2k.tanks.ballast0', { units: 'm3', displayName: 'Ballast Capacity (300 L)' }),
        },
      },
    },

    // =========================================================================
    // Family 6: Notifications (`notifications.*`)
    // =========================================================================
    notifications: {
      navigation: {
        anchor: makeLeaf(
          { state: 'normal', method: ['visual'], message: 'Anchor watch normal' },
          'signalk-anchoralarm-plugin',
          { displayName: 'Anchor Alarm Notification' },
        ),
      },
      bilge: {
        main: makeLeaf(
          { state: 'normal', method: ['visual'], message: 'Main bilge dry' },
          'openplotter.gpio.pin17',
          { displayName: 'Main Bilge Float Alarm' },
        ),
      },
      security: {
        companionwayHatch: makeLeaf(
          { state: 'normal', method: ['visual'], message: 'Companionway hatch closed' },
          'homey.security',
          { displayName: 'Companionway Hatch Security' },
        ),
        forwardHatch: makeLeaf(
          { state: 'normal', method: ['visual'], message: 'Forward hatch closed' },
          'homey.security',
          { displayName: 'Forward Hatch Security' },
        ),
      },
      electrical: {
        batteries: {
          house: makeLeaf(
            { state: 'normal', method: ['visual'], message: 'House battery normal' },
            'venus.com.victronenergy.battery.288',
            { displayName: 'House Battery Notification' },
          ),
        },
      },
      propulsion: {
        port: {
          overTemperature: makeLeaf(
            { state: 'normal', method: [], message: 'Port engine temperature normal' },
            'n2k.engine.port',
            { displayName: 'Port Engine Over-Temperature Alarm' },
          ),
        },
      },
    },
  };
}
