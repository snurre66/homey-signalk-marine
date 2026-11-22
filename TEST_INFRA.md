# Test Infrastructure (`TEST_INFRA.md`)

## Frameworks & Dependencies
- **Test Runner**: Built-in Node.js Test Runner (`node:test` + `node:assert/strict`, Node `v22.23.5`), zero external package dependencies required to execute `test/e2e/*.test.mjs`.
- **Mock Signal K Server (`test/e2e/harness/mock_signalk_server.mjs`)**: Real local HTTP + RFC 6455 WebSocket server binding to an ephemeral localhost port (`127.0.0.1:0`) supporting:
  - `GET /signalk` discovery endpoint
  - `POST /signalk/v1/access/requests` & `GET /signalk/v1/access/requests/:id` (PENDING -> APPROVED/DENIED JWT token lifecycle)
  - `GET /signalk/v1/api/vessels/self/**` (complete vessel data tree with Victron VE.Direct/Venus OS, NMEA 2000/SeaTalkNG, OpenPlotter 1-Wire/I2C/GPIO, Autoterm/Shelly Diesel Heater, and RuuviTag BLE fixtures, plus `/meta` queries)
  - `PUT /signalk/v1/api/vessels/self/**` (`200 COMPLETED`, `202 PENDING` -> async `COMPLETED`/`502 FAILED`, `405 Method Not Allowed`, `400 Bad Request` multi-source ambiguity, `401/403` auth errors)
  - `POST /plugins/anchoralarm/{dropAnchor,raiseAnchor,setRadius,setRodeLength}` plugin REST fallback endpoints
  - WebSocket `/signalk/v1/stream?subscribe=none` (RFC 6455 handshake, `hello` frame with `self` URN, `subscribe`/`unsubscribe` parsing with rate policies `instant`/`ideal`/`fixed`, WS `put` messages, inbound Homey -> Signal K `updates` delta capture, and outbound live delta broadcast).
- **Homey SDK v3 Runtime Harness & Dynamic Adapter (`test/e2e/harness/homey_runtime_harness.mjs`)**:
  - Dynamically loads real compiled/transpiled or TypeScript application modules from `/home/antigravity/lib/`, `/home/antigravity/drivers/`, `/home/antigravity/app.ts` (or `.homeybuild/`), and `/home/antigravity/.homeycompose/` (`app.json`) when present, and provides a full Homey SDK v3 runtime emulator (`Homey.App`, `Homey.Driver`, `Homey.Device`, `Homey.Flow`, `DiscoveryStrategy`, `PairSession`, `RepairSession`).

## How to Run
```bash
node --test test/e2e/*.test.mjs
```

## Directory Structure
```text
/home/antigravity/test/e2e/
├── helpers/
│   └── rfc6455_ws.mjs                   # Self-contained RFC 6455 WebSocket Server & Client implementation
├── harness/
│   ├── fixtures.mjs                     # Full OpenPlotter / Signal K vessel fixtures (Victron, N2K, 1-Wire/GPIO, Diesel Heater, RuuviTag)
│   ├── mock_signalk_server.mjs          # Ephemeral localhost HTTP REST + WS Mock Signal K Server
│   └── homey_runtime_harness.mjs        # Homey SDK v3 runtime emulator & dynamic real-module loader
├── tier1_feature_coverage.test.mjs      # Tier 1: >= 75 happy-path tests (>= 5 per feature F1–F15)
├── tier2_boundary_corner.test.mjs       # Tier 2: >= 75 boundary, negative & error tests (>= 5 per feature F1–F15)
├── tier3_cross_feature.test.mjs         # Tier 3: >= 15 pairwise cross-feature interaction tests
└── tier4_boat_scenarios.test.mjs        # Tier 4: >= 10 tests across 8 realistic end-to-end smart-boat scenarios
```

## Feature Coverage Checklist

| # | Feature | Tier 1 (Happy Path >= 5) | Tier 2 (Boundary/Error >= 5) | Tier 3 (Cross-Feature) | Tier 4 (Boat Scenarios) | Status |
|---|---------|--------------------------|------------------------------|------------------------|-------------------------|--------|
| F1 | `.homeycompose` Modular App Manifest & App Store Assets | 5+ tests | 5+ tests | Pairwise manifest/driver/flow checks | Scenario 8 | Planned |
| F2 | Deterministic SI <-> Marine Unit Converter (`UnitConverter`) | 5+ tests | 5+ tests | Pairwise WS delta -> unit -> capability | Scenarios 1–6 | Planned |
| F3 | Built-in Haversine GPS Anchor Drift Calculator (`AnchorWatchCalculator`) | 5+ tests | 5+ tests | Pairwise plugin vs Haversine fallback | Scenario 1 | Planned |
| F4 | Signal K Discovery, Auth & Access Request Manager (`SignalKAuthManager`) | 5+ tests | 5+ tests | Pairwise mDNS + Auth + Repair | Scenarios 1, 7 | Planned |
| F5 | Shared Multiplexed WebSocket & REST Connection Pool (`SignalKConnectionPool`) | 5+ tests | 5+ tests | Pairwise multi-driver WS multiplexing + `$source` + throttling | Scenarios 1–7 | Planned |
| F6 | Safety-Boundary Enforced `PUT` Control & Hardware Presets (`SignalKPutController`, `HardwarePresets`) | 5+ tests | 5+ tests | Pairwise PUT + async 202 + safety blocklist + anchor fallback | Scenarios 1, 2, 3, 5 | Planned |
| F7 | Vessel & Anchor Watch Driver (`drivers/vessel`) | 5+ tests | 5+ tests | Pairwise vessel telemetry + anchor watch + mDNS IP change | Scenarios 1, 5, 7 | Planned |
| F8 | Propulsion / Engine Driver (`drivers/propulsion`) | 5+ tests | 5+ tests | Pairwise N2K engine telemetry + read-only enforcement | Scenario 5 | Planned |
| F9 | Custom Signal K Path Sensor Driver (`drivers/custom-sensor`) | 5+ tests | 5+ tests | Pairwise `$source` pinning + custom unit conversion + 1-Wire/RuuviTag | Scenarios 3, 4 | Planned |
| F10 | Battery / Electrical Bank Driver (`drivers/electrical-bank`) | 5+ tests | 5+ tests | Pairwise Victron SmartShunt/MPPT/MultiPlus + Homey Energy + load-shedding PUT | Scenario 2 | Planned |
| F11 | Fluid Tank Monitor Driver (`drivers/fluid-tank`) | 5+ tests | 5+ tests | Pairwise multi-tank volume/level + high/low alarms | Scenario 6 | Planned |
| F12 | Digital Switch / Relay Driver (`drivers/digital-switch`) | 5+ tests | 5+ tests | Pairwise switch `onoff`/`dim` PUT + `202 PENDING` -> `502 FAILED` rollback | Scenarios 2, 3, 4 | Planned |
| F13 | Bidirectional Sensor Bridge Flow Action Cards (Homey -> Signal K) | 5+ tests | 5+ tests | Pairwise Homey sensor -> SI conversion (`°C->K`, `%->ratio`, `mbar->Pa`) -> WS delta -> Signal K | Scenarios 3, 4 | Planned |
| F14 | Anchor Watch, Notification & Battery Load-Shedding Flow Cards | 5+ tests | 5+ tests | Pairwise trigger -> condition -> action automation chain | Scenarios 1, 2, 3, 4, 6 | Planned |
| F15 | Full App Composition, CLI Build/Validation & Final E2E Verification | 5+ tests | 5+ tests | Full E2E integration across all 6 drivers & manifest schema rules | Scenario 8 | Planned |
