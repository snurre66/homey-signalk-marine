# E2E Test Suite Ready (`TEST_READY.md`)

## Summary of the Complete E2E Suite

The end-to-end verification suite for the **Signal K Marine** Homey SDK v3 application is implemented under `/home/antigravity/test/e2e/` using Node.js's built-in test runner (`node:test`) and `node:assert/strict` with zero external runtime test dependencies.

### Test Suites & Counts

| Tier | File | Scope | Test Count |
|------|------|-------|------------|
| **Tier 1** | `test/e2e/tier1_feature_coverage.test.mjs` | Feature Coverage Happy-Path E2E Suite across F1–F15 | **79** |
| **Tier 2** | `test/e2e/tier2_boundary_corner.test.mjs` | Boundary, Negative & Error Cases across F1–F15 | **77** |
| **Tier 3** | `test/e2e/tier3_cross_feature.test.mjs` | Pairwise Cross-Feature Interaction Tests across F1–F15 | **16** |
| **Tier 4** | `test/e2e/tier4_boat_scenarios.test.mjs` | 8 Realistic End-to-End Smart-Boat Scenarios | **10** |
| **Total** | `test/e2e/*.test.mjs` | Complete F1–F15 Verification | **182** |

### Tier 3 Cross-Feature Coverage (`tier3_cross_feature.test.mjs` — 16 tests)
- **CF-01 (F1 + F15)**: Manifest validation, 6 drivers, 18 custom capabilities, mDNS strategy, and Flow listener binding on `Homey.App` boot.
- **CF-02 (F4 + F5 + F7)**: Server discovery -> access request JWT approval -> vessel pairing -> token revocation (`401`) -> `onRepair` access request recovery.
- **CF-03 (F5 + F9 + F12)**: Multi-driver WebSocket multiplexing (`?subscribe=none`), `$source` pinning, and slow/fast tier throttling.
- **CF-04 (F6 + F12 + F14)**: Safety boundary blocklist + async `202 PENDING` completion & `502 FAILED` optimistic UI rollback.
- **CF-05 (F3 + F6 + F7)**: Anchor Watch `405` plugin fallback (`signalk-anchoralarm-plugin`) + Haversine GPS drift fallback.
- **CF-06 (F2 + F7 + F14)**: `UnitConverter` speed unit setting + live WebSocket delta -> `path_value_updated` trigger -> `path_value_comparison` condition -> `put_signalk_path` action.
- **CF-07 (F2 + F5 + F13)**: Bidirectional Homey sensor bridge (`°C -> K`, `% -> ratio`, `hPa -> Pa`) -> WebSocket delta -> paired Signal K sensors.
- **CF-08 (F5 + F13 + F14)**: Homey security notification bridge -> Signal K -> `signalk_notification_raised` -> `is_alarm_active` -> `clear_signalk_notification`.
- **CF-09 (F6 + F10 + F14)**: Battery SOC drop -> `battery_soc_below_threshold` -> `is_battery_soc_below` -> MultiPlus inverter `eco` mode PUT.
- **CF-10 (F6 + F8 + F14)**: Propulsion read-only safety enforcement + live NMEA 2000 engine telemetry + overheat alarm notification chain.
- **CF-11 (F4 + F5 + F7 + F10)**: mDNS IP/port change (`onDiscoveryAddressChanged`) migrating shared WebSocket pool across vessel and battery devices.
- **CF-12 (F2 + F11 + F14)**: Fluid tank level-to-volume derivation + low fresh water / high black water alarms + `is_alarm_active` condition.
- **CF-13 (F5 + F12 + F13)**: Bidirectional switch bridge + dimmer `dimmingLevel` PUT syncing `.state`.
- **CF-14 (F7 + F12 + F14)**: Automation chain (`navigation_state_changed` -> `is_vessel_state` / `is_anchor_armed` -> `arm_anchor_watch` + `anchorLight`).
- **CF-15 (F2 + F10 + F14)**: Shore power loss (`shore_power_status_changed`) + `W = V * I` battery power fallback + water heater load shedding.
- **CF-16 (F2 + F5 + F9)**: `custom-sensor` live `onSettings` rebinding of path, unit category, `$source` filter, and throttle tier.

### Tier 4 Smart-Boat Scenarios (`tier4_boat_scenarios.test.mjs` — 10 tests across 8 scenarios)
1. **Scenario 1 — Anchor Drift Watch (`SC1-01`, `SC1-02`)**: Drop anchor via plugin fallback, masthead anchor light, Haversine GPS drag detection, cabin red alarm light, plugin alarm override, and anchor raise/clear.
2. **Scenario 2 — Victron Battery Load Shedding (`SC2-01`, `SC2-02`)**: Shore power disconnect, solar MPPT drop, SmartShunt SOC < 30% -> MultiPlus `eco` mode + water heater & fridge relay shedding, plus critical battery alarm and `502` relay rollback.
3. **Scenario 3 — Diesel Heater & Cabin Comfort (`SC3-01`)**: Homey Zigbee cabin temperature bridged (`°C -> K`) to Signal K triggering Autoterm/Shelly diesel heater relay and saloon LED dimmer.
4. **Scenario 4 — RuuviTag & Bilge Alarm (`SC4-01`)**: RuuviTag BLE humidity bridge + GPIO bilge water `emergency` notification triggering main bilge pump and notification clearance.
5. **Scenario 5 — NMEA 2000 Engine & Sailing Telemetry (`SC5-01`)**: Live motor-sailing NMEA 2000 stream across vessel and twin propulsion devices with strict read-only safety boundary enforcement on autopilot and engines.
6. **Scenario 6 — Fluid Tank Monitoring (`SC6-01`)**: Multi-tank voyage monitoring (`freshWater`, `fuel`, `blackWater`) with low/high threshold alarms and fresh water pump shutoff.
7. **Scenario 7 — mDNS IP Change & Reconnect (`SC7-01`)**: DHCP IP/port reassignment via mDNS discovery, shared WebSocket migration, and exponential-backoff recovery after transient Wi-Fi drop.
8. **Scenario 8 — Full App Lifecycle (`SC8-01`)**: Full boot, publish-level manifest/asset validation, pairing across all 6 drivers, simultaneous live streaming, bidirectional Flow bridge, and clean `onUninit` shutdown.

## How to Run

Execute the full E2E suite from `/home/antigravity`:

```bash
node --test test/e2e/*.test.mjs
```

To run individual tiers:

```bash
node --test test/e2e/tier1_feature_coverage.test.mjs
node --test test/e2e/tier2_boundary_corner.test.mjs
node --test test/e2e/tier3_cross_feature.test.mjs
node --test test/e2e/tier4_boat_scenarios.test.mjs
```
