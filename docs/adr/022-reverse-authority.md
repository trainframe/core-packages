# ADR-022: Reverse authority (curing the closed nose-to-nose standoff)

## Status

Accepted — implemented (June 2026). New core command `grant_reverse` — a
bounded, signed clearance to back UP to a named earlier marker; protocol bumped
0.6.0 → 0.7.0 (additive). The scheduler's deadlock path gains a second resolver
that, when the existing forward yield (ADR-017 §3) cannot fire, picks a reverser
by the same total order, verifies it can back into space it provably holds /
that is clear, and grants the reverse — breaking the closed standoff. The
`VirtualTrain` enacts the grant by driving backward along the edges it holds to
the granted marker. Where no member of the cycle can safely reverse, the
deadlock is still reported, unchanged.

This is the named follow-up [ADR-017](017-conflict-resolution-policy.md)
deferred under *"Reverse authority (the cure for closed standoffs)."* It builds
on [ADR-002](002-clearance-model.md) (clearance, not commands),
[ADR-011](011-section-as-edge-plus-boundary-markers.md) (a section is an edge
plus its two boundary markers), and the deadlock detector
(`detectWaitsForCycle`) ADR-017 reuses. It closes the open area CLAUDE.md /
docs/status.md record as *"Reverse-authority primitive."*

## Context

ADR-017 named the load-bearing constraint of the clearance model and then bumped
into it:

> **Withholding clearance cannot vacate a block a train already occupies.**

Its deadlock resolver (`tryYieldLowestRanked`) breaks a waits-for cycle by
*withholding* the lowest-ranked victim's not-yet-entered claims, so a
higher-ranked peer takes the freed block. That cures the passing-loop case — a
loser held at a boundary it merely holds. It explicitly **cannot** cure the
*closed nose-to-nose standoff*: two trains that have each physically entered
the block the other needs. Withholding asks a train that is already stopped to
not-move; it is a no-op. `tryYieldLowestRanked` therefore returns `null` for
that case and the scheduler keeps publishing the deadlock honestly, with no
programmatic way out.

The missing primitive is **reverse authority**: an explicit, bounded grant to
back a train *out* of an occupied block, to an earlier marker, so the section it
was sitting in becomes free for the peer. Today clearance only ever grants
FORWARD motion to a limit marker ahead of the head. Nothing in the model lets
the scheduler say "you may give ground."

Two design tensions shaped this:

**It must stay "clearance, not commands."** "Back up to X" can read like an
imperative — the very pattern ADR-002 rejected. The resolution is that reverse
authority is still a *grant*: a bounded, revocable authority to occupy a
*signed* run of track, not a streamed motor command. The train remains the
autonomous agent; it enacts the grant by following the rails backward, exactly
as a forward grant has it follow them forward. Default-stopped/safe is
preserved — absent the grant the train does not reverse, and a train that cannot
safely reverse simply doesn't (it reports, it is not forced).

**"How far back is safe" is the whole problem.** Reversing into another train
is the one thing that must never happen. The discriminator (and it is
simultaneously the safety check *and* the distance computation) is:

> Does the reverser have a backward target marker **X** such that (a) every edge
> on the path from its head back to X is one it already holds or that is
> provably clear — no peer shares any of its markers — and (b) once its head
> sits at X it no longer shares a marker with the peer's wanted edge?

If such an X exists, reversing to it is safe and resolves the standoff. If none
does — backing would enter a block a peer holds, or the head sits against a
buffer with no edge behind it, or every retreat still shares the contested
marker — there is no safe reverse and the deadlock stands. This is a pure graph
+ occupancy query over state the scheduler already holds; no clock, no RNG.

## Decision

### 1. A new signed clearance command: `grant_reverse`

Add one core command (additive minor bump, mirroring ADR-015's
`begin_exploration` move):

- `grant_reverse` — payload `{ limit_marker_id, edges, reason? }`.
  - `limit_marker_id` is the backward target **X**: the marker the train is
    authorised to reverse *to*. It becomes the train's new clearance limit,
    now BEHIND the head rather than ahead of it — this is the "signed" part.
  - `edges` is the ordered run of held, forward-oriented `EdgeRef`s the train
    backs along, head-first edge first. The train traverses each in reverse.
    Naming them (rather than just X) keeps the train from having to re-derive
    the retreat path and keeps the grant self-describing on the wire.
  - `reason?` optional, for observability (`'deadlock_reverse'`).

Released, like every other clearance, by the existing `revoke_clearance` /
`emergency_stop` — no new stop command. A `grant_reverse` is bounded (it names a
limit) and revocable, so it is a clearance in good standing, not a command in
disguise.

We deliberately do **not** add a new event type. The grant is observable on the
wire as the command itself, and the deadlock-resolution outcome is already
visible: the `railway/state/deadlock/active` snapshot clears once the cycle
breaks, and the reverser's retained clearance state updates to its new
(backward) limit. Keeping the surface to one command keeps the TCF registry
append small and the protocol honest.

### 2. The scheduler chooses the reverser by the existing total order

Resolution slots into the deadlock path *after* the forward yield, never
tangled into it. In `resolveDeadlockOrEmitState`, when a cycle is detected and
`tryYieldLowestRanked` returns `null` (the forward cure cannot reach this case),
the scheduler calls a new `tryReverseToBreakStandoff(cycle)` before falling
through to `emitDeadlockState`. The yield path and the detector are untouched.

`tryReverseToBreakStandoff` walks the cycle members in the **same total order**
ADR-017 defined (priority → registration-seq FIFO floor → `train_id`), lowest
first — the lowest-ranked train gives ground, exactly as it is the one withheld
in the forward case. For the candidate it computes the backward target X (§3);
the first candidate for which a safe X exists is the reverser. This is fully
deterministic: the order is a pure function of scheduler-held state, so the same
event stream picks the same reverser every run.

### 3. The safety check and "how far back", as one computation

For a candidate victim blocking a peer whose wanted edge is `peerWanted`,
`computeReverseTarget` walks backward from the victim's head:

1. Start at the head marker `H = last_marker_id`. The occupied head block is the
   held edge whose `to_marker_id === H`; the train backs along it toward its
   `from_marker_id`.
2. At each step, the next marker back is the `from_marker_id` of the current
   held edge. The edge being backed over must be one the victim **holds**
   (so no peer can be inside it — block exclusivity already guarantees that) —
   reversing only ever retreats over the train's *own* occupancy. Backing onto
   a marker any **other** train holds is forbidden; if the next marker back is
   shared with a peer's held edge, stop — that retreat is unsafe.
3. After each step, test condition (b): does the candidate target marker still
   share with `peerWanted`? The contested marker is the one `peerWanted`'s
   wanted edge touches; the victim must retreat until its head no longer sits on
   it. The first backward marker X that (a) was reached only over held/clear
   edges and (b) no longer shares with `peerWanted` is the target.
4. If the walk runs out of held edges behind the head (a buffer / terminus — no
   edge to back onto) before reaching a safe X, there is no safe reverse for
   this candidate → return `undefined`.

Returning `undefined` for every cycle member is the honest-deadlock case:
`tryReverseToBreakStandoff` returns `null` and the deadlock is reported
unchanged. The asymmetry mirrors ADR-016's tail-release: holding (not reversing)
is always safe; reversing into uncertainty is not, so the walk is conservative —
it never reverses over an edge it cannot prove the victim holds.

### 4. Enacting the grant — scheduler state and the train

When a safe X is found the scheduler:

- Releases the victim's occupied blocks *between* its old head and X (the run it
  is vacating) from `cleared_edges`, but **retains** the edges from X forward
  that it still sits on — its tail now trails back over them from the new head
  position at X. The freed markers (the contested block) are now unheld, so the
  peer's `retryBlockedClearances` pass grants it the section.
- Sets the victim's `clearance_limit_marker_id` to X and its `last_marker_id`
  to X (its head is now there).
- Emits the `grant_reverse` command to the victim and an updated clearance
  snapshot, then re-runs `retryBlockedClearances` with the victim in the skip
  set (so it does not immediately re-grab the block it just vacated, the same
  mechanism the forward yield uses), letting the peer proceed.

The **`VirtualTrain`** enacts `grant_reverse` deterministically: it enters a
bounded *reversing* state, sets a backward target, and on each `tick` drives the
head backward along the held edges (walking its existing `traversal_history`,
the same backward chain `getTrailingPosition` already uses) until the head
reaches X, then stops. Backward motion reuses the same `VirtualClock`-driven
kinematics as forward motion, negated — no `Date.now`, no `Math.random` in the
path. It emits `tag_observed` for each marker it backs onto so the scheduler
tracks the retreat. This is what makes the integration test real: application
code cannot tell the virtual reverse from a physical one.

### 5. Layer placement — core, not a capability

Like ADR-017's total order, reverse authority lives in **scheduler core**,
uniform across trains, not a capability and not device-class-specific. It is a
global property of deadlock resolution; pushing it into a pure hook would be the
wrong layer. Capabilities keep their existing role (deny a grant); they never
order trains and never reverse them. The hooks stay pure
`(state, event) → (newState, intents)`; the reverse computation is a graph +
occupancy query over scheduler state, no I/O, no clock.

## A note on totality — what the implementation revealed

Designing and testing the safety walk surfaced a stronger result than the ADR
first assumed, worth recording because it reshapes the honest claim:

> **Under block exclusivity, a train in a closed standoff can *always* reverse
> out of it.**

The argument is short. The victim retreats over the edges it HOLDS. Every marker
it backs onto is a *boundary of an edge it exclusively holds* — and block
exclusivity (ADR-011) guarantees no peer can touch a marker the victim's held
edge touches. So *every* backward step lands on a marker that is provably free;
the `markerHeldByAnotherTrain` guard can never fire during a genuine retreat. And
the contested marker (the peer's *wanted* edge) is, by definition, *wanted, not
held* — so it too is free, and the very first step that releases the occupied
head block frees it. The only candidates the reverse walk cannot help are those
with **no occupied block behind the head** — i.e. a train holding only
forward grant-ahead claims — and *those are exactly the candidates the forward
yield (ADR-017 §3) already resolves*, because everything they hold is releasable.

**A correction the implementation forced — length is part of the safety walk.**
The totality argument above reasons about the HEAD's retreat path. But a
length-aware train (ADR-012/016) is not a point: backing the head from its old
position to X shifts the whole body back by the same distance, so the TAIL sweeps
into the track *behind* X. That swept-behind region must be track the victim still
provably HOLDS, exactly as the head's path must be — otherwise the reverse vacates
the contested block while leaving the body physically occupying a section the
scheduler no longer tracks as held (a peer could then be granted into it). The
length-blind reverse target therefore had a latent occupancy gap for trains whose
body extended past their retained tail. `computeReverseTarget` now closes it with
a third condition mirroring ADR-016's conservative tail-release: after finding X
it walks the retained held edges backward by `train_length_mm` over their
`estimated_length_mm`, and only grants the reverse if that swept-behind region is
fully covered by held, known-length track (`reverseBodyCoveredByHeldTail`). If the
body would extend past tracked occupancy — into edges the victim does not hold, or
whose length is unknown — the candidate is REFUSED (the same hold-don't-guess
asymmetry: an over-long hold is safe, an under-tracked reverse is not). A point
train (`length_mm` 0/undefined) is trivially covered, so the prior behaviour is
unchanged. The totality result holds *within the length-coverable region*: every
two-train standoff whose reverser has a body-covering retreat reverses; the only
2-train case left to *report* is one where every candidate's body would sweep past
its tracked tail (e.g. a train longer than its whole held approach), which is the
conservative-refuse path, not an unsafe grant.

So the two resolvers **partition** the cases: the forward yield handles every
train whose blocking edge is a not-yet-entered claim; reverse authority handles
every train whose blocking edge is its occupied head block. Together they resolve
**every exclusivity-respecting waits-for cycle between trains.** The
`tryReverseToBreakStandoff` null-return and its two internal safety breaks are
therefore *defensive* — they cannot be reached by a cycle the scheduler's own
grant logic (exclusivity + ordered grants, which also prevents any fully-packed
configuration from forming) can produce. They are retained because the safety of
the primitive must not depend on that invariant holding for inputs from outside
the normal grant path (a future operator-forced reverse, a desynced peer); they
are marked as defensive in the code and excluded from coverage with that
rationale, per the repo's documented practice.

The detector and its banner are unchanged and stay honest: they still report a
cycle the instant one is detected, in the same pass before resolution runs, and
clear it once broken. What changes is that the closed nose-to-nose standoff —
the case ADR-017 could only *report* — is now *resolved*.

## Consequences

- **Closed standoffs become curable — and, between two trains, always are.** The
  class of deadlock ADR-017 could only *report* is now *resolved*: the
  lowest-ranked cycle member whose blocking edge is its occupied head block backs
  out over its own held track (provably free by exclusivity), freeing the
  contested block for the peer. See the totality note above.
- **The system never forces an unsafe reverse.** The safety walk only ever
  retreats over track the victim provably holds; if (defensively) no safe target
  exists for any candidate, `tryReverseToBreakStandoff` returns `null` and the
  deadlock is reported unchanged rather than a train shoved into uncertain track.
  Report, don't force.
- **"Clearance, not commands" holds.** Reverse authority is a bounded, revocable
  grant of signed track, not a streamed motor command. Default-stopped is
  preserved: absent the grant a train never reverses.
- **One new wire command; small registry append.** `grant_reverse` is appended
  to `COMMAND_TYPE_ORDER` (epoch bumped) and `CORE_COMMAND_SCHEMAS`; the
  correspondence test stays green. No new event type.
- **Determinism strengthened, not bent.** The reverser is chosen by the same
  pure total order; the safety walk is a pure query. Same seed, same resolution.

## What stays deferred

- **Operator-initiated reverse.** The scheduler now reverses a train
  autonomously to break a deadlock. A *manual* "back this train out" operator
  gesture (a UI button, an admin API call) is a thin wrapper over the same
  `grant_reverse` + `computeReverseTarget` machinery, but the operator-recovery
  UI is out of scope here — as it was for ADR-017's yield.
- **Multi-train cascading retreat.** This resolver reverses ONE train per pass
  (the lowest-ranked with a safe retreat). The totality argument above is stated
  for the two-train cycle; a ≥3-train cycle that needs several trains to back up
  in sequence is resolved across successive passes (each pass breaks one edge of
  the cycle and re-runs detection on the next event), but a *single-pass*
  cascading resolver that backs several trains at once is a follow-up. The
  common single-reverse case is what landed and is exercised end to end.
- **Reverse over learned/inferred edges with unknown length.** The safety walk
  retreats over edges the victim holds; computing how far the *tail* extends
  past X reuses ADR-016's conservative tail logic (`reverseBodyCoveredByHeldTail`,
  added when the length gap was closed). An edge of unknown `estimated_length_mm`
  in the swept-behind region stops the coverage walk → the body cannot be proven
  tracked → the candidate is held (not reversed), the same asymmetry as ADR-016.
- **Anti-starvation interaction.** Repeatedly choosing the lowest-ranked train
  to give ground could, under static priority, always pick the same victim. This
  is the same starvation trade-off ADR-017 accepted and deferred; unchanged here.
