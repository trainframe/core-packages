# ADR-009: Discovery mode and topology learning

## Status

Accepted

## Context

The spec calls for the server to learn the layout incrementally rather than demanding a fully-specified layout JSON up front. Operators bring up the system by running a train around the track; the system asks the operator to identify unknown tags as they appear and notes the order in which markers are traversed. After enough traversals the inferred graph stabilises into a confirmed layout. ADR-007 shipped the tag side of this (unknown tag → anomaly → assign-tag UI → registry); ADR-009 closes the loop on the graph side.

Concretely we need:

- A new tag binding for an as-yet-unknown marker should *create* the marker, not just point at a missing ID.
- Consecutive `marker_traversed` events that span a marker pair with no edge between them should *add* the edge to the graph as inferred.
- An inferred edge becomes confirmed after N traversals (default 3, configurable).
- Subscribers (visualiser) see graph changes live without restarting the system.

What we deliberately *don't* solve in this ADR:

- Edge length learning (`learned_traversal_time_ms_at_speed`). The protocol already has the field; populating it is mechanical follow-up.
- Cautious "one edge at a time" clearance in unknown territory. The current clearance grant model issues a single edge per `tag_observed` anyway, so the spec's intent is satisfied by accident.
- Visualiser styling of inferred vs confirmed edges. Worth doing once the graph-side work lands; tracked separately.

## Decision

### Where the inferred state lives

`LayoutState` owns the inferred bit and the traversal counter, exactly like it owns switch positions and the marker map today. Two new internal maps keyed by `edgeKey(from, to)`:

- `traversalCounts: Map<string, number>` — incremented on each successful `marker_traversed` for a train where the previous marker exists in the layout.
- The existing `LayoutEdge.inferred?: boolean` field stays the source of truth for the flag; LayoutState exposes a setter to flip it once a count threshold is met.

### What triggers what

`Scheduler.handleTrainAtMarker` (already the consequential method) gains two side effects:

1. **Edge inference.** If `train.last_marker_id` is set, that marker exists in the layout, and no edge exists from `last_marker_id` to the just-arrived marker, register an inferred edge and emit `update_state_snapshot` for the layout. The new edge has no `requires_switch_state`, no `estimated_length_mm`, and `inferred: true`.
2. **Traversal counter increment + confirmation.** For every traversal where an edge exists (inferred or not), bump the counter. When an inferred edge reaches the threshold, mark it confirmed and emit a layout snapshot update.

`marker_traversed` events carry `in_discovery_mode: true` whenever the just-traversed edge (or the new inferred edge) is inferred. The flag already exists in the schema; we now populate it meaningfully.

### Marker creation on tag assignment

`Scheduler.handleTagAssignment` already enforces that the emitting device declared `core.assigns_tags`. We extend the marker branch (`assigned_kind === 'marker'`) to call `layout.upsertMarker(target_id, marker_kind ?? 'unspecified')` before the registry update. If the marker already existed the call is a no-op; if not, the layout grows.

Newly-created markers are added without spatial coordinates. The visualiser already auto-places markers without `position` info around a circle, so the user sees them appear immediately.

### Retained layout updates

Every change to the graph (new marker, new inferred edge, inferred-to-confirmed flip) emits an `update_state_snapshot` effect for `layout/<layout_name>`. Server publishes that as a retained MQTT message. Visualiser's `useLayoutState` hook already subscribes to `railway/state/layout/+` and replaces its in-memory layout on each receipt; the new state is rendered immediately.

This is heavier on the bus than necessary at steady state (the whole layout is re-published on every marker addition) but trivial to implement and matches the existing pattern. If it becomes a hotspot, a future `railway/state/layout/<name>/diff` topic can carry diffs instead — out of scope here.

### Configurable confirmation threshold

`Server` and `Simulation` constructors take an optional `discovery: { confirmTraversals?: number }` settings bag, default `confirmTraversals: 3`. Passed through to the scheduler; LayoutState exposes the same value via constructor for symmetry with tests that construct LayoutState directly.

### Capability hook surface

No new hooks. The capability-based extensibility ADR (ADR-001) says scheduler-level rules go in the scheduler unless they're device-class specific; layout inference is universal, not per-device. `gates_clearance` etc. continue to vote on clearance the same way regardless of whether the edges they vote on were learned or declared.

## Consequences

- Discovery becomes a feature, not a docs claim. An operator can boot the server against an empty layout (markers only, no edges), drive a train, assign tags as they pop up, and end with a confirmed graph.
- The visualiser shows inferred edges live (because retained-state replays). Distinguishing inferred-vs-confirmed visually is a small UI follow-up.
- Existing tests that publish `marker_traversed`-equivalent events (via `tag_observed`) for marker pairs that *are* edges keep passing — counter increments don't change clearance behaviour.
- Tests that want a *closed* layout (no discovery learning) keep the same shape because the marker pair is always known.
- A real-world quirk: if a sensor misfires and produces a phantom marker traversal sequence, an inferred edge would be added. With the confirmation threshold of 3 such phantoms persist until either the operator deletes them or they're traversed enough times to confirm. Out of scope for this ADR; a later operator UI can surface inferred edges for review/delete.
