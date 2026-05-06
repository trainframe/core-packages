# ADR-002: Clearance-based train control

## Status

Accepted.

## Context

We needed a model for how the server controls trains. Two patterns were considered:

1. **Imperative commands.** The server tells trains "stop now," "start now," "set speed 50%." Trains are dumb; the server orchestrates. Familiar from RC toys.

2. **Movement authorities (the railway pattern).** The server grants trains permission to occupy specific track segments up to a limit; trains are autonomous within that authority. This is how real railways work (ETCS, PTC). The default state is *stopped*; movement requires an active grant.

The first pattern has a fatal property: every train action depends on a network round-trip. A flaky connection means a train rolls past its station. Fail-safe behaviour requires the server to constantly affirm "you may continue," which is fragile.

## Decision

Trains receive *clearances*: permissions to occupy a sequence of edges up to a named limit marker. A train without clearance does not move. Trains request clearance extensions as they approach their limit. The server may grant, withhold, or revoke.

Block exclusivity falls out of the model: the server will not extend a clearance into an edge already cleared to another train.

Devices with `gates_clearance` may *also* withhold clearance at markers they gate. A station gates the platform marker for a dwell time; a crane-gated station gates it until the crane reports payload-dropped. From the train's perspective, both look identical: stop, wait, eventually proceed.

## Consequences

- Default behaviour is safe. A train with a stale or missing clearance stops. Network failures degrade to safe states.
- The crane-gated station example becomes trivial: it's a `gates_clearance` device with custom logic for when to grant. No special-casing in the scheduler.
- Trains need to be autonomous: they execute their route, request clearance, brake at limits. This is more firmware than dumb-train designs but pays back in robustness.
- The protocol is more verbose than imperative-command equivalents. Every meaningful state change is an explicit clearance grant or withholding.
- We inherit the conceptual model of real railways, including its standard failure modes and recovery patterns. This is a good thing.
