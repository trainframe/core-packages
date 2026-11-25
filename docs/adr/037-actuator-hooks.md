# ADR-037: Junction actuation through capability hooks

## Status

Accepted. Implemented in `@trainframe/core`. No wire protocol change.

## Context

[ADR-001](001-capability-based-extensibility.md) holds that a built-in capability has no privileged path: whatever a built-in needs, a satellite can do the same. `core.controls_switch` broke that rule. Its capability had no hooks, and the scheduler did the work itself: it read `controls_marker_id` and `valid_positions` out of the registration of any device declaring `core.controls_switch`, kept the requested position and the unconfirmed-request timer per junction, sent `set_switch_position`, and handled `switch_state_changed` in a dedicated branch.

So a satellite actuator (a turntable, a traverser, a three-way point driven by a different command) could not take part. It had no way to tell the scheduler which junction it serves, no way to be asked to move it, and no way to report that it had.

The hook surface also lacked any notion of time. The re-send of an unanswered command needs a clock, and hooks must stay pure (no `Date.now`).

## Decision

Split switch handling along the line between deciding and applying. The capability decides what to say to its hardware and when; the scheduler owns the layout and applies what capabilities report.

**Capability side (public hook surface):**

- `onEvent` also receives `device_registered`, after the scheduler has recorded the device. This is where an actuator reads its own registration fields and binds its junction. Capabilities that ignore unknown event types are unaffected
- `onActuationRequest(state, { device_id, junction_marker_id, position, now_ms })` returns `{ newState, intents }`. The scheduler calls it on every capability of the device bound to a junction whenever a waiting train needs that junction at `position`. It is called again on every clearance retry while the train waits, so it owns its own idempotency
- `isActuationOverdue(state, { now_ms })` returns a boolean. The scheduler polls it whenever a train reports `train_status`; a true answer retries blocked clearances, which re-asks `onActuationRequest`
- Two intents: `bind_junction { junction_marker_id, valid_positions? }` and `report_switch_position { junction_marker_id, position, confirmed }`

`now_ms` comes from the scheduler's injected clock, so a hook is still a pure function of its arguments. It is passed only to the two actuation hooks. `onEvent` does not get it, because nothing in it needs time yet and adding a field later is not breaking.

**Scheduler side (not reachable by capabilities):**

- Applying `bind_junction`: the zone ownership refusal of [ADR-034](034-zone-owned-marker-declaration.md), then the pairing and the junction record of [ADR-035](035-device-onboarding-and-pairing.md)
- Applying `report_switch_position`: the unknown-marker anomaly, the retained `switches` state, and for a confirmed position, adopting it into the layout and retrying blocked clearances
- Deciding that an edge needs the points moved, and withholding clearance until they are

`core.controls_switch` is now an ordinary capability on this surface. Its state is the requested position per junction and, while unconfirmed, when it was sent; `SWITCH_ACTUATION_TIMEOUT_MS` lives with it. A satellite builds the same thing with its own command, event and timeout; `packages/core/src/scheduler/actuator-hooks.test.ts` does exactly that with a turntable.

### Alternatives considered

- **A dedicated `onRegister` hook** for binding. Rejected: `device_registered` is an event, and `onEvent` already has the right shape for it.
- **`now_ms` on every hook context.** Rejected for now as unneeded surface; see above.
- **The capability re-sends on a timer tick of its own** instead of being re-asked. Rejected: a resend should happen only while a train is still waiting for that junction, and only the scheduler knows that. The overdue query plus re-ask keeps that decision where the knowledge is.
- **Capabilities mutate the layout directly** (pass them a layout handle). Rejected: hooks would no longer be pure, and the zone ownership check would have to be trusted to every satellite.

## Consequences

- A satellite actuator needs no core change: declare a capability, bind from registration, implement `onActuationRequest`, report through `report_switch_position`
- Breaking for satellites only in that `onEvent` now sees `device_registered`. A hook that treats every event it does not recognise as its own would misbehave; the documented pattern is to ignore unknown event types
- `switch_state_changed` reaches the scheduler only through a capability, so it is adopted only from a registered device that declares one reporting it (`core.controls_switch` or a satellite). A report from an unregistered or undeclared device is ignored, as `gate_state_changed` already is
- The re-send anomaly is raised through `emit_anomaly`, so it now carries `context.source_device_id`
- What a device asked for lives in its capability state, so forgetting the device drops it with no separate bookkeeping; the scheduler only drops the junction binding
