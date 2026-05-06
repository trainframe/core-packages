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
| `hold_gate` / `release_gate` commands      | not started | Mentioned in spec; not in `commands.ts`. Server-side override of local gate logic.             |
| `vehicle_identified` event schema          | not started | Spec defines; not yet a TypeBox schema in `events.ts`.                                         |

Coverage: 100% lines, 100% branches.

---

## Core: `packages/core/`

Source: spec §"Capability model", §"Clearance model"; [`ADR-001`](adr/001-capability-based-extensibility.md), [`ADR-002`](adr/002-clearance-model.md), [`ADR-005`](adr/005-existential-types-for-registry.md)

| Area                                      | Status | Notes                                                                                          |
| ----------------------------------------- | :----: | ---------------------------------------------------------------------------------------------- |
| `Capability<State>` author-facing type    | shipped | + `RegisteredCapability` existential wrapper + `wrap()` adapter.                               |
| `CapabilityRegistry`                      | shipped | `register`, `registerAll`, `freeze`, `validateDeviceCapabilities`, lookup.                     |
| `core.gates_clearance` built-in           | shipped | Full `onEvent` + `onClearanceConsultation` + `onDeviceDisconnect` hooks.                       |
| Other built-in capabilities               | partial | Stubs only. `controls_motion`, `accepts_route`, `controls_switch`, `displays_aspect`, `identifies_vehicles`, `reports_marker_traversal`, `assigns_tags`: declared but no hook logic. |
| Scheduler: route assignment               | shipped | `assignRoute` + initial clearance grant.                                                       |
| Scheduler: clearance extension            | shipped | At-marker → grant next edge unless any capability denies. Block exclusivity.                   |
| Scheduler: gate-release re-grant          | shipped | After capability state changes, retries blocked clearances.                                    |
| Scheduler: switch state events            | partial | Stores position in `LayoutState`; doesn't yet enforce `requires_switch_state` on edges.        |
| `LayoutState`                             | partial | Edges, marker lookup, switch positions. No discovery learning, no `inferred` flag handling.    |
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
| Realistic-time mode                               | partial | simulator-ui drives `setInterval` advance; no first-class realtime mode in the package. |
| Detection: miss rate                              | shipped | `miss_rate` knob on train config.                                              |
| Detection: latency (mean+stddev)                  | shipped | `detection_latency_ms`.                                                        |
| Detection: double-read rate                       | not started | Spec'd, not implemented.                                                       |
| Detection: spurious-read rate                     | not started | Spec'd, not implemented.                                                       |
| Mishap: overshoot                                 | shipped | Sticky per-edge brake-fail, anomaly emission. ADR-006.                         |
| Mishap: derailment                                | not started | Framing in ADR-006; deferred to per-train UI controls.                         |
| `WiFiTransport` / `EspNowTransport`               | not started | Spec defines; the package today has no transport abstraction (in-process only).|
| Virtual bridge with frame loss/reorder/latency    | not started | Bridge fault injection.                                                        |
| Fault profiles (`pristine`/`realistic`/`hostile`) | not started | Spec'd named bundles. Today every config is per-test.                          |
| `startTestEnvironment` harness API                | not started | Spec'd in §"Testing harness API". Today tests construct a `Simulation` directly. |
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
| HTTP / MQTT admin API (assignRoute, etc.)         | partial | `Server.assignRoute` exists as a method; no remote endpoint yet.               |
| Custom-event dispatch (`railway/events/custom/...`) | not started | Server only subscribes to four-segment core events.                            |
| Authentication / pairing                          | not started | Spec §"Authentication" defers details to garage-device pairing.                |
| Discovery mode (learning new edges/markers)       | not started | Spec §"Incremental discovery". Major scheduler+layout work.                    |
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
| Layout rendering (markers, edges)          | not started | Spec §"Spatial layout": visualiser auto-routes curves between markers.       |
| Train-position rendering                   | not started | From `train_status` + `marker_traversed` events.                              |
| Layout snapshot bootstrap                  | not started | Subscribe `railway/state/#` for current world.                                 |
| Tag-assignment / discovery UI              | not started | Spec §"Incremental discovery": user assigns kind to unknown tags.             |

---

## Simulator UI: `packages/simulator-ui/`

| Area                                       | Status | Notes                                                                         |
| ------------------------------------------ | :----: | ----------------------------------------------------------------------------- |
| Static-shell deployment                    | shipped | Pages-deployed, broker URL via localStorage.                                   |
| `SimRunner` bridge → MQTT publish          | shipped | Event envelope construction, snapshot listeners.                               |
| Lifecycle controls                         | shipped | Start / Resume / Pause / Stop / Step.                                          |
| Track configuration UI                     | shipped | Preset dropdown + custom-JSON editor, persisted in localStorage.               |
| Spawn-train form (per-train config)        | partial | Today: a single button spawns the next `T<n>` along the layout's first three edges. No per-train physics knobs (e.g. overshoot). |
| Realtime-mode auto-advance                 | shipped | `setInterval` + `tick_ms`. No speed multiplier yet.                            |
| Mishap rate UI                             | not started | `overshoot_rate` is config-only; needs operator-facing knobs (ADR-006 §"Out of scope"). |
| Inbound command subscription (broker → sim)| not started | Today the sim runs the scheduler in-process. Once a real server exists, the sim should accept commands. |

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
| Simulator-driven E2E (sim publishes device events)| not started | Needs `@trainframe/simulator` to support a "device-only" transport mode (no embedded scheduler). Out-of-scope for the harness as-is. |
| Browser-driven UI E2E (clicks + SVG assertions)   | not started | Out of this package. Will live in a separate Playwright-based package when added. |

Coverage thresholds: disabled. The package IS the cross-cutting coverage; gating itself on its own coverage is circular.

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

1. **Visualiser layout rendering**. Markers + edges as SVG, train positions from `train_status`. Closes the loop on the simulator → broker → visualiser flow that's currently log-only. Self-contained, testable, immediately demo-able.
2. **`packages/server` first cut**. Broker client + scheduler dispatch + retained-state publishing. Unblocks every "real hardware" path. Largest single piece of unbuilt code in the repo.
3. **`controls_switch` capability + edge filtering**. The scheduler should refuse to clear an edge whose `requires_switch_state` doesn't match the current switch position. Modest scheduler change, satisfies a major feature in the spec, enables interesting layouts (figure-8 with junction).
4. **Tag→marker resolution registry + `assigns_tags` + ADR**. Moves the simulator and protocol off the "tag IDs ARE marker IDs" shortcut. Prerequisite for discovery mode.
5. **Discovery mode / topology learning**. Ingest `tag_observed` for unknown tags, infer edges, ratchet `inferred → confirmed` after N traversals. Spec §"Incremental discovery". Scheduler + layout-state work.
6. **`startTestEnvironment` harness + fault profiles**. Replace the ad-hoc `new Simulation(...)` pattern in tests with the harness the simulator spec describes. Profiles, `attachDevice`, `waitForEvent`. Pays off as more capabilities ship.

Smaller follow-ups that don't need a major thread:

- ADR + implementation for missing detection knobs (double-read, spurious read).
- `hold_gate` / `release_gate` commands (server-side override of local gate logic).
- `vehicle_identified` event schema in `packages/protocol/`.
- Per-train spawn config form in simulator-ui (mishap rate knobs from ADR-006).
- Bundle-size / code-splitting on the two Vite apps (currently 569 kB each).
