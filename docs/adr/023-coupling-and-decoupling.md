# ADR-023: Coupling and decoupling — trains as dynamic compositions

## Status

Proposed. Design-only; no code, no protocol bump yet. When Phase 1 lands it is
an additive minor bump (0.7.0 → 0.8.0): one new event and one new capability.

Resolves the last open design question recorded in CLAUDE.md and
`docs/status.md`: *"Coupling/decoupling of trains as multi-vehicle
compositions."*

Builds on, and is constrained by:

- [ADR-016](016-train-consists-and-length-visualisation.md) — a train *is* a
  consist whose **total length is the only wire quantity**; carriages are
  wire-invisible; the discrete `consist` descriptor was **deferred**. This ADR
  reaffirms that deferral (see the hard constraint below).
- [ADR-012](012-train-length-and-tail-clearance.md) — `train_length_mm` drives
  tail-clearance release.
- [ADR-011](011-section-as-edge-plus-boundary-markers.md) — a section is an edge
  plus its boundary markers; **block exclusivity** is the core safety invariant.
- [ADR-002](002-clearance-model.md) — clearance, not commands; default-safe.
- [ADR-022](022-reverse-authority.md) — bounded, signed reverse grants; the
  length-aware reverse body-coverage check.
- [ADR-007](007-tag-resolution-registry.md) — the `core.assigns_tags`
  producer-authority model the scheduler enforces; this ADR mirrors it.
- [ADR-009](009-discovery-mode.md) / [ADR-014](014-track-learn-mode.md) /
  [ADR-015](015-exploration-clearance.md) — how a train's identity and position
  are established and anchored.

## Context

ADR-016 closed the loop on *static* consists: a train has a physical length,
that length is the only thing the scheduler needs, and the carriages that make
it up are a simulator (`VirtualTrain`) and visualiser detail — never devices,
never wire entities. It explicitly left dynamic coupling out of scope: *"This
ADR assumes a fixed consist per train."*

This ADR takes up the deferred case. An operator wants to back a locomotive onto
a rake of carriages and pull away as a longer train; later split it; eventually
let a *robotic decoupler station* do the work as a third-party satellite device.
That is the headline feature — and the "fun test" of the extensibility story:
can a device nobody on the core team built change a train's most
safety-relevant physical fact, through the same public seams a built-in uses?

Three things make this hard, and the design must answer each:

1. **Length is fixed at registration today.** `train_length_mm` enters the
   scheduler exactly once, on `device_registered` (`scheduler.ts` ~line 226,
   into `TrainState.length_mm` via `initTrainState`). It is immutable at
   runtime. Coupling changes a train's length *while it runs*, and ADR-012/016
   make length load-bearing for occupancy: tail-release, the ADR-022 reverse
   body-coverage walk, and the clearance horizon all key off it. A runtime
   length change must therefore re-derive occupancy, not just store a number.

2. **The change must not have to come from the train.** A robotic decoupler
   knows the new lengths; the locomotive may not. So the producer of a
   length-change fact must be *something other than the train itself* — yet the
   scheduler must not let any device rewrite any train's length unchallenged.
   ADR-007 already solved exactly this shape for tag binding:
   `tag_assignment` is honoured *only* from a device that declared
   `core.assigns_tags` (`scheduler.ts` ~line 369). That is the template.

3. **To couple, one train must enter a block another occupies.** Physical
   coupling *is* two trains making contact in the same section — a head-on
   breach of ADR-011 block exclusivity, the invariant the whole safety model
   rests on. There is no way to couple without, for one controlled moment,
   suspending the rule that exists precisely to keep trains apart.

### Hard constraint: core does not know about carriages

Trainframe core and protocol do **not** model carriages. Carriages are not
devices and not first-class wire or core entities — they are a `VirtualTrain`
consist detail in the simulator and a render detail in the visualiser, exactly
as ADR-016 established. The only mutable wire fact about a train's make-up is its
**scalar length** (`train_length_mm`).

This ADR therefore does **not** build ADR-016's deferred discrete `consist`
descriptor, and the new event does **not** carry an ordered vehicle list. A
decoupler asserts the resulting *length(s)*. How carriages compose into those
lengths is the simulator's business and out of core scope. We say this plainly
so a future reader does not mistake "coupling" for a reason to teach the core
about vehicles.

## Decision

### 1. Runtime length is a capability-gated, retained fact

Generalise registration-time `train_length_mm` into a **runtime, retained**
fact that a suitably-authorised device may update at any time.

**New event: `consist_changed`**, carrying a single scalar `train_length_mm`
(the new total) and the affected `train_id`. It carries no vehicle list, no
ordered carriages — only the scalar, reaffirming ADR-016's deferral. We keep the
name `consist_changed` rather than `train_length_changed` because the *cause*
the operator and visualiser care about is a composition change (carriages added
or dropped); the *wire fact* is deliberately just the resulting length. The
event payload's documentation must state this explicitly so no one is tempted to
grow it into a vehicle manifest. (If, in review, the "length-only" honesty is
judged more important than naming the cause, `train_length_changed` is the
literal alternative; we prefer `consist_changed` and flag the choice.)

**New capability: `core.reports_consist_change`.** A device's `consist_changed`
event is honoured *only* if that device declared `core.reports_consist_change`
at registration; otherwise the scheduler rejects it with a `warning` anomaly and
makes no state change. This is the exact enforcement shape ADR-007 uses for
`core.assigns_tags` (`scheduler.ts` ~line 369): a marker capability the
scheduler checks directly, no capability voting. We choose this name over
`core.couples_consists` deliberately: that name is *action-narrow* (decoupling
needs the same authority) and *class-narrow* (it implies a coupler device). The
right parallel to `core.assigns_tags` is "authority to **assert** the length
fact" — held by a self-reporting train **or** a robotic decoupler station, and
covering both couple and decouple. The scheduler does not care about device
class. The train itself MAY hold the capability (self-report); a decoupler holds
the *same* one. This is the direct answer to "the length change should not have
to come from the train."

**What the scheduler does on receipt.** Update `TrainState.length_mm` to the new
scalar, then **re-derive occupancy** against the existing state — the same
machinery, now fed a new length:

- Re-run the ADR-012/016 tail-release walk: a now-*shorter* train may release
  edges its old length still held; a now-*longer* train holds more, and the
  conservative hold-don't-guess asymmetry (ADR-016) applies — an over-long hold
  is safe, so released-too-early can never result from a length *increase*.
- The ADR-022 reverse body-coverage check (`reverseBodyCoveredByHeldTail`)
  reads the new length on its next invocation; no special handling needed.
- The clearance horizon keys off the new length on the next `train_status` /
  `marker_traversed`.
- Publish the new length on the retained `railway/state/devices/{id}` payload
  (the `DeviceRetainedState` ADR-016 already added), so fresh subscribers and
  the visualiser see the current length without replaying history — mirroring
  how `tag_assignment` publishes retained `railway/state/tags/*`.

This is Phase 1 in its entirety, and it is foundational and low-risk: it is the
ADR-012 registration path made mutable and gated, with occupancy re-derivation
that reuses code already in the scheduler.

### 2. Identity lifecycle — slave and resume, never mint from nothing

The deepest part, and the one most constrained by "carriages are invisible."

The crucial observation: **a schedulable identity exists only because a
`core.controls_motion` device registered** (`initTrainState`). The scheduler has
no way to mint a train from nothing, and — per the hard constraint — must not,
because the only thing that could be born ex nihilo is a rake of carriages,
which are not entities. So decouple and couple are framed not as
*create/destroy* but as *resume/slave* of pre-existing motion-device
identities. This reconciles the user's "a new train is born mid-layout" framing
with the constraint: nothing is born; an already-registered but currently-merged
identity *resumes*.

**Decouple splits into two cases, and the ADR must distinguish them:**

- **Dropping passive carriages off a single locomotive.** The carriages were
  never wire-visible (no motion device, no tag, no identity). So **no new train
  appears.** This is purely a `consist_changed` that *shrinks* the surviving
  locomotive's `train_length_mm`. Phase 1 handles it completely; there is no
  identity work at all. This is the common case and it costs nothing beyond
  Phase 1.

- **Splitting a consist with motive power in both halves.** Both halves are
  *pre-existing* `core.controls_motion` identities that were merged by an earlier
  couple (see below). Nothing is created. The mediating device (the
  `core.reports_consist_change` holder) asserts the split by naming: (a) the
  **cut marker** — the position at which the rear identity now sits; (b) which
  motion-device identity *resumes* independent scheduling; and (c) the resulting
  scalar length of each half (two `consist_changed` assertions, or one combined
  decouple assertion carrying both — to be settled at protocol-design time;
  the information content is fixed here). The scheduler then re-establishes the
  resumed train's anchor exactly as a normal train is anchored: its
  `last_marker_id` becomes the cut marker, its `cleared_edges` becomes the
  *suffix* of the combined train's held edges that lies behind the cut (inherited
  occupancy span — see §2's transfer rule for the symmetric couple side), its
  `length_mm` becomes its asserted scalar, and occupancy is re-derived. The
  survivor keeps the prefix and its own reduced length. No exclusivity is
  breached: the split happens entirely within a span the combined train
  *already held*, so both resulting spans are subsets of held track. **Decouple
  needs no clearance exception** (contrast §3).

**Couple is the symmetric inverse: 2 → 1 by slaving, not destroying.**

When two motion-device identities couple into one combined train, the scheduler
**slaves** one identity under the other: the survivor remains schedulable; the
slaved identity is suspended (not retired, not freed) and can resume on a later
decouple. Two concrete calls, both flagged for review:

- **Who survives is *named by the mediating device*, not inferred.** Only the
  physical device knows the front/rear geometry of the joined train — which head
  leads the combined onward route. The logical graph cannot tell the scheduler
  this. So the couple assertion names the survivor. We considered the
  alternative of picking the survivor by the existing total order (priority →
  registration-seq → `train_id`, as ADR-017/022 use) — it is clean and fully
  deterministic — but it is **blind to physical orientation**: it could elect
  the trailing head as the leader, and the combined train would then be
  scheduled to drive its rear forward. Device-named survivor wins; the order is
  a tiebreak only if the device declines to name one.

- **Occupancy must *transfer*, not free.** This is the load-bearing safety
  detail. `handleDeviceDisconnect` *frees* a vanished train's `cleared_edges`
  (`scheduler.ts` ~line 296) — correct for a train that is gone. But a slaved
  train is **physically still there**, now part of the survivor's body. Freeing
  its held edges would momentarily break ADR-011 exclusivity and admit a peer
  into track the combined train occupies. So couple must **move** the slaved
  identity's `cleared_edges` into the survivor's held set (a contiguous span:
  the two were in contact in one shared section) and **sum** the two lengths into
  the survivor's `length_mm`, then re-derive. The slaved identity's state is
  retained, suspended, keyed so a later decouple can resume it; its clearance
  snapshot is *not* emptied (that is the disconnect path's job, and this is not a
  disconnect).

**While slaved, the scheduler folds the slaved device's position events into the
survivor.** A coupled-but-slaved locomotive is still a physical
`core.controls_motion` device on the bus: its RFID reader sits somewhere in the
combined body and *will* cross markers as the train is dragged along, emitting
`tag_observed` (the sim's `VirtualTrain` ticks identically). Left untouched,
`handleTagObserved` → `handleTrainAtMarker` would advance the slaved identity's
route and clearance as if it were running independently — diverging the very
state we said is suspended. So while an identity is slaved it has **no
independent route or clearance limit**, and the scheduler treats its
`tag_observed` either as a position observation of the *survivor's* body (a
trailing-reader cross, no independent route advance) or suppresses it; it never
re-anchors or re-clears the slaved identity until resume. (Which of the two — a
genuine second-reader occupancy signal for the combined body, or plain
suppression — is an implementation choice for Phase 2; the requirement fixed here
is that the slaved identity is never independently scheduled while suspended.)

The scheduler gains a small identity-lifecycle facility for this:
suspend-with-state-retained and resume-at-anchor. It is asserted only by a
`core.reports_consist_change` device and only via the couple/decouple
assertions; there is no free-floating "create train" command.

### 3. The controlled block-exclusivity exception — coupling clearance

The riskiest decision. To physically couple, the approaching train must enter
the section the target train occupies and make gentle contact. That is a
deliberate, **mediated** breach of ADR-011 block exclusivity.

**It breaches ADR-011, not ADR-002.** This is still a *clearance*, not a command:
bounded, revocable, default-safe. We are not streaming a motor command; we are
granting a narrowly-scoped authority. The thing we suspend is exclusivity, not
the clearance model.

**Why suspending exclusivity is acceptable here, as a controlled exception.**
Exclusivity exists to prevent collision. Coupling's *intended outcome is gentle
contact* — the one operation where two trains sharing a section is the goal, not
a failure. Suspending the rule for exactly that case, under mediation and at
crawl speed, is safe in a way a general relaxation never could be.

**Shape it like `grant_reverse` (ADR-022): a new, tightly-scoped command.**
A coupling clearance:

- names **exactly the two `train_id`s** and **the one shared section** they may
  occupy together — nothing wider;
- carries a **speed cap** (crawl), so contact is gentle;
- is **emitted only on the mediating `core.reports_consist_change` device's
  request** — the scheduler does not generate it autonomously the way it
  generates a reverse to break a deadlock;
- is **revocable** by the existing `revoke_clearance` / `emergency_stop` — no new
  stop command, exactly as ADR-015 and ADR-022;
- is **default-safe**: absent the grant, exclusivity is universal again.

**Why it cannot leak into normal operation.** The exception is not a mode or a
flag on the scheduler; it is a single grant, scoped to two named trains and one
named section, that must be *requested* by an authorised mediator and is
revoked the instant coupling completes (or fails). The ordinary
`edgeConflictsWithAnotherTrain` check (ADR-011) is untouched for every train and
every section not named in a live coupling clearance. There is no path by which a
train without an active, mediator-issued coupling clearance for *this specific
peer and section* gets to share a block. The blast radius is two trains and one
edge, for the duration of one mediated maneuver.

**Decouple needs no such exception.** Splitting happens within a span the train
already holds (§2); no train enters a block it does not already occupy. The
coupling clearance is a *couple-only* primitive.

### 4. Maneuvering composes from existing primitives — no new motion

Positioning to couple — backing a locomotive onto a standing rake, navigating a
station throat — is **not** a new motion primitive. It is ADR-022 reverse
authority plus ordinary ADR-004 routes. We state this explicitly so the
implementing session does not invent a "shunt" command.

The orchestration of a couple is therefore:

1. Route the approaching train to a **staging marker** just outside the target's
   section (ordinary `assign_route` + bounded `grant_clearance`).
2. The mediator requests a **coupling clearance** (§3) for the two trains and the
   shared section.
3. The approaching train **reverse-closes** the gap under that clearance, at
   crawl speed, using ADR-022's `grant_reverse` machinery to back the signed run
   into contact (a manual/mediated reverse, the operator-initiated case ADR-022
   left as a thin wrapper over `computeReverseTarget`).
4. On contact, the mediator asserts the **couple** (§2): survivor named, slaved
   identity's occupancy transferred, lengths summed → one combined
   `train_length_mm` via `consist_changed`. The coupling clearance is revoked;
   exclusivity is universal again.

Decoupling is simpler: position (route), then the mediator asserts the split
(§2). No coupling clearance, no special motion.

### 5. Phasing, and the decoupler as a satellite

Three phases, smallest-risk first:

- **Phase 1 — runtime length (foundational, low-risk).** The
  `consist_changed` event, the `core.reports_consist_change` capability, the
  scheduler's gated update + occupancy re-derivation, and retained-state
  publication. This alone delivers passive-carriage drop/add (the common
  decouple case) and self-reported length changes. Additive: protocol minor bump
  0.7.0 → 0.8.0 when implemented.

- **Phase 2 — identity lifecycle.** Suspend-and-resume of slaved motion-device
  identities; occupancy transfer on couple; anchor re-establishment on decouple
  (§2). No new wire surface beyond Phase 1's event carrying the cut
  marker / survivor naming (settled at protocol-design time within the same
  minor line).

- **Phase 3 — coupling clearance + a robotic decoupler satellite.** The
  coupling-clearance command (§3) and, as the extensibility proof, a robotic
  decoupler built as a **satellite device in its own repository,
  `trainframe/decoupler`** (per CLAUDE.md's repo naming: a satellite capability/
  device repo, no `-packages` suffix). It declares `core.reports_consist_change`
  and drives couple/decouple over the exact public seams a built-in would — the
  "fun test" that the core never special-cases a device class. The
  coupling-clearance command is a further additive command append (epoch bump on
  `COMMAND_TYPE_ORDER`, mirroring ADR-022's `grant_reverse`), within the same
  pre-1.0 minor cadence.

Protocol-version implication overall: additive event + capability ⇒ a minor
bump (0.8.0) at Phase 1; the Phase 3 command is a further additive append. This
ADR, being Proposed and design-only, bumps nothing now.

## Consequences

- **The common case is nearly free.** Dropping passive carriages is just a
  shrinking `consist_changed` (Phase 1); no identity work, no exclusivity
  exception. Most "decoupling" an operator does costs only Phase 1.
- **Length becomes a live, externally-asserted safety input.** The fact that
  drives tail-release, reverse body-coverage, and the horizon is no longer fixed
  at registration; a satellite device can change it at runtime. The
  capability gate (`core.reports_consist_change`) and the hold-don't-guess
  asymmetry (an over-long hold is always safe) contain the risk, but the trust
  boundary is real — see the flag below.
- **No new motion primitive.** Coupling maneuvers reuse reverse authority and
  routes; the scheduler's motion surface is unchanged.
- **Carriages stay out of core, as ADR-016 decided.** The wire fact is a scalar;
  the discrete `consist` descriptor stays deferred; the simulator and visualiser
  keep ownership of carriage composition.
- **Determinism preserved.** No clock, no RNG enters the path. The survivor is
  device-named (deterministic given the assertion); occupancy transfer and anchor
  re-establishment are pure functions of held state plus the asserted cut
  marker / lengths.

### Flagged for the reviewer — this ADR is Proposed, not final

Three decisions most worth scrutiny before this moves to Accepted:

1. **The couple-survivor choice (§2).** We let the *mediating device name the
   survivor* rather than picking by the total order, on the grounds that only the
   physical device knows front/rear geometry. This puts onward-route orientation
   in a device's hands. Is that the right trust split, or should the scheduler
   own survivor selection with the device supplying only orientation as a hint?

2. **The coupling-clearance exception (§3).** This deliberately suspends ADR-011
   block exclusivity — the core safety invariant — for two named trains, one
   section, at crawl speed, under mediation. We argue it cannot leak (it is a
   scoped, requested, revocable grant, not a mode). This is the single riskiest
   thing in the design and deserves the hardest look: is the blast radius
   genuinely two-trains-one-edge, and is "intended gentle contact at crawl speed"
   a sufficient safety story, or do we want an additional interlock (e.g. the
   target train must be confirmed *stationary* before the grant issues)?

3. **The producer-authority trust boundary on length (§1).** A non-train device
   can now assert any train's `train_length_mm` at runtime. An *under-reported*
   length releases tail-held track too early — a tail-collision regression that
   the conservative-hold asymmetry does **not** catch (the asymmetry protects
   against over-long holds, not under-reports). The capability gate restricts
   *who* can assert; it does not validate the *value*. Do we want a sanity bound
   (e.g. reject a length below some floor, or below the train's own
   registration-declared length unless the assertion is a documented decouple),
   or is the capability gate alone the accepted boundary?
