import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { URL } from 'node:url';
import { Rfc6455Server } from '../helpers/rfc6455_ws.mjs';
import {
  VESSEL_SELF_URN,
  VESSEL_UUID,
  SERVER_INFO,
  DEFAULT_TIMESTAMP,
  createDefaultVesselTree,
  makeLeaf,
} from './fixtures.mjs';

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Compiles a Signal K subscription path pattern (e.g. "electrical.batteries.*" or "navigation.speedOverGround")
 * into a RegExp.
 */
function compileSubscriptionRegex(pattern) {
  if (!pattern || pattern === '*') {
    return /^.+$/;
  }
  const escaped = String(pattern)
    .split('.')
    .map((segment) => {
      if (segment === '**') return '.+';
      if (segment === '*') return '[^.]+';
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('\\.');
  return new RegExp(`^${escaped}(\\..+)?$`);
}

/**
 * Checks whether a dot-path is writable by default on the Mock Signal K Server.
 */
function isDefaultWritableSignalKPath(dotPath, anchorPutDisabled = false) {
  if (/^electrical\.switches\..+\.(state|dimmingLevel)$/.test(dotPath)) return true;
  if (/^electrical\.chargers\.[^.]+\.(mode|currentLimit|state)$/.test(dotPath)) return true;
  if (/^electrical\.inverters\.[^.]+\.(inverterMode|mode|state)$/.test(dotPath)) return true;
  if (!anchorPutDisabled && /^navigation\.anchor\.(position|maxRadius|rodeLength|currentRadius)$/.test(dotPath)) {
    return true;
  }
  return false;
}

/**
 * Ephemeral localhost HTTP REST + RFC 6455 WebSocket Mock Signal K Server.
 */
export class MockSignalKServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = '127.0.0.1';
    this.port = 0;
    this.baseUrl = '';
    this.wsUrl = '';
    this._httpServer = null;
    this._wsServer = null;
    this._wsSessions = new Set();
    this._timers = new Set();

    this.reset(options);
  }

  reset(options = {}) {
    this._clearTimers();
    this.vesselTree = createDefaultVesselTree();
    this.selfUrn = options.selfUrn || VESSEL_SELF_URN;

    // Access requests & Token state
    this.accessRequestMode = options.accessRequestMode || 'PENDING'; // 'PENDING' | 'AUTO_APPROVE' | 'AUTO_DENY' | 'NOT_IMPLEMENTED' | 'FORBIDDEN'
    this.accessRequests = new Map();
    this.validTokens = new Map(); // token -> { clientId, permissions: 'readwrite' | 'readonly' }
    this.revokedTokens = new Set();
    this.requireAuthForGet = Boolean(options.requireAuthForGet);
    this.requireAuthForPut = Boolean(options.requireAuthForPut);
    this.requireAuthForWs = Boolean(options.requireAuthForWs);

    // Pre-seed default test tokens
    this.validTokens.set('default-readwrite-token', {
      clientId: VESSEL_UUID,
      permissions: 'readwrite',
    });
    this.validTokens.set('default-readonly-token', {
      clientId: VESSEL_UUID,
      permissions: 'readonly',
    });

    // PUT & Action Request state
    this.anchorPutDisabled = Boolean(options.anchorPutDisabled);
    this.putBehaviors = new Map(); // dotPath -> { mode, delayMs, message, requiredSource }
    this.pendingActionRequests = new Map(); // requestId -> { requestId, state, statusCode, path, value, message }

    // Audit & Test Inspection Logs
    this.recordedHttpRequests = [];
    this.recordedPuts = [];
    this.recordedPluginCalls = [];
    this.recordedSubscriptions = [];
    this.recordedUnsubscriptions = [];
    this.receivedHomeyDeltas = [];
  }

  _clearTimers() {
    for (const timer of this._timers) {
      clearTimeout(timer);
    }
    this._timers.clear();
  }

  _setTimeout(fn, ms) {
    const t = setTimeout(() => {
      this._timers.delete(t);
      fn();
    }, ms);
    this._timers.add(t);
    return t;
  }

  /**
   * Starts the HTTP + WebSocket Mock Signal K Server on `127.0.0.1:port` (default `0` ephemeral).
   */
  async start(port = 0) {
    if (this._httpServer) {
      return {
        host: this.host,
        port: this.port,
        baseUrl: this.baseUrl,
        wsUrl: this.wsUrl,
      };
    }

    this._httpServer = http.createServer((req, res) => {
      this._handleHttpRequest(req, res).catch((err) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ state: 'FAILED', statusCode: 500, message: err.message }));
      });
    });

    this._wsServer = new Rfc6455Server({
      server: this._httpServer,
      pathMatcher: (pathname) => pathname === '/signalk/v1/stream',
      verifyClient: (req) => this._verifyWsUpgradeAuth(req),
    });

    this._wsServer.on('connection', (ws, req) => {
      this._handleWsConnection(ws, req);
    });

    await new Promise((resolve, reject) => {
      this._httpServer.once('error', reject);
      this._httpServer.listen(port, this.host, () => {
        const addr = this._httpServer.address();
        this.port = addr.port;
        this.baseUrl = `http://${this.host}:${this.port}`;
        this.wsUrl = `ws://${this.host}:${this.port}/signalk/v1/stream`;
        resolve();
      });
    });

    return {
      host: this.host,
      port: this.port,
      baseUrl: this.baseUrl,
      wsUrl: this.wsUrl,
    };
  }

  /**
   * Stops the server and terminates all open connections and timers.
   */
  async stop() {
    this._clearTimers();
    if (this._wsServer) {
      this._wsServer.close();
      this._wsServer = null;
    }
    this._wsSessions.clear();

    if (this._httpServer) {
      const srv = this._httpServer;
      this._httpServer = null;
      await new Promise((resolve) => {
        srv.close(() => resolve());
        if (typeof srv.closeAllConnections === 'function') {
          srv.closeAllConnections();
        }
      });
    }
  }

  // ===========================================================================
  // Programmable Test Hooks
  // ===========================================================================

  setAccessRequestMode(mode) {
    this.accessRequestMode = mode;
  }

  setAccessRequestsSupported(supported) {
    this.accessRequestMode = supported ? 'PENDING' : 'NOT_IMPLEMENTED';
  }

  issueToken({ clientId = VESSEL_UUID, permissions = 'readwrite', customToken = null } = {}) {
    const token = customToken || `sk-jwt-${crypto.randomUUID()}`;
    this.validTokens.set(token, { clientId, permissions });
    this.revokedTokens.delete(token);
    return token;
  }

  revokeToken(token) {
    this.validTokens.delete(token);
    this.revokedTokens.add(token);
    // Notify or close active WS sessions using this token if applicable
    for (const session of this._wsSessions) {
      if (session.token === token) {
        session.permissions = 'revoked';
      }
    }
  }

  approveAccessRequest(requestId, customToken = null, permissions = 'readwrite') {
    const record = this.accessRequests.get(requestId);
    if (!record) {
      throw new Error(`Unknown access requestId: ${requestId}`);
    }
    const token = this.issueToken({
      clientId: record.clientId,
      permissions: permissions || record.permissions || 'readwrite',
      customToken,
    });
    record.state = 'COMPLETED';
    record.statusCode = 200;
    record.accessRequest = {
      permission: 'APPROVED',
      token,
    };
    return record;
  }

  denyAccessRequest(requestId) {
    const record = this.accessRequests.get(requestId);
    if (!record) {
      throw new Error(`Unknown access requestId: ${requestId}`);
    }
    record.state = 'COMPLETED';
    record.statusCode = 200;
    record.accessRequest = {
      permission: 'DENIED',
    };
    return record;
  }

  setPutBehavior(dotPath, behavior) {
    if (!behavior) {
      this.putBehaviors.delete(dotPath);
    } else {
      this.putBehaviors.set(dotPath, behavior);
    }
  }

  setAnchorPutDisabled(disabled) {
    this.anchorPutDisabled = Boolean(disabled);
  }

  getPutRequestLog() {
    return this.recordedPuts;
  }

  getActiveWebSocketCount() {
    let count = 0;
    for (const session of this._wsSessions) {
      if (session.ws.readyState === 1) count++;
    }
    return count;
  }

  dropWebSocketClients() {
    for (const session of this._wsSessions) {
      try {
        session.ws.terminate();
      } catch {
        // ignore
      }
    }
    this._wsSessions.clear();
  }

  sendRawWsText(rawText) {
    for (const session of this._wsSessions) {
      if (session.ws.readyState === 1) {
        session.ws.send(String(rawText));
      }
    }
  }

  // ===========================================================================
  // Vessel Tree Manipulation & Delta Broadcast
  // ===========================================================================

  /**
   * Resolves a dot-path or slash-path inside `this.vesselTree`.
   */
  getTreeNode(pathStr) {
    const parts = String(pathStr || '')
      .replace(/^\/+|\/+$/g, '')
      .split(/[./]/)
      .filter(Boolean);

    let curr = this.vesselTree;
    for (const part of parts) {
      if (curr === null || curr === undefined || typeof curr !== 'object') {
        return undefined;
      }
      curr = curr[part];
    }
    return curr;
  }

  /**
   * Applies a single `{ path, value, $source, timestamp }` update to `this.vesselTree`.
   */
  applyPathValueToTree(dotPath, value, $source = 'signalk.mock', timestamp = new Date().toISOString()) {
    const parts = String(dotPath).split('.').filter(Boolean);
    if (parts.length === 0) return;

    let curr = this.vesselTree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!curr[part] || typeof curr[part] !== 'object' || ('value' in curr[part] && '$source' in curr[part])) {
        curr[part] = {};
      }
      curr = curr[part];
    }

    const leafKey = parts[parts.length - 1];
    const existing = curr[leafKey];
    if (existing && typeof existing === 'object' && ('value' in existing || 'meta' in existing)) {
      existing.value = value;
      existing.$source = $source;
      existing.timestamp = timestamp;
      if (!existing.values || typeof existing.values !== 'object') {
        existing.values = {};
      }
      existing.values[$source] = { value, timestamp };
    } else {
      curr[leafKey] = makeLeaf(value, $source, {}, null, timestamp);
    }
  }

  /**
   * Broadcasts one or more path/value updates as a Signal K delta frame to subscribed WebSocket clients.
   *
   * @param {Array<{ path: string, value: any, $source?: string, timestamp?: string }>|{ path: string, value: any, $source?: string, timestamp?: string }} updatesInput
   * @param {object} [options]
   * @param {string} [options.context]
   * @param {string} [options.$source]
   * @param {string} [options.timestamp]
   * @param {boolean} [options.skipTreeUpdate=false]
   * @param {boolean} [options.forceBroadcast=false]
   */
  emitDelta(updatesInput, options = {}) {
    const items = Array.isArray(updatesInput) ? updatesInput : [updatesInput];
    const context = options.context || this.selfUrn;
    const defaultSource = options.$source || 'n2k.actisense.115';
    const defaultTs = options.timestamp || new Date().toISOString();

    // Group by $source + timestamp
    const grouped = new Map();
    for (const item of items) {
      const src = item.$source || defaultSource;
      const ts = item.timestamp || defaultTs;
      const key = `${src}::${ts}`;
      if (!grouped.has(key)) {
        grouped.set(key, { $source: src, timestamp: ts, values: [] });
      }
      grouped.get(key).values.push({ path: item.path, value: item.value });

      if (!options.skipTreeUpdate && (context === this.selfUrn || context === 'vessels.self')) {
        this.applyPathValueToTree(item.path, item.value, src, ts);
      }
    }

    const updates = Array.from(grouped.values());

    for (const session of this._wsSessions) {
      if (session.ws.readyState !== 1) continue;

      if (options.forceBroadcast || session.subscribeAll) {
        session.ws.sendJson({ context, updates });
        continue;
      }

      // Filter values matching session's active subscriptions
      const matchedUpdates = [];
      for (const u of updates) {
        const matchedValues = u.values.filter((v) =>
          session.subscriptions.some((sub) => sub.regex.test(v.path) || v.path === ''),
        );
        if (matchedValues.length > 0) {
          matchedUpdates.push({
            $source: u.$source,
            timestamp: u.timestamp,
            values: matchedValues,
          });
        }
      }

      if (matchedUpdates.length > 0) {
        session.ws.sendJson({ context, updates: matchedUpdates });
      }
    }
  }

  // ===========================================================================
  // Authentication Helpers
  // ===========================================================================

  _extractBearerToken(headers, urlObj = null) {
    const authHeader = headers?.authorization || headers?.Authorization;
    if (authHeader && typeof authHeader === 'string') {
      const match = authHeader.match(/^Bearer\s+(.+)$/i);
      if (match) return match[1].trim();
      const jwtMatch = authHeader.match(/^JWT\s+(.+)$/i);
      if (jwtMatch) return jwtMatch[1].trim();
    }
    if (urlObj && urlObj.searchParams.has('token')) {
      return urlObj.searchParams.get('token');
    }
    return null;
  }

  _checkAuth(token, { requireToken = false, requireWrite = false } = {}) {
    if (token) {
      if (this.revokedTokens.has(token) || !this.validTokens.has(token)) {
        return { ok: false, statusCode: 401, message: 'Invalid or revoked JWT token' };
      }
      const info = this.validTokens.get(token);
      if (requireWrite && info.permissions === 'readonly') {
        return { ok: false, statusCode: 403, message: 'Forbidden: readwrite permission required' };
      }
      return { ok: true, token, permissions: info.permissions };
    }

    if (requireToken) {
      return { ok: false, statusCode: 401, message: 'Authentication required' };
    }
    return { ok: true, token: null, permissions: 'readwrite' };
  }

  _verifyWsUpgradeAuth(req) {
    const parsedUrl = new URL(req.url || '/', this.baseUrl || 'http://127.0.0.1');
    const token = this._extractBearerToken(req.headers, parsedUrl);
    if (token && (this.revokedTokens.has(token) || !this.validTokens.has(token))) {
      return { allowed: false, statusCode: 401 };
    }
    if (this.requireAuthForWs && !token) {
      return { allowed: false, statusCode: 401 };
    }
    return { allowed: true };
  }

  // ===========================================================================
  // HTTP Request Router
  // ===========================================================================

  async _readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { __raw: raw, __parseError: true };
    }
  }

  _sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  }

  async _handleHttpRequest(req, res) {
    const parsedUrl = new URL(req.url || '/', this.baseUrl || 'http://127.0.0.1');
    const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method || 'GET').toUpperCase();
    const token = this._extractBearerToken(req.headers, parsedUrl);

    this.recordedHttpRequests.push({
      method,
      pathname,
      search: parsedUrl.search,
      headers: req.headers,
      timestamp: Date.now(),
    });

    // 1. GET /signalk discovery endpoint
    if (method === 'GET' && pathname === '/signalk') {
      return this._sendJson(res, 200, {
        endpoints: {
          v1: {
            version: '1.7.0',
            'signalk-http': `${this.baseUrl}/signalk/v1/api/`,
            'signalk-ws': this.wsUrl,
          },
        },
        server: {
          ...SERVER_INFO,
        },
      });
    }

    // 2. POST /signalk/v1/access/requests
    if (method === 'POST' && pathname === '/signalk/v1/access/requests') {
      const body = await this._readJsonBody(req);
      if (this.accessRequestMode === 'NOT_IMPLEMENTED') {
        return this._sendJson(res, 501, {
          state: 'FAILED',
          statusCode: 501,
          message: 'Access requests not implemented on this server',
        });
      }
      if (this.accessRequestMode === 'FORBIDDEN') {
        return this._sendJson(res, 403, {
          state: 'FAILED',
          statusCode: 403,
          message: 'Device access requests are disabled',
        });
      }

      if (!body || !body.clientId || !UUID_V4_REGEX.test(String(body.clientId))) {
        return this._sendJson(res, 400, {
          state: 'FAILED',
          statusCode: 400,
          message: 'Invalid or missing UUIDv4 clientId',
        });
      }

      const requestId = crypto.randomUUID();
      const href = `/signalk/v1/access/requests/${requestId}`;
      const record = {
        requestId,
        clientId: body.clientId,
        description: body.description || 'Homey Pro Smart Boat Hub',
        permissions: body.permissions || 'readwrite',
        state: 'PENDING',
        statusCode: 202,
        href,
        pollCount: 0,
      };
      this.accessRequests.set(requestId, record);

      return this._sendJson(res, 202, {
        state: 'PENDING',
        statusCode: 202,
        href,
        requestId,
      });
    }

    // 3. GET /signalk/v1/access/requests/:id
    if (method === 'GET' && pathname.startsWith('/signalk/v1/access/requests/')) {
      const requestId = pathname.slice('/signalk/v1/access/requests/'.length);
      const record = this.accessRequests.get(requestId);
      if (!record) {
        return this._sendJson(res, 404, {
          state: 'FAILED',
          statusCode: 404,
          message: 'Access request not found',
        });
      }

      record.pollCount += 1;
      if (record.state === 'PENDING') {
        if (this.accessRequestMode === 'AUTO_APPROVE') {
          this.approveAccessRequest(requestId);
        } else if (this.accessRequestMode === 'AUTO_DENY') {
          this.denyAccessRequest(requestId);
        }
      }

      if (record.state === 'PENDING') {
        return this._sendJson(res, 202, {
          state: 'PENDING',
          statusCode: 202,
          href: record.href,
          requestId: record.requestId,
        });
      }

      return this._sendJson(res, 200, {
        state: 'COMPLETED',
        statusCode: 200,
        accessRequest: record.accessRequest,
      });
    }

    // 4. GET /signalk/v1/requests/:requestId (Async PUT polling)
    if (method === 'GET' && pathname.startsWith('/signalk/v1/requests/')) {
      const requestId = pathname.slice('/signalk/v1/requests/'.length);
      const action = this.pendingActionRequests.get(requestId);
      if (!action) {
        return this._sendJson(res, 404, {
          requestId,
          state: 'FAILED',
          statusCode: 404,
          message: 'Request ID not found',
        });
      }
      return this._sendJson(res, action.statusCode, action);
    }

    // 5. POST /plugins/anchoralarm/{dropAnchor,raiseAnchor,setRadius,setRodeLength}
    if (method === 'POST' && pathname.startsWith('/plugins/anchoralarm/')) {
      const auth = this._checkAuth(token, { requireToken: this.requireAuthForPut, requireWrite: true });
      if (!auth.ok) {
        return this._sendJson(res, auth.statusCode, {
          state: 'FAILED',
          statusCode: auth.statusCode,
          message: auth.message,
        });
      }

      const actionName = pathname.slice('/plugins/anchoralarm/'.length);
      const body = await this._readJsonBody(req);
      this.recordedPluginCalls.push({
        plugin: 'anchoralarm',
        action: actionName,
        body,
        timestamp: Date.now(),
      });

      if (actionName === 'dropAnchor') {
        const vesselPos = this.getTreeNode('navigation.position')?.value || {
          latitude: 59.3293,
          longitude: 18.0686,
        };
        const dropPos = body?.position || {
          latitude: vesselPos.latitude,
          longitude: vesselPos.longitude,
        };
        const updates = [
          { path: 'navigation.anchor.position', value: dropPos, $source: 'signalk-anchoralarm-plugin' },
          { path: 'navigation.anchor.currentRadius', value: 0, $source: 'signalk-anchoralarm-plugin' },
        ];
        if (typeof body?.maxRadius === 'number' || typeof body?.radius === 'number') {
          updates.push({
            path: 'navigation.anchor.maxRadius',
            value: Number(body.maxRadius ?? body.radius),
            $source: 'signalk-anchoralarm-plugin',
          });
        }
        if (typeof body?.rodeLength === 'number') {
          updates.push({
            path: 'navigation.anchor.rodeLength',
            value: Number(body.rodeLength),
            $source: 'signalk-anchoralarm-plugin',
          });
        }
        this.emitDelta(updates);
        return this._sendJson(res, 200, { status: 'ok', position: dropPos });
      }

      if (actionName === 'raiseAnchor') {
        this.emitDelta([
          { path: 'navigation.anchor.position', value: null, $source: 'signalk-anchoralarm-plugin' },
          { path: 'navigation.anchor.currentRadius', value: null, $source: 'signalk-anchoralarm-plugin' },
          {
            path: 'notifications.navigation.anchor',
            value: { state: 'normal', method: [], message: 'Anchor raised' },
            $source: 'signalk-anchoralarm-plugin',
          },
        ]);
        return this._sendJson(res, 200, { status: 'ok' });
      }

      if (actionName === 'setRadius') {
        const radius = Number(body?.radius ?? body?.maxRadius ?? body?.value);
        if (!Number.isFinite(radius) || radius <= 0) {
          return this._sendJson(res, 400, { status: 'error', message: 'Invalid radius' });
        }
        this.emitDelta({
          path: 'navigation.anchor.maxRadius',
          value: radius,
          $source: 'signalk-anchoralarm-plugin',
        });
        return this._sendJson(res, 200, { status: 'ok', radius });
      }

      if (actionName === 'setRodeLength') {
        const length = Number(body?.length ?? body?.rodeLength ?? body?.value);
        if (!Number.isFinite(length) || length < 0) {
          return this._sendJson(res, 400, { status: 'error', message: 'Invalid rode length' });
        }
        this.emitDelta({
          path: 'navigation.anchor.rodeLength',
          value: length,
          $source: 'signalk-anchoralarm-plugin',
        });
        return this._sendJson(res, 200, { status: 'ok', length });
      }

      return this._sendJson(res, 404, { status: 'error', message: 'Unknown anchoralarm action' });
    }

    // 6. GET /signalk/v1/api or /signalk/v1/api/vessels/self/**
    if (method === 'GET' && pathname.startsWith('/signalk/v1/api')) {
      const auth = this._checkAuth(token, { requireToken: this.requireAuthForGet, requireWrite: false });
      if (!auth.ok) {
        return this._sendJson(res, auth.statusCode, {
          state: 'FAILED',
          statusCode: auth.statusCode,
          message: auth.message,
        });
      }

      if (pathname === '/signalk/v1/api') {
        return this._sendJson(res, 200, {
          self: this.selfUrn,
          version: '1.7.0',
          vessels: {
            self: this.vesselTree,
            [this.selfUrn]: this.vesselTree,
          },
        });
      }

      let subPath = '';
      const selfPrefix = '/signalk/v1/api/vessels/self';
      const urnPrefix = `/signalk/v1/api/vessels/${this.selfUrn}`;
      const uuidPrefix = `/signalk/v1/api/vessels/urn:mrn:signalk:uuid:${VESSEL_UUID}`;

      if (pathname === selfPrefix || pathname.startsWith(`${selfPrefix}/`)) {
        subPath = pathname.slice(selfPrefix.length).replace(/^\/+/, '');
      } else if (pathname === urnPrefix || pathname.startsWith(`${urnPrefix}/`)) {
        subPath = pathname.slice(urnPrefix.length).replace(/^\/+/, '');
      } else if (pathname === uuidPrefix || pathname.startsWith(`${uuidPrefix}/`)) {
        subPath = pathname.slice(uuidPrefix.length).replace(/^\/+/, '');
      } else {
        return this._sendJson(res, 404, { message: 'Not Found' });
      }

      if (!subPath) {
        return this._sendJson(res, 200, this.vesselTree);
      }

      const node = this.getTreeNode(subPath);
      if (node === undefined) {
        return this._sendJson(res, 404, { message: `Path not found: ${subPath}` });
      }
      return this._sendJson(res, 200, node);
    }

    // 7. PUT /signalk/v1/api/vessels/self/**
    if (method === 'PUT' && pathname.startsWith('/signalk/v1/api/vessels/')) {
      const body = await this._readJsonBody(req);
      let subPath = '';
      const selfPrefix = '/signalk/v1/api/vessels/self/';
      const urnPrefix = `/signalk/v1/api/vessels/${this.selfUrn}/`;
      if (pathname.startsWith(selfPrefix)) {
        subPath = pathname.slice(selfPrefix.length);
      } else if (pathname.startsWith(urnPrefix)) {
        subPath = pathname.slice(urnPrefix.length);
      } else {
        return this._sendJson(res, 404, { state: 'FAILED', statusCode: 404, message: 'Vessel not found' });
      }

      const dotPath = subPath.replace(/\//g, '.');
      const result = this._executePutStateMachine({
        dotPath,
        value: body?.value,
        source: body?.source,
        requestId: body?.requestId || crypto.randomUUID(),
        token,
        transport: 'http',
      });

      return this._sendJson(res, result.statusCode, result.payload);
    }

    return this._sendJson(res, 404, { message: `Route not found: ${method} ${pathname}` });
  }

  // ===========================================================================
  // Unified PUT State Machine (HTTP REST & WebSocket)
  // ===========================================================================

  _executePutStateMachine({ dotPath, value, source, requestId = crypto.randomUUID(), token = null, transport = 'http' }) {
    this.recordedPuts.push({
      path: dotPath,
      value,
      source: source || null,
      requestId,
      token,
      transport,
      timestamp: Date.now(),
    });

    // 1. Auth check
    const auth = this._checkAuth(token, { requireToken: this.requireAuthForPut, requireWrite: true });
    if (!auth.ok) {
      return {
        statusCode: auth.statusCode,
        payload: {
          requestId,
          state: 'FAILED',
          statusCode: auth.statusCode,
          message: auth.message,
        },
      };
    }

    // 2. Check programmable behavior or default writability
    const customBehavior = this.putBehaviors.get(dotPath);
    const isWritable = customBehavior
      ? customBehavior.mode !== 'REJECT_405'
      : isDefaultWritableSignalKPath(dotPath, this.anchorPutDisabled);

    if (!isWritable) {
      return {
        statusCode: 405,
        payload: {
          requestId,
          state: 'FAILED',
          statusCode: 405,
          message: customBehavior?.message || `PUT not supported for path ${dotPath}`,
        },
      };
    }

    // 3. Multi-source disambiguation check (400 Bad Request when multiple sources exist and source is omitted)
    const existingNode = this.getTreeNode(dotPath);
    const hasMultipleSources =
      (existingNode &&
        existingNode.values &&
        typeof existingNode.values === 'object' &&
        Object.keys(existingNode.values).length > 1) ||
      customBehavior?.mode === 'REQUIRE_SOURCE_400';

    if (hasMultipleSources && !source) {
      return {
        statusCode: 400,
        payload: {
          requestId,
          state: 'FAILED',
          statusCode: 400,
          message: `Multiple sources present for ${dotPath}; specify "source" in PUT body`,
        },
      };
    }

    if (customBehavior?.requiredSource && source && source !== customBehavior.requiredSource) {
      return {
        statusCode: 400,
        payload: {
          requestId,
          state: 'FAILED',
          statusCode: 400,
          message: `Unknown source "${source}" for ${dotPath}`,
        },
      };
    }

    const mode = customBehavior?.mode || 'SYNC_200';
    const delayMs = typeof customBehavior?.delayMs === 'number' ? customBehavior.delayMs : 50;
    const effectiveSource = source || existingNode?.$source || 'signalk.put';

    if (mode === 'REJECT_502') {
      return {
        statusCode: 502,
        payload: {
          requestId,
          state: 'FAILED',
          statusCode: 502,
          message: customBehavior?.message || 'Hardware actuator rejected command',
        },
      };
    }

    if (mode === 'ASYNC_202_COMPLETE' || mode === 'ASYNC_202_FAIL_502' || mode === 'ASYNC_202_HANG') {
      const href = `/signalk/v1/requests/${requestId}`;
      const pendingRecord = {
        requestId,
        state: 'PENDING',
        statusCode: 202,
        href,
        path: dotPath,
        value,
      };
      this.pendingActionRequests.set(requestId, pendingRecord);

      if (mode === 'ASYNC_202_COMPLETE') {
        this._setTimeout(() => {
          this.completePendingPut(requestId, effectiveSource);
        }, delayMs);
      } else if (mode === 'ASYNC_202_FAIL_502') {
        this._setTimeout(() => {
          this.failPendingPut(requestId, customBehavior?.message || 'Hardware actuator did not acknowledge');
        }, delayMs);
      }

      return {
        statusCode: 202,
        payload: {
          requestId,
          state: 'PENDING',
          statusCode: 202,
          href,
        },
      };
    }

    // Default SYNC_200
    this.emitDelta({
      path: dotPath,
      value,
      $source: effectiveSource,
    });

    // If dimmingLevel is updated on a switch, keep switch state consistent
    if (dotPath.endsWith('.dimmingLevel') && typeof value === 'number') {
      const statePath = dotPath.replace(/\.dimmingLevel$/, '.state');
      this.emitDelta({
        path: statePath,
        value: value > 0,
        $source: effectiveSource,
      });
    }

    const completedRecord = {
      requestId,
      state: 'COMPLETED',
      statusCode: 200,
    };
    this.pendingActionRequests.set(requestId, completedRecord);

    return {
      statusCode: 200,
      payload: completedRecord,
    };
  }

  completePendingPut(requestId, $source = 'signalk.put') {
    const action = this.pendingActionRequests.get(requestId);
    if (!action) return;
    action.state = 'COMPLETED';
    action.statusCode = 200;

    this.emitDelta({
      path: action.path,
      value: action.value,
      $source,
    });

    for (const session of this._wsSessions) {
      if (session.ws.readyState === 1) {
        session.ws.sendJson({
          requestId,
          state: 'COMPLETED',
          statusCode: 200,
        });
      }
    }
  }

  failPendingPut(requestId, message = 'Hardware actuator timeout') {
    const action = this.pendingActionRequests.get(requestId);
    if (!action) return;
    action.state = 'FAILED';
    action.statusCode = 502;
    action.message = message;

    for (const session of this._wsSessions) {
      if (session.ws.readyState === 1) {
        session.ws.sendJson({
          requestId,
          state: 'FAILED',
          statusCode: 502,
          message,
        });
      }
    }
  }

  // ===========================================================================
  // WebSocket Stream Handler (/signalk/v1/stream)
  // ===========================================================================

  _handleWsConnection(ws, req) {
    const parsedUrl = new URL(req.url || '/', this.baseUrl || 'http://127.0.0.1');
    const subscribeMode = (parsedUrl.searchParams.get('subscribe') || 'self').toLowerCase();
    const token = this._extractBearerToken(req.headers, parsedUrl);
    const tokenInfo = token ? this.validTokens.get(token) : null;

    const session = {
      ws,
      req,
      token,
      permissions: tokenInfo ? tokenInfo.permissions : 'readwrite',
      subscribeMode,
      subscribeAll: subscribeMode === 'self' || subscribeMode === 'all',
      subscriptions: [],
    };

    if (session.subscribeAll) {
      session.subscriptions.push({
        path: '*',
        policy: 'ideal',
        period: 1000,
        minPeriod: 200,
        regex: compileSubscriptionRegex('*'),
      });
    }

    this._wsSessions.add(session);
    ws.on('close', () => {
      this._wsSessions.delete(session);
    });

    // Immediately send Signal K hello frame
    ws.sendJson({
      name: SERVER_INFO.id,
      version: SERVER_INFO.version,
      timestamp: DEFAULT_TIMESTAMP,
      self: this.selfUrn,
      roles: ['master', 'main'],
    });

    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
      } catch {
        return;
      }
      this._handleWsClientMessage(session, msg);
    });
  }

  _handleWsClientMessage(session, msg) {
    if (!msg || typeof msg !== 'object') return;

    // 1. Subscription registration: { context: "vessels.self", subscribe: [...] }
    if (Array.isArray(msg.subscribe)) {
      for (const sub of msg.subscribe) {
        const entry = {
          context: msg.context || 'vessels.self',
          path: sub.path || '*',
          period: sub.period,
          minPeriod: sub.minPeriod,
          policy: sub.policy || 'ideal',
          format: sub.format || 'delta',
          regex: compileSubscriptionRegex(sub.path || '*'),
        };
        session.subscriptions.push(entry);
        this.recordedSubscriptions.push(entry);
      }
      return;
    }

    // 2. Unsubscription: { context: "*", unsubscribe: [{ path: "..." }] }
    if (Array.isArray(msg.unsubscribe)) {
      for (const unsub of msg.unsubscribe) {
        this.recordedUnsubscriptions.push(unsub);
        if (unsub.path === '*') {
          session.subscriptions = [];
          session.subscribeAll = false;
        } else {
          session.subscriptions = session.subscriptions.filter((s) => s.path !== unsub.path);
        }
      }
      return;
    }

    // 3. WebSocket PUT message: { context: "vessels.self", requestId, put: [{ path, value, source }] }
    if (Array.isArray(msg.put) && msg.put.length > 0) {
      const reqId = msg.requestId || crypto.randomUUID();
      const firstPut = msg.put[0];
      const result = this._executePutStateMachine({
        dotPath: firstPut.path,
        value: firstPut.value,
        source: firstPut.source,
        requestId: reqId,
        token: session.token,
        transport: 'ws',
      });
      session.ws.sendJson(result.payload);
      return;
    }

    // 4. Inbound Homey -> Signal K Delta message: { context: "vessels.self", updates: [{ $source, timestamp, values: [{ path, value }] }] }
    if (Array.isArray(msg.updates)) {
      if (session.permissions === 'readonly' || session.permissions === 'revoked') {
        this.emit('unauthorizedDelta', msg);
        return;
      }

      this.receivedHomeyDeltas.push(msg);
      const flatUpdates = [];
      for (const updateBlock of msg.updates) {
        const $source =
          updateBlock.$source ||
          (updateBlock.source && updateBlock.source.label ? `homey.${updateBlock.source.label}` : 'homey.bridge');
        const timestamp = updateBlock.timestamp || new Date().toISOString();
        if (Array.isArray(updateBlock.values)) {
          for (const valEntry of updateBlock.values) {
            flatUpdates.push({
              path: valEntry.path,
              value: valEntry.value,
              $source,
              timestamp,
            });
          }
        }
      }

      if (flatUpdates.length > 0) {
        this.emitDelta(flatUpdates, {
          context: msg.context || this.selfUrn,
        });
      }
    }
  }
}

export default MockSignalKServer;
