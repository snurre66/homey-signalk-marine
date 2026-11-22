import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockSignalKServer } from './harness/mock_signalk_server.mjs';
import {
  HomeyRuntimeHarness,
  SafetyBoundaryError,
  MockPairSession,
  MockRepairSession,
} from './harness/homey_runtime_harness.mjs';
import { VESSEL_SELF_URN, VESSEL_UUID } from './harness/fixtures.mjs';

const waitForWs = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function clearClientThrottle(harness, serverId = 'boat-1') {
  const conn = harness.connectionPool._connections.get(serverId);
  if (!conn) return;
  for (const sub of conn.subscriptions.values()) {
    sub.lastDeliveredPerPath.clear();
  }
}

describe('Tier 3 — Pairwise Cross-Feature Interaction E2E Suite (F1–F15)', () => {
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

  test('CF-01 (F1 + F15): Manifest drivers, capabilities, mDNS discovery & Flow definitions bind cleanly on App boot', async () => {
    const { manifest } = harness.loadAppManifest();
    const pubValidation = harness.validatePublishLevel(manifest);
    const assetValidation = harness.validateAppStoreAssets();

    assert.equal(pubValidation.valid, true);
    assert.equal(assetValidation.valid, true);
    assert.equal(pubValidation.driverCount, 6);
    assert.equal(pubValidation.capabilityCount, 18);

    await harness.app.onInit();

    for (const d of manifest.drivers) {
      const driver = harness.homey.drivers.getDriver(d.id);
      assert.equal(driver.id, d.id);
      assert.equal(d.discovery, 'signalk');
    }

    for (const trig of manifest.flow.triggers) {
      assert.equal(typeof harness.homey.flow.getTriggerCard(trig.id)._runListener, 'function');
    }
    for (const cond of manifest.flow.conditions) {
      assert.equal(typeof harness.homey.flow.getConditionCard(cond.id)._runListener, 'function');
    }
    for (const act of manifest.flow.actions) {
      assert.equal(typeof harness.homey.flow.getActionCard(act.id)._runListener, 'function');
    }
  });

  test('CF-02 (F4 + F5 + F7): Discovery -> Access Request JWT Approval -> Pairing -> Token Revocation -> Repair Recovery', async () => {
    mockServer.requireAuthForGet = true;
    mockServer.requireAuthForPut = true;
    mockServer.requireAuthForWs = true;

    await harness.app.onInit();

    const disc = await harness.authManager.discoverServer({
      host: mockServer.host,
      port: mockServer.port,
    });
    assert.ok(disc.signalkWsUrl.endsWith('/signalk/v1/stream'));

    const reqRes = await harness.authManager.requestAccess(
      { host: mockServer.host, port: mockServer.port },
      { clientId: VESSEL_UUID, description: 'Homey Pro E2E' },
    );
    setTimeout(() => {
      mockServer.approveAccessRequest(reqRes.requestId, 'initial-jwt-token', 'readwrite');
    }, 30);

    const pollRes = await harness.authManager.pollAccessRequest(
      { host: mockServer.host, port: mockServer.port },
      reqRes.href,
    );
    assert.equal(pollRes.token, 'initial-jwt-token');

    const driver = harness.homey.drivers.getDriver('vessel');
    const pairSession = new MockPairSession();
    await driver.onPair(pairSession);
    await pairSession.emit('connect_server', {
      serverId: 'boat-1',
      host: mockServer.host,
      port: mockServer.port,
      token: pollRes.token,
    });
    const devices = await pairSession.emit('list_devices');
    const vessel = await harness.pairDevice('vessel', devices[0]);
    await waitForWs();

    assert.equal(vessel.getAvailable(), true);
    assert.equal(mockServer.getActiveWebSocketCount(), 1);

    // Revoke token and verify PUT triggers 401 -> device unavailable
    mockServer.revokeToken('initial-jwt-token');
    await assert.rejects(
      () => harness.putController.putPath('boat-1', 'navigation.anchor.maxRadius', 45),
      (err) => err.statusCode === 401,
    );
    assert.equal(vessel.getAvailable(), false);

    // Repair via access request flow
    const repairSession = new MockRepairSession();
    await driver.onRepair(repairSession, vessel);
    const repairReq = await repairSession.emit('request_access');
    setTimeout(() => {
      mockServer.approveAccessRequest(repairReq.requestId, 'repaired-jwt-token', 'readwrite');
    }, 30);

    const repairPoll = await repairSession.emit('poll_access_request', {
      requestId: repairReq.requestId,
      href: repairReq.href,
    });
    assert.equal(repairPoll.token, 'repaired-jwt-token');
    assert.equal(vessel.getStoreValue('token'), 'repaired-jwt-token');
    assert.equal(vessel.getAvailable(), true);

    await waitForWs();
    mockServer.emitDelta({ path: 'navigation.speedOverGround', value: 4.115555 });
    await waitForWs();
    assert.equal(vessel.getCapabilityValue('measure_sog'), 8);
  });

  test('CF-03 (F5 + F9 + F12): Multi-driver WS multiplexing + $source pinning + tier throttling', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

    const depthRaymarine = await harness.pairDevice('custom-sensor', {
      settings: {
        path: 'environment.depth.belowTransducer',
        capability: 'measure_depth',
        unitCategory: 'distance_m',
        sourceFilter: 'n2k.raymarine.11',
        throttleTier: 'fast',
      },
      capabilities: ['measure_depth'],
    });

    const tempSaloonSlow = await harness.pairDevice('custom-sensor', {
      settings: {
        path: 'environment.inside.saloon.temperature',
        capability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        sourceFilter: 'openplotter.1wire.saloon',
        throttleTier: 'slow',
      },
      capabilities: ['measure_temperature'],
    });

    const swMulti = await harness.pairDevice('digital-switch', {
      store: { switchId: 'multiSourceSwitch', basePath: 'electrical.switches.multiSourceSwitch' },
      settings: { sourceFilter: 'n2k.switchbank.1' },
      capabilities: ['onoff'],
    });

    await waitForWs();
    assert.equal(mockServer.getActiveWebSocketCount(), 1);

    // Emit competing $sources for depth
    mockServer.emitDelta({ path: 'environment.depth.belowTransducer', value: 18.5, $source: 'n2k.garmin.22' });
    mockServer.emitDelta({ path: 'environment.depth.belowTransducer', value: 6.4, $source: 'n2k.raymarine.11' });

    // Burst 10 updates to slow-throttled saloon temperature
    for (let i = 0; i < 10; i++) {
      mockServer.emitDelta({
        path: 'environment.inside.saloon.temperature',
        value: 294.15 + i * 0.5,
        $source: 'openplotter.1wire.saloon',
      });
    }

    // Actuate multi-source switch using pinned sourceFilter
    await swMulti.triggerCapabilityListener('onoff', true);
    await waitForWs();

    assert.equal(depthRaymarine.getCapabilityValue('measure_depth'), 6.4);
    assert.ok(tempSaloonSlow.capabilityHistory.length <= 2);
    assert.equal(tempSaloonSlow.getCapabilityValue('measure_temperature'), 21);
    assert.equal(swMulti.getCapabilityValue('onoff'), true);
    assert.ok(
      mockServer.recordedPuts.some(
        (p) => p.path === 'electrical.switches.multiSourceSwitch.state' && p.source === 'n2k.switchbank.1',
      ),
    );
  });

  test('CF-04 (F6 + F12 + F14): Safety blocklist + async 202 PENDING completion & 502 FAILED rollback', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

    const deckLight = await harness.pairDevice('digital-switch', {
      store: { switchId: 'deckLight', basePath: 'electrical.switches.deckLight' },
      capabilities: ['onoff'],
    });
    await deckLight.setCapabilityValue('onoff', false);
    await waitForWs();

    // Safety boundary blocks autopilot & propulsion via Flow action before any network call
    await assert.rejects(
      () =>
        harness.homey.flow.runAction('put_signalk_path', {
          path: 'steering.autopilot.target.headingTrue',
          value: 2.1,
        }),
      (err) => err instanceof SafetyBoundaryError,
    );
    assert.equal(mockServer.getPutRequestLog().length, 0);

    // Async 202 -> 200 success updates switch
    mockServer.setPutBehavior('electrical.switches.deckLight.state', {
      mode: 'ASYNC_202_COMPLETE',
      delayMs: 50,
    });
    await deckLight.triggerCapabilityListener('onoff', true);
    assert.equal(deckLight.getCapabilityValue('onoff'), true);

    // Async 202 -> 502 failure rolls back optimistic state
    mockServer.setPutBehavior('electrical.switches.deckLight.state', {
      mode: 'ASYNC_202_FAIL_502',
      delayMs: 50,
      message: 'N2K bus timeout',
    });
    await assert.rejects(
      () => deckLight.triggerCapabilityListener('onoff', false),
      (err) => err.statusCode === 502 && /N2K bus timeout/i.test(err.message),
    );
    assert.equal(deckLight.getCapabilityValue('onoff'), true);
  });

  test('CF-05 (F3 + F6 + F7): Anchor Watch 405 plugin fallback + seamless Haversine GPS drift fallback', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    mockServer.setAnchorPutDisabled(true);

    const vessel = await harness.pairDevice('vessel', {
      settings: { anchor_max_radius: 30 },
    });
    await waitForWs();

    await vessel.triggerCapabilityListener('onoff.anchor_armed', true);
    await waitForWs();

    assert.equal(vessel.getCapabilityValue('onoff.anchor_armed'), true);
    assert.deepEqual(
      mockServer.recordedPluginCalls.map((c) => c.action),
      ['dropAnchor', 'setRadius', 'setRodeLength'],
    );

    // Simulate plugin failing to publish currentRadius while GPS position drifts ~55m North
    mockServer.emitDelta([
      { path: 'navigation.anchor.currentRadius', value: null },
      { path: 'navigation.position', value: { latitude: 59.3298, longitude: 18.0686 } },
    ]);
    await waitForWs();

    assert.equal(vessel._lastDriftStatus.source, 'haversine_fallback');
    assert.ok(vessel.getCapabilityValue('measure_anchor_distance') > 30);
    assert.equal(vessel.getCapabilityValue('alarm_generic'), true);
    assert.ok(harness.homey.flow.triggeredHistory.some((t) => t.cardId === 'anchor_drag_alarm'));

    await vessel.triggerCapabilityListener('onoff.anchor_armed', false);
    assert.equal(vessel.getCapabilityValue('onoff.anchor_armed'), false);
    assert.equal(vessel.getCapabilityValue('alarm_generic'), false);
    assert.equal(mockServer.recordedPluginCalls.at(-1).action, 'raiseAnchor');
  });

  test('CF-06 (F2 + F7 + F14): UnitConverter speed setting + live WS delta -> path trigger -> condition -> switch PUT', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    const vessel = await harness.pairDevice('vessel');
    const navLights = await harness.pairDevice('digital-switch', {
      store: { switchId: 'navLights', basePath: 'electrical.switches.navLights' },
      capabilities: ['onoff'],
    });
    await waitForWs();

    await vessel.simulateUserSettingsChange({ speed_unit: 'km/h' });

    let automationExecuted = false;
    harness.homey.flow.onTrigger('path_value_updated', async (record) => {
      if (record.tokens.path === 'navigation.speedOverGround') {
        const fastEnough = await harness.homey.flow.evaluateCondition('path_value_comparison', {
          path: 'navigation.speedOverGround',
          operator: '>',
          value: 4.5,
        });
        if (fastEnough) {
          await harness.homey.flow.runAction('put_signalk_path', {
            path: 'electrical.switches.navLights.state',
            value: true,
          });
          automationExecuted = true;
        }
      }
    });

    mockServer.emitDelta({ path: 'navigation.speedOverGround', value: 5.0 }); // 18.0 km/h
    await waitForWs(80);

    assert.equal(automationExecuted, true);
    assert.equal(vessel.getCapabilityValue('measure_sog'), 18);
    assert.equal(navLights.getCapabilityValue('onoff'), true);
  });

  test('CF-07 (F2 + F5 + F13): Homey sensor -> SI conversion (C->K, %->ratio, hPa->Pa) -> WS delta -> paired Signal K sensors', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

    const cabinTemp = await harness.pairDevice('custom-sensor', {
      settings: {
        path: 'environment.inside.mainCabin.temperature',
        capability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'fast',
      },
      capabilities: ['measure_temperature'],
    });
    const cabinHum = await harness.pairDevice('custom-sensor', {
      settings: {
        path: 'environment.inside.mainCabin.relativeHumidity',
        capability: 'measure_humidity',
        unitCategory: 'ratio_to_percent',
        throttleTier: 'fast',
      },
      capabilities: ['measure_humidity'],
    });
    const cabinPres = await harness.pairDevice('custom-sensor', {
      settings: {
        path: 'environment.inside.mainCabin.pressure',
        capability: 'measure_pressure',
        unitCategory: 'pressure_pa_to_hpa',
        throttleTier: 'fast',
      },
      capabilities: ['measure_pressure'],
    });
    await waitForWs();

    await harness.homey.flow.runAction('publish_temperature_to_signalk', {
      zone: 'mainCabin',
      value: 22.4,
      source: 'zigbee.aqara.cabin',
    });
    await harness.homey.flow.runAction('publish_humidity_to_signalk', {
      zone: 'mainCabin',
      value: 56.5,
      source: 'zigbee.aqara.cabin',
    });
    await harness.homey.flow.runAction('publish_pressure_to_signalk', {
      zone: 'mainCabin',
      value: 1014.6,
      source: 'zigbee.aqara.cabin',
    });
    await waitForWs(60);

    assert.equal(mockServer.receivedHomeyDeltas.length, 3);
    assert.equal(mockServer.getTreeNode('environment.inside.mainCabin.temperature').value, 295.55);
    assert.equal(mockServer.getTreeNode('environment.inside.mainCabin.relativeHumidity').value, 0.565);
    assert.equal(mockServer.getTreeNode('environment.inside.mainCabin.pressure').value, 101460);

    // Server broadcasts inbound Homey deltas back to subscribed devices
    assert.equal(cabinTemp.getCapabilityValue('measure_temperature'), 22.4);
    assert.equal(cabinHum.getCapabilityValue('measure_humidity'), 56.5);
    assert.equal(cabinPres.getCapabilityValue('measure_pressure'), 1014.6);
  });

  test('CF-08 (F5 + F13 + F14): Homey security notification bridge -> Signal K -> signalk_notification_raised -> clear', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    await waitForWs();

    await harness.homey.flow.runAction('raise_signalk_notification', {
      category: 'security',
      item: 'forwardHatch',
      state: 'alarm',
      message: 'Forward hatch opened while moored',
    });
    await waitForWs(60);

    assert.equal(
      await harness.homey.flow.evaluateCondition('is_alarm_active', {
        path: 'notifications.security.forwardHatch',
      }),
      true,
    );
    assert.ok(
      harness.homey.flow.triggeredHistory.some(
        (t) =>
          t.cardId === 'signalk_notification_raised' &&
          t.tokens.path === 'notifications.security.forwardHatch' &&
          t.tokens.state === 'alarm',
      ),
    );

    await harness.homey.flow.runAction('clear_signalk_notification', {
      category: 'security',
      item: 'forwardHatch',
    });
    await waitForWs(60);

    assert.equal(
      await harness.homey.flow.evaluateCondition('is_alarm_active', {
        path: 'notifications.security.forwardHatch',
      }),
      false,
    );
  });

  test('CF-09 (F6 + F10 + F14): Battery SOC drop -> trigger -> condition -> MultiPlus inverter eco PUT -> device update', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

    const houseBank = await harness.pairDevice('electrical-bank', {
      store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
    });
    const inverter = await harness.pairDevice('electrical-bank', {
      store: { bankType: 'inverter', bankId: '0', basePath: 'electrical.inverters.0' },
      capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
    });
    await waitForWs();

    let shedHandled = false;
    harness.homey.flow.onTrigger('battery_soc_below_threshold', async (record) => {
      if (record.tokens.threshold === 30) {
        const isLow = await harness.homey.flow.evaluateCondition('is_battery_soc_below', {
          device: houseBank,
          threshold: 35,
        });
        if (isLow) {
          await harness.homey.flow.runAction('set_charger_inverter_mode', {
            bankId: '0',
            mode: 'eco',
          });
          shedHandled = true;
        }
      }
    });

    mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.45 });
    await waitForWs();
    clearClientThrottle(harness);

    mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.28 });
    await waitForWs(80);

    assert.equal(shedHandled, true);
    assert.equal(houseBank.getCapabilityValue('measure_battery'), 28);
    assert.equal(inverter.getCapabilityValue('charger_inverter_mode'), 'eco');
  });

  test('CF-10 (F6 + F8 + F14): Propulsion read-only boundary + live N2K engine metrics + overheat alarm notification chain', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    const portEngine = await harness.pairDevice('propulsion', {
      data: { engineId: 'port' },
      store: { engineId: 'port' },
    });
    await waitForWs();

    await assert.rejects(
      () => harness.putController.putPath('boat-1', 'propulsion.port.revolutions', 30),
      (err) => err instanceof SafetyBoundaryError,
    );

    mockServer.emitDelta([
      { path: 'propulsion.port.revolutions', value: 38 }, // 2280 RPM
      { path: 'propulsion.port.coolantTemperature', value: 371.15 }, // 98.0 °C
      { path: 'propulsion.port.oilPressure', value: 310000 }, // 3.1 bar
      {
        path: 'notifications.propulsion.port.overTemperature',
        value: { state: 'alarm', method: ['sound'], message: 'Coolant temp high' },
      },
    ]);
    await waitForWs(60);

    assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 2280);
    assert.equal(portEngine.getCapabilityValue('measure_temperature'), 98);
    assert.equal(portEngine.getCapabilityValue('measure_oil_pressure'), 3.1);
    assert.equal(portEngine.getCapabilityValue('alarm_generic'), true);
    assert.equal(
      await harness.homey.flow.evaluateCondition('is_alarm_active', { device: portEngine }),
      true,
    );
    assert.ok(
      harness.homey.flow.triggeredHistory.some(
        (t) =>
          t.cardId === 'signalk_notification_raised' &&
          t.tokens.path === 'notifications.propulsion.port.overTemperature',
      ),
    );
  });

  test('CF-11 (F4 + F5 + F7 + F10): mDNS IP/port change migrates shared WS pool across vessel and battery devices', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    const vessel = await harness.pairDevice('vessel', { id: VESSEL_SELF_URN });
    const houseBank = await harness.pairDevice('electrical-bank', {
      store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
    });
    await waitForWs();

    const server2 = new MockSignalKServer();
    await server2.start();
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
        port: server2.port,
      });
      await waitForWs(60);

      assert.ok(server2.getActiveWebSocketCount() >= 1);
      assert.equal(vessel.getStoreValue('port'), server2.port);

      clearClientThrottle(harness);
      server2.emitDelta([
        { path: 'navigation.speedOverGround', value: 3.086667 }, // 6.0 kn
        { path: 'electrical.batteries.house.voltage', value: 13.62 },
      ]);
      await waitForWs(60);

      assert.equal(vessel.getCapabilityValue('measure_sog'), 6);
      assert.equal(houseBank.getCapabilityValue('measure_voltage'), 13.62);
    } finally {
      await server2.stop();
    }
  });

  test('CF-12 (F2 + F11 + F14): Fluid tank level->volume derivation + high/low alarms + is_alarm_active condition', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

    const fwTank = await harness.pairDevice('fluid-tank', {
      store: {
        tankType: 'freshWater',
        tankId: '0',
        basePath: 'tanks.freshWater.0',
        capacityLiters: 200,
      },
      capabilities: ['measure_tank_level', 'measure_tank_volume', 'meter_water', 'alarm_generic'],
    });
    const bwTank = await harness.pairDevice('fluid-tank', {
      store: {
        tankType: 'blackWater',
        tankId: '0',
        basePath: 'tanks.blackWater.0',
        capacityLiters: 80,
      },
      capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic', 'alarm_water'],
    });
    await waitForWs();

    mockServer.emitDelta([
      { path: 'tanks.freshWater.0.currentLevel', value: 0.1 }, // 10% -> 20 L -> low alarm
      { path: 'tanks.blackWater.0.currentLevel', value: 0.9 }, // 90% -> 72 L -> high alarm
    ]);
    await waitForWs(60);

    assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 10);
    assert.equal(fwTank.getCapabilityValue('measure_tank_volume'), 20);
    assert.equal(fwTank.getCapabilityValue('meter_water'), 0.02);
    assert.equal(fwTank.getCapabilityValue('alarm_generic'), true);

    assert.equal(bwTank.getCapabilityValue('measure_tank_level'), 90);
    assert.equal(bwTank.getCapabilityValue('measure_tank_volume'), 72);
    assert.equal(bwTank.getCapabilityValue('alarm_generic'), true);
    assert.equal(bwTank.getCapabilityValue('alarm_water'), true);

    assert.equal(await harness.homey.flow.evaluateCondition('is_alarm_active', { device: fwTank }), true);
    assert.equal(await harness.homey.flow.evaluateCondition('is_alarm_active', { device: bwTank }), true);
  });

  test('CF-13 (F5 + F12 + F13): Bidirectional switch bridge + dimmer dimmingLevel PUT syncing .state', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

    const heater = await harness.pairDevice('digital-switch', {
      store: { switchId: 'dieselHeater', basePath: 'electrical.switches.dieselHeater' },
      capabilities: ['onoff'],
    });
    const dimmer = await harness.pairDevice('digital-switch', {
      store: { switchId: 'saloonDimmer', basePath: 'electrical.switches.saloonDimmer' },
      capabilities: ['onoff', 'dim'],
    });
    await waitForWs();

    // Homey Flow bridge publishes Shelly heater relay state into Signal K
    await harness.homey.flow.runAction('publish_switch_state_to_signalk', {
      switchId: 'dieselHeater',
      state: true,
      source: 'shelly.12v.heater',
    });
    await waitForWs();
    assert.equal(heater.getCapabilityValue('onoff'), true);

    // Dimmer PUT to 0.0 automatically syncs state = false via Signal K delta
    await dimmer.triggerCapabilityListener('dim', 0.45);
    await waitForWs();
    assert.equal(dimmer.getCapabilityValue('dim'), 0.45);
    assert.equal(dimmer.getCapabilityValue('onoff'), true);

    await dimmer.triggerCapabilityListener('dim', 0);
    await waitForWs();
    assert.equal(dimmer.getCapabilityValue('dim'), 0);
    assert.equal(dimmer.getCapabilityValue('onoff'), false);
  });

  test('CF-14 (F7 + F12 + F14): Trigger -> Condition -> Action chain (navigation_state_changed -> anchored -> arm anchor + anchorLight)', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    const vessel = await harness.pairDevice('vessel');
    const anchorLight = await harness.pairDevice('digital-switch', {
      store: { switchId: 'anchorLight', basePath: 'electrical.switches.anchorLight' },
      capabilities: ['onoff'],
    });
    await anchorLight.setCapabilityValue('onoff', false);
    await waitForWs();

    mockServer.emitDelta({ path: 'navigation.state', value: 'sailing' });
    await waitForWs();

    let arrivalExecuted = false;
    harness.homey.flow.onTrigger('navigation_state_changed', async (record) => {
      if (record.tokens.state === 'anchored') {
        const isAnchored = await harness.homey.flow.evaluateCondition('is_vessel_state', {
          device: vessel,
          state: 'anchored',
        });
        const alreadyArmed = await harness.homey.flow.evaluateCondition('is_anchor_armed', {
          device: vessel,
        });
        if (isAnchored && !alreadyArmed) {
          await harness.homey.flow.runAction('arm_anchor_watch', { maxRadius: 42, rodeLength: 35 });
          await harness.homey.flow.runAction('put_signalk_path', {
            path: 'electrical.switches.anchorLight.state',
            value: true,
          });
          arrivalExecuted = true;
        }
      }
    });

    clearClientThrottle(harness);
    mockServer.emitDelta({ path: 'navigation.state', value: 'anchored' });
    await waitForWs(80);

    assert.equal(arrivalExecuted, true);
    assert.equal(vessel.getCapabilityValue('onoff.anchor_armed'), true);
    assert.equal(vessel.getCapabilityValue('measure_anchor_radius'), 42);
    assert.equal(anchorLight.getCapabilityValue('onoff'), true);
  });

  test('CF-15 (F2 + F10 + F14): Shore power loss trigger + W=V*I battery power fallback + load shedding', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    const starterBank = await harness.pairDevice('electrical-bank', {
      store: { bankType: 'battery', bankId: 'starter', basePath: 'electrical.batteries.starter' },
    });
    const waterHeater = await harness.pairDevice('digital-switch', {
      store: { switchId: 'waterHeater', basePath: 'electrical.switches.waterHeater' },
      capabilities: ['onoff'],
    });
    await waterHeater.setCapabilityValue('onoff', true);
    await waitForWs();

    let shoreLostHandled = false;
    harness.homey.flow.onTrigger('shore_power_status_changed', async (record) => {
      if (record.tokens.connected === false) {
        await harness.homey.flow.runAction('put_signalk_path', {
          path: 'electrical.switches.waterHeater.state',
          value: false,
        });
        shoreLostHandled = true;
      }
    });

    mockServer.emitDelta([
      { path: 'electrical.ac.0.phaseA.voltage', value: 0 },
      { path: 'electrical.batteries.starter.voltage', value: 12.5 },
      { path: 'electrical.batteries.starter.current', value: -12.0 },
    ]);
    await waitForWs(80);

    assert.equal(shoreLostHandled, true);
    assert.equal(waterHeater.getCapabilityValue('onoff'), false);
    assert.equal(starterBank.getCapabilityValue('measure_power'), -150);
  });

  test('CF-16 (F2 + F5 + F9): custom-sensor live onSettings rebinds path, unitCategory, $source & throttle tier', async () => {
    await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
    const sensor = await harness.pairDevice('custom-sensor', {
      settings: {
        path: 'environment.inside.saloon.temperature',
        capability: 'measure_temperature',
        unitCategory: 'temperature_k_to_c',
        throttleTier: 'slow',
      },
      capabilities: ['measure_temperature', 'measure_humidity'],
    });
    await waitForWs();

    mockServer.emitDelta({ path: 'environment.inside.saloon.temperature', value: 294.15 });
    await waitForWs();
    assert.equal(sensor.getCapabilityValue('measure_temperature'), 21);

    await sensor.simulateUserSettingsChange({
      path: 'environment.inside.forwardCabin.relativeHumidity',
      capability: 'measure_humidity',
      unitCategory: 'ratio_to_percent',
      sourceFilter: 'ble.ruuvitag.f4a2',
      throttleTier: 'fast',
    });
    await waitForWs();

    // Unpinned source ignored; pinned RuuviTag source accepted immediately
    mockServer.emitDelta({
      path: 'environment.inside.forwardCabin.relativeHumidity',
      value: 0.99,
      $source: 'wrong.source',
    });
    mockServer.emitDelta({
      path: 'environment.inside.forwardCabin.relativeHumidity',
      value: 0.615,
      $source: 'ble.ruuvitag.f4a2',
    });
    await waitForWs();

    assert.equal(sensor.getCapabilityValue('measure_humidity'), 61.5);
  });
});
