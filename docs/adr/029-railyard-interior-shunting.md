# ADR-029: Real railyard interior — device-driven shunting

> **Behaviour spec:** the agreed, authoritative description of how the interior
> choreography must look and behave lives in
> [`docs/spec/railyard-shunting-choreography.md`](../spec/railyard-shunting-choreography.md).
> Where the build and that spec disagree, the spec wins.

## Status

Accepted — built. Makes the railyard **interior** real: the zone device drives a
SELF-PROPELLED train along the yard's actual interior rails (spine → ladder leg →
slot) — enter a free slot, the crane lifts its leading cut, pull back onto the lead
and drive into the spares slot to couple, the crane reads it, then drive back out —
and the gantry crane only ever handles CUTS OF CARRIAGES, never the loco/train.
Replaces the instantaneous `swapLeadingPair` consist-array swap that
[ADR-027](027-zone-interior-handoff.md) deliberately hand-waved. The device is
geometry-free (phase + progress + slot choices); the toy-table maps each phase onto
its centre-line path. Verified by `virtual-railyard.test.ts` (phase order, cut
lift/hold, no-swap path) and a yard-framed screenshot + video pass
(`scripts/railyard-yard-capture.mjs`, `scripts/railyard-single-video.mjs`).

**Scope boundary (the load-bearing decision): this is entirely a simulator +
toy-table concern. Core and the wire protocol do not change.** ADR-026/027 already
settled that core never routes a train inside a zone — the interior "is the
device's and the simulator's concern, hand-waved exactly as every experimental
device hand-waves its hardware." This ADR stops hand-waving the *hardware*; it
does not touch the handoff. Entry-suspend, exit-release (`zone_train_released`),
and length reconcile (`train_length_changed`, ADR-023) are unchanged and still the
only things that cross the wire.

Builds on:

- [ADR-026](026-delegated-capacity-territory.md) — the zone is opaque to core; the
  device asserts occupancy. The interior geometry defined here is **device-private**
  and never enters core's graph. Single-lead (one mover inside) is upheld.
- [ADR-027](027-zone-interior-handoff.md) — the throat is the authority boundary.
  A suspended train (`in_zone`, holding no core block) is exactly the train this
  ADR is free to drive: core has let go of it, so interior motion is invisible and
  safe by construction.
- [ADR-023](023-coupling-and-decoupling.md) / [ADR-016](016-train-consists-and-length-visualisation.md)
  — length is the only physical fact on the wire; carriages are invisible to core.
  The interior changes a train's wagons incrementally; the device reconciles the
  resulting length on exit (already built).
- [ADR-022](022-reverse-authority.md) / `core.can_reverse` (ADR-027 §4) — interior
  shunting is back-and-forth; admission already requires a reversible train. This
  ADR is what that gate was *for*.

## Context

Three things are visibly wrong in the demo, all downstream of the hand-waved
interior:

1. **Nothing collides inside the yard.** Slots are labels (`occupant | null`), not
   places. An admitted train never spatially enters; it parks at the throat and
   its consist is swapped in place, so trains and cuts render on top of each other.
2. **Trains drive through each other's rakes on the main line.** Core models a
   train's length as the loco only (~60 mm) while the toy-table renders a ~270 mm
   rake; carriages are invisible to core (ADR-016), so block exclusivity frees
   blocks the wagons still occupy. This is *separable* from the interior and is a
   pure application of ADR-023 (report the train's true length); it is handled
   first, before this ADR's interior work (see §0).
3. **No real coupling/decoupling.** `swapLeadingPair` is an instantaneous array
   mutation — no maneuver, no crane, no time, no occupancy.

The whole point of the railyard exercise is to *demonstrate* a zone device that
controls train movement: pulling a train between slots with forward/reverse
maneuvers to join and part from carriages, the crane doing the decoupling. That is
the deferred interior, and it is now worth building because the platform around it
(admission, suspend/reclaim, length reconcile, the crane) is real.

## Decision

### 0. Prerequisite (separable): trains carry their true length on the main line

Before the interior work, fix the main-line overlap with existing machinery: a
train's reported `train_length_mm` is the physical extent of **loco + coupled
rake**, not the loco alone. Block exclusivity + ADR-023 tail-release then hold the
blocks the wagons occupy, so trains stop tailgating through each other. The length
changes when wagons couple/decouple (the yard already reports this on exit, ADR-023).
This is not part of the interior model; it is listed here because it is the
"collision" half of the same complaint and lands first. **Risk to watch:** a longer
train holds more blocks, which can re-tighten contention on a short loop — verify
with the headless multi-train soak before/after.

### 1. The interior is a device-private geometry the simulator mirrors

The yard owns a small interior model, never published to core:

- an **interior lead** running back from the throat, and **N slot positions** along
  it (the existing visual bays, now given coordinates);
- each slot holds at most one **cut** (a contiguous set of wagons) or is empty;
- one **mover** at a time (the admitted train) occupies a position on the lead
  (single-lead, ADR-026).

This is the device's "hardware" map. The simulator mirrors it so the train can be
*driven* over it; the toy-table renders train + wagons at their interior positions.
Core sees none of it — the zone is still one boundary marker.

### 2. Interior movement authority (in-sim, not on the wire)

While a train is suspended `in_zone`, the device drives it: the `VirtualRailyard`
issues interior moves to the `VirtualTrain` (drive to interior position P, forward
or reverse; stop). The `VirtualTrain` gains an **interior-drive mode** distinct from
main-line clearance — it follows the device's position commands along the interior
lead instead of a core route, and reports no `tag_observed`/`marker_traversed`
(there are no core markers inside).

**Real-world mapping / why this is honest.** A physical railyard would move a train
through its own interior control (powered shunting track, or a private device↔loco
channel) — out of core's scope by ADR-027. The simulator models that control
in-process (the device holds a reference to the train), exactly as every device
sim "is" its own hardware. *Simulator as a peer of hardware* holds: core, server,
and visualiser cannot tell — only the sim internals drive the train. A future wire
protocol for device→train interior commands is **explicitly deferred**; nothing
here precludes it.

### 3. Coupling/decoupling is a timed, crane-tied maneuver — not a swap

`swapLeadingPair` is replaced by a **choreography** the device runs while it holds
the train (after suspend, before release). The **self-propelled** train drives
itself along the yard's REAL interior rails (the toy-table's spine + ladder legs +
slots) — it does not float across the body. The shipped sequence:

1. **enter** — the train drives in off the throat, along the spine and out a ladder
   leg, onto a free slot;
2. **decouple** — it sits while the **crane** travels over its leading cut, lowers,
   and lifts that cut off (the crane only ever handles CUTS OF CARRIAGES, never the
   loco/train); the consist shortens;
3. **cross-pull** then **cross-set** — the train pulls back out onto the spine lead,
   then drives into the spares slot; as it arrives the spares couple onto it and the
   consist is whole again. Meanwhile the crane carries the lifted cut across and sets
   it down in the spares slot, where it becomes the next visitor's spares;
4. **inspect** — the train sits in the slot it ended up in (no return-to-neutral)
   while the crane's **camera reads** it correct;
5. **release-out** — the train drives itself back to the throat; the device
   reconciles length (ADR-023 `train_length_changed` if it changed) and emits
   `zone_train_released` (ADR-027), and core reclaims it.

A train with nothing to swap still enters and is inspected, but the crane lifts no
cut. Each step takes sim time and is observable; the consist changes **incrementally**
(a cut at a time) rather than in one instant. The interior is **geometry-free in the
device** (it emits phase + 0..1 progress + slot choices); the toy-table maps each
phase onto its centre-line path and owns where the train, crane, and cuts render.
The demo uses the "swap the leading pair" goal, now actually performed by driving
the train between real slots while the crane works the cuts.

### 4. Interior occupancy ⇒ collision-free, by construction

The device never drives the train to a position occupied by a cut, and never drops
a cut into a non-empty slot. Single-lead (one mover) means two movers never meet.
Together these make the interior collision-free without a physics engine — the same
"assert, don't compute" stance ADR-026 takes for occupancy, applied to position.

### 5. The crane is driven by the work

The crane **parks while the self-propelled train drives itself** and only ever
moves to handle CUTS OF CARRIAGES — never the loco or the whole train (the bug the
first cut of this had). Per phase: it runs in over the leading cut to lift it
(`decouple`), carries that cut across to the spares slot and sets it down as the
train takes the spares (`cross-pull`/`cross-set`), reads the finished train
(`inspect`), and otherwise sits at its home end. The toy-table derives the gantry
pose from the device's phase + progress (re-rendered each sim tick, like the
trains), lowering the hook only while actually working a cut.

## What this ADR deliberately does NOT do

- **No core or protocol change.** No new event, capability, or scheduler branch.
  The handoff (ADR-027) and length seam (ADR-023) are untouched.
- **No wire-level interior command protocol.** Device→train interior movement is
  modeled in-sim. A real ESP-NOW/MQTT interior channel is deferred.
- **No multi-lead / concurrent interior motion.** One mover inside, always.
- **No coupler physics or identity.** Cuts are contiguous wagon groups; coupling is
  a list operation with a position and a time, not modeled magnets. Carriages stay
  invisible to core (ADR-016); no identity is minted (ADR-023 upheld).
- **No general shunting puzzle solver.** The demo runs one fixed program; arbitrary
  Inglenook/Timesaver sequencing is out of scope.

## Consequences

- The railyard finally *demonstrates its own thesis*: a zone device controlling
  train movement, shunting between slots with forward/reverse to join and part from
  carriages — visibly, with the crane doing the decoupling.
- Interior realism is contained to `VirtualRailyard` + `VirtualTrain` (interior-drive
  mode) + the toy-table renderer. Core/server/visualiser are unaffected — proof that
  the ADR-026/027 boundary was drawn in the right place.
- Collisions are designed out (occupancy + single-lead), not detected — consistent
  with the platform's no-oracle stance.

## Test plan

- **Interior occupancy is respected** (sim): drive a train through the program and
  assert it never shares an interior position with a cut, and never drops into a
  filled slot.
- **Incremental consist change** (sim): after step 2 the train is shorter by one
  cut and the slot holds it; after step 4 it is longer and the slot is empty — not
  a single atomic swap.
- **Length reconciled on exit** (integration, existing seam): the train leaves with
  the rearranged length the maneuver produced (ADR-023).
- **Main-line non-overlap** (integration, §0): two trains with full-rake length run
  the loop without their rakes' blocks overlapping; the multi-train soak still
  circulates (no new deadlock from longer trains).
- **User-observable** (Playwright, per practice): a journey video/assertions showing
  a train pull in, get shunted between slots, and pull out with swapped wagons.

## Open questions

- **Interior geometry source of truth.** The slot coordinates exist in the toy-table
  (`RAILYARD_SLOT_YS` etc.). Does the sim derive the interior lead from those, or
  carry its own parameterisation handed in at spawn? (Leaning: device is constructed
  with an interior spec, the UI renders from the same spec — one source.)
- **Program generality.** The demo runs a fixed drop-pair/pick-spares program. A
  declarative interior program (so satellites define their own) is a later step.
- **Wire interior protocol.** If/when interior movement should be real device→train
  commands (so a physical yard could drive a physical loco), that is a protocol ADR
  of its own — deferred here.
