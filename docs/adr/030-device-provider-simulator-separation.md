# ADR-030: Devices as portable controllers; the simulator as the physical world

## Status

Accepted — partially built. **Done (video-confirmed):** the physical substrate
(`packages/simulator-ui/src/physics/` — `world.ts`, `rail.ts`) with all seven
acceptance scenarios passing as both headless unit tests and recorded video
(`packages/ui-tests/scripts/physics-scenarios-video.mjs` → 8/8), and the CameraProvider
seam + two-marker vision station (`…/sensors/`) measuring a passing rake's length
(224 mm vs 224 mm expected). **Remaining:** the railyard rebuilt as a CV-driven
controller on this substrate (Plan §4) — needs the physics extended from a single
rail to a switched rail network.

Establishes the load-bearing separation every custom device will sit on:

- A **device** is a portable controller. It runs an event loop, speaks the **core
  protocol** (markers, clearance, go/stop/reverse, `tag_observed`), and perceives /
  acts on the world **only** through **provider interfaces** (a camera, an actuator).
  It holds no track geometry, no pixels, no carriage bookkeeping. The same device
  class could be lifted into firmware by swapping its providers.
- A **provider** is the sensor/actuator seam. In the simulator a provider is backed
  by the simulator's ground truth; on real hardware the same interface is backed by
  OpenCV, GPIO, motor drivers. **Device logic never changes between the two.**
- The **simulator** is the authoritative **physical world**: it owns body pose,
  velocity, extent, track geometry, contact/collision, coupling, derailment. It
  *drives* sensors and *obeys* actuators. **Track and carriages exist only here;
  core sees only markers.**

This ADR does **not** change the wire protocol or core. It changes where world
modelling lives and how devices reach it.

Builds on / relates to:

- [ADR-016](016-train-consists-and-length-visualisation.md) — carriages are invisible
  to core; length is the only physical fact on the wire. This ADR makes carriages
  fully **physical objects in the simulator** that no central system is formally
  aware of — exactly that principle, taken to its conclusion.
- [ADR-026](026-delegated-capacity-territory.md) / [ADR-027](027-zone-interior-handoff.md)
  — the zone is opaque to core; the throat is the authority boundary. Unchanged. A
  device's *interior* behaviour is now expressed as sense→decide→actuate against
  providers, not as hand-computed geometry.
- [ADR-022](022-reverse-authority.md) — reverse is a device-level motion primitive
  (go/stop/reverse), now actuated against the physical layer.
- [ADR-029](029-railyard-interior-shunting.md) — **its implementation approach is
  superseded by this ADR.** ADR-029 built the interior as hand-animated centre-line
  keyframes (bespoke per-phase paths, magic constants, per-phase reverse flags). That
  is exactly the hand-rolled animation this ADR removes. The *behaviour spec*
  (`docs/spec/railyard-shunting-choreography.md`) still stands; only the mechanism
  changes — the railyard is rebuilt as a vision-driven controller on the substrate
  defined here.

## Context

Building the railyard interior by hand-animating every phase produced a brittle mess
that fought geometry on every change and required a non-physical 180° sprite-flip to
fake reversing. The root cause is architectural, not local: **devices that need
custom behaviour have no physical world to act on and no sensor seam to perceive it
through, so they reach through the protocol into simulator internals and hand-roll
the result.** Without fixing this, every future device with custom behaviour repeats
the same trap.

What is **already correct** (and must be preserved):

- The **train ↔ core boundary.** `VirtualTrain` is commanded purely by bus events
  (`route_assigned`, `grant_clearance` with a clearance-limit marker) and emits
  `tag_observed` (marker reads). It has **zero concept of curvature** — the renderer
  maps its progress onto the real curve. The device already speaks the right language.

What this ADR **retcons** about the train device:

- **A train does not know its velocity or metric position.** Real loco hardware can't
  report either accurately, so neither is device knowledge and neither is on the wire.
  The train device knows only its **motion state — forward / stopped / reversing** —
  its route (a marker sequence), and its clearance-limit marker; it learns *where it
  is* only as **marker crossings** (`tag_observed`). **Velocity and metric position
  are physical facts owned by the simulator** (the body's kinematics; ramps accelerate
  it under gravity), perceivable only by external sensors. `train_status` no longer
  carries velocity. Consequently the device's braking/clearance behaviour is
  **marker-event-driven**, not odometry-driven — and any speed *measurement* must come
  from outside the train (see §5).

What is **broken**:

1. **Devices reach into the simulator.** The railyard reads `getConsist()` and calls
   `setConsist()` — a device formally editing carriages — and (via the toy-table)
   hand-computes interior geometry.
2. **The one sensor we have is hard-wired.** `reportVisionLengths` "measures" a train
   by reading `simulation.getTrain().getConsist().length` and emitting it. It is the
   right *idea* (a vision sensor) wired the wrong way — it cheats by reading
   ground-truth makeup instead of perceiving it, and there is no swappable interface.
3. **There is no physical world.** Authoritative state is 1D (edge + distance);
   2D world geometry lives only in the renderer (`packages/simulator-ui`), derived
   per-frame, not authoritative. Nothing collides, nothing derails, nothing can leave
   the rails. The simulator cannot do the job it exists for — being a real-world
   stress test of the core protocol.

## Decision

### 1. A shared device base (event-loop controller)

All devices share a base interface: an event loop with lifecycle hooks
(`on_tick`, `on_bus_event`, `on_sensor_event`, `emit`). A device's logic is a pure
controller over that loop — it consumes bus + sensor events and emits bus messages +
actuator commands. No device touches simulator state directly.

### 2. Provider interfaces (the sensor/actuator seam)

Devices are constructed with providers behind narrow interfaces. The two we need
first:

- **`CameraProvider`** — emits dumb, time-sampled perceptions, e.g. every ~50 ms:
  `{ occupied: true, colour }` while something is in view, then a final
  `{ occupied: false }`. **No identity, no length, no ground-truth makeup** — only
  what a fixed sensor could actually see. The sim backs this from physical body
  state; real hardware backs it from OpenCV. The device does the inference.
  **A camera perceives only the track physically beneath it** (its footprint at its
  current position) — a slight over-constraint, but it keeps the model simple and,
  crucially, makes a multi-part device **coordinate its camera and actuator**: to
  perceive a different spot, an actuator must first move the camera there (e.g. the
  railyard's camera rides the crane/gantry, so "look at that slot" is an actuator
  move followed by a perception). A fixed device (the vision station) simply has a
  fixed footprint over its stretch of line.
- **`ActuatorProvider`** — issues real-world motion (a crane head moving, a hook
  lowering, a motor speed/direction). The sim turns these into body motion; real
  hardware turns them into GPIO/motor output.

The interfaces must admit richer future backings (a spatial camera, two-sensor
time-of-flight) **without changing device logic**.

### 3. The simulator owns an authoritative, lightweight physical world

The simulator gains a physical-body model — the unifying substrate both vision and
collisions sit on:

- **Bodies** have **pose (x, y, heading) + velocity + extent**. Trains and carriages
  are bodies. Pieces **self-report** simplified collision geometry.
- **Rail as a breakable constraint.** A body is normally held to the centre-line of
  its rail (this is how it follows curves — the body, not the device, is constrained).
  The constraint **releases** under conditions that then produce free motion:
  - **end of rail** → the body stops at a terminus, or **coasts off** an unbuilt
    track end (free ballistic motion);
  - **speed × curvature over a lateral limit** → **derailment** (e.g. a train that
    gained speed down a ramp under gravity and cannot hold a curve).
- **Contact** is a lightweight kinematic test (extent overlap). Resolution is along
  the motion axis: bodies **stop** each other or **push** an unanchored body ahead.
- **Coupling** is a physical magnetic event: a body reversing into contact with a
  carriage **snaps** coupled when their coupler faces come within a **capture range**.
  The bond holds up to a **hold strength**. A coupling **breaks** by exactly one of
  two distinct physical events:
  - **Mechanical separation (the decoupler).** An actuator — the railyard crane's
    **wedge** — is driven down between two coupled faces and **forces them apart past
    the capture range**. This is a deliberate prising motion, modelled as an
    actuator-applied separation at a named coupling point; it is **independent of
    traction/power** (the wedge doesn't out-pull anything, it physically splits the
    faces). This is how the yard decouples.
  - **Tension overload.** The net pulling force across the coupling exceeds the hold
    strength and the bond tears. Trains carry a **traction/power** value, so a
    tug-of-war between opposed locos coupled to one carriage resolves by the stronger
    winning; **equal power is the stalemate** special case (acceptance video #5). A
    weak coupling could also tear under a strong-enough single pull.

  The two are separate mechanisms on purpose: traction/power governs *tension* breaks
  and tug-of-war; the wedge governs *deliberate* decoupling and has no traction parallel.

This is deliberately **kinematic-lite, not a dynamics engine** — overlap tests, a
breakable rail constraint, gravity on slopes, magnetic snap with a strength cap. No
device knows any of it; they perceive its consequences through sensors.

### 4. Physics + geometry are DOM-free and headless-testable; the UI is a view

The authoritative physical-body model must be testable **headless** (no DOM) and
must own positions; React only reads body poses. Where it lives: the original plan
said `packages/simulator`, but in practice the track geometry already lives in
`packages/simulator-ui` (`pieces.ts`, `edge-path.ts`) and `packages/simulator` is
pure logical/device simulation with **no spatial data** (it operates on the marker
graph). The toy-table layer in `simulator-ui` *is* the physical-world layer.
Inverting that — relocating all geometry into `packages/simulator` — would be a large,
risky churn against the existing "logical graph vs spatial layout" separation, and a
new shared package needs explicit sign-off. So **the physics layer lives in
`packages/simulator-ui/src/physics/` (and `…/sensors/`), DOM-free and unit-tested
headless under vitest** — satisfying the headless requirement without the relocation.
If a non-UI consumer ever needs the physics, extract a shared geometry package then.

### 5. The vision station, done honestly (two-marker speed)

Because the train can no longer self-report speed (the retcon above), a fixed camera
yields only **dwell time**, not length — so the device measures speed itself from its
**two markers a known, internally-set distance apart**. The device is configured with
**the ids of its two markers and the fixed baseline distance between them**; it
watches `tag_observed` for those ids, and speed = baseline ÷ (interval between the two
crossings). It then integrates the `CameraProvider`'s blob-presence stream into a
dwell, derives length = speed × dwell, cross-references with its core insight (a train
was just here), and reports the length. **No train self-reporting; no reading
`getConsist`.** This is the first real exercise of the provider seam and validates it
cheaply.

### 6. Carriages are physical; no device edits a consist

Carriages are simulator bodies. Coupling/decoupling are **physical events** (proximity
snap; a decoupler actuator splitting a coupling). Devices learn a train's makeup by
**perceiving** it (vision), never by mutating a consist array. `setConsist` as a
device API goes away.

## Non-goals

- **Not full Newtonian dynamics.** Lightweight kinematic contact + a breakable rail
  constraint is enough for the acceptance set.
- **No new wire protocol.** Core still sees only markers and the existing events. The
  two-marker vision station uses an extra *marker*, not a new message shape. The one
  wire *reduction* is `train_status` dropping its velocity field (the retcon above) —
  a simplification of an existing event, not a new shape or topic.
- **The opaque-zone model (ADR-026/027) is unchanged.** Core still never routes a
  zone interior.

## Plan (sequencing)

1. **This ADR.**
2. **Vision station** (§5) — formalise the `CameraProvider` and the two-marker speed
   device; retire `reportVisionLengths`' ground-truth cheat.
3. **Physics substrate** (§3), in parallel — built to satisfy the acceptance videos
   below.
4. **Railyard last** — rebuilt as a `CameraProvider`-driven controller commanding a
   self-propelled train + a decoupler actuator on the physical layer, against the
   unchanged behaviour spec. It only works once 2 and 3 are real.

## Acceptance (physics substrate)

A reliable video of each, verified by the scenario/trace harness
(`packages/ui-tests/scripts/`):

1. A train hits an oncoming train and both stop — **no markers**.
2. A train hits a carriage and **pushes it back**.
3. A train drives into a terminus and stops **purely in the simulator** — no marker,
   no core clearance telling it to stop.
4. A train **magnetically couples** to a carriage after reversing into it.
5. Two trains facing opposite ways, both coupled to one carriage, **stalemated** at
   equal power (and the stronger loco winning when powers differ).
6. A train going too fast (down a ramp) **derails** on a curve.
7. A train **continues off the track** because the rest of the track is not built.

## Consequences

- Every future custom device is a controller over providers — the railyard pattern
  generalises instead of being re-hand-rolled each time.
- The simulator becomes a genuine real-world stress test of the core protocol:
  physics can **contradict** core (a train stops/derails/leaves the graph with no
  marker), which is precisely the failure surface worth testing.
- Larger near-term cost (a physical layer + provider seam + a geometry move) in
  exchange for deleting the hand-animation and unblocking all custom devices.
- The 180° facing-flip disappears for free: a body that reverses simply drives
  backward, heading continuous.
