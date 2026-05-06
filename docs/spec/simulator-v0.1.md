# Simulator architecture, Working Draft v0.1

The simulator is the most leveraged piece of the system. It validates the protocol before any hardware exists, runs the integration test suite, drives the visualiser during development, and lets third-party device authors test their devices without a physical layout.

This document covers what the simulator does, how it's structured, what it models, and the API it exposes for tests and tooling.

## Goals and non-goals

**Goals:**

- Run the full server-and-device protocol indistinguishably from a hardware-backed system, from the server's perspective.
- Model physical phenomena (motion, sensor noise, bridge fragmentation, latency) realistically enough that tests catch real-world bugs.
- Provide a deterministic test environment where the same scenario produces the same outcome every run.
- Support extensibility: third-party capabilities must work in simulation as easily as built-ins.
- Be fast enough to run thousands of integration tests in CI in reasonable time.

**Non-goals:**

- Physical accuracy in the engineering sense (we are not modelling rolling friction or motor torque curves).
- Visual fidelity: the visualiser handles rendering; the simulator is headless.
- Replacing hardware-in-the-loop tests for production validation. The simulator finds protocol bugs; HIL tests find hardware bugs.

## Architectural overview

The simulator runs as a process (or in-process module) that hosts a population of virtual devices and orchestrates their interaction with the rest of the system. Critically: **the simulator does not contain the broker, server, or visualiser**. It is one MQTT client among others.

```
┌─────────────────┐       ┌─────────────┐       ┌──────────────────┐
│  Virtual ESP32  │──┐    │             │       │                  │
├─────────────────┤  │    │             │       │   @trainframe/   │
│  Virtual ESP32  │──┼───▶│   Virtual   │──────▶│      server      │
├─────────────────┤  │    │   bridge    │ MQTT  │  (scheduler,     │
│  Virtual train  │──┘    │             │       │   clearance,     │
│  (WiFi-direct)  │──────────────────────▶      │   layout state)  │
└─────────────────┘            MQTT             └──────────────────┘
                                                         ▲
                                                         │ MQTT
                                                ┌────────┴────────┐
                                                │   Visualiser    │
                                                └─────────────────┘
```

A virtual bridge in the simulator does exactly what a physical bridge would: ESP-NOW frames in, MQTT messages out, and vice versa. Trains (which use WiFi directly) connect to the broker as MQTT clients without a bridge. The server, broker, and visualiser are all real. Only the device population is virtual.

This means the simulator does not "simulate the system." It simulates *devices*. The system itself runs.

## Deterministic core

Every random process in the simulator is seeded. Given the same seed, the same scenario produces the same events in the same order. This is non-negotiable for test reliability.

Sources of nondeterminism that must be controlled:

- Tag detection noise (miss rate, double reads, detection delay)
- Train physics noise (stopping distance variation, speed control jitter)
- ESP-NOW frame loss and reordering
- Bridge processing latency
- Battery drain rates (where modelled)

The simulator exposes a `Random` interface that all virtual devices use. In tests, the seed is fixed; in interactive runs (e.g. driving the visualiser during development), it can be `Math.random()`.

Time is also controlled. The simulator runs on a virtual clock that can be:

- **Real-time**: for interactive use with the visualiser.
- **Accelerated**: for fast-forwarding scenarios (10x, 100x).
- **Step-driven**: for deterministic tests, where the test advances the clock explicitly.

Step-driven mode is critical: tests assert "after the train has had 5 seconds to react" by advancing the clock 5 seconds, not by `await sleep(5000)`. This makes tests fast and fully deterministic.

## Virtual device model

A virtual device is an object implementing the same interface a real device firmware would target, minus the physical I/O.

```typescript
interface VirtualDevice {
  readonly device_id: string;
  readonly capabilities: Capability[];
  readonly manifest: DeviceManifest;

  // Lifecycle
  start(transport: VirtualTransport): Promise<void>;
  stop(): Promise<void>;

  // Driven by the simulator's tick loop
  tick(now: VirtualTime, dt: number): void;
}
```

The transport abstraction is the key extensibility point. A virtual device doesn't know whether its messages go out via WiFi-direct MQTT or via an ESP-NOW bridge; it calls `transport.publishEvent()` and `transport.onCommand()`. The simulator wires up the right transport per device.

Two transport implementations:

- **WiFiTransport**: direct MQTT client. Used for trains. Models WiFi-realistic latency (5–30 ms typical, occasional 200 ms+ jitter) and very rare disconnects.
- **EspNowTransport**: fragments outbound messages into 250-byte frames, sends them to a virtual bridge with configurable per-frame loss/delay. The bridge reassembles and republishes on MQTT. Inbound commands are received over MQTT by the bridge and forwarded as ESP-NOW frames.

Both transports honour the deterministic random source. Both can be configured with fault profiles (described below).

## Virtual trains

The most physics-heavy virtual device. State:

- Current edge (or null if not on the layout)
- Distance from edge start (mm)
- Velocity (mm/s)
- Target velocity (set by `set_target_speed` commands)
- Acceleration profile (configurable; default: linear ramp)
- Current route, route progress index
- Current clearance limit
- A list of upcoming markers it expects to pass on its current edge

Each tick:

1. Update velocity toward target (acceleration * dt, clamped).
2. Update position (velocity * dt).
3. If position has crossed any markers on the current edge, generate `tag_observed` events with realistic timing.
4. If position has reached the edge's end marker, transition to the next edge in the route.
5. If the clearance limit is approaching, decide whether to brake (based on stopping distance estimate).

The braking logic is deliberately simple. The train knows its current speed and approximate stopping distance and starts braking when it estimates it'll stop within 5 cm of the limit marker. This is the same algorithm a real train would use; replicating it in simulation means braking-related bugs surface in both environments.

Stopping distance noise: actual stopping distance = nominal * (1 + N(0, σ²)) where σ is a configured noise factor. Tests can raise σ to exercise overshoot/undershoot handling.

## Virtual sensors and tag observation

A virtual train carries virtual readers. When the train's position crosses a marker, the reader generates a `tag_observed` event.

Detection model:

- **Read latency**: the event is delayed by `N(20ms, 5ms)` from the actual crossing.
- **Miss rate**: each crossing has probability `p_miss` of generating no event.
- **Double-read rate**: each crossing has probability `p_double` of generating two events.
- **Spurious read rate**: at any time, probability of a fake event with random tag ID, configurable.

These default to small but nonzero values (1% miss, 0.5% double, near-zero spurious). Tests that exercise robust handling can crank them up.

## Virtual bridge

The bridge is itself a virtual device, but a special one: it has a population of "downstream" devices and translates between them and MQTT.

Bridge behaviour:

- Maintains an MQTT connection on behalf of each downstream device, using their device_id as the message origin.
- Translates outbound MQTT commands for downstream devices into ESP-NOW frames, fragmenting if needed.
- Receives ESP-NOW frames from downstream devices, reassembles, validates, publishes to MQTT.

Bridge fault injection (simulator config):

- Frame loss rate (per direction)
- Frame reorder probability
- Reassembly buffer size (frames are dropped if a fragmented message can't be completed within N frames)
- Bridge-side processing latency
- Bridge crash and recovery (rare, but tests should cover the case)

The fault profile is per-bridge, so tests can simulate a flaky bridge in one corner of the layout while another is fine.

## Layout and topology

The simulator loads a layout JSON describing markers, edges, junctions, and initial positions. Example:

```json
{
  "name": "simple-loop-with-station",
  "markers": [
    { "id": "M1", "kind": "block_boundary", "x": 0, "y": 0 },
    { "id": "M2", "kind": "junction", "x": 200, "y": 0 },
    { "id": "M3", "kind": "station_stop", "x": 400, "y": 0 },
    { "id": "M4", "kind": "block_boundary", "x": 400, "y": 200 },
    { "id": "M5", "kind": "block_boundary", "x": 0, "y": 200 }
  ],
  "edges": [
    { "from": "M1", "to": "M2", "length_mm": 200 },
    { "from": "M2", "to": "M3", "length_mm": 200, "requires_switch_state": "main" },
    { "from": "M2", "to": "M5", "length_mm": 280, "requires_switch_state": "diverge" },
    { "from": "M3", "to": "M4", "length_mm": 200 },
    { "from": "M4", "to": "M5", "length_mm": 400 },
    { "from": "M5", "to": "M1", "length_mm": 200 }
  ],
  "junctions": [
    { "marker_id": "M2", "initial_state": "main" }
  ]
}
```

This is the same format the server consumes for layout state. The simulator uses it for physics (knowing where markers are, how long edges are) and for spawning virtual switches at junction markers.

## Extensibility

A virtual device implementing a non-core capability must work without simulator changes. The mechanism is the same as the server's: capabilities are values, registered at startup, with handlers.

The simulator package exports `registerVirtualCapability()`. A satellite package can ship a virtual implementation of its capability alongside its real device:

```typescript
// in @alice/trainframe-turntable/simulator
import { registerVirtualCapability } from '@trainframe/simulator';
import { TurntableCapability } from './capability';

registerVirtualCapability(TurntableCapability, {
  createVirtualDevice: (config) => new VirtualTurntable(config),
  // …
});
```

Tests in the satellite repo import both `@trainframe/simulator/testing` and their own virtual capability:

```typescript
import { startTestEnvironment } from '@trainframe/simulator/testing';
import '@alice/trainframe-turntable/simulator'; // self-registers

const env = await startTestEnvironment({
  layout: 'fixtures/yard-with-turntable.json',
  capabilities: ['controls_turntable'], // require this capability
});
```

The simulator does not need to know what a turntable is. It loads the registered capability, instantiates the virtual device the satellite provides, and runs.

## Fault profiles

A fault profile is a named bundle of simulator configuration. Tests select one. Three built-ins:

- `pristine`: no noise, no losses, no jitter. Used for pure protocol logic tests where physical realism is a distraction.
- `realistic`: small noise (1% miss rate, 5 ms latency stdev, 0.5% bridge frame loss). Used for most tests.
- `hostile`: large noise (10% miss rate, 30 ms latency stdev, 5% bridge frame loss, occasional bridge restarts). Used for resilience tests.

Custom profiles compose these primitives:

```typescript
const env = await startTestEnvironment({
  layout: 'fixtures/figure8.json',
  faults: {
    bridges: { 'bridge-A': { frame_loss: 0.05 } },
    trains: { 'T1': { stopping_distance_noise: 0.2 } },
  },
});
```

## Testing harness API

`@trainframe/simulator/testing` exports a high-level test environment API. The shape:

```typescript
const env = await startTestEnvironment({
  layout: 'fixtures/figure8.json',
  faults: 'realistic',
  seed: 12345,
  timeMode: 'step', // or 'realtime' for visualiser-driven dev
});

// Spawn devices
const train = await env.spawnTrain('T1', { startEdge: { from: 'M1', to: 'M2' } });
const station = await env.spawnGate('STATION_A', { holdUntil: 'manual' });

// Or attach a real device implementation (e.g. for testing your own device)
const myDevice = await env.attachDevice({
  manifestPath: './manifest.json',
  entryPath: './src/index.ts',
  env: { GATED_MARKER_IDS: 'M3' },
});

// Issue commands via the server (which then commands devices)
await env.assignRoute('T1', [['M1','M2'], ['M2','M3'], ['M3','M4']]);

// Advance virtual time
await env.advance({ ms: 2000 });

// Or wait for an event (returns once the event arrives or a timeout fires)
await env.waitForEvent({
  event_type: 'marker_traversed',
  matching: { train_id: 'T1', marker_id: 'M3' },
  timeoutMs: 5000,
});

// High-level assertions
await env.expectTrainStopped('T1', { atMarker: 'M3' });
await env.expectClearanceLimit('T1', 'M3');

// Inspect state
const state = await env.getServerState();
expect(state.trains.T1.clearance_block_reason).toBe('device_gated');

// Test-side gate control
station.release();
await env.expectTrainMoving('T1');

await env.shutdown();
```

The harness manages the broker, server, and simulator lifecycle. Each test gets a clean instance. Suite-level setup can share a broker across tests if isolation isn't needed (faster), but the default is full isolation.

Critical design decision: **the test does not mock the server, broker, or simulator**. They are all real. The test interacts with the system the same way a developer would. This is the Kent Dodds trust-the-system approach, and it's why the test suite is the strongest safety net.

## Visualiser integration

In `realtime` mode, the simulator runs continuously, emitting events at wall-clock pace. The visualiser, running as a separate process, subscribes to MQTT and renders. Developers can interact with the visualiser (spawn trains, assign routes, press virtual buttons) and the simulator responds.

The visualiser does not know it's connected to the simulator vs. real hardware. This is the key property: the same UI works for both, end to end.

## Performance targets

For unit-test-like integration tests in step-driven mode: under 100 ms per scenario for simple cases, under 1 s for complex multi-train scenarios. CI suite of 500 scenarios should complete in under 5 minutes.

In realtime mode for visualiser-driven dev: 60 simulator ticks per second, supporting up to 10 trains and 50 devices without dropping ticks.

## Open questions for v0.2

- The boundary between simulator and server when handling discovery-mode topology learning. The server is what learns; the simulator just generates events. But we should confirm the server's discovery code path is exercised by simulator scenarios.
- Whether to support layout reload in a running simulator (for the visualiser-driven workflow where you tweak the JSON and want to see the change). Probably yes, but it complicates state.
- Persistence of simulator state across runs: useful for some debugging workflows, but adds complexity. Default no, opt-in yes?
- Multi-process simulators: for very large layouts, distributing virtual devices across processes. Almost certainly v3+.
- A "record and replay" feature: capture an event stream from a real hardware run, replay it in the simulator. Hugely valuable for debugging once hardware exists. Worth designing the data model now even if implementation is later.

---

*End of v0.1.*
