import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';

const require = createRequire(import.meta.url);
const WORKSPACE_ROOT = '/home/antigravity';
const BUILD_DIR = path.join(WORKSPACE_ROOT, '.homeybuild');

function loadCompiledModules() {
  class MockSimpleClass {
    public log(..._args: unknown[]): void {}
    public error(..._args: unknown[]): void {}
  }
  class MockApp extends MockSimpleClass {
    public homey: any;
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
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(BUILD_DIR)) {
        delete require.cache[key];
      }
    }
    const SignalKMarineApp = require(path.join(BUILD_DIR, 'app.js'));
    const { SafetyBoundaryError } = require(path.join(BUILD_DIR, 'lib', 'SafetyBoundary.js'));
    return { SignalKMarineApp, SafetyBoundaryError };
  } finally {
    Module._load = origLoad;
  }
}

function createFlowMockHomey() {
  const settingsMap = new Map<string, unknown>();
  const triggers = new Map<string, any>();
  const conditions = new Map<string, any>();
  const actions = new Map<string, any>();
  const triggeredHistory: Array<{ id: string; tokens: any; state: any; passed: boolean }> = [];
  const devicesByDriver = new Map<string, any[]>();

  const makeCard = (id: string, type: string) => ({
    id,
    type,
    _runListener: null as any,
    _autocompleteListeners: new Map<string, any>(),
    registerRunListener(fn: any) {
      this._runListener = fn;
      return this;
    },
    registerArgumentAutocompleteListener(argName: string, fn: any) {
      this._autocompleteListeners.set(argName, fn);
      return this;
    },
    async trigger(tokens: any = {}, state: any = {}) {
      let passed = true;
      if (typeof this._runListener === 'function') {
        passed = Boolean(await this._runListener({}, state));
      }
      triggeredHistory.push({ id, tokens, state, passed });
    },
  });

  const homey: any = {
    app: null,
    settings: {
      get: (k: string) => (settingsMap.has(k) ? settingsMap.get(k) : null),
      set: (k: string, v: unknown) => settingsMap.set(k, v),
      unset: (k: string) => settingsMap.delete(k),
      getKeys: () => Array.from(settingsMap.keys()),
    },
    flow: {
      getTriggerCard: (id: string) => {
        if (!triggers.has(id)) triggers.set(id, makeCard(id, 'trigger'));
        return triggers.get(id);
      },
      getConditionCard: (id: string) => {
        if (!conditions.has(id)) conditions.set(id, makeCard(id, 'condition'));
        return conditions.get(id);
      },
      getActionCard: (id: string) => {
        if (!actions.has(id)) actions.set(id, makeCard(id, 'action'));
        return actions.get(id);
      },
    },
    drivers: {
      getDriver: (driverId: string) => ({
        getDevices: () => devicesByDriver.get(driverId) || [],
      }),
    },
  };

  return {
    homey,
    triggers,
    conditions,
    actions,
    triggeredHistory,
    devicesByDriver,
    async runAction(id: string, args: any = {}, state: any = {}) {
      const card = actions.get(id);
      assert.ok(card && typeof card._runListener === 'function', `Missing action listener for ${id}`);
      return card._runListener(args, state);
    },
    async evaluateCondition(id: string, args: any = {}, state: any = {}) {
      const card = conditions.get(id);
      assert.ok(card && typeof card._runListener === 'function', `Missing condition listener for ${id}`);
      return Boolean(await card._runListener(args, state));
    },
    async queryAutocomplete(type: 'trigger' | 'condition' | 'action', id: string, argName: string, query = '') {
      const map = type === 'trigger' ? triggers : type === 'condition' ? conditions : actions;
      const card = map.get(id);
      assert.ok(card, `Missing card ${id}`);
      const fn = card._autocompleteListeners.get(argName);
      assert.ok(typeof fn === 'function', `Missing autocomplete listener for ${id}.${argName}`);
      return fn(query, {});
    },
  };
}

const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('M4 Flows: FlowCardManager & .homeycompose/flow/*.json', () => {
  let app: any;
  let SafetyBoundaryError: any;
  let mockHomey: ReturnType<typeof createFlowMockHomey>;
  let httpServer: http.Server;
  let wss: WebSocketServer;
  let serverPort: number;
  let receivedDeltas: any[];
  let recordedPuts: Array<{ path: string; body: any }>;
  let serverSockets: Set<any>;

  beforeEach(async () => {
    receivedDeltas = [];
    recordedPuts = [];
    serverSockets = new Set();

    httpServer = http.createServer((req, res) => {
      if (req.url === '/signalk' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            endpoints: {
              v1: {
                version: '1.7.0',
                'signalk-http': `http://127.0.0.1:${serverPort}/signalk/v1/api/`,
                'signalk-ws': `ws://127.0.0.1:${serverPort}/signalk/v1/stream`,
              },
            },
          }),
        );
        return;
      }

      if (req.url === '/signalk/v1/api/vessels/self' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            name: 'Test Yacht',
            navigation: {
              position: { value: { latitude: 59.3293, longitude: 18.0686 } },
              anchor: { maxRadius: { value: 40 } },
            },
            electrical: {
              switches: {
                cabinLight: { state: { value: false, meta: { supportsPut: true } } },
              },
              inverters: {
                '0': { inverterMode: { value: 'on', meta: { supportsPut: true } } },
              },
            },
          }),
        );
        return;
      }

      if (req.url?.startsWith('/signalk/v1/api/vessels/self/') && req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const skPath = req.url!.replace('/signalk/v1/api/vessels/self/', '').replace(/\//g, '.');
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          recordedPuts.push({ path: skPath, body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ state: 'COMPLETED', statusCode: 200 }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ noServer: true });
    httpServer.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        serverSockets.add(ws);
        ws.on('close', () => serverSockets.delete(ws));
        ws.send(JSON.stringify({ name: 'Mock SK', version: '1.7.0', self: 'vessels.urn:mrn:signalk:uuid:test' }));
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString('utf8'));
          if (Array.isArray(msg.updates)) {
            receivedDeltas.push(msg);
          }
        });
      });
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => {
        serverPort = (httpServer.address() as any).port;
        resolve();
      });
    });

    const loaded = loadCompiledModules();
    SafetyBoundaryError = loaded.SafetyBoundaryError;
    mockHomey = createFlowMockHomey();
    app = new loaded.SignalKMarineApp();
    app.homey = mockHomey.homey;
    mockHomey.homey.app = app;

    await app.onInit();
    await app.connectServer({
      serverId: 'test-boat',
      host: '127.0.0.1',
      port: serverPort,
      useTls: false,
      token: 'test-token',
    });
  });

  afterEach(async () => {
    if (app) {
      await app.onUninit();
    }
    for (const ws of serverSockets) {
      ws.close();
    }
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function emitServerDelta(values: Array<{ path: string; value: unknown }>, $source = 'n2k.test') {
    const payload = JSON.stringify({
      context: 'vessels.self',
      updates: [{ $source, timestamp: new Date().toISOString(), values }],
    });
    for (const ws of serverSockets) {
      ws.send(payload);
    }
  }

  test('.homeycompose/flow JSON files exist, validate against homey-lib schema, and match registered IDs', async () => {
    const Ajv = require('ajv');
    const HomeyLibApp = require('homey-lib/lib/App');
    const schema = HomeyLibApp.getJSONSchema();
    const ajv = new Ajv({ allErrors: true });
    const flowCardValidator = ajv.compile({
      definitions: schema.definitions,
      $ref: '#/definitions/flowCard',
    });

    const expectedTriggers = [
      'signalk_notification_raised',
      'anchor_drag_alarm',
      'navigation_state_changed',
      'battery_soc_below_threshold',
      'shore_power_status_changed',
      'path_value_updated',
    ];
    const expectedConditions = [
      'is_vessel_state',
      'is_alarm_active',
      'is_battery_soc_below',
      'is_anchor_armed',
      'path_value_comparison',
    ];
    const expectedActions = [
      'publish_temperature_to_signalk',
      'publish_humidity_to_signalk',
      'publish_pressure_to_signalk',
      'publish_switch_contact_to_signalk',
      'publish_notification_alarm',
      'publish_custom_value_to_signalk',
      'arm_anchor_watch',
      'disarm_anchor_watch',
      'set_anchor_max_radius',
      'set_charger_inverter_mode',
      'put_signalk_path',
    ];

    const checkDir = (subDir: string, expectedIds: string[], registeredMap: Map<string, any>) => {
      const dirPath = path.join(WORKSPACE_ROOT, '.homeycompose', 'flow', subDir);
      const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.json'));
      const idsFromDisk = files.map((f) => f.replace(/\.json$/, '')).sort();
      assert.deepEqual(idsFromDisk, [...expectedIds].sort());

      for (const file of files) {
        const cardDef = JSON.parse(fs.readFileSync(path.join(dirPath, file), 'utf8'));
        assert.equal(cardDef.id, file.replace(/\.json$/, ''));
        const valid = flowCardValidator(cardDef);
        assert.equal(valid, true, `Schema error in ${subDir}/${file}: ${JSON.stringify(flowCardValidator.errors)}`);
        assert.ok(registeredMap.has(cardDef.id), `Card ${cardDef.id} not registered in FlowCardManager`);
        assert.equal(typeof registeredMap.get(cardDef.id)._runListener, 'function');
      }
    };

    checkDir('triggers', expectedTriggers, mockHomey.triggers);
    checkDir('conditions', expectedConditions, mockHomey.conditions);
    checkDir('actions', expectedActions, mockHomey.actions);
  });

  test('Homey -> Signal K sensor bridge actions convert units to SI and publish WS deltas', async () => {
    await mockHomey.runAction('publish_temperature_to_signalk', {
      zone: 'mainCabin',
      temperature_c: 21.5,
      source: 'zigbee.saloon',
    });
    await mockHomey.runAction('publish_humidity_to_signalk', {
      zone: 'forwardCabin',
      humidity_pct: 62.5,
    });
    await mockHomey.runAction('publish_pressure_to_signalk', {
      zone: 'saloon',
      pressure_hpa: 1013.25,
    });
    await mockHomey.runAction('publish_switch_contact_to_signalk', {
      path: 'electrical.switches.dieselHeater.state',
      state: 'true',
    });
    await mockHomey.runAction('publish_notification_alarm', {
      path: 'notifications.security.companionwayHatch',
      state: 'alarm',
      message: 'Hatch opened',
    });
    await mockHomey.runAction('publish_custom_value_to_signalk', {
      path: 'environment.inside.galley.temperature',
      value: '296.15',
    });

    await wait(50);

    assert.equal(receivedDeltas.length, 6);
    assert.deepEqual(receivedDeltas[0].updates[0].values[0], {
      path: 'environment.inside.mainCabin.temperature',
      value: 294.65,
    });
    assert.equal(receivedDeltas[0].updates[0].$source, 'homey.zigbee.saloon');
    assert.deepEqual(receivedDeltas[1].updates[0].values[0], {
      path: 'environment.inside.forwardCabin.relativeHumidity',
      value: 0.625,
    });
    assert.deepEqual(receivedDeltas[2].updates[0].values[0], {
      path: 'environment.inside.saloon.pressure',
      value: 101325,
    });
    assert.deepEqual(receivedDeltas[3].updates[0].values[0], {
      path: 'electrical.switches.dieselHeater.state',
      value: true,
    });
    assert.equal(receivedDeltas[4].updates[0].values[0].path, 'notifications.security.companionwayHatch');
    assert.equal(receivedDeltas[4].updates[0].values[0].value.state, 'alarm');
    assert.equal(receivedDeltas[4].updates[0].values[0].value.message, 'Hatch opened');
    assert.deepEqual(receivedDeltas[5].updates[0].values[0], {
      path: 'environment.inside.galley.temperature',
      value: 296.15,
    });
  });

  test('put_signalk_path enforces SafetyBoundaryError on steering.*, propulsion.*, and non-anchor navigation.*', async () => {
    const forbidden = [
      'steering.autopilot.target.headingTrue',
      'steering.rudderAngle',
      'propulsion.port.revolutions',
      'navigation.courseGreatCircle.nextPoint.position',
      'navigation.speedOverGround',
    ];

    for (const badPath of forbidden) {
      await assert.rejects(
        () => mockHomey.runAction('put_signalk_path', { path: badPath, value: 1.5 }),
        (err: any) => err instanceof SafetyBoundaryError && err.path === badPath,
      );
    }
    assert.equal(recordedPuts.length, 0);

    // Allowed paths execute PUT successfully
    await mockHomey.runAction('put_signalk_path', {
      path: 'electrical.switches.cabinLight.state',
      value: 'true',
    });
    assert.equal(recordedPuts.length, 1);
    assert.equal(recordedPuts[0].path, 'electrical.switches.cabinLight.state');
    assert.equal(recordedPuts[0].body.value, true);
  });

  test('Anchor Watch and Charger/Inverter control actions execute valid PUT commands', async () => {
    await mockHomey.runAction('arm_anchor_watch', { max_radius: 45 });
    await mockHomey.runAction('set_anchor_max_radius', { max_radius: 55 });
    await mockHomey.runAction('disarm_anchor_watch', {});
    await mockHomey.runAction('set_charger_inverter_mode', {
      path: 'electrical.inverters.0.inverterMode',
      mode: 'eco',
    });

    assert.ok(recordedPuts.some((p) => p.path === 'navigation.anchor.position' && p.body.value !== null));
    assert.ok(recordedPuts.some((p) => p.path === 'navigation.anchor.maxRadius' && p.body.value === 45));
    assert.ok(recordedPuts.some((p) => p.path === 'navigation.anchor.maxRadius' && p.body.value === 55));
    assert.ok(recordedPuts.some((p) => p.path === 'navigation.anchor.position' && p.body.value === null));
    assert.ok(
      recordedPuts.some(
        (p) => p.path === 'electrical.inverters.0.inverterMode' && p.body.value === 'eco',
      ),
    );
  });

  test('Inbound WS deltas fire triggers and update condition evaluators', async () => {
    emitServerDelta([
      { path: 'navigation.state', value: 'motoring' },
      { path: 'environment.wind.speedApparent', value: 14.2 },
      { path: 'electrical.ac.0.phaseA.voltage', value: 230 },
      { path: 'electrical.batteries.house.voltage', value: 12.6 },
      { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.6 },
      {
        path: 'notifications.bilge.main',
        value: { state: 'alarm', message: 'Bilge water high' },
      },
    ]);
    await wait(50);

    // Condition checks on cached state
    assert.equal(await mockHomey.evaluateCondition('is_vessel_state', { state: 'motoring' }), true);
    assert.equal(await mockHomey.evaluateCondition('is_vessel_state', { state: 'sailing' }), false);
    assert.equal(
      await mockHomey.evaluateCondition('is_alarm_active', { path: 'notifications.bilge.main' }),
      true,
    );
    assert.equal(
      await mockHomey.evaluateCondition('path_value_comparison', {
        path: 'environment.wind.speedApparent',
        operator: '>',
        value: 12,
      }),
      true,
    );
    assert.equal(
      await mockHomey.evaluateCondition('is_battery_soc_below', { bank_id: 'house', threshold: 50 }),
      false,
    );

    // Check notification trigger fired
    const notifTrigger = mockHomey.triggeredHistory.find(
      (t) => t.id === 'signalk_notification_raised' && t.tokens.path === 'notifications.bilge.main',
    );
    assert.ok(notifTrigger);
    assert.equal(notifTrigger.tokens.state, 'alarm');
    assert.equal(notifTrigger.tokens.message, 'Bilge water high');

    // Wait past fast-tier 200ms throttle window for non-notification path updates
    await wait(220);

    // Emit state transitions to trigger nav state, battery SOC drop, shore power loss
    emitServerDelta([
      { path: 'navigation.state', value: 'anchored' },
      { path: 'electrical.ac.0.phaseA.voltage', value: 0 },
      { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.45 },
      { path: 'notifications.bilge.main', value: { state: 'normal', message: 'Clear' } },
    ]);
    await wait(50);

    assert.equal(
      await mockHomey.evaluateCondition('is_alarm_active', { path: 'notifications.bilge.main' }),
      false,
    );
    assert.equal(
      await mockHomey.evaluateCondition('is_battery_soc_below', { bank_id: 'house', threshold: 50 }),
      true,
    );

    const navTrigger = mockHomey.triggeredHistory.find((t) => t.id === 'navigation_state_changed');
    assert.ok(navTrigger);
    assert.equal(navTrigger.tokens.state, 'anchored');
    assert.equal(navTrigger.tokens.previous_state, 'motoring');

    const shoreTrigger = mockHomey.triggeredHistory.find((t) => t.id === 'shore_power_status_changed');
    assert.ok(shoreTrigger);
    assert.equal(shoreTrigger.tokens.connected, false);

    const socTrigger = mockHomey.triggeredHistory.find(
      (t) => t.id === 'battery_soc_below_threshold' && t.tokens.threshold === 50,
    );
    assert.ok(socTrigger);
    assert.equal(socTrigger.tokens.bank_name, 'house');
    assert.equal(socTrigger.tokens.soc, 45);
    assert.equal(socTrigger.tokens.voltage, 12.6);
  });

  test('Autocomplete listeners return discovered paths and respect SafetyBoundary for put_signalk_path', async () => {
    const putResults = await mockHomey.queryAutocomplete('action', 'put_signalk_path', 'path', '');
    assert.ok(putResults.length > 0);
    for (const item of putResults) {
      assert.equal(app.safetyBoundary.isWritablePath(item.name), true, `Non-writable path leaked: ${item.name}`);
    }

    const customResults = await mockHomey.queryAutocomplete(
      'action',
      'publish_custom_value_to_signalk',
      'path',
      'temperature',
    );
    assert.ok(customResults.some((r: any) => r.name.includes('temperature')));
  });
});
