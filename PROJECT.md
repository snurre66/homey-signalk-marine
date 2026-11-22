# Project: Homey Pro Smart Boat Integration for OpenPlotter (Signal K) (`com.signalk.marine`)

## 1. Architecture &Confirmed Design Decisions (`/grill-me` + `/plan` Alignment)

### 1.1 Overview
This Homey SDK v3 application (`com.signalk.marine`, App Store Title: `"Signal K Marine"`) integrates **OpenPlotter / Signal K Server** running on a boat's Raspberry Pi (12V LAN/Wi-Fi) with **Homey Pro (2019 and newer, e.g., Early 2023 / 2026)**. It positions Homey Pro as the central onboard smart-boat automation hub for cabin comfort, energy management, appliance control, security/bilge alerts, anchor drift watch, and sailing telemetry dashboards—while enforcing a strict safety boundary that leaves course/waypoint navigation, autopilot actuation, and propulsion control read-only inside OpenPlotter / NMEA 2000.

### 1.2 Confirmed `/grill-me` Architectural Decisions

1. **6 Modular Homey Drivers (Homey Energy & Zone Compatible)**:
   - `vessel` (**Vessel & Anchor Watch**): Core sailing/navigation telemetry (SOG, STW, COG, Heading, Depth, AWS/TWS, AWA/TWA, Barometric Pressure, Outside/Water Temp, Navigation State, Read-Only Autopilot State/Target Heading) + **Anchor Drift Watch** (armed state, current radius, max radius, rode length, bearing, alarm capability `alarm_generic`, Haversine fallback calculator, and `PUT` / REST control to drop anchor, raise anchor, and set max radius).
   - `electrical-bank` (**Battery / Electrical Bank — Homey Energy Compatible**): Auto-discovers and monitors Victron VE.Direct / Venus OS (`SmartShunt`, `BMV`, `MPPT Solar`, `MultiPlus / Charger / Inverter`) and NMEA 2000 DC/AC banks (`electrical.batteries.*`, `electrical.solar.*`, `electrical.chargers.*`, `electrical.inverters.*`, `electrical.alternators.*`, `electrical.ac.*`). Supports voltage (`V`), current (`A`), power (`W`), energy (`kWh`), state of charge (`%`), remaining capacity (`Ah` from Coulombs `C / 3600`), time remaining (`min`/`h`), battery temperature (`°C`), low-battery alarm (`alarm_battery`), and `PUT` control for charger/inverter load-shedding modes where writable.
   - `fluid-tank` (**Fluid Tank Monitor**): Auto-discovers `tanks.{freshWater,fuel,blackWater,wasteWater,liveWell,lubrication,ballast}.*`. Reports tank level (`%`, `0..100`), current volume (`L` from `m³ * 1000`), total capacity (`L`), and high/low level alerts.
   - `digital-switch` (**Digital Switch / Relay — Read/Write `PUT` Enabled**): Auto-discovers and controls `electrical.switches.*` (Victron GX relays, Shelly 12V relays, Autoterm diesel heater relays, NMEA 2000 switch banks, 1-Wire/GPIO relays). Supports `onoff` (boolean / `0`/`1`) and optional `dim` (`dimmingLevel` `0..1`) via Signal K `PUT` with async `202 PENDING` -> `200 COMPLETED` / `FAILED` state handling.
   - `propulsion` (**Propulsion / Engine — Strictly Read-Only**): Auto-discovers `propulsion.<id>.*` (port/starboard/main engines from NMEA 2000 / SeaTalkNG engine gateways & 1-Wire/I2C sensors). Reports engine state, RPM (`Hz * 60`), engine/coolant/exhaust temperature (`K -> °C`), oil & coolant pressure (`Pa -> bar`), engine hours (`s -> h`), fuel rate (`m³/s -> L/h`),transmission gear, and engine overheat/oil alarm (`alarm_generic`). Strictly read-only (zero `PUT` capabilities).
   - `custom-sensor` (**Custom Signal K Path Sensor**): User-configurable driver that binds any arbitrary Signal K dot-path (with optional `$source` pinning and selectable unit conversion preset) to Homey numeric, string, or boolean alarm capabilities.

2. **App Store Compliant Bidirectional Sensor Bridge (Homey -> Signal K Flow Action Cards)**:
   - Complies with Homey App Store Guideline 1.15 (does **not** request restricted `homey:manager:api` permission).
   - Provides rich Homey Flow Action Cards (`then`) that publish Homey Zigbee, Z-Wave, Wi-Fi, and BLE sensor values (e.g., cabin temperature, humidity, barometric pressure, hatch/door contact sensors, bilge float switches, Shelly 12V relays, RuuviTag BLE sensors, diesel heater status) back into Signal K over the authenticated `readwrite` WebSocket delta stream (`{ context: "vessels.self", updates: [{ $source: "homey.<source>", timestamp, values: [{ path, value }] }] }`).
   - Performs automatic reverse unit conversion from Homey units to strict Signal K SI units:
     - Temperature: `°C -> K` (`x = y + 273.15`)
     - Relative Humidity / Ratio / Level: `% (0..100) -> ratio (0..1)` (`x = y / 100`)
     - Atmospheric Pressure: `hPa / mbar -> Pa` (`x = y * 100`)
   - Includes standard path presets for:
     - `environment.inside.<zone>.temperature`, `environment.inside.<zone>.relativeHumidity`, `environment.inside.<zone>.pressure` (zones: `mainCabin`, `saloon`, `forwardCabin`, `aftCabin`, `galley`, `engineRoom`, `heads`, `lazarette`)
     - `electrical.switches.<id>.state` (including diesel heater & cabin relays)
     - `notifications.security.<item>` (hatch/door contact intrusion alerts)
     - `notifications.bilge.<item>` (bilge high-water float switch alarms)
     - Custom arbitrary Signal K path + custom value/notification state (`normal`, `alert`, `warn`, `alarm`, `emergency`).

3. **Control Boundaries (`PUT` Actuation vs. Read-Only Safety Boundary)**:
   - **Read/Write (`PUT` Enabled)**:
     - Electrical switches & dimmers (`electrical.switches.<id>.state`, `electrical.switches.<id>.dimmingLevel`, `electrical.switches.bank.<bank>.<id>.state`)
     - Charger & Inverter load-shedding modes (`electrical.inverters.<id>.inverterMode`, `electrical.chargers.<id>.mode`, `electrical.chargers.<id>.currentLimit`)
     - Anchor Watch actuation (`navigation.anchor.position`, `navigation.anchor.maxRadius`, `navigation.anchor.rodeLength`, plus automatic fallback to `signalk-anchoralarm-plugin` REST endpoints `POST /plugins/anchoralarm/{dropAnchor,raiseAnchor,setRadius,setRodeLength}`).
   - **Strictly Read-Only (Safety Boundary Enforced in Code)**:
     - Autopilot (`steering.autopilot.*`)
     - Course, route, and waypoint navigation (`navigation.course*`, `navigation.waypoints*`, `steering.rudderAngle*`)
     - Propulsion and transmission (`propulsion.*`)
     - Outbound `PUT` calls in `SignalKClient` and the generic `put_signalk_path` Flow Action Card MUST validate paths against a strict safety blocklist (`^steering\.`, `^propulsion\.`, `^navigation\.(?!anchor\b)`) and throw a descriptive `SafetyBoundaryError` if a write is attempted to a read-only navigation/autopilot/propulsion path.

4. **Anchor Drift Watch & Battery Load-Shedding Automation**:
   - **Dual-Mode Anchor Drift Watch**:
     1. **Signal K Plugin Integration**: Subscribes to `navigation.anchor.*` and `notifications.navigation.anchor.*` (`policy: "instant"`, `minPeriod: 200`), supporting both `sbender9/signalk-anchoralarm-plugin` and `hoekens-anchor-alarm`.
     2. **Built-in Homey-Side Haversine GPS Drift Fallback Calculator (`lib/AnchorWatchCalculator.ts`)**: When enabled or when no server-side anchor plugin provides `currentRadius`, stores the anchor drop GPS coordinate (`latitude`, `longitude`) and computes exact great-circle distance in meters (`Haversine` formula with Earth radius `R = 6371000 m`) and true bearing (`0..360°`) from live `navigation.position` updates. Automatically raises/clears anchor drag alarms and fires `anchor_drag_alarm` and `anchor_radius_exceeded` Flow triggers when `distance > maxRadius`.
   - **Battery Load-Shedding Automation**:
     - Dedicated Flow Triggers (`battery_soc_below_threshold`, `battery_voltage_low`, `load_shedding_stage_changed`, `shore_power_disconnected`) and Flow Conditions (`is_battery_soc_below`, `is_on_shore_power`, `is_solar_generating`, `is_vessel_state`) plus Flow Actions (`set_charger_inverter_mode`, `toggle_digital_switch`) so boat owners can automatically shed non-essential 12V/230V loads (water heater, fridge, cabin AC, outlets) as House Battery SOC or voltage drops.

5. **SI-to-Marine Unit Conversions & Homey Pro (2019) Throttling**:
   - **Deterministic Bidirectional Unit Converter (`lib/UnitConverter.ts`)**:
     - Speed (`SOG`, `STW`, `AWS`, `TWS`): Default `kn` (`m/s * 3600 / 1852`), user-configurable per device to `m/s` or `km/h` (`m/s * 3.6`).
     - Depth / Distance / Anchor Radius & Rode: `m` (`1:1`).
     - Temperature: `°C` (`K - 273.15`).
     - Atmospheric Pressure: `hPa` / `mbar` (`Pa / 100`).
     - Engine / Oil / Coolant Pressure: `bar` (`Pa / 100000`).
     - Fluid Tank Volume: `L` (`m³ * 1000`), Tank Level / SOC / Humidity: `%` (`ratio * 100`).
     - Battery Capacity: `Ah` (`Coulombs C / 3600`), Energy: `kWh` (`Joules J / 3600000`), Time Remaining: `min` or `h` (`s / 60` or `s / 3600`).
     - Angles (`Heading`, `COG`, `Bearing`): Unsigned `[0, 360)` deg (`rad * 180 / π`); Wind Angles (`AWA`, `TWA`) & Attitude (`Roll`, `Pitch`): Signed `[-180, +180]` deg.
     - Engine Speed: `RPM` (`Hz * 60`), Fuel Flow Rate: `L/h` (`m³/s * 3600000`), Engine Runtime: `h` (`s / 3600`).
     - Strict `null` / `NaN` guards: `null` values in Signal K (lost sensor fix or cleared notification) never convert to `-273.15°C` or `0`; they clear alarms or preserve graceful null state.
   - **Homey Pro (2019) CPU/Memory Throttling Tiers**:
     - Single shared WebSocket connection per Signal K server (`?subscribe=none`) multiplexed by `SignalKConnectionPool`.
     - Tiered subscription & client-side throttling policies (configurable in device settings):
       - **Tier Fast (`200ms`, `policy: "instant"`, `minPeriod: 200`)**: `notifications.*`, `electrical.switches.*`, `navigation.anchor.*`
       - **Tier Medium (`2000ms`, `policy: "ideal"`, `period: 2000`, `minPeriod: 1000`)**: `navigation.*`, `environment.wind.*`, `environment.depth.*`, `propulsion.*`
       - **Tier Slow (`5000ms`, `policy: "ideal"`, `period: 5000`, `minPeriod: 2500`)**: `electrical.batteries.*`, `electrical.solar.*`, `electrical.chargers.*`, `electrical.inverters.*`, `tanks.*`, `environment.inside.*`, `environment.outside.*`, `environment.water.*`.

6. **Onboard Hardware Presets & Test Fixtures (`lib/HardwarePresets.ts`)**:
   - First-class discovery, path templates, and realistic test fixtures for:
     - **Victron VE.Direct / Venus OS (`signalk-venus-plugin`)**: SmartShunt / BMV-712 (`house`, `starter`, `bowThruster`), SmartSolar MPPT (`solar.0`, `solar.1`), MultiPlus Inverter/Charger (`inverters.0`, `chargers.0`, `ac.0`), GX Relay (`switches.venusRelay0`, `switches.venusRelay1`).
     - **NMEA 2000 / SeaTalkNG**: Raymarine / B&G / Garmin instruments (`environment.depth.belowTransducer`, `navigation.speedOverGround`, `navigation.speedThroughWater`, `environment.wind.speedApparent`, `environment.wind.angleApparent`, `navigation.position`, `navigation.headingTrue`, `steering.autopilot.state`, `steering.autopilot.target.headingTrue`) & engine gateway (`propulsion.port.*`, `propulsion.starboard.*` or `propulsion.main.*`).
     - **1-Wire / I2C / GPIO on OpenPlotter Raspberry Pi**: Engine room & saloon 1-Wire DS18B20 temps (`environment.inside.engineRoom.temperature`, `environment.inside.saloon.temperature`), BME280 barometric pressure (`environment.outside.pressure`), GPIO bilge float switches (`notifications.bilge.main`, `electrical.switches.bilgePump.state`).
     - **Diesel Heater & RuuviTag BLE**: Autoterm / Shelly 12V / Victron relay control & status (`electrical.switches.dieselHeater.state`, `environment.inside.aftCabin.temperature`) and RuuviTag BLE environmental sensors (`environment.inside.forwardCabin.temperature`, `relativeHumidity`, `pressure`).

---

## 2. Feature Inventory

Every feature discovered in the Step 0 Survey and confirmed in the `/grill-me` user interview is assigned to an explicit implementation milestone below (zero unassigned features).

| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| F1 | `.homeycompose` Modular App Manifest & App Store Assets | SDK v3 manifest (`.homeycompose/app.json`, custom capabilities, mDNS discovery strategy, flow definitions, driver templates, valid SVG icons, PNG images, plain-text `README.txt`, `.homeychangelog.json`) passing Homey App Store `publish` schema rules without `homey:manager:api`. | M1 | survey + grill-me #1, #2 |
| F2 | Deterministic SI <-> Marine Unit Converter (`UnitConverter`) | Bidirectional conversion between Signal K SI units (`K`, `Pa`, `rad`, `m/s`, `ratio 0..1`, `C`, `J`, `m³`, `m³/s`, `Hz`, `s`) and Homey/Marine units (`°C`, `hPa`/`mbar`, `bar`, `deg`, `kn`/`m/s`/`km/h`, `%`, `Ah`, `kWh`, `L`, `L/h`, `RPM`, `h`/`min`) with strict `null`/`NaN` guards and signed vs. unsigned angle handling. | M1 | survey + grill-me #2, #5 |
| F3 | Built-in Haversine GPS Anchor Drift Calculator (`AnchorWatchCalculator`) | Computes great-circle distance (`m`) and true bearing (`0..360°`) between anchor drop coordinates and live `navigation.position`, supporting automatic radius alarm triggers when server-side plugin radius is absent or fallback mode is active. | M1 | grill-me #4 |
| F4 | Signal K Discovery, Auth & Access Request Manager (`SignalKAuthManager`) | mDNS-SD (`_signalk-http._tcp`) + `GET /signalk` endpoint discovery + manual `host:port` & self-signed TLS support + `POST /signalk/v1/access/requests` (`permissions: "readwrite"`, persistent UUIDv4 `clientId`) + `GET <href>` approval polling + JWT bearer token & unauthenticated read-only fallback. | M1 | survey |
| F5 | Shared Multiplexed WebSocket & REST Connection Pool (`SignalKConnectionPool`) | Single shared WebSocket per Signal K server (`?subscribe=none`), tiered subscription throttling (`200ms` fast, `2000ms` medium, `5000ms` slow), `hello.self` URN context normalization, `$source` filtering, exponential backoff auto-reconnect, and WebSocket delta publishing. | M1 | survey + grill-me #5 |
| F6 | Safety-Boundary Enforced `PUT` Control & Hardware Presets (`SignalKPutController`, `HardwarePresets`) | Executes REST/WS `PUT` requests with async `202 PENDING` -> `200 COMPLETED` / `FAILED` handling, anchor alarm plugin REST fallback (`/plugins/anchoralarm/*`), strict safety blocklist preventing writes to autopilot/navigation/propulsion, and OpenPlotter hardware presets/discovery (`PathDiscoveryService`). | M1 | survey + grill-me #3, #4, #6 |
| F7 | Vessel & Anchor Watch Driver (`drivers/vessel`) | Pairs vessel telemetry & anchor watch device: SOG, STW, COG, Heading, Depth, AWS/TWS, AWA/TWA, Barometer, Outside/Water Temp, Navigation State, Read-Only Autopilot State, Anchor Armed toggle (`onoff.anchor_armed`), Anchor Current/Max Radius, Anchor Distance, Anchor Drag Alarm (`alarm_generic`), with mDNS IP updates and custom pairing/repair views. | M2 | survey + grill-me #1, #3, #4, #5 |
| F8 | Propulsion / Engine Driver (`drivers/propulsion`) | Auto-discovers NMEA 2000 / OpenPlotter engines (`propulsion.<id>`); reports engine state, RPM (`Hz -> RPM`), coolant/engine temp (`K -> °C`), oil & coolant pressure (`Pa -> bar`), engine hours (`s -> h`), fuel rate (`m³/s -> L/h`), transmission gear, and engine alarm (`alarm_generic`). Strictly read-only. | M2 | survey + grill-me #1, #3, #5, #6 |
| F9 | Custom Signal K Path Sensor Driver (`drivers/custom-sensor`) | Pairs user-defined Signal K dot-paths (including 1-Wire/I2C/GPIO & RuuviTag paths) with configurable `$source` pinning, unit conversion category, and throttling interval (`200ms`/`2s`/`5s`). | M2 | survey + grill-me #1, #5, #6 |
| F10 | Battery / Electrical Bank Driver (`drivers/electrical-bank`) | Homey Energy compatible driver for Victron SmartShunt/BMV, MPPT Solar, MultiPlus Charger/Inverter, Alternators & NMEA 2000 banks (`measure_voltage`, `measure_current`, `measure_power`, `meter_power`, `measure_battery`, `measure_temperature`, `measure_remaining_ah`, `measure_time_remaining`, `alarm_battery`, and writable charger/inverter load-shedding mode where supported). | M3 | survey + grill-me #1, #3, #4, #5, #6 |
| F11 | Fluid Tank Monitor Driver (`drivers/fluid-tank`) | Auto-discovers `tanks.{freshWater,fuel,blackWater,wasteWater,liveWell,lubrication,ballast}.<id>`; reports level `%` (`measure_tank_level`), volume `L` (`measure_tank_volume`), capacity `L`, `meter_water` (`m³`), and tank threshold alarms (`alarm_generic` / `alarm_water`). | M3 | survey + grill-me #1, #5, #6 |
| F12 | Digital Switch / Relay Driver (`drivers/digital-switch`) | Auto-discovers `electrical.switches.*` (Victron GX relays, Shelly 12V relays, Autoterm diesel heater relay, NMEA 2000 switch banks, GPIO bilge pump switches); supports `onoff` and optional `dim` via Signal K `PUT` with optimistic state & failure rollback. | M3 | survey + grill-me #1, #3, #5, #6 |
| F13 | Bidirectional Sensor Bridge Flow Action Cards (Homey -> Signal K) | App Store compliant Flow Action Cards to publish Homey temperature (`°C -> K`), humidity (`% -> ratio`), pressure (`mbar -> Pa`), contact/switch state (`boolean`), custom path value, and notification alarms (`notifications.security.*`, `notifications.bilge.*`, `environment.inside.<zone>.*`, `electrical.switches.*`) into Signal K via WebSocket delta stream. | M4 | survey + grill-me #2, #6 |
| F14 | Anchor Watch, Notification & Battery Load-Shedding Flow Cards (Triggers, Conditions, Actions) | Maritime Flow Triggers (`signalk_notification_raised`, `anchor_drag_alarm`, `navigation_state_changed`, `battery_soc_below_threshold`, `shore_power_status_changed`, `path_value_updated`), Conditions (`is_vessel_state`, `is_alarm_active`, `is_battery_soc_below`, `is_anchor_armed`, `path_value_comparison`), and Control Actions (`arm_anchor_watch`, `disarm_anchor_watch`, `set_anchor_max_radius`, `set_charger_inverter_mode`, `put_signalk_path` with safety boundary enforcement). | M4 | survey + grill-me #2, #3, #4 |
| F15 | Full App Composition, CLI Build/Validation & Final E2E Verification | Full composition of `.homeycompose` into `app.json`, TypeScript compilation to `.homeybuild/`, Homey App Store `publish`-level validation (`homey app validate -l publish` / schema validator), passing 100% of E2E tests (Tiers 1–4) + Tier 5 Adversarial Coverage Hardening. | M4 & M5 | survey + grill-me #1–#6 |

---

## 3. Milestones

| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Core Foundation, `.homeycompose` Base, Signal K Engine & Unit/Haversine Libraries | Initialize project (`package.json`, `tsconfig.json`, `.homeycompose/app.json`, custom capabilities, discovery, driver templates, valid SVG/PNG assets, plain-text `README.txt`); implement `lib/UnitConverter.ts`, `lib/AnchorWatchCalculator.ts`, `lib/HardwarePresets.ts`, `lib/SafetyBoundary.ts`, `lib/SignalKAuthManager.ts`, `lib/SignalKConnectionPool.ts`, `lib/SignalKPutController.ts`, `lib/PathDiscoveryService.ts`, and core `app.ts` service registry with comprehensive unit tests. | none | COMPLETED |
| M2 | Vessel & Anchor Watch (`vessel`), Propulsion (`propulsion`) & Custom Sensor (`custom-sensor`) Drivers | Implement `drivers/vessel`, `drivers/propulsion`, and `drivers/custom-sensor` (`driver.compose.json`, `driver.settings.compose.json`, `driver.ts`, `device.ts`, custom HTML pairing `pair/connect_server.html` and repair `repair/reconnect_server.html` views, driver icons/images) integrating M1 libraries, dual-mode Anchor Watch (Signal K plugin + Haversine fallback), read-only safety boundary for autopilot/propulsion, and configurable units/throttling, with unit/integration tests. | M1 | COMPLETED |
| M3 | Electrical Bank (`electrical-bank`), Fluid Tank (`fluid-tank`) & Digital Switch (`digital-switch`) Drivers | Implement `drivers/electrical-bank` (Homey Energy compatible: batteries, solar MPPT, chargers/inverters, load-shedding mode `PUT`), `drivers/fluid-tank` (level `%`, volume `L`, `meter_water`, alerts), and `drivers/digital-switch` (`onoff` & `dim` via Signal K `PUT` with async `202 PENDING` -> `200 COMPLETED` / rollback), covering all Victron/N2K/1-Wire/Diesel Heater/Shelly presets, with unit/integration tests. | M1 | COMPLETED |
| M4 | Bidirectional Flow Engine (Homey <-> Signal K), App Composition & App Store Validation | Implement all Flow Triggers, Conditions, and Action Cards (`.homeycompose/flow/{triggers,conditions,actions}/*.json`, `lib/FlowCardManager.ts`, wired into `app.ts` and all 6 drivers): Homey-to-Signal K sensor bridge (`°C->K`, `%->ratio`, `mbar->Pa`, presets for `environment.inside.<zone>.*`, `electrical.switches.*`, `notifications.security.*`, `notifications.bilge.*`), Anchor Drift & Battery Load-Shedding Flows, manifest build (`app.json`), and Homey App Store `publish`-level validation (`homey app validate -l publish`). | M2, M3 | COMPLETED |
| E2E | E2E Testing Track (Parallel Opaque-Box Suite) | Build standalone realistic Mock Signal K Server (HTTP REST + mDNS + Access Request Auth + WebSocket delta stream + PUT handlers + Victron/N2K/1-Wire/Diesel Heater/RuuviTag fixtures) and 4-Tier Opaque-Box E2E Test Suite (`TEST_INFRA.md`, `test/e2e/`, `TEST_READY.md`) testing all 15 features F1–F15 across ≥175 E2E test cases. | none (runs in parallel with M1–M4) | COMPLETED |
| M5 | Final Verification: Composition, App Store Validation & E2E Tiers 1–4 | Full composition (`homey app build`), `homey app validate --level publish`, 27/27 unit tests, and 182/182 E2E tests across Tiers 1–4. | M4, E2E | COMPLETED |

---

## 4. Interface Contracts

### 4.1 `lib/UnitConverter.ts` ↔ Drivers & Flow Engine
```typescript
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
```
- **Contract**: If `value` is `null`, `undefined`, `NaN`, or non-finite, `fromSignalK` and `toSignalK` MUST return `null` (never `0` or `-273.15`).

### 4.2 `lib/SafetyBoundary.ts` ↔ `SignalKPutController` & Flow Actions
```typescript
export class SafetyBoundaryError extends Error {
  public readonly path: string;
  constructor(path: string, reason?: string);
}

export interface ISafetyBoundary {
  isWritablePath(path: string): boolean;
  assertWritablePath(path: string): void;
}
```
- **Contract**:
  - Allowed write (`PUT`) namespaces:
    - `electrical.switches.**`
    - `electrical.chargers.*.mode`, `electrical.chargers.*.currentLimit`, `electrical.chargers.*.state`
    - `electrical.inverters.*.inverterMode`, `electrical.inverters.*.state`
    - `navigation.anchor.**` (drop, raise, maxRadius, rodeLength, position)
  - Forbidden read-only namespaces (MUST throw `SafetyBoundaryError`):
    - `steering.**` (including `steering.autopilot.**`, `steering.rudderAngle**`)
    - `propulsion.**`
    - `navigation.**` EXCEPT `navigation.anchor.**` (blocks `navigation.course**`, `navigation.waypoints**`, `navigation.position`, `navigation.speedOverGround`, etc.).

### 4.3 `lib/AnchorWatchCalculator.ts` ↔ `drivers/vessel` & Flow Engine
```typescript
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
```

### 4.4 `lib/SignalKConnectionPool.ts` & `lib/SignalKAuthManager.ts` ↔ `Homey.App` & All 6 Drivers
```typescript
export type ThrottleTier = 'fast' | 'medium' | 'slow'; // fast=200ms, medium=2000ms, slow=5000ms

export interface ServerConnectionConfig {
  serverId: string;        // e.g. vessel self URN or host:port
  host: string;
  port: number;
  useTls: boolean;
  allowSelfSigned?: boolean;
  token?: string;          // JWT Bearer token
  clientId?: string;       // Persistent UUIDv4
}

export interface PathSubscription {
  subscriberId: string;    // Homey device ID
  path: string;            // e.g. "electrical.batteries.house.voltage" or "notifications.*"
  tier: ThrottleTier;
  customMinPeriodMs?: number;
  sourceFilter?: string;   // optional $source pin
  onUpdate: (update: {
    path: string;
    value: unknown;
    $source: string;
    timestamp: string;
  }) => void;
}

export interface ISignalKConnectionPool {
  acquireConnection(config: ServerConnectionConfig): Promise<void>;
  subscribe(serverId: string, sub: PathSubscription): () => void;
  updateServerAddress(serverId: string, host: string, port: number): Promise<void>;
  publishDelta(serverId: string, updates: Array<{
    path: string;
    value: unknown;
    $source?: string;
    sourceLabel?: string;
  }>): Promise<void>;
  putPath(serverId: string, path: string, value: unknown, options?: {
    source?: string;
    timeoutMs?: number;
  }): Promise<{ state: 'COMPLETED' | 'PENDING' | 'FAILED'; statusCode: number; message?: string }>;
  getVesselSubtree(serverId: string, subPath?: string): Promise<Record<string, any>>;
}
```

---

## 5. Code Layout

All application code lives at the workspace root `/home/antigravity` following standard Homey SDK v3 TypeScript conventions:

```text
/home/antigravity/
├── PROJECT.md                           # Master architecture, feature inventory & milestone status
├── TEST_INFRA.md                        # E2E test architecture & feature checklist (created by E2E Track)
├── TEST_READY.md                        # E2E suite completion signal (created by E2E Track)
├── README.txt                           # App Store compliant plain-text description (no Markdown/URLs)
├── .homeychangelog.json                 # Homey App Store changelog
├── package.json                         # Dependencies (ws, uuid) & scripts (build, test, test:unit, test:e2e, validate)
├── tsconfig.json                        # Compiles TypeScript to .homeybuild/
├── app.json                             # Generated/composed root Homey SDK v3 manifest
├── app.ts                               # Homey.App singleton initializing connection pool, auth,discovery & flow manager
├── .homeycompose/
│   ├── app.json                         # Base app metadata (id: "com.signalk.marine", sdk: 3, platforms: ["local"])
│   ├── capabilities/                    # Custom marine capabilities:
│   │   ├── measure_sog.json
│   │   ├── measure_stw.json
│   │   ├── measure_depth.json
│   │   ├── measure_heading.json
│   │   ├── measure_cog.json
│   │   ├── measure_tank_level.json
│   │   ├── measure_tank_volume.json
│   │   ├── measure_anchor_distance.json
│   │   ├── measure_anchor_radius.json
│   │   ├── measure_remaining_ah.json
│   │   ├── measure_time_remaining.json
│   │   ├── measure_engine_rpm.json
│   │   ├── measure_engine_hours.json
│   │   ├── measure_fuel_rate.json
│   │   ├── measure_oil_pressure.json
│   │   ├── navigation_state.json
│   │   ├── autopilot_state.json
│   │   └── charger_inverter_mode.json
│   ├── discovery/
│   │   └── signalk.json                 # mDNS-SD _signalk-http._tcp strategy
│   ├── drivers/
│   │   └── templates/
│   │       └── signalk_base.json        # Shared server connection settings & pairing views
│   └── flow/
│       ├── triggers/                    # App & device Flow trigger JSON cards
│       ├── conditions/                  # App & device Flow condition JSON cards
│       └── actions/                     # App & device Flow action JSON cards (Homey -> Signal K bridge & control)
├── lib/
│   ├── UnitConverter.ts                 # SI <-> Homey/Marine unit conversions
│   ├── AnchorWatchCalculator.ts         # Haversine distance, bearing & drift alarm evaluator
│   ├── SafetyBoundary.ts                # Enforces Read/Write vs. Read-Only Signal K path rules
│   ├── HardwarePresets.ts               # Victron, NMEA 2000, 1-Wire/I2C/GPIO, Diesel Heater, RuuviTag presets & paths
│   ├── SignalKAuthManager.ts            # GET /signalk, POST /signalk/v1/access/requests, polling, JWT handling
│   ├── SignalKConnectionPool.ts         # Shared WS (?subscribe=none) + REST client, throttling, delta publishing
│   ├── SignalKPutController.ts          # PUT state machine (202 PENDING -> 200 COMPLETED) + anchor REST fallback
│   ├── PathDiscoveryService.ts          # Auto-discovers batteries, tanks, switches, engines, sensors from /vessels/self
│   └── FlowCardManager.ts               # Registers all triggers, conditions, actions & autocomplete listeners
├── drivers/
│   ├── vessel/                          # Driver 1: Vessel & Anchor Watch (M2)
│   ├── propulsion/                      # Driver 2: Propulsion / Engine — Read-Only (M2)
│   ├── custom-sensor/                   # Driver 3: Custom Signal K Path Sensor (M2)
│   ├── electrical-bank/                 # Driver 4: Battery / Electrical Bank — Homey Energy (M3)
│   ├── fluid-tank/                      # Driver 5: Fluid Tank Monitor (M3)
│   └── digital-switch/                  # Driver 6: Digital Switch / Relay — PUT Enabled (M3)
├── assets/
│   ├── icon.svg                         # 960x960 line-art SVG
│   └── images/                          # small.png (250x175), large.png (500x350)
├── locales/
│   └── en.json                          # English translations
└── test/
    ├── unit/                            # Unit & integration tests for M1–M4 (owned by Implementation Track)
    └── e2e/                             # Opaque-box 4-tier E2E test suite & Mock Signal K server (owned by E2E Track)
```

### Exclusive Write Ownership Rules
- **M1 Worker**: `package.json`, `tsconfig.json`, `.homeycompose/app.json`, `.homeycompose/capabilities/**`, `.homeycompose/discovery/**`, `.homeycompose/drivers/templates/**`, `assets/**`, `locales/**`, `README.txt`, `.homeychangelog.json`, `app.ts`, `lib/UnitConverter.ts`, `lib/AnchorWatchCalculator.ts`, `lib/SafetyBoundary.ts`, `lib/HardwarePresets.ts`, `lib/SignalKAuthManager.ts`, `lib/SignalKConnectionPool.ts`, `lib/SignalKPutController.ts`, `lib/PathDiscoveryService.ts`, `test/unit/m1_*.test.ts`.
- **M2 Worker**: `drivers/vessel/**`, `drivers/propulsion/**`, `drivers/custom-sensor/**`, `test/unit/m2_*.test.ts`.
- **M3 Worker**: `drivers/electrical-bank/**`, `drivers/fluid-tank/**`, `drivers/digital-switch/**`, `test/unit/m3_*.test.ts`.
- **M4 Worker**: `.homeycompose/flow/**`, `lib/FlowCardManager.ts`, composition of `app.json`, integration into `app.ts` and `drivers/**`, `test/unit/m4_*.test.ts`.
- **E2E Testing Track**: `TEST_INFRA.md`, `TEST_READY.md`, `test/e2e/**` (exclusive ownership during parallel execution).
