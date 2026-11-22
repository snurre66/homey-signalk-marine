import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import * as nodeModule from 'node:module';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

import { createDefaultVesselTree } from '../e2e/harness/fixtures.mjs';

const WORKSPACE_ROOT = '/home/antigravity';
const localRequire = createRequire(import.meta.url);

class MockHomeyDriver {
  homey: any;
  manifest: any;
  log(..._args: any[]) {}
  error(..._args: any[]) {}
}

class MockHomeyDevice {
  homey: any;
  log(..._args: any[]) {}
  error(..._args: any[]) {}
}

const moduleCache = new Map<string, any>();

function loadTsModule(absOrRelPath: string): any {
  const resolved = absOrRelPath.startsWith('/')
    ? absOrRelPath
    : path.resolve(WORKSPACE_ROOT, absOrRelPath);
  const candidates = [resolved, `${resolved}.ts`, `${resolved}.js`];
  const filePath = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!filePath) {
    throw new Error(`Module not found: ${absOrRelPath}`);
  }
  if (moduleCache.has(filePath)) {
    return moduleCache.get(filePath);
  }

  const rawCode = fs.readFileSync(filePath, 'utf8');
  let jsCode = filePath.endsWith('.ts')
    ? nodeModule.stripTypeScriptTypes(rawCode, { mode: 'transform' })
    : rawCode;

  // Transform ESM syntax into CommonJS for VM execution (Node 22 stripTypeScriptTypes preserves ESM)
  jsCode = jsCode
    .replace(/import\s+type\s+[^;]+;/g, '')
    .replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g, 'const $1 = require("$2");')
    .replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/g, (_m, names, mod) => {
      const cleaned = names
        .split(',')
        .map((n: string) => n.trim())
        .filter((n: string) => n && !n.startsWith('type '))
        .map((n: string) => n.replace(/\s+as\s+/g, ': '))
        .join(', ');
      return cleaned ? `const { ${cleaned} } = require("${mod}");` : '';
    })
    .replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g, 'const $1 = (require("$2").default ?? require("$2"));')
    .replace(/export\s+default\s+/g, 'exports.default = ')
    .replace(/export\s+(async\s+function|function|class|const|let|var)\s+(\w+)/g, (_m, kind, name) => {
      return `${kind} ${name}; exports.${name} = ${name};`;
    });

  // Fix `const x; exports.x = x` for function/class/const declarations cleanly
  jsCode = jsCode.replace(
    /(const|let|var)\s+(\w+);\s*exports\.(\w+)\s*=\s*(\w+)\s*=/g,
    'exports.$2 = $1 $2 =',
  );

  // Better: reset and use a simpler two-pass CJS transform
  jsCode = filePath.endsWith('.ts')
    ? nodeModule.stripTypeScriptTypes(rawCode, { mode: 'transform' })
    : rawCode;
  const exportedNames: string[] = [];
  jsCode = jsCode
    .replace(/import\s+type\s+[^;]+;/g, '')
    .replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g, 'const $1 = require("$2");')
    .replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"]([^'"]+)['"];?/g, (_m, names, mod) => {
      const cleaned = names
        .split(',')
        .map((n: string) => n.trim())
        .filter((n: string) => n && !n.startsWith('type '))
        .map((n: string) => n.replace(/\s+as\s+/g, ': '))
        .join(', ');
      return cleaned ? `const { ${cleaned} } = require("${mod}");` : '';
    })
    .replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g, 'const $1 = (require("$2").default ?? require("$2"));')
    .replace(/export\s+default\s+/g, 'exports.default = ')
    .replace(/export\s+(async\s+function|function|class|const|let|var)\s+(\w+)/g, (_m, kind, name) => {
      exportedNames.push(name);
      return `${kind} ${name}`;
    });
  if (exportedNames.length > 0) {
    jsCode += `\n${exportedNames.map((n) => `exports.${n} = ${n};`).join('\n')}\n`;
  }

  const modExports: Record<string, any> = {};
  const modObj = { exports: modExports };
  moduleCache.set(filePath, modExports);

  const customRequire = (id: string) => {
    if (id === 'homey') {
      return {
        Driver: MockHomeyDriver,
        Device: MockHomeyDevice,
        default: { Driver: MockHomeyDriver, Device: MockHomeyDevice },
      };
    }
    if (id.startsWith('.')) {
      return loadTsModule(path.resolve(path.dirname(filePath), id));
    }
    return localRequire(id);
  };

  const fn = new vm.Script(
    `(function(exports, require, module, __filename, __dirname) { ${jsCode}\n})`,
    { filename: filePath },
  ).runInThisContext();
  fn(modExports, customRequire, modObj, filePath, path.dirname(filePath));
  moduleCache.set(filePath, modObj.exports);
  return modObj.exports;
}

const { UnitConverter } = loadTsModule('lib/UnitConverter');
const { AnchorWatchCalculator } = loadTsModule('lib/AnchorWatchCalculator');
const { SafetyBoundary, SafetyBoundaryError } = loadTsModule('lib/SafetyBoundary');
const { PathDiscoveryService } = loadTsModule('lib/PathDiscoveryService');

/**
 * Lightweight mock Homey SDK v3 environment for unit-testing M2 drivers
 * (`vessel`, `propulsion`, `custom-sensor`) without modifying `app.ts` or `lib/`.
 */
function createMockHomeyRuntime() {
  const settingsStore = new Map<string, any>();
  const flowTriggers = new Map<string, { triggered: Array<any> }>();
  const subscriptions: Array<{
    serverId: string;
    sub: any;
  }> = [];
  const putCalls: Array<{ serverId: string; path: string; value: unknown; options?: any }> = [];
  const acquiredConnections: Array<any> = [];
  const addressUpdates: Array<{ serverId: string; host: string; port: number }> = [];

  const safetyBoundary = new SafetyBoundary();
  const unitConverter = new UnitConverter();
  const anchorCalculator = new AnchorWatchCalculator();
  const pathDiscoveryService = new PathDiscoveryService(safetyBoundary);
  let selfTree: Record<string, any> = createDefaultVesselTree();

  const poolEmitter = new EventEmitter();
  const connectionPool = Object.assign(poolEmitter, {
    acquireConnection: async (cfg: any) => {
      acquiredConnections.push(cfg);
    },
    subscribe: (serverId: string, sub: any) => {
      const entry = { serverId, sub };
      subscriptions.push(entry);
      return () => {
        const idx = subscriptions.indexOf(entry);
        if (idx >= 0) subscriptions.splice(idx, 1);
      };
    },
    updateServerAddress: async (serverId: string, host: string, port: number) => {
      addressUpdates.push({ serverId, host, port });
    },
    publishDelta: async () => {},
    putPath: async (serverId: string, skPath: string, value: unknown, options?: any) => {
      safetyBoundary.assertWritablePath(skPath);
      putCalls.push({ serverId, path: skPath, value, options });
      return { state: 'COMPLETED' as const, statusCode: 200 };
    },
    getVesselSubtree: async (_serverId: string, subPath?: string) => {
      if (subPath === 'navigation/position') {
        return selfTree.navigation?.position ?? {};
      }
      return selfTree;
    },
    releaseConnection: async () => {},
    closeAll: async () => {},
  });

  const discoveryResults: Record<string, any> = {
    'urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d': {
      id: 'urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d',
      name: 'OpenPlotter Signal K',
      address: '192.168.1.42',
      host: 'openplotter.local',
      port: 3000,
      txt: { self: 'urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d' },
    },
  };

  const homey: any = {
    __: (k: string) => k,
    settings: {
      get: (k: string) => settingsStore.get(k),
      set: (k: string, v: any) => settingsStore.set(k, v),
    },
    discovery: {
      getStrategy: (_id: string) => ({
        getDiscoveryResults: () => discoveryResults,
      }),
    },
    flow: {
      getTriggerCard: (cardId: string) => {
        if (!flowTriggers.has(cardId)) {
          flowTriggers.set(cardId, { triggered: [] });
        }
        return {
          trigger: async (tokens: any, state: any) => {
            flowTriggers.get(cardId)!.triggered.push({ tokens, state });
          },
        };
      },
    },
    app: {
      connectionPool,
      unitConverter,
      anchorCalculator,
      pathDiscoveryService,
      safetyBoundary,
    },
  };

  const emitDelta = (skPath: string, value: unknown, $source = 'n2k.test') => {
    for (const { sub } of [...subscriptions]) {
      const pattern = String(sub.path);
      const matches =
        pattern === skPath ||
        (pattern.endsWith('.*') && skPath.startsWith(pattern.slice(0, -1)));
      if (!matches) continue;
      if (sub.sourceFilter && sub.sourceFilter !== $source) continue;
      sub.onUpdate({
        path: skPath,
        value,
        $source,
        timestamp: new Date().toISOString(),
      });
    }
  };

  return {
    homey,
    subscriptions,
    putCalls,
    acquiredConnections,
    addressUpdates,
    flowTriggers,
    connectionPool,
    emitDelta,
    setSelfTree: (t: Record<string, any>) => {
      selfTree = t;
    },
  };
}

function createDeviceHarness(
  DeviceClass: any,
  homey: any,
  opts: {
    data?: Record<string, any>;
    store?: Record<string, any>;
    settings?: Record<string, any>;
    capabilities?: string[];
  } = {},
) {
  const data = { id: 'dev-1', serverId: 'boat-1', ...(opts.data || {}) };
  const store: Record<string, any> = { serverId: 'boat-1', ...(opts.store || {}) };
  const settings: Record<string, any> = { ...(opts.settings || {}) };
  const capabilities = [...(opts.capabilities || [])];
  const capValues = new Map<string, any>();
  const capListeners = new Map<string, (val: any, opts?: any) => Promise<void> | void>();
  let available = true;
  let unavailableMessage: string | null = null;

  const instance = new DeviceClass();
  Object.assign(instance, {
    homey,
    log: () => {},
    error: () => {},
    getData: () => data,
    getStore: () => ({ ...store }),
    getStoreValue: (k: string) => store[k],
    setStoreValue: async (k: string, v: any) => {
      store[k] = v;
    },
    getSetting: (k: string) => settings[k],
    getSettings: () => ({ ...settings }),
    setSettings: async (next: Record<string, any>) => {
      Object.assign(settings, next);
    },
    getCapabilities: () => [...capabilities],
    hasCapability: (c: string) => capabilities.includes(c),
    addCapability: async (c: string) => {
      if (!capabilities.includes(c)) capabilities.push(c);
    },
    getCapabilityValue: (c: string) => (capValues.has(c) ? capValues.get(c) : null),
    setCapabilityValue: async (c: string, v: any) => {
      if (typeof v === 'number' && !Number.isFinite(v)) {
        throw new TypeError(`Non-finite value for ${c}`);
      }
      capValues.set(c, v);
    },
    registerCapabilityListener: (c: string, fn: any) => {
      capListeners.set(c, fn);
    },
    getAvailable: () => available,
    setAvailable: async () => {
      available = true;
      unavailableMessage = null;
    },
    setUnavailable: async (msg?: string) => {
      available = false;
      unavailableMessage = msg || null;
    },
    getUnavailableMessage: () => unavailableMessage,
    triggerCapabilityListener: async (c: string, v: any) => {
      const fn = capListeners.get(c);
      if (!fn) throw new Error(`Capability "${c}" is read-only`);
      await fn(v);
    },
    simulateUserSettingsChange: async (changed: Record<string, any>) => {
      const oldSettings = { ...settings };
      const newSettings = { ...settings, ...changed };
      Object.assign(settings, newSettings);
      try {
        await instance.onSettings({
          oldSettings,
          newSettings,
          changedKeys: Object.keys(changed),
        });
      } catch (err) {
        Object.assign(settings, oldSettings);
        throw err;
      }
    },
    __capListeners: capListeners,
  });

  return instance;
}

function createDriverHarness(DriverClass: any, homey: any, manifest: Record<string, any>) {
  const driver = Object.create(DriverClass.prototype);
  // Run constructor field initializers cleanly by instantiating with dummy prototype or calling fields
  const raw = new DriverClass();
  Object.assign(driver, raw, {
    homey,
    manifest,
    log: () => {},
    error: () => {},
  });
  return driver;
}

function createPairSessionMock() {
  const handlers = new Map<string, (data?: any) => Promise<any>>();
  return {
    setHandler: (evt: string, fn: (data?: any) => Promise<any>) => {
      handlers.set(evt, fn);
    },
    emit: async (evt: string, data?: any) => {
      const fn = handlers.get(evt);
      if (!fn) throw new Error(`No handler for ${evt}`);
      return fn(data);
    },
  };
}

// Load M2 driver classes via TypeScript-stripping CJS loader
const VesselDriverMod = loadTsModule('drivers/vessel/driver');
const VesselDeviceMod = loadTsModule('drivers/vessel/device');
const PropulsionDriverMod = loadTsModule('drivers/propulsion/driver');
const PropulsionDeviceMod = loadTsModule('drivers/propulsion/device');
const CustomSensorDriverMod = loadTsModule('drivers/custom-sensor/driver');
const CustomSensorDeviceMod = loadTsModule('drivers/custom-sensor/device');

const VesselDriver = VesselDriverMod.default;
const VesselDevice = VesselDeviceMod.default;
const PropulsionDriver = PropulsionDriverMod.default;
const PropulsionDevice = PropulsionDeviceMod.default;
const CustomSensorDriver = CustomSensorDriverMod.default;
const CustomSensorDevice = CustomSensorDeviceMod.default;

describe('Milestone M2 Drivers Unit Tests', () => {
  let rt: ReturnType<typeof createMockHomeyRuntime>;

  beforeEach(() => {
    rt = createMockHomeyRuntime();
  });

  describe('M2 Compose Schemas & Assets', () => {
    it('all 3 M2 drivers have valid driver.compose.json, driver.settings.compose.json, HTML views, SVG icons & PNG images', () => {
      const rootIcon = fs.readFileSync('/home/antigravity/assets/icon.svg', 'utf8');
      for (const driverId of ['vessel', 'propulsion', 'custom-sensor']) {
        const baseDir = path.join('/home/antigravity/drivers', driverId);
        const compose = JSON.parse(fs.readFileSync(path.join(baseDir, 'driver.compose.json'), 'utf8'));
        const settings = JSON.parse(
          fs.readFileSync(path.join(baseDir, 'driver.settings.compose.json'), 'utf8'),
        );

        assert.equal(compose.id, driverId);
        assert.ok(Array.isArray(compose.$extends) && compose.$extends.includes('signalk_base'));
        assert.ok(Array.isArray(compose.capabilities) && compose.capabilities.length > 0);
        assert.ok(Array.isArray(settings) && settings.length > 0);

        const pairHtml = fs.readFileSync(path.join(baseDir, 'pair/connect_server.html'), 'utf8');
        const repairHtml = fs.readFileSync(path.join(baseDir, 'repair/reconnect_server.html'), 'utf8');
        assert.ok(pairHtml.includes('Homey.emit'));
        assert.ok(pairHtml.includes('Homey.showView'));
        assert.ok(repairHtml.includes('Homey.emit'));

        const svg = fs.readFileSync(path.join(baseDir, 'assets/icon.svg'), 'utf8');
        assert.ok(svg.includes('<svg'));
        assert.notEqual(svg.trim(), rootIcon.trim());

        const smallPng = fs.readFileSync(path.join(baseDir, 'assets/images/small.png'));
        const largePng = fs.readFileSync(path.join(baseDir, 'assets/images/large.png'));
        assert.equal(smallPng.readUInt32BE(16), 75);
        assert.equal(smallPng.readUInt32BE(20), 75);
        assert.equal(largePng.readUInt32BE(16), 500);
        assert.equal(largePng.readUInt32BE(20), 500);
      }
    });
  });

  describe('Vessel & Anchor Watch Driver (drivers/vessel)', () => {
    it('discovers vessel during pairing, handles connect_server & onRepair', async () => {
      const compose = JSON.parse(
        fs.readFileSync('/home/antigravity/drivers/vessel/driver.compose.json', 'utf8'),
      );
      const driver = createDriverHarness(VesselDriver, rt.homey, compose);
      await driver.onInit();

      const session = createPairSessionMock();
      await driver.onPair(session as any);

      const discoveredServers = await session.emit('discover_servers');
      assert.equal(discoveredServers.length, 1);
      assert.equal(discoveredServers[0].address, '192.168.1.42');

      const connRes = await session.emit('connect_server', {
        serverId: 'boat-1',
        host: '127.0.0.1',
        port: 3000,
        token: 'jwt-123',
      });
      assert.equal(connRes.ok, true);
      assert.equal(rt.acquiredConnections.length, 1);

      const devices = await session.emit('list_devices');
      assert.equal(devices.length, 1);
      assert.equal(devices[0].name, 'S/Y Northern Star');
      assert.ok(devices[0].capabilities.includes('onoff.anchor_armed'));
    });

    it('supports HTTP Access Request flow during pairing when server returns 401 -> 202 PENDING -> 200 APPROVED', async () => {
      let pollCount = 0;
      const server = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/signalk/v1/api/vessels/self') {
          res.statusCode = 401;
          res.end(JSON.stringify({ message: 'Unauthorized' }));
          return;
        }
        if (req.method === 'POST' && req.url === '/signalk/v1/access/requests') {
          res.statusCode = 202;
          res.end(
            JSON.stringify({
              state: 'PENDING',
              requestId: 'req-42',
              href: '/signalk/v1/access/requests/req-42',
            }),
          );
          return;
        }
        if (req.method === 'GET' && req.url === '/signalk/v1/access/requests/req-42') {
          pollCount++;
          res.statusCode = 200;
          res.end(
            JSON.stringify({
              state: 'COMPLETED',
              accessRequest: {
                permission: 'APPROVED',
                token: 'approved-jwt-xyz',
              },
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end('{}');
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      try {
        const compose = JSON.parse(
          fs.readFileSync('/home/antigravity/drivers/vessel/driver.compose.json', 'utf8'),
        );
        const driver = createDriverHarness(VesselDriver, rt.homey, compose);
        const session = createPairSessionMock();
        await driver.onPair(session as any);

        const pending = await session.emit('connect_server', {
          host: '127.0.0.1',
          port,
          requestAccessIfNeeded: true,
        });
        assert.equal(pending.ok, false);
        assert.equal(pending.state, 'PENDING');
        assert.equal(pending.requestId, 'req-42');

        const approved = await session.emit('poll_access_request', pending);
        assert.equal(approved.ok, true);
        assert.equal(approved.token, 'approved-jwt-xyz');
        assert.ok(pollCount >= 1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('converts navigation/wind/environment telemetry with null guards and speed_unit changes', async () => {
      const compose = JSON.parse(
        fs.readFileSync('/home/antigravity/drivers/vessel/driver.compose.json', 'utf8'),
      );
      const dev = createDeviceHarness(VesselDevice, rt.homey, {
        capabilities: compose.capabilities,
        settings: { speed_unit: 'kn', anchor_max_radius: 40, anchor_rode_length: 30 },
      });
      await dev.onInit();

      rt.emitDelta('navigation.speedOverGround', 3.60111);
      rt.emitDelta('navigation.courseOverGroundTrue', Math.PI / 2);
      rt.emitDelta('environment.wind.angleApparent', -Math.PI / 6);
      rt.emitDelta('environment.outside.pressure', 101520);
      rt.emitDelta('environment.outside.temperature', 291.15);
      rt.emitDelta('navigation.state', 'sailing');
      rt.emitDelta('steering.autopilot.state', 'wind');
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(dev.getCapabilityValue('measure_sog'), 7);
      assert.equal(dev.getCapabilityValue('measure_cog'), 90);
      assert.equal(dev.getCapabilityValue('measure_wind_angle'), -30);
      assert.equal(dev.getCapabilityValue('measure_pressure'), 1015.2);
      assert.equal(dev.getCapabilityValue('measure_temperature'), 18);
      assert.equal(dev.getCapabilityValue('navigation_state'), 'sailing');
      assert.equal(dev.getCapabilityValue('autopilot_state'), 'wind');

      // Null safety: lost fix does not overwrite with -273.15 or 0
      rt.emitDelta('environment.outside.temperature', null);
      rt.emitDelta('navigation.speedOverGround', null);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(dev.getCapabilityValue('measure_temperature'), 18);
      assert.equal(dev.getCapabilityValue('measure_sog'), 7);

      // Speed unit setting change recomputes cached speed
      await dev.simulateUserSettingsChange({ speed_unit: 'm/s' });
      assert.equal(dev.getCapabilityValue('measure_sog'), 3.6);

      // Strictly read-only autopilot_state & navigation_state
      assert.equal(dev.__capListeners.has('autopilot_state'), false);
      assert.equal(dev.__capListeners.has('navigation_state'), false);

      await dev.onDeleted();
      assert.equal(rt.subscriptions.length, 0);
    });

    it('supports dual-mode Anchor Watch (PUT control + Haversine GPS drift fallback + drag alarm)', async () => {
      const compose = JSON.parse(
        fs.readFileSync('/home/antigravity/drivers/vessel/driver.compose.json', 'utf8'),
      );
      const dev = createDeviceHarness(VesselDevice, rt.homey, {
        capabilities: compose.capabilities,
        settings: { anchor_max_radius: 35, anchor_rode_length: 25 },
      });
      await dev.onInit();

      await dev.triggerCapabilityListener('onoff.anchor_armed', true);
      assert.equal(dev.getCapabilityValue('onoff.anchor_armed'), true);
      assert.equal(dev.getCapabilityValue('measure_anchor_radius'), 35);
      assert.ok(rt.putCalls.some((p) => p.path === 'navigation.anchor.position'));
      assert.ok(rt.putCalls.some((p) => p.path === 'navigation.anchor.maxRadius' && p.value === 35));

      // Drift ~61m North without plugin currentRadius -> Haversine fallback raises alarm
      rt.emitDelta('navigation.anchor.currentRadius', null);
      rt.emitDelta('navigation.position', { latitude: 59.32985, longitude: 18.0686 });
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(dev.getCapabilityValue('measure_anchor_distance') > 35);
      assert.equal(dev.getCapabilityValue('alarm_generic'), true);
      assert.equal(rt.flowTriggers.get('anchor_drag_alarm')?.triggered.length, 1);

      // Disarm raises anchor & clears alarm
      await dev.triggerCapabilityListener('onoff.anchor_armed', false);
      assert.equal(dev.getCapabilityValue('onoff.anchor_armed'), false);
      assert.equal(dev.getCapabilityValue('alarm_generic'), false);
    });

    it('handles mDNS address changes and onRepair credentials update', async () => {
      const compose = JSON.parse(
        fs.readFileSync('/home/antigravity/drivers/vessel/driver.compose.json', 'utf8'),
      );
      const dev = createDeviceHarness(VesselDevice, rt.homey, {
        data: { id: 'vessel.urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d' },
        capabilities: compose.capabilities,
      });
      await dev.onInit();

      assert.equal(
        dev.onDiscoveryResult({
          id: 'urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d',
        }),
        true,
      );

      await dev.onDiscoveryAddressChanged({
        id: 'urn:mrn:signalk:uuid:c0d79334-4e25-4245-8892-54e8ccc8021d',
        address: '192.168.1.99',
        port: 3001,
      });
      assert.equal(dev.getStoreValue('host'), '192.168.1.99');
      assert.equal(dev.getStoreValue('port'), 3001);
      assert.equal(rt.addressUpdates[0].host, '192.168.1.99');

      // Repair session updates token and clears unavailable state
      await dev.setUnavailable('Token expired');
      const driver = createDriverHarness(VesselDriver, rt.homey, compose);
      const repairSession = createPairSessionMock();
      await driver.onRepair(repairSession as any, dev);
      await repairSession.emit('reconnect_server', {
        host: '192.168.1.100',
        port: 3000,
        token: 'fresh-jwt',
      });
      assert.equal(dev.getStoreValue('token'), 'fresh-jwt');
      assert.equal(dev.getAvailable(), true);
    });
  });

  describe('Propulsion / Engine Driver (drivers/propulsion)', () => {
    it('auto-discovers port and starboard engines and enforces zero PUT listeners (strictly read-only)', async () => {
      const compose = JSON.parse(
        fs.readFileSync('/home/antigravity/drivers/propulsion/driver.compose.json', 'utf8'),
      );
      const driver = createDriverHarness(PropulsionDriver, rt.homey, compose);
      const list = await driver.onPairListDevices('boat-1');
      assert.deepEqual(
        list.map((d: any) => d.data.engineId).sort(),
        ['port', 'starboard'],
      );

      const portEngine = createDeviceHarness(PropulsionDevice, rt.homey, {
        data: { id: 'boat-1::propulsion::port', serverId: 'boat-1', engineId: 'port' },
        store: { serverId: 'boat-1', engineId: 'port' },
        capabilities: compose.capabilities,
      });
      await portEngine.onInit();

      assert.equal(portEngine.__capListeners.size, 0);

      rt.emitDelta('propulsion.port.revolutions', 41.666667);
      rt.emitDelta('propulsion.port.temperature', 361.15);
      rt.emitDelta('propulsion.port.oilPressure', 380000);
      rt.emitDelta('propulsion.port.runTime', 450000);
      rt.emitDelta('propulsion.port.fuel.rate', 0.0000015);
      rt.emitDelta('propulsion.port.state', 'started');
      rt.emitDelta('propulsion.port.transmission.gear', 'Forward');
      rt.emitDelta('notifications.propulsion.port.overTemperature', {
        state: 'alarm',
        message: 'High temp',
      });
      // Unrelated starboard update should not affect port
      rt.emitDelta('propulsion.starboard.revolutions', 10);
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(portEngine.getCapabilityValue('measure_engine_rpm'), 2500);
      assert.equal(portEngine.getCapabilityValue('measure_temperature'), 88);
      assert.equal(portEngine.getCapabilityValue('measure_oil_pressure'), 3.8);
      assert.equal(portEngine.getCapabilityValue('measure_engine_hours'), 125);
      assert.equal(portEngine.getCapabilityValue('measure_fuel_rate'), 5.4);
      assert.equal(portEngine.getStoreValue('engineState'), 'started');
      assert.equal(portEngine.getStoreValue('transmissionGear'), 'Forward');
      assert.equal(portEngine.getCapabilityValue('alarm_generic'), true);

      // Clear notification back to normal
      rt.emitDelta('notifications.propulsion.port.overTemperature', { state: 'normal' });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(portEngine.getCapabilityValue('alarm_generic'), false);

      // SafetyBoundary rejects any write to propulsion
      assert.throws(() => rt.homey.app.safetyBoundary.assertWritablePath('propulsion.port.state'), SafetyBoundaryError);
    });
  });

  describe('Custom Signal K Path Sensor Driver (drivers/custom-sensor)', () => {
    it('discovers 1-Wire/RuuviTag/GPIO paths, supports $source filtering, alarms, and dynamic onSettings', async () => {
      const compose = JSON.parse(
        fs.readFileSync('/home/antigravity/drivers/custom-sensor/driver.compose.json', 'utf8'),
      );
      const driver = createDriverHarness(CustomSensorDriver, rt.homey, compose);
      const discovered = await driver.onPairListDevices('boat-1');
      assert.ok(discovered.some((d: any) => d.data.path === 'environment.inside.engineRoom.temperature'));
      assert.ok(discovered.some((d: any) => d.data.path === 'notifications.bilge.main'));

      const sensor = createDeviceHarness(CustomSensorDevice, rt.homey, {
        settings: {
          path: 'environment.inside.forwardCabin.relativeHumidity',
          capability: 'measure_humidity',
          unitCategory: 'ratio_to_percent',
          sourceFilter: 'ble.ruuvitag.fwd',
          throttleTier: 'fast',
        },
        capabilities: ['measure_humidity'],
      });
      await sensor.onInit();

      // Wrong source is ignored
      rt.emitDelta('environment.inside.forwardCabin.relativeHumidity', 0.99, 'zigbee.other');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sensor.getCapabilityValue('measure_humidity'), null);

      // Matching $source is accepted
      rt.emitDelta('environment.inside.forwardCabin.relativeHumidity', 0.645, 'ble.ruuvitag.fwd');
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sensor.getCapabilityValue('measure_humidity'), 64.5);

      // Rejects invalid path in onSettings
      await assert.rejects(
        () => sensor.simulateUserSettingsChange({ path: '../bad//path' }),
        /Invalid Signal K path/i,
      );

      // Dynamic rebinding to bilge alarm
      await sensor.simulateUserSettingsChange({
        path: 'notifications.bilge.main',
        capability: 'alarm_water',
        unitCategory: 'passthrough',
        throttleTier: 'fast',
        sourceFilter: '',
      });
      rt.emitDelta('notifications.bilge.main', { state: 'alarm', message: 'Bilge high' });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sensor.getCapabilityValue('alarm_water'), true);

      rt.emitDelta('notifications.bilge.main', null);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sensor.getCapabilityValue('alarm_water'), false);
    });
  });
});
