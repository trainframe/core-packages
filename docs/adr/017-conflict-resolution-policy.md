# ADR-017: Conflict-resolution policy for edge/section contention

## Status

Proposed.

Builds on [ADR-002](002-clearance-model.md) (clearance, not commands),
[ADR-011](011-section-as-edge-plus-boundary-markers.md) (a section is an edge
plus its two boundary markers), and the deadlock *detector* shipped after
ADR-011 (`detectWaitsForCycle` / the `railway/state/deadlock/active` snapshot).
Resolves the open design question CLAUDE.md records as *"Conflict resolution
policy for clearance contention between trains."*

## Context

ADR-011 made block exclusivity innate: `edgeConflictsWithAnotherTrain` denies a
train any edge whose boundary markers a peer already holds. That is the right
*safety* rule — two trains can never co-occupy a shared section. But it only ever
says **"not you, not now."** It never says **who.** Two questions the clearance
model leaves open both live in that gap, and they are not the same question:

**(A) Contention — who goes first.** Two trains both want a section that is
currently free; only one can have it. Today the answer is an accident of
`Map` iteration order: `retryBlockedClearances` walks `this.trains` in insertion
order, and whichever train's horizon walk reaches the contested edge *first in
that pass* grabs it; the other's `tryGrantClearance` then sees the conflict and
withholds. This is deterministic *only* incidentally — it tracks spawn order,
nothing the operator chose, and nothing the model names. There is no way to say
"the express takes the junction before the freight."

**(B) Deadlock — the cycle has already formed.** Two trains approach each other
on a single-track section between passing loops. Each holds the block behind it
and wants the block the other holds. The detector finds the waits-for cycle and
publishes it; the banner lights up. Nothing then *resolves* it. The standing
guidance (ADR-011, status.md) is "that's an authoring decision — add a passing
siding." True, but it leaves the running system wedged with no programmatic way
out.

These are separate problems with separate ceilings, and conflating them produces
a wrong ADR. The load-bearing constraint is this:

> **Withholding clearance cannot vacate a block a train already occupies.**

Our entire model is "default stopped; a grant authorises *entry*." Denying a
train that is *already stopped inside* the contested section does nothing — it is
not asking to move. Recovering from a physically-closed deadlock requires the
train to *back out*, which is a **reverse authority**, not a withhold. So the
clearance model can *prevent* deadlocks (by ordering contention before the cycle
closes) far more than it can *cure* them (which needs a primitive we don't have).
The honest scope is: solve (A) well, show that solving (A) shrinks (B)'s
incidence, and bound exactly how much of (B) the clearance model can reach
without a reverse primitive.

## Decision

### 1. An explicit, deterministic total order over trains

Replace the incidental `Map`-iteration tiebreak with an explicit **train
priority order**, applied uniformly in the scheduler's grant path. The order is a
pure, total comparison over trains:

1. **Announced priority**, higher first (optional; default equal — see §4).
2. **Registration sequence number**, lower first — a monotonic counter the
   scheduler assigns when a train first registers. This is the FIFO floor:
   absent any priority, the train that has been waiting in the system longest for
   contested track wins. It is *arrival order*, not request order, and it is
   deterministic by construction.
3. **`train_id`**, lexicographic — final stable tiebreak so the order is total
   even for two trains registered in the same event batch.

No wall clock. No `Math.random`. No VirtualClock tiebreak (it is *allowed* per
the determinism contract, but unnecessary here and weaker — a sequence counter
is reproducible without reading any clock at all). The order is a deterministic
function of state the scheduler already holds, so the same seed and the same
event stream produce the same grants, every run. We are not adding
non-determinism; we are **making the accidental order intentional.**

### 2. Contention resolved by granting in priority order

`retryBlockedClearances` already re-runs every blocked train's horizon walk after
any unblocking event. The single change: **iterate trains in the total order of
§1, not `Map` order.** When several trains contend for one free section in the
same pass, the highest-ranked reaches `tryGrantClearance` first, takes it, and
ADR-011's existing conflict check denies the rest — unchanged. The grant
*mechanism* is untouched; only the *order of consideration* becomes a named
policy instead of an emergent one.

This is the whole of (A). It is enough because most contention is resolved
*before* anyone enters the contested block: the loser simply waits one block
back, exactly as ADR-011 already arranges, but now it is defined *which* train
loses. Ordering contention deterministically also **prevents** a large class of
(B): two trains converging on single track no longer both creep into the
approach blocks in an order nobody chose; the lower-ranked one is held at the
last passing-loop boundary it can still wait at, before the cycle can close.

### 3. Deadlock resolution: yield the lowest-ranked, only while it can still yield

Reuse the existing detector verbatim — `detectWaitsForCycle`,
`buildWaitsForGraph`. When a cycle is detected, the **same total order** selects
the victim: the lowest-ranked train in the cycle. Resolution is then expressed
purely within the clearance model:

- The victim's *wanted* edge claim is withheld and it is added to the
  `retryBlockedClearances` skip set (the same mechanism `revokeClearance`
  already uses to stop a train re-grabbing a block it was just told to release),
  so the **higher-ranked trains in the cycle proceed** and the cycle breaks.
- This unwinds the deadlock **iff the victim has not yet physically entered the
  contested block** — i.e. it is still waiting at a boundary it holds, with a
  block behind it the winner does not need. In the common passing-loop case
  (the loser held at the loop, the winner needing the single-track section the
  loser merely *wants*) this is exactly the situation, and yielding clears it.

What it explicitly does **not** do: if the victim is already stopped *inside* the
single-track section (a true nose-to-nose standoff, both trains physically in
blocks the other needs), withholding changes nothing — see the load-bearing
constraint. The scheduler keeps publishing the deadlock state; resolution then
needs a **reverse authority** (a grant to back out) we have not yet defined.
That primitive, and operator-initiated recovery built on it, is deferred (§5).
The detector's contract is unchanged: detection still reports honestly even when
resolution cannot reach the case.

### 4. Priority as an optional, flagged enrichment — order-only first

Mirror ADR-016's optional-`consist`-descriptor move exactly. Ship the **tiebreak
floor first**: registration-sequence + `train_id`, zero protocol surface, fully
deterministic, no new wire field. The announced-priority term (§1.1) is an
*optional* scalar that MAY later ride `device_registered` as a **flagged minor
protocol bump** if and when an operator wants "express beats freight." Until
then every train is equal-priority and the FIFO floor decides everything.

This keeps the baseline protocol-free and the decision explicit: priority is a
flagged addition, never a silent one, and the system is correct and deterministic
without it.

### 5. Layer placement — core, uniform, not a capability

The order lives in **scheduler core**, applied uniformly in the
`tryGrantClearance` / `retryBlockedClearances` path. It is **not** a capability
and **not** device-class-specific. Capabilities keep their existing role:
`gates_clearance` and any `onClearanceConsultation` hook *deny* a grant (a
gate, a dwell, a crane); they never *order* trains. Ordering is a global
property of contention, not a property any one device owns — pushing it into a
pure hook would be the wrong layer and a device-specific hack of the kind
CLAUDE.md forbids. The hooks stay pure `(state, event) → (newState, intents)`;
the total order is computed from scheduler-held train state, no I/O, no clock.

## Consequences

- **The tiebreak becomes a contract, not an accident.** Two trains contending
  for one junction now resolve in a defined, reproducible order an operator can
  reason about and, optionally, control. Same seed, same outcome — the
  determinism contract is strengthened, not bent.
- **FIFO floor leans fair; priority leans expressive — and can starve.** The
  named trade-off: pure arrival-order (the floor) is fair but cannot express
  "express first"; a static announced priority *can*, at the accepted cost that
  a persistently-contended low-priority train may be **starved** indefinitely.
  We accept starvation as the cost of expressiveness and default to the fair
  floor; anti-starvation (priority aging, fairness windows) is a follow-up, not
  shipped here.
- **Prevention buys more than cure.** Deterministic contention ordering stops a
  large class of deadlocks from ever forming, which is where the clearance model
  has real leverage. The residual — physically-closed nose-to-nose standoffs —
  is bounded by a constraint of the model itself, not a gap we forgot.
- **Detection stays honest where resolution can't reach.** The detector and its
  banner are unchanged and keep reporting cycles the yield cannot unwind, so the
  operator is never shown a false "resolved."
- **No new wire surface in the baseline.** §1–§3 are pure scheduler-internal
  changes over state already held. The only protocol touch is the *optional,
  flagged* priority field, deferred until wanted.

## What stays deferred

- **Reverse authority (the cure for closed standoffs).** A grant that authorises
  a train to *back out* of an occupied block is the missing primitive for
  recovering physically-closed deadlocks. It is a new clearance shape and
  deserves its own ADR; until it exists, closed standoffs remain an authoring
  fix (passing siding, more markers) plus operator revoke, exactly as today.
- **Operator-initiated recovery UI.** Per-train revoke already exists; a
  "yield this train / back it out" operator action belongs with the reverse
  primitive above.
- **Anti-starvation under static priority** (aging, fairness windows) — only
  relevant once announced priority ships, and only if real layouts show
  starvation in practice.
- **Multi-gate contention semantics** (several `gates_clearance` devices on one
  marker) remains its own open question; this ADR orders *trains*, not gates.

## Suggested sequencing for the implementing session

1. Core: add the monotonic registration sequence number to `TrainState` and an
   `orderedTrains()` comparator (priority → sequence → id).
2. Core: iterate `orderedTrains()` in `retryBlockedClearances` instead of
   `Map` order. Add an integration test (two trains, one junction, fixed seed)
   asserting the higher-ranked train takes it every run.
3. Core: on a detected cycle, withhold the lowest-ranked victim's claim via the
   existing skip-set path; test the passing-loop case unwinds and the
   closed-standoff case does *not* (and still reports deadlock).
4. (If wanted) optional announced `priority` on `device_registered` — a flagged
   minor protocol bump — plumbed into the comparator's first term.
5. (Separate ADR) reverse authority and operator yield for closed standoffs.
