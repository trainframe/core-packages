# ADR-019: Topology violation handling

## Status

Proposed. Refines [ADR-009](009-discovery-mode.md) (always-on discovery) and
relates to [ADR-014](014-track-learn-mode.md) (track-learn) and
[ADR-015](015-exploration-clearance.md) (exploration clearance).

## Context

A train reports the markers it crosses. After tag resolution the scheduler
turns each `tag_observed` into a `marker_traversed` and, in
`handleTrainAtMarker`, calls `LayoutState.recordTraversal(previousMarker,
markerId, …)`. Per ADR-009 discovery is *always on*: if no edge
`previousMarker → markerId` is known, `recordTraversal` **silently creates one**
as an inferred edge.

That is exactly the right behaviour while a train is *discovering* track. It is
the wrong behaviour while a train is running an assigned route. Consider a train
under a bounded route + clearance sitting at marker `P`, whose only known
outgoing edge is `P → Q`. The next event reports marker `M`, and the graph has
no edge `P → M`. Today the scheduler shrugs and learns `P → M` — a phantom
edge born of, most likely, a misread tag, a skipped marker, or the train having
been physically lifted and replaced. That phantom edge is now a permanent fact
the planner may later route a real train across — into a wall.

This is the open design question recorded in CLAUDE.md:

> Topology violations: a train reports a marker the graph says shouldn't be
> reachable from where it was.

The system already carries two hooks for the answer without using them for this
purpose: `marker_traversed` carries `inferred_edge` (the edge the server
concluded was just completed, ADR-004/ADR-016), and `train_status` already
defines a `clearance_block_reason` literal `'unknown_topology'`. The reason
exists in the protocol but nothing in the scheduler emits it.

### The three causes, and why they cannot be auto-distinguished

An "unreachable marker" report has (at least) three real-world causes:

1. **Sensor fault** — a tag misread, a skipped/missed marker, a duplicate read,
   or a stale event. The train is roughly where the graph thinks; the *report*
   is wrong.
2. **Genuine new edge** — the track really does connect `P → M` and the graph
   simply has not learned it yet.
3. **Lifted-and-replaced train** — the train was physically moved to an
   unrelated part of the layout. Its last-known position is now meaningless.

The critical constraint: **from the event alone these are indistinguishable.**
A single `marker_traversed` reporting an unreachable `M` looks identical in all
three cases. Any heuristic that tries to classify them automatically (e.g.
"`M` is within K hops of `P`, so it was probably a missed read — keep rolling")
picks an arbitrary `K` and, whatever it picks, leaves the train's true position
genuinely uncertain while continuing to grant clearance. That violates "default
state stopped/safe."

## Decision

### 1. Gate auto-learn on per-train expectation (refines ADR-009)

ADR-009's "always-on discovery" is refined to: **auto-learn an unknown
adjacency only when the reporting train has no bounded expectation it
contradicts.** Otherwise, validate the report against the graph and, on
contradiction, treat it as a **topology violation** and hold.

The discriminator is *per-train state the scheduler already holds* — not a new
flag. A train is in **expecting** mode when it is running a bounded route +
clearance: it has an assigned route and a non-empty `cleared_edges` /
`clearance_limit_marker_id`. A train is in **open** mode when it is exploring
(ADR-015 `begin_exploration`) or being driven by track-learn (ADR-014), i.e.
under an open-ended grant with no bounded next edge to contradict.

- **Open mode** → an unexplained adjacency *is* the discovery signal. Learn it,
  exactly as today. This is the only context in which ADR-009's auto-learn
  fires.
- **Expecting mode** → an unexplained adjacency contradicts a route the
  scheduler issued. It is a topology violation. Do **not** learn the edge; hold.

This is the load-bearing sentence: discovery learns; bounded operation
validates. The same physical event (unknown `P → M`) is a *fact to record* under
exploration and a *fault to flag* under a route, and the scheduler can already
tell which from the train's own state.

The coarse global `--discovery` layout is the degenerate case: with no routes
assigned, every train is in open mode and behaviour is unchanged. Keying off
per-train route/clearance state is strictly more precise and is checkable from
existing `TrainState`; it is the default. The global flag is only the
all-trains-open coarse case.

### 2. The safety action is uniform across all three causes

Because the three causes cannot be distinguished from the event, the
**automatic** action must not branch on them. On a topology violation the
scheduler always does the same thing: **declare the train's position uncertain,
stop it, and flag it.** The cause taxonomy lives in the operator-facing
explanation and recovery options (§5, §6), never in an auto-classifier that
decides whether to keep the train rolling.

### 3. Protect the train and its neighbours via block exclusivity

Position uncertainty is expressed in the vocabulary ADR-002 already enforces, not
a parallel mechanism:

- **The violating train** is held: its onward clearance is withheld
  (`clearance_limit_marker_id` pinned to its last *certain* boundary, no further
  grants). Default-safe: a held train without clearance stops.
- **The uncertain region** — last-known marker `P`, the reported marker `M`, and
  any edges the train might be straddling between them — is treated as
  **occupied** by this train (retained in its `cleared_edges`). ADR-002 block
  exclusivity then denies those blocks to every peer **for free**: no peer is
  granted a conflicting edge while we do not know where this train physically
  is. If `M` is entirely unknown to the graph (no incident edges), the hold is
  maximal — the train is treated as occupying an unknown location and no onward
  grants are issued until an operator re-anchors it.

No new neighbour-holding system is introduced; uncertainty is just occupancy the
clearance system was already built to honour.

### 4. What is emitted (visible to operators and the visualiser)

Two surfaces, and the producer of each must be honest. `train_status` is a
*train-emitted* event — the scheduler cannot set fields on it — so the
scheduler-owned signal rides the retained **clearance state** the scheduler
already publishes, not `train_status`.

- **Retained, scheduler-owned.** The scheduler already publishes retained
  clearance state to `railway/state/clearance/{train_id}` on every clearance
  mutation (`clearanceStateEffect`, today carrying `cleared_edges`). The hold is
  surfaced here by adding a `block_reason: 'unknown_topology'` field to that
  retained payload — a scheduler-produced "this train is held, and why" signal
  the visualiser reads alongside the (now empty / pinned) cleared edges. Reusing
  the pre-existing `'unknown_topology'` literal keeps the vocabulary aligned with
  `train_status.clearance_block_reason`, which a train MAY independently echo
  when it perceives the hold; the two need not be conflated, and the
  authoritative producer for the violation is the scheduler.
- **Event (new).** A non-retained `topology_violation` event on
  `railway/events/topology_violation/{train_id}`, carrying:

  ```
  {
    train_id:           string,
    last_known_marker_id: string,   // P (the last certain position)
    reported_marker_id:   string,   // M (the unreachable marker)
    suspected_cause:    'sensor_fault' | 'unknown_edge' | 'lifted_train' | 'unknown',
    detected_at_ms:     number
  }
  ```

  `suspected_cause` is a *hint* for the operator UI, never an input to the
  automatic action (§2). The scheduler defaults it to `'unknown'`; richer
  inference (e.g. "`M` exists in the graph but is non-adjacent" ⇒ more likely a
  missed read than a brand-new edge) MAY refine the hint without ever changing
  the hold.

These are backward-compatible protocol additions (a new event type, plus an
optional `block_reason` field on retained clearance state; consumers that don't
understand either ignore it) → a **minor version bump**, following the ADR-015
`begin_exploration` precedent. The spec records the new event and the new
clearance-state field carrying the pre-existing `'unknown_topology'` reason.

### 5. Deterministic decision procedure

In `handleTrainAtMarker`, beside the existing `recordTraversal` call, before
learning anything. `P` = `train.last_marker_id` (previous), `M` = reported
marker. All steps are pure `LayoutState` graph lookups — no I/O, no clock, no
randomness — so determinism is preserved.

1. **`P` undefined** (train's first report, position not yet anchored) → accept
   `M` as the anchor. Nothing to validate against.
2. **`M == P`** → a re-read of the current marker → ignore, no traversal.
3. **Edge `P → M` exists in the graph** (confirmed *or* inferred) → normal
   traversal; proceed exactly as today (`recordTraversal`, clearance top-up).
4. **Edge `P → M` absent AND train in open mode** (exploring / track-learn /
   no bounded route) → learn it as an inferred edge (ADR-009 unchanged).
5. **Edge `P → M` absent AND train in expecting mode** (bounded route +
   clearance) → **topology violation**: do not learn the edge; apply the hold
   (§3); emit the signals (§4).

### 6. Recovery (and the bridge back to track-learn)

A held train does not auto-resume; recovery is an explicit operator gesture,
which is also where the cause taxonomy is finally resolved by a human:

- **Re-anchor.** The operator re-scans the train at a known marker (or confirms
  its position). This re-establishes a certain `last_known_marker_id`, the hold
  is lifted, and scheduled operation can resume. This covers the sensor-fault
  and lifted-train cases.
- **Confirm new track.** The operator confirms `P → M` is real new track. This
  is precisely the track-learn gesture (ADR-014): the edge is learned and the
  hold lifts. A topology violation under a route is therefore a clean entry
  point into learn mode — "this looks like undiscovered track; learn it?" — not
  a dead end.

The operator-side topics and the visualiser surface for these gestures reuse the
ADR-014 learn-track operator channel and are detailed when implemented; this ADR
fixes the scheduler behaviour and the wire surface, not the UI.

### Where this lives

This is **core position-validation logic**, of a kind with clearance itself: it
reasons over the logical graph and the train's clearance state and decides
whether onward clearance may be granted. It belongs in the scheduler, in the
`handleTrainAtMarker` path, reading `LayoutState`. It is emphatically **not**
device-class-specific logic, so it is not expressed as a capability — there is no
device whose behaviour this customises; it is the scheduler's own duty to refuse
to drive a train whose position it cannot vouch for. The procedure is pure graph
queries (§5), satisfying the determinism requirement; no capability hook is
touched.

## Consequences

- **A misread no longer becomes a permanent phantom edge under a route.** The
  trade-off this resolves: pure auto-learn is frictionless but one bad read
  poisons the graph forever and can later route a train into a wall;
  hold-on-violation is safe but a flaky sensor adds operator friction (a hold +
  re-scan). The per-train mode gate buys both — frictionless learning while
  exploring, strict validation under a route — instead of choosing one globally.
- **Default-safe is preserved.** Uncertain position ⇒ stopped train ⇒ neighbours
  denied the uncertain blocks, all through the existing clearance system. No new
  safety mechanism, no new failure mode.
- **One new event, one new field on retained clearance state; a minor protocol
  bump.** The `'unknown_topology'` reason finally has a scheduler-side producer
  (on retained clearance state, not on the train-emitted `train_status`).
- **ADR-009 is narrowed, not reversed.** Always-on discovery becomes
  always-on-*while-open*. Pure-discovery layouts and learn/exploration sessions
  are unaffected.

### Deferred follow-ups

- **Cause inference for the operator hint.** `suspected_cause` ships as
  `'unknown'` with at most a coarse "M is a known non-adjacent marker"
  refinement. Sharper inference (recent traversal history, repeated misreads
  from one tag ⇒ likely faulty sensor) is a later enrichment that must never
  feed the automatic action.
- **Automatic re-anchoring.** If a held train's *next* report is consistent with
  a plausible single missed marker (e.g. `P → X → M` where both edges exist),
  the system could in principle re-anchor at `M` without operator action. This
  ADR deliberately does **not** do that — it would re-introduce the "keep
  rolling on a guess" hazard §2 rejects. Revisit only with explicit operator
  opt-in.
- **Multi-train uncertain regions.** The hold treats the violating train's
  uncertain span as occupied. Interaction with a *second* train already holding
  part of that span (contention during uncertainty) is governed by the
  unresolved clearance-contention question (CLAUDE.md) and is out of scope here.
