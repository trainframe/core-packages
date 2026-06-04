# ADR-014: Track-learn mode

## Status

Accepted

## Context

ADR-009 established that the server learns layout topology from traversals: a
`tag_observed` event from a train produces a `marker_traversed` after tag
resolution, and pairs of consecutive `marker_traversed` events cause the
scheduler to infer a new edge via `LayoutState.recordTraversal`. Discovery is
therefore continuous and always on.

The catch-22: edges are learned from traversals, but the system can't plan a
route for a train until it already knows the edges. On a freshly-placed track
with no pre-declared layout (`--discovery` flag), the edge graph starts empty.
Without a route, the train won't move; without movement, no traversals; without
traversals, no edges. Discovery is in a deadlock at startup.

What's needed is an operator-initiated bootstrap gesture: "make the train drive
around and explore." Whoever issues that gesture must have two properties:

1. It is an *operator* — directing the system to take an action, not a physical
   device on the table doing something physical.
2. It is *system-facing* — issuing clearance and route commands directly to the
   server's scheduler output side, not acting as a device emitting events.

Per ADR-013, the simulator-ui is virtual hardware. Hardware does not have a
"drive my train for me" control; such a control would make the sim-UI a
co-scheduler, re-introducing exactly the coupling ADR-013 removed. The gesture
belongs on the operator surface: the visualiser.

## Decision

Add a **track-learn mode** owned jointly by the visualiser (operator surface)
and the server (state machine + command emitter). The sim-UI receives no new
controls.

### Operator topics

Two new operator-side topics:

- `railway/operator/learn_track_start` — optional payload `{ train_id? }`.
  Starts a session. If `train_id` is omitted the server uses the first
  registered train, or waits for one to register.
- `railway/operator/learn_track_stop` — stops the active session immediately
  and returns to idle.

### Retained state topic

`railway/state/track_learning/active` (retained, JSON):

```
{
  state: 'idle' | 'waiting_for_train' | 'driving' | 'paused_terminus' | 'complete',
  train_id?: string,
  markers_visited?: number,
  edges_learned?: number,
  start_marker_id?: string,
  last_marker_id?: string
}
```

The server publishes an idle snapshot on startup so the visualiser can render
the "Learn track" button immediately, even before any operator action.

### Wire commands reused

Learn mode emits no new message types. It drives the selected train using the
existing command set:

- `set_switch_position` — flip a junction before driving through it.
- `assign_route` — single-edge route assigned to the train.
- `grant_clearance` — one-edge clearance grant (`reason: 'track-learn'`).

It consumes one event: `tag_observed`, forwarded from the server's main dispatch
loop after the scheduler has processed it.

### Server module: `LearnMode`

`LearnMode` is a self-contained class in `packages/server/src/learn-mode.ts`.
It is a *peer* of the scheduler, not an extension of it. Its `LearnModePorts`
interface exposes read-only access to `LayoutState` and `registeredTrains`, the
ability to read a train's `last_marker_id`, and the ability to emit commands.
The class never mutates scheduler state.

**Ordering invariant:** `Server.handleMessage` dispatches an inbound event to
the scheduler *before* forwarding it to `LearnMode.onEvent`. This guarantees
that when LearnMode queries `LayoutState` — to find outgoing edges, or to read
the train's new `lastMarkerId` — the scheduler has already recorded the
traversal. Discovery happens in the scheduler; LearnMode just reads the result
and picks the next edge.

### State machine

Five states:

- **`idle`** — no session. Initial state; also the result of `learn_track_stop`.
- **`waiting_for_train`** — start received but no registered train with a
  known marker position yet. Transitions to `driving` when a `tag_observed`
  arrives from a registered train.
- **`driving`** — active. On each `tag_observed` from the seized train,
  LearnMode picks the next unvisited outgoing edge (falling back to the first
  outgoing edge when all have been visited), optionally flips the junction
  switch if needed, then issues `assign_route` + `grant_clearance` for that
  edge.
- **`paused_terminus`** — the train arrived at a `terminus` marker. No outgoing
  edges exist; there is nothing to do until the operator lifts the train and
  places it on a different section of track. When the train scans in again,
  LearnMode resumes from `waiting_for_train`.
- **`complete`** — the train returned to its `start_marker_id` with all
  outgoing edges from that marker already visited. The reachable graph from the
  start is fully traversed.

### Junctions

When the chosen next edge has a `requires_switch_state`, LearnMode checks the
junction's current confirmed position in `LayoutState`. If it differs, a
`set_switch_position` command goes to the junction marker before the route is
assigned. By preferring unvisited outgoing edges, LearnMode covers both
positions of every junction it passes through across successive passes.

### Terminus and operator recovery

A `terminus` marker has no outgoing edges and represents a physical dead end
(buffer stop, wall). LearnMode cannot continue past it without physical
intervention. On arrival it publishes `paused_terminus` and stops issuing
commands. The visualiser prompts the operator to pick up the train and place it
on a new, as-yet-unexplored section of track. When the operator scans the train
there, a fresh `tag_observed` triggers `waiting_for_train → driving` again with
the accumulated session state intact.

### Visualiser surface

`LearnTrackPanel` (in `packages/visualiser/src/components/`) subscribes to
`railway/state/track_learning/active` via `useTrackLearningState`. It renders a
single toggle button ("Learn track" / "Stop learning") and a status line
describing the current state in plain language. On click it publishes to
`railway/operator/learn_track_start` or `railway/operator/learn_track_stop`.

The panel lives on the visualiser, never the sim-UI. Per ADR-013, the
mechanical boundary (`noRestrictedImports`) already prevents the sim-UI from
importing visualiser components.

## Consequences

**What this enables.** A child can snap Brio pieces together, place a train,
press "Learn track" on the companion tablet, and have the system fully map the
layout — markers, edges, junctions — without typing any JSON. After completion,
schedules can be assigned immediately via the existing operator UI.

**What this postpones.** The current algorithm explores the reachable subgraph
from a single start marker in one session. Disconnected graph components (a
spur that is unreachable from the start without a physical lift-and-replace) and
open branches off the main cycle require operator intervention at each terminus.
A smarter learn that handles spur branches automatically, or one that
orchestrates multiple trains across disconnected components simultaneously, is a
future follow-up.

**Note:** junction pieces today emit `tag_assignment` when scanned by the
scan-box, but do not register a `controls_switch` motor device. Auto-flip via
`set_switch_position` therefore has no physical effect on the virtual junction
unless a `VirtualSwitch` or equivalent device is also present. This is an open
item tracked in the project memory file (`project_track_learn_mode.md`).
