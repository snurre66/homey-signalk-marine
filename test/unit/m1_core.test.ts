import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WORKSPACE_ROOT = '/home/antigravity';
const BUILD_DIR = path.join(WORKSPACE_ROOT, '.homeybuild');

/**
 * Loads compiled `.homeybuild/app.js` with a mocked `homey` SDK module so
 * `SignalKMarineApp` can be tested directly in Node without a physical Homey Pro.
 */
function loadAppWithMockHomey() {
  class MockSimpleClass {
    public log(..._args: unknown[]): void {}
    public error(..._args: unknown[]): void {}
  }

  class MockApp extends MockSimpleClass {
    public homey: any;
    public manifest: any = {};
    public id = 'com.signalk.marine';
    public sdk = 3;
    constructor() {
      super();
    }
  }

  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'homey') {
      return {
        App: MockApp,
        SimpleClass: MockSimpleClass,
        default: { App: MockApp, SimpleClass: MockSimpleClass },
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };

  try {
    // Clear cached modules so each test gets a fresh load if needed
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(BUILD_DIR)) {
        delete require.cache[key];
      }
    }
    const SignalKMarineApp = require(path.join(BUILD_DIR, 'app.js'));
    return SignalKMarineApp;
  } finally {
    Module._load = origLoad;
  }
}

function createMockHomeyRuntime() {
  const settingsMap = new Map<string, unknown>();
  const triggerCards = new Map<string, any>();
  const conditionCards = new Map<string, any>();
  const actionCards = new Map<string, any>();

  const makeCard = (id: string, type: string) => ({
    id,
    type,
    runListener: null as any,
    autocompleteListeners: new Map<string, any>(),
    registerRunListener(fn: any) {
      this.runListener = fn;
      return this;
    },
    registerArgumentAutocompleteListener(argName: string, fn: any) {
      this.autocompleteListeners.set(argName, fn);
      return this;
    },
    async trigger(_tokens?: any, _state?: any) {},
  });

  const homey: any = {
    app: null,
    settings: {
      get: (k: string) => (settingsMap.has(k) ? settingsMap.get(k) : null),
      set: (k: string, v: unknown) => {
        settingsMap.set(k, v);
      },
      unset: (k: string) => {
        settingsMap.delete(k);
      },
      getKeys: () => Array.from(settingsMap.keys()),
    },
    flow: {
      getTriggerCard: (id: string) => {
        if (!triggerCards.has(id)) triggerCards.set(id, makeCard(id, 'trigger'));
        return triggerCards.get(id);
      },
      getConditionCard: (id: string) => {
        if (!conditionCards.has(id)) conditionCards.set(id, makeCard(id, 'condition'));
        return conditionCards.get(id);
      },
      getActionCard: (id: string) => {
        if (!actionCards.has(id)) actionCards.set(id, makeCard(id, 'action'));
        return actionCards.get(id);
      },
    },
    drivers: {
      getDriver: () => ({ getDevices: () => [] }),
    },
  };

  return { homey, settingsMap, triggerCards, conditionCards, actionCards };
}

describe('M1 Core: SignalKMarineApp (`app.ts`) & Manifest Composition', () => {
  let app: any;
  let mockRuntime: ReturnType<typeof createMockHomeyRuntime>;

  beforeEach(() => {
    const SignalKMarineApp = loadAppWithMockHomey();
    mockRuntime = createMockHomeyRuntime();
    app = new SignalKMarineApp();
    app.homey = mockRuntime.homey;
    mockRuntime.homey.app = app;
  });

  afterEach(async () => {
    if (app) {
      await app.onUninit();
    }
  });

  test('onInit() instantiates and exposes all 8 core services and accessors', async () => {
    await app.onInit();

    assert.ok(app.connectionPool);
    assert.ok(app.authManager);
    assert.ok(app.putController);
    assert.ok(app.discoveryService);
    assert.ok(app.unitConverter);
    assert.ok(app.anchorCalculator);
    assert.ok(app.safetyBoundary);
    assert.ok(app.flowCardManager);

    assert.equal(app.getConnectionPool(), app.connectionPool);
    assert.equal(app.getAuthManager(), app.authManager);
    assert.equal(app.getPutController(), app.putController);
    assert.equal(app.getDiscoveryService(), app.discoveryService);
    assert.equal(app.getUnitConverter(), app.unitConverter);
    assert.equal(app.getAnchorCalculator(), app.anchorCalculator);
    assert.equal(app.getSafetyBoundary(), app.safetyBoundary);
    assert.equal(app.getFlowCardManager(), app.flowCardManager);
  });

  test('onInit() generates and persists a valid RFC 4122 UUIDv4 clientId', async () => {
    await app.onInit();

    const clientId = app.ensureClientId();
    assert.equal(app.authManager.isValidUuidV4(clientId), true);
    assert.equal(mockRuntime.settingsMap.get('signalk_client_id'), clientId);

    // Calling ensureClientId again preserves existing persistent ID
    assert.equal(app.ensureClientId(), clientId);
  });

  test('onInit() is idempotent and registers all Flow cards exactly once', async () => {
    await app.onInit();
    await app.onInit();

    assert.equal(mockRuntime.triggerCards.size, 6);
    assert.equal(mockRuntime.conditionCards.size, 5);
    assert.equal(mockRuntime.actionCards.size, 11);
  });

  test('defaultServerId management and settings restoration', async () => {
    mockRuntime.settingsMap.set('signalk_default_server_id', 'openplotter-main');
    mockRuntime.settingsMap.set('signalk_servers', {
      'openplotter-main': {
        host: '192.168.1.50',
        port: 3000,
        useTls: false,
        allowSelfSigned: true,
        token: 'jwt-123',
      },
    });

    await app.onInit();

    assert.equal(app.getDefaultServerId(), 'openplotter-main');
    assert.deepEqual(app.getRegisteredServerIds(), ['openplotter-main']);
    const cfg = app.getServerConfig();
    assert.equal(cfg.host, '192.168.1.50');
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.token, 'jwt-123');

    app.setDefaultServerId('backup-pi');
    assert.equal(app.getDefaultServerId(), 'backup-pi');
    assert.equal(mockRuntime.settingsMap.get('signalk_default_server_id'), 'backup-pi');
  });

  test('onUninit() cleanly shuts down flowCardManager and connectionPool', async () => {
    await app.onInit();

    let flowDestroyed = false;
    let poolClosed = false;

    const origDestroy = app.flowCardManager.destroy.bind(app.flowCardManager);
    app.flowCardManager.destroy = () => {
      flowDestroyed = true;
      origDestroy();
    };

    const origCloseAll = app.connectionPool.closeAll.bind(app.connectionPool);
    app.connectionPool.closeAll = async () => {
      poolClosed = true;
      await origCloseAll();
    };

    await app.onUninit();

    assert.equal(flowDestroyed, true);
    assert.equal(poolClosed, true);
  });

  test('SafetyBoundary blocks steering.*, propulsion.*, and non-anchor navigation.*', async () => {
    await app.onInit();

    assert.equal(app.safetyBoundary.isWritablePath('electrical.switches.cabin.state'), true);
    assert.equal(app.safetyBoundary.isWritablePath('navigation.anchor.maxRadius'), true);
    assert.equal(app.safetyBoundary.isWritablePath('electrical.inverters.0.inverterMode'), true);
    assert.equal(app.safetyBoundary.isWritablePath('steering.autopilot.target.headingTrue'), false);
    assert.equal(app.safetyBoundary.isWritablePath('propulsion.port.revolutions'), false);
    assert.equal(app.safetyBoundary.isWritablePath('navigation.courseGreatCircle.nextPoint.position'), false);

    assert.throws(() => app.safetyBoundary.assertWritablePath('steering.autopilot.state'), {
      name: 'SafetyBoundaryError',
    });
  });

  test('UnitConverter converts SI <-> Marine units accurately and guards null/NaN', async () => {
    await app.onInit();

    assert.equal(app.unitConverter.toSignalK(21.5, 'temperature_k_to_c'), 294.65);
    assert.equal(app.unitConverter.fromSignalK(294.65, 'temperature_k_to_c', 2), 21.5);
    assert.equal(app.unitConverter.toSignalK(62.5, 'ratio_to_percent'), 0.625);
    assert.equal(app.unitConverter.toSignalK(1013.25, 'pressure_pa_to_hpa'), 101325);
    assert.equal(app.unitConverter.fromSignalK(null, 'temperature_k_to_c'), null);
    assert.equal(app.unitConverter.fromSignalK(Number.NaN, 'temperature_k_to_c'), null);
  });

  test('.homeycompose/app.json meets SDK v3 local platform and App Store rules', () => {
    const appJsonPath = path.join(WORKSPACE_ROOT, '.homeycompose', 'app.json');
    const manifest = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));

    assert.equal(manifest.id, 'com.signalk.marine');
    assert.equal(manifest.sdk, 3);
    assert.deepEqual(manifest.platforms, ['local']);
    assert.equal((manifest.permissions || []).includes('homey:manager:api'), false);
  });
});
