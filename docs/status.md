# Implementation status

Snapshot of what's built vs. what's specified. Spec is the source of truth for *what* should exist; this file is the source of truth for *where it is*. Updated by hand when major pieces land.

Status values: `shipped`, `partial`, `not started`.

---

## Wire protocol: `packages/protocol/`

Source: [`docs/spec/protocol-v0.2.md`](spec/protocol-v0.2.md)

| Area                                       | Status | Notes                                                                                          |
| ------------------------------------------ | :----: | ---------------------------------------------------------------------------------------------- |
| Common event envelope                      | shipped | `eventEnvelope(...)`, `commandEnvelope(...)` factories. JSON over MQTT.                        |
| Topic builders + parser (`topics.ts`)      | shipped | All topic shapes from the spec, plus `parseEventTopic` round-trip.                             |
| Core event schemas (12 types)              | shipped | `device_registered`, `tag_observed`, `marker_traversed`, `train_status`, clearance \*, `gate_state_changed`, `switch_state_changed`, `aspect_changed`, `tag_assignment`, `anomaly`. |
| Core command schemas (8 types)             | shipped | `assign_route`, `grant_clearance`, `revoke_clearance`, `set_target_speed`, `emergency_stop`, `set_switch_position`, `set_aspect`, `assign_tag`. |
| Capability identifiers                     | shipped | `BUILTIN_CAPABILITIES` enum + `CapabilityId` regex.                                            |
| `DeviceManifest` schema                    | shipped | Used by examples; not yet enforced by anything that loads manifests.                           |
| Layout schema                              | shipped | Markers, edges, junctions. Optional spatial fields.                                            |
| `protocol_version` literal                 | shipped | `0.2.0` exported as `PROTOCOL_VERSION`.                                                        |
| `hold_gate` / `release_gate` commands      | shipped | Server-side override of local gate logic. `VirtualGate.acceptCommand` honours them and publishes the matching `gate_state_changed`. |
| `vehicle_identified` event schema          | shipped | `{ vehicle_id, context_device_id }`. The scheduler already derives these from vehicle-tag observations.                                |

Coverage: 100% lines, 100% branches.

---

## Core: `packages/core/`

Source: spec §"Capability model", §"Clearance model"; [`ADR-001`](adr/001-capability-based-extensibility.md), [`ADR-002`](adr/002-clearance-model.md), [`ADR-005`](adr/005-existential-types-for-registry.md)

| Area                                      | Status | Notes                                                                                          |
| ----------------------------------------- | :----: | ---------------------------------------------------------------------------------------------- |
| `Capability<State>` author-facing type    | shipped | + `RegisteredCapability` existential wrapper + `wrap()` adapter.                               |
| `CapabilityRegistry`                      | shipped | `register`, `registerAll`, `freeze`, `validateDeviceCapabilities`, lookup.                     |
| `core.gates_clearance` built-in           | shipped | Full `onEvent` + `onClearanceConsultation` + `onDeviceDisconnect` hooks.                       |
| Other built-in capabilities               | partial | Stubs for `controls_motion`, `accepts_route`, `controls_switch`, `displays_aspect`, `identifies_vehicles`, `reports_marker_traversal`. `core.assigns_tags` is now real: scheduler enforces that only devices declaring it can mutate the `TagRegistry`. |
| Tag-to-entity registry (`TagRegistry`)    | shipped | Sibling of `LayoutState`. Populated only by `tag_assignment` events from `core.assigns_tags` devices; resolves `tag_observed` to `marker_traversed` or `vehicle_identified`. Retained on `railway/state/tags/<tag_id>`. ADR-007. |
| Scheduler: route assignment               | shipped | `assignRoute` + initial clearance grant.                                                       |
| Scheduler: clearance extension            | shipped | At-marker → grant next edge unless any capability denies. Block exclusivity.                   |
| Scheduler: gate-release re-grant          | shipped | After capability state changes, retries blocked clearances.                                    |
| Scheduler: switch-state edge filtering    | shipped | Refuses to clear an edge whose `requires_switch_state` doesn't match the junction's confirmed position. Retries blocked clearances when a switch confirms. |
| `LayoutState`                             | shipped | Edges, marker lookup, switch positions, runtime `upsertMarker`, edge inference via `recordTraversal`, inferred→confirmed flip on N traversals (ADR-009), `toLayout()` serialiser for republishing as retained state. |
| Anomaly emission for unknown tags         | shipped | `tag_observed` against unregistered marker → anomaly event.                                    |
| Conflict resolution policy                | not started | Open design Q (CLAUDE.md). Block exclusivity is first-come-by-clearance-grant; no priorities. |
| Multi-gate semantics                      | not started | Open design Q. Today: any deny is a deny (logical AND).                                        |
| Topology violation handling               | not started | Open design Q. Today: silently ignored.                                                        |

Coverage thresholds: 75 lines / 75 branches (low to allow for remaining LayoutState work; raise to 85 once discovery lands).

---

## Simulator (test harness): `packages/simulator/`

Source: [`docs/spec/simulator-v0.1.md`](spec/simulator-v0.1.md); [`ADR-006`](adr/006-physical-mishap-simulation.md)

| Area                                              | Status | Notes                                                                          |
| ------------------------------------------------- | :----: | ------------------------------------------------------------------------------ |
| In-process `Simulation` with scheduler + devices  | shipped | Pure-TS, broker-free, deterministic.                                           |
| `VirtualClock`                                    | shipped | Step-driven (`advance(ms)`).                                                   |
| `SeededRandom`                                    | shipped | Bernoulli + normal sources.                                                    |
| `VirtualTrain`                                    | shipped | Position/velocity, braking, route execution, marker emission with latency.    |
| `VirtualGate`                                     | shipped | Withhold/release per marker.                                                   |
| `Simulation.onEvent` listener API                 | shipped | Used by simulator-ui to bridge events onto MQTT.                              |
| Device-only mode (`disableScheduler` + `BrokerBridge`) | shipped | Run virtual devices against a real broker + server with no embedded scheduler. Bridges `simulation.onEvent` → `railway/events/...` and routes `railway/commands/...` to `simulation.handleCommand()`. E2E covered by `@trainframe/integration`. |
| Realistic-time mode                               | partial | simulator-ui drives `setInterval` advance; no first-class realtime mode in the package. |
| Detection: miss rate                              | shipped | `miss_rate` knob on train config.                                              |
| Detection: latency (mean+stddev)                  | shipped | `detection_latency_ms`.                                                        |
| Detection: double-read rate                       | shipped | `double_read_rate` knob on `VirtualTrainConfig`. On hit, a second `tag_observed` fires after an additional N(10, 5) ms latency. |
| Detection: spurious-read rate                     | shipped | `spurious_read_rate` knob. Each tick rolls a Bernoulli; on hit emits `tag_observed` with `tag_id = spurious-<random>` to trigger an Unknown-tag anomaly downstream. |
| Mishap: overshoot                                 | shipped | Sticky per-edge brake-fail, anomaly emission. ADR-006.                         |
| Mishap: derailment                                | not started | Framing in ADR-006; deferred to per-train UI controls.                         |
| `WiFiTransport` / `EspNowTransport`               | not started | Spec defines; the package today has no transport abstraction (in-process only).|
| Virtual bridge with frame loss/reorder/latency    | not started | Bridge fault injection.                                                        |
| Fault profiles (`pristine`/`realistic`/`hostile`) | shipped | `FAULT_PROFILES` map in `@trainframe/simulator/testing`. Tests pick by name; per-train overrides win. |
| `startTestEnvironment` harness API                | shipped | `@trainframe/simulator/testing` exports `startTestEnvironment({layout, seed, faults, tags})`. Bundles a seeded `Simulation` with identity-tag seeding and `waitForEvent`, `advance`, `spawnTrain`, `assignRoute` helpers. In-process today; broker-backed variant deferred. |
| `registerVirtualCapability` extensibility         | not started | Satellite virtual devices have nowhere to register. `extraCapabilities` only handles core-side hooks. |
| `attachDevice` (load real device into harness)    | not started | For satellite-author testing; depends on the harness API.                      |

Coverage thresholds: 80 lines / 75 branches.

---

## Server: `packages/server/`

Source: spec §"Transport: MQTT" (server is what runs the scheduler against a real broker)

| Area                                              | Status | Notes                                                                          |
| ------------------------------------------------- | :----: | ------------------------------------------------------------------------------ |
| Composition of broker client + scheduler          | shipped | `Server` class wires `BrokerClient` (in-memory + mqtt-backed impls) into `Scheduler`. |
| MQTT connection (real broker)                     | shipped | `MqttBrokerClient` over MQTT 3.1.1 (universal: Mosquitto, aedes).               |
| Subscribe `railway/events/+/+`, dispatch into scheduler | shipped | Loose JSON parsing; malformed/self-emitted events dropped.                     |
| Publish `SchedulerEffect`s as commands/events     | shipped | `send_command` → `railway/commands/{device_id}`; `publish_event` → `railway/events/{type}/server`; `update_state_snapshot` → `railway/state/{type}/{id}` retained. |
| Retained `railway/state/layout/<name>` snapshot   | shipped | Published on `Server.start()`.                                                 |
| Minimal CLI (`tf-server`)                         | shipped | `--layout <path> [--broker mqtt://…]`. SIGINT/SIGTERM clean shutdown.          |
| HTTP admin API (assignRoute, hold/release, tags)  | shipped | `AdminHttpServer` on a configurable port (default 3000). Endpoints: `/api/health`, `/api/state`, `/api/trains/:id/route`, `/api/trains/:id/revoke_clearance`, `/api/gates/:id/hold`, `/api/gates/:id/release`, `/api/tags`. CLI: `--http-port`. No auth (LAN/localhost). ADR-008. |
| Custom-event dispatch (`railway/events/custom/...`) | not started | Server only subscribes to four-segment core events.                            |
| Authentication / pairing                          | not started | Spec §"Authentication" defers details to garage-device pairing.                |
| Discovery mode (learning new edges/markers)       | shipped | ADR-009. Marker creation on `tag_assignment`, edge inference on traversal, confirmation after 3 traversals (configurable). Layout republished as retained state on every change. Edge-length learning and cautious-clearance follow-ups deferred. |
| Simulator-ui device-only mode                     | not started | The browser sim still runs its own scheduler in-process. Once the real server is in operator use, the sim should publish raw device events and let the server schedule. |

Coverage thresholds: 75 lines / 65 branches / 65 functions (new package; ratchet up as the surface stabilises).

---

## Visualiser: `packages/visualiser/`

| Area                                       | Status | Notes                                                                         |
| ------------------------------------------ | :----: | ----------------------------------------------------------------------------- |
| Static-shell deployment                    | shipped | Pages-deployed, broker URL via localStorage.                                   |
| MQTT-over-WS subscriber                    | shipped | `BrokerSubscriber` interface + `mqtt`-backed prod client + in-memory test impl.|
| Connection status UI                       | shipped |                                                                               |
| Live event log                             | shipped | Rolling 100, newest-first, loose parsing, custom-event vendor surfaced.       |
| Layout rendering (markers, edges)          | shipped | SVG canvas. Auto-places markers around a circle when no spatial coords; uses `position.x_mm/y_mm` when present. |
| Train-position rendering                   | shipped | Mid-edge interpolation from `train_status` events; falls back to last `marker_traversed` marker when no status yet. |
| Layout snapshot bootstrap                  | shipped | `useLayoutState` subscribes to `railway/state/layout/+`; simulator-ui publishes the active layout retained on start. |
| Tag-assignment UI                          | shipped | `UnknownTags` component surfaces unknown-tag anomalies and POSTs `tag_assignment` requests to the server's admin HTTP API. Plays the discovery loop: anomaly → operator picks target → registry binds → row vanishes. |
| Discovery / topology learning UI           | shipped | Discovered markers and inferred edges show up in the layout SVG live. Inferred edges render dashed (`stroke-dasharray="8 6"`) with `data-inferred="true"`; confirmed edges stay solid. |

---

## Simulator UI: `packages/simulator-ui/`

| Area                                       | Status | Notes                                                                         |
| ------------------------------------------ | :----: | ----------------------------------------------------------------------------- |
| Static-shell deployment                    | shipped | Pages-deployed, broker URL via localStorage.                                   |
| `SimRunner` bridge → MQTT publish          | shipped | Event envelope construction, snapshot listeners.                               |
| Lifecycle controls                         | shipped | Start / Resume / Pause / Stop / Step.                                          |
| Track configuration UI                     | shipped | Preset dropdown + custom-JSON editor, persisted in localStorage.               |
| Spawn-train form (per-train config)        | shipped | Inline form on `SimControls` lets the operator pick `train_id`, `overshoot_rate`, `miss_rate` before spawning. Threaded through `useSimRunner` → `SimRunner.spawnTrain` → `Simulation.spawnTrain(config)`. |
| Realtime-mode auto-advance                 | shipped | `setInterval` + `tick_ms`. No speed multiplier yet.                            |
| Retained layout state publish              | shipped | `SimRunner.start()` publishes the active layout to `railway/state/layout/<name>` retained. |
| Mishap rate UI                             | shipped | Overshoot + miss rate exposed on the spawn form; double-read and spurious-read knobs available on the simulator but not yet on the form. |
| Inbound command subscription (broker → sim)| shipped | `SimRunner` accepts `mode: 'device-only'`, which constructs the `Simulation` without an embedded scheduler and wires `BrokerBridge` to forward `railway/commands/<device>` into the sim. Operator-facing UI still defaults to `embedded`. |

---

## Capabilities (built-in implementations)

| Capability                          | Status | Notes                                                                          |
| ----------------------------------- | :----: | ------------------------------------------------------------------------------ |
| `core.gates_clearance`              | shipped | Full implementation; reference for satellite authors.                          |
| `core.controls_switch`              | not started | Stub. Needs `set_switch_position` command handling, `switch_state_changed` event handling, edge filtering when `requires_switch_state` mismatches the active position. |
| `core.controls_motion`              | not started | Stub. Today the train acts on commands directly; the capability isn't doing anything. |
| `core.accepts_route`                | not started | Stub.                                                                          |
| `core.identifies_vehicles`          | not started | Stub.                                                                          |
| `core.reports_marker_traversal`     | not started | Stub. The scheduler currently special-cases `tag_observed` from a `controls_motion` device. |
| `core.displays_aspect`              | not started | Stub. `set_aspect` / `aspect_changed` round-trip not wired.                    |
| `core.assigns_tags`                 | not started | Stub. Tag→marker resolution registry doesn't exist (open Q).                   |

---

## Cross-package integration tests: `packages/integration/`

Private workspace package. Spawns an in-process [aedes](https://www.npmjs.com/package/aedes) broker on a random port per test, runs the real `@trainframe/server` against it via `MqttBrokerClient`, and acts as device + operator + visualiser through the wire. Tests are written in `given … when … then …` user-action language.

| Area                                              | Status | Notes                                                                          |
| ------------------------------------------------- | :----: | ------------------------------------------------------------------------------ |
| aedes-based test harness                          | shipped | `startHarness({ layout })` → `{ server, testClient, shutdown }`. Random port, MQTT 3.1.1. |
| `TestClient` device/operator surrogate            | shipped | `publishEvent`, `waitForCommand`, `waitForState`, `commandsFor`, `retained`, `events`. |
| Clearance flow E2E test                           | shipped | Initial grant, gate withholds, gate releases, retained layout bootstrap.       |
| Simulator-driven E2E (sim publishes device events)| shipped | `simulator-bridge.test.ts` drives a `Simulation` (device-only mode) through `BrokerBridge` against the real server. |
| Browser-driven UI E2E (clicks + SVG assertions)   | shipped | Lives in `@trainframe/ui-tests` (separate package, Playwright + Chromium). |

Coverage thresholds: disabled. The package IS the cross-cutting coverage; gating itself on its own coverage is circular.

---

## Browser UI tests: `packages/ui-tests/`

Private workspace package. Spawns the simulator-ui Vite preview, an aedes broker over WebSockets, and a real `@trainframe/server` against it; drives Chromium through Playwright and asserts on rendered DOM.

| Area                                              | Status | Notes                                                                          |
| ------------------------------------------------- | :----: | ------------------------------------------------------------------------------ |
| Playwright + Chromium setup                       | shipped | `playwright.config.ts` with `webServer` for `vite preview`; chromium-only project. |
| `startUiHarness` (aedes WS + server + bridged sim)| shipped | WebSocket listener with MQTT-subprotocol selection. Also wires a device-only `Simulation` to the broker via `BrokerBridge`, so admin HTTP commands actually reach virtual trains/gates. Reused by per-spec `beforeAll`. |
| Lifecycle smoke test                              | shipped | Start, Spawn, Step against the embedded sim (no broker required). |
| Connected-to-broker test                          | shipped | UI connects to aedes via WS, `device_registered` round-trips through the server. |
| Operator journeys                                 | shipped | `multi-train-journey`, `tag-assignment`, `discovery`, `feature-showcase`, plus five new specs: `route-reassignment` (expects `cleared_edges`-wipe fix), `unknown-tag-closure` (bound-tag → train lands on marker), `spawn-form-mishaps` (overshoot knob → anomaly in EventLog), `layout-swap` (preset swap + invalid-JSON error), `gate-hold-release` (admin HTTP hold/release → train stops/advances). |
| Visualiser SVG assertions                         | shipped | `data-train-id` / `data-at-marker` / `data-on-edge` / `data-marker-id` / `data-inferred` assertions are routine across the new specs. |

Coverage thresholds: not applicable (Playwright; covered by E2E pass/fail).

---

## Documentation

| Doc                                            | Status | Notes                                                                          |
| ---------------------------------------------- | :----: | ------------------------------------------------------------------------------ |
| `docs/spec/protocol-v0.2.md`                   | shipped | Frozen working draft. Open Qs listed at end.                                   |
| `docs/spec/simulator-v0.1.md`                  | shipped | Frozen.                                                                        |
| `docs/contributing/new-device.md`              | shipped | Walkthrough: panic-button device against the simulator.                        |
| `docs/contributing/new-capability.md`          | shipped |                                                                                |
| ADRs 001–006                                   | shipped | Capability extensibility, clearance, MQTT, edge-routes, existentials, mishaps. |
| `docs/status.md` (this file)                   | shipped | New.                                                                           |
| ADR for HTTP query API split                   | not started | Spec §"Open questions for v0.3" flags this as undecided.                       |
| ADR for tag→marker resolution registry         | not started |                                                                                |
| ADR for conflict resolution policy             | not started |                                                                                |
| ADR for ESP-NOW bridge wire format             | not started |                                                                                |

---

## Open design questions

Mirrored from [`CLAUDE.md`](../CLAUDE.md). Need ADRs before implementation.

- Conflict resolution policy when two trains contend for the same edge.
- Multi-gate semantics: AND vs priority when several `gates_clearance` devices gate the same marker.
- Topology violations: train reports a marker the graph says is unreachable.
- Coupling/decoupling: trains as multi-vehicle compositions.
- Tag→marker resolution at runtime (today: simulator uses marker IDs as tag IDs).
- ESP-NOW bridge wire format for compact frames.

---

## Suggested next priorities

Ranked by leverage. None are mandatory; this is the recommendation, not the plan.

1. **Use learned traversal times for clearance decisions**. `LayoutState.getLearnedTraversalMs` now accumulates EWMA times per edge; nothing reads it yet. Wire it into braking-distance / clearance-extension logic so trains learn to slow earlier on long edges.
2. **Surface `train_status` battery + error_state in the visualiser**. Schema fields exist but the visualiser ignores them.

Smaller follow-ups that don't need a major thread:

- ADR + implementation for missing detection knobs (double-read, spurious read).
- Per-train spawn config form in simulator-ui (mishap rate knobs from ADR-006).
