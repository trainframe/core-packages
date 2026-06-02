# Smart Railway API, Working Draft v0.2

A capability-based protocol for a distributed model railway system. Designed to be physically agnostic, extensible by third parties, and testable in simulation before any hardware exists.

**Changes from v0.1:** Simpler junction model (one marker plus switch state). Edge-based routes instead of marker lists, fixing repeated-marker ambiguity (figure-8s, loops). MQTT replaces WebSocket as the transport. Layout split into logical graph and spatial layout layers.

## Core principles

The server holds the authoritative model of the world. Devices report what they observe and execute what they're commanded; they do not coordinate among themselves. There is exactly one place where decisions are made.

Devices declare *capabilities* on registration, not types. The server schedules and routes by capability. New device classes can be invented by users without server changes, provided they fulfil capability contracts the server already understands.

Default state is safe. A train without an active clearance does not move. A switch with unknown position is not routed over. A block of unknown occupancy is treated as occupied.

Trains are autonomous within their assigned route. The server hands a train an ordered plan; the train executes it, requesting clearance at each block boundary and reporting progress. The server intervenes by modifying the plan or withholding clearance.

---

## Entities

**Tag**: an opaque identifier readable by some physical mechanism (RFID, QR, AprilTag, future: anything). Tags have no inherent meaning. The server stores `tag_id → entity` mappings established at registration time. A tag may identify a marker or a vehicle.

**Marker**: a logical point in the layout. A marker is what the server reasons about; tags are how markers are physically detected. One marker is normally backed by one tag. A marker has a `kind` describing its role (`block_boundary`, `station_stop`, `junction`, `terminus`, `yard_entry`, `unspecified`). A junction marker is a single node; the routing decision lives on its outgoing *edges*, keyed by switch state.

**Edge**: a directed connection from one marker to another. Edges carry metadata: estimated length, an optional `requires_switch_state` if the source is a junction, and learned traversal time at known speed. Edges are the unit of routing.

**Block**: typically equivalent to an edge for clearance purposes. A train holds clearance for one or more contiguous edges ahead of it. At most one train holds clearance for any edge at any time.

**Junction**: a marker with multiple outgoing edges, exactly one active at any time per the switch state. The marker itself has no special role beyond being detected; the structure lives on the edges.

**Layout**: two parallel structures: the *logical graph* (markers and edges, used for routing and clearance) and the *spatial layout* (2D positions and edge geometry, used for visualisation only). The logical graph is authoritative; spatial layout is presentational.

**Train**: a vehicle with onboard intelligence. Holds a current route (an edge sequence), a current clearance, and reports markers as it passes them. Identified by a stable train ID, which is in turn linked to a tag for physical identification (e.g. when scanned at a garage).

**Device**: anything that connects to the broker and declares capabilities. Trains, signals, switches, stations, cranes, garages, displays, the simulator: all are devices.

**Schedule**: the operator-facing intent. An ordered list of *stops* (marker IDs) the train cycles through indefinitely. Carried on the admin API; not on the device-facing bus. After the last stop the train heads back to the first. There is no "non-cyclic schedule" — single-stop schedules park the train at the stop. See [ADR-010](../adr/010-schedule-planner-transit.md).

**Transit**: the planner-computed per-leg sequence of edges from the train's current marker to its next stop. Re-computed on arrival at each stop. Lives in the server; reaches the train as the `assign_route` command's payload. Use of edges (not markers) ensures unambiguous progress tracking on layouts where the same marker is visited more than once (figure-8s, loops, shunting moves). Optional dwell instructions may be attached to specific edge transitions.

**Route** (historical term): a synonym for transit in the wire-level `assign_route` command and field names like `route_id`. Pre-ADR-010 callers used this for the operator-facing concept too; that role is now filled by Schedule.

**Clearance**: a server-issued permission for a specific train to occupy a specific sequence of edges up to a named limit. A train without clearance is stopped. Clearances are revocable.

---

## Capability model

A device declares a set of capabilities at registration. Each capability is a contract: a set of MQTT topics it publishes to and subscribes from. The server reasons in terms of capabilities, never device classes.

Defined capabilities for v0.2:

`identifies_vehicles`: the device reads vehicle tags and publishes `vehicle_identified` events. Onboard train readers, garage slots, and yard sensors all have this capability.

`reports_marker_traversal`: the device detects when a vehicle passes a marker. Typically a train (which knows its own ID and reads markers as it moves) but could equally be a trackside detector reading vehicle tags.

`controls_motion`: the device accepts motion commands and publishes motion-state events. Trains have this capability.

`accepts_route`: the device accepts route assignments and executes them, reporting progress. Trains have this capability (always co-declared with `controls_motion`).

`controls_switch`: the device accepts switch-position commands and publishes position-confirmation events.

`displays_aspect`: the device accepts aspect commands and shows them. E-paper signal heads, station departure boards, status displays.

`gates_clearance`: the device may withhold or grant clearance for trains at a specified marker. The extensibility hook: any device can become a clearance gate by declaring this capability and publishing `gate_state_changed` events for the markers it gates. Stations, crane-gated stations, manual stop buttons, "wait for kid to press button" puzzles: all gates.

`assigns_tags`: the device can assign meaning to previously-unknown tags. Garages and registration interfaces have this capability.

A device may declare multiple capabilities. A train: `identifies_vehicles` (its own tag, for garage scanning), `reports_marker_traversal`, `controls_motion`, `accepts_route`. A garage: `identifies_vehicles`, `assigns_tags`.

---

## The clearance model

This is the heart of the system. Everything stop-related is expressed as clearance, not commands.

When the server assigns a route to a train, the train does not begin moving. The server must also issue an initial clearance: "you may proceed along edges E1, E2, … up to limit marker M, after which you must stop unless re-cleared."

As the train approaches its clearance limit, it publishes a `clearance_request` event. The server may extend the clearance (forwarding the limit further along the route), withhold (the train will stop at its current limit), or revoke (the train must stop immediately).

Edge clearance is automatic: the server will not extend a clearance into an edge already cleared to another train. This is how block signalling falls out of the model.

Devices with `gates_clearance` may *also* withhold clearance at markers they gate. A station device gating marker `STATION_A_PLATFORM` may withhold clearance for a configured dwell time. A crane-gated station gates the same marker but withholds until the crane reports "payload dropped." From the train's perspective, both behave identically: stop at the platform marker, eventually receive an extension, proceed.

A train always knows its current clearance limit and the reason it cannot proceed past it (`block_occupied`, `device_gated`, `unknown_topology`, `manually_revoked`). Reportable via the `train_status` event.

---

## Transport: MQTT

The system uses MQTT as its application-layer protocol. A broker (e.g. Mosquitto) runs on the server host. Devices and the scheduler are MQTT clients.

### Topic structure

```
railway/events/{event_type}/{device_id}       # events from devices
railway/commands/{device_id}                  # commands to a specific device
railway/state/{entity_type}/{entity_id}       # retained state messages
railway/discovery/register                    # device registration handshake
```

Events use the `event_type` segment so consumers can subscribe selectively (the visualiser subscribes `railway/events/#`, the scheduler subscribes only to events it cares about). Retained state messages mean a fresh subscriber gets current train positions, switch states, and clearance grants without replaying history.

### Quality of service

QoS 1 (at-least-once) for events and commands. Idempotency is enforced via `event_id` / `command_id` UUIDs; receivers deduplicate.

QoS 2 is overkill and adds latency. QoS 0 is unsafe for clearance-related messages.

### Physical transport

Trains use WiFi (always-on, real-time bidirectional). Trackside battery-powered devices may use ESP-NOW with a bridge that republishes their messages onto MQTT, or Thread via a border router (also bridging to MQTT). The application protocol is the same regardless.

The bridge pattern: a more capable device maintains the MQTT connection on behalf of constrained ones, translating their messages and tagging events with the originating device ID. The simulator is also a bridge, fronting virtual devices.

### Authentication

Per-device credentials stored on the broker. Initial pairing via the garage device: scanning a new device's tag in the garage slot generates a credential pair, displayed for entry into the device. This is UX, not security; for v0.2, "good enough for a home toy."

---

## Event schema

All events have a common envelope, published as JSON:

```json
{
  "event_id": "uuid",
  "device_id": "uuid",
  "timestamp_device": "ISO8601 from device clock",
  "timestamp_server": "ISO8601 set on broker receipt",
  "event_type": "string",
  "payload": { ... }
}
```

The broker does not set `timestamp_server`; the scheduler does, on consumption. This keeps the broker generic.

### Event types

`device_registered`: a device has joined. Payload: declared capabilities, device kind hint (free-form, human display only), metadata.

`tag_observed`: a tag was detected. Payload: `tag_id`, optional `direction`, optional `confidence`. The server resolves `tag_id` to either a vehicle, a marker, or "unknown" and emits a derived event.

`marker_traversed`: server-derived from `tag_observed` when the tag resolves to a marker and the context indicates traversal (i.e. the reading device is a train, or a trackside detector reads a vehicle). Payload: `train_id`, `marker_id`, `direction`, `inferred_edge` (the edge the train is now on, computed from the route or the graph).

`vehicle_identified`: server-derived from `tag_observed` when the tag resolves to a vehicle and context is non-traversal (e.g. a garage scan). Payload: `vehicle_id`, `context_device_id`.

`train_status`: periodic and on-change: position estimate (current edge plus distance from start), speed, current clearance limit, route progress (edge index), battery level, error state.

`clearance_request`: train approaches its clearance limit. Payload: `train_id`, `current_limit_marker`, `next_edge_in_route`.

`clearance_granted`: server-emitted. Payload: `train_id`, new limit marker, edges newly cleared.

`clearance_revoked`: server-emitted. Payload: `train_id`, reason, immediate-or-at-marker.

`gate_state_changed`: emitted by `gates_clearance` device. Payload: `marker_id`, `state` (`granting` | `withholding`), optional `reason` (free-form, for human display).

`switch_state_changed`: emitted by `controls_switch` device. Payload: `junction_marker_id`, `position`, `confirmed` (boolean: physical state confirmed or only commanded).

`aspect_changed`: emitted by `displays_aspect` device when display updates.

`tag_assignment`: emitted by `assigns_tags` device. Payload: `tag_id`, `assigned_kind` (`marker` | `vehicle`), `target_id` (the marker_id or train_id this tag refers to), optional `marker_kind`, metadata. Updates the tag→entity map. Honoured only if the emitting device declared `core.assigns_tags`.

`anomaly`: emitted by anything; describes unexpected conditions: unknown tags, missed-marker timeouts, two trains in one block, switch position contradicting command. Free-form description, severity.

---

## Command schema

Commands flow from server to devices via `railway/commands/{device_id}`. Same envelope as events, with a `command_id` the device echoes in its acknowledgement event.

`assign_route`: to an `accepts_route` device. Payload: ordered list of *edges* (each identified by `from_marker_id` and `to_marker_id`), optional dwell instructions per edge transition, route ID. The edges here are the *transit* — the per-leg plan computed by the server's planner, not an operator-supplied route. Operators provide a sparse list of *stops* via the admin API; the server's planner translates that into the edge sequence the train receives here. See [ADR-010](../adr/010-schedule-planner-transit.md).

`grant_clearance` / `revoke_clearance`: to a `controls_motion` device. Payload: limit marker, reason.

`set_target_speed`: to a `controls_motion` device. Payload: speed (0.0–1.0 normalised; the device decides physical mapping).

`emergency_stop`: to a `controls_motion` device. No payload. Stop as fast as physically possible.

`set_switch_position`: to a `controls_switch` device. Payload: junction marker ID, desired position.

`set_aspect`: to a `displays_aspect` device. Payload: aspect string.

`hold_gate` / `release_gate`: to a `gates_clearance` device. Used for server overrides of local gate logic. Rare.

`assign_tag`: to an `assigns_tags` device. Payload: `tag_id`, `assigned_kind`, `target_id`, optional `marker_kind`, metadata. The server commits the assignment after the device confirms with a `tag_assignment` event.

---

## Topology: logical graph and spatial layout

Two parallel structures, kept separate by design.

### Logical graph

Markers as nodes. Edges as directed connections, each carrying:

- `from_marker_id`, `to_marker_id`
- `requires_switch_state` (optional; only if `from_marker_id` is a junction)
- `estimated_length_mm` (initially null; learned)
- `learned_traversal_time_ms_at_speed` (initially null; learned)
- `inferred` (boolean; true until traversed N times)

Routing operates on this. Clearance operates on this. The scheduler reasons in edges.

### Spatial layout

Marker positions in 2D space (`x_mm`, `y_mm`). Edge geometry described as a path (straight, curve with control points, S-curve, etc.). Used by the visualiser; the scheduler ignores it.

The visualiser auto-routes edges as smooth curves between marker positions when geometry is unspecified, and lets the user drag bend points to match the physical track. Edge lengths in the spatial layout do not affect routing; only the logical `estimated_length_mm` matters for the scheduler, and that's learned.

### Incremental discovery

A `tag_observed` event with an unknown tag generates an `anomaly`; the user assigns it a kind via the visualiser or garage. Once assigned, the tag becomes a marker.

A train traversing markers in an order the server has not seen before adds inferred edges to the graph. Each new edge is flagged `inferred` until traversed N times (configurable; default 3).

In territory the server doesn't fully understand, the server issues short clearances (one edge at a time) and uses each `marker_traversed` to extend the graph. This is "discovery mode": slow, cautious, no explicit calibration step required.

Edge length is learned: first traversal at known speed measures the time, server records `learned_traversal_time_ms_at_speed`. Subsequent traversals refine the estimate. Length in mm is derived if a reference length is known anywhere in the layout, otherwise time-based reasoning is sufficient for braking distance calculation.

Direction is recorded per-edge. An A→B traversal does not imply B→A is permitted. Reverse edges are added when a train traverses them.

Switches are linked to junction markers when a `controls_switch` device registers against a marker. Without a registered controller, a junction is "passive": its state is observed (from where the train ends up), not commanded. This means kids can build layouts with a mix of powered and manual switches without changing the API.

---

## Simulator

The simulator is a bridge fronting virtual devices, presenting the same MQTT protocol as physical hardware. Indistinguishable from real devices to the scheduler.

Models:

- Position, velocity, acceleration of trains, with configurable per-train physics
- Stopping distance with realistic noise
- Tag detection with configurable miss rate, double-read rate, detection delay
- MQTT message jitter and drop rate
- Battery drain (optional)

Physical and virtual devices may coexist in one running system. The visualiser is a separate MQTT subscriber, also indistinguishable to it.

---

## Open questions for v0.3

The semantics of *stopping at a marker*: distant + home pattern, or single-marker with calibrated overshoot? Probably both should be supported; the API needs to express which a given request is.

Conflict resolution policy when two trains request clearance into the same edge: first-come, route-priority, train-priority? Needs an explicit policy.

Route plans with conditional branches: "if gate X is held more than Y seconds, divert via edge Z." v0.2 routes are still linear edge sequences.

Coupling and decoupling: trains as multi-vehicle compositions. Currently a train is an atomic entity.

Multi-gate semantics: when several `gates_clearance` devices all gate the same marker, do they AND or have priority?

Topology violations: a train reports a marker that the graph says shouldn't be reachable from where it was. Repair behaviour vs. lockout?

The split between MQTT pub/sub and HTTP query API is currently informal; some queries (current layout snapshot, route planning request) might want a request/reply pattern. MQTT 5 has request/response built in; whether to use it or a separate HTTP server is undecided.

---

*End of v0.2.*
