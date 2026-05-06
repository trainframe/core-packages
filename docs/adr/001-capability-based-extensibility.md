# ADR-001: Capability-based extensibility

## Status

Accepted.

## Context

The platform aims to let third parties build new device types without modifying core code. Two obvious approaches were considered:

1. **Closed device-type enum.** Server defines a fixed set of device types (`TRAIN`, `SIGNAL`, `STATION`, `SWITCH`); third parties open PRs to add new ones. Simple, but every new device idea requires a server change and a release.

2. **Pure topic namespacing.** Devices publish whatever events they like on namespaced topics; the server is event-agnostic. Maximally open, but the scheduler can't reason about new device types: it has no way to know that "this device gates clearance" or "this device controls a switch."

Neither was right. The first kills the open ecosystem; the second prevents the platform from offering anything useful beyond a message bus.

## Decision

Devices declare *capabilities* on registration, not types. A capability is a contract: a set of events the device may emit, commands it must accept, scheduler hooks it may participate in. The scheduler reasons in terms of capabilities, never device classes.

Built-in capabilities (`gates_clearance`, `controls_motion`, etc.) are implemented through the same public API third-party capabilities use. Capabilities are values in a runtime registry; the server's startup composes the registry from built-ins plus any satellite packages the operator wants.

Capability state is generic per capability. The registry stores capabilities behind an existential wrapper (`RegisteredCapability`) that hides State variance, allowing heterogeneous capabilities to coexist without `any`.

## Consequences

- A third party can ship a new device type entirely outside the core repo. Define a `Capability<State>`, register it with the platform, ship the device firmware. No PR.
- The scheduler is small and general: it consults capabilities, aggregates votes, executes intents. It contains no device-specific logic.
- Some kinds of behaviour are hard to express. A capability that needs to influence route *planning* (rather than just clearance) doesn't fit the current hook surface. We accept this; the open question can be resolved by adding hook surface as needed.
- The capability hook signature is the platform's most important API. Changes are breaking. We version the protocol carefully.
- Built-in capabilities have no privileged path. If a built-in needs something, every satellite can do the same thing. This is the correctness check.
