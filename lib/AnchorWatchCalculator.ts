/**
 * Built-in Homey-Side Haversine GPS Anchor Drift Calculator & Dual-Mode Evaluator.
 *
 * Supports both server-side Signal K anchor alarm plugins (signalk-anchoralarm-plugin,
 * hoekens-anchor-alarm) and a standalone Haversine great-circle distance & true bearing
 * fallback calculator (Earth mean radius R = 6,371,000 meters).
 */

export interface GeoPosition {
  latitude: number;
  longitude: number;
}

export interface AnchorDriftStatus {
  armed: boolean;
  anchorPosition: GeoPosition | null;
  vesselPosition: GeoPosition | null;
  currentRadiusMeters: number | null;
  maxRadiusMeters: number;
  rodeLengthMeters: number | null;
  bearingTrueDegrees: number | null;
  isDragging: boolean;
  source: 'plugin' | 'haversine_fallback';
}

export interface IAnchorWatchCalculator {
  calculateHaversineDistanceMeters(a: GeoPosition, b: GeoPosition): number;
  calculateBearingDegrees(from: GeoPosition, to: GeoPosition): number;
  evaluateDrift(state: {
    armed: boolean;
    anchorPosition: GeoPosition | null;
    vesselPosition: GeoPosition | null;
    pluginCurrentRadiusMeters?: number | null;
    pluginAlarmState?: string | null;
    maxRadiusMeters: number;
    rodeLengthMeters?: number | null;
  }): AnchorDriftStatus;
}

export const EARTH_RADIUS_METERS = 6371000;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const ACTIVE_PLUGIN_ALARM_STATES = new Set(['alert', 'warn', 'alarm', 'emergency']);

/**
 * Checks whether an arbitrary value is a valid geographic coordinate
 * with finite latitude in [-90, 90] and longitude in [-180, 180].
 */
export function isValidGeoPosition(pos: unknown): pos is GeoPosition {
  if (!pos || typeof pos !== 'object') {
    return false;
  }
  const { latitude, longitude } = pos as Record<string, unknown>;
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

export class AnchorWatchCalculator implements IAnchorWatchCalculator {
  /**
   * Computes exact great-circle distance in meters between two WGS84 coordinates
   * using the Haversine formula with Earth mean radius R = 6,371,000 m.
   */
  public calculateHaversineDistanceMeters(a: GeoPosition, b: GeoPosition): number {
    if (!isValidGeoPosition(a) || !isValidGeoPosition(b)) {
      throw new TypeError('Invalid GeoPosition coordinates');
    }

    if (a.latitude === b.latitude && a.longitude === b.longitude) {
      return 0;
    }

    const phi1 = a.latitude * DEG_TO_RAD;
    const phi2 = b.latitude * DEG_TO_RAD;
    const deltaPhi = (b.latitude - a.latitude) * DEG_TO_RAD;
    const deltaLambda = (b.longitude - a.longitude) * DEG_TO_RAD;

    const sinHalfPhi = Math.sin(deltaPhi / 2);
    const sinHalfLambda = Math.sin(deltaLambda / 2);

    const h =
      sinHalfPhi * sinHalfPhi +
      Math.cos(phi1) * Math.cos(phi2) * sinHalfLambda * sinHalfLambda;

    // Clamp to [0, 1] to guard against floating-point overshoot on antipodal points
    const clampedH = Math.min(1, Math.max(0, h));
    const c = 2 * Math.atan2(Math.sqrt(clampedH), Math.sqrt(1 - clampedH));
    const distance = EARTH_RADIUS_METERS * c;

    return Object.is(distance, -0) || distance === 0 ? 0 : distance;
  }

  /**
   * Computes the initial true bearing (forward azimuth) in degrees [0, 360)
   * from the anchor position (`from`) to the vessel position (`to`).
   */
  public calculateBearingDegrees(from: GeoPosition, to: GeoPosition): number {
    if (!isValidGeoPosition(from) || !isValidGeoPosition(to)) {
      throw new TypeError('Invalid GeoPosition coordinates');
    }

    if (from.latitude === to.latitude && from.longitude === to.longitude) {
      return 0;
    }

    const phi1 = from.latitude * DEG_TO_RAD;
    const phi2 = to.latitude * DEG_TO_RAD;
    const deltaLambda = (to.longitude - from.longitude) * DEG_TO_RAD;

    const y = Math.sin(deltaLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);

    const thetaDeg = Math.atan2(y, x) * RAD_TO_DEG;
    let bearing = ((thetaDeg % 360) + 360) % 360;
    if (bearing >= 360 || Math.abs(bearing - 360) < 1e-9) {
      bearing = 0;
    }
    return Object.is(bearing, -0) || bearing === 0 ? 0 : bearing;
  }

  /**
   * Evaluates current anchor drift status combining Signal K anchor plugin telemetry
   * with the built-in Haversine GPS fallback calculator.
   */
  public evaluateDrift(state: {
    armed: boolean;
    anchorPosition: GeoPosition | null;
    vesselPosition: GeoPosition | null;
    pluginCurrentRadiusMeters?: number | null;
    pluginAlarmState?: string | null;
    maxRadiusMeters: number;
    rodeLengthMeters?: number | null;
  }): AnchorDriftStatus {
    const validAnchorPos = isValidGeoPosition(state.anchorPosition)
      ? { latitude: state.anchorPosition.latitude, longitude: state.anchorPosition.longitude }
      : null;
    const validVesselPos = isValidGeoPosition(state.vesselPosition)
      ? { latitude: state.vesselPosition.latitude, longitude: state.vesselPosition.longitude }
      : null;

    const hasValidPluginRadius =
      typeof state.pluginCurrentRadiusMeters === 'number' &&
      Number.isFinite(state.pluginCurrentRadiusMeters) &&
      state.pluginCurrentRadiusMeters >= 0;

    const normalizedAlarmState =
      typeof state.pluginAlarmState === 'string'
        ? state.pluginAlarmState.trim().toLowerCase()
        : null;

    const isPluginAlarmActive =
      normalizedAlarmState !== null && ACTIVE_PLUGIN_ALARM_STATES.has(normalizedAlarmState);

    const safeMaxRadius =
      typeof state.maxRadiusMeters === 'number' &&
      Number.isFinite(state.maxRadiusMeters) &&
      state.maxRadiusMeters > 0
        ? state.maxRadiusMeters
        : 0;

    const safeRodeLength =
      typeof state.rodeLengthMeters === 'number' &&
      Number.isFinite(state.rodeLengthMeters) &&
      state.rodeLengthMeters >= 0
        ? state.rodeLengthMeters
        : null;

    const source: 'plugin' | 'haversine_fallback' =
      hasValidPluginRadius || isPluginAlarmActive ? 'plugin' : 'haversine_fallback';

    let currentRadiusMeters: number | null = null;
    if (hasValidPluginRadius) {
      currentRadiusMeters = state.pluginCurrentRadiusMeters!;
    } else if (validAnchorPos && validVesselPos) {
      currentRadiusMeters = this.calculateHaversineDistanceMeters(validAnchorPos, validVesselPos);
    }

    const bearingTrueDegrees =
      validAnchorPos && validVesselPos
        ? this.calculateBearingDegrees(validAnchorPos, validVesselPos)
        : null;

    let isDragging = false;
    if (Boolean(state.armed)) {
      const radiusExceeded =
        currentRadiusMeters !== null && safeMaxRadius > 0 && currentRadiusMeters > safeMaxRadius;
      isDragging = isPluginAlarmActive || radiusExceeded;
    }

    return {
      armed: Boolean(state.armed),
      anchorPosition: validAnchorPos,
      vesselPosition: validVesselPos,
      currentRadiusMeters,
      maxRadiusMeters: safeMaxRadius,
      rodeLengthMeters: safeRodeLength,
      bearingTrueDegrees,
      isDragging,
      source,
    };
  }
}

export const anchorWatchCalculator = new AnchorWatchCalculator();
export default AnchorWatchCalculator;
