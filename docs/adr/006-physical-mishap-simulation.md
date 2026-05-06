# ADR-006: Physical-mishap simulation in the simulator

## Status

Accepted

## Context

The simulator already models nominal behaviour: trains accelerate, traverse markers in sequence, brake for clearance limits, and obey block exclusivity. Real model railways routinely fail in physical ways the protocol's logical model can't reason about by itself:

- **Overshoot.** A train brakes too late and rolls past its intended stop point, traversing a marker it didn't have clearance for.
- **Sensor miss.** A reader fails to detect the tag of a passing vehicle. The train moves on; the server still thinks the train is on the previous edge.
- **Derailment.** The train leaves the layout entirely. No further marker observations come from it.
- **Position loss.** The train is on the layout but the server has lost track of which edge it's on (uncertain after a sensor miss or a manual move).

These need to be testable in simulation so the scheduler and the visualiser can be exercised against realistic failure modes before any hardware exists. They also need to compose with the existing determinism guarantees (`SeededRandom`, `VirtualClock`) and the protocol's existing `anomaly` event.

`VirtualTrainConfig` already has `miss_rate` (sensor miss) and `stopping_noise` (mild stopping-point variation). Both are continuous knobs that perturb nominal behaviour. They don't yet fire anomalies; the operator has no visible signal that something went wrong.

## Decision

Mishaps are modelled as **stochastic perturbations of the train's existing physics, rolled by `SeededRandom` so they remain deterministic**, with each detected mishap emitting an `anomaly` event so the visualiser and scheduler can observe it.

### Mishap categories

Each is a separate knob on `VirtualTrainConfig`. Default zero (no mishaps); set per-test or per-operator-config.

| Knob              | Type      | Effect                                                                                                                  |
| ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `miss_rate`       | 0–1       | _(existing)_ Probability the train's reader fails to emit `tag_observed` for a marker it physically passed.             |
| `stopping_noise`  | ≥0        | _(existing)_ Multiplicative noise on the kinematic stopping distance. Kept; expresses "well-tuned but not perfect".     |
| `overshoot_rate`  | 0–1       | Probability that, when the train _should_ be braking for its clearance limit, the brake fails to engage on that tick.   |
| _(future)_        | _(future)_ | `derailment_rate` per traversal; shape: train stops emitting events and the layout reports it as off-track.            |

### Detection and signalling

Mishaps that affect the protocol-visible state of the world emit an `anomaly` event through the same path normal events flow:

```
{ event_type: 'anomaly',
  device_id: <train_id>,
  payload: { severity: 'warning' | 'error',
             description: 'overshoot at marker M3 by 12mm',
             context: { ... } } }
```

The `anomaly` event already exists in the protocol (`packages/protocol/src/events.ts`). The simulator just needs to emit it through `Simulation.captureEvent`.

### Implementation

Per-edge state on `VirtualTrain`:

- `overshoot_engaged_this_edge: boolean`: sticky after the first failed-brake roll on an edge, reset on edge transition. Once a brake has failed to engage, it stays failed for that edge. This models "the brake is broken right now" rather than "every tick is an independent coin flip" (which would be both unrealistic and hard to debug).

Algorithm:

1. In `maybeBrakeForClearanceLimit`, when the train _would_ engage the brake (stopping distance >= remaining distance), if `overshoot_engaged_this_edge` is unset, roll once: `overshoot_engaged_this_edge = random.bernoulli(overshoot_rate)`. If true, _skip_ setting `target_velocity_mm_s = 0` on this tick (and all subsequent ticks while the train is on this edge).
2. In `maybeCrossEdgeEnd`, when the train crosses the to-marker:
   - If `clearance_limit_marker_id === marker_id` _and_ `overshoot_engaged_this_edge` is true, the train has overshot. Park as usual at `edge_length_mm`, but emit an `anomaly` event before the regular `tag_observed` flow.
3. On any edge transition (`transitionToNextEdge`), reset `overshoot_engaged_this_edge` to false.

### Why a per-edge sticky flag, not a per-tick roll

A per-tick coin flip with `overshoot_rate = 0.5` would result in roughly half of all ticks failing; with 50ms ticks, the chance of stopping in any reasonable distance approaches one rapidly even for high "failure rates". The sticky model is closer to the mental model an operator has ("on this run, this train's brakes failed once") and gives stable, comprehensible outputs at moderate rates.

### Determinism

All rolls go through `SeededRandom`. Tests fix the seed and assert observable outcomes (which markers traversed, which anomalies fired). Live operator runs may use the system clock for the seed; the simulator-ui exposes seed configuration as a follow-up.

### Out of scope for this ADR

- **Derailment.** Requires the train to enter a state where it stops emitting `tag_observed` events at all and the layout reports it as off-track. The protocol's `train_status` event has a `error_state` field that's a natural home for this; the simulator-ui needs a "derailment" UI control. Defer until the in-browser simulator gets richer per-train controls.
- **Position loss recovery.** The protocol already supports tag→marker resolution at registration; how the server recovers when a train's position becomes uncertain mid-route is an open scheduler question (see "Open design questions" in CLAUDE.md). The simulator can produce the failure mode (via `miss_rate`) once that's resolved.
- **Mishap rate UI.** The first cut configures rates only via `VirtualTrainConfig` defaults and tests. Operator-facing knobs in the simulator-ui come once we have a "spawn train with config" form.

## Consequences

- **What it costs.** One new field on `VirtualTrainConfig`. ~30 lines in `virtual-train.ts`. One new test asserting that a seeded run with `overshoot_rate: 1` emits an anomaly. The protocol layer changes nothing; `anomaly` already exists.
- **What it enables.** The visualiser's event log will now show anomalies as the simulation progresses. Tests can pin specific failure modes via seed and rate. The scheduler can be tested against "train just overshot" scenarios. Future mishap categories slot into the same knob/anomaly pattern.
- **Future-compatibility.** Adding `derailment_rate` later follows the same shape: roll, set sticky state, emit anomaly. The ADR doesn't lock in derailment specifics, only the framing.
