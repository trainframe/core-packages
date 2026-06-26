# ADR-036: Train introduction and activation lifecycle

## Status

Proposed — design agreed, ready to spec. Introduces a registered-but-not-yet-on-track
train state, an operator-driven *introduction* at a chosen safe location, vector
resolution by either a two-marker forward roll or a heading-providing zone, and
the safety handling for the moment a newly-resolved vector lands a train in a
block another train already holds.

Builds on [ADR-002](002-clearance-model.md) (clearance, not commands; default
stopped/safe), [ADR-011](011-section-as-edge-plus-boundary-markers.md) (block
exclusivity), [ADR-015](015-exploration-clearance.md) (open-ended forward
motion for discovery), [ADR-017](017-conflict-resolution-policy.md) (contention
order), and the capability model in `core/src/capability.ts`.

## Context

The route planner needs a train's **layout-relative heading** to route it
directionally (ADR-010/ADR-022: a train has a heading and never flips 180° to
take a shortcut). A train that has just been placed on the track has no known
heading, and today the scheduler *guesses* a direction when it plans the first
leg. When the guess contradicts the train's physical facing — which it can't
reverse out of — the train drives off-route and stalls at the first junction.
This is the live "two placed trains got completely stuck" report (it is **not**
a clearance deadlock — the detector stays empty; see `docs/status.md`).

Three facts close off the obvious fixes:

1. **One marker is not a heading.** A single `tag_observed` says only "a train
   is here now." A heading is an *edge* — two consecutive crossings, A then B,
   give A→B. And the core cannot assume it knew A beforehand: a freshly placed
   train is a blank slate, no position and no heading, until it has crossed two
   markers in motion.

2. **Discovering the heading by motion cannot be automatic.** Establishing the
   vector requires real forward travel across (at least) one full edge before
   anything about the train's direction is known. On a layout with other trains
   that is precisely the open-ended, can-not-pre-clear motion ADR-015 flags as a
   *runaway* primitive, safe only for single-train discovery. The scheduler must
   not initiate it behind the operator's back.

3. **Heading-at-registration is not child-friendly.** Requiring whoever places a
   loco to declare its orientation as a registration field pushes a fiddly,
   error-prone step onto a child snapping track together. Registration means
   "this train exists," nothing about where it is or which way it points.

The resolution is to make introduction an explicit, operator-controlled act
performed from a location the operator has judged safe — and to let a suitably
capable zone hand the heading over directly so the common path needs no blind
motion at all.

## Decision

### 1. A train has a lifecycle: *registered* → *introduced/active*

A registered train is *known* but not *on the track*. The scheduler treats a
train with no resolved vector as off-the-map: it is never granted clearance and
never routed. The garage lists registered-but-not-introduced trains so the
operator can see what is waiting to be brought on.

### 2. Introduction is an operator gesture at a chosen safe location

The operator introduces a specific train when and where they choose. Nothing
moves until they do — this stays within "default stopped/safe." Introduction
begins vector resolution (§3); it does not, by itself, assign a destination.

### 3. The vector resolves one of two ways

**(a) Two-marker forward roll (the general mechanism).** The train rolls
*forward* — the only direction it can — at a gentle introduction speed, until it
has crossed two markers. Those two crossings give the core the train's position
and heading. The core **ends the roll itself** the instant the heading is
established (it is not the free-running ADR-015 grant; the core owns the
release). The train then comes to rest as an active, vector-known train.

**(b) Heading-providing zone (`core.provides_train_heading`).** A new optional
capability. A zone or device that declares it **emits** a train's heading — as a
`train_introduced` event — *before* it releases the train to leave, so the
vector is known to the core the moment the train reaches open track, never after.
Introduction from such a zone therefore resolves the vector with no roll and no
window of blind motion on the layout. A railyard is the intended first claimant;
the turntable — which already owns a train's orientation as a turnout — is a
natural second. This is pure capability-based extension: the scheduler takes the
zone's emitted vector when present and falls back to the roll (a) otherwise.

### 4. Vector-unknown trains are unroutable; schedules may still be queued

A schedule **can** be assigned to a not-yet-introduced train; it is held
pending. The scheduler refuses to plan it while the vector is unknown, and
starts executing it the instant the vector resolves. So the operator may set up
a train's whole job in advance and have it run the moment it is introduced.

### 5. Safety: resolution into an occupied block

Block exclusivity (ADR-011) cannot protect a train whose position is unknown —
there is nothing to exclude. So at the **moment the vector resolves**, the core
re-checks the train against active peers and, wherever possible, resolves the
contention rather than freezing everything:

- **Resolvable (the common case): stop only the train that is behind.** If the
  newly-resolved train and an active train want the same block but one is simply
  *following* the other, this is ordinary contention (ADR-011/ADR-017): the
  trailing train holds until the block clears, the leading train is unaffected,
  and the held train's pending schedule starts once it is clear. Both trains do
  not stop — only the one behind yields.
- **Unresolvable: escalate to the operator.** If the conflict is a genuine
  deadlock (head-on in a shared block, or a mutual block neither can yield out
  of) or an outright safety overlap (the train resolved *into* a block a peer
  occupies), the core stops the introduced train, raises a
  `train_introduction_conflict` anomaly naming the contested block and the two
  trains, and instructs the operator to move a train. No auto-proceed and no
  pending-schedule start until the operator clears it.

This is the dangerous moment the design exists to make safe, and both branches
are first-class tested scenarios, not afterthoughts.

### 6. Operator guidance

The recommended practice is to introduce every train from a purpose-built safe
point — a railyard or other zone that either holds several close markers (so the
two-marker roll resolves within a few centimetres) or declares
`provides_train_heading` (so it resolves instantly). Dropping a loco onto open
main line and introducing it there is supported but discouraged.

### Protocol (bump 0.14.0 → 0.15.0; TCF epoch 6 → 7)

- New command `introduce_train` — payload `{ reason?: string }` — addressed to
  the **train**; the operator gesture that begins vector resolution. Authorises
  the bounded introduction roll (§3a). When the train sits in a
  `provides_train_heading` zone, that zone resolves the vector instead (§3b).
- New event `train_introduced` — payload `{ train_id, marker_id, heading_edge }`
  — the resolved position and heading edge. Emitted by the core when the
  two-marker roll completes, or **by a `provides_train_heading` zone before it
  releases the train to leave** (so the vector is always known before the train
  reaches open track).
- New event `train_introduction_conflict` (or an `anomaly` of that kind) — §5.
- New capability `core.provides_train_heading` — a zone/device that supplies a
  train's heading on emergence (§3b).
- A train lifecycle flag `introduced` on the retained device state
  (`DeviceRetainedState`, alongside the existing train-specific `train_length_mm`)
  — `true` once a train's vector has resolved, absent/false while it is
  registered but not yet introduced, so the garage can list trains awaiting
  introduction.

New event types append to the TCF registry, so this bumps the protocol minor and
the registry epoch together (per `version.ts`).

## Consequences

- The "placed train stalls / two trains stuck" class is closed at the root: a
  train is never routed on a guessed heading.
- Introduction is a deliberate, visible operator act with a safe-by-default
  resting state — consistent with the whole clearance model.
- The common path (introduce from a heading-providing yard) needs no blind
  motion; the fallback roll is bounded and operator-initiated, never automatic.
- One new wire command, two new events, one new capability, one protocol +
  epoch bump. The spec and `version.ts` record them before any code.
- The simulator gains an introduction speed and a yard/zone that claims
  `provides_train_heading`; the toy-table fills the operator-chosen safe
  location naturally (placement already captures pose, but the *core* still
  learns the vector through the protocol — the sim never short-circuits it
  out-of-band, per ADR-030).

## Scenarios (the test surface)

1. **Clean introduction by roll** — train introduced on plain track, rolls
   forward, crosses two markers, comes to rest active with the correct heading;
   a subsequently-assigned schedule runs.
2. **Pending schedule auto-start** — schedule assigned *before* introduction;
   the train runs it the instant its vector resolves.
3. **Zone-provided heading** — train introduced from a `provides_train_heading`
   zone resolves its vector with no roll.
4. **Resolution behind an active train (resolvable)** — the introduced train
   resolves *following* an active train into a shared block: only the trailing
   (introduced) train holds, the leading train runs on, and the held train's
   pending schedule starts once the block clears.
5. **Resolution into a deadlock/overlap (escalated)** — the introduced train's
   vector lands head-on or directly inside a block a peer occupies: it stops, a
   `train_introduction_conflict` is raised, the operator is told to move a train,
   and no pending schedule starts until they do.
6. **Introduction with a second train approaching** — an active train nears the
   introduction point during the roll; block exclusivity holds the instant the
   vector resolves.

## Resolved during review

- **Heading hand-over** is an event the zone **emits before releasing** the
  train to leave — the vector is known before any motion onto the layout.
- **`introduce_train` is addressed to the train**; a capable zone resolves the
  vector on its behalf.
- **Conflict recovery** prefers resolution over freezing: stop only the train
  behind; escalate to "operator, move a train" only on a real deadlock or safety
  overlap (§5).
