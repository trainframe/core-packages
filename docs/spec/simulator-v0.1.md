# Simulator architecture, v0.1

The simulator is `@trainframe/simulator` (`packages/simulator/`). It is the physical world for tests, demos and the toy table: a physics engine plus device implementations that speak the protocol exactly as hardware would. The server, broker and visualiser are real and never know the difference.

This document describes what is built. See [ADR-030](../adr/030-device-provider-simulator-separation.md) and [ADR-031](../adr/031-provider-boundary-platform-and-honest-actuators.md) for the reasoning and [`docs/status.md`](../status.md) for gaps. The original design (a fault-injecting virtual-device simulator with seeded noise, virtual bridge and fault profiles) was replaced by the physics world in 4759ee6; the parts of that design that were never rebuilt are listed under "Not built".

## Goals and non-goals

**Goals**

- Run the full device-and-server protocol indistinguishably from hardware, from the server's point of view
- Keep devices honest: a device perceives and acts only through provider interfaces, so the same device code could run on firmware
- Be deterministic: the same scenario yields the same events every run
- Be fast enough for hundreds of integration tests in CI

**Non-goals**

- Engineering-grade physical accuracy (no rolling friction or motor torque curves)
- Rendering: the toy table (`packages/simulator-ui`) and visualiser draw, the simulator is headless
- Replacing hardware-in-the-loop tests

## Layers

```
 device (ScheduledTrainDevice, GateDevice, SwitchDevice, zones, ...)
    │ senses and acts through WORLD providers      │ talks to core through the PLATFORM provider
    ▼                                               ▼
 PhysicsWorld (bodies on a RailNetwork)        mqttPlatform | inProcessPlatform | EspNowPlatform
                                                    │
                                              broker ──► @trainframe/server (scheduler)
```

- **Physics world** (`physics/world.ts`): `PhysicsWorld` steps bodies along a `RailNetwork` (`physics/network.ts`, `physics/rail.ts`). Bodies are locos and carriages; switches and links can be thrown; bodies couple by proximity. Height layers give grade separation. `physics/network-from-pieces.ts` compiles real Brio-style track pieces (`track/pieces.ts`) into a network
- **World providers** (ADR-030): a device senses through a sensor and acts through an actuator. `sim/marker-sensor.ts`, `sim/motor-actuator.ts` and `sim/switch-actuator.ts` bind those interfaces to a `PhysicsWorld`. A camera provider (`sensors/camera-provider.ts`) backs the vision station
- **Platform provider** (ADR-031, `devices/platform-provider.ts`): the single device-to-core seam, with `register`, `publish`, `onCommand` and an optional `commission` for the pairing lifecycle. A device imports only this interface. Backings are `mqttPlatform` (`broker/mqtt-platform.ts`), an in-process bus (`inProcessPlatform`), a parent controller (`platformFor`, nested zones) and `EspNowPlatform` (`broker/espnow-platform.ts`, ADR-035)
- **Devices** (`devices/`): `ScheduledTrainDevice`, `GateDevice`, `SwitchDevice`, `BeaconDevice`, the zone devices (`YardZoneDevice`, `DepotController`) and the experimental devices from `docs/experimental/`. Each registers through `registerDevice` (`devices/registerable-device.ts`)

The in-memory broker (`broker/in-memory-client.ts`) dispatches synchronously, which is what makes step-driven tests complete and deterministic.

## Determinism

The simulator has no seeded random source and no noise model. Determinism comes from:

- A fixed 60 Hz physics step (`world.step(dt)`)
- An injected clock: devices take an `EnvelopeSource` (`envelope-source.ts`, `newId` and `now`), and the server takes `now`. `startPhysicsEnv` wires all of them to one virtual clock, and `advance(ms)` steps the world, the devices and the scheduler together
- No wall-clock or `Math.random` reads in core, in the simulator or in device logic: `envelope.ts` validates every envelope through one adapter, and `deterministicEnvelopeSource` gives tests reproducible ids. The real sources (`wallClockEnvelopeSource` in the toy table's entry point, and the defaults in `server` and `gate-device`) live only at the composition edge

Tests never sleep. They call `env.advance(ms)` and assert.

## Test harness: `startPhysicsEnv`

`@trainframe/simulator/physics-env.js` exports `startPhysicsEnv(scene)`. It wires a real `@trainframe/server` to a real in-memory broker and populates it with real physics devices on a real `PhysicsWorld`. Nothing is mocked.

```typescript
const env = startPhysicsEnv(scene);   // scene = { net, layout, markers, segmentLayer? }
env.spawnTrain('T1', { atMarker: 'M1' });          // ScheduledTrainDevice, introduced by default
env.spawnGate('GATE-A', { markers: ['M3'] });      // GateDevice
env.spawnSwitch('SW1', { junctionMarkerId, switchLabel, positions });
env.assignSchedule('T1', ['M1', 'M3']);
env.advance(4000);                                  // ms of virtual time
env.commandsFor('T1');                              // commands the scheduler sent
env.eventsOfType('train_status');                   // captured events
env.world.bodies();                                 // physical poses
env.server.injectEvent('device_disconnected', 'GATE-A', {});
env.shutdown();
```

`straightLoop(markers, { spacingMm, name })` builds the cheap default scene: markers on one straight rail closed into a loop. A test needing junctions passes any `RailNetwork` with a matching `Layout`. Pass `introduced: false` to `spawnTrain` to exercise the introduction lifecycle (ADR-036) with `env.introduceTrain(...)`.

### A real test

From `packages/integration/src/multi-gate-clearance.test.ts` (ADR-018: two gates on one marker are conjunctive):

```typescript
import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const buildScene = () =>
  straightLoop(
    [
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'block_boundary' },
      { id: 'M4', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'multi-gate-clearance' },
  );

let env: PhysicsEnv;
beforeEach(() => {
  env = startPhysicsEnv(buildScene());
});
afterEach(() => {
  env.shutdown();
});

const grants = (limit?: string) =>
  env
    .commandsFor('T1')
    .filter(
      (c) =>
        c.command_type === 'grant_clearance' &&
        (limit === undefined || c.payload.limit_marker_id === limit),
    );

it('two gates on M3: train held until BOTH release', () => {
  const gateA = env.spawnGate('GATE-A', { markers: ['M3'] });
  const gateB = env.spawnGate('GATE-B', { markers: ['M3'] });
  gateA.hold('M3', 'gate A reason');
  gateB.hold('M3', 'gate B reason');

  env.spawnTrain('T1', { atMarker: 'M1' });
  env.assignSchedule('T1', ['M1', 'M3']);
  env.advance(4000);
  expect(grants('M3')).toHaveLength(0);

  gateA.release('M3');
  env.advance(2000);
  expect(grants('M3')).toHaveLength(0); // GATE-B still vetoes

  gateB.release('M3');
  env.advance(4000);
  expect(grants('M3').length).toBeGreaterThanOrEqual(1);
});
```

## Layout and topology

A scene pairs the physics network with the logical `Layout` the server consumes (the same schema as `packages/protocol/src/layout.ts`). Markers carry a world position so the marker sensor can fire `tag_observed` when a body crosses them. `physics/scene-markers.ts` (`sceneToLayout`) derives a `Layout` from a physics scene, and `track/layout-from-pieces.ts` does so for hand-built pieces.

## Extensibility

A third-party device is a class that takes a `PlatformProvider` (and, if it touches the world, sensor and actuator interfaces) and registers itself with `registerDevice`. It needs no change to the simulator. `startPhysicsEnv` exposes the broker as `env.client`, so a custom device is wired the same way `spawnGate` wires `GateDevice`:

```typescript
const device = new GateDevice(deviceId, {
  platform: mqttPlatform(env.client, deviceId, { newId, now: nowIso }),
  markers,
});
device.start();
```

A satellite capability (a `Capability<State>` with hooks) is registered on the server side through `ServerOptions.extraCapabilities`. See [new-capability.md](../contributing/new-capability.md).

## Visualiser and toy-table integration

The toy table (`packages/simulator-ui`) runs a `PhysicsWorld` in the browser. `sim/toy-hardware.ts` rebuilds the network when the operator edits track and runs one device per live piece, each on its own `mqttPlatform`, against a real server. The visualiser subscribes to the broker and cannot tell the toy table from hardware. A running server is required: devices publish events, only the server turns them into the retained state the visualiser reads (`pnpm dev:stack`).

## Not built

- Sensor noise (miss, double read, spurious read, latency jitter) and stopping-distance noise
- Mishaps (overshoot, derailment) from [ADR-006](../adr/006-physical-mishap-simulation.md)
- A virtual bridge with frame loss, reorder and latency (`EspNowLink` models the radio segment for pairing only)
- Named fault profiles
- A registry for third-party virtual capabilities or an `attachDevice` harness call
- Realtime and accelerated clock modes in the package (the toy table drives the world from `requestAnimationFrame`)

## Open questions

- Record and replay: capture an event stream from hardware and replay it in the simulator
- Whether to reintroduce a seeded random source for noise and mishap injection
- Persistence of simulator state across runs
