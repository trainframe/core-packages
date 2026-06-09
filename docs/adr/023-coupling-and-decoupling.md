# ADR-023: Runtime train length changes (carriage swaps)

## Status

Accepted (not yet implemented). Design-only; no code yet. When implemented it is
an additive minor bump (0.7.0 → 0.8.0): one new event and one new capability,
plus ordinary structural schema validation. Nothing else.

Resolves the open design question recorded in CLAUDE.md and `docs/status.md`,
*"Coupling/decoupling of trains as multi-vehicle compositions,"* by deciding —
deliberately — that the system does **not** model compositions. It models
length, and length alone.

Builds on:

- [ADR-016](016-train-consists-and-length-visualisation.md) — a train's **total
  length is the only wire quantity**; carriages are a `VirtualTrain` /
  visualiser detail, never devices, never wire entities. This ADR reaffirms that
  and makes the one change ADR-016 left out: letting that length change at
  runtime.
- [ADR-012](012-train-length-and-tail-clearance.md) — `train_length_mm` drives
  tail-clearance release; it is the load-bearing input this ADR makes mutable.
- [ADR-007](007-tag-resolution-registry.md) — the `core.assigns_tags`
  producer-authority pattern the scheduler enforces; this ADR mirrors it.

## Context

The physical reality is Brio-style toy track: carriages attach to a train (and
to each other) with magnets. A child picks a carriage up off one train and
sticks it on another whenever they feel like it. There is no coupler protocol,
no negotiation, no maneuver — just a small hand rearranging passive plastic.

The only consequence the system cares about is that **a train's length
changed**. Length drives tail-clearance release (ADR-012), the ADR-022 reverse
body-coverage check, and the clearance horizon. Today `train_length_mm` is fixed
at `device_registered` and immutable for the device's lifetime
(`scheduler.ts` ~line 226). So a train that gains or loses a carriage is, as far
as the scheduler knows, still its registration-time length — and its
tail-occupancy is wrong until it re-registers.

Two things follow, and they are the whole of this ADR:

1. **Length must be changeable at runtime**, with occupancy re-derived when it
   is.
2. **The change must not have to come from the train.** A locomotive generally
   cannot sense that a child added a carriage behind it. Something else may know
   — a future trackside station that does the attaching/detaching, or an
   operator telling the system. So the producer of a length fact must be allowed
   to be a device *other than the train*, while still being trusted (a child
   cannot, and a buggy device should not, silently rewrite a safety input). ADR-007
   already solved exactly this shape: `tag_assignment` is honoured *only* from a
   device that declared `core.assigns_tags`. That is the template.

### What this ADR explicitly does NOT do

The earlier draft of this ADR grew an identity lifecycle, a coupling-clearance
exception to block exclusivity, and a maneuvering orchestration for trains
driving into each other to mate. **All of that is deleted as out of scope and
unwanted.** For the avoidance of doubt, the system does *not* gain:

- any notion of a **carriage as an entity** — carriages stay invisible to core
  and protocol, exactly as ADR-016 decided;
- any **identity lifecycle** — no train is minted, retired, slaved, or resumed
  when carriages move. Swapping a carriage from train A to train B is simply A's
  length going down and B's length going up: two independent length facts about
  two pre-existing trains;
- any **coupling clearance** or exception to ADR-011 block exclusivity — nothing
  drives into an occupied block to couple; a hand does the work while trains are
  wherever they are;
- any **coupling maneuver** — no shunting, no reverse-to-mate. (Reverse authority
  from ADR-022 exists for deadlock recovery; it is not repurposed here.)

The guiding principle, stated so a future reader does not re-grow this: **the
system's only concept of a train's make-up is its length. It should stay that
way.** If a feature seems to need the core to know *which* carriages are where,
that is a simulator or visualiser concern, or it is the wrong feature.

> **Update (ADR-026).** "No coupling maneuver — no shunting" remains true *of the
> core*. [ADR-026](026-delegated-capacity-territory.md) later adds a delegated
> **capacity-territory** (a railyard): a device may own an opaque region and
> perform shunting *inside it*, emitting to core only a capacity/occupancy count
> and, on exit, a length change via the `core.reports_length` seam this ADR
> opens. That does not contradict the prohibition here — core still gains no
> maneuver, no consist model, no reverse-to-mate. The shunting lives in a device,
> not the scheduler, which is exactly where this ADR says physical make-up
> belongs.

## Decision

### 1. `train_length_mm` becomes a runtime, capability-gated, retained fact

**New event: `train_length_changed`**, carrying the affected `train_id` and the
new scalar `train_length_mm`. No carriage list, no composition — just the new
length. (Named for exactly what it is. `consist_changed` was considered and
rejected as implying a composition model we are choosing not to have.)

**New capability: `core.reports_length`.** A `train_length_changed` event is
honoured *only* if the producing device declared `core.reports_length` at
registration; otherwise the scheduler rejects it with a `warning` anomaly and
makes no state change — the exact enforcement `core.assigns_tags` uses
(`scheduler.ts` ~line 369), a marker capability checked directly, no capability
voting. The capability says nothing about device class: a train that *can* sense
its own length may hold it and self-report; a trackside station may hold it and
report on the train's behalf. The scheduler does not care which.

**On receipt the scheduler** updates `TrainState.length_mm` to the new scalar
and **re-derives occupancy** with the machinery that already exists — fed a new
length, not given new logic:

- re-run the ADR-012/016 tail-release walk (a shorter train may release edges it
  still held; a longer train holds more, and ADR-016's conservative
  hold-don't-guess asymmetry means an over-long hold is always safe);
- the ADR-022 reverse body-coverage check reads the new length on its next call;
- the clearance horizon keys off the new length on the next event;
- publish the new length on the retained `railway/state/devices/{id}` payload
  (the `DeviceRetainedState` ADR-016 added), so fresh subscribers and the
  visualiser see the current length without replaying history.

That is the entire feature. It is the ADR-012 registration path made mutable and
capability-gated, reusing occupancy code already in the scheduler.

**No value validation — the capability gate is the trust boundary.** The
scheduler does *not* sanity-check the reported length, because it has no ground
truth to check against: there is no independent way to measure a train's length
or even to detect that it changed (that is precisely why the fact must be
*asserted* rather than observed). Nor is there a usable relational bound — a
floor like "reject below the registration length" would be wrong, since removing
carriages legitimately *shrinks* a train. So length is trusted exactly as a
`tag_assignment` is trusted: the `core.reports_length` capability establishes
that the producer is authorised, and an incorrect value is a device fault, not
something the core second-guesses (it has no oracle to do so, and a fake check
would only manufacture false confidence). The only check is ordinary
protocol-layer schema validation — a finite, positive number — which is
malformed-payload rejection, not safety validation. If authority ever needs
tightening, the one defensible lever is *context*, not value: e.g. a station may
assert a length only for a train currently located *at* it. That is a later
refinement, not core.

### 2. A trackside attach/detach station, if it ever exists, is just a reporter

The "fun test of the system" — a station that physically clips a carriage on or
off — needs **no special core support**, and that is the point. It would be a
satellite device (`trainframe/decoupler` per CLAUDE.md's naming) that declares
`core.reports_length`, does its mechanical work while the train sits at it, and
emits a `train_length_changed` with the resulting length. The core never learns
what a "decoupler" is; it sees a capability-bearing device assert a length, the
same as it would from a train. No coupling clearance, no maneuver, no identity
change — because, per the principle above, the only fact that crosses the wire
is the new length.

## Consequences

- **Tiny surface.** One event, one capability, one mutable field, occupancy
  re-derivation that already exists. No identity machinery, no exclusivity
  exception, no new motion. The open design question is resolved by *narrowing*
  it, not by building the large thing its original wording implied.
- **Length becomes a live, externally-assertable safety input.** What drives
  tail-release and reverse body-coverage is no longer fixed at registration. The
  `core.reports_length` gate restricts *who* may assert it; the *value* is
  trusted (no oracle exists — §1), exactly as a tag binding is trusted.
- **Carriages stay out of core (ADR-016 upheld).** The simulator and visualiser
  keep ownership of carriage composition; the wire fact is a scalar.
- **Determinism preserved.** No clock, no RNG; the update is a pure function of
  the asserted length and held state.

### Resolved decision: no value validation (gate-only)

The one decision this ADR left open in review — whether to sanity-check the
reported length value — is resolved as **gate-only, no value check** (§1). There
is no ground truth to validate against, no usable relational bound (length
legitimately moves both ways), and a fake check would only manufacture false
confidence. The `core.reports_length` capability is the trust boundary, mirroring
`core.assigns_tags`; only structural schema validation (finite, positive) applies
at the protocol layer.

### Open, but deliberately out of scope here

**How is a length change detected when nothing observes it?** When a child moves
a carriage by hand and no `core.reports_length` device sees it, *nothing* knows
the length changed until something reports it. This ADR makes length *reportable
and changeable*; it does not make changes *detectable*. Detection is a
hardware/device concern — a load sensor, an operator UI, re-registration, or a
sensing station. A concrete viability test of exactly this lives at
[`docs/experimental/001-vision-length-station.md`](../experimental/001-vision-length-station.md):
a station with a computer-vision element that measures a train as it visits and
reports the result. The core model is complete; the detection story lives outside
it, and an experimental device is the right place to prove a detector is possible.
