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

function loadM3Modules() {
  class MockSimpleClass {
    public log(..._args: unknown[]): void {}
    public error(..._args: unknown[]): void {}
  }

  class MockDriver extends MockSimpleClass {
    public id = '';
    public homey: any;
    public manifest: any = {};
    public async onInit(): Promise<void> {}
    public async onPair(_session: any): Promise<void> {}
    public async onPairListDevices(): Promise<any[]> {
      return [];
    }
    public async onRepair(_session: any, _device?: any): Promise<void> {}
  }

  class MockDevice extends MockSimpleClass {
    public homey: any;
    public driver: any;
    public _data: Record<string, any> = {};
    public _store: Record<string, any> = {};
    public _settings: Record<string, any> = {};
    public _caps: string[] = [];
    public _capValues = new Map<string, any>();
    public _capListeners = new Map<string, (val: any, opts?: any) => Promise<void> | void>();
    public _available = true;
    public _unavailableMsg: string | null = null;

    public getData() {
      return { ...this._data };
    }
    public getStoreValue(key: string) {
      return this._store[key];
    }
    public async setStoreValue(key: string, val: unknown) {
      this._store[key] = val;
    }
    public getSettings() {
      return { ...this._settings };
    }
    public getSetting(key: string) {
      return this._settings[key];
    }
    public async setSettings(s: Record<string, unknown>) {
      this._settings = { ...this._settings, ...s };
    }
    public getCapabilities() {
      return [...this._caps];
    }
    public hasCapability(cap: string) {
      return this._caps.includes(cap);
    }
    public async addCapability(cap: string) {
      if (!this._caps.includes(cap)) this._caps.push(cap);
    }
    public async removeCapability(cap: string) {
      this._caps = this._caps.filter((c) => c !== cap);
      this._capValues.delete(cap);
    }
    public getCapabilityValue(cap: string) {
      return this._capValues.has(cap) ? this._capValues.get(cap) : null;
    }
    public async setCapabilityValue(cap: string, val: unknown) {
      if (typeof val === 'number' && !Number.isFinite(val)) {
        throw new TypeError(`Non-finite value for ${cap}`);
      }
      this._capValues.set(cap, val);
    }
    public registerCapabilityListener(cap: string, fn: any) {
      this._capListeners.set(cap, fn);
    }
    public async triggerCapabilityListener(cap: string, val: any, opts: any = {}) {
      const fn = this._capListeners.get(cap);
      if (!fn) throw new Error(`No listener for ${cap}`);
      return fn(val, opts);
    }
    public async setAvailable() {
      this._available = true;
      this._unavailableMsg = null;
    }
    public async setUnavailable(msg?: string | null) {
      this._available = false;
      this._unavailableMsg = msg ?? null;
    }
    public getAvailable() {
      return this._available;
    }
    public async onInit(): Promise<void> {}
    public async onSettings(_event: any): Promise<string | void> {}
    public onDiscoveryResult(_res: any): boolean {
      return false;
    }
    public async onDiscoveryAddressChanged(_res: any): Promise<void> {}
    public async onUninit(): Promise<void> {}
  }

  class MockApp extends MockSimpleClass {
    public homey: any;
  }

  const Module = require('node:module');
  const origLoad = Module._load;
  Module._load = function (request: string, parent: any, isMain: boolean) {
    if (request === 'homey') {
      const mod = {
        App: MockApp,
        Driver: MockDriver,
        Device: MockDevice,
        SimpleClass: MockSimpleClass,
      };
      return { ...mod, default: mod };
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
    const ElectricalBankDriver = require(path.join(BUILD_DIR, 'drivers', 'electrical-bank', 'driver.js'));
    const ElectricalBankDevice = require(path.join(BUILD_DIR, 'drivers', 'electrical-bank', 'device.js'));
    const FluidTankDriver = require(path.join(BUILD_DIR, 'drivers', 'fluid-tank', 'driver.js'));
    const FluidTankDevice = require(path.join(BUILD_DIR, 'drivers', 'fluid-tank', 'device.js'));
    const DigitalSwitchDriver = require(path.join(BUILD_DIR, 'drivers', 'digital-switch', 'driver.js'));
    const DigitalSwitchDevice = require(path.join(BUILD_DIR, 'drivers', 'digital-switch', 'device.js'));

    return {
      MockDevice,
      SignalKMarineApp,
      ElectricalBankDriver,
      ElectricalBankDevice,
      FluidTankDriver,
      FluidTankDevice,
      DigitalSwitchDriver,
      DigitalSwitchDevice,
    };
  } finally {
    Module._load = origLoad;
  }
}

function createMockHomey() {
  const settings = new Map<string, unknown>();
  const triggers = new Map<string, any>();
  const triggered: Array<{ id: string; tokens: any; state: any }> = [];

  const makeCard = (id: string) => ({
    id,
    _runListener: null as any,
    registerRunListener(fn: any) {
      this._runListener = fn;
      return this;
    },
    registerArgumentAutocompleteListener() {
      return this;
    },
    async trigger(tokens: any = {}, state: any = {}) {
      triggered.push({ id, tokens, state });
    },
  });

  const homey: any = {
    app: null,
    settings: {
      get: (k: string) => (settings.has(k) ? settings.get(k) : null),
      set: (k: string, v: unknown) => settings.set(k, v),
      unset: (k: string) => settings.delete(k),
      getKeys: () => Array.from(settings.keys()),
    },
    flow: {
      getTriggerCard: (id: string) => {
        if (!triggers.has(id)) triggers.set(id, makeCard(id));
        return triggers.get(id);
      },
      getConditionCard: (id: string) => makeCard(id),
      getActionCard: (id: string) => makeCard(id),
    },
    discovery: {
      getStrategy: () => ({
        getDiscoveryResults: () => ({
          'vessels.urn:mrn:signalk:uuid:test': {
            id: 'vessels.urn:mrn:signalk:uuid:test',
            name: 'OpenPlotter Test',
            address: '127.0.0.1',
            port: 3000,
          },
        }),
      }),
    },
    drivers: {
      getDriver: () => ({ getDevices: () => [] }),
    },
  };

  return { homey, triggered };
}

function createSampleVesselTree() {
  return {
    name: 'S/Y Test Vessel',
    uuid: 'urn:mrn:signalk:uuid:test',
    electrical: {
      batteries: {
        house: {
          name: 'House LiFePO4 Bank',
          voltage: { value: 13.2, meta: { units: 'V' } },
          current: { value: -5.0, meta: { units: 'A' } },
          power: { value: -66.0, meta: { units: 'W' } },
          temperature: { value: 295.15, meta: { units: 'K' } },
          capacity: {
            stateOfCharge: { value: 0.85, meta: { units: 'ratio' } },
            remaining: { value: 1080000, meta: { units: 'C' } },
            timeRemaining: { value: 72000, meta: { units: 's' } },
          },
        },
        starter: {
          name: 'Starter AGM Bank',
          voltage: { value: 12.8, meta: { units: 'V' } },
          current: { value: 0, meta: { units: 'A' } },
        },
      },
      solar: {
        0: {
          name: 'Victron SmartSolar MPPT 100/30',
          panelVoltage: { value: 36.2, meta: { units: 'V' } },
          current: { value: 15.0, meta: { units: 'A' } },
          panelPower: { value: 210.0, meta: { units: 'W' } },
          yieldToday: { value: 3600000, meta: { units: 'J' } },
        },
      },
      inverters: {
        0: {
          name: 'Victron MultiPlus Inverter',
          inverterMode: { value: 'on', meta: { supportsPut: true } },
        },
      },
      chargers: {
        0: {
          name: 'Victron MultiPlus Charger',
          mode: { value: 'on', meta: { supportsPut: true } },
        },
      },
    },
    tanks: {
      freshWater: {
        0: {
          name: 'Bow Fresh Water',
          currentLevel: { value: 0.75, meta: { units: 'ratio' } },
          currentVolume: { value: 0.15, meta: { units: 'm3' } },
          capacity: { value: 0.2, meta: { units: 'm3' } },
        },
      },
      fuel: {
        0: {
          name: 'Main Diesel Tank',
          currentLevel: { value: 0.5, meta: { units: 'ratio' } },
          capacity: { value: 0.15, meta: { units: 'm3' } },
        },
      },
      blackWater: {
        0: {
          name: 'Holding Tank',
          currentLevel: { value: 0.2, meta: { units: 'ratio' } },
          capacity: { value: 0.08, meta: { units: 'm3' } },
        },
      },
    },
    electrical_extra: {},
  };
}

function attachSwitchTree(tree: Record<string, any>) {
  tree.electrical.switches = {
    venusRelay0: {
      name: 'Victron GX Relay 0',
      state: { value: false, meta: { supportsPut: true } },
    },
    dieselHeater: {
      name: 'Autoterm Diesel Heater',
      state: { value: false, meta: { supportsPut: true } },
    },
    cabinLights: {
      name: 'Saloon Cabin Dimmer',
      state: { value: true, meta: { supportsPut: true } },
      dimmingLevel: { value: 0.75, meta: { units: 'ratio', supportsPut: true } },
    },
    bank: {
      main: {
        waterPump: {
          name: 'Main Bank Water Pump',
          state: { value: false, meta: { supportsPut: true } },
        },
      },
    },
  };
  return tree;
}

describe('Milestone M3 Drivers Unit & Integration Tests', () => {
  let mods: ReturnType<typeof loadM3Modules>;
  let httpServer: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  let wsClients: Set<any> = new Set();
  let vesselTree: Record<string, any>;
  let putRequests: Array<{ path: string; body: any }> = [];
  let putHandlerOverride: ((reqPath: string, body: any, res: http.ServerResponse) => boolean) | null = null;
  let port = 0;
  let app: any = null;

  beforeEach(async () => {
    mods = loadM3Modules();
    vesselTree = attachSwitchTree(createSampleVesselTree());
    putRequests = [];
    putHandlerOverride = null;
    wsClients = new Set();

    httpServer = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && urlPath === '/signalk') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            endpoints: {
              v1: {
                version: '1.7.0',
                'signalk-http': `http://127.0.0.1:${port}/signalk/v1/api/`,
                'signalk-ws': `ws://127.0.0.1:${port}/signalk/v1/stream`,
              },
            },
          }),
        );
        return;
      }

      if (req.method === 'GET' && urlPath === '/signalk/v1/api/vessels/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(vesselTree));
        return;
      }

      if (req.method === 'GET' && urlPath.startsWith('/signalk/v1/requests/')) {
        const reqId = urlPath.split('/').pop();
        if (reqId === 'pending-complete') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ requestId: reqId, state: 'COMPLETED', statusCode: 200 }));
          return;
        }
        if (reqId === 'pending-fail') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              requestId: reqId,
              state: 'COMPLETED',
              statusCode: 502,
              message: 'Relay hardware NACK',
            }),
          );
          return;
        }
      }

      if (req.method === 'PUT' && urlPath.startsWith('/signalk/v1/api/vessels/self/')) {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          const skPath = urlPath
            .slice('/signalk/v1/api/vessels/self/'.length)
            .replace(/\//g, '.');
          putRequests.push({ path: skPath, body });

          if (putHandlerOverride && putHandlerOverride(skPath, body, res)) {
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ state: 'COMPLETED', statusCode: 200 }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    wss = new WebSocketServer({ server: httpServer, path: '/signalk/v1/stream' });
    wss.on('connection', (ws) => {
      wsClients.add(ws);
      ws.send(
        JSON.stringify({
          name: 'mock-signalk',
          version: '2.8.2',
          self: 'vessels.urn:mrn:signalk:uuid:test',
          roles: ['master', 'main'],
        }),
      );
      ws.on('close', () => wsClients.delete(ws));
    });

    await new Promise<void>((resolve) => {
      httpServer!.listen(0, '127.0.0.1', () => {
        port = (httpServer!.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (app) {
      await app.onUninit().catch(() => {});
      app = null;
    }
    for (const ws of wsClients) {
      try {
        ws.close();
      } catch {}
    }
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
      wss = null;
    }
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = null;
    }
  });

  function broadcastDelta(values: Array<{ path: string; value: unknown; $source?: string }>) {
    const payload = JSON.stringify({
      context: 'vessels.self',
      updates: [
        {
          $source: values[0]?.$source || 'venus.test',
          timestamp: new Date().toISOString(),
          values: values.map((v) => ({ path: v.path, value: v.value })),
        },
      ],
    });
    for (const ws of wsClients) {
      ws.send(payload);
    }
  }

  async function bootConnectedApp() {
    const { homey, triggered } = createMockHomey();
    app = new mods.SignalKMarineApp();
    app.homey = homey;
    homey.app = app;
    await app.onInit();
    await app.connectServer({
      serverId: 'boat-test',
      host: '127.0.0.1',
      port,
      useTls: false,
      allowSelfSigned: true,
    });
    return { homey, triggered };
  }

  function instantiateDevice(
    DeviceClass: any,
    homey: any,
    driver: any,
    opts: {
      id: string;
      data?: Record<string, any>;
      store?: Record<string, any>;
      settings?: Record<string, any>;
      capabilities?: string[];
    },
  ) {
    const dev = new DeviceClass();
    dev.homey = homey;
    dev.driver = driver;
    dev._data = { id: opts.id, serverId: 'boat-test', ...(opts.data || {}) };
    dev._store = { serverId: 'boat-test', ...(opts.store || {}) };
    dev._settings = { ...(opts.settings || {}) };
    dev._caps = [...(opts.capabilities || [])];
    return dev;
  }

  test('1. Static M3 driver manifests, pairing/repair HTML, unique SVGs & valid PNG dimensions', () => {
    const driverIds = ['electrical-bank', 'fluid-tank', 'digital-switch'];
    const appSvg = fs.readFileSync(path.join(WORKSPACE_ROOT, 'assets/icon.svg'), 'utf8');
    const seenSvgs = new Set<string>([appSvg.trim()]);
    const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    for (const id of driverIds) {
      const base = path.join(WORKSPACE_ROOT, 'drivers', id);
      const compose = JSON.parse(fs.readFileSync(path.join(base, 'driver.compose.json'), 'utf8'));
      assert.equal(compose.id, id);
      assert.deepEqual(compose.$extends, ['signalk_base']);
      assert.ok(Array.isArray(compose.capabilities) && compose.capabilities.length > 0);

      if (id === 'electrical-bank') {
        assert.ok(compose.energy && (compose.energy.homeBattery === true || Array.isArray(compose.energy.batteries)));
        assert.ok(compose.capabilities.includes('measure_battery'));
        assert.ok(compose.capabilities.includes('charger_inverter_mode'));
      }
      if (id === 'fluid-tank') {
        assert.equal(compose.class, 'sensor');
        assert.ok(compose.capabilities.includes('measure_tank_level'));
        assert.ok(compose.capabilities.includes('measure_tank_volume'));
        assert.ok(compose.capabilities.includes('meter_water'));
      }
      if (id === 'digital-switch') {
        assert.equal(compose.class, 'socket');
        assert.deepEqual(compose.capabilities, ['onoff', 'dim']);
      }

      assert.ok(fs.existsSync(path.join(base, 'pair/connect_server.html')));
      assert.ok(fs.existsSync(path.join(base, 'repair/reconnect_server.html')));

      const svg = fs.readFileSync(path.join(base, 'assets/icon.svg'), 'utf8');
      assert.ok(svg.includes('<svg'));
      assert.equal(seenSvgs.has(svg.trim()), false, `Duplicate SVG icon for ${id}`);
      seenSvgs.add(svg.trim());

      const smallBuf = fs.readFileSync(path.join(base, 'assets/images/small.png'));
      assert.ok(smallBuf.subarray(0, 8).equals(pngSig));
      assert.equal(smallBuf.readUInt32BE(16), 75);
      assert.equal(smallBuf.readUInt32BE(20), 75);

      const largeBuf = fs.readFileSync(path.join(base, 'assets/images/large.png'));
      assert.ok(largeBuf.subarray(0, 8).equals(pngSig));
      assert.equal(largeBuf.readUInt32BE(16), 500);
      assert.equal(largeBuf.readUInt32BE(20), 500);
    }
  });

  test('2. ElectricalBankDriver auto-discovers Victron batteries, solar MPPT, chargers, and inverters via onPairListDevices & onPair', async () => {
    const { homey } = await bootConnectedApp();
    const driver = new mods.ElectricalBankDriver();
    driver.homey = homey;
    await driver.onInit();

    const list = await driver.onPairListDevices();
    assert.ok(list.some((d: any) => d.data.bankType === 'battery' && d.data.bankId === 'house'));
    assert.ok(list.some((d: any) => d.data.bankType === 'battery' && d.data.bankId === 'starter'));
    assert.ok(list.some((d: any) => d.data.bankType === 'solar' && d.data.bankId === '0'));
    assert.ok(list.some((d: any) => d.data.bankType === 'inverter' && d.data.bankId === '0'));
    assert.ok(list.some((d: any) => d.data.bankType === 'charger' && d.data.bankId === '0'));

    const house = list.find((d: any) => d.data.bankId === 'house');
    assert.ok(house.energy && house.energy.homeBattery === true);

    // Pair session flow
    const handlers = new Map<string, any>();
    await driver.onPair({ setHandler: (ev: string, fn: any) => handlers.set(ev, fn) } as any);
    const connRes = await handlers.get('connect_server')({
      serverId: 'boat-test',
      host: '127.0.0.1',
      port,
    });
    assert.equal(connRes.ok, true);
    const pairedDevices = await handlers.get('list_devices')();
    assert.equal(pairedDevices.length, list.length);
  });

  test('3. ElectricalBankDevice converts C->Ah, s->min, K->°C, ratio->%, computes W=V*I fallback, and handles alarm_battery & inverter PUT', async () => {
    const { homey, triggered } = await bootConnectedApp();
    const driver = new mods.ElectricalBankDriver();
    driver.homey = homey;

    const house = instantiateDevice(mods.ElectricalBankDevice, homey, driver, {
      id: 'house-1',
      store: { bankType: 'battery', bankId: 'house', basePath: 'electrical.batteries.house' },
      settings: { lowSocThreshold: 20, lowVoltageThreshold: 11.8, throttleTier: 'fast' },
      capabilities: [
        'measure_battery',
        'measure_voltage',
        'measure_current',
        'measure_power',
        'measure_remaining_ah',
        'measure_time_remaining',
        'measure_temperature',
        'alarm_battery',
      ],
    });
    await house.onInit();

    const inverter = instantiateDevice(mods.ElectricalBankDevice, homey, driver, {
      id: 'inv-0',
      store: { bankType: 'inverter', bankId: '0', basePath: 'electrical.inverters.0' },
      capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
    });
    await inverter.onInit();

    broadcastDelta([
      { path: 'electrical.batteries.house.voltage', value: 12.5 },
      { path: 'electrical.batteries.house.current', value: -10.0 },
      { path: 'electrical.batteries.house.capacity.stateOfCharge', value: 0.19 },
      { path: 'electrical.batteries.house.capacity.remaining', value: 288000 }, // 80 Ah
      { path: 'electrical.batteries.house.capacity.timeRemaining', value: 28800 }, // 480 min
      { path: 'electrical.batteries.house.temperature', value: 298.15 }, // 25.0 °C
    ]);

    await new Promise((r) => setTimeout(r, 60));

    assert.equal(house.getCapabilityValue('measure_voltage'), 12.5);
    assert.equal(house.getCapabilityValue('measure_current'), -10);
    assert.equal(house.getCapabilityValue('measure_power'), -125); // V*I fallback
    assert.equal(house.getCapabilityValue('measure_battery'), 19);
    assert.equal(house.getCapabilityValue('measure_remaining_ah'), 80);
    assert.equal(house.getCapabilityValue('measure_time_remaining'), 480);
    assert.equal(house.getCapabilityValue('measure_temperature'), 25);
    assert.equal(house.getCapabilityValue('alarm_battery'), true);
    assert.ok(triggered.some((t) => t.id === 'battery_soc_below_threshold'));

    // Inverter load shedding PUT
    await inverter.triggerCapabilityListener('charger_inverter_mode', 'eco');
    assert.equal(inverter.getCapabilityValue('charger_inverter_mode'), 'eco');
    assert.ok(
      putRequests.some((p) => p.path === 'electrical.inverters.0.inverterMode' && p.body.value === 'eco'),
    );

    await house.onUninit();
    await inverter.onUninit();
  });

  test('4. FluidTankDriver & FluidTankDevice convert ratio->%, m3->L, derive volume from capacity, and evaluate high/low alarms', async () => {
    const { homey } = await bootConnectedApp();
    const driver = new mods.FluidTankDriver();
    driver.homey = homey;

    const tanks = await driver.onPairListDevices();
    assert.ok(tanks.some((t: any) => t.data.tankType === 'freshWater' && t.data.tankId === '0'));
    assert.ok(tanks.some((t: any) => t.data.tankType === 'fuel' && t.data.tankId === '0'));
    assert.ok(tanks.some((t: any) => t.data.tankType === 'blackWater' && t.data.tankId === '0'));

    const fwTank = instantiateDevice(mods.FluidTankDevice, homey, driver, {
      id: 'fw-0',
      store: { tankType: 'freshWater', tankId: '0', basePath: 'tanks.freshWater.0', capacityLiters: 200 },
      settings: { throttleTier: 'fast', alarmThresholdPercent: 15 },
      capabilities: ['measure_tank_level', 'measure_tank_volume', 'meter_water', 'alarm_generic'],
    });
    const bwTank = instantiateDevice(mods.FluidTankDevice, homey, driver, {
      id: 'bw-0',
      store: { tankType: 'blackWater', tankId: '0', basePath: 'tanks.blackWater.0', capacityLiters: 80 },
      settings: { throttleTier: 'fast', alarmThresholdPercent: 85 },
      capabilities: ['measure_tank_level', 'measure_tank_volume', 'alarm_generic', 'alarm_water'],
    });
    await fwTank.onInit();
    await bwTank.onInit();

    broadcastDelta([
      { path: 'tanks.freshWater.0.currentLevel', value: 0.12 },
      { path: 'tanks.blackWater.0.currentLevel', value: 0.9 },
    ]);
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(fwTank.getCapabilityValue('measure_tank_level'), 12);
    assert.equal(fwTank.getCapabilityValue('measure_tank_volume'), 24);
    assert.equal(fwTank.getCapabilityValue('meter_water'), 0.024);
    assert.equal(fwTank.getCapabilityValue('alarm_generic'), true);

    assert.equal(bwTank.getCapabilityValue('measure_tank_level'), 90);
    assert.equal(bwTank.getCapabilityValue('measure_tank_volume'), 72);
    assert.equal(bwTank.getCapabilityValue('alarm_generic'), true);
    assert.equal(bwTank.getCapabilityValue('alarm_water'), true);

    await assert.rejects(
      () => fwTank.onSettings({ oldSettings: {}, newSettings: { alarmThresholdPercent: 150 }, changedKeys: ['alarmThresholdPercent'] }),
      /between 0 and 100%/i,
    );

    await fwTank.onUninit();
    await bwTank.onUninit();
  });

  test('5. DigitalSwitchDriver & DigitalSwitchDevice auto-discover relays/dimmers/banks and handle PUT 202 PENDING -> COMPLETED / FAILED rollback', async () => {
    const { homey } = await bootConnectedApp();
    const driver = new mods.DigitalSwitchDriver();
    driver.homey = homey;

    const switches = await driver.onPairListDevices();
    assert.ok(switches.some((s: any) => s.data.switchId === 'venusRelay0'));
    assert.ok(switches.some((s: any) => s.data.switchId === 'dieselHeater'));
    assert.ok(switches.some((s: any) => s.data.basePath === 'electrical.switches.bank.main.waterPump'));

    const cabinLights = switches.find((s: any) => s.data.switchId === 'cabinLights');
    assert.deepEqual(cabinLights.capabilities, ['onoff', 'dim']);

    const relay = instantiateDevice(mods.DigitalSwitchDevice, homey, driver, {
      id: 'sw-relay',
      store: { switchId: 'venusRelay0', basePath: 'electrical.switches.venusRelay0', hasDim: false },
      settings: { putTimeoutMs: 1000 },
      capabilities: ['onoff', 'dim'], // should auto-prune 'dim' because hasDim is false
    });
    await relay.onInit();
    assert.equal(relay.hasCapability('dim'), false);

    // 1. Async 202 PENDING -> 200 COMPLETED
    putHandlerOverride = (_p, _b, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          state: 'PENDING',
          statusCode: 202,
          requestId: 'pending-complete',
          actionResult: { href: '/signalk/v1/requests/pending-complete' },
        }),
      );
      return true;
    };
    await relay.triggerCapabilityListener('onoff', true);
    assert.equal(relay.getCapabilityValue('onoff'), true);

    // 2. Async 202 PENDING -> 502 FAILED rollback to previous state (true)
    putHandlerOverride = (_p, _b, res) => {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          state: 'PENDING',
          statusCode: 202,
          requestId: 'pending-fail',
          actionResult: { href: '/signalk/v1/requests/pending-fail' },
        }),
      );
      return true;
    };
    await assert.rejects(() => relay.triggerCapabilityListener('onoff', false), /Relay hardware NACK/);
    assert.equal(relay.getCapabilityValue('onoff'), true);

    // 3. Dimmer device PUT + external WS delta update (numeric 0/1)
    putHandlerOverride = null;
    const dimmer = instantiateDevice(mods.DigitalSwitchDevice, homey, driver, {
      id: 'sw-dim',
      store: { switchId: 'cabinLights', basePath: 'electrical.switches.cabinLights', hasDim: true },
      capabilities: ['onoff', 'dim'],
    });
    await dimmer.onInit();

    await dimmer.triggerCapabilityListener('dim', 0.4);
    assert.equal(dimmer.getCapabilityValue('dim'), 0.4);
    assert.equal(dimmer.getCapabilityValue('onoff'), true);

    broadcastDelta([{ path: 'electrical.switches.cabinLights.state', value: 0 }]);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(dimmer.getCapabilityValue('onoff'), false);

    await relay.onUninit();
    await dimmer.onUninit();
  });
});
