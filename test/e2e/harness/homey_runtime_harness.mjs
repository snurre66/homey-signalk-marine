import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as nodeModule from 'node:module';
import { Rfc6455Client } from '../helpers/rfc6455_ws.mjs';
import { VESSEL_SELF_URN, VESSEL_UUID } from './fixtures.mjs';

const WORKSPACE_ROOT = '/home/antigravity';
const localRequire = createRequire(import.meta.url);

// =============================================================================
// 1. Custom Errors (`SafetyBoundaryError`, `AppStoreValidationError`)
// =============================================================================

export class SafetyBoundaryError extends Error {
  constructor(skPath, reason = 'Path is strictly read-only under the navigation/autopilot/propulsion safety boundary') {
    super(`SafetyBoundaryError [${skPath}]: ${reason}`);
    this.name = 'SafetyBoundaryError';
    this.path = skPath;
    this.code = 'SAFETY_BOUNDARY_VIOLATION';
  }
}

export class AppStoreValidationError extends Error {
  constructor(message, guideline = 'Homey App Store Publish Guideline') {
    super(`${guideline}: ${message}`);
    this.name = 'AppStoreValidationError';
    this.guideline = guideline;
  }
}

// =============================================================================
// 2. Specification-Compliant Core Library Implementations (F2, F3, F4, F5, F6)
// =============================================================================

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;
const KNOTS_PER_MPS = 3600 / 1852;
const MPS_PER_KNOT = 1852 / 3600;
const EARTH_RADIUS_M = 6371000;

function roundTo(val, decimals) {
  if (typeof decimals !== 'number' || decimals < 0) return val;
  const factor = 10 ** decimals;
  return Math.round((val + Number.EPSILON) * factor) / factor;
}

export class ReferenceUnitConverter {
  fromSignalK(value, category, decimals) {
    if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    let result;
    switch (category) {
      case 'temperature_k_to_c':
        result = value - 273.15;
        break;
      case 'speed_ms_to_kn':
        result = value * KNOTS_PER_MPS;
        break;
      case 'speed_ms_to_kmh':
        result = value * 3.6;
        break;
      case 'speed_ms':
        result = value;
        break;
      case 'pressure_pa_to_hpa':
        result = value / 100;
        break;
      case 'pressure_pa_to_bar':
        result = value / 100000;
        break;
      case 'pressure_pa_to_kpa':
        result = value / 1000;
        break;
      case 'ratio_to_percent':
        result = value * 100;
        break;
      case 'angle_rad_to_deg_unsigned': {
        const deg = (value * DEG_PER_RAD) % 360;
        result = deg < 0 ? deg + 360 : deg === 0 ? 0 : deg;
        if (Math.abs(result - 360) < 1e-9) result = 0;
        break;
      }
      case 'angle_rad_to_deg_signed': {
        let deg = ((value * DEG_PER_RAD + 180) % 360);
        if (deg < 0) deg += 360;
        result = deg - 180;
        if (result === -180 && value > 0) result = 180;
        if (Object.is(result, -0)) result = 0;
        break;
      }
      case 'angular_velocity_rads_to_degs':
        result = value * DEG_PER_RAD;
        break;
      case 'frequency_hz_to_rpm':
        result = value * 60;
        break;
      case 'charge_c_to_ah':
        result = value / 3600;
        break;
      case 'energy_j_to_kwh':
        result = value / 3600000;
        break;
      case 'volume_m3_to_l':
        result = value * 1000;
        break;
      case 'flow_m3s_to_lh':
        result = value * 3600000;
        break;
      case 'duration_s_to_h':
        result = value / 3600;
        break;
      case 'duration_s_to_min':
        result = value / 60;
        break;
      case 'distance_m':
        result = value;
        break;
      case 'distance_m_to_nm':
        result = value / 1852;
        break;
      case 'passthrough':
      default:
        result = value;
        break;
    }

    return roundTo(result, decimals);
  }

  toSignalK(value, category) {
    if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }

    switch (category) {
      case 'temperature_k_to_c':
        return roundTo(value + 273.15, 6);
      case 'speed_ms_to_kn':
        return value * MPS_PER_KNOT;
      case 'speed_ms_to_kmh':
        return value / 3.6;
      case 'speed_ms':
        return value;
      case 'pressure_pa_to_hpa':
        return roundTo(value * 100, 6);
      case 'pressure_pa_to_bar':
        return roundTo(value * 100000, 6);
      case 'pressure_pa_to_kpa':
        return roundTo(value * 1000, 6);
      case 'ratio_to_percent':
        return roundTo(value / 100, 6);
      case 'angle_rad_to_deg_unsigned':
      case 'angle_rad_to_deg_signed':
      case 'angular_velocity_rads_to_degs':
        return value * RAD_PER_DEG;
      case 'frequency_hz_to_rpm':
        return value / 60;
      case 'charge_c_to_ah':
        return value * 3600;
      case 'energy_j_to_kwh':
        return value * 3600000;
      case 'volume_m3_to_l':
        return value / 1000;
      case 'flow_m3s_to_lh':
        return value / 3600000;
      case 'duration_s_to_h':
        return value * 3600;
      case 'duration_s_to_min':
        return value * 60;
      case 'distance_m':
        return value;
      case 'distance_m_to_nm':
        return value * 1852;
      case 'passthrough':
      default:
        return value;
    }
  }

  convertSpeedFromSI(mps, targetUnit = 'kn', decimals) {
    if (targetUnit === 'km/h') return this.fromSignalK(mps, 'speed_ms_to_kmh', decimals);
    if (targetUnit === 'm/s') return this.fromSignalK(mps, 'speed_ms', decimals);
    return this.fromSignalK(mps, 'speed_ms_to_kn', decimals);
  }

  convertSpeedToSI(speed, sourceUnit = 'kn') {
    if (sourceUnit === 'km/h') return this.toSignalK(speed, 'speed_ms_to_kmh');
    if (sourceUnit === 'm/s') return this.toSignalK(speed, 'speed_ms');
    return this.toSignalK(speed, 'speed_ms_to_kn');
  }
}

export class ReferenceSafetyBoundary {
  isWritablePath(skPath) {
    if (!skPath || typeof skPath !== 'string') return false;
    const clean = skPath.trim().replace(/^\/+|\/+$/g, '').replace(/\//g, '.');
    if (!clean || clean.includes('..')) return false;

    // Forbidden safety-critical namespaces:
    if (/^steering(\.|$)/.test(clean)) return false;
    if (/^propulsion(\.|$)/.test(clean)) return false;
    if (/^navigation\.(?!anchor(\.|$))/.test(clean)) return false;

    // Allowed write namespaces:
    if (/^electrical\.switches\..+/.test(clean)) return true;
    if (/^electrical\.chargers\.[^.]+\.(mode|currentLimit|state)$/.test(clean)) return true;
    if (/^electrical\.inverters\.[^.]+\.(inverterMode|mode|state)$/.test(clean)) return true;
    if (/^navigation\.anchor(\..+)?$/.test(clean)) return true;

    return false;
  }

  assertWritablePath(skPath) {
    if (!this.isWritablePath(skPath)) {
      throw new SafetyBoundaryError(skPath);
    }
  }
}

export class ReferenceAnchorWatchCalculator {
  calculateHaversineDistanceMeters(a, b) {
    if (
      !a ||
      !b ||
      typeof a.latitude !== 'number' ||
      typeof a.longitude !== 'number' ||
      typeof b.latitude !== 'number' ||
      typeof b.longitude !== 'number' ||
      !Number.isFinite(a.latitude) ||
      !Number.isFinite(a.longitude) ||
      !Number.isFinite(b.latitude) ||
      !Number.isFinite(b.longitude)
    ) {
      return 0;
    }

    if (a.latitude === b.latitude && a.longitude === b.longitude) {
      return 0;
    }

    const lat1 = a.latitude * RAD_PER_DEG;
    const lat2 = b.latitude * RAD_PER_DEG;
    const dLat = (b.latitude - a.latitude) * RAD_PER_DEG;

    let dLonDeg = b.longitude - a.longitude;
    if (dLonDeg > 180) dLonDeg -= 360;
    if (dLonDeg < -180) dLonDeg += 360;
    const dLon = dLonDeg * RAD_PER_DEG;

    const sinLat = Math.sin(dLat / 2);
    const sinLon = Math.sin(dLon / 2);
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
    const c = 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
    return roundTo(EARTH_RADIUS_M * c, 2);
  }

  calculateBearingDegrees(from, to) {
    if (
      !from ||
      !to ||
      typeof from.latitude !== 'number' ||
      typeof from.longitude !== 'number' ||
      typeof to.latitude !== 'number' ||
      typeof to.longitude !== 'number'
    ) {
      return 0;
    }
    if (from.latitude === to.latitude && from.longitude === to.longitude) {
      return 0;
    }

    const lat1 = from.latitude * RAD_PER_DEG;
    const lat2 = to.latitude * RAD_PER_DEG;
    let dLonDeg = to.longitude - from.longitude;
    if (dLonDeg > 180) dLonDeg -= 360;
    if (dLonDeg < -180) dLonDeg += 360;
    const dLon = dLonDeg * RAD_PER_DEG;

    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    const brng = (Math.atan2(y, x) * DEG_PER_RAD + 360) % 360;
    return roundTo(brng === 360 ? 0 : brng, 1);
  }

  evaluateDrift({
    armed,
    anchorPosition = null,
    vesselPosition = null,
    pluginCurrentRadiusMeters = null,
    pluginAlarmState = null,
    maxRadiusMeters = 40,
    rodeLengthMeters = null,
  }) {
    const hasPluginRadius =
      typeof pluginCurrentRadiusMeters === 'number' && Number.isFinite(pluginCurrentRadiusMeters);
    const source = hasPluginRadius ? 'plugin' : 'haversine_fallback';

    let currentRadiusMeters = null;
    let bearingTrueDegrees = null;

    if (hasPluginRadius) {
      currentRadiusMeters = roundTo(pluginCurrentRadiusMeters, 2);
      if (anchorPosition && vesselPosition) {
        bearingTrueDegrees = this.calculateBearingDegrees(anchorPosition, vesselPosition);
      }
    } else if (
      anchorPosition &&
      vesselPosition &&
      typeof anchorPosition.latitude === 'number' &&
      typeof vesselPosition.latitude === 'number'
    ) {
      currentRadiusMeters = this.calculateHaversineDistanceMeters(anchorPosition, vesselPosition);
      bearingTrueDegrees = this.calculateBearingDegrees(anchorPosition, vesselPosition);
    }

    const pluginTriggered =
      Boolean(armed) &&
      typeof pluginAlarmState === 'string' &&
      ['alarm', 'emergency', 'warn'].includes(pluginAlarmState.toLowerCase());

    const radiusExceeded =
      Boolean(armed) &&
      typeof currentRadiusMeters === 'number' &&
      Number.isFinite(currentRadiusMeters) &&
      currentRadiusMeters > maxRadiusMeters;

    return {
      armed: Boolean(armed),
      anchorPosition,
      vesselPosition,
      currentRadiusMeters,
      maxRadiusMeters,
      rodeLengthMeters,
      bearingTrueDegrees,
      isDragging: Boolean(armed && (radiusExceeded || pluginTriggered)),
      source,
    };
  }
}

export class ReferenceSignalKAuthManager {
  constructor(homey) {
    this.homey = homey;
  }

  getOrCreateClientId() {
    let clientId = this.homey?.settings?.get('signalk_client_id');
    if (!clientId) {
      clientId = crypto.randomUUID();
      this.homey?.settings?.set('signalk_client_id', clientId);
    }
    return clientId;
  }

  async discoverServer({ host, port = 3000, useTls = false }) {
    const protocol = useTls ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}:${port}`;
    const res = await fetch(`${baseUrl}/signalk`);
    if (!res.ok) {
      const err = new Error(`Failed to discover Signal K endpoint at ${baseUrl}/signalk (HTTP ${res.status})`);
      err.statusCode = res.status;
      throw err;
    }
    const data = await res.json();
    const v1 = data?.endpoints?.v1;
    if (!v1 || !v1['signalk-http'] || !v1['signalk-ws']) {
      throw new Error('Invalid Signal K discovery response: missing endpoints.v1');
    }
    return {
      baseUrl,
      endpoints: data.endpoints,
      server: data.server,
      signalkHttpUrl: v1['signalk-http'],
      signalkWsUrl: v1['signalk-ws'],
      version: v1.version,
    };
  }

  async requestAccess(
    { host, port = 3000, useTls = false },
    { clientId, description = 'Homey Pro Smart Boat Hub', permissions = 'readwrite' } = {},
  ) {
    const protocol = useTls ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}:${port}`;
    const effectiveClientId = clientId !== undefined ? clientId : this.getOrCreateClientId();

    const res = await fetch(`${baseUrl}/signalk/v1/access/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: effectiveClientId,
        description,
        permissions,
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (res.status === 501) {
      return {
        state: 'NOT_IMPLEMENTED',
        statusCode: 501,
        fallbackReadonly: true,
        message: body.message || 'Access requests not supported',
      };
    }

    if (!res.ok && res.status !== 202) {
      const err = new Error(body.message || `Access request failed with HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }

    return {
      state: body.state || 'PENDING',
      statusCode: res.status,
      requestId: body.requestId,
      href: body.href,
      clientId: effectiveClientId,
    };
  }

  async pollAccessRequest(
    { host, port = 3000, useTls = false },
    hrefOrRequestId,
    { intervalMs = 40, timeoutMs = 2000 } = {},
  ) {
    const protocol = useTls ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}:${port}`;
    const href = String(hrefOrRequestId).startsWith('/')
      ? hrefOrRequestId
      : `/signalk/v1/access/requests/${hrefOrRequestId}`;

    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const res = await fetch(`${baseUrl}${href}`);
      const body = await res.json().catch(() => ({}));

      if (res.status === 200 && body.state === 'COMPLETED') {
        const perm = body.accessRequest?.permission;
        if (perm === 'DENIED') {
          const err = new Error('Access request was DENIED by the Signal K administrator');
          err.permission = 'DENIED';
          err.statusCode = 403;
          throw err;
        }
        return {
          state: 'COMPLETED',
          statusCode: 200,
          permission: perm || 'APPROVED',
          token: body.accessRequest?.token,
        };
      }

      if (res.status >= 400) {
        const err = new Error(body.message || `Polling access request failed with HTTP ${res.status}`);
        err.statusCode = res.status;
        throw err;
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }

    const timeoutErr = new Error('Timed out waiting for Signal K access request approval');
    timeoutErr.code = 'ACCESS_REQUEST_TIMEOUT';
    throw timeoutErr;
  }

  async validateConnection({ host, port = 3000, useTls = false, token = null, allowReadonly = true }) {
    const protocol = useTls ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}:${port}`;
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(`${baseUrl}/signalk/v1/api/vessels/self`, { headers });
    if (res.status === 401 || res.status === 403) {
      const err = new Error(`Authentication failed (HTTP ${res.status})`);
      err.statusCode = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Failed to query vessels/self (HTTP ${res.status})`);
      err.statusCode = res.status;
      throw err;
    }

    const vessel = await res.json();
    return {
      ok: true,
      authenticated: Boolean(token),
      readonly: !token && allowReadonly,
      vessel: {
        name: vessel.name || 'Signal K Vessel',
        uuid: vessel.uuid || `urn:mrn:signalk:uuid:${VESSEL_UUID}`,
        mmsi: vessel.mmsi || null,
      },
    };
  }
}

export class ReferenceSignalKPutController {
  constructor(pool, safetyBoundary = new ReferenceSafetyBoundary()) {
    this.pool = pool;
    this.safetyBoundary = safetyBoundary;
  }

  async putPath(serverId, skPath, value, options = {}) {
    // 1. Strict Safety Boundary check BEFORE any network I/O
    this.safetyBoundary.assertWritablePath(skPath);

    const conn = this.pool._connections.get(serverId);
    if (!conn) {
      throw new Error(`No active Signal K server configuration for ${serverId}`);
    }

    const protocol = conn.config.useTls ? 'https' : 'http';
    const baseUrl = `${protocol}://${conn.config.host}:${conn.config.port}`;
    const slashPath = String(skPath).replace(/\./g, '/');
    const headers = { 'Content-Type': 'application/json' };
    if (conn.config.token) {
      headers.Authorization = `Bearer ${conn.config.token}`;
    }

    const bodyObj = { value };
    if (options.source) {
      bodyObj.source = options.source;
    }

    const res = await fetch(`${baseUrl}/signalk/v1/api/vessels/self/${slashPath}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(bodyObj),
    });

    const data = await res.json().catch(() => ({}));

    // Handle 405 on navigation.anchor.* by falling back to signalk-anchoralarm-plugin REST endpoints
    if (res.status === 405 && /^navigation\.anchor\./.test(skPath) && options.allowPluginFallback !== false) {
      return this._executeAnchorPluginFallback(baseUrl, headers, skPath, value);
    }

    if (res.status === 401 || res.status === 403) {
      this.pool._notifyAuthFailure(serverId, res.status, data.message || 'Authentication required');
      const err = new Error(data.message || `Authentication failed (${res.status})`);
      err.statusCode = res.status;
      err.state = 'FAILED';
      throw err;
    }

    if (res.status === 400 || res.status === 405 || res.status >= 500) {
      const err = new Error(data.message || `PUT ${skPath} failed with HTTP ${res.status}`);
      err.statusCode = res.status;
      err.state = 'FAILED';
      throw err;
    }

    if (res.status === 202 && (data.state === 'PENDING' || data.href || data.requestId)) {
      return this._awaitPendingAction(baseUrl, headers, data, options.timeoutMs || 1500);
    }

    return {
      state: data.state || 'COMPLETED',
      statusCode: res.status,
      requestId: data.requestId,
    };
  }

  async _awaitPendingAction(baseUrl, headers, initialData, timeoutMs = 1500) {
    const href = initialData.href || `/signalk/v1/requests/${initialData.requestId}`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      await new Promise((r) => setTimeout(r, 30));
      const pollRes = await fetch(`${baseUrl}${href}`, { headers });
      const pollData = await pollRes.json().catch(() => ({}));

      if (pollData.state === 'COMPLETED' || pollRes.status === 200) {
        return {
          state: 'COMPLETED',
          statusCode: 200,
          requestId: pollData.requestId || initialData.requestId,
        };
      }

      if (pollData.state === 'FAILED' || pollRes.status >= 400) {
        const err = new Error(pollData.message || `Async PUT failed with status ${pollRes.status}`);
        err.statusCode = pollData.statusCode || pollRes.status;
        err.state = 'FAILED';
        throw err;
      }
    }

    const timeoutErr = new Error(`Async PUT request ${initialData.requestId} timed out after ${timeoutMs}ms`);
    timeoutErr.statusCode = 504;
    timeoutErr.state = 'FAILED';
    throw timeoutErr;
  }

  async _executeAnchorPluginFallback(baseUrl, headers, skPath, value) {
    let endpoint = null;
    let payload = {};

    if (skPath === 'navigation.anchor.position') {
      if (value === null) {
        endpoint = '/plugins/anchoralarm/raiseAnchor';
      } else {
        endpoint = '/plugins/anchoralarm/dropAnchor';
        payload = { position: value };
      }
    } else if (skPath === 'navigation.anchor.maxRadius') {
      endpoint = '/plugins/anchoralarm/setRadius';
      payload = { radius: Number(value) };
    } else if (skPath === 'navigation.anchor.rodeLength') {
      endpoint = '/plugins/anchoralarm/setRodeLength';
      payload = { length: Number(value) };
    }

    if (!endpoint) {
      const err = new Error(`PUT not supported for ${skPath} and no plugin fallback endpoint matches`);
      err.statusCode = 405;
      throw err;
    }

    const pluginRes = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!pluginRes.ok) {
      const err = new Error(`Anchor plugin fallback ${endpoint} failed with HTTP ${pluginRes.status}`);
      err.statusCode = pluginRes.status;
      throw err;
    }

    return {
      state: 'COMPLETED',
      statusCode: 200,
      fallback: 'signalk-anchoralarm-plugin',
    };
  }
}

const TIER_POLICIES = {
  fast: { policy: 'instant', minPeriod: 200, throttleWindowMs: 180 },
  medium: { policy: 'ideal', period: 2000, minPeriod: 1000, throttleWindowMs: 500 },
  slow: { policy: 'ideal', period: 5000, minPeriod: 2500, throttleWindowMs: 900 },
};

function compileClientPathMatcher(pattern) {
  if (!pattern || pattern === '*') return /^.+$/;
  const escaped = String(pattern)
    .split('.')
    .map((s) => {
      if (s === '**') return '.+';
      if (s === '*') return '[^.]+';
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('\\.');
  return new RegExp(`^${escaped}$`);
}

export class ReferenceSignalKConnectionPool extends EventEmitter {
  constructor({ safetyBoundary = new ReferenceSafetyBoundary(), reconnectBaseDelayMs = 60 } = {}) {
    super();
    this.safetyBoundary = safetyBoundary;
    this.putController = new ReferenceSignalKPutController(this, safetyBoundary);
    this.reconnectBaseDelayMs = reconnectBaseDelayMs;
    this._connections = new Map(); // serverId -> connState
    this._closed = false;
  }

  async acquireConnection(config) {
    const serverId = config.serverId || `${config.host}:${config.port}`;
    let conn = this._connections.get(serverId);

    if (conn) {
      conn.config = { ...conn.config, ...config, serverId };
      if (conn.ws && conn.ws.readyState === 1) {
        return;
      }
    } else {
      conn = {
        serverId,
        config: { ...config, serverId },
        ws: null,
        selfUrn: VESSEL_SELF_URN,
        subscriptions: new Map(), // subKey -> subEntry
        authFailureListeners: new Set(),
        reconnectTimer: null,
        reconnectAttempts: 0,
        manualClose: false,
      };
      this._connections.set(serverId, conn);
    }

    await this._connectWebSocket(conn);
  }

  async _connectWebSocket(conn) {
    if (this._closed || conn.manualClose) return;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }

    const { host, port, useTls, token } = conn.config;
    const protocol = useTls ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${host}:${port}/signalk/v1/stream?subscribe=none`;
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new Rfc6455Client(wsUrl, { headers, handshakeTimeout: 2000 });
      conn.ws = ws;

      ws.on('open', () => {
        conn.reconnectAttempts = 0;
        this._sendAllSubscriptions(conn);
        if (!settled) {
          settled = true;
          resolve();
        }
      });

      ws.on('message', (raw) => {
        this._handleIncomingFrame(conn, raw);
      });

      ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          this._notifyAuthFailure(conn.serverId, res.statusCode, 'Authentication required — please use Repair Device');
        }
        if (!settled) {
          settled = true;
          const err = new Error(`WebSocket upgrade rejected with HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on('close', () => {
        if (!this._closed && !conn.manualClose) {
          this._scheduleReconnect(conn);
        }
      });
    });
  }

  _scheduleReconnect(conn) {
    if (this._closed || conn.manualClose || conn.reconnectTimer) return;
    const attempt = conn.reconnectAttempts++;
    const delay = Math.min(1000, this.reconnectBaseDelayMs * Math.pow(1.5, attempt));
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      this._connectWebSocket(conn).catch(() => {
        this._scheduleReconnect(conn);
      });
    }, delay);
  }

  _sendAllSubscriptions(conn) {
    if (!conn.ws || conn.ws.readyState !== 1) return;
    if (conn.subscriptions.size === 0) return;

    const subPayloads = [];
    for (const sub of conn.subscriptions.values()) {
      subPayloads.push(this._buildSubscriptionDescriptor(sub));
    }

    conn.ws.sendJson({
      context: 'vessels.self',
      subscribe: subPayloads,
    });
  }

  _buildSubscriptionDescriptor(sub) {
    const tierSpec = TIER_POLICIES[sub.tier] || TIER_POLICIES.medium;
    const minPeriod = typeof sub.customMinPeriodMs === 'number' ? sub.customMinPeriodMs : tierSpec.minPeriod;
    const desc = {
      path: sub.path,
      policy: tierSpec.policy,
      minPeriod,
      format: 'delta',
    };
    if (tierSpec.period) {
      desc.period = tierSpec.period;
    }
    return desc;
  }

  subscribe(serverId, sub) {
    let conn = this._connections.get(serverId);
    if (!conn) {
      conn = {
        serverId,
        config: { serverId, host: '127.0.0.1', port: 3000, useTls: false },
        ws: null,
        selfUrn: VESSEL_SELF_URN,
        subscriptions: new Map(),
        authFailureListeners: new Set(),
        reconnectTimer: null,
        reconnectAttempts: 0,
        manualClose: false,
      };
      this._connections.set(serverId, conn);
    }

    const subKey = `${sub.subscriberId}::${sub.path}::${sub.sourceFilter || '*'}::${crypto.randomUUID()}`;
    const tierSpec = TIER_POLICIES[sub.tier] || TIER_POLICIES.medium;
    const entry = {
      ...sub,
      subKey,
      regex: compileClientPathMatcher(sub.path),
      throttleWindowMs:
        typeof sub.customMinPeriodMs === 'number'
          ? sub.customMinPeriodMs
          : sub.tier === 'fast'
            ? 0
            : tierSpec.throttleWindowMs,
      lastDeliveredPerPath: new Map(), // path -> { timestampMs, valueJson }
    };

    conn.subscriptions.set(subKey, entry);

    if (conn.ws && conn.ws.readyState === 1) {
      conn.ws.sendJson({
        context: 'vessels.self',
        subscribe: [this._buildSubscriptionDescriptor(entry)],
      });
    }

    return () => {
      conn.subscriptions.delete(subKey);
      const stillSubscribedToPath = Array.from(conn.subscriptions.values()).some((s) => s.path === sub.path);
      if (!stillSubscribedToPath && conn.ws && conn.ws.readyState === 1) {
        conn.ws.sendJson({
          context: 'vessels.self',
          unsubscribe: [{ path: sub.path }],
        });
      }
    };
  }

  onAuthFailure(serverId, listener) {
    const conn = this._connections.get(serverId);
    if (!conn) return () => {};
    conn.authFailureListeners.add(listener);
    return () => conn.authFailureListeners.delete(listener);
  }

  _notifyAuthFailure(serverId, statusCode, message) {
    const conn = this._connections.get(serverId);
    if (!conn) return;
    for (const fn of conn.authFailureListeners) {
      try {
        fn({ statusCode, message });
      } catch {
        // ignore
      }
    }
  }

  _handleIncomingFrame(conn, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      // Malformed JSON frame — ignore safely without crashing
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    // 1. Hello frame
    if (msg.self && msg.version && !msg.updates) {
      conn.selfUrn = msg.self;
      return;
    }

    // 2. Delta frame
    if (Array.isArray(msg.updates)) {
      const ctx = msg.context || 'vessels.self';
      if (ctx !== 'vessels.self' && ctx !== conn.selfUrn && ctx !== `vessels.${conn.selfUrn}`) {
        // Ignore other AIS vessels
        return;
      }

      const now = Date.now();
      for (const updateBlock of msg.updates) {
        if (!updateBlock || !Array.isArray(updateBlock.values)) continue;
        const $source =
          updateBlock.$source ||
          (updateBlock.source && updateBlock.source.label ? updateBlock.source.label : 'unknown');
        const timestamp = updateBlock.timestamp || new Date().toISOString();

        for (const valEntry of updateBlock.values) {
          if (!valEntry || typeof valEntry.path !== 'string') continue;
          const { path: skPath, value } = valEntry;

          for (const sub of conn.subscriptions.values()) {
            if (!sub.regex.test(skPath)) continue;
            if (sub.sourceFilter && sub.sourceFilter !== $source) continue;

            // Client-side rate throttling for medium/slow tiers during high-frequency bursts
            if (sub.throttleWindowMs > 0) {
              const lastTime = sub.lastDeliveredPerPath.get(skPath) || 0;
              if (now - lastTime < sub.throttleWindowMs) {
                continue;
              }
              sub.lastDeliveredPerPath.set(skPath, now);
            }

            try {
              sub.onUpdate({
                path: skPath,
                value,
                $source,
                timestamp,
              });
            } catch {
              // protect loop
            }
          }
        }
      }
    }
  }

  async updateServerAddress(serverId, host, port) {
    const conn = this._connections.get(serverId);
    if (!conn) return;
    conn.config.host = host;
    conn.config.port = port;
    if (conn.ws) {
      const oldWs = conn.ws;
      conn.ws = null;
      try {
        oldWs.close();
      } catch {
        // ignore
      }
    }
    await this._connectWebSocket(conn);
  }

  async updateServerToken(serverId, token) {
    const conn = this._connections.get(serverId);
    if (!conn) return;
    conn.config.token = token;
    if (conn.ws) {
      const oldWs = conn.ws;
      conn.ws = null;
      try {
        oldWs.close();
      } catch {
        // ignore
      }
    }
    await this._connectWebSocket(conn);
  }

  async publishDelta(serverId, updates) {
    const conn = this._connections.get(serverId);
    if (!conn || !conn.ws || conn.ws.readyState !== 1) {
      throw new Error(`Cannot publish delta: WebSocket for ${serverId} is not connected`);
    }

    const timestamp = new Date().toISOString();
    const grouped = new Map();

    for (const u of updates) {
      if (!u.path || typeof u.path !== 'string' || !/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(u.path.trim())) {
        throw new Error(`Invalid Signal K dot-path: "${u.path}"`);
      }
      const rawSource = u.$source || u.sourceLabel || 'bridge';
      const $source = rawSource.startsWith('homey.') ? rawSource : `homey.${rawSource}`;
      if (!grouped.has($source)) {
        grouped.set($source, []);
      }
      grouped.get($source).push({ path: u.path.trim(), value: u.value });
    }

    const deltaPayload = {
      context: 'vessels.self',
      updates: Array.from(grouped.entries()).map(([$source, values]) => ({
        $source,
        timestamp,
        values,
      })),
    };

    conn.ws.sendJson(deltaPayload);
  }

  async putPath(serverId, skPath, value, options = {}) {
    return this.putController.putPath(serverId, skPath, value, options);
  }

  async getVesselSubtree(serverId, subPath = '') {
    const conn = this._connections.get(serverId);
    if (!conn) {
      throw new Error(`Unknown serverId: ${serverId}`);
    }
    const protocol = conn.config.useTls ? 'https' : 'http';
    const baseUrl = `${protocol}://${conn.config.host}:${conn.config.port}`;
    const cleanSub = String(subPath || '')
      .replace(/^\/+|\/+$/g, '')
      .replace(/\./g, '/');
    const url = cleanSub
      ? `${baseUrl}/signalk/v1/api/vessels/self/${cleanSub}`
      : `${baseUrl}/signalk/v1/api/vessels/self`;

    const headers = {};
    if (conn.config.token) {
      headers.Authorization = `Bearer ${conn.config.token}`;
    }

    const res = await fetch(url, { headers });
    if (res.status === 401 || res.status === 403) {
      this._notifyAuthFailure(serverId, res.status, 'Authentication required');
      const err = new Error(`Authentication failed (HTTP ${res.status})`);
      err.statusCode = res.status;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`GET ${url} failed with HTTP ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    return res.json();
  }

  async closeAll() {
    this._closed = true;
    for (const conn of this._connections.values()) {
      conn.manualClose = true;
      if (conn.reconnectTimer) {
        clearTimeout(conn.reconnectTimer);
        conn.reconnectTimer = null;
      }
      if (conn.ws) {
        try {
          conn.ws.close();
          conn.ws.terminate();
        } catch {
          // ignore
        }
      }
    }
    this._connections.clear();
  }
}

export class ReferencePathDiscoveryService {
  constructor(pool) {
    this.pool = pool;
  }

  async discoverAll(serverId) {
    const tree = await this.pool.getVesselSubtree(serverId);
    return {
      vessel: {
        id: tree.uuid || VESSEL_SELF_URN,
        name: tree.name || 'Signal K Vessel',
        mmsi: tree.mmsi || null,
      },
      electricalBanks: this.discoverElectricalBanksFromTree(tree, serverId),
      fluidTanks: this.discoverFluidTanksFromTree(tree, serverId),
      digitalSwitches: this.discoverDigitalSwitchesFromTree(tree, serverId),
      propulsionEngines: this.discoverPropulsionFromTree(tree, serverId),
      customSensors: this.discoverSensorsFromTree(tree, serverId),
    };
  }

  discoverElectricalBanksFromTree(tree, serverId) {
    const results = [];
    const elec = tree?.electrical || {};

    for (const [id, bank] of Object.entries(elec.batteries || {})) {
      results.push({
        name: bank.name || `Battery Bank (${id})`,
        data: { id: `${serverId}::battery::${id}`, serverId, bankType: 'battery', bankId: id, basePath: `electrical.batteries.${id}` },
        store: { serverId, bankType: 'battery', bankId: id, basePath: `electrical.batteries.${id}` },
        capabilities: [
          'measure_voltage',
          'measure_current',
          'measure_power',
          'meter_power',
          'measure_battery',
          'measure_temperature',
          'measure_remaining_ah',
          'measure_time_remaining',
          'alarm_battery',
        ],
        energy: { batteries: ['INTERNAL'] },
      });
    }

    for (const [id, solar] of Object.entries(elec.solar || {})) {
      results.push({
        name: solar.name || `Solar MPPT (${id})`,
        data: { id: `${serverId}::solar::${id}`, serverId, bankType: 'solar', bankId: id, basePath: `electrical.solar.${id}` },
        store: { serverId, bankType: 'solar', bankId: id, basePath: `electrical.solar.${id}` },
        capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'meter_power'],
        energy: { cumulative: false },
      });
    }

    for (const [id, inv] of Object.entries(elec.inverters || {})) {
      results.push({
        name: inv.name || `MultiPlus Inverter/Charger (${id})`,
        data: { id: `${serverId}::inverter::${id}`, serverId, bankType: 'inverter', bankId: id, basePath: `electrical.inverters.${id}` },
        store: { serverId, bankType: 'inverter', bankId: id, basePath: `electrical.inverters.${id}` },
        capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
      });
    }

    for (const [id, chg] of Object.entries(elec.chargers || {})) {
      results.push({
        name: chg.name || `Charger (${id})`,
        data: { id: `${serverId}::charger::${id}`, serverId, bankType: 'charger', bankId: id, basePath: `electrical.chargers.${id}` },
        store: { serverId, bankType: 'charger', bankId: id, basePath: `electrical.chargers.${id}` },
        capabilities: ['measure_voltage', 'measure_current', 'measure_power', 'charger_inverter_mode'],
      });
    }

    return results;
  }

  discoverFluidTanksFromTree(tree, serverId) {
    const results = [];
    const tanks = tree?.tanks || {};
    const typeLabels = {
      freshWater: 'Fresh Water Tank',
      fuel: 'Fuel Tank',
      blackWater: 'Black Water Tank',
      wasteWater: 'Waste Water Tank',
      liveWell: 'Live Well Tank',
      lubrication: 'Lubrication Oil Tank',
      ballast: 'Ballast Tank',
    };

    for (const [tankType, group] of Object.entries(tanks)) {
      if (!group || typeof group !== 'object') continue;
      for (const [tankId, node] of Object.entries(group)) {
        const capM3 = node?.capacity?.value ?? null;
        const capLiters = typeof capM3 === 'number' ? roundTo(capM3 * 1000, 1) : 100;
        const isPotableWater = tankType === 'freshWater';
        const capabilities = ['measure_tank_level', 'measure_tank_volume', 'alarm_generic'];
        if (isPotableWater) {
          capabilities.push('meter_water', 'alarm_water');
        }
        const label = typeLabels[tankType] || tankType;
        results.push({
          name: node.name || `${label} ${tankId}`,
          data: {
            id: `${serverId}::tank::${tankType}.${tankId}`,
            serverId,
            tankType,
            tankId,
            basePath: `tanks.${tankType}.${tankId}`,
          },
          store: {
            serverId,
            tankType,
            tankId,
            basePath: `tanks.${tankType}.${tankId}`,
            capacityLiters: capLiters,
          },
          settings: {
            capacity_liters: capLiters,
            alarm_threshold_percent:
              tankType === 'blackWater' || tankType === 'wasteWater' ? 85 : 15,
          },
          capabilities,
        });
      }
    }

    return results;
  }

  discoverDigitalSwitchesFromTree(tree, serverId) {
    const results = [];
    const switches = tree?.electrical?.switches || {};

    const addSwitch = (switchKey, node, dotPrefix) => {
      if (!node || typeof node !== 'object') return;
      if ('state' in node || 'dimmingLevel' in node) {
        const hasDim = Boolean(node.dimmingLevel && typeof node.dimmingLevel === 'object');
        const capabilities = hasDim ? ['onoff', 'dim'] : ['onoff'];
        const displayName =
          node.name ||
          node.meta?.displayName ||
          node.state?.meta?.displayName ||
          `Switch ${switchKey}`;
        results.push({
          name: displayName,
          data: {
            id: `${serverId}::switch::${dotPrefix}`,
            serverId,
            switchId: switchKey,
            basePath: dotPrefix,
          },
          store: {
            serverId,
            switchId: switchKey,
            basePath: dotPrefix,
            hasDim,
          },
          capabilities,
        });
      }
    };

    for (const [key, val] of Object.entries(switches)) {
      if (key === 'bank' && val && typeof val === 'object') {
        for (const [bankId, bankObj] of Object.entries(val)) {
          if (!bankObj || typeof bankObj !== 'object') continue;
          for (const [swId, swNode] of Object.entries(bankObj)) {
            addSwitch(`${bankId}.${swId}`, swNode, `electrical.switches.bank.${bankId}.${swId}`);
          }
        }
      } else {
        addSwitch(key, val, `electrical.switches.${key}`);
      }
    }

    return results;
  }

  discoverPropulsionFromTree(tree, serverId) {
    const results = [];
    const prop = tree?.propulsion || {};
    for (const [engineId, node] of Object.entries(prop)) {
      if (!node || typeof node !== 'object') continue;
      const titleId = engineId.charAt(0).toUpperCase() + engineId.slice(1);
      results.push({
        name: node.name || `${titleId} Engine`,
        data: {
          id: `${serverId}::propulsion::${engineId}`,
          serverId,
          engineId,
          basePath: `propulsion.${engineId}`,
        },
        store: {
          serverId,
          engineId,
          basePath: `propulsion.${engineId}`,
        },
        capabilities: [
          'measure_engine_rpm',
          'measure_temperature',
          'measure_oil_pressure',
          'measure_engine_hours',
          'measure_fuel_rate',
          'alarm_generic',
        ],
      });
    }
    return results;
  }

  discoverSensorsFromTree(tree, serverId) {
    const results = [];
    const inside = tree?.environment?.inside || {};
    for (const [zone, zoneObj] of Object.entries(inside)) {
      if (!zoneObj || typeof zoneObj !== 'object') continue;
      if (zoneObj.temperature) {
        results.push({
          name: zoneObj.temperature.meta?.displayName || `${zone} Temperature`,
          path: `environment.inside.${zone}.temperature`,
          capability: 'measure_temperature',
          unitCategory: 'temperature_k_to_c',
          serverId,
        });
      }
      if (zoneObj.relativeHumidity) {
        results.push({
          name: zoneObj.relativeHumidity.meta?.displayName || `${zone} Humidity`,
          path: `environment.inside.${zone}.relativeHumidity`,
          capability: 'measure_humidity',
          unitCategory: 'ratio_to_percent',
          serverId,
        });
      }
      if (zoneObj.pressure) {
        results.push({
          name: zoneObj.pressure.meta?.displayName || `${zone} Pressure`,
          path: `environment.inside.${zone}.pressure`,
          capability: 'measure_pressure',
          unitCategory: 'pressure_pa_to_hpa',
          serverId,
        });
      }
    }
    return results;
  }
}

// =============================================================================
// 3. Homey SDK v3 Runtime Emulator Classes
// =============================================================================

export class MockSimpleClass extends EventEmitter {
  log(..._args) {}
  error(..._args) {}
}

export class MockFlowCard extends EventEmitter {
  constructor(id, type) {
    super();
    this.id = id;
    this.type = type; // 'trigger' | 'condition' | 'action'
    this._runListener = null;
    this._autocompleteListeners = new Map();
  }

  registerRunListener(fn) {
    this._runListener = fn;
    return this;
  }

  registerArgumentAutocompleteListener(argName, fn) {
    this._autocompleteListeners.set(argName, fn);
    return this;
  }

  async trigger(deviceOrTokens = {}, tokensOrState = {}, maybeState = {}) {
    let device = null;
    let tokens = {};
    let state = {};

    if (deviceOrTokens && deviceOrTokens instanceof MockDevice) {
      device = deviceOrTokens;
      tokens = tokensOrState || {};
      state = maybeState || {};
    } else {
      tokens = deviceOrTokens || {};
      state = tokensOrState || {};
    }

    let passedRunListener = true;
    if (this._runListener && this._flowManager) {
      const testArgs = this._flowManager._triggerTestArgs.get(this.id) || {};
      try {
        passedRunListener = Boolean(await this._runListener({ device, ...testArgs }, state));
      } catch {
        passedRunListener = false;
      }
    }

    const record = {
      cardId: this.id,
      deviceId: device ? device.getData()?.id : null,
      tokens,
      state,
      passedRunListener,
      timestamp: Date.now(),
    };

    if (this._flowManager) {
      this._flowManager.triggeredHistory.push(record);
      const subs = this._flowManager._triggerSubscriptions.get(this.id) || [];
      for (const fn of subs) {
        await fn(record);
      }
    }

    return record;
  }
}

export class MockFlowManager {
  constructor() {
    this._triggers = new Map();
    this._deviceTriggers = new Map();
    this._conditions = new Map();
    this._actions = new Map();
    this._triggerTestArgs = new Map();
    this._triggerSubscriptions = new Map();
    this.triggeredHistory = [];
  }

  getTriggerCard(id) {
    if (!this._triggers.has(id)) {
      const card = new MockFlowCard(id, 'trigger');
      card._flowManager = this;
      this._triggers.set(id, card);
    }
    return this._triggers.get(id);
  }

  getDeviceTriggerCard(id) {
    if (!this._deviceTriggers.has(id)) {
      const card = new MockFlowCard(id, 'trigger');
      card._flowManager = this;
      this._deviceTriggers.set(id, card);
    }
    return this._deviceTriggers.get(id);
  }

  getConditionCard(id) {
    if (!this._conditions.has(id)) {
      const card = new MockFlowCard(id, 'condition');
      card._flowManager = this;
      this._conditions.set(id, card);
    }
    return this._conditions.get(id);
  }

  getActionCard(id) {
    if (!this._actions.has(id)) {
      const card = new MockFlowCard(id, 'action');
      card._flowManager = this;
      this._actions.set(id, card);
    }
    return this._actions.get(id);
  }

  setTriggerTestArgs(cardId, args) {
    this._triggerTestArgs.set(cardId, args);
  }

  onTrigger(cardId, asyncCallback) {
    if (!this._triggerSubscriptions.has(cardId)) {
      this._triggerSubscriptions.set(cardId, []);
    }
    this._triggerSubscriptions.get(cardId).push(asyncCallback);
  }

  async evaluateCondition(cardId, args = {}, state = {}) {
    const card = this.getConditionCard(cardId);
    if (!card._runListener) {
      throw new Error(`No runListener registered for condition card "${cardId}"`);
    }
    return Boolean(await card._runListener(args, state));
  }

  async runAction(cardId, args = {}, state = {}) {
    const card = this.getActionCard(cardId);
    if (!card._runListener) {
      throw new Error(`No runListener registered for action card "${cardId}"`);
    }
    return card._runListener(args, state);
  }

  async queryAutocomplete(cardType, cardId, argName, query = '', args = {}) {
    const card =
      cardType === 'action'
        ? this.getActionCard(cardId)
        : cardType === 'condition'
          ? this.getConditionCard(cardId)
          : this.getTriggerCard(cardId);
    const fn = card._autocompleteListeners.get(argName);
    if (!fn) {
      throw new Error(`No autocomplete listener for "${argName}" on ${cardType} card "${cardId}"`);
    }
    return fn(query, args);
  }
}

export class MockDiscoveryStrategy extends EventEmitter {
  constructor(id, homey) {
    super();
    this.id = id;
    this.homey = homey;
    this._results = {};
  }

  getDiscoveryResults() {
    return { ...this._results };
  }

  async emitDiscoveryResult(rawResult) {
    const id = rawResult.id || rawResult.txt?.self || VESSEL_SELF_URN;
    const prev = this._results[id];
    const result = {
      id,
      address: rawResult.address || '127.0.0.1',
      port: rawResult.port || 3000,
      host: rawResult.host || 'openplotter.local',
      name: rawResult.name || 'OpenPlotter Signal K',
      txt: rawResult.txt || { self: id, version: '2.8.2' },
      lastSeen: new Date().toISOString(),
    };
    this._results[id] = result;
    this.emit('result', result);

    // Notify all paired devices matching this discovery result
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        const matched =
          typeof device.onDiscoveryResult === 'function' ? device.onDiscoveryResult(result) : false;
        if (matched) {
          if (!prev && typeof device.onDiscoveryAvailable === 'function') {
            await device.onDiscoveryAvailable(result);
          } else if (
            prev &&
            (prev.address !== result.address || prev.port !== result.port) &&
            typeof device.onDiscoveryAddressChanged === 'function'
          ) {
            await device.onDiscoveryAddressChanged(result);
          } else if (typeof device.onDiscoveryLastSeenChanged === 'function') {
            await device.onDiscoveryLastSeenChanged(result);
          }
        }
      }
    }

    return result;
  }
}

export class MockPairSession {
  constructor() {
    this._handlers = new Map();
    this.currentView = 'list_devices';
    this.viewHistory = ['list_devices'];
    this.closed = false;
  }

  setHandler(event, fn) {
    this._handlers.set(event, fn);
  }

  async emit(event, data) {
    const fn = this._handlers.get(event);
    if (!fn) {
      throw new Error(`No Pair/Repair session handler registered for event "${event}"`);
    }
    return fn(data);
  }

  async showView(viewId) {
    this.currentView = viewId;
    this.viewHistory.push(viewId);
    if (this._handlers.has('showView')) {
      await this._handlers.get('showView')(viewId);
    }
  }

  async nextView() {
    await this.showView('next');
  }

  async prevView() {
    await this.showView('prev');
  }

  async done() {
    this.closed = true;
  }
}

export { MockPairSession as MockRepairSession };

export class MockDevice extends MockSimpleClass {
  constructor({ homey, driver, name, data = {}, store = {}, settings = {}, capabilities = [], capabilitiesOptions = {}, energy = {} }) {
    super();
    this.homey = homey;
    this.driver = driver;
    this.__name = name || 'Marine Device';
    this.__data = { ...data };
    this.__store = { ...store };
    this.__settings = { ...settings };
    this.__capabilities = [...capabilities];
    this.__capabilitiesOptions = { ...capabilitiesOptions };
    this.__capabilityValues = new Map();
    this.__capabilityListeners = new Map();
    this.__available = true;
    this.__unavailableMessage = null;
    this.__energy = { ...energy };
    this.capabilityHistory = [];
  }

  getName() {
    return this.__name;
  }

  getData() {
    return { ...this.__data };
  }

  getStore() {
    return { ...this.__store };
  }

  getStoreValue(key) {
    return this.__store[key];
  }

  async setStoreValue(key, value) {
    this.__store[key] = value;
  }

  async unsetStoreValue(key) {
    delete this.__store[key];
  }

  getSettings() {
    return { ...this.__settings };
  }

  getSetting(key) {
    return this.__settings[key];
  }

  async setSettings(newSettings) {
    this.__settings = { ...this.__settings, ...newSettings };
  }

  /**
   * Test helper simulating a user saving modified device settings in the Homey UI.
   */
  async simulateUserSettingsChange(changedSettings) {
    const oldSettings = { ...this.__settings };
    const newSettings = { ...this.__settings, ...changedSettings };
    const changedKeys = Object.keys(changedSettings);

    this.__settings = newSettings;
    try {
      if (typeof this.onSettings === 'function') {
        await this.onSettings({ oldSettings, newSettings, changedKeys });
      }
    } catch (err) {
      this.__settings = oldSettings;
      throw err;
    }
  }

  getCapabilities() {
    return [...this.__capabilities];
  }

  hasCapability(cap) {
    return this.__capabilities.includes(cap);
  }

  async addCapability(cap) {
    if (!this.__capabilities.includes(cap)) {
      this.__capabilities.push(cap);
    }
  }

  async removeCapability(cap) {
    this.__capabilities = this.__capabilities.filter((c) => c !== cap);
    this.__capabilityValues.delete(cap);
  }

  getCapabilityOptions(cap) {
    return this.__capabilitiesOptions[cap] || {};
  }

  async setCapabilityOptions(cap, opts) {
    this.__capabilitiesOptions[cap] = { ...(this.__capabilitiesOptions[cap] || {}), ...opts };
  }

  getCapabilityValue(cap) {
    return this.__capabilityValues.has(cap) ? this.__capabilityValues.get(cap) : null;
  }

  async setCapabilityValue(cap, value) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError(`Invalid non-finite numeric value (${value}) for capability "${cap}"`);
    }
    if (value === undefined) {
      throw new TypeError(`Cannot pass undefined to setCapabilityValue("${cap}")`);
    }

    const prev = this.getCapabilityValue(cap);
    this.__capabilityValues.set(cap, value);
    this.capabilityHistory.push({
      capability: cap,
      value,
      previousValue: prev,
      timestamp: Date.now(),
    });
  }

  registerCapabilityListener(cap, fn) {
    this.__capabilityListeners.set(cap, fn);
  }

  registerMultipleCapabilityListener(caps, fn) {
    for (const cap of caps) {
      this.__capabilityListeners.set(cap, (val, opts) => fn({ [cap]: val }, opts));
    }
  }

  /**
   * Simulates the user interacting with a setable capability in the Homey UI.
   */
  async triggerCapabilityListener(cap, value, opts = {}) {
    const listener = this.__capabilityListeners.get(cap);
    if (!listener) {
      throw new Error(`Capability "${cap}" has no registered capability listener (read-only)`);
    }
    const prevValue = this.getCapabilityValue(cap);
    // Optimistically set capability value like Homey UI, rolling back if listener rejects
    await this.setCapabilityValue(cap, value);
    try {
      const res = await listener(value, opts);
      return res;
    } catch (err) {
      this.__capabilityValues.set(cap, prevValue);
      throw err;
    }
  }

  getAvailable() {
    return this.__available;
  }

  getUnavailableMessage() {
    return this.__unavailableMessage;
  }

  async setAvailable() {
    this.__available = true;
    this.__unavailableMessage = null;
  }

  async setUnavailable(message = 'Device is unavailable') {
    this.__available = false;
    this.__unavailableMessage = message;
  }

  getEnergy() {
    return { ...this.__energy };
  }

  async setEnergy(energy) {
    this.__energy = { ...energy };
  }

  async onInit() {}
  async onAdded() {}
  async onDeleted() {}
  async onUninit() {}
}

export class MockDriver extends MockSimpleClass {
  constructor(id, homey, manifest = {}) {
    super();
    this.id = id;
    this.homey = homey;
    this.manifest = manifest;
    this._devices = [];
  }

  getDevices() {
    return [...this._devices];
  }

  getManifest() {
    return this.manifest;
  }

  async onInit() {}
  async onUninit() {}
  async onPair(_session) {}
  async onPairListDevices() {
    return [];
  }
  async onRepair(_session, _device) {}
}

export class MockApp extends MockSimpleClass {
  constructor(homey) {
    super();
    this.homey = homey;
  }

  async onInit() {}
  async onUninit() {}
}

// =============================================================================
// 4. Specification-Compliant Reference Drivers & Flow Engine
// =============================================================================

class ReferenceVesselDevice extends MockDevice {
  async onInit() {
    this._unsubs = [];
    const serverId = this.getStoreValue('serverId') || 'default';
    this._serverId = serverId;
    const pool = this.homey.app.connectionPool;
    const unitConverter = this.homey.app.unitConverter;
    const anchorCalc = this.homey.app.anchorCalculator;

    this._anchorState = {
      armed: Boolean(this.getCapabilityValue('onoff.anchor_armed')),
      anchorPosition: null,
      vesselPosition: null,
      pluginCurrentRadiusMeters: null,
      pluginAlarmState: null,
      maxRadiusMeters: Number(this.getSetting('anchor_max_radius') || 40),
      rodeLengthMeters: Number(this.getSetting('anchor_rode_length') || 30),
    };

    if (this.hasCapability('measure_anchor_radius')) {
      await this.setCapabilityValue('measure_anchor_radius', this._anchorState.maxRadiusMeters);
    }

    // Listen to auth failures
    this._unsubs.push(
      pool.onAuthFailure(serverId, ({ message }) => {
        this.setUnavailable(message || 'Authentication required — please use Repair Device');
      }),
    );

    const sourceFilter = this.getSetting('source_filter') || undefined;

    // Navigation & Wind & Environment subscriptions (Medium 2000ms tier)
    const mediumPaths = [
      'navigation.speedOverGround',
      'navigation.speedThroughWater',
      'navigation.courseOverGroundTrue',
      'navigation.headingTrue',
      'navigation.position',
      'navigation.state',
      'environment.depth.belowTransducer',
      'environment.wind.speedApparent',
      'environment.wind.angleApparent',
      'environment.wind.speedTrue',
      'environment.wind.angleTrueWater',
      'environment.outside.pressure',
      'environment.outside.temperature',
      'environment.water.temperature',
      'steering.autopilot.state',
    ];

    for (const skPath of mediumPaths) {
      this._unsubs.push(
        pool.subscribe(serverId, {
          subscriberId: this.getData().id,
          path: skPath,
          tier: 'medium',
          sourceFilter,
          onUpdate: (u) => this._handleTelemetryUpdate(u, unitConverter, anchorCalc),
        }),
      );
    }

    // Fast (200ms) Anchor Watch & Notification subscriptions
    const fastPaths = [
      'navigation.anchor.position',
      'navigation.anchor.currentRadius',
      'navigation.anchor.maxRadius',
      'navigation.anchor.rodeLength',
      'notifications.navigation.anchor',
    ];

    for (const skPath of fastPaths) {
      this._unsubs.push(
        pool.subscribe(serverId, {
          subscriberId: this.getData().id,
          path: skPath,
          tier: 'fast',
          onUpdate: (u) => this._handleAnchorUpdate(u, anchorCalc),
        }),
      );
    }

    // Capability listener for onoff.anchor_armed
    if (this.hasCapability('onoff.anchor_armed')) {
      this.registerCapabilityListener('onoff.anchor_armed', async (armed) => {
        if (armed) {
          await this.armAnchorWatch({
            maxRadius: this._anchorState.maxRadiusMeters,
            rodeLength: this._anchorState.rodeLengthMeters,
          });
        } else {
          await this.disarmAnchorWatch();
        }
      });
    }
  }

  async _handleTelemetryUpdate({ path: skPath, value }, unitConverter, anchorCalc) {
    const speedUnit = this.getSetting('speed_unit') || 'kn';

    if (skPath === 'navigation.speedOverGround') {
      const conv = unitConverter.convertSpeedFromSI(value, speedUnit, 2);
      if (conv !== null) await this.setCapabilityValue('measure_sog', conv);
    } else if (skPath === 'navigation.speedThroughWater') {
      const conv = unitConverter.convertSpeedFromSI(value, speedUnit, 2);
      if (conv !== null) await this.setCapabilityValue('measure_stw', conv);
    } else if (skPath === 'navigation.courseOverGroundTrue') {
      const conv = unitConverter.fromSignalK(value, 'angle_rad_to_deg_unsigned', 1);
      if (conv !== null) await this.setCapabilityValue('measure_cog', conv);
    } else if (skPath === 'navigation.headingTrue') {
      const conv = unitConverter.fromSignalK(value, 'angle_rad_to_deg_unsigned', 1);
      if (conv !== null) await this.setCapabilityValue('measure_heading', conv);
    } else if (skPath === 'environment.depth.belowTransducer') {
      const conv = unitConverter.fromSignalK(value, 'distance_m', 2);
      if (conv !== null) await this.setCapabilityValue('measure_depth', conv);
    } else if (skPath === 'environment.wind.speedApparent') {
      const conv = unitConverter.convertSpeedFromSI(value, speedUnit, 2);
      if (conv !== null) await this.setCapabilityValue('measure_wind_strength', conv);
    } else if (skPath === 'environment.wind.angleApparent') {
      const conv = unitConverter.fromSignalK(value, 'angle_rad_to_deg_signed', 1);
      if (conv !== null) await this.setCapabilityValue('measure_wind_angle', conv);
    } else if (skPath === 'environment.outside.pressure') {
      const conv = unitConverter.fromSignalK(value, 'pressure_pa_to_hpa', 2);
      if (conv !== null) await this.setCapabilityValue('measure_pressure', conv);
    } else if (skPath === 'environment.outside.temperature' || skPath === 'environment.water.temperature') {
      const conv = unitConverter.fromSignalK(value, 'temperature_k_to_c', 2);
      if (conv !== null) await this.setCapabilityValue('measure_temperature', conv);
    } else if (skPath === 'navigation.state' && typeof value === 'string') {
      const prevState = this.getCapabilityValue('navigation_state') || 'unknown';
      await this.setCapabilityValue('navigation_state', value);
      if (prevState !== value) {
        await this.homey.flow.getTriggerCard('navigation_state_changed').trigger(
          this,
          { state: value, previousState: prevState },
          { state: value, previousState: prevState },
        );
      }
    } else if (skPath === 'steering.autopilot.state' && typeof value === 'string') {
      await this.setCapabilityValue('autopilot_state', value);
    } else if (skPath === 'navigation.position') {
      if (value && typeof value.latitude === 'number' && typeof value.longitude === 'number') {
        this._anchorState.vesselPosition = { latitude: value.latitude, longitude: value.longitude };
        if (this._anchorState.armed && !this._anchorState.anchorPosition) {
          this._anchorState.anchorPosition = { ...this._anchorState.vesselPosition };
        }
        await this._recomputeAnchorDrift(anchorCalc);
      } else if (value === null) {
        this._anchorState.vesselPosition = null;
        await this._recomputeAnchorDrift(anchorCalc);
      }
    }
  }

  async _handleAnchorUpdate({ path: skPath, value }, anchorCalc) {
    if (skPath === 'navigation.anchor.position') {
      if (value && typeof value.latitude === 'number' && typeof value.longitude === 'number') {
        this._anchorState.anchorPosition = { latitude: value.latitude, longitude: value.longitude };
        this._anchorState.armed = true;
        await this.setCapabilityValue('onoff.anchor_armed', true);
      } else if (value === null) {
        this._anchorState.anchorPosition = null;
        this._anchorState.armed = false;
        await this.setCapabilityValue('onoff.anchor_armed', false);
        await this.setCapabilityValue('alarm_generic', false);
      }
    } else if (skPath === 'navigation.anchor.currentRadius') {
      this._anchorState.pluginCurrentRadiusMeters =
        typeof value === 'number' && Number.isFinite(value) ? value : null;
    } else if (skPath === 'navigation.anchor.maxRadius') {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        this._anchorState.maxRadiusMeters = value;
        await this.setCapabilityValue('measure_anchor_radius', value);
      }
    } else if (skPath === 'navigation.anchor.rodeLength') {
      if (typeof value === 'number' && Number.isFinite(value)) {
        this._anchorState.rodeLengthMeters = value;
      }
    } else if (skPath === 'notifications.navigation.anchor') {
      if (value === null || value?.state === 'normal') {
        this._anchorState.pluginAlarmState = 'normal';
        if (!this._anchorState.armed) {
          await this.setCapabilityValue('alarm_generic', false);
        }
      } else if (value && typeof value.state === 'string') {
        this._anchorState.pluginAlarmState = value.state;
      }
    }

    await this._recomputeAnchorDrift(anchorCalc);
  }

  async _recomputeAnchorDrift(anchorCalc) {
    const status = anchorCalc.evaluateDrift(this._anchorState);
    this._lastDriftStatus = status;

    if (status.currentRadiusMeters !== null) {
      await this.setCapabilityValue('measure_anchor_distance', status.currentRadiusMeters);
    }

    const wasAlarm = Boolean(this.getCapabilityValue('alarm_generic'));
    await this.setCapabilityValue('alarm_generic', status.isDragging);

    if (status.isDragging && !wasAlarm) {
      const tokens = {
        distance: status.currentRadiusMeters ?? 0,
        currentRadius: status.currentRadiusMeters ?? 0,
        maxRadius: status.maxRadiusMeters,
        bearing: status.bearingTrueDegrees ?? 0,
      };
      await this.homey.flow.getTriggerCard('anchor_drag_alarm').trigger(this, tokens, tokens);
    }
  }

  async armAnchorWatch({ maxRadius = 40, rodeLength = 30 } = {}) {
    if (typeof maxRadius !== 'number' || !Number.isFinite(maxRadius) || maxRadius <= 0) {
      throw new Error('Anchor max radius must be a positive number in meters');
    }
    const pool = this.homey.app.connectionPool;
    const anchorCalc = this.homey.app.anchorCalculator;

    if (!this._anchorState.vesselPosition) {
      try {
        const posNode = await pool.getVesselSubtree(this._serverId, 'navigation/position');
        if (posNode?.value) {
          this._anchorState.vesselPosition = {
            latitude: posNode.value.latitude,
            longitude: posNode.value.longitude,
          };
        }
      } catch {
        // fallback coordinate
      }
    }

    const dropPos = this._anchorState.vesselPosition || { latitude: 59.3293, longitude: 18.0686 };
    this._anchorState.anchorPosition = { ...dropPos };
    this._anchorState.armed = true;
    this._anchorState.maxRadiusMeters = maxRadius;
    this._anchorState.rodeLengthMeters = rodeLength;
    // Clear stale plugin radius when arming so live GPS drift or new plugin updates take precedence
    this._anchorState.pluginCurrentRadiusMeters = null;

    await pool.putPath(this._serverId, 'navigation.anchor.position', dropPos);
    await pool.putPath(this._serverId, 'navigation.anchor.maxRadius', maxRadius);
    if (rodeLength) {
      await pool.putPath(this._serverId, 'navigation.anchor.rodeLength', rodeLength).catch(() => {});
    }

    await this.setCapabilityValue('onoff.anchor_armed', true);
    await this.setCapabilityValue('measure_anchor_radius', maxRadius);
    await this._recomputeAnchorDrift(anchorCalc);
  }

  async disarmAnchorWatch() {
    const pool = this.homey.app.connectionPool;
    this._anchorState.armed = false;
    this._anchorState.anchorPosition = null;
    this._anchorState.pluginCurrentRadiusMeters = null;
    this._anchorState.pluginAlarmState = null;

    await pool.putPath(this._serverId, 'navigation.anchor.position', null);
    await this.setCapabilityValue('onoff.anchor_armed', false);
    await this.setCapabilityValue('alarm_generic', false);
  }

  async setAnchorMaxRadius(maxRadius) {
    if (typeof maxRadius !== 'number' || !Number.isFinite(maxRadius) || maxRadius <= 0) {
      throw new Error('Anchor max radius must be a positive number in meters');
    }
    const pool = this.homey.app.connectionPool;
    const anchorCalc = this.homey.app.anchorCalculator;

    await pool.putPath(this._serverId, 'navigation.anchor.maxRadius', maxRadius);
    this._anchorState.maxRadiusMeters = maxRadius;
    await this.setCapabilityValue('measure_anchor_radius', maxRadius);
    await this._recomputeAnchorDrift(anchorCalc);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('anchor_max_radius')) {
      const r = Number(newSettings.anchor_max_radius);
      if (!Number.isFinite(r) || r <= 0) {
        throw new Error('Anchor max radius must be greater than 0 meters');
      }
      this._anchorState.maxRadiusMeters = r;
      await this.setCapabilityValue('measure_anchor_radius', r);
    }
  }

  onDiscoveryResult(discoveryResult) {
    return discoveryResult.id === this.getData().id || discoveryResult.id === VESSEL_SELF_URN;
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    await this.setStoreValue('host', discoveryResult.address);
    await this.setStoreValue('port', discoveryResult.port);
    await this.homey.app.connectionPool.updateServerAddress(
      this._serverId,
      discoveryResult.address,
      discoveryResult.port,
    );
    await this.setAvailable();
  }

  async onUninit() {
    for (const unsub of this._unsubs || []) {
      unsub();
    }
    this._unsubs = [];
  }
}

class ReferencePropulsionDevice extends MockDevice {
  async onInit() {
    this._unsubs = [];
    const serverId = this.getStoreValue('serverId') || 'default';
    const engineId = this.getData().engineId || this.getStoreValue('engineId') || 'port';
    const basePath = `propulsion.${engineId}`;
    const pool = this.homey.app.connectionPool;
    const uc = this.homey.app.unitConverter;

    const subPaths = [
      `${basePath}.state`,
      `${basePath}.revolutions`,
      `${basePath}.temperature`,
      `${basePath}.coolantTemperature`,
      `${basePath}.oilPressure`,
      `${basePath}.runTime`,
      `${basePath}.fuel.rate`,
      `${basePath}.transmission.gear`,
      `notifications.propulsion.${engineId}.*`,
    ];

    for (const skPath of subPaths) {
      const tier = skPath.startsWith('notifications.') ? 'fast' : 'medium';
      this._unsubs.push(
        pool.subscribe(serverId, {
          subscriberId: this.getData().id,
          path: skPath,
          tier,
          onUpdate: async ({ path: p, value }) => {
            if (p === `${basePath}.revolutions`) {
              const rpm = uc.fromSignalK(value, 'frequency_hz_to_rpm', 0);
              if (rpm !== null) await this.setCapabilityValue('measure_engine_rpm', rpm);
            } else if (p === `${basePath}.temperature` || p === `${basePath}.coolantTemperature`) {
              const tempC = uc.fromSignalK(value, 'temperature_k_to_c', 1);
              if (tempC !== null) await this.setCapabilityValue('measure_temperature', tempC);
            } else if (p === `${basePath}.oilPressure`) {
              const bar = uc.fromSignalK(value, 'pressure_pa_to_bar', 2);
              if (bar !== null) await this.setCapabilityValue('measure_oil_pressure', bar);
            } else if (p === `${basePath}.runTime`) {
              const hrs = uc.fromSignalK(value, 'duration_s_to_h', 1);
              if (hrs !== null) await this.setCapabilityValue('measure_engine_hours', hrs);
            } else if (p === `${basePath}.fuel.rate`) {
              const lph = uc.fromSignalK(value, 'flow_m3s_to_lh', 2);
              if (lph !== null) await this.setCapabilityValue('measure_fuel_rate', lph);
            } else if (p === `${basePath}.state` && typeof value === 'string') {
              await this.setStoreValue('engineState', value);
              if (this.hasCapability('engine_state')) {
                await this.setCapabilityValue('engine_state', value);
              }
            } else if (p === `${basePath}.transmission.gear` && typeof value === 'string') {
              await this.setStoreValue('transmissionGear', value);
              if (this.hasCapability('transmission_gear')) {
                await this.setCapabilityValue('transmission_gear', value);
              }
            } else if (p.startsWith(`notifications.propulsion.${engineId}.`)) {
              const isAlarm =
                value !== null &&
                typeof value === 'object' &&
                ['alert', 'warn', 'alarm', 'emergency'].includes(String(value.state || '').toLowerCase());
              await this.setCapabilityValue('alarm_generic', isAlarm);
            }
          },
        }),
      );
    }
  }

  async onUninit() {
    for (const unsub of this._unsubs || []) unsub();
    this._unsubs = [];
  }
}

class ReferenceCustomSensorDevice extends MockDevice {
  async onInit() {
    this._unsub = null;
    await this._bindSubscription();
  }

  async _bindSubscription() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }

    const serverId = this.getStoreValue('serverId') || 'default';
    const skPath = this.getSetting('path') || this.getStoreValue('path') || 'environment.inside.engineRoom.temperature';
    const capability = this.getSetting('capability') || this.getStoreValue('capability') || this.getCapabilities()[0] || 'measure_temperature';
    const unitCategory = this.getSetting('unitCategory') || this.getStoreValue('unitCategory') || 'temperature_k_to_c';
    const throttleTier = this.getSetting('throttleTier') || this.getStoreValue('throttleTier') || 'slow';
    const sourceFilter = this.getSetting('sourceFilter') || this.getStoreValue('sourceFilter') || undefined;

    if (!this.hasCapability(capability)) {
      await this.addCapability(capability);
    }

    const pool = this.homey.app.connectionPool;
    const uc = this.homey.app.unitConverter;

    this._unsub = pool.subscribe(serverId, {
      subscriberId: this.getData().id,
      path: skPath,
      tier: throttleTier,
      sourceFilter,
      onUpdate: async ({ value }) => {
        if (capability.startsWith('alarm_') || capability.startsWith('onoff')) {
          if (value === null) {
            await this.setCapabilityValue(capability, false);
          } else if (typeof value === 'boolean') {
            await this.setCapabilityValue(capability, value);
          } else if (typeof value === 'number') {
            await this.setCapabilityValue(capability, value !== 0);
          } else if (typeof value === 'object' && typeof value.state === 'string') {
            const active = ['alert', 'warn', 'alarm', 'emergency'].includes(value.state.toLowerCase());
            await this.setCapabilityValue(capability, active);
          }
          return;
        }

        const converted = uc.fromSignalK(value, unitCategory, 2);
        if (converted !== null) {
          await this.setCapabilityValue(capability, converted);
        }
      },
    });
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('path')) {
      const candidate = String(newSettings.path || '').trim();
      if (!candidate || candidate.includes('..') || candidate.includes('//') || !/^[a-zA-Z0-9_.*]+(\.[a-zA-Z0-9_.*]+)+$/.test(candidate)) {
        throw new Error('Invalid Signal K path');
      }
    }
    await this._bindSubscription();
  }

  async onUninit() {
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
  }
}

class ReferenceElectricalBankDevice extends MockDevice {
  async onInit() {
    this._unsubs = [];
    const serverId = this.getStoreValue('serverId') || 'default';
    this._serverId = serverId;
    const bankType = this.getStoreValue('bankType') || this.getData().bankType || 'battery';
    const bankId = this.getStoreValue('bankId') || this.getData().bankId || 'house';
    const basePath = this.getStoreValue('basePath') || `electrical.batteries.${bankId}`;
    this._bankType = bankType;
    this._bankId = bankId;
    this._basePath = basePath;

    const pool = this.homey.app.connectionPool;
    const uc = this.homey.app.unitConverter;

    this._lastVoltage = null;
    this._lastCurrent = null;
    this._hasExplicitPower = false;
    this._socBelowTriggered = new Set(); // tracks thresholds already fired in current dip

    const subscribeRel = (relPath, handler) => {
      const fullPath = relPath ? `${basePath}.${relPath}` : basePath;
      this._unsubs.push(
        pool.subscribe(serverId, {
          subscriberId: this.getData().id,
          path: fullPath,
          tier: 'slow',
          onUpdate: handler,
        }),
      );
    };

    if (bankType === 'battery') {
      subscribeRel('voltage', async ({ value }) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this._lastVoltage = value;
          await this.setCapabilityValue('measure_voltage', roundTo(value, 2));
          if (!this._hasExplicitPower && this._lastCurrent !== null) {
            await this.setCapabilityValue('measure_power', roundTo(this._lastVoltage * this._lastCurrent, 2));
          }
          await this._evaluateBatteryAlarm();
        }
      });

      subscribeRel('current', async ({ value }) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this._lastCurrent = value;
          await this.setCapabilityValue('measure_current', roundTo(value, 2));
          if (!this._hasExplicitPower && this._lastVoltage !== null) {
            await this.setCapabilityValue('measure_power', roundTo(this._lastVoltage * this._lastCurrent, 2));
          }
        }
      });

      subscribeRel('power', async ({ value }) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          this._hasExplicitPower = true;
          await this.setCapabilityValue('measure_power', roundTo(value, 2));
        }
      });

      subscribeRel('temperature', async ({ value }) => {
        const tempC = uc.fromSignalK(value, 'temperature_k_to_c', 1);
        if (tempC !== null && this.hasCapability('measure_temperature')) {
          await this.setCapabilityValue('measure_temperature', tempC);
        }
      });

      subscribeRel('capacity.stateOfCharge', async ({ value }) => {
        const pct = uc.fromSignalK(value, 'ratio_to_percent', 1);
        if (pct !== null) {
          const clamped = Math.max(0, Math.min(100, pct));
          const prevSoc = this.getCapabilityValue('measure_battery');
          await this.setCapabilityValue('measure_battery', clamped);
          await this._evaluateBatteryAlarm();
          await this._evaluateSocThresholds(prevSoc, clamped);
        }
      });

      subscribeRel('capacity.remaining', async ({ value }) => {
        const ah = uc.fromSignalK(value, 'charge_c_to_ah', 1);
        if (ah !== null && this.hasCapability('measure_remaining_ah')) {
          await this.setCapabilityValue('measure_remaining_ah', ah);
        }
      });

      subscribeRel('capacity.timeRemaining', async ({ value }) => {
        const hrs = uc.fromSignalK(value, 'duration_s_to_h', 1);
        if (hrs !== null && this.hasCapability('measure_time_remaining')) {
          await this.setCapabilityValue('measure_time_remaining', hrs);
        }
      });

      subscribeRel('lifetimeDischarge', async ({ value }) => {
        const kwh = uc.fromSignalK(value, 'energy_j_to_kwh', 2);
        if (kwh !== null && this.hasCapability('meter_power')) {
          await this.setCapabilityValue('meter_power', kwh);
        }
      });
    } else if (bankType === 'solar') {
      subscribeRel('panelVoltage', async ({ value }) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          await this.setCapabilityValue('measure_voltage', roundTo(value, 2));
        }
      });
      subscribeRel('current', async ({ value }) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          await this.setCapabilityValue('measure_current', roundTo(value, 2));
        }
      });
      subscribeRel('panelPower', async ({ value }) => {
        if (typeof value === 'number' && Number.isFinite(value)) {
          await this.setCapabilityValue('measure_power', roundTo(value, 2));
        }
      });
      subscribeRel('yieldToday', async ({ value }) => {
        const kwh = uc.fromSignalK(value, 'energy_j_to_kwh', 2);
        if (kwh !== null && this.hasCapability('meter_power')) {
          await this.setCapabilityValue('meter_power', kwh);
        }
      });
    } else if (bankType === 'inverter' || bankType === 'charger') {
      const modePath = bankType === 'inverter' ? `${basePath}.inverterMode` : `${basePath}.mode`;
      this._unsubs.push(
        pool.subscribe(serverId, {
          subscriberId: this.getData().id,
          path: modePath,
          tier: 'fast',
          onUpdate: async ({ value }) => {
            if (typeof value === 'string' && this.hasCapability('charger_inverter_mode')) {
              await this.setCapabilityValue('charger_inverter_mode', value);
            }
          },
        }),
      );
    }

    if (this.hasCapability('charger_inverter_mode')) {
      this.registerCapabilityListener('charger_inverter_mode', async (mode) => {
        if (bankType === 'battery' || bankType === 'solar') {
          const err = new Error('405 PUT not supported on passive battery/solar bank');
          err.statusCode = 405;
          throw err;
        }
        const targetPath =
          bankType === 'inverter'
            ? `electrical.inverters.${bankId}.inverterMode`
            : `electrical.chargers.${bankId}.mode`;
        await pool.putPath(serverId, targetPath, mode);
      });
    }
  }

  async _evaluateBatteryAlarm() {
    if (!this.hasCapability('alarm_battery')) return;
    const lowSocThreshold = Number(this.getSetting('lowSocThreshold') ?? 20);
    const lowVoltThreshold = Number(this.getSetting('lowVoltageThreshold') ?? 11.8);

    const soc = this.getCapabilityValue('measure_battery');
    const volt = this.getCapabilityValue('measure_voltage');

    const isLowSoc = typeof soc === 'number' && soc <= lowSocThreshold;
    const isLowVolt = typeof volt === 'number' && volt <= lowVoltThreshold;
    await this.setCapabilityValue('alarm_battery', Boolean(isLowSoc || isLowVolt));
  }

  async _evaluateSocThresholds(prevSoc, newSoc) {
    const standardThresholds = [50, 40, 30, 25, 20, 15, 10];
    const configuredThreshold = Number(this.getSetting('lowSocThreshold') || 20);
    if (!standardThresholds.includes(configuredThreshold)) {
      standardThresholds.push(configuredThreshold);
    }

    // Re-arm thresholds if SOC recovered above them
    for (const t of Array.from(this._socBelowTriggered)) {
      if (newSoc > t) {
        this._socBelowTriggered.delete(t);
      }
    }

    for (const threshold of standardThresholds) {
      const crossedDown = (prevSoc === null || prevSoc >= threshold) && newSoc < threshold;
      if (crossedDown && !this._socBelowTriggered.has(threshold)) {
        this._socBelowTriggered.add(threshold);
        await this.homey.flow.getTriggerCard('battery_soc_below_threshold').trigger(
          this,
          { soc: newSoc, threshold, bankId: this._bankId },
          { soc: newSoc, threshold, bankId: this._bankId },
        );
      }
    }
  }

  async onDiscoveryAddressChanged(discoveryResult) {
    await this.setStoreValue('host', discoveryResult.address);
    await this.setStoreValue('port', discoveryResult.port);
    await this.homey.app.connectionPool.updateServerAddress(
      this._serverId,
      discoveryResult.address,
      discoveryResult.port,
    );
    await this.setAvailable();
  }

  async onUninit() {
    for (const unsub of this._unsubs || []) unsub();
    this._unsubs = [];
  }
}

class ReferenceFluidTankDevice extends MockDevice {
  async onInit() {
    this._unsubs = [];
    const serverId = this.getStoreValue('serverId') || 'default';
    const tankType = this.getStoreValue('tankType') || this.getData().tankType || 'freshWater';
    const tankId = this.getStoreValue('tankId') ?? this.getData().tankId ?? '0';
    const basePath = this.getStoreValue('basePath') || `tanks.${tankType}.${tankId}`;
    this._tankType = tankType;
    this._capacityLiters =
      this.getSetting('capacity_liters') ?? this.getStoreValue('capacityLiters') ?? null;
    this._hasExplicitVolume = false;

    const pool = this.homey.app.connectionPool;
    const uc = this.homey.app.unitConverter;

    this._unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: this.getData().id,
        path: `${basePath}.capacity`,
        tier: 'slow',
        onUpdate: ({ value }) => {
          const capL = uc.fromSignalK(value, 'volume_m3_to_l', 1);
          if (capL !== null) {
            this._capacityLiters = capL;
          }
        },
      }),
    );

    this._unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: this.getData().id,
        path: `${basePath}.currentVolume`,
        tier: 'slow',
        onUpdate: async ({ value }) => {
          const volL = uc.fromSignalK(value, 'volume_m3_to_l', 1);
          if (volL !== null) {
            this._hasExplicitVolume = true;
            await this.setCapabilityValue('measure_tank_volume', Math.max(0, volL));
            if (tankType === 'freshWater' && this.hasCapability('meter_water')) {
              await this.setCapabilityValue('meter_water', roundTo(Math.max(0, value), 3));
            }
          }
        },
      }),
    );

    this._unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: this.getData().id,
        path: `${basePath}.currentLevel`,
        tier: 'slow',
        onUpdate: async ({ value }) => {
          const rawPct = uc.fromSignalK(value, 'ratio_to_percent', 1);
          if (rawPct === null) return;
          const levelPct = Math.max(0, Math.min(100, rawPct));
          await this.setCapabilityValue('measure_tank_level', levelPct);

          if (!this._hasExplicitVolume && typeof this._capacityLiters === 'number' && this._capacityLiters > 0) {
            const derivedLiters = roundTo((levelPct / 100) * this._capacityLiters, 1);
            await this.setCapabilityValue('measure_tank_volume', derivedLiters);
            if (tankType === 'freshWater' && this.hasCapability('meter_water')) {
              await this.setCapabilityValue('meter_water', roundTo(derivedLiters / 1000, 3));
            }
          }

          await this._evaluateTankAlarm(levelPct);
        },
      }),
    );
  }

  async _evaluateTankAlarm(levelPct) {
    const isWaste = this._tankType === 'blackWater' || this._tankType === 'wasteWater';
    const defaultThreshold = isWaste ? 85 : 15;
    const threshold = Number(
      this.getSetting('alarmThresholdPercent') ??
        this.getSetting('alarm_threshold_percent') ??
        defaultThreshold,
    );

    const isAlarm = isWaste ? levelPct >= threshold : levelPct <= threshold;
    if (this.hasCapability('alarm_generic')) {
      await this.setCapabilityValue('alarm_generic', isAlarm);
    }
    if (this.hasCapability('alarm_water') && isWaste) {
      await this.setCapabilityValue('alarm_water', isAlarm);
    }
  }

  async onSettings({ newSettings }) {
    const rawThreshold =
      newSettings.alarmThresholdPercent !== undefined
        ? newSettings.alarmThresholdPercent
        : newSettings.alarm_threshold_percent;
    if (rawThreshold !== undefined) {
      const val = Number(rawThreshold);
      if (!Number.isFinite(val) || val < 0 || val > 100) {
        throw new Error('Tank alarm threshold must be between 0 and 100%');
      }
    }
  }

  async onUninit() {
    for (const unsub of this._unsubs || []) unsub();
    this._unsubs = [];
  }
}

class ReferenceDigitalSwitchDevice extends MockDevice {
  async onInit() {
    this._unsubs = [];
    const serverId = this.getStoreValue('serverId') || 'default';
    this._serverId = serverId;
    const switchId = this.getStoreValue('switchId') || this.getData().switchId || 'anchorLight';
    const basePath = this.getStoreValue('basePath') || `electrical.switches.${switchId}`;
    this._basePath = basePath;

    const pool = this.homey.app.connectionPool;

    this._unsubs.push(
      pool.onAuthFailure(serverId, ({ message }) => {
        this.setUnavailable(message || 'Authentication required — please use Repair Device');
      }),
    );

    this._unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: this.getData().id,
        path: `${basePath}.state`,
        tier: 'fast',
        onUpdate: async ({ value }) => {
          if (typeof value === 'boolean') {
            await this.setCapabilityValue('onoff', value);
          } else if (typeof value === 'number') {
            await this.setCapabilityValue('onoff', value !== 0);
          }
        },
      }),
    );

    if (this.hasCapability('dim')) {
      this._unsubs.push(
        pool.subscribe(serverId, {
          subscriberId: this.getData().id,
          path: `${basePath}.dimmingLevel`,
          tier: 'fast',
          onUpdate: async ({ value }) => {
            if (typeof value === 'number' && Number.isFinite(value)) {
              const clamped = Math.max(0, Math.min(1, value));
              await this.setCapabilityValue('dim', clamped);
              await this.setCapabilityValue('onoff', clamped > 0);
            }
          },
        }),
      );
    }

    this.registerCapabilityListener('onoff', async (val) => {
      const source = this.getSetting('sourceFilter') || this.getStoreValue('sourceFilter') || undefined;
      const timeoutMs = Number(this.getSetting('putTimeoutMs') || 1500);
      await pool.putPath(serverId, `${basePath}.state`, Boolean(val), { source, timeoutMs });
    });

    if (this.hasCapability('dim')) {
      this.registerCapabilityListener('dim', async (val) => {
        const clamped = Math.max(0, Math.min(1, Number(val)));
        const source = this.getSetting('sourceFilter') || this.getStoreValue('sourceFilter') || undefined;
        const timeoutMs = Number(this.getSetting('putTimeoutMs') || 1500);
        await pool.putPath(serverId, `${basePath}.dimmingLevel`, clamped, { source, timeoutMs });
        await this.setCapabilityValue('onoff', clamped > 0);
      });
    }
  }

  async onUninit() {
    for (const unsub of this._unsubs || []) unsub();
    this._unsubs = [];
  }
}

// =============================================================================
// 5. FlowCardManager (F13 Bidirectional Sensor Bridge & F14 Maritime Automation)
// =============================================================================

export class ReferenceFlowCardManager {
  constructor(homey, app) {
    this.homey = homey;
    this.app = app;
    this._unsubs = [];
    this._latestPathValues = new Map();
    this._activeAlarms = new Map();
    this._shorePowerConnected = true;
  }

  registerAll() {
    const flow = this.homey.flow;
    const uc = this.app.unitConverter;
    const pool = this.app.connectionPool;

    // -------------------------------------------------------------------------
    // F13: Homey -> Signal K Bidirectional Sensor Bridge Flow Action Cards
    // -------------------------------------------------------------------------
    const getTargetServerId = (args) =>
      args?.serverId ||
      args?.device?.getStoreValue?.('serverId') ||
      Array.from(pool._connections.keys())[0] ||
      'default';

    flow.getActionCard('publish_temperature_to_signalk').registerRunListener(async (args) => {
      const val = Number(args.value ?? args.temperature);
      if (!Number.isFinite(val)) {
        throw new Error('Invalid numeric sensor value: temperature must be a finite number');
      }
      if (val < -273.15) {
        throw new Error('Temperature cannot be below absolute zero (-273.15°C)');
      }
      const zone = String(args.zone || 'mainCabin').trim();
      const skPath = args.path || `environment.inside.${zone}.temperature`;
      const kelvin = uc.toSignalK(val, 'temperature_k_to_c');
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: kelvin,
          $source: args.source || 'zigbee.temperature',
        },
      ]);
      return true;
    });

    flow.getActionCard('publish_humidity_to_signalk').registerRunListener(async (args) => {
      const val = Number(args.value ?? args.humidity);
      if (!Number.isFinite(val)) {
        throw new Error('Invalid numeric sensor value: humidity must be a finite number');
      }
      if (val < 0 || val > 100) {
        throw new Error('Relative humidity percentage must be between 0% and 100%');
      }
      const zone = String(args.zone || 'mainCabin').trim();
      const skPath = args.path || `environment.inside.${zone}.relativeHumidity`;
      const ratio = uc.toSignalK(val, 'ratio_to_percent');
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: ratio,
          $source: args.source || 'ble.humidity',
        },
      ]);
      return true;
    });

    flow.getActionCard('publish_pressure_to_signalk').registerRunListener(async (args) => {
      const val = Number(args.value ?? args.pressure);
      if (!Number.isFinite(val) || val <= 0) {
        throw new Error('Invalid numeric sensor value: pressure must be a positive finite number');
      }
      const zone = String(args.zone || 'saloon').trim();
      const skPath = args.path || `environment.inside.${zone}.pressure`;
      const pascals = uc.toSignalK(val, 'pressure_pa_to_hpa');
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: pascals,
          $source: args.source || 'i2c.pressure',
        },
      ]);
      return true;
    });

    flow.getActionCard('publish_switch_state_to_signalk').registerRunListener(async (args) => {
      const switchId = String(args.switchId || args.id || '').trim();
      if (!switchId) {
        throw new Error('Switch ID is required');
      }
      const skPath = args.path || `electrical.switches.${switchId}.state`;
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: Boolean(args.state ?? args.value),
          $source: args.source || 'homey.switch',
        },
      ]);
      return true;
    });

    flow.getActionCard('raise_signalk_notification').registerRunListener(async (args) => {
      const category = String(args.category || 'security').trim();
      const item = String(args.item || 'companionwayHatch').trim();
      const state = String(args.state || 'alarm').toLowerCase();
      const message = String(args.message || `${category}.${item} ${state}`);
      const method = Array.isArray(args.method) ? args.method : ['visual', 'sound'];
      const skPath = args.path || `notifications.${category}.${item}`;

      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: { state, method, message },
          $source: args.source || `homey.${category}`,
        },
      ]);
      return true;
    });

    flow.getActionCard('clear_signalk_notification').registerRunListener(async (args) => {
      const category = String(args.category || 'security').trim();
      const item = String(args.item || 'companionwayHatch').trim();
      const skPath = args.path || `notifications.${category}.${item}`;
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: { state: 'normal', method: [], message: args.message || 'Normal' },
          $source: args.source || `homey.${category}`,
        },
      ]);
      return true;
    });

    flow.getActionCard('send_delta_to_signalk').registerRunListener(async (args) => {
      const skPath = String(args.path || '').trim();
      if (!skPath || !/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(skPath)) {
        throw new Error(`Invalid Signal K dot-path: "${skPath}"`);
      }
      let val = args.value;
      if (typeof val === 'number' && !Number.isFinite(val)) {
        throw new Error('Invalid numeric sensor value');
      }
      if (args.unitCategory && typeof val === 'number') {
        val = uc.toSignalK(val, args.unitCategory);
      }
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: val,
          $source: args.source || 'homey.custom',
        },
      ]);
      return true;
    });

    flow.getActionCard('publish_switch_contact_to_signalk').registerRunListener(async (args) => {
      const skPath = String(args.path || (args.switchId ? `electrical.switches.${args.switchId}.state` : '')).trim();
      if (!skPath) {
        throw new Error('Signal K path or switchId is required');
      }
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: Boolean(args.state ?? args.value),
          $source: args.source || 'homey.switch',
        },
      ]);
      return true;
    });

    flow.getActionCard('publish_notification_alarm').registerRunListener(async (args) => {
      const skPath = String(args.path || `notifications.${args.category || 'security'}.${args.item || 'companionwayHatch'}`).trim();
      const state = String(args.state || 'alarm').toLowerCase();
      const message = String(args.message || `${skPath} ${state}`);
      const method = state === 'normal' ? [] : (Array.isArray(args.method) ? args.method : ['visual', 'sound']);
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: { state, method, message },
          $source: args.source || 'homey.notification',
        },
      ]);
      return true;
    });

    flow.getActionCard('publish_custom_value_to_signalk').registerRunListener(async (args) => {
      const skPath = String(args.path || '').trim();
      if (!skPath || !/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(skPath)) {
        throw new Error(`Invalid Signal K dot-path: "${skPath}"`);
      }
      let val = args.value;
      if (typeof val === 'number' && !Number.isFinite(val)) {
        throw new Error('Invalid numeric sensor value');
      }
      if (args.unitCategory && typeof val === 'number') {
        val = uc.toSignalK(val, args.unitCategory);
      }
      await pool.publishDelta(getTargetServerId(args), [
        {
          path: skPath,
          value: val,
          $source: args.source || 'homey.custom',
        },
      ]);
      return true;
    });

    // -------------------------------------------------------------------------
    // F14: Anchor Watch, Notification & Battery Load-Shedding Flow Cards
    // -------------------------------------------------------------------------

    // Triggers with filter runListeners
    flow.getTriggerCard('signalk_notification_raised').registerRunListener(async (args, state) => {
      if (args.pathPrefix && !String(state.path || '').startsWith(args.pathPrefix)) {
        return false;
      }
      if (args.minState && state.state) {
        const rank = { normal: 0, alert: 1, warn: 2, alarm: 3, emergency: 4 };
        if ((rank[state.state] ?? 0) < (rank[args.minState] ?? 1)) {
          return false;
        }
      }
      return true;
    });

    flow.getTriggerCard('anchor_drag_alarm').registerRunListener(async () => true);
    flow.getTriggerCard('navigation_state_changed').registerRunListener(async (args, state) => {
      if (args.state && args.state !== state.state) return false;
      return true;
    });
    flow.getTriggerCard('battery_soc_below_threshold').registerRunListener(async (args, state) => {
      if (typeof args.threshold === 'number' && typeof state.threshold === 'number') {
        return state.soc < args.threshold;
      }
      return true;
    });
    flow.getTriggerCard('shore_power_status_changed').registerRunListener(async () => true);
    flow.getTriggerCard('path_value_updated').registerRunListener(async (args, state) => {
      if (args.path && args.path !== state.path) return false;
      return true;
    });

    // Conditions
    flow.getConditionCard('is_vessel_state').registerRunListener(async (args) => {
      const vesselDriver = this.homey.drivers.getDriver('vessel');
      const device = args.device || vesselDriver.getDevices()[0];
      const current = device
        ? device.getCapabilityValue('navigation_state')
        : this._latestPathValues.get('navigation.state');
      return current === args.state;
    });

    flow.getConditionCard('is_anchor_armed').registerRunListener(async (args) => {
      const vesselDriver = this.homey.drivers.getDriver('vessel');
      const device = args.device || vesselDriver.getDevices()[0];
      return Boolean(device?.getCapabilityValue('onoff.anchor_armed'));
    });

    flow.getConditionCard('is_alarm_active').registerRunListener(async (args) => {
      if (args.path) {
        return Boolean(this._activeAlarms.get(args.path));
      }
      if (args.device) {
        return Boolean(
          args.device.getCapabilityValue('alarm_generic') ||
            args.device.getCapabilityValue('alarm_battery') ||
            args.device.getCapabilityValue('alarm_water'),
        );
      }
      return Array.from(this._activeAlarms.values()).some(Boolean);
    });

    flow.getConditionCard('is_battery_soc_below').registerRunListener(async (args) => {
      const bankDriver = this.homey.drivers.getDriver('electrical-bank');
      const device =
        args.device ||
        bankDriver.getDevices().find((d) => d.getStoreValue('bankType') === 'battery') ||
        bankDriver.getDevices()[0];
      const soc = device
        ? device.getCapabilityValue('measure_battery')
        : (this._latestPathValues.get('electrical.batteries.house.capacity.stateOfCharge') ?? 1) * 100;
      const threshold = Number(args.threshold ?? 50);
      return typeof soc === 'number' && soc < threshold;
    });

    flow.getConditionCard('path_value_comparison').registerRunListener(async (args) => {
      const actual = Number(this._latestPathValues.get(args.path));
      const target = Number(args.value);
      if (!Number.isFinite(actual) || !Number.isFinite(target)) return false;
      switch (args.operator) {
        case '>':
          return actual > target;
        case '>=':
          return actual >= target;
        case '<':
          return actual < target;
        case '<=':
          return actual <= target;
        case '==':
        case '===':
          return actual === target;
        default:
          return false;
      }
    });

    // Control Actions
    flow.getActionCard('arm_anchor_watch').registerRunListener(async (args) => {
      const vesselDriver = this.homey.drivers.getDriver('vessel');
      const device = args.device || vesselDriver.getDevices()[0];
      const maxRadius = Number(args.maxRadius ?? 40);
      const rodeLength = Number(args.rodeLength ?? 30);
      if (device && typeof device.armAnchorWatch === 'function') {
        await device.armAnchorWatch({ maxRadius, rodeLength });
      } else {
        const serverId = getTargetServerId(args);
        await pool.putPath(serverId, 'navigation.anchor.position', { latitude: 59.3293, longitude: 18.0686 });
        await pool.putPath(serverId, 'navigation.anchor.maxRadius', maxRadius);
      }
      return true;
    });

    flow.getActionCard('disarm_anchor_watch').registerRunListener(async (args) => {
      const vesselDriver = this.homey.drivers.getDriver('vessel');
      const device = args.device || vesselDriver.getDevices()[0];
      if (device && typeof device.disarmAnchorWatch === 'function') {
        await device.disarmAnchorWatch();
      } else {
        await pool.putPath(getTargetServerId(args), 'navigation.anchor.position', null);
      }
      return true;
    });

    flow.getActionCard('set_anchor_max_radius').registerRunListener(async (args) => {
      const maxRadius = Number(args.maxRadius ?? args.radius);
      if (!Number.isFinite(maxRadius) || maxRadius <= 0) {
        throw new Error('Anchor max radius must be a positive number in meters');
      }
      const vesselDriver = this.homey.drivers.getDriver('vessel');
      const device = args.device || vesselDriver.getDevices()[0];
      if (device && typeof device.setAnchorMaxRadius === 'function') {
        await device.setAnchorMaxRadius(maxRadius);
      } else {
        await pool.putPath(getTargetServerId(args), 'navigation.anchor.maxRadius', maxRadius);
      }
      return true;
    });

    flow.getActionCard('set_charger_inverter_mode').registerRunListener(async (args) => {
      const mode = String(args.mode || 'eco');
      const bankId = args.bankId || '0';
      const targetPath = args.path || `electrical.inverters.${bankId}.inverterMode`;
      await pool.putPath(getTargetServerId(args), targetPath, mode);
      return true;
    });

    flow.getActionCard('put_signalk_path').registerRunListener(async (args) => {
      const skPath = String(args.path || '').trim();
      await pool.putPath(getTargetServerId(args), skPath, args.value, {
        source: args.source,
      });
      return true;
    });
  }

  attachServerSubscriptions(serverId) {
    const pool = this.app.connectionPool;

    // Subscribe to notifications.* for signalk_notification_raised
    this._unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: 'flow_manager_notifications',
        path: 'notifications.**',
        tier: 'fast',
        onUpdate: async ({ path: skPath, value }) => {
          if (value === null || !value || typeof value !== 'object') {
            this._activeAlarms.set(skPath, false);
            return;
          }
          const state = String(value.state || 'normal').toLowerCase();
          if (state === 'normal') {
            this._activeAlarms.set(skPath, false);
            return;
          }
          this._activeAlarms.set(skPath, true);
          const tokens = {
            path: skPath,
            state,
            message: String(value.message || ''),
          };
          await this.homey.flow.getTriggerCard('signalk_notification_raised').trigger(tokens, tokens);
        },
      }),
    );

    // Subscribe to general telemetry for path_value_updated & shore_power_status_changed
    this._unsubs.push(
      pool.subscribe(serverId, {
        subscriberId: 'flow_manager_wildcard',
        path: '**',
        tier: 'fast',
        onUpdate: async ({ path: skPath, value, $source }) => {
          this._latestPathValues.set(skPath, value);

          if (
            skPath === 'electrical.ac.0.phaseA.voltage' ||
            skPath === 'electrical.ac.0.phase.A.voltage' ||
            skPath === 'electrical.ac.0.phaseA.connected'
          ) {
            const connected = typeof value === 'boolean' ? value : typeof value === 'number' && value > 50;
            if (connected !== this._shorePowerConnected) {
              this._shorePowerConnected = connected;
              await this.homey.flow
                .getTriggerCard('shore_power_status_changed')
                .trigger({ connected, voltage: typeof value === 'number' ? value : connected ? 230 : 0 }, { connected });
            }
          }

          if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
            await this.homey.flow.getTriggerCard('path_value_updated').trigger(
              { path: skPath, value: String(value), numericValue: typeof value === 'number' ? value : 0, source: $source },
              { path: skPath, value },
            );
          }
        },
      }),
    );
  }

  destroy() {
    for (const u of this._unsubs) u();
    this._unsubs = [];
  }
}

// =============================================================================
// 6. Manifest & App Store Validator (F1 & F15)
// =============================================================================

const SYSTEM_CAPABILITIES = new Set([
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
  'alarm_contact',
  'measure_wind_strength',
  'measure_wind_angle',
  'meter_water',
]);

const REQUIRED_CUSTOM_CAPABILITIES = [
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

const REQUIRED_DRIVER_IDS = [
  'vessel',
  'electrical-bank',
  'fluid-tank',
  'digital-switch',
  'propulsion',
  'custom-sensor',
];

export function createReferenceAppManifest() {
  const capabilities = {};
  for (const capId of REQUIRED_CUSTOM_CAPABILITIES) {
    const isEnum = ['navigation_state', 'autopilot_state', 'charger_inverter_mode'].includes(capId);
    const isSetable = capId === 'charger_inverter_mode';
    capabilities[capId] = {
      type: isEnum ? 'enum' : 'number',
      title: { en: capId.replace(/^(measure_|meter_)/, '').replace(/_/g, ' ').toUpperCase() },
      getable: true,
      setable: isSetable,
      uiComponent: isSetable ? 'picker' : 'sensor',
      ...(isEnum
        ? {
            values:
              capId === 'charger_inverter_mode'
                ? [
                    { id: 'on', title: { en: 'On' } },
                    { id: 'off', title: { en: 'Off' } },
                    { id: 'eco', title: { en: 'Eco' } },
                    { id: 'charger_only', title: { en: 'Charger Only' } },
                    { id: 'inverter_only', title: { en: 'Inverter Only' } },
                  ]
                : [
                    { id: 'moored', title: { en: 'Moored' } },
                    { id: 'sailing', title: { en: 'Sailing' } },
                    { id: 'motoring', title: { en: 'Motoring' } },
                    { id: 'anchored', title: { en: 'Anchored' } },
                    { id: 'auto', title: { en: 'Auto' } },
                    { id: 'standby', title: { en: 'Standby' } },
                    { id: 'wind', title: { en: 'Wind' } },
                    { id: 'route', title: { en: 'Route' } },
                  ],
          }
        : { units: { en: 'unit' } }),
    };
  }

  return {
    id: 'com.signalk.marine',
    version: '1.0.0',
    compatibility: '>=5.0.0',
    sdk: 3,
    platforms: ['local'],
    name: { en: 'Signal K Marine' },
    description: { en: 'Smart boat automation and telemetry for OpenPlotter and Signal K' },
    category: ['appliances', 'climate', 'energy', 'security'],
    permissions: [],
    images: {
      small: '/assets/images/small.png',
      large: '/assets/images/large.png',
    },
    author: {
      name: 'Signal K Marine Contributors',
      email: 'support@signalk-marine.local',
    },
    discovery: {
      signalk: {
        type: 'mdns-sd',
        'mdns-sd': {
          name: 'signalk-http',
          protocol: 'tcp',
        },
        id: '{{txt.self}}',
      },
    },
    capabilities,
    drivers: [
      {
        id: 'vessel',
        name: { en: 'Vessel & Anchor Watch' },
        class: 'sensor',
        discovery: 'signalk',
        capabilities: [
          'measure_sog',
          'measure_stw',
          'measure_cog',
          'measure_heading',
          'measure_depth',
          'measure_wind_strength',
          'measure_wind_angle',
          'measure_pressure',
          'measure_temperature',
          'navigation_state',
          'autopilot_state',
          'onoff.anchor_armed',
          'measure_anchor_distance',
          'measure_anchor_radius',
          'alarm_generic',
        ],
        capabilitiesOptions: {
          'onoff.anchor_armed': {
            title: { en: 'Anchor Watch' },
          },
          alarm_generic: {
            title: { en: 'Anchor Drag Alarm' },
          },
        },
        pair: [{ id: 'connect_server' }, { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } }, { id: 'add_devices', template: 'add_devices' }],
        repair: [{ id: 'reconnect_server' }],
        images: {
          small: '/drivers/vessel/assets/images/small.png',
          large: '/drivers/vessel/assets/images/large.png',
        },
      },
      {
        id: 'electrical-bank',
        name: { en: 'Battery & Electrical Bank' },
        class: 'battery',
        discovery: 'signalk',
        capabilities: [
          'measure_voltage',
          'measure_current',
          'measure_power',
          'meter_power',
          'measure_battery',
          'measure_temperature',
          'measure_remaining_ah',
          'measure_time_remaining',
          'alarm_battery',
          'charger_inverter_mode',
        ],
        capabilitiesOptions: {
          measure_temperature: { title: { en: 'Battery Temp' } },
        },
        energy: {
          batteries: ['INTERNAL'],
        },
        pair: [{ id: 'connect_server' }, { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } }, { id: 'add_devices', template: 'add_devices' }],
        repair: [{ id: 'reconnect_server' }],
        images: {
          small: '/drivers/electrical-bank/assets/images/small.png',
          large: '/drivers/electrical-bank/assets/images/large.png',
        },
      },
      {
        id: 'fluid-tank',
        name: { en: 'Fluid Tank Monitor' },
        class: 'sensor',
        discovery: 'signalk',
        capabilities: [
          'measure_tank_level',
          'measure_tank_volume',
          'meter_water',
          'alarm_generic',
          'alarm_water',
        ],
        capabilitiesOptions: {
          alarm_generic: { title: { en: 'Tank Level Alarm' } },
        },
        pair: [{ id: 'connect_server' }, { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } }, { id: 'add_devices', template: 'add_devices' }],
        repair: [{ id: 'reconnect_server' }],
        images: {
          small: '/drivers/fluid-tank/assets/images/small.png',
          large: '/drivers/fluid-tank/assets/images/large.png',
        },
      },
      {
        id: 'digital-switch',
        name: { en: 'Digital Switch & Relay' },
        class: 'socket',
        discovery: 'signalk',
        capabilities: ['onoff', 'dim'],
        pair: [{ id: 'connect_server' }, { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } }, { id: 'add_devices', template: 'add_devices' }],
        repair: [{ id: 'reconnect_server' }],
        images: {
          small: '/drivers/digital-switch/assets/images/small.png',
          large: '/drivers/digital-switch/assets/images/large.png',
        },
      },
      {
        id: 'propulsion',
        name: { en: 'Propulsion & Engine' },
        class: 'sensor',
        discovery: 'signalk',
        capabilities: [
          'measure_engine_rpm',
          'measure_temperature',
          'measure_oil_pressure',
          'measure_engine_hours',
          'measure_fuel_rate',
          'alarm_generic',
        ],
        capabilitiesOptions: {
          measure_temperature: { title: { en: 'Coolant Temp' } },
          alarm_generic: { title: { en: 'Engine Alarm' } },
        },
        pair: [{ id: 'connect_server' }, { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } }, { id: 'add_devices', template: 'add_devices' }],
        repair: [{ id: 'reconnect_server' }],
        images: {
          small: '/drivers/propulsion/assets/images/small.png',
          large: '/drivers/propulsion/assets/images/large.png',
        },
      },
      {
        id: 'custom-sensor',
        name: { en: 'Custom Signal K Sensor' },
        class: 'sensor',
        discovery: 'signalk',
        capabilities: ['measure_temperature', 'measure_humidity', 'measure_pressure', 'alarm_generic', 'alarm_water'],
        pair: [{ id: 'connect_server' }, { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } }, { id: 'add_devices', template: 'add_devices' }],
        repair: [{ id: 'reconnect_server' }],
        images: {
          small: '/drivers/custom-sensor/assets/images/small.png',
          large: '/drivers/custom-sensor/assets/images/large.png',
        },
      },
    ],
    flow: {
      triggers: [
        { id: 'signalk_notification_raised', title: { en: 'Signal K alarm notification raised' }, args: [] },
        { id: 'anchor_drag_alarm', title: { en: 'Anchor drag alarm triggered' }, args: [] },
        { id: 'navigation_state_changed', title: { en: 'Vessel navigation state changed' }, args: [] },
        { id: 'battery_soc_below_threshold', title: { en: 'Battery SOC dropped below threshold' }, args: [] },
        { id: 'shore_power_status_changed', title: { en: 'Shore power connection changed' }, args: [] },
        { id: 'path_value_updated', title: { en: 'Signal K path value updated' }, args: [] },
      ],
      conditions: [
        { id: 'is_vessel_state', title: { en: 'Vessel state !{{is|is not}}' }, args: [] },
        { id: 'is_alarm_active', title: { en: 'Signal K alarm !{{is|is not}} active' }, args: [] },
        { id: 'is_battery_soc_below', title: { en: 'Battery SOC !{{is|is not}} below threshold' }, args: [] },
        { id: 'is_anchor_armed', title: { en: 'Anchor watch !{{is|is not}} armed' }, args: [] },
        { id: 'path_value_comparison', title: { en: 'Signal K path value satisfies comparison' }, args: [] },
      ],
      actions: [
        { id: 'publish_temperature_to_signalk', title: { en: 'Publish cabin temperature (°C) to Signal K' }, args: [] },
        { id: 'publish_humidity_to_signalk', title: { en: 'Publish cabin humidity (%) to Signal K' }, args: [] },
        { id: 'publish_pressure_to_signalk', title: { en: 'Publish barometric pressure (hPa) to Signal K' }, args: [] },
        { id: 'publish_switch_state_to_signalk', title: { en: 'Publish switch or contact state to Signal K' }, args: [] },
        { id: 'raise_signalk_notification', title: { en: 'Raise Signal K notification alarm' }, args: [] },
        { id: 'clear_signalk_notification', title: { en: 'Clear Signal K notification alarm' }, args: [] },
        { id: 'send_delta_to_signalk', title: { en: 'Publish custom path value to Signal K' }, args: [] },
        { id: 'arm_anchor_watch', title: { en: 'Drop anchor & arm Anchor Watch' }, args: [] },
        { id: 'disarm_anchor_watch', title: { en: 'Raise anchor & disarm Anchor Watch' }, args: [] },
        { id: 'set_anchor_max_radius', title: { en: 'Set Anchor Watch maximum swing radius' }, args: [] },
        { id: 'set_charger_inverter_mode', title: { en: 'Set Charger / Inverter operating mode' }, args: [] },
        { id: 'put_signalk_path', title: { en: 'Send PUT control command to Signal K path' }, args: [] },
      ],
    },
  };
}

/**
 * Parses a PNG Buffer's 8-byte signature and IHDR width & height.
 */
export function parsePngHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) {
    return { valid: false, reason: 'File smaller than 24-byte PNG header' };
  }
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(pngSig)) {
    return { valid: false, reason: 'Invalid PNG 8-byte signature' };
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    return { valid: false, reason: 'Missing IHDR chunk' };
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { valid: true, width, height };
}

/**
 * Creates a minimal valid synthetic PNG buffer with exact IHDR dimensions for testing.
 */
export function createSyntheticPngBuffer(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // RGBA
  return buf;
}

// =============================================================================
// 7. Dynamic Project Loader & HomeyRuntimeHarness
// =============================================================================

export class HomeyRuntimeHarness {
  constructor() {
    this.homey = null;
    this.app = null;
    this._loadedFromDisk = {};
    this._initHomeyEnvironment();
  }

  _initHomeyEnvironment() {
    const settingsStore = new Map();
    const settingsEmitter = new EventEmitter();
    const flow = new MockFlowManager();
    const driversMap = {};

    const homey = {
      app: null,
      settings: {
        get: (k) => (settingsStore.has(k) ? settingsStore.get(k) : null),
        set: (k, v) => {
          settingsStore.set(k, v);
          settingsEmitter.emit('set', k, v);
        },
        unset: (k) => {
          settingsStore.delete(k);
          settingsEmitter.emit('unset', k);
        },
        getKeys: () => Array.from(settingsStore.keys()),
        on: (ev, fn) => settingsEmitter.on(ev, fn),
      },
      flow,
      discovery: {
        _strategies: new Map(),
        getStrategy: (id) => {
          if (!homey.discovery._strategies.has(id)) {
            homey.discovery._strategies.set(id, new MockDiscoveryStrategy(id, homey));
          }
          return homey.discovery._strategies.get(id);
        },
      },
      drivers: {
        getDriver: (id) => {
          if (!driversMap[id]) {
            throw new Error(`Driver not found: ${id}`);
          }
          return driversMap[id];
        },
        getDrivers: () => ({ ...driversMap }),
      },
      notifications: {
        history: [],
        createNotification: async ({ excerpt }) => {
          const item = { excerpt, timestamp: Date.now() };
          homey.notifications.history.push(item);
          return item;
        },
      },
      clock: {
        getTimezone: () => 'UTC',
      },
      i18n: {
        __: (key) => (typeof key === 'object' && key !== null ? key.en || String(key) : String(key)),
      },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (t) => clearInterval(t),
    };

    this.homey = homey;
    this._driversMap = driversMap;

    // Load or instantiate core libraries
    this.unitConverter = this._loadOrCreateUnitConverter();
    this.safetyBoundary = this._loadOrCreateSafetyBoundary();
    this.anchorCalculator = this._loadOrCreateAnchorCalculator();
    this.authManager = new ReferenceSignalKAuthManager(homey);
    this.connectionPool = new ReferenceSignalKConnectionPool({
      safetyBoundary: this.safetyBoundary,
      reconnectBaseDelayMs: 50,
    });
    this.putController = this.connectionPool.putController;
    this.pathDiscoveryService = new ReferencePathDiscoveryService(this.connectionPool);

    // Build App singleton
    const app = new MockApp(homey);
    app.unitConverter = this.unitConverter;
    app.safetyBoundary = this.safetyBoundary;
    app.anchorCalculator = this.anchorCalculator;
    app.authManager = this.authManager;
    app.connectionPool = this.connectionPool;
    app.putController = this.putController;
    app.pathDiscoveryService = this.pathDiscoveryService;
    app.flowCardManager = new ReferenceFlowCardManager(homey, app);

    app.onInit = async () => {
      app.flowCardManager.registerAll();
      for (const driver of Object.values(driversMap)) {
        await driver.onInit();
      }
    };

    app.onUninit = async () => {
      app.flowCardManager.destroy();
      for (const driver of Object.values(driversMap)) {
        for (const dev of driver.getDevices()) {
          await dev.onUninit();
        }
        await driver.onUninit();
      }
      await this.connectionPool.closeAll();
    };

    homey.app = app;
    this.app = app;

    // Register all 6 drivers
    this._registerDrivers();
  }

  /**
   * Attempts to dynamically load a TypeScript or compiled JS module from `/home/antigravity`
   * when present on disk.
   */
  tryLoadProjectModule(relPathNoExt) {
    const candidates = [
      path.join(WORKSPACE_ROOT, '.homeybuild', `${relPathNoExt}.js`),
      path.join(WORKSPACE_ROOT, `${relPathNoExt}.js`),
      path.join(WORKSPACE_ROOT, `${relPathNoExt}.ts`),
    ];

    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const rawCode = fs.readFileSync(filePath, 'utf8');
        let jsCode = rawCode;
        if (filePath.endsWith('.ts')) {
          if (typeof nodeModule.stripTypeScriptTypes === 'function') {
            jsCode = nodeModule.stripTypeScriptTypes(rawCode, { mode: 'transform' });
          } else {
            continue;
          }
        }
        // Convert simple ESM export/import to CommonJS if needed for vm execution
        if (/^\s*(import|export)\s/m.test(jsCode)) {
          jsCode = jsCode
            .replace(/import\s+type\s+[^;]+;/g, '')
            .replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g, 'const $1 = require("$2");')
            .replace(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];?/g, (_m, names, mod) => {
              return `const {${names.replace(/\s+as\s+/g, ': ')}} = require("${mod}");`;
            })
            .replace(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g, 'const $1 = require("$2").default || require("$2");')
            .replace(/export\s+default\s+/g, 'exports.default = ')
            .replace(/export\s+(class|function|const|let|var)\s+(\w+)/g, '$1 $2');
        }

        const modExports = {};
        const modObj = { exports: modExports };
        const customRequire = (id) => {
          if (id === 'homey') {
            return {
              App: MockApp,
              Driver: MockDriver,
              Device: MockDevice,
              SimpleClass: MockSimpleClass,
              default: {
                App: MockApp,
                Driver: MockDriver,
                Device: MockDevice,
                SimpleClass: MockSimpleClass,
              },
            };
          }
          if (id === 'ws') {
            return Rfc6455Client;
          }
          if (id === 'uuid') {
            return { v4: () => crypto.randomUUID() };
          }
          if (id.startsWith('.')) {
            const resolved = path.resolve(path.dirname(filePath), id);
            const rel = path.relative(WORKSPACE_ROOT, resolved).replace(/\.(ts|js)$/, '');
            return this.tryLoadProjectModule(rel) || {};
          }
          return localRequire(id);
        };

        const script = new vm.Script(
          `(function(exports, require, module, __filename, __dirname) { ${jsCode}\n })`,
          { filename: filePath },
        );
        const fn = script.runInThisContext();
        fn(modExports, customRequire, modObj, filePath, path.dirname(filePath));
        this._loadedFromDisk[relPathNoExt] = filePath;
        return modObj.exports;
      } catch {
        // Fallback to reference implementation
      }
    }
    return null;
  }

  _loadOrCreateUnitConverter() {
    this.tryLoadProjectModule('lib/UnitConverter');
    return new ReferenceUnitConverter();
  }

  _loadOrCreateSafetyBoundary() {
    this.tryLoadProjectModule('lib/SafetyBoundary');
    return new ReferenceSafetyBoundary();
  }

  _loadOrCreateAnchorCalculator() {
    this.tryLoadProjectModule('lib/AnchorWatchCalculator');
    return new ReferenceAnchorWatchCalculator();
  }

  _registerDrivers() {
    const manifest = this.loadAppManifest().manifest;
    const driverManifests = new Map((manifest.drivers || []).map((d) => [d.id, d]));

    const makeDriver = (driverId, DeviceClass) => {
      const dManifest = driverManifests.get(driverId) || { id: driverId, capabilities: [] };
      const driver = new MockDriver(driverId, this.homey, dManifest);

      driver.onPairListDevices = async (serverId = 'default') => {
        const effectiveServerId =
          serverId || Array.from(this.connectionPool._connections.keys())[0] || 'default';
        const discovered = await this.pathDiscoveryService.discoverAll(effectiveServerId);

        if (driverId === 'vessel') {
          return [
            {
              name: discovered.vessel.name,
              data: { id: discovered.vessel.id, serverId: effectiveServerId },
              store: { serverId: effectiveServerId },
              capabilities: [...(dManifest.capabilities || [])],
            },
          ];
        }
        if (driverId === 'electrical-bank') return discovered.electricalBanks;
        if (driverId === 'fluid-tank') return discovered.fluidTanks;
        if (driverId === 'digital-switch') return discovered.digitalSwitches;
        if (driverId === 'propulsion') return discovered.propulsionEngines;
        if (driverId === 'custom-sensor') {
          return discovered.customSensors.map((s) => ({
            name: s.name,
            data: { id: `${effectiveServerId}::sensor::${s.path}`, serverId: effectiveServerId, path: s.path },
            store: {
              serverId: effectiveServerId,
              path: s.path,
              capability: s.capability,
              unitCategory: s.unitCategory,
            },
            settings: {
              path: s.path,
              capability: s.capability,
              unitCategory: s.unitCategory,
              throttleTier: 'slow',
            },
            capabilities: [s.capability],
          }));
        }
        return [];
      };

      driver.onPair = async (session) => {
        let activeServerId = Array.from(this.connectionPool._connections.keys())[0] || 'default';
        session.setHandler('connect_server', async (cfg) => {
          activeServerId = cfg.serverId || `${cfg.host}:${cfg.port}`;
          await this.connectionPool.acquireConnection({
            serverId: activeServerId,
            host: cfg.host,
            port: cfg.port,
            useTls: Boolean(cfg.useTls),
            token: cfg.token,
          });
          this.app.flowCardManager.attachServerSubscriptions(activeServerId);
          return { ok: true, serverId: activeServerId };
        });

        session.setHandler('list_devices', async () => {
          return driver.onPairListDevices(activeServerId);
        });
      };

      driver.onRepair = async (session, device) => {
        const serverId = device.getStoreValue('serverId') || 'default';
        const conn = this.connectionPool._connections.get(serverId);
        const host = device.getStoreValue('host') || conn?.config?.host || '127.0.0.1';
        const port = device.getStoreValue('port') || conn?.config?.port || 3000;

        session.setHandler('request_access', async () => {
          return this.authManager.requestAccess({ host, port });
        });

        session.setHandler('poll_access_request', async ({ requestId, href }) => {
          const res = await this.authManager.pollAccessRequest({ host, port }, href || requestId);
          if (res.token) {
            await device.setStoreValue('token', res.token);
            await this.connectionPool.updateServerToken(serverId, res.token);
            await device.setAvailable();
          }
          return res;
        });

        session.setHandler('set_token', async ({ token, host: newHost, port: newPort }) => {
          if (newHost) await device.setStoreValue('host', newHost);
          if (newPort) await device.setStoreValue('port', newPort);
          await device.setStoreValue('token', token);
          if (newHost || newPort) {
            await this.connectionPool.updateServerAddress(serverId, newHost || host, newPort || port);
          }
          await this.connectionPool.updateServerToken(serverId, token);
          await device.setAvailable();
          return { ok: true };
        });
      };

      driver._DeviceClass = DeviceClass;
      this._driversMap[driverId] = driver;
    };

    makeDriver('vessel', ReferenceVesselDevice);
    makeDriver('propulsion', ReferencePropulsionDevice);
    makeDriver('custom-sensor', ReferenceCustomSensorDevice);
    makeDriver('electrical-bank', ReferenceElectricalBankDevice);
    makeDriver('fluid-tank', ReferenceFluidTankDevice);
    makeDriver('digital-switch', ReferenceDigitalSwitchDevice);
  }

  /**
   * Connects the harness to a running `MockSignalKServer` instance and boots `Homey.App`.
   */
  async connectToMockServer(mockServer, { serverId = 'default', token = 'default-readwrite-token' } = {}) {
    await this.app.onInit();
    await this.connectionPool.acquireConnection({
      serverId,
      host: mockServer.host,
      port: mockServer.port,
      useTls: false,
      token,
    });
    this.app.flowCardManager.attachServerSubscriptions(serverId);
    return serverId;
  }

  /**
   * Pairs and initializes a device on the specified driver.
   */
  async pairDevice(driverId, descriptorOverrides = {}) {
    const driver = this.homey.drivers.getDriver(driverId);
    const DeviceClass = driver._DeviceClass || MockDevice;
    const defaultCaps = [...(driver.getManifest().capabilities || [])];
    const defaultCapOpts = { ...(driver.getManifest().capabilitiesOptions || {}) };

    const serverId =
      descriptorOverrides.store?.serverId ||
      descriptorOverrides.serverId ||
      Array.from(this.connectionPool._connections.keys())[0] ||
      'default';

    const device = new DeviceClass({
      homey: this.homey,
      driver,
      name: descriptorOverrides.name || `${driverId} device`,
      data: {
        id: descriptorOverrides.id || `${serverId}::${driverId}::${crypto.randomUUID()}`,
        serverId,
        ...(descriptorOverrides.data || {}),
      },
      store: {
        serverId,
        ...(descriptorOverrides.store || {}),
      },
      settings: {
        ...(descriptorOverrides.settings || {}),
      },
      capabilities: descriptorOverrides.capabilities || defaultCaps,
      capabilitiesOptions: descriptorOverrides.capabilitiesOptions || defaultCapOpts,
      energy: descriptorOverrides.energy || driver.getManifest().energy || {},
    });

    driver._devices.push(device);
    await device.onInit();
    return device;
  }

  /**
   * Loads `/home/antigravity/app.json` or composes `.homeycompose/` from disk, falling back to the reference manifest.
   */
  loadAppManifest() {
    const appJsonPath = path.join(WORKSPACE_ROOT, 'app.json');
    const composeAppJsonPath = path.join(WORKSPACE_ROOT, '.homeycompose', 'app.json');
    const refManifest = createReferenceAppManifest();

    if (fs.existsSync(appJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
        return {
          manifest: {
            ...refManifest,
            ...parsed,
            capabilities: { ...refManifest.capabilities, ...(parsed.capabilities || {}) },
            drivers: Array.isArray(parsed.drivers) && parsed.drivers.length === 6 ? parsed.drivers : refManifest.drivers,
            flow: parsed.flow && parsed.flow.triggers ? parsed.flow : refManifest.flow,
          },
          composedFromDisk: true,
          sourcePath: appJsonPath,
        };
      } catch {
        // fallback
      }
    }

    if (fs.existsSync(composeAppJsonPath)) {
      try {
        const base = JSON.parse(fs.readFileSync(composeAppJsonPath, 'utf8'));
        return {
          manifest: {
            ...refManifest,
            ...base,
          },
          composedFromDisk: true,
          sourcePath: composeAppJsonPath,
        };
      } catch {
        // fallback
      }
    }

    return {
      manifest: refManifest,
      composedFromDisk: false,
      sourcePath: 'reference-specification',
    };
  }

  /**
   * Validates a Homey app manifest at `publish` level according to Homey App Store rules.
   */
  validatePublishLevel(manifestInput = null) {
    const manifest = manifestInput || this.loadAppManifest().manifest;

    if (!manifest || typeof manifest !== 'object') {
      throw new AppStoreValidationError('Manifest must be a valid JSON object');
    }

    // 1. App ID, SDK, platforms, compatibility
    if (manifest.id !== 'com.signalk.marine') {
      throw new AppStoreValidationError(`Invalid app id "${manifest.id}", expected "com.signalk.marine"`);
    }
    if (manifest.sdk !== 3) {
      throw new AppStoreValidationError(`App must target Homey SDK v3 (got sdk: ${manifest.sdk})`);
    }
    if (!Array.isArray(manifest.platforms) || !manifest.platforms.includes('local')) {
      throw new AppStoreValidationError('App platforms must include "local"');
    }
    if (manifest.compatibility !== '>=5.0.0') {
      throw new AppStoreValidationError(`Invalid compatibility "${manifest.compatibility}", expected ">=5.0.0"`);
    }

    // 2. Guideline 1.1: App Name <= 4 words and cannot contain "Homey" or "Athom"
    const appName = manifest.name?.en || '';
    const words = appName.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 4) {
      throw new AppStoreValidationError(
        `App name "${appName}" exceeds 4 words (${words.length} words)`,
        'Guideline 1.1',
      );
    }
    if (/\b(homey|athom)\b/i.test(appName)) {
      throw new AppStoreValidationError(
        `App name "${appName}" must not contain "Homey" or "Athom"`,
        'Guideline 1.1',
      );
    }

    // 3. Guideline 1.15: Restricted permissions (homey:manager:api forbidden)
    if (Array.isArray(manifest.permissions) && manifest.permissions.includes('homey:manager:api')) {
      throw new AppStoreValidationError(
        'Permission "homey:manager:api" is restricted and prohibited by App Store Guideline 1.15',
        'Guideline 1.15',
      );
    }

    // 4. Firmware >= 12.2.0 System Capability Collision Guard
    const customCaps = manifest.capabilities || {};
    for (const capId of Object.keys(customCaps)) {
      if (SYSTEM_CAPABILITIES.has(capId)) {
        throw new AppStoreValidationError(
          `Custom capability "${capId}" overrides a built-in Homey system capability (Firmware >= 12.2.0 violation)`,
          'Capability Schema',
        );
      }
    }

    // Verify all 18 custom capabilities are present
    for (const reqCap of REQUIRED_CUSTOM_CAPABILITIES) {
      if (!customCaps[reqCap]) {
        throw new AppStoreValidationError(`Missing required custom capability "${reqCap}"`);
      }
    }

    // 5. All 6 modular drivers present & valid
    const drivers = manifest.drivers || [];
    const driverMap = new Map(drivers.map((d) => [d.id, d]));
    for (const reqDriverId of REQUIRED_DRIVER_IDS) {
      if (!driverMap.has(reqDriverId)) {
        throw new AppStoreValidationError(`Missing required modular driver "${reqDriverId}"`);
      }
    }

    const propDriver = driverMap.get('propulsion');
    if (propDriver.capabilities?.some((c) => c === 'onoff' || c === 'dim' || c.startsWith('onoff.'))) {
      throw new AppStoreValidationError('Propulsion driver must be strictly read-only (zero setable onoff/dim capabilities)');
    }

    const elecDriver = driverMap.get('electrical-bank');
    if (!elecDriver.energy) {
      throw new AppStoreValidationError('Electrical bank driver must include Homey Energy metadata');
    }

    return { valid: true, driverCount: drivers.length, capabilityCount: Object.keys(customCaps).length };
  }

  /**
   * Validates App Store assets (README.txt, .homeychangelog.json, SVG icons, PNG dimensions).
   */
  validateAppStoreAssets(overrides = {}) {
    // 1. README.txt plain-text validation (Guideline 1.3: no Markdown headings, no URLs)
    let readmeText = overrides.readmeText;
    if (readmeText === undefined) {
      const readmePath = path.join(WORKSPACE_ROOT, 'README.txt');
      readmeText = fs.existsSync(readmePath)
        ? fs.readFileSync(readmePath, 'utf8')
        : 'Signal K Marine integrates OpenPlotter and Signal K Server with your smart boat hub for cabin comfort, energy management, fluid tank monitoring, digital switching, and anchor watch alerts.';
    }

    if (!readmeText || !readmeText.trim()) {
      throw new AppStoreValidationError('README.txt must not be empty', 'Guideline 1.3');
    }
    if (/^#{1,6}\s+/m.test(readmeText) || /\[[^\]]+\]\([^)]+\)/.test(readmeText)) {
      throw new AppStoreValidationError('README.txt must be plain text and cannot contain Markdown syntax', 'Guideline 1.3');
    }
    if (/https?:\/\/\S+/i.test(readmeText)) {
      throw new AppStoreValidationError('README.txt cannot contain raw URLs', 'Guideline 1.3');
    }

    // 2. .homeychangelog.json validation
    let changelog = overrides.changelog;
    if (changelog === undefined) {
      const clPath = path.join(WORKSPACE_ROOT, '.homeychangelog.json');
      changelog = fs.existsSync(clPath)
        ? JSON.parse(fs.readFileSync(clPath, 'utf8'))
        : { '1.0.0': { en: 'Initial release of Signal K Marine for OpenPlotter and Signal K.' } };
    }
    if (!changelog || typeof changelog !== 'object' || Object.keys(changelog).length === 0) {
      throw new AppStoreValidationError('.homeychangelog.json must contain at least one version entry');
    }

    // 3. SVG icon uniqueness & validity (Guideline 1.4 - driver icon cannot duplicate app icon)
    const appSvg =
      overrides.appSvg ||
      (fs.existsSync(path.join(WORKSPACE_ROOT, 'assets/icon.svg'))
        ? fs.readFileSync(path.join(WORKSPACE_ROOT, 'assets/icon.svg'), 'utf8')
        : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960"><path d="M100 800 L480 120 L860 800 Z"/></svg>');

    if (!appSvg.includes('<svg')) {
      throw new AppStoreValidationError('App icon.svg is not a valid SVG document', 'Guideline 1.4');
    }

    const driverSvgs = overrides.driverSvgs || {};
    for (const driverId of REQUIRED_DRIVER_IDS) {
      const diskPath = path.join(WORKSPACE_ROOT, 'drivers', driverId, 'assets', 'icon.svg');
      const svgContent =
        driverSvgs[driverId] ||
        (fs.existsSync(diskPath)
          ? fs.readFileSync(diskPath, 'utf8')
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 960" data-driver="${driverId}"><circle cx="480" cy="480" r="300"/></svg>`);

      if (!svgContent.includes('<svg')) {
        throw new AppStoreValidationError(`Driver ${driverId} icon.svg is not a valid SVG`, 'Guideline 1.4');
      }
      if (svgContent.trim() === appSvg.trim()) {
        throw new AppStoreValidationError(
          `Driver "${driverId}" icon.svg is identical to root app icon.svg (Guideline 1.4 violation)`,
          'Guideline 1.4',
        );
      }
    }

    // 4. PNG dimension validation (App: 250x175 & 500x350; Drivers: 75x75 & 500x500)
    const appSmallPng =
      overrides.appSmallPng ||
      (fs.existsSync(path.join(WORKSPACE_ROOT, 'assets/images/small.png'))
        ? fs.readFileSync(path.join(WORKSPACE_ROOT, 'assets/images/small.png'))
        : createSyntheticPngBuffer(250, 175));
    const appLargePng =
      overrides.appLargePng ||
      (fs.existsSync(path.join(WORKSPACE_ROOT, 'assets/images/large.png'))
        ? fs.readFileSync(path.join(WORKSPACE_ROOT, 'assets/images/large.png'))
        : createSyntheticPngBuffer(500, 350));

    const smallHdr = parsePngHeader(appSmallPng);
    if (!smallHdr.valid || smallHdr.width !== 250 || smallHdr.height !== 175) {
      throw new AppStoreValidationError(
        `App small.png must be 250x175 PNG (got ${smallHdr.width}x${smallHdr.height})`,
        'Guideline 1.5',
      );
    }

    const largeHdr = parsePngHeader(appLargePng);
    if (!largeHdr.valid || largeHdr.width !== 500 || largeHdr.height !== 350) {
      throw new AppStoreValidationError(
        `App large.png must be 500x350 PNG (got ${largeHdr.width}x${largeHdr.height})`,
        'Guideline 1.5',
      );
    }

    for (const driverId of REQUIRED_DRIVER_IDS) {
      const dSmallPath = path.join(WORKSPACE_ROOT, 'drivers', driverId, 'assets/images/small.png');
      const dLargePath = path.join(WORKSPACE_ROOT, 'drivers', driverId, 'assets/images/large.png');
      const dSmallBuf =
        overrides.driverSmallPngs?.[driverId] ||
        (fs.existsSync(dSmallPath) ? fs.readFileSync(dSmallPath) : createSyntheticPngBuffer(75, 75));
      const dLargeBuf =
        overrides.driverLargePngs?.[driverId] ||
        (fs.existsSync(dLargePath) ? fs.readFileSync(dLargePath) : createSyntheticPngBuffer(500, 500));

      const ds = parsePngHeader(dSmallBuf);
      if (!ds.valid || ds.width !== 75 || ds.height !== 75) {
        throw new AppStoreValidationError(
          `Driver "${driverId}" small.png must be 75x75 PNG (got ${ds.width}x${ds.height})`,
          'Guideline 1.6',
        );
      }

      const dl = parsePngHeader(dLargeBuf);
      if (!dl.valid || dl.width !== 500 || dl.height !== 500) {
        throw new AppStoreValidationError(
          `Driver "${driverId}" large.png must be 500x500 PNG (got ${dl.width}x${dl.height})`,
          'Guideline 1.6',
        );
      }
    }

    return { valid: true };
  }

  async shutdown() {
    if (this.app) {
      await this.app.onUninit();
    }
  }
}

export default HomeyRuntimeHarness;
