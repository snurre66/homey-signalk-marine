/**
 * Deterministic SI <-> Marine Unit Converter for Homey Pro & Signal K.
 *
 * Converts between Signal K strict SI units (Kelvin, Pascals, radians, m/s,
 * ratio 0..1, Coulombs, Joules, m³, m³/s, Hz, seconds, meters) and Homey/Marine
 * display units (°C, hPa/mbar, bar, kPa, degrees, kn/m/s/km/h, %, Ah, kWh,
 * L, L/h, RPM, hours, minutes, meters, NM).
 *
 * Strictly enforces null / NaN / non-finite guards so lost sensor fixes (value: null)
 * never convert to -273.15°C or 0.
 */

export type SpeedUnit = 'kn' | 'm/s' | 'km/h';

export type UnitCategory =
  | 'temperature_k_to_c'
  | 'speed_ms_to_kn'
  | 'speed_ms_to_kmh'
  | 'speed_ms'
  | 'pressure_pa_to_hpa'
  | 'pressure_pa_to_bar'
  | 'pressure_pa_to_kpa'
  | 'ratio_to_percent'
  | 'angle_rad_to_deg_unsigned'
  | 'angle_rad_to_deg_signed'
  | 'angular_velocity_rads_to_degs'
  | 'frequency_hz_to_rpm'
  | 'charge_c_to_ah'
  | 'energy_j_to_kwh'
  | 'volume_m3_to_l'
  | 'flow_m3s_to_lh'
  | 'duration_s_to_h'
  | 'duration_s_to_min'
  | 'distance_m'
  | 'distance_m_to_nm'
  | 'passthrough';

export interface IUnitConverter {
  fromSignalK(value: unknown, category: UnitCategory, decimals?: number): number | null;
  toSignalK(value: unknown, category: UnitCategory): number | null;
  convertSpeedFromSI(mps: unknown, targetUnit: SpeedUnit, decimals?: number): number | null;
  convertSpeedToSI(speed: unknown, sourceUnit: SpeedUnit): number | null;
}

const KELVIN_OFFSET = 273.15;
const METERS_PER_NAUTICAL_MILE = 1852;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const JOULES_PER_KWH = 3600000;
const LITERS_PER_CUBIC_METER = 1000;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Validates that an input is a strict finite JavaScript number.
 * Rejects null, undefined, NaN, Infinity, booleans, strings, and objects.
 */
function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

/**
 * Applies optional decimal rounding and eliminates negative zero (-0).
 */
function applyRounding(value: number, decimals?: number): number {
  let result: number;
  if (decimals !== undefined) {
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
      result = Number(value.toFixed(10));
    } else {
      const factor = 10 ** decimals;
      const shifted = Math.round((value + (value >= 0 ? 1 : -1) * Number.EPSILON) * factor) / factor;
      result = Number(shifted.toFixed(decimals));
    }
  } else {
    result = Number(value.toFixed(10));
  }
  return Object.is(result, -0) || result === 0 ? 0 : result;
}

/**
 * Normalizes an angle in degrees into unsigned [0, 360).
 * Ensures values that round to 360.0 wrap cleanly to 0.
 */
function normalizeUnsignedDegrees(deg: number, decimals?: number): number {
  let wrapped = ((deg % 360) + 360) % 360;
  wrapped = applyRounding(wrapped, decimals);
  if (wrapped >= 360 || Math.abs(wrapped - 360) < 1e-9) {
    wrapped = 0;
  }
  return Object.is(wrapped, -0) || wrapped === 0 ? 0 : wrapped;
}

/**
 * Normalizes an angle in degrees into signed [-180, +180].
 * Preserves -180 when input is negative at the boundary and +180 when positive.
 */
function normalizeSignedDegrees(deg: number, decimals?: number): number {
  let wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  if (wrapped === -180 && deg > 0) {
    wrapped = 180;
  }
  wrapped = applyRounding(wrapped, decimals);
  if (wrapped > 180) {
    wrapped -= 360;
  } else if (wrapped < -180) {
    wrapped += 360;
  }
  if (wrapped === -180 && deg > 0) {
    wrapped = 180;
  }
  return Object.is(wrapped, -0) || wrapped === 0 ? 0 : wrapped;
}

export class UnitConverter implements IUnitConverter {
  /**
   * Converts a raw Signal K SI value into the target Homey / Marine display unit.
   */
  public fromSignalK(value: unknown, category: UnitCategory, decimals?: number): number | null {
    const x = toFiniteNumber(value);
    if (x === null) {
      return null;
    }

    switch (category) {
      case 'temperature_k_to_c': {
        if (x < 0) {
          return null;
        }
        return applyRounding(x - KELVIN_OFFSET, decimals);
      }
      case 'speed_ms_to_kn':
        return applyRounding((x * SECONDS_PER_HOUR) / METERS_PER_NAUTICAL_MILE, decimals);
      case 'speed_ms_to_kmh':
        return applyRounding(x * 3.6, decimals);
      case 'speed_ms':
        return applyRounding(x, decimals);
      case 'pressure_pa_to_hpa':
        return applyRounding(x / 100, decimals);
      case 'pressure_pa_to_bar':
        return applyRounding(x / 100000, decimals);
      case 'pressure_pa_to_kpa':
        return applyRounding(x / 1000, decimals);
      case 'ratio_to_percent':
        return applyRounding(x * 100, decimals);
      case 'angle_rad_to_deg_unsigned':
        return normalizeUnsignedDegrees(x * RAD_TO_DEG, decimals);
      case 'angle_rad_to_deg_signed':
        return normalizeSignedDegrees(x * RAD_TO_DEG, decimals);
      case 'angular_velocity_rads_to_degs':
        return applyRounding(x * RAD_TO_DEG, decimals);
      case 'frequency_hz_to_rpm':
        return applyRounding(x * SECONDS_PER_MINUTE, decimals);
      case 'charge_c_to_ah':
        return applyRounding(x / SECONDS_PER_HOUR, decimals);
      case 'energy_j_to_kwh':
        return applyRounding(x / JOULES_PER_KWH, decimals);
      case 'volume_m3_to_l':
        return applyRounding(x * LITERS_PER_CUBIC_METER, decimals);
      case 'flow_m3s_to_lh':
        return applyRounding(x * LITERS_PER_CUBIC_METER * SECONDS_PER_HOUR, decimals);
      case 'duration_s_to_h':
        return applyRounding(x / SECONDS_PER_HOUR, decimals);
      case 'duration_s_to_min':
        return applyRounding(x / SECONDS_PER_MINUTE, decimals);
      case 'distance_m':
        return applyRounding(x, decimals);
      case 'distance_m_to_nm':
        return applyRounding(x / METERS_PER_NAUTICAL_MILE, decimals);
      case 'passthrough':
        return applyRounding(x, decimals);
      default:
        return null;
    }
  }

  /**
   * Converts a Homey / Marine display value back into strict Signal K SI units.
   */
  public toSignalK(value: unknown, category: UnitCategory): number | null {
    const y = toFiniteNumber(value);
    if (y === null) {
      return null;
    }

    switch (category) {
      case 'temperature_k_to_c': {
        if (y < -KELVIN_OFFSET) {
          return null;
        }
        return applyRounding(y + KELVIN_OFFSET);
      }
      case 'speed_ms_to_kn':
        return applyRounding((y * METERS_PER_NAUTICAL_MILE) / SECONDS_PER_HOUR);
      case 'speed_ms_to_kmh':
        return applyRounding(y / 3.6);
      case 'speed_ms':
        return applyRounding(y);
      case 'pressure_pa_to_hpa':
        return applyRounding(y * 100);
      case 'pressure_pa_to_bar':
        return applyRounding(y * 100000);
      case 'pressure_pa_to_kpa':
        return applyRounding(y * 1000);
      case 'ratio_to_percent':
        return applyRounding(y / 100);
      case 'angle_rad_to_deg_unsigned': {
        const normDeg = normalizeUnsignedDegrees(y);
        return applyRounding(normDeg * DEG_TO_RAD);
      }
      case 'angle_rad_to_deg_signed': {
        const normDeg = normalizeSignedDegrees(y);
        return applyRounding(normDeg * DEG_TO_RAD);
      }
      case 'angular_velocity_rads_to_degs':
        return applyRounding(y * DEG_TO_RAD);
      case 'frequency_hz_to_rpm':
        return applyRounding(y / SECONDS_PER_MINUTE);
      case 'charge_c_to_ah':
        return applyRounding(y * SECONDS_PER_HOUR);
      case 'energy_j_to_kwh':
        return applyRounding(y * JOULES_PER_KWH);
      case 'volume_m3_to_l':
        return applyRounding(y / LITERS_PER_CUBIC_METER);
      case 'flow_m3s_to_lh':
        return applyRounding(y / (LITERS_PER_CUBIC_METER * SECONDS_PER_HOUR));
      case 'duration_s_to_h':
        return applyRounding(y * SECONDS_PER_HOUR);
      case 'duration_s_to_min':
        return applyRounding(y * SECONDS_PER_MINUTE);
      case 'distance_m':
        return applyRounding(y);
      case 'distance_m_to_nm':
        return applyRounding(y * METERS_PER_NAUTICAL_MILE);
      case 'passthrough':
        return applyRounding(y);
      default:
        return null;
    }
  }

  /**
   * Converts SI speed in m/s to user-selected speed unit ('kn' | 'm/s' | 'km/h').
   */
  public convertSpeedFromSI(mps: unknown, targetUnit: SpeedUnit, decimals?: number): number | null {
    switch (targetUnit) {
      case 'kn':
        return this.fromSignalK(mps, 'speed_ms_to_kn', decimals);
      case 'km/h':
        return this.fromSignalK(mps, 'speed_ms_to_kmh', decimals);
      case 'm/s':
        return this.fromSignalK(mps, 'speed_ms', decimals);
      default:
        return null;
    }
  }

  /**
   * Converts speed in user-selected speed unit ('kn' | 'm/s' | 'km/h') back to SI m/s.
   */
  public convertSpeedToSI(speed: unknown, sourceUnit: SpeedUnit): number | null {
    switch (sourceUnit) {
      case 'kn':
        return this.toSignalK(speed, 'speed_ms_to_kn');
      case 'km/h':
        return this.toSignalK(speed, 'speed_ms_to_kmh');
      case 'm/s':
        return this.toSignalK(speed, 'speed_ms');
      default:
        return null;
    }
  }
}

export const unitConverter = new UnitConverter();
export default UnitConverter;
