# ADR-031: The provider boundary — platform providers and physically-honest actuators

## Status

Accepted — **built** (the platform-provider seam). The `PlatformProvider`
interface (`devices/platform-provider.ts`) is the device↔core seam: a device
imports only it and never a transport. Three backings land — the in-process bus
(`inProcessPlatform`, sim/tests), the parent-as-core link (`ParentPlatform` /
`platformFor`, ADR-032, wired additively into `DepotController` so the depot is
its turntable child's core), and the **MQTT adapter at the IO/composition EDGE**
(`broker/mqtt-platform.ts`, next to `MqttBrokerClient`) — and the **device layer
is transport-free** (a grep confirms nothing under `devices/` imports the broker
client, the MQTT adapter, or `'mqtt'`). A portability proof drives the *same*
controller over both the in-process bus and the edge MQTT adapter against a real
in-process aedes broker, asserting identical behaviour. §2 (honest actuators) was
already realised by the crane/turntable/link actuators. Extends
[ADR-030](030-device-provider-simulator-separation.md).

## Context

ADR-030 made a device a **portable controller**: it runs an event loop, speaks the
core protocol, and perceives / acts on the **physical world** only through provider
interfaces (a `CameraProvider` to sense, a `MotorActuator` / `SwitchActuator` to
act). Swap the provider implementation and the *same* device logic runs against the
simulator or against real hardware. That is the load-bearing separation.

Two things ADR-030 left under-specified have now surfaced while planning the
turntable, the dock crane, and the depot:

1. **The device ↔ core connection is still implicit.** A device perceives the
   *world* through a provider, but its link to *core* — publishing events,
   receiving commands / clearance, registering its capabilities — is assumed to be
   "an MQTT client it has." That is the one remaining place a device reaches out and
   constructs its own transport. It means a device cannot be exercised headlessly,
   or driven by the simulator's in-process bus, without dragging a real broker in.

2. **Where do the physical limits of motion live?** ADR-030 said actuators "act",
   but did not pin down whether a device may decide *how fast* its motion happens.
   If a device animates its own movement (eases an angle over N ticks, assumes a
   move completes this instant), that assumption is baked into device logic and will
   be **wrong on real hardware**, where a motor has its own acceleration, top speed,
   and may jam against an endstop or stall against a load.

Both are the same realisation: **everything a device touches is a provider.** This
ADR names the two families and states the rule that keeps actuators honest.

## Decision

### 1. Two families of provider

- **World providers** — sense and act on the physical world. `CameraProvider`
  (sense); `MotorActuator`, `SwitchActuator`, and the forthcoming `TurntableActuator`,
  `LinkActuator`, and crane payload seam (act). Backed by the simulator now, by
  OpenCV / GPIO / motor drivers later.
- **Platform providers** — the device ↔ core link. A single injected interface
  (a *repository* for the device's view of core): publish an event, subscribe to
  commands / clearance, register the device's capabilities. Backed by the real MQTT
  broker client in production, by an in-process aedes broker in tests, by the
  simulator's in-process bus in the toy table. **A device never constructs its own
  transport** — it is handed a platform provider, exactly as it is handed a camera.

A device is therefore fully described by the providers it is wired from: some world
providers + one platform provider. Nothing else crosses its boundary.

### 2. Actuators model physical reality; devices command intent

A **world actuator owns the physics of its own motion.** Acceleration, top speed,
and travel-limit endstops are properties of the (virtual or real) motor, enforced by
the actuator and the world — **never animated by the device.**

A device expresses **intent** — "go to position B", "forward", "raise the span",
"slew to 40°" — and then *observes and awaits the physical result* through its
providers. It must cope with the consequences it does not control:

- the motion **takes time** (it is not instantaneous);
- it can **jam at an endstop** (a commanded move past a physical limit is clamped);
- it can be **blocked, stalled, or collided** (a load too heavy, an obstacle, a
  contending mover).

There is **no device-side speed, easing, or animation**, and no reading of simulator
ground truth to short-circuit perception. This is precisely what lets one controller
run unchanged against a simulated motor and a real GPIO motor: the device never
assumed *how fast*, or *whether*, the motion would succeed — it commanded an intent
and watched.

The crane gantry already embodies this — `devices/crane.ts` gives each axis an
acceleration, a top speed, and endstops, and the `YardController` waits for the head
to physically arrive before it wedges. The train motor embodies it — the world's
dynamics (`a = netPower/mass − DRAG·v − …`) decide the speed, not the `TrainDevice`.
The `TurntableActuator` (rotation has an angular acceleration and rate, and a train
aboard rides it) and the `LinkActuator` (a span takes time to raise) **must** be
built the same way.

## Consequences

- **Portability holds all the way to core.** A device is now testable headlessly
  (platform provider = in-process broker), drivable by the simulator (platform
  provider = sim bus), and deployable (platform provider = MQTT) with no change to
  device logic.
- **Honesty is enforced structurally.** A device cannot cheat by animating an
  instant move or by reading the simulator's internal state — it only has intents
  out and observations in. Bugs that would only appear on real hardware (a move that
  takes longer than assumed, an endstop, a stall) appear in the simulator too.
- **The device ↔ core seam becomes mockable** the same way the world seam is, which
  removes the last reason a device test would stand up a real broker.
- **Cost:** more interfaces and a little more wiring ceremony per device; a device
  must be handed its providers rather than reaching for globals.

## Plan

1. Define the `PlatformProvider` (working name) interface — publish / subscribe /
   register — and back it with (a) the existing MQTT client, (b) an in-process bus
   for the simulator/toy table, (c) the test broker.
2. Audit existing world actuators for honesty; ensure the `TurntableActuator` and
   `LinkActuator` are built with real motion limits from the start (per §2).
3. Migrate the experimental devices to receive both families of provider as they are
   ported to controllers (turntable first, then crane-cargo, lift-bridge, vision).

The turntable (a capacity-1 opaque zone) and the dock crane are the first devices to
be wired provider-native from both families; they are the proving ground for this
ADR.
