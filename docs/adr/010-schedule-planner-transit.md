# ADR-010: Schedule / Planner / Transit — three-layer route model

## Status

Accepted

Partially supersedes [ADR-004](004-edge-based-routes.md): edges remain the
unit of clearance and execution (called *sections* in this ADR's vocabulary),
but they are no longer what an operator hands the system. The operator
hands the system a *schedule*; the *planner* turns that into a *transit* of
edges on demand.

## Context

The current `assign_route` command takes `{ route_id, edges: EdgeRef[] }`. The
operator (or anything upstream of the scheduler) is responsible for handing
the system a flat list of edges to traverse. This has three failures we no
longer want to live with:

1. **It does not match the user's mental model.** The operator's intent is
   "this train stops at SA, then at SB, then back to SA, …" — a sparse list
   of *stops*. Computing the edge sequence is the system's job, not the
   operator's. The simulator-ui route builder is a long workaround for
   the fact that we currently make a human do this.
2. **It is implicitly finite.** A list ends. Trains on toy track loops do
   not end. The sim-ui has been building 50-edge "routes" to fake
   indefinite running. That is a code smell that exposes the wrong shape.
3. **It throws away the graph.** The layout is a graph (markers + edges +
   junctions) that already encodes everything needed to find a path
   between two markers. The edge-list form discards that structure at the
   first hop and forces every consumer to think in linear terms.

The architectural error is mixing the operator-facing concept (a schedule of
stops) with the execution-facing concept (a clearance-locked sequence of
sections). They should be different layers. This ADR introduces the planner
layer that sits between them.

## Decision

### Vocabulary

- **Schedule.** The operator-facing artefact. An ordered list of *stop*
  marker IDs. Implicitly cyclic — after the last stop the train heads back
  to the first. Carried on the wire in `assign_route`. (We keep the
  command name; the payload shape changes.)
- **Transit.** The system-computed artefact. An ordered list of edges
  (`{ from_marker_id, to_marker_id }`) from the train's current marker to
  the next stop. Lives in the scheduler. Never crosses the wire on its
  own — the train still receives clearance grants one edge at a time as
  it does today.
- **Section.** The atomic locking unit. What ADR-004 called an "edge" in
  the clearance/block-exclusivity sense. The term is borrowed from
  mainline rail signalling (Pachl) and from JMRI; we adopt it in
  documentation and prose. The protocol field name `EdgeRef` stays for
  now to avoid a wire churn this ADR is not the right place for; rename
  is tracked separately.
- **Planner.** The component that takes a schedule and the current static
  layout and produces a transit. Lives in
  `packages/core/src/scheduler/planner.ts` as a peer of `Scheduler`,
  invoked by it.

This vocabulary is borrowed from the standard ATS → route-setting →
ATP/ATO layering used by real interlocking and CBTC/ETCS systems. Same
shape, smaller scale.

### Wire change

Two surfaces involved, with different ownership:

**Operator → scheduler** (HTTP admin API, `/api/trains/:id/route`). Body
becomes:

```jsonc
{
  "route_id": "morning-loop",        // unchanged: operator's name for it
  "stops": ["SA", "SB"]              // new: ordered marker IDs
}
```

The old `edges: EdgeRef[]` shape on this endpoint is removed.

**Scheduler → train** (MQTT command `assign_route`, defined in
`@trainframe/protocol/commands`). The payload shape stays
`{ route_id, edges: EdgeRef[] }` — but the semantics shift: the edges
are now a *transit* computed by the planner, not an operator-supplied
list. The train doesn't need to know about schedules; it just receives a
transit (and per-edge clearance grants on top of that, as today) and
walks it.

Both changes are pre-1.0; no migration shim. The spec bumps because the
HTTP body shape is observable to operators.

### Planner

A plain Dijkstra over `LayoutState`. The graph is small (tens to a few
hundred markers per layout in any realistic deployment), so the
worst-case run is microseconds. No A* — we don't reliably have spatial
coordinates and the heuristic gain at this scale isn't worth the
complexity.

**Critically: the planner is purely structural.** Inputs are the layout
graph and a `(from_marker, to_marker)` pair. The planner does **not**
look at:

- Which edges are currently held by other trains' clearance.
- Which position any switch is currently in.
- What schedules other trains are running.

The execution layer (clearance grants, section-level block exclusivity,
switch-state edge filtering — all already implemented) handles every
runtime contention case. If a train's transit passes through a section
held by another train, the train waits at the section boundary for
clearance, exactly as it does today. The planner does not need to know.

This is a deliberate departure from Factorio's signal-penalty
pathfinding. Factorio bakes signal state into edge cost and recomputes
periodically, which produces a known family of bugs: oscillation
between two trains, deadlocks invisible to the planner, and "train
tries to path through a permanently-blocked section forever" (FFF #233
and the LTN mod author's writeups document these in detail). By
contrast, the rail interlocking world separates route-setting (static)
from MA grant (dynamic) — they are different layers because they have
different correctness properties. We adopt that separation directly.

The consequence the operator most cares about: **two trains chasing
each other around a single-loop layout coexist naturally.** They share
the same transit. Section blocking provides the spacing. The planner
ran once per arrival per train; no replan ever fires because nothing
about the transit is structurally invalid.

### Replanning triggers

The planner is invoked:

1. **On schedule assignment.** Plan the first transit (current marker to
   stops[0]).
2. **On arrival at the current target stop.** Plan the next transit
   (just-arrived stop to next stop in the schedule — wrapping to stops[0]
   after the last entry).
3. **On topology change** (`LayoutState` mutated by discovery, operator
   edit, etc.) if and only if the current transit references an edge
   that no longer exists. Otherwise the existing transit stays valid.

Replanning is **not** triggered by clearance state changes, switch
position changes, or peer trains' schedule assignments. None of those
affect transit validity in a planner that ignores runtime state.

### Switches

When a transit includes an edge with `requires_switch_state`, today's
scheduler refuses to grant clearance until the switch state matches.
The planner does nothing extra here — same as for clearance holds. A
later iteration may emit `set_switch_position` commands so the system
actively throws switches rather than waiting for an operator; that's
a follow-up, not in scope for this ADR.

### Termini

A schedule consisting of a single stop, or a schedule whose stops form
an unreachable target from each other through the static graph, is a
configuration error. The planner emits an anomaly (`severity: 'warning'`,
description naming the unreachable stop), the schedule is rejected, and
the train stays parked. No partial-execution semantics.

A train that reaches its final stop and is on a single-stop schedule
parks at that stop. Cyclicity is a property of the schedule (more than
one stop → cycle through them); it is not a flag, and there is no
`is_cycle` field anywhere.

### Deadlock

Out of scope to *resolve*; in scope to *detect*. When N trains are all
parked indefinitely with each blocking a section the next one needs,
the scheduler emits an anomaly identifying the cycle. The operator
intervenes — revoke a route, despawn a train, throw a switch by hand.
A real fix (priority arbitration, automated reroute, etc.) is a future
ADR.

Detection is cheap: every clearance retry that fails because the next
edge is held by another train can write a "(this train, that edge)
waits-for" record. A periodic check for a cycle in the waits-for graph
catches deadlocks within seconds. Implementation is straightforward
once the planner work lands; the deadlock detector is a separate
follow-up commit.

## Consequences

- **Operator workflow simplifies dramatically.** The sim-ui route
  builder's "click every marker through the planned path" UI is
  replaced by a "pick the stops" UI. Schedules of 2–3 stops replace
  routes of 50+ markers.
- **No more 50-edge "routes" to fake indefinite running.** Loops are
  the default; schedules describe stops, not laps.
- **The Factorio-style oscillation and deadlock-bait failure modes do
  not apply to us.** We get them for free by separating the layers.
- **The clearance/block-exclusivity machinery, the switch-state
  filtering, the `revokeClearance` path, the `device_disconnected`
  cleanup, all of `core.gates_clearance` — none change.** The planner
  slots in above them; below stays as is.
- **ADR-004 stands for execution and clearance.** Sections (née edges)
  are the unit of locking and the disambiguation primitive at
  execution time. ADR-004's reasoning ("figure-8s and shunting moves
  need edge-level disambiguation") still holds at the transit layer.
  This ADR only changes what we accept *from the operator* — sparse
  stops instead of dense edge sequences.
- **Migration cost.** The sim-ui's `SimControls` route builder needs
  to be rewritten; the `assign_route` payload changes; tests that
  hand-wrote edge lists become schedule lists. The simulator-ui
  preset layouts and at least one integration test currently use the
  old form. One-shot refactor, no compatibility layer.
- **Naming pass.** "Route" in code means too many things today (the
  schedule, the transit, the train's progress index). Worth a
  one-pass grep-and-rename: `route` → context-appropriate term, so
  prose, types, and field names line up. Done up front to avoid
  half-converted state leaking.
- **Deadlock surfaces explicitly instead of silently.** A schedule
  that produces a deadlock used to look like "train just stopped
  moving" to an operator. Now they get an anomaly with the cycle.
