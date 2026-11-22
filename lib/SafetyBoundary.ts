/**
 * Marine Control & Read-Only Safety Boundary Enforcement (`PROJECT.md § 4.2`).
 *
 * Enforces the strict separation between:
 *  - Read/Write (`PUT` Enabled) comfort, energy, electrical switching, and anchor watch paths:
 *      - `electrical.switches.**`
 *      - `electrical.chargers.*.{mode,currentLimit,state}`
 *      - `electrical.inverters.*.{inverterMode,state}`
 *      - `navigation.anchor.**`
 *  - Strictly Read-Only safety-critical vessel actuation paths (MUST throw `SafetyBoundaryError`):
 *      - `steering.**` (including `steering.autopilot.**`, `steering.rudderAngle**`)
 *      - `propulsion.**`
 *      - `navigation.**` EXCEPT `navigation.anchor.**`
 */

export class SafetyBoundaryError extends Error {
  public readonly path: string;

  constructor(path: string, reason?: string) {
    const cleanPath = typeof path === 'string' ? path : String(path);
    const detail = reason
      ? `Safety boundary violation for Signal K path "${cleanPath}": ${reason}`
      : `Safety boundary violation: Signal K path "${cleanPath}" is strictly read-only and cannot be modified via PUT.`;
    super(detail);
    this.name = 'SafetyBoundaryError';
    this.path = cleanPath;
    Object.setPrototypeOf(this, SafetyBoundaryError.prototype);
  }
}

export interface ISafetyBoundary {
  normalizePath(rawPath: string): string;
  isWritablePath(path: string): boolean;
  assertWritablePath(path: string): void;
}

const FORBIDDEN_STEERING_REGEX = /^steering(\.|$)/;
const FORBIDDEN_PROPULSION_REGEX = /^propulsion(\.|$)/;
const FORBIDDEN_NAVIGATION_REGEX = /^navigation(\.(?!anchor(\.|$))|$)/;

const WRITABLE_PATH_PATTERNS: RegExp[] = [
  // Electrical switches & dimmers (direct and banked: electrical.switches.<id>.state, electrical.switches.bank.<bank>.<id>.state)
  /^electrical\.switches\.[A-Za-z0-9_.-]+$/,
  // Charger load-shedding modes, current limits, and state
  /^electrical\.chargers\.[A-Za-z0-9_-]+\.(mode|currentLimit|state)$/,
  // Inverter load-shedding modes and state
  /^electrical\.inverters\.[A-Za-z0-9_-]+\.(inverterMode|state)$/,
  // Anchor Watch control (position, maxRadius, rodeLength, dropAnchor, raiseAnchor, setRadius, setRodeLength, etc.)
  /^navigation\.anchor\.[A-Za-z0-9_.-]+$/,
];

const VALID_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;

export class SafetyBoundary implements ISafetyBoundary {
  /**
   * Canonicalizes a Signal K dot-path or REST slash-path into a normalized dot-path.
   * Returns an empty string `""` if the path is malformed, empty, or contains traversal sequences.
   */
  public normalizePath(rawPath: string): string {
    if (typeof rawPath !== 'string') {
      return '';
    }

    const trimmed = rawPath.trim();
    if (trimmed.length === 0) {
      return '';
    }

    // Reject URL query strings, fragments, null bytes, backslashes, URL-encoded traversal, or '..'
    if (
      trimmed.includes('?') ||
      trimmed.includes('#') ||
      trimmed.includes('\0') ||
      trimmed.includes('\\') ||
      trimmed.includes('..') ||
      /%2e/i.test(trimmed) ||
      /%2f/i.test(trimmed) ||
      /%5c/i.test(trimmed)
    ) {
      return '';
    }

    let cleaned = trimmed;
    // Strip standard REST API prefix or vessels.self prefix if present
    cleaned = cleaned.replace(/^\/?signalk\/v1\/api\/vessels\/self\/?/i, '');
    cleaned = cleaned.replace(/^\/?vessels\/self\/?/i, '');
    cleaned = cleaned.replace(/^vessels\.self\./i, '');

    // Convert slashes to dots and strip leading/trailing dots
    cleaned = cleaned.replace(/\//g, '.').replace(/^\.+|\.+$/g, '');

    if (cleaned.length === 0 || cleaned.includes('..')) {
      return '';
    }

    const segments = cleaned.split('.');
    for (const seg of segments) {
      if (!VALID_SEGMENT_REGEX.test(seg)) {
        return '';
      }
    }

    return cleaned;
  }

  /**
   * Inspects a path and returns `{ writable: true }` or `{ writable: false, reason }`.
   */
  private evaluatePath(rawPath: string): { writable: boolean; normalized: string; reason?: string } {
    const normalized = this.normalizePath(rawPath);
    if (!normalized) {
      return {
        writable: false,
        normalized: '',
        reason: 'Malformed, empty, or path-traversal Signal K path is forbidden.',
      };
    }

    // 1. Explicit Safety Blocklist checks (evaluated first)
    if (FORBIDDEN_STEERING_REGEX.test(normalized)) {
      return {
        writable: false,
        normalized,
        reason: 'Autopilot and steering actuation (steering.**) is strictly read-only for vessel safety.',
      };
    }

    if (FORBIDDEN_PROPULSION_REGEX.test(normalized)) {
      return {
        writable: false,
        normalized,
        reason: 'Propulsion and engine control (propulsion.**) is strictly read-only for vessel safety.',
      };
    }

    if (FORBIDDEN_NAVIGATION_REGEX.test(normalized)) {
      return {
        writable: false,
        normalized,
        reason:
          'Navigation, course, and waypoint control (navigation.** except navigation.anchor.**) is strictly read-only for vessel safety.',
      };
    }

    // 2. Allowed Writable Whitelist check
    for (const pattern of WRITABLE_PATH_PATTERNS) {
      if (pattern.test(normalized)) {
        return { writable: true, normalized };
      }
    }

    return {
      writable: false,
      normalized,
      reason:
        'Path is outside the permitted writable namespaces (electrical.switches.**, electrical.chargers.*.{mode,currentLimit,state}, electrical.inverters.*.{inverterMode,state}, navigation.anchor.**).',
    };
  }

  /**
   * Returns true if and only if the Signal K path is permitted for outbound PUT writes.
   */
  public isWritablePath(path: string): boolean {
    return this.evaluatePath(path).writable;
  }

  /**
   * Asserts that a Signal K path is permitted for outbound PUT writes.
   * Throws `SafetyBoundaryError` synchronously if the path is read-only or malformed.
   */
  public assertWritablePath(path: string): void {
    const evaluation = this.evaluatePath(path);
    if (!evaluation.writable) {
      throw new SafetyBoundaryError(path, evaluation.reason);
    }
  }
}

export const safetyBoundary = new SafetyBoundary();
export default SafetyBoundary;
