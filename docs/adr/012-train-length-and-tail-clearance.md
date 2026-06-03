# ADR-012: Train length and tail-clearance release

## Status

Accepted

Extends [ADR-011](011-section-as-edge-plus-boundary-markers.md). The section-pair
locking rule treats every train as a point. This ADR generalises the release
side of that model to honour the train's physical length.

## Context

Under ADR-011 the scheduler releases an edge from a train's `cleared_edges`
the moment the train's head reports passing the edge's `to_marker_id`. That
is correct for a point train — head and tail cross the boundary at the same
instant — but on a real layout where the train has length, the *tail* is
still occupying the previous edge for a while after the head crosses. If the
scheduler releases the previous edge on head-cross, a chaser can pull in
behind before the tail is clear, ending in a physical collision.

The user asked for this to be innate rather than opt-in, with a deliberate
note that the protocol shouldn't grow a new device-emitted `tail_cleared`
event: trains typically don't have rear sensors. The information is
derivable from data the scheduler already receives.

## Decision

### Length is declared at registration

`device_registered` payloads gain an optional `train_length_mm: number`
field. The scheduler stores it on `TrainState.length_mm`. When absent or
0, point-train semantics apply (head-cross releases immediately) —
backwards compatible for every existing layout and test.

### Release is scheduler-internal, derived from `train_status`

No wire-level `tail_cleared` event. The scheduler subscribes to the
existing `train_status` event (which already carries
`estimated_distance_from_edge_start_mm`). When a train has `length_mm >
0` and that distance reaches `length_mm`, the tail has crossed the
current edge's `from_marker_id`; the scheduler filters `cleared_edges`
to drop edges whose `to_marker_id` matches and runs
`retryBlockedClearances`. For length-0 trains the existing
`marker_traversed` filter still fires.

### Scope: one previous edge at a time

For phase-2 simplicity, the implementation assumes
`length_mm < shortest_edge_length` along the train's path. A train
therefore spans at most two edges (current + one previous) at any
instant, and the tail-clearance check only needs to release a single
edge per `train_status`. Multi-edge-spanning long trains are noted as a
future refinement; their release would need a queue of pending releases
keyed by progress distance.

### Per-train learned traversal times

`LayoutState` now tracks per-train EWMAs alongside the global one.
`getLearnedTraversalMs(from, to, trainId?)` returns the per-train value
when present, falling back to global, falling back to undefined. The
global EWMA still accepts every observation so the population-wide
estimate stays useful for newly-registered trains. The per-train value
exists so a slow shunter doesn't pollute a fast express's predictions.

The scheduler doesn't yet *consume* this — `recordTraversal` just gains
the train-id arg. Reading from it (for braking distance / tail-clear
timing on hardware that doesn't report `distance_into_edge_mm` directly)
is a follow-up.

## Consequences

- **No new wire events, no new commands, no new capabilities.** The
  protocol surface only widens by one optional field on
  `device_registered`.
- **Point trains (the demo default) are unaffected.** All existing tests
  pass without modification; the release path branches on length=0.
- **Long trains visibly hold their section behind them.** Combined with
  ADR-011's shared-marker rule, a 200 mm train on a 200 mm edge will
  keep the previous edge locked for the full traversal — a chaser must
  wait for the lead's tail to clear before pulling in.
- **The simulator's `Spawn train` form exposes a Train length (mm)
  input.** Default 0 to keep behaviour identical; operators opt in to
  longer trains by setting a positive value.
- **`physical length < shortest edge length` is an authoring
  constraint.** Layouts where this is violated will see released-too-early
  behaviour for the under-covered section. The implementation doesn't
  enforce the constraint at registration; a future check could compare
  declared length against `LayoutState.shortestEdgeLength()`.
- **Multi-edge spanning, hardware tail-sensor events, and consumption
  of per-train EWMAs** are all left for future ADRs. The current change
  is the smallest one that makes long trains *correct* under the
  common case.
