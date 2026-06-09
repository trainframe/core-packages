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
| Core command schemas (10 types)            | shipped | `assign_route`, `grant_clearance`, `revoke_clearance`, `begin_exploration`, `set_target_speed`, `emergency_stop`, `set_switch_position`, `set_aspect`, `assign_tag`, `grant_reverse` (ADR-022 bounded backward clearance). |
| Capability identifiers                     | shipped | `BUILTIN_CAPABILITIES` enum + `CapabilityId` regex.                                            |
| `DeviceManifest` schema                    | shipped | Used by examples; not yet enforced by anything that loads manifests.                           |
| Layout schema                              | shipped | Markers, edges, junctions. Optional spatial fields.                                            |
| `protocol_version` literal                 | shipped | `0.7.0` exported as `PROTOCOL_VERSION` (0.5.0 added optional `priority` on `device_registered`, ADR-017; 0.6.0 added the `topology_violation` event + retained-clearance `block_reason`, ADR-019; 0.7.0 added the `grant_reverse` command, ADR-022).              |
| `hold_gate` / `release_gate` commands      | shipped | Server-side override of local gate logic. `VirtualGate.acceptCommand` honours them and publishes the matching `gate_state_changed`. |
| `vehicle_identified` event schema          | shipped | `{ vehicle_id, context_device_id }`. The scheduler already derives these from vehicle-tag observations.                                |
| `begin_exploration` command                | shipped | ADR-015. Open-ended discovery clearance: authorises a train to drive forward across markers indefinitely (following the rails, taking the switched branch at junctions) until `revoke_clearance`. Names no edges — the primitive that bootstraps discovery on an unknown layout. |

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
| Scheduler: schedule assignment            | shipped | `assignSchedule(trainId, routeId, stops)`. Sparse stop list per ADR-010; planner computes the per-leg transit; train receives `assign_route(edges)` carrying that transit + initial clearance grant. All trains loop. |
| Planner (Dijkstra over static layout)     | shipped | `planTransit(layout, from, to)` in `@trainframe/core`. Purely structural — ignores runtime clearance holds and switch state; execution layer handles waits via existing clearance/section-exclusivity machinery. ADR-010. |
| Scheduler: clearance extension            | shipped | At-marker → grant next edge unless any capability denies. Block exclusivity (section-as-edge-plus-boundary-markers per ADR-011): two sections conflict when they share a boundary marker — protects figure-8 crossings, junctions, and gives one-block separation on a single loop, all from one rule. |
| Scheduler: gate-release re-grant          | shipped | After capability state changes, retries blocked clearances.                                    |
| Scheduler: clearance revocation           | shipped | `Scheduler.revokeClearance(trainId)` drops the train's cleared edges, snaps the limit back to its current marker, emits a `revoke_clearance` command, and retries blocked peers (skipping the revoked train so it can't re-grab the block). |
| Scheduler: switch-state edge filtering    | shipped | Refuses to clear an edge whose `requires_switch_state` doesn't match the junction's confirmed position. Retries blocked clearances when a switch confirms. |
| Scheduler: proactive clearance horizon    | shipped | Grants up to `CLEARANCE_HORIZON_EDGES` (3) edges ahead, topped up on every marker crossing — a moving train always carries several blocks of clearance, killing the per-marker stutter-brake. Behaviour-gated by `packages/simulator/src/clearance-horizon.test.ts`. |
| Scheduler: switch actuation for routes    | shipped | The horizon reaching a junction edge emits `set_switch_position` autonomously — scheduled routes throw their own switches instead of waiting on the operator. |
| Scheduler: deterministic station dwell    | shipped | `STATION_DWELL_MS` (2500 ms) hold at each scheduled stop via the injected monotonic clock; no pointer advance or onward grant until the dwell elapses. |
| Scheduler: device disconnect               | shipped | `device_disconnected` event runs each capability's `onDeviceDisconnect` hook, deletes the device (and its train state if it owned `core.controls_motion`), then retries blocked clearances so peers waiting on a vanished gate's withhold or a vanished train's block get re-granted. |
| `LayoutState`                             | shipped | Edges, marker lookup, switch positions, runtime `upsertMarker`, edge inference via `recordTraversal`, inferred→confirmed flip on N traversals (ADR-009), `toLayout()` serialiser for republishing as retained state. |
| Anomaly emission for unknown tags         | shipped | `tag_observed` against unregistered marker → anomaly event.                                    |
| Referential validation on broker boundary | shipped | `assignRoute`, `clearance_request`, and `switch_state_changed` reject payloads referencing markers absent from `LayoutState`, emit a warning anomaly, and skip the would-be state mutation. Defence-in-depth against malformed inbound MQTT. |
| Conflict resolution policy                | shipped | ADR-017 + ADR-022. Deterministic total order (priority → registration-seq FIFO floor → train_id) in the grant path; deadlock first yields the lowest-ranked train's not-yet-entered blocking edges (ADR-017), then — for a closed nose-to-nose standoff where withholding can't help — grants reverse authority to back a train out (ADR-022); only a genuinely unrecoverable standoff is reported. |
| Multi-gate semantics                      | shipped | ADR-018. Conjunctive AND (`anyCapabilityDeniesClearance` veto-on-any-deny); n>1 integration test locks it. Aggregated block-reason view deferred. |
| Topology violation handling               | shipped | ADR-019. Expectation-gated: a train under a bounded route reporting an unreachable marker is held default-safe (no phantom edge, region occupied, clearance revoked, `topology_violation` emitted, `block_reason: 'unknown_topology'` on retained clearance state); an open train still learns. Recovery via `reanchorTrain` / `confirmNewTrack`. |

Coverage thresholds: 75 lines / 75 branches (low to allow for remaining LayoutState work; raise to 85 once discovery lands).

---

## Simulator (test harness): `packages/simulator/`

Source: [`docs/spec/simulator-v0.1.md`](spec/simulator-v0.1.md); [`ADR-006`](adr/006-physical-mishap-simulation.md)

| Area                                              | Status | Notes                                                                          |
| ------------------------------------------------- | :----: | ------------------------------------------------------------------------------ |
| In-process `Simulation` (devices + physics, no scheduler) | shipped | Pure-TS, broker-free, deterministic. The scheduler moved to `@trainframe/server` per ADR-013 — the simulator is virtual hardware only. |
| `VirtualClock`                                    | shipped | Step-driven (`advance(ms)`).                                                   |
| `SeededRandom`                                    | shipped | Bernoulli + normal sources.                                                    |
| `VirtualTrain`                                    | shipped | Position/velocity, braking, route execution, marker emission with latency.    |
| `VirtualGate`                                     | shipped | Withhold/release per marker.                                                   |
| Despawn → `device_disconnected`                   | shipped | `Simulation.despawnTrain` and `despawnGate` drop the device and emit a `device_disconnected` event so the scheduler can run disconnect hooks and free held blocks/withholds. Stand-in for MQTT LWT in pre-broker tests. |
| `Simulation.onEvent` listener API                 | shipped | Used by simulator-ui to bridge events onto MQTT.                              |
| Exploration mode (`begin_exploration`)            | shipped | ADR-015. `VirtualTrain` rolls forward onto the next physical edge indefinitely, taking the switched branch at junctions, until `revoke_clearance`. A concrete `assign_route` supersedes exploration. |
| Power-off → inert-in-place                        | shipped | Powering a train off freezes it where it stands — no motion, ignores commands, emits nothing — instead of despawning. Power-on resumes from the same spot. `train-power.test.ts`. |
| `BrokerBridge` against a real server                   | shipped | The simulator's only mode now. Bridges `simulation.onEvent` → `railway/events/...` and routes `railway/commands/...` to `simulation.handleCommand()`. E2E covered by `@trainframe/integration`. |
| `Simulation.bindIdentityTag(markerId)`                 | shipped | Silent identity bind for callers (the toy-table) that publish their own `tag_assignment` and only need the in-process `markerToTag` populated so virtual trains emit `tag_observed`. |
| Realistic-time mode                               | partial | simulator-ui drives a `requestAnimationFrame` loop via `useToyHardware`; no first-class realtime mode in the package itself. |
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
| Minimal CLI (`tf-server`)                         | shipped | `--layout <path> | --discovery [--broker mqtt://…]`. `--discovery` boots with an empty layout that grows from incoming `tag_assignment` events and inferred edges. SIGINT/SIGTERM clean shutdown. |
| Docker image + compose service                    | shipped | `packages/server/Dockerfile` (multi-stage pnpm deploy → alpine). `tools/broker/docker-compose.yml` includes `tf-server` alongside mosquitto; `pnpm services` brings both up. `pnpm server:dev` runs the same server locally without docker. |
| HTTP admin API (assignSchedule, hold/release, tags) | shipped | `AdminHttpServer` on a configurable port (default 3000). Endpoints: `/api/health`, `/api/state`, `/api/trains/:id/route` (body: `{route_id, stops: marker_id[]}`; routes through `Server.assignSchedule`), `/api/trains/:id/revoke_clearance` (routed through `Server.revokeClearance` so the scheduler's view of who owns which block stays in sync with the train's behavior), `/api/gates/:id/hold`, `/api/gates/:id/release`, `/api/tags`. CLI: `--http-port`. No auth (LAN/localhost). ADR-008. |
| Custom-event dispatch (`railway/events/custom/...`) | not started | Server only subscribes to four-segment core events.                            |
| Authentication / pairing                          | not started | Spec §"Authentication" defers details to garage-device pairing.                |
| Discovery mode (learning new edges/markers)       | shipped | ADR-009, ADR-014. Marker creation on `tag_assignment`, edge inference on traversal, confirmation after 3 traversals (configurable). Layout republished as retained state on every change. Edge-length learning and cautious-clearance follow-ups deferred. |
| Track-learn mode                                  | shipped | ADR-014, reworked per ADR-015. `LearnMode` now bootstraps the graph by issuing `begin_exploration` to the operator-designated train (open-ended discovery clearance) instead of edge-by-edge grants. Operator topics: `railway/operator/learn_track_start`, `railway/operator/learn_track_stop`. State published retained to `railway/state/track_learning/active`. |
| Stale deadlock-state cleanup on start             | shipped | `Server.start()` clears any retained deadlock state left by a previous run, so a restart doesn't show a phantom deadlock banner. |
| Simulator-ui as virtual hardware only             | shipped | `simulator-ui` no longer runs a scheduler. All scheduling routes through `@trainframe/server`. |

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
| Layout snapshot bootstrap                  | shipped | `useLayoutState` subscribes to `railway/state/layout/+`; `@trainframe/server` publishes the active layout retained as the discovery loop learns it. The simulator-ui does NOT publish layout state — that's system knowledge, not hardware knowledge (ADR-013). |
| Tag-assignment UI                          | shipped | `UnknownTags` component surfaces unknown-tag anomalies and POSTs `tag_assignment` requests to the server's admin HTTP API. Plays the discovery loop: anomaly → operator picks target → registry binds → row vanishes. The simulator-ui's `GARAGE` device auto-binds via wire events directly. |
| Discovery / topology learning UI           | shipped | Discovered markers and inferred edges show up in the layout SVG live. Inferred edges render dashed (`stroke-dasharray="8 6"`) with `data-inferred="true"`; confirmed edges stay solid. |
| Schedule assignment (operator intent)      | shipped | `ScheduleAssigner` publishes `railway/operator/assign_schedule`. Train selector appears once any train registers. |
| Schedule list                              | shipped | `ScheduleList` mirrors `railway/state/schedule/+`. Current stop highlighted. |
| Deadlock banner + per-train revoke         | shipped | `DeadlockBanner` subscribes to `railway/state/deadlock/+`; per-train Revoke buttons publish `railway/operator/revoke_clearance`. |
| Devices panel + recently-scanned highlight | shipped | `DevicesPanel` groups every registered device by capability bucket (Trains, Gates, Garages, Markers) with live state. `useLastScanned` watches `tag_observed`/`tag_assignment` and pulses an amber highlight on the matching row for 3s. |
| Pan/zoom + fit-to-content                  | shipped | `LayoutCanvas` pans and zooms; fits to content on load. Markers/trains/glyphs render at constant screen size — zoom spreads the layout, not the glyphs. |
| Merged bidirectional edges + smooth track  | shipped | A↔B edge pairs render as a single path; track smoothing via undirected neighbour-position tangents (no opposing-curve kinks at shared markers). |
| Cohesive warm theme (ADR-024)              | shipped | Shares the simulator-ui's wooden "workshop" palette so the two apps read as one product: wood-desk surround, paper-card surface, rounded display font, warm `--tf-vis-*` tokens (wood-brown rails, cream marker pucks) and a warm wooden tabletop behind the diagram. Theme/CSS only — no rendering-logic change. |

---

## Simulator UI: `packages/simulator-ui/`

Reframed per ADR-013 as the **toy table** — a virtual Brio-style table the operator builds on, not a developer control panel. The interaction surface is a unified toybox + canvas + scan-box: pieces sit on the table inert until dragged onto the scan-box, which mediates the act of "this thing exists on the bus."

| Area                                       | Status | Notes                                                                         |
| ------------------------------------------ | :----: | ----------------------------------------------------------------------------- |
| Static-shell deployment                    | shipped | Pages-deployed, broker URL via localStorage.                                   |
| Toy table (parts tray + canvas + scan-box) | shipped | `ToyTable` component. A **parts tray** under the table holds actual wooden renders of each piece (`PiecePreview`, the same shape/groove/feature spec as the live pieces) — track (straight, curve, tight-curve, junction, station, terminus, crossing, ramp) and devices (train, gate, carriage). Drag a part onto the table (or click-to-arm + click-to-place). The **scan-box is a floating dashed zone in the table's bottom-left corner** (the GARAGE tag zone). Pieces start inert; only scanning makes them live on the bus. The canvas is capped to the viewport height so the tray below it stays on screen. |
| Wooden-track aesthetic                      | shipped | ADR-024. Pieces render as consistent beech-wood planks: a wood-gradient body, twin routed rail grooves derived from the SAME centre-line a train rides (`getPieceShape` → `{ svgPath, grooves, features, width, height }`), rim-light + contact shadow, and warm functional tints (`PIECE_TINT`: station/terminus/ramp; junction/crossing read from their silhouette). Devices get characterful top-down bodies (loco, carriage, gate boom). Selection/overlap are a colour glow (no seam on multi-plank pieces). Topology is unchanged — purely visual. The whole app wears a warm "workshop" theme (wood-desk surround, paper card, rounded display font). Every piece is defined by ONE entry in an exhaustive `PIECES: Record<TrackPieceType, PieceDescriptor>` registry (metadata + endpoints/centre-lines/rail-lines/body co-located); `TRACK_PIECE_TYPES`, `DEVICE_PIECE_TYPES`, `PIECE_TINT`, `PIECE_LABELS`, the marker-kind/device predicates, and `DEVICE_FILL` all derive from it, so adding a piece is a single compiler-checked entry with no scattered switches. Grooves derive uniformly for every piece (offset of its `railLines`); a dead-end declares a longer drawn rail than its ridden centre-line (`getRailLines` vs `getCentreLinePath`). |
| Scan-box → wire commissioning              | shipped | Drag a placed piece onto `ScanBox` to fire its identifying events: a synthetic `GARAGE` device announces once per session (`device_registered` with `core.assigns_tags`); track-piece scans emit `tag_assignment` binding `M-{piece.id}`; junction scans additionally emit `device_registered` for `SWITCH-{piece.id}` with `core.controls_switch` and `controls_marker_id: M-{piece.id}` so the server records the pairing; train/gate scans emit their own `device_registered` for `T-{piece.id}` / `GATE-{piece.id}`. Inert pieces (placed but unscanned) emit nothing. |
| Power-off in place / delete despawns       | shipped | Clicking a live device's body only selects it. The explicit power affordance (power dot or ActionBar button) toggles a train inert IN PLACE — silent on the bus, no `device_disconnected`, server keeps its block. Deleting a live piece is the genuine despawn: exactly one `device_disconnected` goes out, including for trains that never spawned in the in-browser sim (no track). E2E: `delete-disconnects-trains.spec.ts`. |
| Physics-only `Simulation` in browser       | shipped | `ToyHardware` class + `useToyHardware` hook own a `Simulation` + `BrokerBridge` wired to the broker. Scanned trains spawn `VirtualTrain` at the nearest outgoing edge; the loop ticks via `requestAnimationFrame` (`performance.now()` delta, capped at 200 ms). No scheduler — the server schedules. |
| Private layout (per-piece markers)         | shipped | `compileLayout(pieces, ...)` produces an in-browser `Layout` whose markers use the same `M-{piece.id}` ids the scan flow publishes, so server-issued routes line up with the sim's internal physics. Never published. |
| Train icon rides the rail                  | shipped | A top-down loco sprite rides the routed grooves of the 26 mm wooden plank. Trains travel the real track geometry — `edge-path.ts` interpolates world position along the piece's actual curve, not a straight chord. |
| Hand-building: snap, flip, drag-connect    | shipped | End-based snapping (including when moving an already-placed piece), mirror/flip (`F`), drag-in connects geometry on drop, consistent junction branch orientation. `placement.ts`, `overlap.ts`. |
| Editor layers + ramp piece (bridges)       | shipped | Height layers with layer-gated snapping and over/under rendering; ramp piece climbs between layers. Research note: `docs/research/bridges-and-height-layers.md`. |
| N-level decks: supports + growable selector | shipped | ADR-025. Editor-only, no protocol/core change. Raised track stands on subtle support piers (`supportColumn` + `tf-pier`), with the pier *suppressed* where a deck bridges directly over lower track (`pierSuppressed`, reusing the overlap footprint test) so a column never lands on the rail beneath. The per-deck drop-shadow cue (`layerStyle`) scales with depth and saturates, so a stack of n decks reads progressively higher (layer 1 unchanged). The deck selector is derived and grows with the layout — Ground..highest-in-use + "+ Add level" — replacing the old fixed Ground/Upper pair; non-active decks fade gently while placing. Tests: `pieces.test.ts`, `overlap.test.ts`, `ui-tests/multi-level-toybox.spec.ts`. |
| Bridge two-train demo                      | shipped | Deterministic flyover layout (ground oval + perpendicular deck OVER it, zero overlaps) with a server-driven two-train schedule and DEV seed hook. Proven by a strict two-train gate: `bridge-demo.test.ts`, `two-train-flyover.test.ts`, plus `ui-tests/scripts/bridge-demo-server.mjs` for live demos. |
| Wildcard MQTT subscriptions in-browser     | shipped | `topic-match.ts` — the in-memory broker client now delivers `+`/`#` wildcard subscriptions to in-browser devices, matching real-broker semantics. |
| Carriage coupling                          | shipped | `computeTrainTrails` flood-fills carriages within 100 mm onto the nearest live train. Coupled carriages render with `data-coupled-to={trainPieceId}`. |
| Carriage physics — trailing behind train   | shipped | `computeRenderPositions` reads `VirtualTrain.getDistanceIntoEdge()` each render and interpolates carriage world positions along the current edge. Carriages are spaced 50 mm behind the train (index 0 at `d-50`, index 1 at `d-100`, clamped to 0 = edge start when negative — full multi-edge trailing is a TODO). The train sprite moves with the sim too, not just the carriages. Render-position re-rendering is driven by `onTick` bumping a React state counter inside the existing RAF loop. |
| `window.trainframeSim` devtools handle     | shipped | Hidden `pause`/`resume`/`step` no-ops (sim ticks forever); kept as a future hook for devtools-driven inspection. |

---

## Capabilities (built-in implementations)

| Capability                          | Status | Notes                                                                          |
| ----------------------------------- | :----: | ------------------------------------------------------------------------------ |
| `core.gates_clearance`              | shipped | Full implementation; reference for satellite authors.                          |
| `core.controls_switch`              | partial | Stub capability. `device_registered` payloads now accept an optional `controls_marker_id` field; the scheduler records the pairing in `LayoutState.recordSwitchPairing` so consumers (LearnMode) can resolve marker → switch device id without a naming convention. LearnMode sends `set_switch_position` to `SWITCH-{pieceId}` (resolved via `switchDeviceForMarker`), not the marker id. The `switch_state_changed` event still carries `junction_marker_id` so the scheduler updates the position map. Command handling hooks not yet wired. |
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
| Lifecycle smoke test                              | shipped | Start, Spawn, Step against the embedded sim (no broker required). Extended with: edgeless-layout hint, duplicate-ID error flow. |
| Connected-to-broker test                          | shipped | UI connects to aedes via WS, `device_registered` round-trips through the server. |
| Operator journeys                                 | shipped | `multi-train-journey`, `tag-assignment`, `discovery`, `feature-showcase`, plus five new specs: `route-reassignment` (expects `cleared_edges`-wipe fix), `unknown-tag-closure` (bound-tag → train lands on marker), `spawn-form-mishaps` (overshoot knob → anomaly in EventLog), `layout-swap` (preset swap + invalid-JSON error), `gate-hold-release` (admin HTTP hold/release → train stops/advances). |
| Visualiser SVG assertions                         | shipped | `data-train-id` / `data-at-marker` / `data-on-edge` / `data-marker-id` / `data-inferred` assertions are routine across the new specs. |
| Native drag specs                                 | shipped | `native-drag.spec.ts`: HTML5 drag-to-place from the toybox + pointer drag-to-move of a placed piece. |
| Runs in CI                                        | shipped | CI workflow installs Chromium via `playwright install --with-deps` before `pnpm test`. Before this, every ui-test failed at browser launch in CI (masked behind an unrelated integration flake). |

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
| ADRs 007–010                                   | shipped | Tag-resolution registry, server admin API, discovery mode, schedule/planner/transit. ADR-010 partially supersedes ADR-004 (sections still the execution unit; operator-facing routes are now sparse stop lists). |
| ADR-011                                        | shipped | Section as edge + boundary markers; amends ADR-002's clearance model. |
| ADR-012                                        | shipped | Train length on registration; tail-clearance release derived from train_status internally; per-train EWMA on LayoutState. The deferred multi-edge release queue landed with ADR-016: stateless backward walk over `cleared_edges` keyed by cumulative distance, conservative hold on unknown edge lengths, cycle-guarded. |
| ADR-013                                        | shipped | Simulator as physical twin; visualiser as system view. Mechanically enforced boundary via Biome `noRestrictedImports`. |
| ADR-014                                        | shipped | Track-learn mode: operator bootstrap gesture for edge-graph discovery; `LearnMode` peer module in `@trainframe/server`; operator surface in `@trainframe/visualiser`. |
| ADR-015                                        | shipped | Exploration clearance: `begin_exploration` as the discovery-bootstrap primitive ("clearance, not commands" extended to open-ended discovery). Protocol bumped to 0.3.0; LearnMode reworked on top. |
| ADR-016                                        | shipped | Train consists + length-aware visualisation, implemented. Sim: `VirtualTrain` traversal history + `getTrailingPosition(offset_mm)` multi-edge trailing query. Toy-table: carriages placed from the sim's consist positions (follow the train across edge boundaries). Visualiser: length-aware trains drawn as a swept body along the edge bezier, crossing back over the previous marker while the tail hasn't cleared (`data-tail-on-edge`); `train_length_mm` rides the retained devices state; `marker_traversed` now carries `inferred_edge`. Optional `consist` descriptor (discrete segments on the wire) deferred per the ADR. |
| ADR-017                                        | shipped | Conflict resolution: deterministic total order (priority → registration-seq FIFO floor → train_id) in the grant path; deadlock yields the lowest-ranked train's not-yet-entered blocking edges. Optional additive `priority` on `device_registered`. Protocol 0.4.0 → 0.5.0. The honest limit it named (withholding can't vacate an occupied block — the closed nose-to-nose standoff) is now cured by ADR-022 reverse authority. |
| ADR-018                                        | shipped | Multi-gate semantics: conjunctive AND, ratifying the existing veto-on-any-deny fold; n>1 integration test added. Scheduler-side aggregated block-reason view deferred. No production change. |
| ADR-019                                        | shipped | Topology-violation handling: expectation-gated (bounded route → hold default-safe + `topology_violation` event + `block_reason: 'unknown_topology'` on retained clearance state; open train still learns). Operator recovery via `reanchorTrain` / `confirmNewTrack`. Protocol 0.5.0 → 0.6.0. Cross-feature fix: topology-held trains are excluded from the waits-for graph so ADR-017 deadlock-yield can't vacate their uncertain-region guard (regression-tested). |
| ADR-020                                        | shipped | HTTP query API split: read-only `GET /api/query/*` (layout, traversal-times, trains(/:id), clearances, tags) projecting existing accessors; `/api/state` kept as deprecated alias. No protocol bump; MQTT stays the app transport. Route planning deferred. |
| ADR-021                                        | shipped | ESP-NOW Trainframe Compact Frame codec in `packages/protocol/src/tcf/` (barrel-exported from `@trainframe/protocol`): epoch-versioned 1-byte event-type ID registry, 13-byte header, ≤250-byte frames, lossless JSON expansion, unknown-id default-safe. Per-type byte codecs (`tcf/payloads.ts`) landed for the hot UUID-heavy types (`marker_traversed`, `clearance_request`, `clearance_granted`, `grant_clearance`) — UUIDs packed to 16 raw bytes so they round-trip and fit one frame; types without a pinned codec keep the generic-JSON fallback. Deferred: CBOR long-tail carriage, satellite-defined event IDs, Thread/6LoWPAN bridges. |
| ADR-022                                        | shipped | Reverse authority: new `grant_reverse` command (bounded, signed backward clearance) the scheduler issues to break a closed nose-to-nose standoff — backs the lowest-ranked cycle member out of its occupied block over track it provably holds (`computeReverseTarget` safety walk reusing the ADR-017 total order), freeing the contested block for the peer. `VirtualTrain` enacts it by driving backward to the granted marker (VirtualClock-deterministic). Protocol 0.6.0 → 0.7.0, TCF epoch 1 → 2. Length-safe: the reverse walk now also verifies the reverser's `train_length_mm` body, swept behind the target X, is fully covered by held known-length track (`reverseBodyCoveredByHeldTail`, mirroring ADR-016 tail-release) — else it refuses (report, don't force), closing a latent occupancy gap where a length-aware body swept into untracked track. Totality finding: under block exclusivity the forward yield (ADR-017) + reverse authority partition and resolve every two-train closed standoff whose reverser has a body-covering retreat; the residual report case is a body that sweeps past its tracked tail. Deferred: operator-initiated reverse + single-pass cascading multi-train retreat. |
| ADR-023                                        | accepted (not impl) | Runtime train length changes. Scope deliberately narrowed: the system models a train's **length**, never its composition. Magnetic toy carriages a child swaps by hand are invisible to core (ADR-016 upheld); the only consequence is a length change. New `train_length_changed` event + `core.reports_length` capability (mirroring `core.assigns_tags` enforcement) make `train_length_mm` runtime-mutable and assertable by a device other than the train; scheduler re-derives occupancy with existing tail-release machinery. Explicitly NO identity lifecycle, NO coupling clearance / ADR-011 exception, NO coupling maneuver. Value validation resolved **gate-only** (no oracle exists; producer trusted like a tag-assigner). Detection of a manual swap is a hardware concern outside the ADR — see the experimental vision length station. |
| Experimental devices log                       | shipped | `docs/experimental/` — speculative viability-test device specs that prove a protocol seam without being normative, judged by "does the API support the action?" not build-realism. Five entries, conceptually grouped into an (unbuilt) **"Experiments" box** in the toy-box tray; each covers API events/data, action goal, visible goal, and toy-box element + animation. [001 vision length station](experimental/001-vision-length-station.md) (CV measures + reports `train_length_mm`); [002 turntable junction](experimental/002-turntable-junction.md) (the switch seam is already N-way — `valid_positions`/`requires_switch_state` string match; a 3-way junction is a piece-geometry task, not a core change); [003 crane cargo station](experimental/003-crane-cargo-station.md) (payload manipulation via dwell+identity+clearance, crate stays out of core like carriages — needs only a cosmetic carriage cargo-slot in the sim); [004 wedge decoupler](experimental/004-wedge-decoupler.md) (ADR-023 decrease direction; isolates the device from the hard *shunting orchestration*, steered by the Inglenook/Timesaver puzzles); [005 lift bridge](experimental/005-lift-bridge.md) (`core.gates_clearance` expresses physical track availability, not just traffic policy). Held-state across the batch resolved as `core.gates_clearance`, not dwell timers. |
| `docs/research/bridges-and-height-layers.md`   | shipped | Research note on bridges and multiple height layers — groundwork for the editor-layers + ramp work in simulator-ui. |
| Live clearance overlay                         | shipped | Retained `railway/state/clearance/<train_id>` topic per train; visualiser renders cleared edges with `data-cleared-to` + per-train hue. ADR-011 made it useful; phase 3 made it visible. |
| Visualiser facelift                            | shipped | Edges as cubic bezier `<path>` arcs with **per-marker tangent continuity** (adjacent edges meeting at a marker share their tangent → smooth flow through the marker, no opposing-curve kinks); 6px → 9px stroke when cleared. Trains as top-down 5-point shapes: rectangular body, smooth rounded nose at the front, rotated to the bezier tangent at their current `t`, filled with `trainColor(train_id)`. All `data-*` attributes preserved for ui-tests + the live-driving doc. |
| Deadlock detection + UI banner                 | shipped | Scheduler runs a waits-for cycle check on every `retryBlockedClearances` pass. Cycles publish to `railway/state/clearance` (entity `deadlock/active`) carrying the involved train IDs; the visualiser's `DeadlockBanner` shows them in their per-train hues with a recovery hint. Doesn't *resolve* the deadlock — that's an authoring decision (more markers, a passing siding). |
| `docs/status.md` (this file)                   | shipped | New.                                                                           |

---

## Open design questions

Mirrored from [`CLAUDE.md`](../CLAUDE.md). Need ADRs before implementation.

Resolved since: conflict resolution (ADR-017), multi-gate semantics (ADR-018),
topology violations (ADR-019), ESP-NOW bridge wire format (ADR-021),
reverse-authority primitive (ADR-022), tag→marker resolution at runtime
(ADR-007 — implemented; the simulator drives real `tag_assignment` events, no
`tag_id == marker_id` shortcut). Still open:

- Coupling/decoupling — resolved by narrowing in ADR-023 (**Accepted**): the system models train *length* only, never composition; magnetic carriage swaps are just runtime length changes. No internal coupling/identity concept, by design. Implementation pending.

---

## Suggested next priorities

Ranked by leverage. None are mandatory; this is the recommendation, not the plan.

1. **Implement ADR-023 (runtime train length changes)** — now **Accepted**, design settled (length only; gate-only trust; no coupling/identity model). Build it: `train_length_changed` event + `core.reports_length` capability making `train_length_mm` runtime-mutable and externally assertable, scheduler re-derives occupancy with existing tail-release code. Small, low-risk. Optional companion: the experimental vision length station (`docs/experimental/001`) as the satellite proving external length reporting end-to-end.
2. **Operator-initiated reverse + recovery UI** — ADR-022 reverses a train autonomously to break a deadlock; a manual "back this train out" gesture is a thin wrapper over the same `grant_reverse` + `computeReverseTarget` machinery, alongside the ADR-019 recovery surface (`reanchorTrain` / `confirmNewTrack` exist on the server with no operator surface yet).
3. **Aggregated multi-gate block-reason view** — deferred in ADR-018; a scheduler-emitted "marker blocked by [reasons]" snapshot so operators see *why* a marker is held when several gates contend.

Recently shipped (cleared the previous backlog): conflict resolution (ADR-017), multi-gate test (ADR-018), topology violations (ADR-019), HTTP query API (ADR-020), ESP-NOW codec incl. per-type payloads (ADR-021), reverse authority (ADR-022), tag→marker resolution regression test (ADR-007); learned traversal times now drive the clearance horizon; `train_status` battery + error_state surfaced in the visualiser.

Smaller follow-ups that don't need a major thread:

- Per-type-codec field anti-drift guard for TCF (ADR-021): nothing currently ties a per-type codec's fields to its TypeBox schema, so a future field added to e.g. `clearance_request` would be silently dropped.
- ADR + implementation for missing detection knobs (double-read, spurious read).
- Per-train spawn config form in simulator-ui (mishap rate knobs from ADR-006).
