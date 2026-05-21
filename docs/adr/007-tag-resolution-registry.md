# ADR-007: Tag-to-entity resolution registry

## Status

Accepted

## Context

The protocol spec defines tags as opaque physical identifiers (RFID, QR, AprilTag) that the server resolves to entities (markers or vehicles) at registration time. In code this resolution has never existed: the scheduler treats `tag_observed.tag_id` as if it were a `marker_id` directly, and the simulator emits tags whose IDs match the marker IDs they're attached to. The "tag IDs ARE marker IDs" shortcut is called out as an open question in `docs/spec/protocol-v0.2.md` and a deferred priority in `docs/status.md`.

This shortcut is fine for the current toy demos but doesn't survive contact with real hardware. A physical RFID tag is a 64-bit number; binding tag identity to logical marker identity at compile time means every layout edit invalidates the physical install. The spec wants tag identity and marker identity decoupled, with the binding established at registration ("scan the tag in the garage, choose what it identifies").

We need:

1. A runtime registry that maps `tag_id → { kind, target_id }`.
2. A path for the registry to be populated. Today: zero entries.
3. Behaviour when a `tag_observed` event arrives for an unknown tag.
4. A capability (`core.assigns_tags`) for the devices that contribute assignments.
5. A migration story for the simulator and existing tests, which currently emit `tag_id = marker_id`.

## Decision

### Registry shape

A new `TagRegistry` class lives in `packages/core/src/scheduler/` alongside `LayoutState`. It is held by the `Scheduler` and exposes:

```typescript
class TagRegistry {
  assign(tag_id: string, assignment: { kind: 'marker' | 'vehicle'; target_id: string }): void;
  resolve(tag_id: string): { kind: 'marker' | 'vehicle'; target_id: string } | undefined;
  unassign(tag_id: string): void;
}
```

Kept separate from `LayoutState` because tag-to-entity binding is operational state (created and revoked over a layout's life), whereas `LayoutState` is the logical graph (markers and edges). Mixing them muddles the two and complicates discovery-mode work later.

### Population is event-driven, no fallback

Tag assignments are established **only** by `tag_assignment` events on the bus. There is no JSON-side shortcut, no implicit "tag_id matches a marker_id so treat it as that marker", and no seed list on `LayoutState`. The registry is the single source of truth at runtime.

This is the strictest of the options considered. The fallback ("if tag_id matches a marker_id, accept it") was rejected because it silently undermines the registry's reason to exist and lets divergent state slip in (a tag that was deliberately *un*assigned would still resolve through the fallback).

Tests pay for this with a small amount of setup: every test that exercises `tag_observed` first publishes `tag_assignment` events for the markers it cares about. A test helper (`assignMarkerTags(...)`) batches the boilerplate. The helper publishes real events; it is not a back door into private state.

### Resolution flow inside the scheduler

`Scheduler.handleTagObserved` becomes:

1. Look up `tag_id` in `TagRegistry`.
2. If unknown: emit an `anomaly` event with `severity: 'info'` and a description naming the tag. No further effect. The operator can use the visualiser to discover the unknown tag and assign it.
3. If `{ kind: 'marker', target_id }`: behave as the current code does today, treating `target_id` as the marker the reading device just crossed. Continue with route advance + clearance extension as before.
4. If `{ kind: 'vehicle', target_id }`: derive a `vehicle_identified` event with `vehicle_id: target_id` and the `context_device_id` set to the reading device. Used by garages and yard sensors; no scheduling effect today.

### `core.assigns_tags` capability

The `core.assigns_tags` stub gains real hooks:

- `onEvent` for `tag_assignment` events: validate the payload, mutate registry, no state on the capability itself (the registry holds the truth).

Actually, simpler: keep the capability as a marker (a contract a device declares so the scheduler knows the device is allowed to assign tags). The scheduler handles `tag_assignment` events directly against the registry, the same way it handles `switch_state_changed` directly against `LayoutState`. Capability voting doesn't apply here.

A device's `tag_assignment` event is only honoured if the device declared `core.assigns_tags` at registration. The scheduler enforces this so that any device can't unilaterally rebind tags.

### Retained state for fresh subscribers

When a `tag_assignment` event lands, the scheduler emits an `update_state_snapshot` effect publishing the assignment to `railway/state/tags/<tag_id>` retained. New subscribers (the visualiser, a fresh server restart) see the current registry without replaying history.

Unassignments are not yet implemented; the registry has the API, but the protocol's `tag_assignment` event has no payload field for "remove". Defer until we have a use case.

### Simulator and existing tests

`VirtualTrain` is changed to emit `tag_observed` events with the tag ID it was configured with, separate from the marker ID it physically crosses. The default helper that wires a marker to a tag-id-equal-to-marker-id is kept *only* as a test convenience that publishes proper `tag_assignment` events to the bus on simulation startup — it is not a code path that bypasses the registry.

Concretely:

- `VirtualTrain` config gets a `marker_to_tag: Record<marker_id, tag_id>` map; the train emits `tag_observed` with the resolved tag ID when it crosses a marker that has an entry. Without an entry, no `tag_observed` is emitted (the train is invisible to the registry until someone tags its markers).
- `Simulation` gets a constructor option `register_tags?: 'identity'` which, when set, on startup publishes one `tag_assignment` event per marker via a synthetic `SIM-GARAGE` device that declares `core.assigns_tags`. The "identity" mode means each marker `M_x` gets a tag `M_x`. Tests that want this convenience opt in.
- Both default off in production builds; tests opt in.

## Consequences

- **Tests grow a setup line or two.** `setupSimulation(...).withIdentityTags()` is the typical shape. Manageable.
- **The protocol gains a retained-state topic family** (`railway/state/tags/*`). The visualiser and any new subscriber observe registry state cheaply. No protocol-version bump; `assign_tag` and `tag_assignment` already exist in the schema.
- **Unknown-tag anomalies become a real signal**, not an artefact of the shortcut. The visualiser can offer an "assign this tag" UI off the back of these anomalies. (Out of scope for this ADR.)
- **Discovery mode** (priority item) becomes easier: when an unknown tag is reported, the operator can register it on the spot via a garage UI; the scheduler then re-evaluates pending clearances. The infrastructure is the same retry-after-state-change pattern already used for gate releases and switch confirmations.
- **A capability gets meat.** `core.assigns_tags` enforces that only devices with the contract can change registry state.
- **What we don't get yet:** vehicle identity flows past `vehicle_identified` event derivation. Trains-as-vehicles in the registry is consistent with the spec but isn't yet exploited by the scheduler.
