# Implementation status

What exists in the code today. The spec and ADRs say what should exist and why; this page says where it is. History belongs in `git log`, not here.

Status values: `shipped`, `partial`, `not started`. Protocol version: `0.16.0` (`packages/protocol/src/version.ts`), TCF registry epoch 7.

## Protocol: `packages/protocol/`

Spec: [`docs/spec/protocol-v0.2.md`](spec/protocol-v0.2.md). Coverage floor: 90 lines, 85 branches.

| Area | Status | Notes |
| --- | :---: | --- |
| Envelope, topic builders and parser | shipped | `envelope.ts`, `topics.ts` |
| Event schemas | shipped | `events.ts`: registration, tag/marker/vehicle, `train_status`, clearance, gate/switch/zone state, `topology_violation`, `train_length_changed`, `zone_train_released`, `device_discovered`, `device_association`, `train_introduced`, `train_introduction_conflict`, `anomaly` |
| Command schemas | shipped | `commands.ts`: `assign_route`, `grant_clearance`, `revoke_clearance`, `begin_exploration`, `grant_reverse`, `introduce_train`, `set_target_speed`, `emergency_stop`, `set_switch_position`, `set_aspect`, `hold_gate`, `release_gate`, `assign_tag` |
| Capability identifiers and `DeviceManifest` | shipped | `capabilities.ts`, `manifest.ts` |
| Layout schema (logical graph plus optional spatial fields) | shipped | `layout.ts` |
| TCF compact codec for ESP-NOW (ADR-021) | shipped | `tcf/`; epoch-versioned 1-byte type registry, 13-byte header, 250-byte frames. Per-type payload codecs exist for a subset, the rest ride a generic JSON carrier |
| Custom (vendor) event dispatch | not started | Envelope and topic shape exist, the server only consumes core event types |
| Authentication and pairing on the broker | not started | The device pairing lifecycle (ADR-035) is built, broker-level auth is not |

## Core: `packages/core/`

Coverage floor: 95 lines, 95 statements, 95 functions, 87 branches.

| Area | Status | Notes |
| --- | :---: | --- |
| `Capability<State>`, `RegisteredCapability`, `wrap()` (ADR-005) | shipped | `capability.ts` |
| `CapabilityRegistry` | shipped | `registry.ts` |
| `core.gates_clearance` | shipped | `builtins/gates-clearance.ts`; the reference capability with real hooks |
| `core.gates_zone` (ADR-026) | shipped | `builtins/gates-zone.ts`; deny-when-full at the zone boundary marker |
| Declaration capabilities | shipped as declarations | `declarationCapability(...)` in `builtins/index.ts`: empty hooks, and the scheduler enforces the behaviour only for devices that declare them. `core.assigns_tags` gates `tag_assignment`, `core.reports_length` gates `train_length_changed`, `core.can_reverse` gates zone admission, `core.provides_train_heading` gates `train_introduced`, `core.reports_marker_traversal` gates marker crossings from `tag_observed`, `core.identifies_vehicles` gates `vehicle_identified`, `core.accepts_route` gates route assignment and `core.controls_motion` marks a device as a train (ADR-023, ADR-027, ADR-036) |
| `core.controls_switch` | shipped | Real hooks (ADR-037, `builtins/controls-switch.ts`): binding via `onEvent` on `device_registered`, `onActuationRequest` and `isActuationOverdue` on the scheduler's clock, `bind_junction` and `report_switch_position` intents. The scheduler keeps the zone-ownership refusal and layout mutation, and re-asks an unconfirmed switch after `SWITCH_ACTUATION_TIMEOUT_MS` (3000) while a train waits. Server learn mode still sends `set_switch_position` directly |
| `core.displays_aspect` | reserved | Schemas exist (`set_aspect`, `aspect_changed`) but nothing declares, sends or consumes them |
| `LayoutState` | shipped | `scheduler/layout-state.ts`; edges, switches, runtime markers, edge inference and confirmation (ADR-009) |
| `TagRegistry` (ADR-007) | shipped | `scheduler/tag-registry.ts`; populated only from `tag_assignment` |
| Planner | shipped | `scheduler/planner.ts`; direction-aware search keyed by (marker, arrival), no U-turns on ordinary routes (ADR-010) |
| Schedules and transit | shipped | Sparse stop lists, cyclic schedules, zone resume (ADR-028) |
| Operator revoke and introduction conflicts | shipped | An operator revoke holds the train stopped until it is given a new schedule. An introduction that would resolve into a block a peer occupies is refused and the block stays held (`train_introduction_conflict`) |
| Device removal and reverse | shipped | `device_disconnected` clears the device's zone and switch state. A reverse re-queues the blocks the train vacated |
| Clearance | shipped | Block exclusivity (ADR-011), tail release by train length (ADR-012, ADR-016; every edge a train crosses is held until its tail leaves, granted or not, and a status with no edge measures from the last marker), horizon of `CLEARANCE_HORIZON_EDGES` (3), switch-state filtering, switch actuation for routes, revocation |
| Station dwell | partial | `STATION_DWELL_MS` (2500) is a constant in `scheduler.ts`, not a capability or per-stop setting |
| Conflict resolution and deadlock yield (ADR-017) | shipped | Total order: priority, registration order, train id |
| Multi-gate semantics (ADR-018) | shipped | Veto on any deny; no aggregated block-reason view |
| Topology violations (ADR-019) | shipped | Expectation-gated hold plus `topology_violation` event |
| Reverse authority (ADR-022) | shipped | `grant_reverse` issued to break nose-to-nose standoffs only |
| Runtime length changes (ADR-023) | shipped | `train_length_changed` from `core.reports_length` devices |
| Zones: admission, interior handoff, owned markers (ADR-026, 027, 034) | shipped | Nested zones (ADR-032) work through the same hooks |
| Train introduction (ADR-036) | shipped | A train is gated off the map until its vector resolves: two-marker roll, `core.provides_train_heading` zone, operator vector. Conflicts raise `train_introduction_conflict` |
| Deadlock detection | shipped | Waits-for cycle check on every retry pass, published as retained deadlock state |
| Disconnect handling | shipped | `device_disconnected` (handled by the scheduler, no protocol schema) runs capability hooks and frees held blocks |

## Server: `packages/server/`

Coverage floor: 75 lines, 65 branches, 65 functions.

| Area | Status | Notes |
| --- | :---: | --- |
| `Server` composition (broker client, scheduler, effects) | shipped | `server.ts`; injectable clock and id source |
| Inbound validation | shipped | `inbound-validation.ts`: core events are checked against `CORE_EVENT_SCHEMAS` before the scheduler sees them, and the sender is taken from the topic, not the envelope. Every producer sends `device_kind_hint`, and a `device_registered` without it is rejected with an anomaly |
| Broker clients | shipped | `broker/mqtt-client.ts` (MQTT 3.1.1), `broker/in-memory-client.ts` |
| Retained state publication | shipped | Layout, devices, clearance, schedule, tags, switches, deadlock |
| Operator MQTT topics | shipped | `railway/operator/{assign_schedule,revoke_clearance,introduce_train}` |
| Admin HTTP | shipped | `admin-http.ts`: `GET /api/health`, `/api/state` (deprecated), `/api/query/*`; `POST /api/tags`, `/api/trains/:id/route`, `/api/trains/:id/revoke_clearance`, `/api/gates/:id/hold`, `/api/gates/:id/release`, `/api/maintenance/{prune-markers,reset}`; `DELETE /api/trains/:id` (ADR-008, ADR-020) |
| Discovery mode | shipped | `--discovery`; markers from `tag_assignment`, edges inferred from traversals, junctions from `valid_positions` (ADR-009, ADR-035) |
| `LearnMode` (ADR-014, ADR-015) | shipped | `learn-mode.ts`; drives a registered train with `begin_exploration`, surveys junction legs by throwing switches |
| CLI `tf-server` | shipped | `--layout`, `--discovery`, `--discovery-name`, `--broker`, `--http-port` |
| Docker image and compose | shipped | `packages/server/Dockerfile`, `tools/broker/docker-compose.yml` |

## Simulator: `packages/simulator/`

Spec: [`docs/spec/simulator-v0.1.md`](spec/simulator-v0.1.md). ADR-030 and ADR-031. Coverage floor: 80 lines, 75 branches.

The package is the physics world and the device layer that runs on it. The earlier virtual-device simulator was deleted in 4759ee6.

| Area | Status | Notes |
| --- | :---: | --- |
| `PhysicsWorld` and rail network | shipped | `physics/world.ts`, `physics/network.ts`, `physics/rail.ts`; bodies on rails, switches, height layers |
| Track pieces, placement, flex and loop closure | shipped | `track/`; Brio-style pieces, snapping, bounded joint flex, loop closure (`closure.ts`), `compileNetwork` in `physics/network-from-pieces.ts` |
| `startPhysicsEnv(scene)` test harness | shipped | `physics-env.ts`; real server, in-memory broker, physics devices, virtual clock; `straightLoop(...)` scene helper |
| Devices: `ScheduledTrainDevice`, `GateDevice`, `SwitchDevice`, `BeaconDevice` | shipped | `devices/`; each speaks the protocol through a `PlatformProvider` |
| Provider seam (ADR-031) | shipped | `devices/platform-provider.ts`; backings `mqttPlatform`, in-memory, `EspNowPlatform` (`broker/espnow-platform.ts`) |
| Device pairing and onboarding (ADR-035) | shipped | `broker/espnow-link.ts`, `broker/pairing-bridge.ts`; marker persistence across reboot is a recorded decision for firmware, not built |
| Zones: `YardZoneDevice`, `DepotController` | shipped | Capacity-gated territories with device-driven interiors (ADR-026, 029, 032). One railyard model: `YardZoneDevice` over a yard discovered from the track under a gantry (`physics/gantry-yard.ts`, `discover-yard.ts`, `discovered-yard-layout.ts`), including the ADR-036 heading zone |
| Turntable, crane, lift bridge, vision station | shipped | Experimental devices 001 to 006 in `docs/experimental/`; turntable pieces compile into the physics network (`physics/turntable-deck.ts`, `network-from-pieces.ts`), and only the gate-backed devices (crane station, lift bridge) are otherwise live on the toy table |
| Demo assemblies | shipped | `demo/`: interesting railway and bridge; driven by tests, the browser `?physics=` views were removed in e0d2aee |
| Determinism | shipped | Fixed 60 Hz step and injected `now` and `newId`; no seeded random source. `envelope.ts` validates envelopes through one adapter, `EnvelopeSource` (`envelope-source.ts`) injects id and clock, and `deterministicEnvelopeSource` backs tests. The toy table supplies `wallClockEnvelopeSource` at its entry point |
| Mishap and fault injection (sensor miss, overshoot, derailment) | not started | ADR-006 specified it, the implementation went with the deleted simulator |
| Bridge frame loss, reorder, latency | not started | `EspNowLink` models the radio segment for pairing only |
| Satellite device registration hook | not started | No `attachDevice` or virtual-capability registry for third parties |

## Visualiser: `packages/visualiser/`

| Area | Status | Notes |
| --- | :---: | --- |
| Broker connection (MQTT over WebSocket) and settings | shipped | `broker/`, `components/Settings.tsx`, `ConnectionStatus.tsx` |
| Layout canvas | shipped | `LayoutCanvas.tsx`; pan and zoom, bezier edges, dashed inferred edges, force layout when no spatial data |
| Train positions, clearance overlay, event log | shipped | `use-train-positions`, `use-clearance-state`, `EventLog.tsx` |
| Schedule assignment and list | shipped | `ScheduleAssigner.tsx`, `ScheduleList.tsx` |
| Deadlock banner, revoke | shipped | `DeadlockBanner.tsx` |
| Unknown tags and tag assignment | shipped | `UnknownTags.tsx` |
| Learn track | shipped | `LearnTrackPanel.tsx` |
| Garage: commissioning, discovery, introduction | shipped | `CommissioningPanel.tsx`, `GarageDiscovery.tsx`, `GarageIntroduction.tsx`, `IntroductionConflictBanner.tsx` |
| Devices panel | shipped | `DevicesPanel.tsx` |
| Maintenance (delete train, prune, reset) | shipped | `MaintenancePanel.tsx` |

## Simulator UI: `packages/simulator-ui/`

The toy table: a virtual Brio table the operator builds on. Runs the physics world in the browser. Never drives trains directly, the server does.

| Area | Status | Notes |
| --- | :---: | --- |
| Toy table: parts tray, canvas, scan box | shipped | `components/ToyTable.tsx`, `ScanBox.tsx` |
| Hardware adapter | shipped | `sim/toy-hardware.ts`; rebuilds the physics net on track edits and re-asserts switch and gate state |
| Editing: drag placement, snap, flip, flex, closure, undo, layers, save/load | shipped | `track/` in `@trainframe/simulator`, `track-storage.ts` |
| Power-off in place, delete despawns | shipped | Power-off keeps a train inert on the track, delete publishes `device_disconnected` |
| Wooden aesthetic (ADR-024), N-level decks (ADR-025) | shipped | `piece-art.tsx` |
| Closure wave | shipped | `components/ClosureWave.tsx`; detection and centreline are pure functions in `packages/simulator/src/track/closure.ts` |

## UI kit: `packages/ui-kit/`

| Area | Status | Notes |
| --- | :---: | --- |
| `Button`, `Panel`, `Drawer`, light and dark themes | shipped | Consumed by simulator-ui and visualiser, depends on neither |

## Tests

| Package | Status | Notes |
| --- | :---: | --- |
| `packages/integration/` | shipped | In-process aedes broker, real server, real physics devices through the wire; vitest, no coverage gate |
| `packages/ui-tests/` | shipped | Playwright and Chromium against the Vite preview, an aedes WebSocket broker and a real server; `scripts/dev-stack.mjs` backs `pnpm dev:stack`, alongside `live-broker.mjs`, `bridge-demo-server.mjs`, `record-session.mjs` and `snoop.mjs` |
| `packages/simulator/src/*.test.ts` | shipped | Scheduler behaviour through `startPhysicsEnv` |

## Capabilities at a glance

| Capability | Status |
| --- | :---: |
| `core.gates_clearance` | shipped, real hooks |
| `core.gates_zone` | shipped, real hooks |
| `core.assigns_tags`, `core.reports_length`, `core.can_reverse`, `core.provides_train_heading` | shipped, enforced by the scheduler |
| `core.reports_marker_traversal`, `core.identifies_vehicles`, `core.accepts_route`, `core.controls_motion` | shipped, enforced by the scheduler |
| `core.controls_switch` | shipped, real hooks (ADR-037) |
| `core.displays_aspect` | reserved |

## Known gaps

- Server learn mode sends `set_switch_position` directly instead of asking through the `core.controls_switch` hooks
- `core.displays_aspect` is reserved: `set_aspect` and `aspect_changed` are schema-only and nothing uses them
- Station dwell is a scheduler constant, not a capability
- No fault, mishap or sensor-noise injection in the physics world
- No broker authentication and no vendor custom-event dispatch
- TCF per-type codecs are not tied to the TypeBox schemas, so a new field can be silently dropped from a compact frame
- ADR-035 firmware obligations (marker and withheld-set persistence, composite-parent association, heartbeat versus duty cycle) are recorded but unbuilt
- Operator-initiated reverse and an aggregated multi-gate block-reason view are not built
