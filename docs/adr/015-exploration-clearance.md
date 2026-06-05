# ADR-015: Exploration clearance (open-ended discovery driving)

## Status

Accepted. Amends ADR-014 (track-learn mode).

## Context

ADR-014 set out to break the discovery deadlock it stated plainly:

> edges are learned from traversals, but the system can't plan a route for a
> train until it already knows the edges. … Without a route, the train won't
> move; without movement, no traversals; without traversals, no edges.

But the mechanism ADR-014 actually shipped does **not** break that deadlock at
cold start. `LearnMode.driveOneStep` drives the train one edge at a time by
picking the next edge from the **known** graph (`LayoutState.edgesFrom(marker)`)
and issuing `assign_route` + `grant_clearance` for it. On a fresh `--discovery`
layout the edge graph is empty, so `edgesFrom` returns nothing, `driveOneStep`
selects no edge, and **no command is ever sent**. The train sits forever; the
deadlock ADR-014 named is intact.

This was found live: build a circle in the toy-table, scan it (8 markers, 0
edges), press *Learn track* — the train never moves, because LearnMode has no
first edge to route along.

The root mismatch is conceptual. Discovery is *not* a routing problem. A train
discovering unknown track does not need to be told which edge to take next — it
simply rolls forward and the rails carry it to the next marker, which it reports.
Routing a train edge-by-edge presumes the routes are already known, which during
discovery they are not. Edge-by-edge driving is the wrong primitive for the job.

## Decision

Introduce a single **exploration clearance**: an open-ended grant that
authorises a train to drive forward across markers *indefinitely*, following the
physical track, until explicitly released. Discovery uses this one primitive
instead of per-edge route+clearance.

This stays squarely within "clearance, not commands": the train does **not**
move until it receives the exploration grant (default remains stopped/safe). The
grant is just open-ended — "proceed and keep reporting" — rather than a named,
bounded route. And it honours "trains as autonomous agents": the train follows
the rails itself; the server neither routes it nor streams it commands.

### Protocol (minor bump 0.2.0 → 0.3.0)

One new core command:

- `begin_exploration` — payload `{ reason?: string }`. Authorises open-ended
  forward motion. Backward-compatible addition (devices that don't understand it
  ignore it), so a minor version bump per `version.ts`.

Released by the **existing** `revoke_clearance` (and `emergency_stop`) — no new
stop command. Revoking the open clearance ends exploration and the train stops.

### Simulator (`VirtualTrain`)

On `begin_exploration` the train enters an `exploring` state: target velocity =
max, and at each marker it **continues onto the next physical edge instead of
parking**. It chooses that edge from its own `LayoutState` — the sim's
ground-truth rails — via `edgesFrom(marker)`:

- exactly one outgoing edge → take it;
- a junction (several) → take the branch whose `requires_switch_state` matches
  the current switch position (`getSwitchPosition`); if none matches, stop
  (the points are set against every branch);
- no outgoing edge (a terminus / dead end) → stop.

It emits `tag_observed` at each marker as before. `revoke_clearance` /
`emergency_stop` leave the exploring state and bring it to rest. This is faithful
to a real RFID train: it has no map, the rails (and the physical switch) decide
where it goes; the sim's `LayoutState` *is* those rails.

### Server (`LearnMode`)

`learn_track_start` now drives via exploration rather than edge-by-edge routing:

- On entering `driving`, issue **one** `begin_exploration` to the seized train.
- The scheduler keeps learning edges passively from the resulting traversals
  (ADR-009 `recordTraversal`, unchanged). LearnMode continues to read
  `LayoutState` after each `tag_observed` and tracks `markers_visited` /
  `edges_learned`.
- **Completion**: when the train returns to its `start_marker_id` having
  discovered no new edge since the previous visit to start (a full lap that
  mapped nothing new), LearnMode issues `revoke_clearance` and → `complete`.
- **Terminus**: a terminus has no outgoing edge, so the exploring train stops
  there of its own accord; LearnMode sees the train at a `terminus` marker →
  `paused_terminus`, revokes, and awaits a re-scan elsewhere (ADR-014 semantics
  unchanged).

### Junctions

v1 follows the physical switch position during a lap. Between laps LearnMode may
flip a junction's switch (`set_switch_position`, reusing ADR-014's logic) to
expose an unexplored branch on the next lap. Fully automatic multi-branch and
disconnected-component exploration remains the documented follow-up ADR-014
already postpones — this ADR does not regress it.

## Consequences

- Cold-start discovery finally works end-to-end from the UI: snap a loop
  together, scan it, press *Learn track*, and the train drives itself around
  while the layout maps itself — delivering what ADR-014 promised.
- The per-edge driving machinery in LearnMode is replaced, for discovery, by the
  exploration primitive. Scheduled operation (planner → `assign_route` +
  bounded `grant_clearance`) is untouched.
- One new wire command and a minor protocol bump; the spec records it.
- A train under exploration will circulate a closed loop forever if never
  released; LearnMode's completion check (and the operator *Stop learning*
  button) are what end it. A stray exploration grant with no releaser is a
  runaway — exploration is therefore only ever issued by LearnMode, which owns
  its release.
