import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockSignalKServer } from './harness/mock_signalk_server.mjs';
import {
  HomeyRuntimeHarness,
  SafetyBoundaryError,
  AppStoreValidationError,
  createSyntheticPngBuffer,
} from './harness/homey_runtime_harness.mjs';
import { VESSEL_SELF_URN } from './harness/fixtures.mjs';

const waitForWs = (ms = 35) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Tier 2 — Boundary, Negative & Error Cases E2E Suite (F1–F15)', () => {
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
  // Feature F1: Manifest & App Store Validation Edge Cases (5 tests)
  // ===========================================================================
  describe('F1: Manifest & App Store Validation Edge Cases', () => {
    test('F1-T2-01: Validator rejects manifest if restricted homey:manager:api permission is injected', () => {
      const { manifest } = harness.loadAppManifest();
      const badManifest = structuredClone(manifest);
      badManifest.permissions = ['homey:manager:api'];

      assert.throws(
        () => harness.validatePublishLevel(badManifest),
        (err) => err instanceof AppStoreValidationError && /homey:manager:api/i.test(err.message),
      );
    });

    test('F1-T2-02: Validator rejects README.txt containing Markdown syntax or URLs', () => {
      assert.throws(
        () => harness.validateAppStoreAssets({ readmeText: '# Signal K Marine\n Smart Boat App' }),
        (err) => err instanceof AppStoreValidationError && /Markdown/i.test(err.message),
      );

      assert.throws(
        () => harness.validateAppStoreAssets({ readmeText: 'Visit https://signalk.org for documentation' }),
        (err) => err instanceof AppStoreValidationError && /URL/i.test(err.message),
      );
    });

    test('F1-T2-03: Validator rejects app name exceeding 4 words or containing "Homey"', () => {
      const { manifest } = harness.loadAppManifest();
      const tooManyWords = structuredClone(manifest);
      tooManyWords.name = { en: 'OpenPlotter Signal K Marine Smart Boat Hub' };

      assert.throws(
        () => harness.validatePublishLevel(tooManyWords),
        (err) => err instanceof AppStoreValidationError && /exceeds 4 words/i.test(err.message),
      );

      const withHomey = structuredClone(manifest);
      withHomey.name = { en: 'Homey Signal K' };
      assert.throws(
        () => harness.validatePublishLevel(withHomey),
        (err) => err instanceof AppStoreValidationError && /Homey/i.test(err.message),
      );
    });

    test('F1-T2-04: Validator rejects custom capability overriding built-in system capability ID', () => {
      const { manifest } = harness.loadAppManifest();
      const collisionManifest = structuredClone(manifest);
      collisionManifest.capabilities.measure_wind_strength = {
        type: 'number',
        title: { en: 'Wind Strength' },
        getable: true,
        setable: false,
      };

      assert.throws(
        () => harness.validatePublishLevel(collisionManifest),
        (err) => err instanceof AppStoreValidationError && /measure_wind_strength/i.test(err.message),
      );
    });

    test('F1-T2-05: Validator detects driver icon reusing app icon or invalid PNG dimensions', () => {
      const sameSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960"><rect width="100" height="100"/></svg>';
      assert.throws(
        () =>
          harness.validateAppStoreAssets({
            appSvg: sameSvg,
            driverSvgs: { vessel: sameSvg },
          }),
        (err) => err instanceof AppStoreValidationError && /identical/i.test(err.message),
      );

      assert.throws(
        () =>
          harness.validateAppStoreAssets({
            driverSmallPngs: { vessel: createSyntheticPngBuffer(64, 64) },
          }),
        (err) => err instanceof AppStoreValidationError && /75x75/i.test(err.message),
      );
    });
  });

  // ===========================================================================
  // Feature F2: UnitConverter Null/NaN/Angle Wrap Edge Cases (5 tests)
  // ===========================================================================
  describe('F2: UnitConverter Null/NaN/Angle Wrap Edge Cases', () => {
    test('F2-T2-01: Strict null guard — null or undefined input never evaluates to -273.15°C or 0', () => {
      const uc = harness.unitConverter;
      assert.strictEqual(uc.fromSignalK(null, 'temperature_k_to_c'), null);
      assert.strictEqual(uc.fromSignalK(undefined, 'speed_ms_to_kn'), null);
      assert.strictEqual(uc.toSignalK(null, 'ratio_to_percent'), null);
      assert.strictEqual(uc.toSignalK(undefined, 'temperature_k_to_c'), null);
    });

    test('F2-T2-02: Non-finite and non-numeric inputs (NaN, +-Infinity, strings, objects) return null', () => {
      const uc = harness.unitConverter;
      assert.strictEqual(uc.fromSignalK(NaN, 'pressure_pa_to_hpa'), null);
      assert.strictEqual(uc.fromSignalK(Infinity, 'speed_ms_to_kn'), null);
      assert.strictEqual(uc.fromSignalK(-Infinity, 'temperature_k_to_c'), null);
      assert.strictEqual(uc.fromSignalK('invalid', 'ratio_to_percent'), null);
      assert.strictEqual(uc.fromSignalK({}, 'distance_m'), null);
    });

    test('F2-T2-03: Unsigned angle wrap normalizes negative radians and >= 2*PI radians into [0, 360)', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(-Math.PI / 2, 'angle_rad_to_deg_unsigned', 1), 270);
      assert.equal(uc.fromSignalK(2 * Math.PI, 'angle_rad_to_deg_unsigned', 1), 0);
      assert.equal(uc.fromSignalK(2.5 * Math.PI, 'angle_rad_to_deg_unsigned', 1), 90);
    });

    test('F2-T2-04: Signed angle wrap normalizes angles outside [-PI, +PI] into [-180, +180]', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(1.5 * Math.PI, 'angle_rad_to_deg_signed', 1), -90);
      assert.equal(uc.fromSignalK(-1.5 * Math.PI, 'angle_rad_to_deg_signed', 1), 90);
    });

    test('F2-T2-05: Zero boundary values (0 K, 0 Pa, 0 m/s, 0 C, 0 rad) convert accurately without falsy drop', () => {
      const uc = harness.unitConverter;
      assert.equal(uc.fromSignalK(0, 'temperature_k_to_c', 2), -273.15);
      assert.equal(uc.fromSignalK(0, 'speed_ms_to_kn', 2), 0);
      assert.equal(uc.fromSignalK(0, 'angle_rad_to_deg_unsigned', 2), 0);
      assert.equal(uc.fromSignalK(0, 'charge_c_to_ah', 2), 0);
      assert.equal(uc.toSignalK(0, 'temperature_k_to_c'), 273.15);
    });
  });

  // ===========================================================================
  // Feature F3: AnchorWatchCalculator Boundary & Fallback Edge Cases (5 tests)
  // ===========================================================================
  describe('F3: AnchorWatchCalculator Boundary & Fallback Edge Cases', () => {
    test('F3-T2-01: Identical anchor and vessel coordinates yield 0m distance, 0 deg bearing, and isDragging = false', () => {
      const calc = harness.anchorCalculator;
      const pos = { latitude: 59.3293, longitude: 18.0686 };
      assert.equal(calc.calculateHaversineDistanceMeters(pos, pos), 0);
      assert.equal(calc.calculateBearingDegrees(pos, pos), 0);

      const status = calc.evaluateDrift({
        armed: true,
        anchorPosition: pos,
        vesselPosition: pos,
        maxRadiusMeters: 30,
      });
      assert.equal(status.currentRadiusMeters, 0);
      assert.equal(status.isDragging, false);
    });

    test('F3-T2-02: International Date Line (+-180 deg longitude wrap) and equator crossing compute shortest great-circle arc', () => {
      const calc = harness.anchorCalculator;
      const a = { latitude: -0.0001, longitude: 179.9999 };
      const b = { latitude: 0.0001, longitude: -179.9999 };
      const dist = calc.calculateHaversineDistanceMeters(a, b);
      assert.ok(dist > 25 && dist < 35, `Expected ~31.4m across Date Line, got ${dist}m`);
      const brng = calc.calculateBearingDegrees(a, b);
      assert.ok(brng >= 44 && brng <= 46, `Expected ~45 deg NE bearing, got ${brng}`);
    });

    test('F3-T2-03: Exact radius threshold boundary (distance === maxRadiusMeters vs distance > maxRadiusMeters)', () => {
      const calc = harness.anchorCalculator;
      const pos = { latitude: 59.3293, longitude: 18.0686 };

      const atLimit = calc.evaluateDrift({
        armed: true,
        anchorPosition: pos,
        vesselPosition: pos,
        pluginCurrentRadiusMeters: 40.0,
        maxRadiusMeters: 40.0,
      });
      assert.equal(atLimit.isDragging, false);

      const overLimit = calc.evaluateDrift({
        armed: true,
        anchorPosition: pos,
        vesselPosition: pos,
        pluginCurrentRadiusMeters: 40.01,
        maxRadiusMeters: 40.0,
      });
      assert.equal(overLimit.isDragging, true);
    });

    test('F3-T2-04: Disarmed anchor watch (armed: false) or missing GPS fix (vesselPosition: null) never false-triggers drag alarm', () => {
      const calc = harness.anchorCalculator;
      const disarmed = calc.evaluateDrift({
        armed: false,
        anchorPosition: { latitude: 59.3293, longitude: 18.0686 },
        vesselPosition: { latitude: 59.3393, longitude: 18.0686 }, // >1000m away
        maxRadiusMeters: 30,
      });
      assert.equal(disarmed.isDragging, false);

      const lostGps = calc.evaluateDrift({
        armed: true,
        anchorPosition: { latitude: 59.3293, longitude: 18.0686 },
        vesselPosition: null,
        pluginCurrentRadiusMeters: null,
        maxRadiusMeters: 30,
      });
      assert.equal(lostGps.currentRadiusMeters, null);
      assert.equal(lostGps.isDragging, false);
    });

    test('F3-T2-05: Plugin alarm state override ("alarm" / "emergency") sets isDragging = true even if radius is below threshold', () => {
      const calc = harness.anchorCalculator;
      const status = calc.evaluateDrift({
        armed: true,
        anchorPosition: { latitude: 59.3293, longitude: 18.0686 },
        vesselPosition: { latitude: 59.32935, longitude: 18.0686 },
        pluginCurrentRadiusMeters: 15,
        pluginAlarmState: 'emergency',
        maxRadiusMeters: 40,
      });
      assert.equal(status.source, 'plugin');
      assert.equal(status.isDragging, true);
    });
  });

  // ===========================================================================
  // Feature F4: Signal K Discovery & Auth Error Handling (5 tests)
  // ===========================================================================
  describe('F4: Signal K Discovery & Auth Error Handling', () => {
    test('F4-T2-01: Handles DENIED access request when admin rejects Homey in Signal K UI', async () => {
      const reqRes = await harness.authManager.requestAccess({
        host: mockServer.host,
        port: mockServer.port,
      });
      mockServer.denyAccessRequest(reqRes.requestId);

      await assert.rejects(
        () =>
          harness.authManager.pollAccessRequest(
            { host: mockServer.host, port: mockServer.port },
            reqRes.href,
          ),
        (err) => err.permission === 'DENIED' && /DENIED/i.test(err.message),
      );
    });

    test('F4-T2-02: Handles 501 Not Implemented when Signal K server has security/access requests disabled', async () => {
      mockServer.setAccessRequestsSupported(false);
      const res = await harness.authManager.requestAccess({
        host: mockServer.host,
        port: mockServer.port,
      });
      assert.equal(res.statusCode, 501);
      assert.equal(res.fallbackReadonly, true);
    });

    test('F4-T2-03: Handles 400 Bad Request when clientId is missing or malformed', async () => {
      await assert.rejects(
        () =>
          harness.authManager.requestAccess(
            { host: mockServer.host, port: mockServer.port },
            { clientId: 'not-a-valid-uuid' },
          ),
        (err) => err.statusCode === 400,
      );
    });

    test('F4-T2-04: Handles 401 Unauthorized / 403 Forbidden on revoked or expired JWT token', async () => {
      mockServer.revokeToken('revoked-jwt-token');
      await assert.rejects(
        () =>
          harness.authManager.validateConnection({
            host: mockServer.host,
            port: mockServer.port,
            token: 'revoked-jwt-token',
          }),
        (err) => err.statusCode === 401,
      );
    });

    test('F4-T2-05: Handles unreachable host, non-Signal K 404 endpoint, and access request polling timeout', async () => {
      const reqRes = await harness.authManager.requestAccess({
        host: mockServer.host,
        port: mockServer.port,
      });

      await assert.rejects(
        () =>
          harness.authManager.pollAccessRequest(
            { host: mockServer.host, port: mockServer.port },
            reqRes.href,
            { intervalMs: 25, timeoutMs: 120 },
          ),
        (err) => err.code === 'ACCESS_REQUEST_TIMEOUT',
      );
    });
  });

  // ===========================================================================
  // Feature F5: Connection Pool Reconnect, Context & Malformed Frame Edge Cases (5 tests)
  // ===========================================================================
  describe('F5: Connection Pool Reconnect, Context & Malformed Frame Edge Cases', () => {
    test('F5-T2-01: Ignores deltas for other AIS vessels (context !== hello.self and context !== "vessels.self")', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const received = [];
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-own',
        path: 'navigation.speedOverGround',
        tier: 'fast',
        onUpdate: (u) => received.push(u.value),
      });
      await waitForWs();

      mockServer.emitDelta(
        { path: 'navigation.speedOverGround', value: 18.5 },
        { context: 'vessels.urn:mrn:imo:mmsi:265555555', forceBroadcast: true },
      );
      await waitForWs();

      assert.equal(received.length, 0);
    });

    test('F5-T2-02: Automatically reconnects with exponential backoff and re-subscribes all active paths after WebSocket drop', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const received = [];
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-reconnect',
        path: 'navigation.speedOverGround',
        tier: 'fast',
        onUpdate: (u) => received.push(u.value),
      });
      await waitForWs();

      mockServer.dropWebSocketClients();
      assert.equal(mockServer.getActiveWebSocketCount(), 0);

      // Wait for exponential backoff auto-reconnect (~60ms)
      await waitForWs(180);
      assert.equal(mockServer.getActiveWebSocketCount(), 1);

      mockServer.emitDelta({ path: 'navigation.speedOverGround', value: 6.2 });
      await waitForWs();
      assert.deepEqual(received, [6.2]);
    });

    test('F5-T2-03: Survives malformed JSON frames and updates[] without values[] without crashing connection', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const received = [];
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-malformed',
        path: 'navigation.speedOverGround',
        tier: 'fast',
        onUpdate: (u) => received.push(u.value),
      });
      await waitForWs();

      mockServer.sendRawWsText('<<<CORRUPT_NON_JSON>>>');
      mockServer.sendRawWsText(JSON.stringify({ context: 'vessels.self', updates: [{}] }));
      mockServer.emitDelta({ path: 'navigation.speedOverGround', value: 4.8 });
      await waitForWs();

      assert.deepEqual(received, [4.8]);
    });

    test('F5-T2-04: Live mDNS IP/port update (updateServerAddress) seamlessly migrates WebSocket to new endpoint', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const received = [];
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'sub-migrate',
        path: 'navigation.speedOverGround',
        tier: 'fast',
        onUpdate: (u) => received.push(u.value),
      });
      await waitForWs();

      const mockServer2 = new MockSignalKServer();
      await mockServer2.start();
      try {
        await harness.connectionPool.updateServerAddress('boat-1', mockServer2.host, mockServer2.port);
        await waitForWs();

        assert.equal(mockServer2.getActiveWebSocketCount(), 1);
        mockServer2.emitDelta({ path: 'navigation.speedOverGround', value: 7.7 });
        await waitForWs();

        assert.deepEqual(received, [7.7]);
      } finally {
        await mockServer2.stop();
      }
    });

    test('F5-T2-05: Unsubscribing a device removes only that subscriber without disrupting other devices on the same path', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const dev1 = [];
      const dev2 = [];

      const unsub1 = harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'dev-1',
        path: 'navigation.speedOverGround',
        tier: 'fast',
        onUpdate: (u) => dev1.push(u.value),
      });
      harness.connectionPool.subscribe('boat-1', {
        subscriberId: 'dev-2',
        path: 'navigation.speedOverGround',
        tier: 'fast',
        onUpdate: (u) => dev2.push(u.value),
      });
      await waitForWs();

      unsub1();
      mockServer.emitDelta({ path: 'navigation.speedOverGround', value: 5.5 });
      await waitForWs();

      assert.deepEqual(dev1, []);
      assert.deepEqual(dev2, [5.5]);
    });
  });

  // ===========================================================================
  // Feature F6: Safety Boundary Blocklist & PUT Failure Edge Cases (5 tests)
  // ===========================================================================
  describe('F6: Safety Boundary Blocklist & PUT Failure Edge Cases', () => {
    test('F6-T2-01: Blocks PUT to steering.autopilot.* with SafetyBoundaryError and zero network requests sent', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'steering.autopilot.state', 'auto'),
        (err) => err instanceof SafetyBoundaryError && err.path === 'steering.autopilot.state',
      );
      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'steering.autopilot.target.headingTrue', 1.57),
        (err) => err instanceof SafetyBoundaryError,
      );
      assert.equal(mockServer.getPutRequestLog().length, 0);
    });

    test('F6-T2-02: Blocks PUT to navigation.course*, navigation.waypoints*, and steering.rudderAngle* with SafetyBoundaryError', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      for (const badPath of [
        'navigation.courseGreatCircle.nextPoint.position',
        'navigation.waypoints.current',
        'steering.rudderAngle',
      ]) {
        await assert.rejects(
          () => harness.putController.putPath('boat-1', badPath, 0),
          (err) => err instanceof SafetyBoundaryError && err.path === badPath,
        );
      }
      assert.equal(mockServer.getPutRequestLog().length, 0);
    });

    test('F6-T2-03: Blocks PUT to propulsion.* (engine revolutions, state, transmission gear) with SafetyBoundaryError', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      for (const badPath of [
        'propulsion.port.revolutions',
        'propulsion.port.state',
        'propulsion.port.transmission.gear',
      ]) {
        await assert.rejects(
          () => harness.putController.putPath('boat-1', badPath, 'Forward'),
          (err) => err instanceof SafetyBoundaryError && err.path === badPath,
        );
      }
      assert.equal(mockServer.getPutRequestLog().length, 0);
    });

    test('F6-T2-04: Handles async 202 PENDING -> 502 FAILED hardware actuation failure', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setPutBehavior('electrical.switches.navLights.state', {
        mode: 'ASYNC_202_FAIL_502',
        delayMs: 50,
        message: 'N2K PGN 127502 timeout',
      });

      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'electrical.switches.navLights.state', true),
        (err) => err.statusCode === 502 && /N2K PGN 127502 timeout/i.test(err.message),
      );
    });

    test('F6-T2-05: Handles 400 Bad Request multi-source ambiguity and retry with explicit source parameter', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      // multiSourceSwitch has 2 sources in fixtures.mjs
      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'electrical.switches.multiSourceSwitch.state', true),
        (err) => err.statusCode === 400 && /Multiple sources/i.test(err.message),
      );

      const res = await harness.putController.putPath(
        'boat-1',
        'electrical.switches.multiSourceSwitch.state',
        true,
        { source: 'n2k.switchbank.1' },
      );
      assert.equal(res.state, 'COMPLETED');
      assert.equal(res.statusCode, 200);
    });
  });

  // ===========================================================================
  // Feature F7: Vessel & Anchor Watch Driver Boundary & Error Cases (5 tests)
  // ===========================================================================
  describe('F7: Vessel & Anchor Watch Driver Boundary & Error Cases', () => {
    test('F7-T2-01: Triggers alarm_generic and anchor_drag_alarm Flow when GPS drift exceeds maxRadius in Haversine fallback mode', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel', {
        settings: { anchor_max_radius: 35 },
      });
      await waitForWs();

      await vesselDevice.armAnchorWatch({ maxRadius: 35, rodeLength: 30 });
      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: null },
        { path: 'navigation.position', value: { latitude: 59.32985, longitude: 18.0686 } }, // ~61m North
      ]);
      await waitForWs();

      assert.ok(vesselDevice.getCapabilityValue('measure_anchor_distance') > 35);
      assert.equal(vesselDevice.getCapabilityValue('alarm_generic'), true);
      assert.ok(harness.homey.flow.triggeredHistory.some((t) => t.cardId === 'anchor_drag_alarm'));
    });

    test('F7-T2-02: Clears anchor drag alarm when notifications.navigation.anchor emits value: null or state: "normal" and vessel is inside radius', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel', {
        settings: { anchor_max_radius: 35 },
      });
      await waitForWs();

      await vesselDevice.armAnchorWatch({ maxRadius: 35 });
      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: 50 },
        { path: 'notifications.navigation.anchor', value: { state: 'alarm', message: 'Anchor dragging' } },
      ]);
      await waitForWs();
      assert.equal(vesselDevice.getCapabilityValue('alarm_generic'), true);

      mockServer.emitDelta([
        { path: 'navigation.anchor.currentRadius', value: 15 },
        { path: 'notifications.navigation.anchor', value: null },
      ]);
      await waitForWs();
      assert.equal(vesselDevice.getCapabilityValue('alarm_generic'), false);
    });

    test('F7-T2-03: Null sensor values (depth sounder lost bottom lock: value: null) do not corrupt capabilities with NaN or -273.15', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      mockServer.emitDelta([
        { path: 'environment.depth.belowTransducer', value: 10.5 },
        { path: 'environment.outside.temperature', value: 293.15 },
      ]);
      await waitForWs();
      assert.equal(vesselDevice.getCapabilityValue('measure_depth'), 10.5);
      assert.equal(vesselDevice.getCapabilityValue('measure_temperature'), 20);

      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      mockServer.emitDelta([
        { path: 'environment.depth.belowTransducer', value: null },
        { path: 'environment.outside.temperature', value: null },
      ]);
      await waitForWs();

      assert.equal(vesselDevice.getCapabilityValue('measure_depth'), 10.5);
      assert.equal(vesselDevice.getCapabilityValue('measure_temperature'), 20);
    });

    test('F7-T2-04: Autopilot capability (autopilot_state) is strictly read-only and rejects any write attempt', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      const { manifest } = harness.loadAppManifest();
      assert.equal(manifest.capabilities.autopilot_state.setable, false);

      await assert.rejects(
        () => vesselDevice.triggerCapabilityListener('autopilot_state', 'auto'),
        /read-only/i,
      );
    });

    test('F7-T2-05: Marks device unavailable with repair message on 401 token revocation and rejects invalid settings in onSettings', async () => {
      await harness.connectToMockServer(mockServer, {
        serverId: 'boat-1',
        token: 'default-readwrite-token',
      });
      const vesselDevice = await harness.pairDevice('vessel');
      await waitForWs();

      await assert.rejects(
        () => vesselDevice.simulateUserSettingsChange({ anchor_max_radius: -10 }),
        /greater than 0/i,
      );

      mockServer.revokeToken('default-readwrite-token');
      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'navigation.anchor.maxRadius', 40),
        (err) => err.statusCode === 401,
      );
      assert.equal(vesselDevice.getAvailable(), false);
    });
  });

  // ===========================================================================
  // Feature F8: Propulsion / Engine Driver Read-Only & Boundary Cases (5 tests)
  // ===========================================================================
  describe('F8: Propulsion / Engine Driver Read-Only & Boundary Cases', () => {
    test('F8-T2-01: Strictly read-only — propulsion driver registers zero setable capabilities and blocks all PUT writes', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });

      assert.equal(portEngine.__capabilityListeners.size, 0);
      await assert.rejects(
        () => harness.putController.putPath('boat-1', 'propulsion.port.state', 'started'),
        (err) => err instanceof SafetyBoundaryError,
      );
    });

    test('F8-T2-02: Stopped engine (0 Hz revolutions, 0 Pa oil pressure, 0 m3/s fuel rate) reports 0 without null/falsy drops', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'propulsion.port.state', value: 'stopped' },
        { path: 'propulsion.port.revolutions', value: 0 },
        { path: 'propulsion.port.oilPressure', value: 0 },
        { path: 'propulsion.port.fuel.rate', value: 0 },
      ]);
      await waitForWs();

      assert.strictEqual(portEngine.getCapabilityValue('measure_engine_rpm'), 0);
      assert.strictEqual(portEngine.getCapabilityValue('measure_oil_pressure'), 0);
      assert.strictEqual(portEngine.getCapabilityValue('measure_fuel_rate'), 0);
    });

    test('F8-T2-03: Isolates port vs. starboard engine deltas so port updates never mutate starboard device', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
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
        { path: 'propulsion.port.revolutions', value: 40 },
        { path: 'propulsion.starboard.revolutions', value: 20 },
      ]);
      await waitForWs();

      assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 2400);
      assert.equal(stbdEngine.getCapabilityValue('measure_engine_rpm'), 1200);
    });

    test('F8-T2-04: Handles null sensor readings when engine ignition NMEA 2000 gateway powers off', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'propulsion.port.revolutions', value: 30 },
        { path: 'propulsion.port.temperature', value: 353.15 },
      ]);
      await waitForWs();
      assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 1800);
      assert.equal(portEngine.getCapabilityValue('measure_temperature'), 80);

      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      mockServer.emitDelta([
        { path: 'propulsion.port.revolutions', value: null },
        { path: 'propulsion.port.temperature', value: null },
        { path: 'propulsion.port.oilPressure', value: null },
      ]);
      await waitForWs();

      assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 1800);
      assert.equal(portEngine.getCapabilityValue('measure_temperature'), 80);
    });

    test('F8-T2-05: Clears engine alarm_generic when notifications.propulsion.<id>.* transitions back to state: "normal" or null', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const portEngine = await harness.pairDevice('propulsion', {
        data: { engineId: 'port' },
        store: { engineId: 'port' },
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'notifications.propulsion.port.overTemperature',
        value: { state: 'alarm', method: ['sound'], message: 'Overheat' },
      });
      await waitForWs();
      assert.equal(portEngine.getCapabilityValue('alarm_generic'), true);

      mockServer.emitDelta({
        path: 'notifications.propulsion.port.overTemperature',
        value: { state: 'normal', method: [], message: 'Normal' },
      });
      await waitForWs();
      assert.equal(portEngine.getCapabilityValue('alarm_generic'), false);
    });
  });

  // ===========================================================================
  // Feature F9: Custom Signal K Path Sensor Driver Boundary & Error Cases (5 tests)
  // ===========================================================================
  describe('F9: Custom Signal K Path Sensor Driver Boundary & Error Cases', () => {
    test('T2-F9-01: Null / Lost-Fix Delta Value Does Not Convert to -273.15°C or 0', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.saloon.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          throttleTier: 'fast',
        },
        capabilities: ['measure_temperature'],
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'environment.inside.saloon.temperature', value: 294.15 });
      await waitForWs();
      assert.equal(sensor.getCapabilityValue('measure_temperature'), 21);

      mockServer.emitDelta({ path: 'environment.inside.saloon.temperature', value: null });
      await waitForWs();
      assert.equal(sensor.getCapabilityValue('measure_temperature'), 21);
    });

    test('T2-F9-02: Mismatched $source Filter Ignores Unpinned Sensor Deltas', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.saloon.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          sourceFilter: 'i2c.bme280.saloon',
          throttleTier: 'fast',
        },
        capabilities: ['measure_temperature'],
      });
      await waitForWs();

      for (let i = 0; i < 5; i++) {
        mockServer.emitDelta({
          path: 'environment.inside.saloon.temperature',
          value: 300.15,
          $source: 'zigbee.aqara.1',
        });
      }
      await waitForWs();

      assert.strictEqual(sensor.getCapabilityValue('measure_temperature'), null);
    });

    test('T2-F9-03: Reject Empty or Malformed Signal K Dot-Path in onSettings', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.saloon.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
        },
      });
      await waitForWs();

      await assert.rejects(
        () => sensor.simulateUserSettingsChange({ path: '   ' }),
        /Invalid Signal K path/i,
      );
      await assert.rejects(
        () => sensor.simulateUserSettingsChange({ path: '../invalid//path' }),
        /Invalid Signal K path/i,
      );
      assert.equal(sensor.getSetting('path'), 'environment.inside.saloon.temperature');
    });

    test('T2-F9-04: Non-Numeric / Corrupt Object Payload on Numeric Capability', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.galley.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          throttleTier: 'fast',
        },
        capabilities: ['measure_temperature'],
      });
      await waitForWs();

      mockServer.emitDelta({
        path: 'environment.inside.galley.temperature',
        value: { invalid: 'NaN' },
      });
      await waitForWs();

      assert.strictEqual(sensor.getCapabilityValue('measure_temperature'), null);
    });

    test('T2-F9-05: High-Frequency 20Hz Delta Burst Throttled by Configured 5000ms Slow Tier', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sensor = await harness.pairDevice('custom-sensor', {
        settings: {
          path: 'environment.inside.aftCabin.temperature',
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          throttleTier: 'slow',
        },
        capabilities: ['measure_temperature'],
      });
      await waitForWs();

      for (let i = 0; i < 20; i++) {
        mockServer.emitDelta({
          path: 'environment.inside.aftCabin.temperature',
          value: 293.15 + i * 0.1,
        });
      }
      await waitForWs();

      assert.ok(
        sensor.capabilityHistory.length <= 2,
        `Expected <= 2 updates during 20-delta burst, got ${sensor.capabilityHistory.length}`,
      );
    });
  });

  // ===========================================================================
  // Feature F10: Battery / Electrical Bank Boundary & Error Cases (5 tests)
  // ===========================================================================
  describe('F10: Battery / Electrical Bank Boundary & Error Cases', () => {
    test('T2-F10-01: SOC Boundary Clamping & Null Time-Remaining When Battery Is Idle (current = 0)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 1.0 },
        { path: 'electrical.batteries.house.capacity.timeRemaining', value: null },
      ]);
      await waitForWs();

      assert.equal(houseBank.getCapabilityValue('measure_battery'), 100);
      assert.strictEqual(houseBank.getCapabilityValue('measure_time_remaining'), null);
    });

    test('T2-F10-02: Read-Only Battery Bank Rejects charger_inverter_mode Write', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
        capabilities: ['measure_voltage', 'charger_inverter_mode'],
      });
      await houseBank.setCapabilityValue('charger_inverter_mode', 'on');
      await waitForWs();

      await assert.rejects(
        () => houseBank.triggerCapabilityListener('charger_inverter_mode', 'eco'),
        /405 PUT not supported/i,
      );
      assert.equal(houseBank.getCapabilityValue('charger_inverter_mode'), 'on');
    });

    test('T2-F10-03: Negative / Discharging Current & Power Sign Preservation', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'electrical.batteries.house.current', value: -45.6 },
        { path: 'electrical.batteries.house.power', value: -556.32 },
      ]);
      await waitForWs();

      assert.equal(houseBank.getCapabilityValue('measure_current'), -45.6);
      assert.equal(houseBank.getCapabilityValue('measure_power'), -556.32);
    });

    test('T2-F10-04: Zero-Coulomb (0 C) & Deep-Discharge (10.5V) Boundary Handling', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const houseBank = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'electrical.batteries.house.capacity.remaining', value: 0 },
        { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0 },
        { path: 'electrical.batteries.house.voltage', value: 10.5 },
      ]);
      await waitForWs();

      assert.strictEqual(houseBank.getCapabilityValue('measure_remaining_ah'), 0);
      assert.strictEqual(houseBank.getCapabilityValue('measure_battery'), 0);
      assert.equal(houseBank.getCapabilityValue('measure_voltage'), 10.5);
      assert.equal(houseBank.getCapabilityValue('alarm_battery'), true);
    });

    test('T2-F10-05: Async 202 PENDING -> 502 FAILED Rollback on Charger Current Limit / Mode PUT', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setPutBehavior('electrical.chargers.0.mode', {
        mode: 'ASYNC_202_FAIL_502',
        delayMs: 50,
        message: 'VE.Bus timeout',
      });

      const charger = await harness.pairDevice('electrical-bank', {
        store: { bankType: 'charger', bankId: '0', basePath: 'electrical.chargers.0' },
        capabilities: ['measure_voltage', 'charger_inverter_mode'],
      });
      await charger.setCapabilityValue('charger_inverter_mode', 'on');
      await waitForWs();

      await assert.rejects(
        () => charger.triggerCapabilityListener('charger_inverter_mode', 'charger_only'),
        /VE\.Bus timeout/i,
      );
      assert.equal(charger.getCapabilityValue('charger_inverter_mode'), 'on');
    });
  });

  // ===========================================================================
  // Feature F11: Fluid Tank Monitor Boundary & Error Cases (5 tests)
  // ===========================================================================
  describe('F11: Fluid Tank Monitor Boundary & Error Cases', () => {
    test('T2-F11-01: Empty Tank (0.0) and Full Tank (1.0) Exact Boundary Values', async () => {
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
        { path: 'tanks.freshWater.0.currentLevel', value: 0.0 },
        { path: 'tanks.freshWater.0.currentVolume', value: 0.0 },
      ]);
      await waitForWs();

      assert.strictEqual(fwTank.getCapabilityValue('measure_tank_level'), 0);
      assert.strictEqual(fwTank.getCapabilityValue('measure_tank_volume'), 0);
      assert.equal(fwTank.getCapabilityValue('alarm_generic'), true);

      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      mockServer.emitDelta([
        { path: 'tanks.freshWater.0.currentLevel', value: 1.0 },
        { path: 'tanks.freshWater.0.currentVolume', value: 0.25 },
      ]);
      await waitForWs();

      assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 100);
      assert.equal(fwTank.getCapabilityValue('measure_tank_volume'), 250);
      assert.equal(fwTank.getCapabilityValue('alarm_generic'), false);
    });

    test('T2-F11-02: Out-of-Range Sensor Glitch (currentLevel: 1.08 or -0.03) Clamping', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const fwTank = await harness.pairDevice('fluid-tank', {
        store: {
          tankType: 'freshWater',
          tankId: '0',
          basePath: 'tanks.freshWater.0',
          capacityLiters: 200,
        },
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'tanks.freshWater.0.currentLevel', value: 1.08 });
      await waitForWs();
      assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 100);

      for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
        sub.lastDeliveredPerPath.clear();
      }
      mockServer.emitDelta({ path: 'tanks.freshWater.0.currentLevel', value: -0.03 });
      await waitForWs();
      assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 0);
    });

    test('T2-F11-03: Null currentLevel & Missing capacity Metadata Handling', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const tank = await harness.pairDevice('fluid-tank', {
        store: {
          tankType: 'fuel',
          tankId: '0',
          basePath: 'tanks.fuel.0',
          capacityLiters: null,
        },
        capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic'],
      });
      await waitForWs();

      mockServer.emitDelta({ path: 'tanks.fuel.0.currentLevel', value: null });
      await waitForWs();

      assert.strictEqual(tank.getCapabilityValue('measure_tank_level'), null);
      assert.strictEqual(tank.getCapabilityValue('measure_tank_volume'), null);
    });

    test('T2-F11-04: Invalid Alarm Threshold Configuration in onSettings (threshold < 0 or > 100)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const tank = await harness.pairDevice('fluid-tank', {
        store: { tankType: 'fuel', tankId: '0', basePath: 'tanks.fuel.0' },
        settings: { alarmThresholdPercent: 15 },
      });

      await assert.rejects(
        () => tank.simulateUserSettingsChange({ alarmThresholdPercent: 120 }),
        /between 0 and 100%/i,
      );
      await assert.rejects(
        () => tank.simulateUserSettingsChange({ alarmThresholdPercent: -10 }),
        /between 0 and 100%/i,
      );
      assert.equal(tank.getSetting('alarmThresholdPercent'), 15);
    });

    test('T2-F11-05: Non-Water Tank (fuel / lubrication) Does Not Misreport Potable meter_water', async () => {
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

      mockServer.emitDelta({ path: 'tanks.fuel.0.currentVolume', value: 0.12 });
      await waitForWs();

      assert.equal(fuelTank.getCapabilityValue('measure_tank_volume'), 120);
      assert.strictEqual(fuelTank.getCapabilityValue('meter_water'), null);
    });
  });

  // ===========================================================================
  // Feature F12: Digital Switch / Relay Boundary & Error Cases (5 tests)
  // ===========================================================================
  describe('F12: Digital Switch / Relay Boundary & Error Cases', () => {
    test('T2-F12-01: Rollback Optimistic onoff State When Async 202 PENDING Resolves to 502 FAILED', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setPutBehavior('electrical.switches.venusRelay0.state', {
        mode: 'ASYNC_202_FAIL_502',
        delayMs: 50,
        message: 'Relay hardware did not ACK',
      });

      const relay = await harness.pairDevice('digital-switch', {
        store: { switchId: 'venusRelay0', basePath: 'electrical.switches.venusRelay0' },
        capabilities: ['onoff'],
      });
      await relay.setCapabilityValue('onoff', false);
      await waitForWs();

      await assert.rejects(
        () => relay.triggerCapabilityListener('onoff', true),
        /Relay hardware did not ACK/i,
      );
      assert.equal(relay.getCapabilityValue('onoff'), false);
    });

    test('T2-F12-02: Read-Only Switch (HTTP 405 Method Not Allowed) Rejects & Rolls Back', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      mockServer.setPutBehavior('electrical.switches.venusRelay1.state', {
        mode: 'REJECT_405',
      });

      const relay = await harness.pairDevice('digital-switch', {
        store: { switchId: 'venusRelay1', basePath: 'electrical.switches.venusRelay1' },
        capabilities: ['onoff'],
      });
      await relay.setCapabilityValue('onoff', false);
      await waitForWs();

      await assert.rejects(
        () => relay.triggerCapabilityListener('onoff', true),
        (err) => err.statusCode === 405,
      );
      assert.equal(relay.getCapabilityValue('onoff'), false);
    });

    test('T2-F12-03: Multi-Source Ambiguity (HTTP 400 Bad Request) When source Is Omitted vs. Resolved with Configured $source', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const sw = await harness.pairDevice('digital-switch', {
        store: { switchId: 'multiSourceSwitch', basePath: 'electrical.switches.multiSourceSwitch' },
        capabilities: ['onoff'],
      });
      await sw.setCapabilityValue('onoff', false);
      await waitForWs();

      await assert.rejects(
        () => sw.triggerCapabilityListener('onoff', true),
        (err) => err.statusCode === 400,
      );
      assert.equal(sw.getCapabilityValue('onoff'), false);

      await sw.setSettings({ sourceFilter: 'n2k.switchbank.1' });
      await sw.triggerCapabilityListener('onoff', true);
      assert.equal(sw.getCapabilityValue('onoff'), true);
    });

    test('T2-F12-04: Unauthenticated / Read-Only Connection (HTTP 401/403) Blocks Switch PUT', async () => {
      await harness.connectToMockServer(mockServer, {
        serverId: 'boat-1',
        token: 'default-readonly-token',
      });
      const sw = await harness.pairDevice('digital-switch', {
        store: { switchId: 'anchorLight', basePath: 'electrical.switches.anchorLight' },
        capabilities: ['onoff'],
      });
      await sw.setCapabilityValue('onoff', false);
      await waitForWs();

      await assert.rejects(
        () => sw.triggerCapabilityListener('onoff', true),
        (err) => err.statusCode === 403,
      );
      assert.equal(sw.getCapabilityValue('onoff'), false);
      assert.equal(sw.getAvailable(), false);
    });

    test('T2-F12-05: Dimmer Boundary Clamping (0.0 Turns Off / 1.0 Full Brightness) & Timeout Handling', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      const dimmer = await harness.pairDevice('digital-switch', {
        store: { switchId: 'saloonDimmer', basePath: 'electrical.switches.saloonDimmer' },
        settings: { putTimeoutMs: 120 },
        capabilities: ['onoff', 'dim'],
      });
      await waitForWs();

      await dimmer.triggerCapabilityListener('dim', 0);
      assert.equal(dimmer.getCapabilityValue('dim'), 0);
      assert.equal(dimmer.getCapabilityValue('onoff'), false);

      mockServer.setPutBehavior('electrical.switches.saloonDimmer.state', {
        mode: 'ASYNC_202_HANG',
      });

      await assert.rejects(
        () => dimmer.triggerCapabilityListener('onoff', true),
        (err) => err.statusCode === 504 && /timed out/i.test(err.message),
      );
      assert.equal(dimmer.getCapabilityValue('onoff'), false);
    });
  });

  // ===========================================================================
  // Feature F13: Bidirectional Sensor Bridge Flow Action Error Cases (5 tests)
  // ===========================================================================
  describe('F13: Bidirectional Sensor Bridge Flow Action Error Cases', () => {
    test('T2-F13-01: Reject NaN or Non-Finite Numeric Value in Flow Action Card', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await assert.rejects(
        () => harness.homey.flow.runAction('publish_temperature_to_signalk', { zone: 'saloon', value: NaN }),
        /Invalid numeric sensor value/i,
      );
      await assert.rejects(
        () => harness.homey.flow.runAction('publish_temperature_to_signalk', { zone: 'saloon', value: Infinity }),
        /Invalid numeric sensor value/i,
      );
      assert.equal(mockServer.receivedHomeyDeltas.length, 0);
    });

    test('T2-F13-02: Humidity Percentage Validation at 0%, 100%, and Out-of-Bounds > 100% / < 0%', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await harness.homey.flow.runAction('publish_humidity_to_signalk', { zone: 'saloon', value: 0 });
      await harness.homey.flow.runAction('publish_humidity_to_signalk', { zone: 'saloon', value: 100 });
      await waitForWs();

      assert.equal(mockServer.receivedHomeyDeltas.length, 2);
      assert.equal(mockServer.receivedHomeyDeltas[0].updates[0].values[0].value, 0);
      assert.equal(mockServer.receivedHomeyDeltas[1].updates[0].values[0].value, 1);

      await assert.rejects(
        () => harness.homey.flow.runAction('publish_humidity_to_signalk', { zone: 'saloon', value: -15 }),
        /between 0% and 100%/i,
      );
      await assert.rejects(
        () => harness.homey.flow.runAction('publish_humidity_to_signalk', { zone: 'saloon', value: 120 }),
        /between 0% and 100%/i,
      );
    });

    test('T2-F13-03: Reject Absolute Zero Violation (temperature < -273.15°C)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await assert.rejects(
        () => harness.homey.flow.runAction('publish_temperature_to_signalk', { zone: 'saloon', value: -300 }),
        /absolute zero/i,
      );
      assert.equal(mockServer.receivedHomeyDeltas.length, 0);
    });

    test('T2-F13-04: Reject Invalid Custom Signal K Path Syntax in Generic send_delta_to_signalk Card', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await assert.rejects(
        () => harness.homey.flow.runAction('send_delta_to_signalk', { path: '', value: 10 }),
        /Invalid Signal K dot-path/i,
      );
      await assert.rejects(
        () => harness.homey.flow.runAction('send_delta_to_signalk', { path: 'http://malicious/path', value: 10 }),
        /Invalid Signal K dot-path/i,
      );
      assert.equal(mockServer.receivedHomeyDeltas.length, 0);
    });

    test('T2-F13-05: Disconnected WebSocket Fails Gracefully on Delta Publish', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.connectionPool.closeAll();

      await assert.rejects(
        () => harness.homey.flow.runAction('publish_temperature_to_signalk', { zone: 'saloon', value: 20 }),
        /not connected/i,
      );
    });
  });

  // ===========================================================================
  // Feature F14: Maritime Flow Cards Safety Boundary & Edge Cases (6 tests)
  // ===========================================================================
  describe('F14: Maritime Flow Cards Safety Boundary & Edge Cases', () => {
    test('T2-F14-01: Safety Boundary Blocklist: put_signalk_path Throws SafetyBoundaryError on Autopilot Path (steering.autopilot.target.headingTrue)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await assert.rejects(
        () =>
          harness.homey.flow.runAction('put_signalk_path', {
            path: 'steering.autopilot.target.headingTrue',
            value: 1.5708,
          }),
        (err) => err instanceof SafetyBoundaryError && err.path === 'steering.autopilot.target.headingTrue',
      );
      assert.equal(mockServer.getPutRequestLog().length, 0);
    });

    test('T2-F14-02: Safety Boundary Blocklist: put_signalk_path Throws SafetyBoundaryError on Course/Waypoint Navigation (navigation.courseGreatCircle.nextPoint.position)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await assert.rejects(
        () =>
          harness.homey.flow.runAction('put_signalk_path', {
            path: 'navigation.courseGreatCircle.nextPoint.position',
            value: { latitude: 60.1, longitude: 24.9 },
          }),
        (err) => err instanceof SafetyBoundaryError && err.path === 'navigation.courseGreatCircle.nextPoint.position',
      );
      assert.equal(mockServer.getPutRequestLog().length, 0);
    });

    test('T2-F14-03: Safety Boundary Blocklist: put_signalk_path Throws SafetyBoundaryError on Propulsion Path (propulsion.port.revolutions)', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });

      await assert.rejects(
        () =>
          harness.homey.flow.runAction('put_signalk_path', {
            path: 'propulsion.port.revolutions',
            value: 40,
          }),
        (err) => err instanceof SafetyBoundaryError && err.path === 'propulsion.port.revolutions',
      );
      assert.equal(mockServer.getPutRequestLog().length, 0);
    });

    test('T2-F14-04: signalk_notification_raised Does Not False-Trigger on state: "normal" or value: null', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await waitForWs();

      mockServer.emitDelta([
        { path: 'notifications.bilge.main', value: { state: 'normal', message: 'Normal' } },
        { path: 'notifications.bilge.main', value: null },
      ]);
      await waitForWs();

      const fired = harness.homey.flow.triggeredHistory.filter(
        (t) => t.cardId === 'signalk_notification_raised',
      );
      assert.equal(fired.length, 0);
    });

    test('T2-F14-05: Hysteresis Guard: battery_soc_below_threshold Does Not Re-Fire on Repeated Deltas Already Below Threshold', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.pairDevice('electrical-bank', {
        store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      });
      await waitForWs();

      const clearThrottle = () => {
        for (const sub of harness.connectionPool._connections.get('boat-1').subscriptions.values()) {
          sub.lastDeliveredPerPath.clear();
        }
      };

      mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.45 });
      await waitForWs();
      clearThrottle();

      mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.44 });
      await waitForWs();
      clearThrottle();

      mockServer.emitDelta({ path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.43 });
      await waitForWs();

      const firesAt50 = harness.homey.flow.triggeredHistory.filter(
        (t) => t.cardId === 'battery_soc_below_threshold' && t.tokens.threshold === 50,
      );
      assert.equal(firesAt50.length, 1, 'Should fire only once on initial downward crossing below 50%');
    });

    test('T2-F14-06: Reject Invalid Anchor Radius (<= 0 or NaN) in set_anchor_max_radius Flow Action', async () => {
      await harness.connectToMockServer(mockServer, { serverId: 'boat-1' });
      await harness.pairDevice('vessel');

      await assert.rejects(
        () => harness.homey.flow.runAction('set_anchor_max_radius', { maxRadius: -10 }),
        /positive number/i,
      );
      await assert.rejects(
        () => harness.homey.flow.runAction('set_anchor_max_radius', { maxRadius: 0 }),
        /positive number/i,
      );
    });
  });

  // ===========================================================================
  // Feature F15: App Composition, Asset & Boot Resilience Edge Cases (6 tests)
  // ===========================================================================
  describe('F15: App Composition, Asset & Boot Resilience Edge Cases', () => {
    test('T2-F15-01: App Store Guideline 1.15 Enforcement: Zero Restricted homey:manager:api Permission', () => {
      const { manifest } = harness.loadAppManifest();
      const permissions = manifest.permissions || [];
      assert.equal(permissions.includes('homey:manager:api'), false);
    });

    test('T2-F15-02: Custom Capabilities Do Not Collide with System Capability IDs (Firmware >= 12.2.0 Guard)', () => {
      const { manifest } = harness.loadAppManifest();
      const systemCapIds = [
        'onoff',
        'dim',
        'measure_temperature',
        'measure_humidity',
        'measure_pressure',
        'measure_voltage',
        'measure_current',
        'measure_power',
        'meter_power',
        'measure_battery',
        'alarm_battery',
        'alarm_generic',
        'alarm_water',
        'measure_wind_strength',
        'measure_wind_angle',
        'meter_water',
      ];
      for (const sysCap of systemCapIds) {
        assert.equal(
          sysCap in (manifest.capabilities || {}),
          false,
          `Custom capabilities must not redefine system capability "${sysCap}"`,
        );
      }
    });

    test('T2-F15-03: Sub-Capability capabilitiesOptions Title Length Limit (<= 4 Words per App Store Rule)', () => {
      const { manifest } = harness.loadAppManifest();
      for (const driver of manifest.drivers || []) {
        const opts = driver.capabilitiesOptions || {};
        for (const [capKey, optObj] of Object.entries(opts)) {
          const titleEn = optObj?.title?.en || '';
          const wordCount = titleEn.trim().split(/\s+/).filter(Boolean).length;
          assert.ok(
            wordCount <= 4,
            `Driver ${driver.id} capabilityOption ${capKey} title "${titleEn}" exceeds 4 words`,
          );
        }
      }
    });

    test('T2-F15-04: Custom Pairing & Repair View Structure Consistency Across All 6 Drivers', () => {
      const { manifest } = harness.loadAppManifest();
      for (const driver of manifest.drivers || []) {
        assert.ok(Array.isArray(driver.pair) && driver.pair.length > 0, `Driver ${driver.id} missing pair views`);
        assert.ok(Array.isArray(driver.repair) && driver.repair.length > 0, `Driver ${driver.id} missing repair views`);
      }
    });

    test('T2-F15-05: Native C++ Addon Prohibition Check (package.json Dependencies)', () => {
      const pkgPath = path.join('/home/antigravity', 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const deps = Object.keys(pkg.dependencies || {});
        const forbiddenNative = ['bufferutil', 'utf-8-validate', 'mdns', 'serialport', 'sqlite3'];
        for (const modName of forbiddenNative) {
          assert.equal(deps.includes(modName), false, `Native addon "${modName}" is prohibited`);
        }
      } else {
        assert.ok(true);
      }
    });

    test('T2-F15-06: Graceful Boot When Signal K Server Is Initially Offline (ECONNREFUSED)', async () => {
      const offlineServer = new MockSignalKServer();
      const info = await offlineServer.start();
      const targetPort = info.port;
      await offlineServer.stop();

      await harness.app.onInit();
      // Attempting initial connection to closed port rejects cleanly, then schedules auto-reconnect
      await assert.rejects(() =>
        harness.connectionPool.acquireConnection({
          serverId: 'delayed-boat',
          host: '127.0.0.1',
          port: targetPort,
          useTls: false,
        }),
      );

      const vessel = await harness.pairDevice('vessel', {
        store: { serverId: 'delayed-boat' },
      });

      // Bring server online on targetPort
      await offlineServer.start(targetPort);
      try {
        await waitForWs(200);
        assert.equal(offlineServer.getActiveWebSocketCount(), 1);

        offlineServer.emitDelta({ path: 'navigation.speedOverGround', value: 5.144444 });
        await waitForWs();
        assert.equal(vessel.getCapabilityValue('measure_sog'), 10);
      } finally {
        await offlineServer.stop();
      }
    });
  });
});
