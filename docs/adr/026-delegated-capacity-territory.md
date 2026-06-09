# ADR-026: Delegated capacity-territory (zones / railyards)

## Status

Accepted. **Partially implemented** — the load-bearing seam (capacity/occupancy
admission) is built; the opaque-interior maneuvering is modelled in the simulator
device and specified here for a later core handoff. Additive minor bump
(0.7.0 → 0.8.0): one new capability, one new event, one new retained-state shape.

Builds on:

- [ADR-001](001-capability-based-extensibility.md) — capabilities are the only
  extensibility primitive; a zone owner is an ordinary capability-bearing device,
  not a privileged class. This ADR adds **no** scheduler knowledge of "zones".
- [ADR-002](002-clearance-model.md) — clearance, not commands. A zone gates
  *entry* by withholding clearance, the system's universal "no" .
- [ADR-011](011-section-as-edge-plus-boundary-markers.md) — block-as-section
  exclusivity. A zone is a **generalisation** of a block: a block is a mutex
  (capacity 1); a zone is a counting semaphore (capacity N) whose freeness is
  *asserted by a device* instead of *computed by core*.
- [ADR-016](016-train-consists-and-length-visualisation.md) — carriages are
  invisible to core. This is the load-bearing constraint: it is *why* core cannot
  compute a zone's occupancy and must delegate the judgment.
- [ADR-018](018-multi-gate-semantics.md) — the consultation/voting seam several
  gating devices already share; zone admission reuses it.
- [ADR-023](023-coupling-and-decoupling.md) — length-only model + `core.reports_length`.
  A zone reconciles a train's length on exit through that exact seam. **This ADR
  resolves the contradiction ADR-023 names** (see *Reconciliation* below).
- [ADR-007](007-tag-resolution-registry.md) — the `core.assigns_tags`
  producer-authority pattern: when core has no oracle, the authorised device
  *asserts* the fact. Occupancy joins length and tag-bindings as a third instance.

## Context

The viability-test device log grew a **railyard**
([`docs/experimental/006-railyard.md`](../experimental/006-railyard.md)): a device
presiding over a fan of sidings off a single lead, into which a train enters with
carriages, is separated, shuffles, re-couples with different carriages, and
leaves. The design dialogue converged on a model that turns out to be a general
core concept, not a one-off device.

Two facts force the design:

1. **Core has no oracle for what is in the yard.** A siding can be blocked by a
   *cut of carriages with no locomotive* — and carriages are invisible to core by
   deliberate decision (ADR-016). So core **cannot compute** whether the yard has
   room. The only entity that knows is the device. This is the same shape as
   train length (no way to measure it — ADR-023) and tag bindings (no way to
   derive them — ADR-007): when there is no oracle, the authorised device
   *asserts* the fact and core trusts it, gated by a capability.

2. **The interior is physical reality core does not model.** What happens inside
   the yard — which siding, how the shuffles sequence, the coupling — is exactly
   the "maneuver" ADR-023 refused to put in core. The yard should be a **black
   box**: it swallows a train of length X and, later, emits one of length Y. Core
   models the length change (ADR-023) and the *capacity*; nothing else.

The instinct "let the device manage its own area, with its own definition of
free" is therefore correct, and principled: it is the only place the deciding
facts (carriages, interior moves) actually live.

### The two authorities

A zone splits authority cleanly at its boundary:

- **Admission (boundary, core-visible).** The zone presents to the core graph as a
  single **boundary marker** (the throat). Routing a train *into* the zone means
  clearing to that marker. Whether that clearance is granted is the **device's**
  decision — it knows its own occupancy. This is the part that touches core, and
  it reuses the clearance-consultation veto.
- **Interior (opaque, device-owned).** Slot assignment, the back-and-forth
  shuffling, coupling/decoupling, and the safety of trains moving inside are the
  device's job. Core neither sees nor manages it.

## Decision

### 1. A zone is a delegated capacity-territory, owned by one device

New capability **`core.gates_zone`**: a device that owns a capacity-limited region
and gates admission to it by its own asserted occupancy. The region appears in the
core graph as one **boundary marker** (`zone_marker_id`) — the throat every
entry/exit crosses. To core, the zone is one node with a capacity, not a subgraph.

### 2. Occupancy is an asserted, capability-gated fact — admission reuses the consultation veto

New event **`zone_state_changed { zone_marker_id, capacity, occupancy }`**, emitted
by the owning device whenever its occupancy changes (a consist parks, leaves, or a
siding is locked by carriages alone). The `core.gates_zone` capability consumes it
into per-device state.

Admission is the existing **clearance-consultation** seam, unchanged:
`onClearanceConsultation` returns `deny` when a train's proposed new clearance
limit **is** the `zone_marker_id` **and** `occupancy >= capacity`; otherwise
`abstain`. A denied train **holds at the throat** (clearance, not commands —
ADR-002). When the device next emits a lower occupancy, the scheduler's existing
`retryBlockedClearances` re-consults and admits automatically — the identical
"deny-and-hold, then auto-admit when free" cycle `gates_clearance` already uses.

**This needs no scheduler changes.** The scheduler already dispatches non-core
events to the emitting device's capabilities and retries blocked clearances after;
it already loops every capability during a grant. A zone is, to the scheduler,
indistinguishable from a gate that happens to say "no" based on a count.

### 3. The trust boundary: gate-only, no oracle (the ADR-007/023 pattern, third instance)

Core does **not** validate occupancy against ground truth, because it has none —
the deciding factor (carriages) is outside its model by construction (ADR-016).
Occupancy is trusted exactly as a length (ADR-023) or a tag binding (ADR-007) is
trusted: the `core.gates_zone` capability establishes that the producer is
authorised; an incorrect count is a device fault, not something core second-guesses
(it has no way to). The only checks are structural schema validation — `capacity`
and `occupancy` finite non-negative integers — i.e. malformed-payload rejection,
not safety validation.

### 4. Opaque interior, single-lead serialisation

Inside the boundary, the device is the authority. The interior markers are **not**
core's routable graph; core does not plan over them and must **not** raise a
topology violation (ADR-019) when a resident train reports one. Core suspends no
guarantee it ever held — the interior was never in its graph.

Interior safety is the device's responsibility, and the chosen discipline bounds
it: **single-lead**. The yard has one working track (the lead); only **one train
moves at a time** on it; trains parked in slots are stationary and cannot collide.
Interior safety thus reduces to the same one-mover invariant core enforces
everywhere — applied privately by the device to its lead. Capacity (how many
consists *park*, the N slots) is independent of concurrency (how many *move*, which
is one); a full yard still shuffles one move at a time. This is how real
small/medium classification yards run under a single switcher.

### 5. Length reconciled on exit (ADR-023)

When a train leaves the zone, its length may have changed (it dropped or gained
carriages inside). The device emits `train_length_changed` per ADR-023
(`core.reports_length`), and the scheduler re-derives occupancy with its existing
tail-release machinery. The zone is, to core, a length-changing black box — which
is precisely the ADR-023 §2 "a station that clips a carriage off is just a
reporter," now generalised to a whole region.

### Reconciliation with ADR-023

ADR-023 states the system gains "no coupling maneuver — no shunting, no
reverse-to-mate." A railyard performs exactly that shunting. The contradiction is
resolved by *where* it lives: **core still gains none of it.** The maneuver happens
inside a delegated territory the core does not model; core sees only a capacity
gate and a length change — both facts ADR-023/ADR-016 already sanction. ADR-023
carries a cross-reference to this ADR making that explicit, so the two do not
contradict: ADR-023 forbids shunting *in core*; ADR-026 puts it *in a device*.

## Implementation status

**Built now (this ADR's spine):**

- `core.gates_zone` capability + `zone_state_changed` event + `ZoneRetainedState`
  shape (protocol, version 0.8.0).
- The admission gate: deny-when-full at the boundary marker via
  `onClearanceConsultation`, auto-admit on occupancy drop via the existing retry.
  Zero scheduler changes.
- `VirtualRailyard` simulator device: scalable to **N slots**, asserts occupancy,
  models park/separate/recouple at the wire-faithful level (it emits real
  `zone_state_changed`, holds and admits real trains).
- **Length reconcile on exit** — [ADR-023](023-coupling-and-decoupling.md) is now
  implemented (protocol 0.9.0), and the railyard declares `core.reports_length`
  and reports a train out at a new length; the scheduler updates it. Proven
  end-to-end in `zone-admission.test.ts`.

**Built since, in [ADR-027](027-zone-interior-handoff.md):**

- The **opaque-interior transit handoff** — core formally suspending its
  management of a *tracked* train when it reaches the boundary as a route
  terminus (`in_zone`), and reclaiming it only on a device-asserted
  `zone_train_released` followed by a core-cleared departure. Admission now also
  gates on `core.can_reverse` (protocol 0.10.0), since interior shunting needs
  reversing. The device still owns the literal interior choreography (which
  carriage moves where); core simply stops routing the train until handed it
  back.
- The topology-violation **exemption** was **dropped**, not deferred: with core
  suspended on entry it never routes a suspended train across interior markers,
  so there is no traversal to exempt. The need evaporated rather than moving
  downstream.

This staging matched the house pattern: prove the load-bearing seam first (this
ADR), then the handoff (ADR-027). The experimental device
([006](../experimental/006-railyard.md)) is the end-to-end proof of both.

## Consequences

- **Block exclusivity generalises to capacity.** A block is a zone of capacity 1
  whose freeness core computes; a zone is capacity N whose freeness the device
  asserts. One concept, two specialisations.
- **Multi-occupant is cheap at the boundary, contained in the interior.** Core
  gets a clean capacity/occupancy gate for free (consultation + retry). The cost
  of multi-occupant — interior collision safety among movers — is bounded by
  single-lead and owned by the trusted device, never by core.
- **A third asserted fact.** Occupancy sits beside length (ADR-023) and tags
  (ADR-007) as a device-asserted, capability-gated, no-oracle fact. The trust
  model is uniform.
- **Carriages stay out of core (ADR-016 upheld).** The yard's whole reason to
  exist — rearranging invisible carriages — never crosses the wire as anything but
  a capacity count and a scalar length.

## Alternatives considered

- **One opaque block, capacity 1 (no slot model).** The single-occupant design
  from the earlier dialogue. Rejected: the user's goal is multi-occupant, and
  capacity is the abstraction that delivers it without core understanding the
  interior.
- **Fully-concurrent interior (device runs a private internal scheduler).**
  Rejected as the default: it re-implements core's block-exclusivity as
  safety-critical device code. Single-lead gives multi-occupant *parking* without
  it. Left open as a future device-internal choice.
- **External orchestrator over the admin API (ADR-008), no new core.** A client
  assigns each leg and watches events. Rejected as the model: it cannot express
  "the yard is full" to the *planner/clearance* layer, so trains would route to a
  full yard and discover it only at the throat with no first-class capacity fact.
  The consultation veto makes capacity a real, retained, plannable fact.

## Open questions

- **Multi-occupant interior concurrency.** Single-lead is the accepted default;
  whether a zone may ever advertise concurrent leads (and thus need internal
  clearance) is deferred to the device, not core.
- **Capacity advertisement for the planner.** The deny-and-hold gate is correct
  without it, but a retained `K of N free` lets the planner avoid routing toward a
  full yard rather than stalling at the throat. Schema defined
  (`ZoneRetainedState`); planner consumption is a later refinement.
- **Identity of the admitted train.** Admission currently gates on capacity alone;
  a zone that wants to admit *a particular* train (reservations) would need the
  consultation request's `train_id`, which it already carries.
- **Failure recovery.** A train stranded inside a crashed zone device: fail-safe is
  core's default — clearance is withheld, nothing moves, an operator intervenes.
  The boundary handoff protocol (future work) must define reclaim-on-disconnect.
- **Tag→slot resolution.** Which slot a consist occupies is device-private; if a
  future feature needs core to know, that is the cargo-entity slippery slope
  ADR-016/023 refuse — raise it, don't assume it.
