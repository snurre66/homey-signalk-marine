import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MockSignalKServer } from './harness/mock_signalk_server.mjs';
import {
  HomeyRuntimeHarness,
  MockPairSession,
  MockRepairSession,
} from './harness/homey_runtime_harness.mjs';
import { VESSEL_SELF_URN, VESSEL_UUID } from './harness/fixtures.mjs';

/**
 * Helper to wait briefly for asynchronous WebSocket frame delivery.
 */
const waitForWs = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Tier 1 — Feature Coverage Happy-Path E2E Suite (F1–F15)', () => {
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
    mockServer.reset();
    harness = new HomeyRuntimeHarness();
  });

  // ===========================================================================
  // Feature F1: .homeycompose Modular App Manifest & App Store Assets (5 tests)
  // ===========================================================================
  describe('F1: .homeycompose Modular App Manifest & App Store Assets', () => {
    test('F1-T1-01: Root manifest metadata meets Homey SDK v3 local platform specification', () => {
      const { manifest } = harness.loadAppManifest();
      assert.equal(manifest.id, 'com.signalk.marine');
      assert.equal(manifest.sdk, 3);
      assert.deepEqual(manifest.platforms, ['local']);
      assert.equal(manifest.compatibility, '>=5.0.0');

      const appName = manifest.name.en;
      const wordCount = appName.trim().split(/\s+/).length;
      assert.ok(wordCount <= 4, `Expected <= 4 words in app name, got "${appName}"`);
      assert.equal(/\b(homey|athom)\b/i.test(appName), false);
    });

    test('F1-T1-02: Manifest complies with App Store Guideline 1.15 (zero restricted permissions)', () => {
      const { manifest } = harness.loadAppManifest();
      const perms = manifest.permissions || [];
      assert.equal(
        perms.includes('homey:manager:api'),
        false,
        'Manifest must not request restricted homey:manager:api permission',
      );
    });

    test('F1-T1-03: All 6 modular drivers are declared with valid classes, capabilities, and Homey Energy metadata', () => {
      const { manifest } = harness.loadAppManifest();
      const drivers = manifest.drivers || [];
      const driverIds = drivers.map((d) => d.id).sort();
      assert.deepEqual(
        driverIds,
        ['custom-sensor', 'digital-switch', 'electrical-bank', 'fluid-tank', 'propulsion', 'vessel'],
      );

      const elec = drivers.find((d) => d.id === 'electrical-bank');
      assert.ok(elec.energy, 'electrical-bank driver must define Homey Energy metadata');

      const prop = drivers.find((d) => d.id === 'propulsion');
      assert.equal(prop.capabilities.includes('onoff'), false);
      assert.equal(prop.capabilities.includes('dim'), false);

      const sw = drivers.find((d) => d.id === 'digital-switch');
      assert.ok(sw.capabilities.includes('onoff'));
    });

    test('F1-T1-04: All 18 custom maritime capabilities and mDNS-SD discovery strategy are properly defined', () => {
      const { manifest } = harness.loadAppManifest();
      const requiredCaps = [
        'measure_sog',
        'measure_stw',
        'measure_depth',
        'measure_heading',
        'measure_cog',
        'measure_tank_level',
        'measure_tank_volume',
        'measure_anchor_distance',
        'measure_anchor_radius',
        'measure_remaining_ah',
        'measure_time_remaining',
        'measure_engine_rpm',
        'measure_engine_hours',
        'measure_fuel_rate',
        'measure_oil_pressure',
        'navigation_state',
        'autopilot_state',
        'charger_inverter_mode',
      ];
      for (const capId of requiredCaps) {
        assert.ok(manifest.capabilities[capId], `Missing custom capability: ${capId}`);
        assert.equal(typeof manifest.capabilities[capId].type, 'string');
        assert.equal(typeof manifest.capabilities[capId].title?.en, 'string');
      }

      const disc = manifest.discovery?.signalk;
      assert.ok(disc);
      assert.equal(disc.type, 'mdns-sd');
      assert.equal(disc['mdns-sd'].name, 'signalk-http');
      assert.equal(disc['mdns-sd'].protocol, 'tcp');
    });

    test('F1-T1-05: App Store assets (SVG icons, PNG dimensions, plain-text README.txt, .homeychangelog.json) pass publish rules', () => {
      const pubRes = harness.validatePublishLevel();
      assert.equal(pubRes.valid, true);
      assert.equal(pubRes.driverCount, 6);

      const assetRes = harness.validateAppStoreAssets();
      assert.equal(assetRes.valid, true);
    });
  });

  // ===========================================================================
  // Feature F2: Deterministic SI <-> Marine Unit Converter (6 tests)
  // ===========================================================================
  describe('F2: Deterministic SI <-> Marine Unit Converter (UnitConverter)', () => {
    test('F2-T1-01: Converts temperatures bidirectionally between Kelvin (K) and Celsius (°C)', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(294.65, 'temperature_k_to_c', 2), 21.5);
      assert.equal(uc.fromSignalK(273.15, 'temperature_k_to_c', 2), 0);
      assert.equal(uc.fromSignalK(358.15, 'temperature_k_to_c', 2), 85);
      assert.equal(uc.toSignalK(21.5, 'temperature_k_to_c'), 294.65);
    });

    test('F2-T1-02: Converts speeds bidirectionally between m/s and knots (kn), km/h, and m/s', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.convertSpeedFromSI(1852 / 3600 * 10, 'kn', 2), 10);
      assert.equal(uc.convertSpeedFromSI(10, 'km/h', 1), 36);
      assert.equal(uc.convertSpeedFromSI(7.5, 'm/s', 2), 7.5);
      assert.ok(Math.abs(uc.convertSpeedToSI(10, 'kn') - 5.144444) < 0.0001);
      assert.equal(uc.convertSpeedToSI(36, 'km/h'), 10);
    });

    test('F2-T1-03: Converts atmospheric pressure (Pa <-> hPa/mbar) and engine pressure (Pa <-> bar / kPa)', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(101325, 'pressure_pa_to_hpa', 2), 1013.25);
      assert.equal(uc.fromSignalK(350000, 'pressure_pa_to_bar', 2), 3.5);
      assert.equal(uc.fromSignalK(350000, 'pressure_pa_to_kpa', 1), 350);
      assert.equal(uc.toSignalK(1013.25, 'pressure_pa_to_hpa'), 101325);
      assert.equal(uc.toSignalK(3.4, 'pressure_pa_to_bar'), 340000);
    });

    test('F2-T1-04: Converts electrical charge (Coulombs <-> Ah), energy (Joules <-> kWh), and ratios (0..1 <-> 0..100%)', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(720000, 'charge_c_to_ah', 1), 200);
      assert.equal(uc.fromSignalK(3600000, 'energy_j_to_kwh', 2), 1);
      assert.equal(uc.fromSignalK(0.85, 'ratio_to_percent', 1), 85);
      assert.equal(uc.toSignalK(200, 'charge_c_to_ah'), 720000);
      assert.equal(uc.toSignalK(62, 'ratio_to_percent'), 0.62);
    });

    test('F2-T1-05: Converts unsigned headings [0, 360) and signed wind/attitude angles [-180, +180] from radians', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(Math.PI, 'angle_rad_to_deg_unsigned', 1), 180);
      assert.equal(uc.fromSignalK(1.5 * Math.PI, 'angle_rad_to_deg_unsigned', 1), 270);
      assert.equal(uc.fromSignalK(-Math.PI / 4, 'angle_rad_to_deg_signed', 1), -45);
      assert.equal(uc.fromSignalK(Math.PI / 2, 'angle_rad_to_deg_signed', 1), 90);
    });

    test('F2-T1-06: Converts engine frequency (Hz <-> RPM), tank volume (m3 <-> L), fuel flow (m3/s <-> L/h), and duration (s <-> h/min)', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(40, 'frequency_hz_to_rpm', 0), 2400);
      assert.equal(uc.fromSignalK(0.25, 'volume_m3_to_l', 1), 250);
      assert.equal(uc.fromSignalK(0.000001, 'flow_m3s_to_lh', 2), 3.6);
      assert.equal(uc.fromSignalK(18000, 'duration_s_to_h', 1), 5);
      assert.equal(uc.fromSignalK(18000, 'duration_s_to_min', 1), 300);
    });
  });

  // ===========================================================================
  // Feature F3: Built-in Haversine GPS Anchor Drift Calculator (5 tests)
  // ===========================================================================
  describe('F3: Built-in Haversine GPS Anchor Drift Calculator (AnchorWatchCalculator)', () => {
    test('F3-T1-01: Computes exact Haversine distance in meters between anchor drop and vessel GPS coordinates', () => {
      const calc = harness.anchorCalculator;
      const anchor = { latitude: 59.3293, longitude: 18.0686 };
      const vessel = { latitude: 59.32975, longitude: 18.0686 };
      const dist = calc.calculateHaversineDistanceMeters(anchor, vessel);
      assert.ok(dist >= 49.5 && dist <= 50.5, `Expected ~50.04m, got ${dist}m`);
    });

    test('F3-T1-02: Computes accurate true bearing across all 4 compass quadrants (N, E, S, W)', () => {
      const calc = harness.anchorCalculator;
      const origin = { latitude: 0, longitude: 0 };
      assert.equal(calc.calculateBearingDegrees(origin, { latitude: 0.001, longitude: 0 }), 0);
      assert.equal(calc.calculateBearingDegrees(origin, { latitude: 0, longitude: 0.001 }), 90);
      assert.equal(calc.calculateBearingDegrees(origin, { latitude: -0.001, longitude: 0 }), 180);
      assert.equal(calc.calculateBearingDegrees(origin, { latitude: 0, longitude: -0.001 }), 270);
    });

    test('F3-T1-03: Evaluates drift using Signal K plugin radius when plugin data is present (source: "plugin")', () => {
      const calc = harness.anchorCalculator;
      const status = calc.evaluateDrift({
        armed: true,
        anchorPosition: { latitude: 59.3293, longitude: 18.0686 },
        vesselPosition: { latitude: 59.3295, longitude: 18.0686 },
        pluginCurrentRadiusMeters: 22.5,
        maxRadiusMeters: 40,
        rodeLengthMeters: 30,
      });
      assert.equal(status.source, 'plugin');
      assert.equal(status.currentRadiusMeters, 22.5);
      assert.equal(status.isDragging, false);
    });

    test('F3-T1-04: Automatically falls back to built-in Haversine calculator when plugin radius is absent (source: "haversine_fallback")', () => {
      const calc = harness.anchorCalculator;
      const status = calc.evaluateDrift({
        armed: true,
        anchorPosition: { latitude: 59.3293, longitude: 18.0686 },
        vesselPosition: { latitude: 59.3295, longitude: 18.0686 },
        pluginCurrentRadiusMeters: null,
        maxRadiusMeters: 40,
      });
      assert.equal(status.source, 'haversine_fallback');
      assert.ok(status.currentRadiusMeters >= 21.5 && status.currentRadiusMeters <= 23.0);
      assert.equal(status.bearingTrueDegrees, 0);
      assert.equal(status.isDragging, false);
    });

    test('F3-T1-05: Triggers isDragging = true when vessel drifts beyond maxRadiusMeters in either plugin or Haversine mode', () => {
      const calc = harness.anchorCalculator;
      const status = calc.evaluateDrift({
        armed: true,
        anchorPosition: { latitude: 59.3293, longitude: 18.0686 },
        vesselPosition: { latitude: 59.32985, longitude: 18.0686 }, // ~61m North
        pluginCurrentRadiusMeters: null,
        maxRadiusMeters: 35,
      });
      assert.equal(status.source, 'haversine_fallback');
      assert.ok(status.currentRadiusMeters > 35);
      assert.equal(status.isDragging, true);
    });
  });

  // ===========================================================================
  // Feature F4: Signal K Discovery, Auth & Access Request Manager (5 tests)
  // ===========================================================================
  describe('F4: Signal K Discovery, Auth & Access Request Manager (SignalKAuthManager)', () => {
    test('F4-T1-01: Queries GET /signalk discovery endpoint and resolves v1 REST and WebSocket URLs', async () => {
      const disc = await harness.authManager.discoverServer({
        host: mockServer.host,
        port: mockServer.port,
        useTls: false,
      });
      assert.equal(disc.version, '1.7.0');
      assert.equal(disc.server.id, 'signalk-server-node');
      assert.ok(disc.signalkHttpUrl.endsWith('/signalk/v1/api/'));
      assert.ok(disc.signalkWsUrl.endsWith('/signalk/v1/stream'));
    });

    test('F4-T1-02: Submits POST /signalk/v1/access/requests with persistent UUIDv4 clientId and readwrite permissions', async () => {
      const res = await harness.authManager.requestAccess(
        { host: mockServer.host, port: mockServer.port },
        { clientId: VESSEL_UUID, description: 'Homey Pro Smart Boat Hub' },
      );
      assert.equal(res.state, 'PENDING');
      assert.equal(res.statusCode, 202);
      assert.ok(res.requestId);
      assert.ok(res.href.startsWith('/signalk/v1/access/requests/'));
    });

    test('F4-T1-03: Polls pending access request href until APPROVED and extracts JWT Bearer token', async () => {
      const reqRes = await harness.authManager.requestAccess({
        host: mockServer.host,
        port: mockServer.port,
      });

      setTimeout(() => {
        mockServer.approveAccessRequest(reqRes.requestId, 'jwt-marine-token-123');
      }, 60);

      const pollRes = await harness.authManager.pollAccessRequest(
        { host: mockServer.host, port: mockServer.port },
        reqRes.href,
      );
      assert.equal(pollRes.state, 'COMPLETED');
      assert.equal(pollRes.permission, 'APPROVED');
      assert.equal(pollRes.token, 'jwt-marine-token-123');
    });

    test('F4-T1-04: Reuses persistent clientId across multiple pairing/repair requests from Homey settings', async () => {
      const r1 = await harness.authManager.requestAccess({
        host: mockServer.host,
        port: mockServer.port,
      });
      const r2 = await harness.authManager.requestAccess({
        host: mockServer.host,
        port: mockServer.port,
      });
      assert.equal(r1.clientId, r2.clientId);
      assert.equal(harness.homey.settings.get('signalk_client_id'), r1.clientId);
    });

    test('F4-T1-05: Supports unauthenticated read-only connection fallback and pre-generated JWT token validation', async () => {
      const roRes = await harness.authManager.validateConnection({
        host: mockServer.host,
        port: mockServer.port,
        token: null,
        allowReadonly: true,
      });
      assert.equal(roRes.ok, true);
      assert.equal(roRes.readonly, true);
      assert.equal(roRes.vessel.name, 'S/Y Northern Star');

      const authRes = await harness.authManager.validateConnection({
        host: mockServer.host,
        port: mockServer.port,
        token: 'default-readwrite-token',
      });
      assert.equal(authRes.ok, true);
      assert.equal(authRes.authenticated, true);
    });
  });

  // ===========================================================================
  // Feature F5: Shared Multiplexed WebSocket & REST Connection Pool (5 tests)
  // ===========================================================================
  describe('F5: Shared Multiplexed WebSocket & REST Connection Pool (SignalKConnectionPool)', () => {
    test('F5-T1-01: Opens a single shared WebSocket connection with ?subscribe=none across multiple subscribed devices', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const paths = [
        'navigation.speedOverGround',
        'electrical.batteries.house.voltage',
        'tanks.freshWater.0.currentLevel',
        'electrical.switches.anchorLight.state',
        'propulsion.port.revolutions',
        'environment.inside.engineRoom.temperature',
      ];
      for (let i = 0; i < paths.length; i++) {
        harness.connectionPool.subscribe('boat-1', {
          subscriberId: `dev-${i}`,
          path: paths[i],
          tier: 'medium',
          onUpdate: () => {},
        });
      }
      await waitForWs();
      assert.equal(mockServer.getActiveWebSocketCount(), 1);
    });

    test('F5-T1-02: Normalizes incoming delta context matching hello.self URN as well as "vessels.self"', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const received = [];
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-urn',
        path: 'navigation.speedOverGround',
        tier: 'fast',
        onUpdate: (u) => received.push(u),
      });
      await waitForWs();

      mockServer.emitDelta(
        { path: 'navigation.speedOverGround', value: 4.5, $source: 'n2k.115' },
        { context: VESSEL_SELF_URN },
      );
      await waitForWs();
      assert.equal(received.length, 1);
      assert.equal(received[0].value, 4.5);
    });

    test('F5-T1-03: Enforces 3-tier subscription throttling policies (Fast 200ms, Medium 2000ms, Slow 5000ms)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const slowUpdates = [];

      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-fast',
        path: 'notifications.bilge.main',
        tier: 'fast',
        onUpdate: () => {},
      });
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-med',
        path: 'navigation.speedOverGround',
        tier: 'medium',
        onUpdate: () => {},
      });
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-slow',
        path: 'electrical.batteries.house.voltage',
        tier: 'slow',
        onUpdate: (u) => slowUpdates.push(u),
      });
      await waitForWs();

      const fastSub = mockServer.recordedSubscriptions.find((s) => s.path === 'notifications.bilge.main');
      const medSub = mockServer.recordedSubscriptions.find((s) => s.path === 'navigation.speedOverGround');
      const slowSub = mockServer.recordedSubscriptions.find((s) => s.path === 'electrical.batteries.house.voltage');

      assert.equal(fastSub.policy, 'instant');
      assert.equal(fastSub.minPeriod, 200);
      assert.equal(medSub.policy, 'ideal');
      assert.equal(medSub.period, 2000);
      assert.equal(slowSub.policy, 'ideal');
      assert.equal(slowSub.period, 5000);

      // Burst 5 deltas within 20ms on slow subscription
      for (let i = 0; i < 5; i++) {
        mockServer.emitDelta({ path: 'electrical.batteries.house.voltage', value: 13.0 + i * 0.1 });
      }
      await waitForWs();
      assert.equal(slowUpdates.length, 1, 'Slow tier throttle should deliver only leading delta during burst');
    });

    test('F5-T1-04: Filters incoming deltas by $source when sourceFilter is pinned on a subscription', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const subA = [];
      const subB = [];

      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-a',
        path: 'environment.depth.belowTransducer',
        tier: 'fast',
        sourceFilter: 'n2k.115',
        onUpdate: (u) => subA.push(u.value),
      });
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-b',
        path: 'environment.depth.belowTransducer',
        tier: 'fast',
        sourceFilter: 'n2k.200',
        onUpdate: (u) => subB.push(u.value),
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'environment.depth.belowTransducer', value: 8.5, $source: 'n2k.115' });
      mockServer.emitDelta({ path: 'environment.depth.belowTransducer', value: 14.2, $source: 'n2k.200' });
      await waitForWs();

      assert.deepEqual(subA, [8.5]);
      assert.deepEqual(subB, [14.2]);
    });

    test('F5-T1-05: Publishes outbound Homey sensor deltas over the authenticated WebSocket stream', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.connectionPool.publishDelta('boat-1', [
        {
          path: 'environment.inside.saloon.temperature',
          value: 294.65,
          $source: 'homey.zigbee',
        },
      ]);
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 1);
      const delta = mockServer.receivedHomeyDeltas[0];
      assert.equal(delta.context, 'vessels.self');
      assert.equal(delta.updates[0].$source, 'homey.zigbee');
      assert.deepEqual(delta.updates[0].values[0], {
        path: 'environment.inside.saloon.temperature',
        value: 294.65,
      });
    });
  });

  // ===========================================================================
  // Feature F6: Safety-Boundary Enforced PUT Control & Hardware Presets (5 tests)
  // ===========================================================================
  describe('F6: Safety-Boundary Enforced PUT Control & Hardware Presets (SignalKPutController)', () => {
    test('F6-T1-01: Executes synchronous 200 COMPLETED PUT on writable electrical.switches.* path', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const res = await harness.putController.putPath('boat-1', 'electrical.switches.anchorLight.state', true);
      assert.equal(res.state, 'COMPLETED');
      assert.equal(res.statusCode, 200);
      assert.equal(mockServer.recordedPuts.length, 1);
      assert.equal(mockServer.recordedPuts[0].path, 'electrical.switches.anchorLight.state');
      assert.equal(mockServer.recordedPuts[0].value, true);
    });

    test('F6-T1-02: Handles asynchronous 202 PENDING -> 200 COMPLETED PUT lifecycle on NMEA 2000 / Victron switches', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setPutBehavior('electrical.switches.venusRelay0.state', {
        mode: 'ASYNC_202_COMPLETE',
        delayMs: 60,
      });

      const res = await harness.putController.putPath('boat-1', 'electrical.switches.venusRelay0.state', true);
      assert.equal(res.state, 'COMPLETED');
      assert.equal(res.statusCode, 200);
    });

    test('F6-T1-03: Executes PUT on charger/inverter load-shedding modes and anchor watch maxRadius', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const r1 = await harness.putController.putPath('boat-1', 'electrical.inverters.0.inverterMode', 'chargerOnly');
      const r2 = await harness.putController.putPath('boat-1', 'electrical.chargers.0.currentLimit', 6);
      const r3 = await harness.putController.putPath('boat-1', 'navigation.anchor.maxRadius', 45);

      assert.equal(r1.statusCode, 200);
      assert.equal(r2.statusCode, 200);
      assert.equal(r3.statusCode, 200);
    });

    test('F6-T1-04: Automatically falls back to signalk-anchoralarm-plugin REST endpoints when PUT navigation.anchor.* returns 405', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setAnchorPutDisabled(true);

      const dropRes = await harness.putController.putPath('boat-1', 'navigation.anchor.position', {
        latitude: 59.3293,
        longitude: 18.0686,
      });
      const radRes = await harness.putController.putPath('boat-1', 'navigation.anchor.maxRadius', 40);
      const raiseRes = await harness.putController.putPath('boat-1', 'navigation.anchor.position', null);

      assert.equal(dropRes.statusCode, 200);
      assert.equal(radRes.statusCode, 200);
      assert.equal(raiseRes.statusCode, 200);

      const actions = mockServer.recordedPluginCalls.map((c) => c.action);
      assert.deepEqual(actions, ['dropAnchor', 'setRadius', 'raiseAnchor']);
    });

    test('F6-T1-05: Auto-discovers Victron, NMEA 2000, 1-Wire/GPIO, Diesel Heater, and RuuviTag hardware presets from vessel tree', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const discovered = await harness.pathDiscoveryService.discoverAll('boat-1');

      assert.equal(discovered.vessel.name, 'S/Y Northern Star');
      assert.ok(discovered.electricalBanks.some((b) => b.data.bankId === 'house'));
      assert.ok(discovered.electricalBanks.some((b) => b.data.bankType === 'solar' && b.data.bankId === '0'));
      assert.ok(discovered.electricalBanks.some((b) => b.data.bankType === 'inverter'));
      assert.ok(discovered.digitalSwitches.some((s) => s.data.switchId === 'venusRelay0'));
      assert.ok(discovered.digitalSwitches.some((s) => s.data.switchId === 'dieselHeater'));
      assert.ok(discovered.digitalSwitches.some((s) => s.data.switchId === 'bilgePump'));
      assert.ok(discovered.fluidTanks.some((t) => t.data.tankType === 'freshWater'));
      assert.ok(discovered.fluidTanks.some((t) => t.data.tankType === 'fuel'));
      assert.ok(discovered.fluidTanks.some((t) => t.data.tankType === 'blackWater'));
      assert.ok(discovered.propulsionEngines.some((e) => e.data.engineId === 'port'));
      assert.ok(discovered.propulsionEngines.some((e) => e.data.engineId === 'starboard'));
      assert.ok(discovered.customSensors.some((c) => c.path.includes('engineRoom.temperature')));
      assert.ok(discovered.customSensors.some((c) => c.path.includes('forwardCabin.temperature')));
    });
  });

  // ===========================================================================
  // Feature F7: Vessel & Anchor Watch Driver (drivers/vessel) (5 tests)
  // ===========================================================================
  describe('F7: Vessel & Anchor Watch Driver (drivers/vessel)', () => {
    test('F7-T1-01: Pairs vessel device via custom pairing session and initializes all sailing & anchor capabilities', async () => {
      const driver = harness.homey.drivers.getDriver('vessel');
      const pairSession = new MockPairSession();
      await driver.onPair(pairSession);

      await pairSession.emit('connect_server', {
        serverId: 'boat-1',
        host: mockServer.host,
        port: mockServer.port,
        token: 'default-readwrite-token',
      });
      const list = await pairSession.emit('list_devices');
      assert.equal(list.length, 1);

      const vesselDevice = await harness.pairDevice('vessel', list[0]);
      assert.equal(vesselDevice.getAvailable(), true);
      assert.ok(vesselDevice.hasCapability('measure_sog'));
      assert.ok(vesselDevice.hasCapability('onoff.anchor_armed'));
      assert.ok(vesselDevice.hasCapability('alarm_generic'));
    });

    test('F7-T1-02: Converts live navigation, wind, depth, barometer, and temperature deltas into Homey capability values', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      mockServer.emitDelta([
        { path: 'navigation.speedOverGround', value: 3.60111 },
        { path: 'navigation.speedThroughWater', value: 3.08667 },
        { path: 'navigation.courseOverGroundTrue', value: Math.PI / 2 },
        { path: 'navigation.headingTrue', value: Math.PI },
        { path: 'environment.depth.belowTransducer', value: 12.4 },
        { path: 'environment.wind.speedApparent', value: 7.71667 },
        { path: 'environment.wind.angleApparent', value: -Math.PI / 6 },
        { path: 'environment.outside.pressure', value: 101520 },
        { path: 'environment.outside.temperature', value: 291.15 },
        { path: 'navigation.state', value: 'sailing' },
        { path: 'steering.autopilot.state', value: 'wind' },
      ]);
      await waitForWs();

      assert.equal(vesselDevice.getCapabilityValue('measure_sog'), 7);
      assert.equal(vesselDevice.getCapabilityValue('measure_stw'), 6);
      assert.equal(vesselDevice.getCapabilityValue('measure_cog'), 90);
      assert.equal(vesselDevice.getCapabilityValue('measure_heading'), 180);
      assert.equal(vesselDevice.getCapabilityValue('measure_depth'), 12.4);
      assert.equal(vesselDevice.getCapabilityValue('measure_wind_strength'), 15);
      assert.equal(vesselDevice.getCapabilityValue('measure_wind_angle'), -30);
      assert.equal(vesselDevice.getCapabilityValue('measure_pressure'), 1015.2);
      assert.equal(vesselDevice.getCapabilityValue('measure_temperature'), 18);
      assert.equal(vesselDevice.getCapabilityValue('navigation_state'), 'sailing');
      assert.equal(vesselDevice.getCapabilityValue('autopilot_state'), 'wind');
    });

    test('F7-T1-03: Respects per-device speed_unit setting change ("kn" -> "km/h" -> "m/s")', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      await vesselDevice.simulateUserSettingsChange({ speed_unit: 'km/h' });
      mockServer.emitDelta({ path: 'navigation.speedOverGround', value: 10 });
      await waitForWs();
      assert.equal(vesselDevice.getCapabilityValue('measure_sog'), 36);

      // Force bypass client throttle window or wait
      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      await vesselDevice.simulateUserSettingsChange({ speed_unit: 'm/s' });
      mockServer.emitDelta({ path: 'navigation.speedOverGround', value: 10 });
      await waitForWs();
      assert.equal(vesselDevice.getCapabilityValue('measure_sog'), 10);
    });

    test('F7-T1-04: Arms and disarms Anchor Watch from Homey UI capability listener and monitors anchor drift', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel', {
        settings: { anchor_max_radius: 40 },
      });
      await waitForWs();

      await vesselDevice.triggerCapabilityListener('onoff.anchor_armed', true);
      assert.equal(vesselDevice.getCapabilityValue('onoff.anchor_armed'), true);
      assert.equal(vesselDevice.getCapabilityValue('measure_anchor_radius'), 40);

      // Clear plugin radius to exercise GPS drift update
      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: null },
        { path: 'navigation.position', value: { latitude: 59.3295, longitude: 18.0686 } },
      ]);
      await waitForWs();

      const dist = vesselDevice.getCapabilityValue('measure_anchor_distance');
      assert.ok(dist >= 21.5 && dist <= 23.0, `Expected ~22.2m, got ${dist}`);
      assert.equal(vesselDevice.getCapabilityValue('alarm_generic'), false);
    });

    test('F7-T1-05: Handles mDNS IP address change (onDiscoveryAddressChanged) and Repair flow (onRepair)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel', {
        id: VESSEL_SELF_URN,
      });
      await waitForWs();

      const mockServer2 = new MockSignalKServer();
      await mockServer2.start();
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
          port: mockServer2.port,
        });
        await waitForWs();

        assert.equal(vesselDevice.getStoreValue('port'), mockServer2.port);

        // Execute onRepair flow
        const driver = harness.homey.drivers.getDriver('vessel');
        const repairSession = new MockRepairSession();
        await driver.onRepair(repairSession, vesselDevice);
        const freshToken = mockServer2.issueToken({ customToken: 'repaired-jwt-token' });
        await repairSession.emit('set_token', { token: freshToken });

        assert.equal(vesselDevice.getStoreValue('token'), 'repaired-jwt-token');
        assert.equal(vesselDevice.getAvailable(), true);
      } finally {
        await mockServer2.stop();
      }
    });
  });

  // ===========================================================================
  // Feature F8: Propulsion / Engine Driver (drivers/propulsion) (5 tests)
  // ===========================================================================
  describe('F8: Propulsion / Engine Driver (drivers/propulsion)', () => {
    test('F8-T1-01: Auto-discovers port and starboard engines from Signal K propulsion.<id> subtree during pairing', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const driver = harness.homey.drivers.getDriver('propulsion');
      const devices = await driver.onPairListDevices('boat-1');

      const ids = devices.map((d) => d.data.engineId).sort();
      assert.deepEqual(ids, ['port', 'starboard']);
    });

    test('F8-T1-02: Converts engine revolutions (Hz -> RPM) and runTime (s -> hours) accurately', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'propulsion.port.revolutions', value: 41.666667 },
        { path: 'propulsion.port.runTime', value: 450000 },
      ]);
      await waitForWs();

      assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 2500);
      assert.equal(portEngine.getCapabilityValue('measure_engine_hours'), 125);
    });

    test('F8-T1-03: Converts engine coolant/exhaust temperature (K -> °C) and oil pressure (Pa -> bar)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'propulsion.port.temperature', value: 361.15 },
        { path: 'propulsion.port.oilPressure', value: 380000 },
      ]);
      await waitForWs();

      assert.equal(portEngine.getCapabilityValue('measure_temperature'), 88);
      assert.equal(portEngine.getCapabilityValue('measure_oil_pressure'), 3.8);
    });

    test('F8-T1-04: Converts volumetric fuel rate (m3/s -> L/h) and updates engine state & transmission gear', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'propulsion.port.fuel.rate', value: 0.0000015 },
        { path: 'propulsion.port.state', value: 'started' },
        { path: 'propulsion.port.transmission.gear', value: 'Forward' },
      ]);
      await waitForWs();

      assert.equal(portEngine.getCapabilityValue('measure_fuel_rate'), 5.4);
      assert.equal(portEngine.getStoreValue('engineState'), 'started');
      assert.equal(portEngine.getStoreValue('transmissionGear'), 'Forward');
    });

    test('F8-T1-05: Raises alarm_generic when notifications.propulsion.<id>.* reports overheat or low oil pressure', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'notifications.propulsion.port.overTemperature',
        value: {
          state: 'alarm',
          method: ['visual', 'sound'],
          message: 'Port Engine Coolant Temp High',
        },
      });
      await waitForWs();

      assert.equal(portEngine.getCapabilityValue('alarm_generic'), true);
      assert.ok(
        harness.homey.flow.triggeredHistory.some(
          (t) =>
            t.cardId === 'signalk_notification_raised' &&
            t.tokens.path === 'notifications.propulsion.port.overTemperature',
        ),
      );
    });
  });

  // ===========================================================================
  // Feature F9: Custom Signal K Path Sensor Driver (drivers/custom-sensor) (5 tests)
  // ===========================================================================
  describe('F9: Custom Signal K Path Sensor Driver (drivers/custom-sensor)', () => {
    test('T1-F9-01: Pair 1-Wire Engine Room Temperature Sensor (environment.inside.engineRoom.temperature)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.engineRoom.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          throttleTier: 'slow',
        },
        capabilities: ['measure_temperature'],
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'environment.inside.engineRoom.temperature',
        value: 318.65,
        $source: 'onewire.engineRoom',
      });
      await waitForWs();

      assert.equal(sensor.getCapabilityValue('measure_temperature'), 45.5);
    });

    test('T1-F9-02: Pair RuuviTag BLE Forward Cabin Humidity & Pressure Sensor', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.forwardCabin.relativeHumidity',
          capability: 'measure_humidity',
          unitCategory: 'ratio_to_percent',
          sourceFilter: 'ble.ruuvitag.fwd',
          throttleTier: 'fast',
        },
        capabilities: ['measure_humidity'],
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'environment.inside.forwardCabin.relativeHumidity',
        value: 0.645,
        $source: 'ble.ruuvitag.fwd',
      });
      await waitForWs();

      assert.equal(sensor.getCapabilityValue('measure_humidity'), 64.5);
    });

    test('T1-F9-03: Pair GPIO Bilge Float Switch Contact Sensor at Fast (200ms) Tier', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'notifications.bilge.main',
          capability: 'alarm_water',
          throttleTier: 'fast',
        },
        capabilities: ['alarm_water'],
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'notifications.bilge.main',
        value: {
          state: 'alarm',
          method: ['visual', 'sound'],
          message: 'High bilge water',
        },
      });
      await waitForWs();

      assert.equal(sensor.getCapabilityValue('alarm_water'), true);
    });

    test('T1-F9-04: Multi-Source ($source) Pinning Disambiguates Duplicate Sensors', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.depth.belowTransducer',
          capability: 'measure_depth',
          unitCategory: 'distance_m',
          sourceFilter: 'n2k.raymarine.11',
          throttleTier: 'fast',
        },
        capabilities: ['measure_depth'],
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'environment.depth.belowTransducer',
        value: 4.2,
        $source: 'n2k.raymarine.11',
      });
      mockServer.emitDelta({
        path: 'environment.depth.belowTransducer',
        value: 12.8,
        $source: 'n2k.garmin.22',
      });
      await waitForWs();

      assert.equal(sensor.getCapabilityValue('measure_depth'), 4.2);
    });

    test('T1-F9-05: Dynamic Device onSettings Updates Path, Unit Category & Throttle Tier Live', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.saloon.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          throttleTier: 'slow',
        },
        capabilities: ['measure_temperature', 'measure_pressure'],
      });
      await waitForWs();

      await sensor.simulateUserSettingsChange({
        path: 'environment.outside.pressure',
        capability: 'measure_pressure',
        unitCategory: 'pressure_pa_to_hpa',
        throttleTier: 'medium',
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'environment.outside.pressure',
        value: 101520,
      });
      await waitForWs();

      assert.equal(sensor.getCapabilityValue('measure_pressure'), 1015.2);
    });
  });

  // ===========================================================================
  // Feature F10: Battery / Electrical Bank Driver (drivers/electrical-bank) (6 tests)
  // ===========================================================================
  describe('F10: Battery / Electrical Bank Driver (drivers/electrical-bank)', () => {
    test('T1-F10-01: Auto-Discover Victron & N2K Electrical Banks via onPairListDevices', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const driver = harness.homey.drivers.getDriver('electrical-bank');
      const devices = await driver.onPairListDevices('boat-1');

      assert.ok(devices.some((d) => d.data.bankType === 'battery' && d.data.bankId === 'house'));
      assert.ok(devices.some((d) => d.data.bankType === 'battery' && d.data.bankId === 'starter'));
      assert.ok(devices.some((d) => d.data.bankType === 'solar' && d.data.bankId === '0'));
      assert.ok(devices.some((d) => d.data.bankType === 'inverter' && d.data.bankId === '0'));
    });

    test('T1-F10-02: House Battery Telemetry & Coulombs-to-Ah / Kelvin-to-Celsius / Ratio-to-Percent Conversions', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'electrical.batteries.house.voltage', value: 12.85 },
        { path: 'electrical.batteries.house.current', value: -14.2 },
        { path: 'electrical.batteries.house.power', value: -182.47 },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.78 },
        { path: 'electrical.batteries.house.capacity.remaining', value: 1123200 },
        { path: 'electrical.batteries.house.capacity.timeRemaining', value: 79200 },
        { path: 'electrical.batteries.house.temperature', value: 296.15 },
      ]);
      await waitForWs();

      assert.equal(houseBank.getCapabilityValue('measure_voltage'), 12.85);
      assert.equal(houseBank.getCapabilityValue('measure_current'), -14.2);
      assert.equal(houseBank.getCapabilityValue('measure_power'), -182.47);
      assert.equal(houseBank.getCapabilityValue('measure_battery'), 78);
      assert.equal(houseBank.getCapabilityValue('measure_remaining_ah'), 312);
      assert.equal(houseBank.getCapabilityValue('measure_time_remaining'), 22);
      assert.equal(houseBank.getCapabilityValue('measure_temperature'), 23);
    });

    test('T1-F10-03: Victron SmartSolar MPPT Telemetry (electrical.solar.0) & Energy Power Generation', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const solar = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'solar', bankId: '0', basePath: 'electrical.solar.0' },
        capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'meter_power'],
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'electrical.solar.0.panelVoltage', value: 38.4 },
        { path: 'electrical.solar.0.current', value: 18.5 },
        { path: 'electrical.solar.0.panelPower', value: 245.0 },
        { path: 'electrical.solar.0.yieldToday', value: 5400000 },
      ]);
      await waitForWs();

      assert.equal(solar.getCapabilityValue('measure_voltage'), 38.4);
      assert.equal(solar.getCapabilityValue('measure_current'), 18.5);
      assert.equal(solar.getCapabilityValue('measure_power'), 245);
      assert.equal(solar.getCapabilityValue('meter_power'), 1.5);
    });

    test('T1-F10-04: Writable Charger/Inverter Mode (charger_inverter_mode) Sends Signal K PUT', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const inverter = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'inverter', bankId: '0', basePath: 'electrical.inverters.0' },
        capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
      });
      await waitForWs();

      await inverter.triggerCapabilityListener('charger_inverter_mode', 'inverter_only');
      assert.equal(inverter.getCapabilityValue('charger_inverter_mode'), 'inverter_only');
      assert.ok(
        mockServer.recordedPuts.some(
          (p) => p.path === 'electrical.inverters.0.inverterMode' && p.value === 'inverter_only',
        ),
      );
    });

    test('T1-F10-05: Automatic Low-Battery Alarm (alarm_battery) Activation & Recovery', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
        settings: { lowSocThreshold: 20, lowVoltageThreshold: 11.8 },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'electrical.batteries.house.voltage', value: 12.6 },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.18 },
      ]);
      await waitForWs();
      assert.equal(houseBank.getCapabilityValue('alarm_battery'), true);

      // Clear client throttle window for subsequent test update
      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.25 });
      await waitForWs();
      assert.equal(houseBank.getCapabilityValue('alarm_battery'), false);
    });

    test('T1-F10-06: Compute Power (W = V * I) Fallback When Signal K Only Streams voltage and current', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const starter = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'starter', basePath: 'electrical.batteries.starter' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'electrical.batteries.starter.voltage', value: 13.4 },
        { path: 'electrical.batteries.starter.current', value: 5.0 },
      ]);
      await waitForWs();

      assert.equal(starter.getCapabilityValue('measure_power'), 67);
    });
  });

  // ===========================================================================
  // Feature F11: Fluid Tank Monitor Driver (drivers/fluid-tank) (5 tests)
  // ===========================================================================
  describe('F11: Fluid Tank Monitor Driver (drivers/fluid-tank)', () => {
    test('T1-F11-01: Auto-Discover Multi-Type Fluid Tanks via onPairListDevices', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const driver = harness.homey.drivers.getDriver('fluid-tank');
      const tanks = await driver.onPairListDevices('boat-1');

      assert.ok(tanks.some((t) => t.data.tankType === 'freshWater' && t.data.tankId === '0'));
      assert.ok(tanks.some((t) => t.data.tankType === 'freshWater' && t.data.tankId === '1'));
      assert.ok(tanks.some((t) => t.data.tankType === 'fuel' && t.data.tankId === '0'));
      assert.ok(tanks.some((t) => t.data.tankType === 'blackWater' && t.data.tankId === '0'));
    });

    test('T1-F11-02: Fresh Water Tank Level (ratio -> %), Volume (m3 -> L) & meter_water (m3)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const fwTank = await harness.pairDevice('fluid-tank', {
        store: {
          tankType: 'freshWater',
          tankId: '0',
          basePath: 'tanks.freshWater.0',
          capacityLiters: 250,
        },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'meter_water', 'alarm_generic'],
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'tanks.freshWater.0.currentLevel', value: 0.68 },
        { path: 'tanks.freshWater.0.currentVolume', value: 0.17 },
      ]);
      await waitForWs();

      assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 68);
      assert.equal(fwTank.getCapabilityValue('measure_tank_volume'), 170);
      assert.equal(fwTank.getCapabilityValue('meter_water'), 0.17);
    });

    test('T1-F11-03: Compute Tank Volume (L) from currentLevel * capacity When currentVolume Is Omitted', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const fuelTank = await harness.pairDevice('fluid-tank', {
        store: {
          tankType: 'fuel',
          tankId: '0',
          basePath: 'tanks.fuel.0',
          capacityLiters: 150,
        },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic'],
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'tanks.fuel.0.currentLevel', value: 0.4 });
      await waitForWs();

      assert.equal(fuelTank.getCapabilityValue('measure_tank_level'), 40);
      assert.equal(fuelTank.getCapabilityValue('measure_tank_volume'), 60);
    });

    test('T1-F11-04: Black Water High-Level Alarm Activation (>= 85%)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const bwTank = await harness.pairDevice('fluid-tank', {
        store: {
          tankType: 'blackWater',
          tankId: '0',
          basePath: 'tanks.blackWater.0',
          capacityLiters: 80,
        },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic'],
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'tanks.blackWater.0.currentLevel', value: 0.88 });
      await waitForWs();

      assert.equal(bwTank.getCapabilityValue('measure_tank_level'), 88);
      assert.equal(bwTank.getCapabilityValue('alarm_generic'), true);
    });

    test('T1-F11-05: Fuel / Fresh Water Low-Level Alarm Activation (<= 15%)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const fuelTank = await harness.pairDevice('fluid-tank', {
        store: {
          tankType: 'fuel',
          tankId: '0',
          basePath: 'tanks.fuel.0',
          capacityLiters: 200,
        },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic'],
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'tanks.fuel.0.currentLevel', value: 0.12 });
      await waitForWs();

      assert.equal(fuelTank.getCapabilityValue('measure_tank_level'), 12);
      assert.equal(fuelTank.getCapabilityValue('alarm_generic'), true);
    });
  });

  // ===========================================================================
  // Feature F12: Digital Switch / Relay Driver (drivers/digital-switch) (5 tests)
  // ===========================================================================
  describe('F12: Digital Switch / Relay Driver (drivers/digital-switch)', () => {
    test('T1-F12-01: Auto-Discover Digital Switches & Dimmer Banks via onPairListDevices', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const driver = harness.homey.drivers.getDriver('digital-switch');
      const switches = await driver.onPairListDevices('boat-1');

      assert.ok(switches.some((s) => s.data.switchId === 'anchorLight'));
      assert.ok(switches.some((s) => s.data.switchId === 'dieselHeater'));
      assert.ok(switches.some((s) => s.data.switchId === 'venusRelay0'));
      const saloonDimmer = switches.find((s) => s.data.switchId === 'saloonDimmer');
      assert.ok(saloonDimmer);
      assert.deepEqual(saloonDimmer.capabilities, ['onoff', 'dim']);
      assert.ok(switches.some((s) => s.data.basePath === 'electrical.switches.bank.main.navLights'));
    });

    test('T1-F12-02: Synchronous onoff Toggle Actuation via Signal K PUT (200 COMPLETED)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const anchorLight = await harness.pairDevice('digital-switch', {
        store: { switchId: 'anchorLight', basePath: 'electrical.switches.anchorLight' },
        capabilities: ['onoff'],
      });
      await waitForWs();

      await anchorLight.triggerCapabilityListener('onoff', true);
      assert.equal(anchorLight.getCapabilityValue('onoff'), true);
      assert.ok(
        mockServer.recordedPuts.some(
          (p) => p.path === 'electrical.switches.anchorLight.state' && p.value === true,
        ),
      );
    });

    test('T1-F12-03: Asynchronous 202 PENDING -> 200 COMPLETED Switch Actuation Lifecycle', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setPutBehavior('electrical.switches.bank.main.waterPump.state', {
        mode: 'ASYNC_202_COMPLETE',
        delayMs: 60,
      });

      const pumpSwitch = await harness.pairDevice('digital-switch', {
        store: {
          switchId: 'main.waterPump',
          basePath: 'electrical.switches.bank.main.waterPump',
        },
        capabilities: ['onoff'],
      });
      await waitForWs();

      await pumpSwitch.triggerCapabilityListener('onoff', true);
      assert.equal(pumpSwitch.getCapabilityValue('onoff'), true);
    });

    test('T1-F12-04: Dimmer Switch (dim Capability 0..1) Sends PUT to dimmingLevel', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const dimmer = await harness.pairDevice('digital-switch', {
        store: { switchId: 'saloonDimmer', basePath: 'electrical.switches.saloonDimmer' },
        capabilities: ['onoff', 'dim'],
      });
      await waitForWs();

      await dimmer.triggerCapabilityListener('dim', 0.65);
      await waitForWs();

      assert.equal(dimmer.getCapabilityValue('dim'), 0.65);
      assert.equal(dimmer.getCapabilityValue('onoff'), true);
      assert.ok(
        mockServer.recordedPuts.some(
          (p) => p.path === 'electrical.switches.saloonDimmer.dimmingLevel' && p.value === 0.65,
        ),
      );
    });

    test('T1-F12-05: External Switch Toggle via WebSocket Delta (boolean and Numeric 1/0) Updates Homey Within 200ms', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const heaterSwitch = await harness.pairDevice('digital-switch', {
        store: { switchId: 'dieselHeater', basePath: 'electrical.switches.dieselHeater' },
        capabilities: ['onoff'],
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'electrical.switches.dieselHeater.state', value: 1 });
      await waitForWs();
      assert.equal(heaterSwitch.getCapabilityValue('onoff'), true);

      mockServer.emitDelta({ path: 'electrical.switches.dieselHeater.state', value: 0 });
      await waitForWs();
      assert.equal(heaterSwitch.getCapabilityValue('onoff'), false);
    });
  });

  // ===========================================================================
  // Feature F13: Bidirectional Sensor Bridge Flow Action Cards (Homey -> Signal K) (5 tests)
  // ===========================================================================
  describe('F13: Bidirectional Sensor Bridge Flow Action Cards (Homey -> Signal K)', () => {
    test('T1-F13-01: Flow Action: Publish Homey Cabin Temperature (°C -> K) to environment.inside.<zone>.temperature', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.homey.flow.runAction('publish_temperature_to_signalk', {
        zone: 'mainCabin',
        value: 21.5,
        source: 'zigbee.aqara.saloon',
      });
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 1);
      const d = mockServer.receivedHomeyDeltas[0];
      assert.equal(d.updates[0].$source, 'homey.zigbee.aqara.saloon');
      assert.deepEqual(d.updates[0].values[0], {
        path: 'environment.inside.mainCabin.temperature',
        value: 294.65,
      });
    });

    test('T1-F13-02: Flow Action: Publish Homey Relative Humidity (% -> ratio 0..1) to environment.inside.<zone>.relativeHumidity', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.homey.flow.runAction('publish_humidity_to_signalk', {
        zone: 'forwardCabin',
        value: 62.5,
        source: 'ble.ruuvitag.fwd',
      });
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 1);
      const val = mockServer.receivedHomeyDeltas[0].updates[0].values[0];
      assert.equal(val.path, 'environment.inside.forwardCabin.relativeHumidity');
      assert.equal(val.value, 0.625);
    });

    test('T1-F13-03: Flow Action: Publish Homey Barometric Pressure (hPa/mbar -> Pa) to environment.inside.<zone>.pressure', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.homey.flow.runAction('publish_pressure_to_signalk', {
        zone: 'saloon',
        value: 1013.25,
        source: 'bme280.saloon',
      });
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 1);
      const val = mockServer.receivedHomeyDeltas[0].updates[0].values[0];
      assert.equal(val.path, 'environment.inside.saloon.pressure');
      assert.equal(val.value, 101325);
    });

    test('T1-F13-04: Flow Action: Publish Homey Switch / Contact Boolean State to electrical.switches.<id>.state', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.homey.flow.runAction('publish_switch_state_to_signalk', {
        switchId: 'dieselHeater',
        state: true,
        source: 'shelly.12v.heater',
      });
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 1);
      const val = mockServer.receivedHomeyDeltas[0].updates[0].values[0];
      assert.equal(val.path, 'electrical.switches.dieselHeater.state');
      assert.equal(val.value, true);
    });

    test('T1-F13-05: Flow Action: Raise & Clear Signal K Notification Alarms (notifications.security.* & notifications.bilge.*)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.homey.flow.runAction('raise_signalk_notification', {
        category: 'security',
        item: 'companionwayHatch',
        state: 'alarm',
        message: 'Companionway hatch opened while armed',
        method: ['visual', 'sound'],
      });
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 1);
      const alarmVal = mockServer.receivedHomeyDeltas[0].updates[0].values[0];
      assert.equal(alarmVal.path, 'notifications.security.companionwayHatch');
      assert.deepEqual(alarmVal.value, {
        state: 'alarm',
        method: ['visual', 'sound'],
        message: 'Companionway hatch opened while armed',
      });

      await harness.homey.flow.runAction('clear_signalk_notification', {
        category: 'security',
        item: 'companionwayHatch',
      });
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 2);
      const clearVal = mockServer.receivedHomeyDeltas[1].updates[0].values[0];
      assert.equal(clearVal.value.state, 'normal');
    });
  });

  // ===========================================================================
  // Feature F14: Anchor Watch, Notification & Battery Load-Shedding Flow Cards (6 tests)
  // ===========================================================================
  describe('F14: Anchor Watch, Notification & Battery Load-Shedding Flow Cards', () => {
    test('T1-F14-01: Trigger signalk_notification_raised Fires with Path, State & Message Tokens', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      harness.homey.flow.setTriggerTestArgs('signalk_notification_raised', {
        minState: 'warn',
        pathPrefix: 'notifications.environment',
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'notifications.environment.depth.belowKeel',
        value: {
          state: 'warn',
          method: ['sound'],
          message: 'Shallow water below keel',
        },
      });
      await waitForWs();

      const fired = harness.homey.flow.triggeredHistory.find(
        (t) =>
          t.cardId === 'signalk_notification_raised' &&
          t.tokens.path === 'notifications.environment.depth.belowKeel',
      );
      assert.ok(fired);
      assert.equal(fired.tokens.state, 'warn');
      assert.equal(fired.tokens.message, 'Shallow water below keel');
      assert.equal(fired.passedRunListener, true);
    });

    test('T1-F14-02: Trigger anchor_drag_alarm & Condition is_anchor_armed Fire When Vessel Drags Beyond maxRadius', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      await harness.homey.flow.runAction('arm_anchor_watch', { maxRadius: 40, rodeLength: 30 });
      const isArmed = await harness.homey.flow.evaluateCondition('is_anchor_armed', { device: vesselDevice });
      assert.equal(isArmed, true);

      // Drift 56m North
      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: null },
        { path: 'navigation.position', value: { latitude: 59.3298, longitude: 18.0686 } },
      ]);
      await waitForWs();

      const dragTrigger = harness.homey.flow.triggeredHistory.find((t) => t.cardId === 'anchor_drag_alarm');
      assert.ok(dragTrigger);
      assert.ok(dragTrigger.tokens.currentRadius > 40);
      assert.equal(dragTrigger.tokens.maxRadius, 40);
    });

    test('T1-F14-03: Trigger navigation_state_changed & Condition is_vessel_state', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      mockServer.emitDelta({ path: 'navigation.state', value: 'anchored' });
      await waitForWs();

      // Clear client throttle window
      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      mockServer.emitDelta({ path: 'navigation.state', value: 'sailing' });
      await waitForWs();

      const navTrigger = harness.homey.flow.triggeredHistory.find(
        (t) => t.cardId === 'navigation_state_changed' && t.tokens.state === 'sailing',
      );
      assert.ok(navTrigger);
      assert.equal(navTrigger.tokens.previousState, 'anchored');

      const isSailing = await harness.homey.flow.evaluateCondition('is_vessel_state', {
        device: vesselDevice,
        state: 'sailing',
      });
      const isAnchored = await harness.homey.flow.evaluateCondition('is_vessel_state', {
        device: vesselDevice,
        state: 'anchored',
      });
      assert.equal(isSailing, true);
      assert.equal(isAnchored, false);
    });

    test('T1-F14-04: Battery Load-Shedding Trigger battery_soc_below_threshold, Condition is_battery_soc_below & Action set_charger_inverter_mode', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.55 });
      await waitForWs();

      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.48 });
      await waitForWs();

      const socTrigger = harness.homey.flow.triggeredHistory.find(
        (t) => t.cardId === 'battery_soc_below_threshold' && t.tokens.threshold === 50,
      );
      assert.ok(socTrigger);
      assert.equal(socTrigger.tokens.soc, 48);

      const cond = await harness.homey.flow.evaluateCondition('is_battery_soc_below', {
        device: houseBank,
        threshold: 50,
      });
      assert.equal(cond, true);

      await harness.homey.flow.runAction('set_charger_inverter_mode', {
        bankId: '0',
        mode: 'eco',
      });
      assert.ok(
        mockServer.recordedPuts.some(
          (p) => p.path === 'electrical.inverters.0.inverterMode' && p.value === 'eco',
        ),
      );
    });

    test('T1-F14-05: Anchor Control Flow Actions: arm_anchor_watch, set_anchor_max_radius & disarm_anchor_watch', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      await harness.homey.flow.runAction('arm_anchor_watch', { maxRadius: 35, rodeLength: 50 });
      assert.equal(vesselDevice.getCapabilityValue('onoff.anchor_armed'), true);
      assert.equal(vesselDevice.getCapabilityValue('measure_anchor_radius'), 35);

      await harness.homey.flow.runAction('set_anchor_max_radius', { maxRadius: 45 });
      assert.equal(vesselDevice.getCapabilityValue('measure_anchor_radius'), 45);

      await harness.homey.flow.runAction('disarm_anchor_watch', {});
      assert.equal(vesselDevice.getCapabilityValue('onoff.anchor_armed'), false);
    });

    test('T1-F14-06: Generic path_value_updated Trigger, path_value_comparison Condition & Allowed put_signalk_path Action', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await waitForWs();

      mockServer.emitDelta({ path: 'environment.wind.speedApparent', value: 15.0 });
      await waitForWs();

      const pathTrig = harness.homey.flow.triggeredHistory.find(
        (t) => t.cardId === 'path_value_updated' && t.tokens.path === 'environment.wind.speedApparent',
      );
      assert.ok(pathTrig);

      const cmp = await harness.homey.flow.evaluateCondition('path_value_comparison', {
        path: 'environment.wind.speedApparent',
        operator: '>',
        value: 12.0,
      });
      assert.equal(cmp, true);

      await harness.homey.flow.runAction('put_signalk_path', {
        path: 'electrical.switches.deckLight.state',
        value: true,
      });
      assert.ok(
        mockServer.recordedPuts.some(
          (p) => p.path === 'electrical.switches.deckLight.state' && p.value === true,
        ),
      );
    });
  });

  // ===========================================================================
  // Feature F15: Full App Composition, CLI Build/Validation & Final E2E Verification (6 tests)
  // ===========================================================================
  describe('F15: Full App Composition, CLI Build/Validation & Final E2E Verification', () => {
    test('T1-F15-01: Composed Root app.json Matches .homeycompose Fragments & SDK v3 publish Schema', () => {
      const { manifest } = harness.loadAppManifest();
      const validation = harness.validatePublishLevel(manifest);
      assert.equal(validation.valid, true);
      assert.equal(validation.driverCount, 6);
      assert.equal(validation.capabilityCount, 18);
    });

    test('T1-F15-02: All 18 Custom Maritime Capabilities & mDNS Discovery Strategy (signalk) Are Valid', () => {
      const { manifest } = harness.loadAppManifest();
      for (const [capId, capDef] of Object.entries(manifest.capabilities)) {
        assert.ok(['number', 'string', 'boolean', 'enum'].includes(capDef.type), `Invalid type on ${capId}`);
        assert.equal(typeof capDef.getable, 'boolean');
        assert.equal(typeof capDef.setable, 'boolean');
      }
      assert.equal(manifest.discovery.signalk.type, 'mdns-sd');
      assert.equal(manifest.discovery.signalk['mdns-sd'].name, 'signalk-http');
    });

    test('T1-F15-03: All Flow Triggers, Conditions & Actions Are Declared in app.json and Bound to Run Listeners in Homey.App', async () => {
      await harness.app.onInit();
      const { manifest } = harness.loadAppManifest();

      for (const trig of manifest.flow.triggers) {
        const card = harness.homey.flow.getTriggerCard(trig.id);
        assert.equal(typeof card._runListener, 'function', `Missing runListener for trigger ${trig.id}`);
      }
      for (const cond of manifest.flow.conditions) {
        const card = harness.homey.flow.getConditionCard(cond.id);
        assert.equal(typeof card._runListener, 'function', `Missing runListener for condition ${cond.id}`);
      }
      for (const act of manifest.flow.actions) {
        const card = harness.homey.flow.getActionCard(act.id);
        assert.equal(typeof card._runListener, 'function', `Missing runListener for action ${act.id}`);
      }
    });

    test('T1-F15-04: App Store Asset Compliance: App & Driver SVG Icons and PNG Images Exist with Valid Headers/Dimensions', () => {
      const res = harness.validateAppStoreAssets();
      assert.equal(res.valid, true);
    });

    test('T1-F15-05: App Store Plain-Text README.txt & .homeychangelog.json Compliance', () => {
      const res = harness.validateAppStoreAssets({
        readmeText:
          'Signal K Marine connects your smart boat hub with OpenPlotter and Signal K for energy management, cabin comfort, fluid tanks, digital switching, and anchor drift watch.',
        changelog: {
          '1.0.0': {
            en: 'Initial release of Signal K Marine for OpenPlotter and Signal K Server.',
          },
        },
      });
      assert.equal(res.valid, true);
    });

    test('T1-F15-06: Full Homey.App + 6 Drivers Boot, Pair, Stream & Clean Shutdown (onUninit) Lifecycle', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vessel = await harness.pairDevice('vessel');
      const engine = await harness.pairDevice('propulsion', { store: { engineId: 'port' } });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.engineRoom.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
        },
      });
      const bank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      const tank = await harness.pairDevice('fluid-tank', {
        store: { tankType: 'freshWater', tankId: '0', basePath: 'tanks.freshWater.0' },
      });
      const sw = await harness.pairDevice('digital-switch', {
        store: { switchId: 'anchorLight', basePath: 'electrical.switches.anchorLight' },
      });
      await waitForWs();

      assert.equal(mockServer.getActiveWebSocketCount(), 1);

      mockServer.emitDelta([
        { path: 'navigation.speedOverGround', value: 5.144444 },
        { path: 'propulsion.port.revolutions', value: 30 },
        { path: 'environment.inside.engineRoom.temperature', value: 303.15 },
        { path: 'electrical.batteries.house.voltage', value: 13.4 },
        { path: 'tanks.freshWater.0.currentLevel', value: 0.8 },
        { path: 'electrical.switches.anchorLight.state', value: true },
      ]);
      await waitForWs();

      assert.equal(vessel.getCapabilityValue('measure_sog'), 10);
      assert.equal(engine.getCapabilityValue('measure_engine_rpm'), 1800);
      assert.equal(sensor.getCapabilityValue('measure_temperature'), 30);
      assert.equal(bank.getCapabilityValue('measure_voltage'), 13.4);
      assert.equal(tank.getCapabilityValue('measure_tank_level'), 80);
      assert.equal(sw.getCapabilityValue('onoff'), true);

      await harness.shutdown();
      await waitForWs();
      assert.equal(mockServer.getActiveWebSocketCount(), 0);
    });
  });
});
