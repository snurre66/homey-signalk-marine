import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockSignalKServer } from './harness/mock_signalk_server.mjs';
import {
  HomeyRuntimeHarness,
  SafetyBoundaryError,
  MockPairSession,
} from './harness/homey_runtime_harness.mjs';
import { VESSEL_SELF_URN } from './harness/fixtures.mjs';

const waitForWs = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function clearClientThrottle(harness, serverId = 'boat-1') {
  const conn = harness.connectionPool._connections.get(serverId);
  if (!conn) return;
  for (const sub of conn.subscriptions.values()) {
    sub.lastDeliveredPerPath.clear();
  }
}

describe('Tier 4 — Realistic End-to-End Smart-Boat Scenarios (Scenarios 1–8)', () => {
  let mockServer;
  let harness;

  before(async () => {
    mockServer = new MockSignalKServer();
    await mockServer.start();
  });

  after(async () => {
    if (harness) {
      await harness.shutdown();
    }
    if (mockServer) {
      await mockServer.stop();
    }
  });

  beforeEach(async () => {
    if (harness) {
      await harness.shutdown();
    }
    mockServer.dropWebSocketClients();
    mockServer.reset();
    harness = new HomeyRuntimeHarness();
  });

  // ===========================================================================
  // Scenario 1: Anchor Drift Watch (2 tests)
  // ===========================================================================
  describe('Scenario 1: Anchor Drift Watch', () => {
    test('SC1-01: Dropping anchor arms watch, switches anchor light on, and triggers cabin alarm light on Haversine GPS drag', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setAnchorPutDisabled(true);

      const vessel = await harness.pairDevice('vessel', {
        settings: { anchor_max_radius: 35, anchor_rode_length: 30 },
      });
      const anchorLight = await harness.pairDevice('digital-switch', {
        store: { switchId: 'anchorLight', basePath: 'electrical.switches.anchorLight' },
        capabilities: ['onoff'],
      });
      const cabinRedAlarmLight = await harness.pairDevice('digital-switch', {
        store: { switchId: 'cabinRedAlarmLight', basePath: 'electrical.switches.cabinRedAlarmLight' },
        capabilities: ['onoff'],
      });
      await anchorLight.setCapabilityValue('onoff', false);
      await cabinRedAlarmLight.setCapabilityValue('onoff', false);
      await waitForWs();

      let alarmActionTriggered = false;
      harness.homey.flow.onTrigger('anchor_drag_alarm', async () => {
        const armed = await harness.homey.flow.evaluateCondition('is_anchor_armed', { device: vessel });
        if (armed) {
          await harness.homey.flow.runAction('put_signalk_path', {
            path: 'electrical.switches.cabinRedAlarmLight.state',
            value: true,
          });
          await harness.homey.notifications.createNotification({
            excerpt: 'Anchor drag detected! Vessel outside 35m swing circle.',
          });
          alarmActionTriggered = true;
        }
      });

      // Step 1: Drop anchor via Flow action + turn on masthead anchor light
      await harness.homey.flow.runAction('arm_anchor_watch', { maxRadius: 35, rodeLength: 30 });
      await anchorLight.triggerCapabilityListener('onoff', true);
      await waitForWs();

      assert.equal(vessel.getCapabilityValue('onoff.anchor_armed'), true);
      assert.equal(anchorLight.getCapabilityValue('onoff'), true);
      assert.deepEqual(
        mockServer.recordedPluginCalls.map((c) => c.action),
        ['dropAnchor', 'setRadius', 'setRodeLength'],
      );

      // Step 2: Anchor plugin radius unavailable; GPS drifts ~56m North -> Haversine fallback detects drag
      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: null },
        { path: 'navigation.position', value: { latitude: 59.3298, longitude: 18.0686 } },
      ]);
      await waitForWs(80);

      assert.equal(vessel._lastDriftStatus.source, 'haversine_fallback');
      assert.ok(vessel.getCapabilityValue('measure_anchor_distance') > 35);
      assert.equal(vessel.getCapabilityValue('alarm_generic'), true);
      assert.equal(alarmActionTriggered, true);
      assert.equal(cabinRedAlarmLight.getCapabilityValue('onoff'), true);
      assert.equal(harness.homey.notifications.history.length, 1);

      // Step 3: Raise anchor & clear alarm
      await harness.homey.flow.runAction('disarm_anchor_watch', {});
      await waitForWs();
      assert.equal(vessel.getCapabilityValue('onoff.anchor_armed'), false);
      assert.equal(vessel.getCapabilityValue('alarm_generic'), false);
      assert.equal(mockServer.recordedPluginCalls.at(-1).action, 'raiseAnchor');
    });

    test('SC1-02: Anchor plugin alarm overrides distance check and clears when vessel settles inside radius', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vessel = await harness.pairDevice('vessel', {
        settings: { anchor_max_radius: 40 },
      });
      await waitForWs();

      await vessel.armAnchorWatch({ maxRadius: 40, rodeLength: 35 });

      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: 24.5 },
        {
          path: 'notifications.navigation.anchor',
          value: { state: 'alarm', method: ['sound'], message: 'Anchor plugin alarm' },
        },
      ]);
      await waitForWs();

      assert.equal(vessel._lastDriftStatus.source, 'plugin');
      assert.equal(vessel.getCapabilityValue('alarm_generic'), true);

      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: 18.0 },
        { path: 'notifications.navigation.anchor', value: { state: 'normal', method: [], message: 'OK' } },
      ]);
      await waitForWs();

      assert.equal(vessel.getCapabilityValue('measure_anchor_distance'), 18);
      assert.equal(vessel.getCapabilityValue('alarm_generic'), false);
    });
  });

  // ===========================================================================
  // Scenario 2: Victron Battery Load Shedding (2 tests)
  // ===========================================================================
  describe('Scenario 2: Victron Battery Load Shedding', () => {
    test('SC2-01: Shore disconnect + solar dip + SOC < 30% switches MultiPlus to eco and sheds water heater & fridge relays', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      const houseBattery = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      const solar = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'solar', bankId: '0', basePath: 'electrical.solar.0' },
        capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'meter_power'],
      });
      const inverter = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'inverter', bankId: '0', basePath: 'electrical.inverters.0' },
        capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
      });
      const waterHeater = await harness.pairDevice('digital-switch', {
        store: { switchId: 'waterHeater', basePath: 'electrical.switches.waterHeater' },
        capabilities: ['onoff'],
      });
      const cockpitFridge = await harness.pairDevice('digital-switch', {
        store: { switchId: 'cockpitFridge', basePath: 'electrical.switches.cockpitFridge' },
        capabilities: ['onoff'],
      });
      await waterHeater.setCapabilityValue('onoff', true);
      await cockpitFridge.setCapabilityValue('onoff', true);
      await waitForWs();

      let loadShedCount = 0;
      harness.homey.flow.onTrigger('battery_soc_below_threshold', async (record) => {
        if (record.tokens.threshold === 30) {
          const confirmedLow = await harness.homey.flow.evaluateCondition('is_battery_soc_below', {
            device: houseBattery,
            threshold: 30,
          });
          if (confirmedLow) {
            await harness.homey.flow.runAction('set_charger_inverter_mode', {
              bankId: '0',
              mode: 'eco',
            });
            await harness.homey.flow.runAction('put_signalk_path', {
              path: 'electrical.switches.waterHeater.state',
              value: false,
            });
            await harness.homey.flow.runAction('put_signalk_path', {
              path: 'electrical.switches.cockpitFridge.state',
              value: false,
            });
            loadShedCount += 1;
          }
        }
      });

      // Shore power disconnects; solar drops; battery drains from 42% -> 27%
      mockServer.emitDelta([
        { path: 'electrical.ac.0.phaseA.connected', value: false },
        { path: 'electrical.solar.0.panelPower', value: 18.0 },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.42 },
      ]);
      await waitForWs();
      clearClientThrottle(harness);

      mockServer.emitDelta([
        { path: 'electrical.batteries.house.voltage', value: 12.15 },
        { path: 'electrical.batteries.house.current', value: -38.5 },
        { path: 'electrical.batteries.house.power', value: -467.78 },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.27 },
        { path: 'electrical.batteries.house.capacity.remaining', value: 388800 }, // 108 Ah
        { path: 'electrical.batteries.house.capacity.timeRemaining', value: 18000 }, // 5.0 h
      ]);
      await waitForWs(90);

      assert.equal(loadShedCount, 1);
      assert.equal(solar.getCapabilityValue('measure_power'), 18);
      assert.equal(houseBattery.getCapabilityValue('measure_battery'), 27);
      assert.equal(houseBattery.getCapabilityValue('measure_remaining_ah'), 108);
      assert.equal(houseBattery.getCapabilityValue('measure_time_remaining'), 5);
      assert.equal(inverter.getCapabilityValue('charger_inverter_mode'), 'eco');
      assert.equal(waterHeater.getCapabilityValue('onoff'), false);
      assert.equal(cockpitFridge.getCapabilityValue('onoff'), false);
      assert.ok(
        harness.homey.flow.triggeredHistory.some(
          (t) => t.cardId === 'shore_power_status_changed' && t.tokens.connected === false,
        ),
      );
    });

    test('SC2-02: Critical battery <= 20% raises alarm_battery and survives 502 relay timeout without corrupting UI state', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBattery = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
        settings: { lowSocThreshold: 20, lowVoltageThreshold: 11.8 },
      });
      const venusRelay0 = await harness.pairDevice('digital-switch', {
        store: { switchId: 'venusRelay0', basePath: 'electrical.switches.venusRelay0' },
        capabilities: ['onoff'],
      });
      await venusRelay0.setCapabilityValue('onoff', true);
      await waitForWs();

      mockServer.setPutBehavior('electrical.switches.venusRelay0.state', {
        mode: 'ASYNC_202_FAIL_502',
        delayMs: 40,
        message: 'GX relay bus busy',
      });

      mockServer.emitDelta([
        { path: 'electrical.batteries.house.voltage', value: 11.65 },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.16 },
      ]);
      await waitForWs();

      assert.equal(houseBattery.getCapabilityValue('alarm_battery'), true);

      await assert.rejects(
        () => venusRelay0.triggerCapabilityListener('onoff', false),
        /GX relay bus busy/i,
      );
      assert.equal(venusRelay0.getCapabilityValue('onoff'), true);
    });
  });

  // ===========================================================================
  // Scenario 3: Diesel Heater & Cabin Comfort (1 test)
  // ===========================================================================
  describe('Scenario 3: Diesel Heater & Cabin Comfort', () => {
    test('SC3-01: Cold Homey cabin sensor bridges C->K to Signal K, triggers diesel heater relay & saloon dimmer ambiance', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      const aftCabinTemp = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.aftCabin.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          throttleTier: 'fast',
        },
        capabilities: ['measure_temperature'],
      });
      const dieselHeater = await harness.pairDevice('digital-switch', {
        store: { switchId: 'dieselHeater', basePath: 'electrical.switches.dieselHeater' },
        capabilities: ['onoff'],
      });
      const saloonDimmer = await harness.pairDevice('digital-switch', {
        store: { switchId: 'saloonDimmer', basePath: 'electrical.switches.saloonDimmer' },
        capabilities: ['onoff', 'dim'],
      });
      await dieselHeater.setCapabilityValue('onoff', false);
      await waitForWs();

      let heatingActivated = false;
      harness.homey.flow.onTrigger('path_value_updated', async (record) => {
        if (record.tokens.path === 'environment.inside.aftCabin.temperature') {
          const isCold = await harness.homey.flow.evaluateCondition('path_value_comparison', {
            path: 'environment.inside.aftCabin.temperature',
            operator: '<',
            value: 288.15, // < 15.0 °C
          });
          if (isCold && !heatingActivated) {
            heatingActivated = true;
            await harness.homey.flow.runAction('put_signalk_path', {
              path: 'electrical.switches.dieselHeater.state',
              value: true,
            });
            await saloonDimmer.triggerCapabilityListener('dim', 0.4);
          }
        }
      });

      // Homey Zigbee thermostat reports 12.5 °C in aftCabin
      await harness.homey.flow.runAction('publish_temperature_to_signalk', {
        zone: 'aftCabin',
        value: 12.5,
        source: 'zigbee.aqara.aftCabin',
      });
      await waitForWs(90);

      assert.equal(mockServer.getTreeNode('environment.inside.aftCabin.temperature').value, 285.65);
      assert.equal(aftCabinTemp.getCapabilityValue('measure_temperature'), 12.5);
      assert.equal(heatingActivated, true);
      assert.equal(dieselHeater.getCapabilityValue('onoff'), true);
      assert.equal(saloonDimmer.getCapabilityValue('dim'), 0.4);

      // Cabin warms up to 20.5 °C -> turn off heater
      mockServer.emitDelta({
        path: 'environment.inside.aftCabin.temperature',
        value: 293.65,
        $source: 'autoterm.heater.sensor',
      });
      await dieselHeater.triggerCapabilityListener('onoff', false);
      await waitForWs();

      assert.equal(aftCabinTemp.getCapabilityValue('measure_temperature'), 20.5);
      assert.equal(dieselHeater.getCapabilityValue('onoff'), false);
    });
  });

  // ===========================================================================
  // Scenario 4: RuuviTag & Bilge Alarm (1 test)
  // ===========================================================================
  describe('Scenario 4: RuuviTag & Bilge Alarm', () => {
    test('SC4-01: RuuviTag cabin humidity + GPIO bilge water alarm activate bilge pump and raise Signal K notification', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      const ruuviHumidity = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.forwardCabin.relativeHumidity',
          capability: 'measure_humidity',
          unitCategory: 'ratio_to_percent',
          sourceFilter: 'homey.ble.ruuvitag.f4a2',
          throttleTier: 'fast',
        },
        capabilities: ['measure_humidity'],
      });
      const bilgeFloat = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'notifications.bilge.main',
          capability: 'alarm_water',
          throttleTier: 'fast',
        },
        capabilities: ['alarm_water'],
      });
      const bilgePump = await harness.pairDevice('digital-switch', {
        store: { switchId: 'bilgePump', basePath: 'electrical.switches.bilgePump' },
        capabilities: ['onoff'],
      });
      await bilgePump.setCapabilityValue('onoff', false);
      await waitForWs();

      let emergencyHandled = false;
      harness.homey.flow.onTrigger('signalk_notification_raised', async (record) => {
        if (record.tokens.path === 'notifications.bilge.main' && record.tokens.state === 'emergency') {
          await harness.homey.flow.runAction('put_signalk_path', {
            path: 'electrical.switches.bilgePump.state',
            value: true,
          });
          await harness.homey.notifications.createNotification({
            excerpt: 'BILGE WATER EMERGENCY — Main bilge pump activated!',
          });
          emergencyHandled = true;
        }
      });

      // Bridge RuuviTag humidity from Homey BLE -> Signal K
      await harness.homey.flow.runAction('publish_humidity_to_signalk', {
        zone: 'forwardCabin',
        value: 74.0,
        source: 'ble.ruuvitag.f4a2',
      });
      await waitForWs(60);

      // Trigger high bilge water emergency notification from OpenPlotter GPIO
      mockServer.emitDelta({
        path: 'notifications.bilge.main',
        value: {
          state: 'emergency',
          method: ['visual', 'sound'],
          message: 'High bilge water detected on GPIO17',
        },
        $source: 'openplotter.gpio.pin17',
      });
      await waitForWs(90);

      assert.equal(ruuviHumidity.getCapabilityValue('measure_humidity'), 74);
      assert.equal(bilgeFloat.getCapabilityValue('alarm_water'), true);
      assert.equal(emergencyHandled, true);
      assert.equal(bilgePump.getCapabilityValue('onoff'), true);
      assert.equal(
        await harness.homey.flow.evaluateCondition('is_alarm_active', {
          path: 'notifications.bilge.main',
        }),
        true,
      );

      // Clear bilge alarm once water pumped out
      await harness.homey.flow.runAction('clear_signalk_notification', {
        category: 'bilge',
        item: 'main',
      });
      await bilgePump.triggerCapabilityListener('onoff', false);
      await waitForWs();

      assert.equal(bilgeFloat.getCapabilityValue('alarm_water'), false);
      assert.equal(bilgePump.getCapabilityValue('onoff'), false);
    });
  });

  // ===========================================================================
  // Scenario 5: NMEA 2000 Engine & Sailing Telemetry (1 test)
  // ===========================================================================
  describe('Scenario 5: NMEA 2000 Engine & Sailing Telemetry', () => {
    test('SC5-01: Live N2K motor-sailing stream updates vessel & twin engines while enforcing propulsion/autopilot safety boundary', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      const vessel = await harness.pairDevice('vessel');
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      const stbdEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'starboard' },
        store: { engineId: 'starboard' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'navigation.speedOverGround', value: 4.115556 }, // 8.0 kn
        { path: 'navigation.speedThroughWater', value: 3.704 }, // 7.2 kn
        { path: 'navigation.headingTrue', value: 1.5707963 }, // 90 deg
        { path: 'environment.wind.speedApparent', value: 9.26 }, // 18.0 kn
        { path: 'environment.wind.angleApparent', value: -Math.PI / 4 }, // -45 deg
        { path: 'environment.depth.belowTransducer', value: 18.6 },
        { path: 'steering.autopilot.state', value: 'auto' },
        { path: 'navigation.state', value: 'motoring' },
        { path: 'propulsion.port.state', value: 'started' },
        { path: 'propulsion.port.revolutions', value: 40 }, // 2400 RPM
        { path: 'propulsion.port.temperature', value: 359.15 }, // 86.0 °C
        { path: 'propulsion.port.oilPressure', value: 350000 }, // 3.5 bar
        { path: 'propulsion.port.fuel.rate', value: 0.00000125 }, // 4.5 L/h
        { path: 'propulsion.starboard.state', value: 'stopped' },
        { path: 'propulsion.starboard.revolutions', value: 0 },
      ]);
      await waitForWs(60);

      assert.equal(vessel.getCapabilityValue('measure_sog'), 8);
      assert.equal(vessel.getCapabilityValue('measure_stw'), 7.2);
      assert.equal(vessel.getCapabilityValue('measure_heading'), 90);
      assert.equal(vessel.getCapabilityValue('measure_wind_strength'), 18);
      assert.equal(vessel.getCapabilityValue('measure_wind_angle'), -45);
      assert.equal(vessel.getCapabilityValue('measure_depth'), 18.6);
      assert.equal(vessel.getCapabilityValue('autopilot_state'), 'auto');
      assert.equal(vessel.getCapabilityValue('navigation_state'), 'motoring');

      assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 2400);
      assert.equal(portEngine.getCapabilityValue('measure_temperature'), 86);
      assert.equal(portEngine.getCapabilityValue('measure_oil_pressure'), 3.5);
      assert.equal(portEngine.getCapabilityValue('measure_fuel_rate'), 4.5);
      assert.equal(stbdEngine.getCapabilityValue('measure_engine_rpm'), 0);

      // Verify strict read-only safety boundary across autopilot & propulsion
      await assert.rejects(
        () => vessel.triggerCapabilityListener('autopilot_state', 'standby'),
        /read-only/i,
      );
      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'steering.autopilot.state', 'standby'),
        (err) => err instanceof SafetyBoundaryError,
      );
      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'propulsion.port.revolutions', 10),
        (err) => err instanceof SafetyBoundaryError,
      );
      assert.equal(mockServer.getPutRequestLog().length, 0);
    });
  });

  // ===========================================================================
  // Scenario 6: Fluid Tank Monitoring (1 test)
  // ===========================================================================
  describe('Scenario 6: Fluid Tank Monitoring', () => {
    test('SC6-01: Multi-tank voyage consumption (freshWater, fuel, blackWater) triggers alarms & shuts freshWaterPump', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      const fwTank = await harness.pairDevice('fluid-tank', {
        store: { tankType: 'freshWater', tankId: '0', basePath: 'tanks.freshWater.0', capacityLiters: 200 },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'meter_water', 'alarm_generic'],
      });
      const fuelTank = await harness.pairDevice('fluid-tank', {
        store: { tankType: 'fuel', tankId: '0', basePath: 'tanks.fuel.0', capacityLiters: 200 },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic'],
      });
      const bwTank = await harness.pairDevice('fluid-tank', {
        store: { tankType: 'blackWater', tankId: '0', basePath: 'tanks.blackWater.0', capacityLiters: 80 },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic', 'alarm_water'],
      });
      const freshWaterPump = await harness.pairDevice('digital-switch', {
        store: { switchId: 'freshWaterPump', basePath: 'electrical.switches.freshWaterPump' },
        capabilities: ['onoff'],
      });
      await freshWaterPump.setCapabilityValue('onoff', true);
      await waitForWs();

      mockServer.emitDelta([
        { path: 'tanks.freshWater.0.currentLevel', value: 0.12 }, // 12% -> 24 L -> low water alarm
        { path: 'tanks.fuel.0.currentLevel', value: 0.45 }, // 45% -> 90 L -> OK
        { path: 'tanks.blackWater.0.currentLevel', value: 0.92 }, // 92% -> 73.6 L -> high holding tank alarm
      ]);
      await waitForWs(60);

      assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 12);
      assert.equal(fwTank.getCapabilityValue('measure_tank_volume'), 24);
      assert.equal(fwTank.getCapabilityValue('meter_water'), 0.024);
      assert.equal(fwTank.getCapabilityValue('alarm_generic'), true);

      assert.equal(fuelTank.getCapabilityValue('measure_tank_level'), 45);
      assert.equal(fuelTank.getCapabilityValue('measure_tank_volume'), 90);
      assert.equal(fuelTank.getCapabilityValue('alarm_generic'), false);

      assert.equal(bwTank.getCapabilityValue('measure_tank_level'), 92);
      assert.equal(bwTank.getCapabilityValue('measure_tank_volume'), 73.6);
      assert.equal(bwTank.getCapabilityValue('alarm_generic'), true);
      assert.equal(bwTank.getCapabilityValue('alarm_water'), true);

      if (await harness.homey.flow.evaluateCondition('is_alarm_active', { device: fwTank })) {
        await freshWaterPump.triggerCapabilityListener('onoff', false);
      }
      assert.equal(freshWaterPump.getCapabilityValue('onoff'), false);
    });
  });

  // ===========================================================================
  // Scenario 7: mDNS IP Change & Reconnect (1 test)
  // ===========================================================================
  describe('Scenario 7: mDNS IP Change & Reconnect', () => {
    test('SC7-01: Router DHCP reassignment triggers mDNS discovery change, migrates WS pool, and recovers after drop', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vessel = await harness.pairDevice('vessel', { id: VESSEL_SELF_URN });
      const fwTank = await harness.pairDevice('fluid-tank', {
        store: { tankType: 'freshWater', tankId: '0', basePath: 'tanks.freshWater.0', capacityLiters: 200 },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'meter_water', 'alarm_generic'],
      });
      await waitForWs();

      const newPiServer = new MockSignalKServer();
      await newPiServer.start();
      try {
        const strategy = harness.homey.discovery.getStrategy('signalk');
        await strategy.emitDiscoveryResult({
          id: VESSEL_SELF_URN,
          address: '127.0.0.1',
          port: mockServer.port,
        });
        await strategy.emitDiscoveryResult({
          id: VESSEL_SELF_URN,
          address: '127.0.0.1',
          port: newPiServer.port,
        });
        await waitForWs(60);

        assert.equal(vessel.getStoreValue('port'), newPiServer.port);
        assert.ok(newPiServer.getActiveWebSocketCount() >= 1);

        // Simulate transient Wi-Fi drop on new IP and verify automatic backoff reconnect
        newPiServer.dropWebSocketClients();
        assert.equal(newPiServer.getActiveWebSocketCount(), 0);
        await waitForWs(180);
        assert.ok(newPiServer.getActiveWebSocketCount() >= 1);

        clearClientThrottle(harness);
        newPiServer.emitDelta([
          { path: 'navigation.speedOverGround', value: 2.572222 }, // 5.0 kn
          { path: 'tanks.freshWater.0.currentLevel', value: 0.72 },
        ]);
        await waitForWs(60);

        assert.equal(vessel.getCapabilityValue('measure_sog'), 5);
        assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 72);
      } finally {
        await newPiServer.stop();
      }
    });
  });

  // ===========================================================================
  // Scenario 8: Full App Lifecycle (1 test)
  // ===========================================================================
  describe('Scenario 8: Full App Lifecycle', () => {
    test('SC8-01: Boot -> Manifest validation -> Multi-driver Pairing -> Live Streaming -> Flow Bridge -> Clean Shutdown', async () => {
      const { manifest } = harness.loadAppManifest();
      assert.equal(harness.validatePublishLevel(manifest).valid, true);
      assert.equal(harness.validateAppStoreAssets().valid, true);

      await harness.app.onInit();

      // Pair via real MockPairSession
      const vesselDriver = harness.homey.drivers.getDriver('vessel');
      const pairSession = new MockPairSession();
      await vesselDriver.onPair(pairSession);
      await pairSession.emit('connect_server', {
        serverId: 'boat-1',
        host: mockServer.host,
        port: mockServer.port,
        token: 'default-readwrite-token',
      });
      const vesselCandidates = await pairSession.emit('list_devices');
      const vessel = await harness.pairDevice('vessel', vesselCandidates[0]);

      // Pair remaining 5 drivers via auto-discovered descriptors
      const elecCandidates = await harness.homey.drivers.getDriver('electrical-bank').onPairListDevices('boat-1');
      const houseBank = await harness.pairDevice(
        'electrical-bank',
        elecCandidates.find((c) => c.data.bankType === 'battery' && c.data.bankId === 'house'),
      );
      const tankCandidates = await harness.homey.drivers.getDriver('fluid-tank').onPairListDevices('boat-1');
      const fuelTank = await harness.pairDevice(
        'fluid-tank',
        tankCandidates.find((c) => c.data.tankType === 'fuel'),
      );
      const swCandidates = await harness.homey.drivers.getDriver('digital-switch').onPairListDevices('boat-1');
      const navLights = await harness.pairDevice(
        'digital-switch',
        swCandidates.find((c) => c.data.switchId === 'navLights'),
      );
      const propCandidates = await harness.homey.drivers.getDriver('propulsion').onPairListDevices('boat-1');
      const portEngine = await harness.pairDevice(
        'propulsion',
        propCandidates.find((c) => c.data.engineId === 'port'),
      );
      const sensorCandidates = await harness.homey.drivers.getDriver('custom-sensor').onPairListDevices('boat-1');
      const engineRoomTemp = await harness.pairDevice(
        'custom-sensor',
        {
          ...sensorCandidates.find((c) => c.store.path === 'environment.inside.engineRoom.temperature'),
          settings: {
            path: 'environment.inside.engineRoom.temperature',
            capability: 'measure_temperature',
            unitCategory: 'temperature_k_to_c',
            throttleTier: 'fast',
          },
        },
      );

      await waitForWs(60);
      assert.equal(mockServer.getActiveWebSocketCount(), 1);

      // Stream telemetry across all 6 drivers simultaneously
      mockServer.emitDelta([
        { path: 'navigation.speedOverGround', value: 3.343889 }, // 6.5 kn
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.84 },
        { path: 'tanks.fuel.0.currentLevel', value: 0.65 },
        { path: 'propulsion.port.revolutions', value: 35 }, // 2100 RPM
        { path: 'environment.inside.engineRoom.temperature', value: 311.15 }, // 38.0 °C
      ]);
      await navLights.triggerCapabilityListener('onoff', true);
      await harness.homey.flow.runAction('publish_pressure_to_signalk', {
        zone: 'saloon',
        value: 1016.4,
        source: 'homey.bme280',
      });
      await waitForWs(60);

      assert.equal(vessel.getCapabilityValue('measure_sog'), 6.5);
      assert.equal(houseBank.getCapabilityValue('measure_battery'), 84);
      assert.equal(fuelTank.getCapabilityValue('measure_tank_level'), 65);
      assert.equal(navLights.getCapabilityValue('onoff'), true);
      assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 2100);
      assert.equal(engineRoomTemp.getCapabilityValue('measure_temperature'), 38);
      assert.equal(mockServer.getTreeNode('environment.inside.saloon.pressure').value, 101640);

      // Clean shutdown tears down WebSocket and subscriptions
      await harness.shutdown();
      await waitForWs(60);
      assert.equal(mockServer.getActiveWebSocketCount(), 0);
    });
  });
});
