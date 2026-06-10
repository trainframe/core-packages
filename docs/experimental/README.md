# Experimental devices

A log of speculative, viability-test device ideas — devices whose point is to
**prove a seam in the protocol works**, not to be something an average setup is
expected to have.

These are not roadmap commitments and not normative. A satellite author or the
core team might build one to demonstrate that the capability model can carry a
given fact or behaviour end-to-end; a typical layout will not include it. The
test is "does the *protocol interaction* hold up?" — so an experimental device is
allowed to hand-wave its hardware or algorithms (assume a sensor or model we
have not built), as long as everything it puts on the wire is real and uses only
the public capability seams a built-in would.

Each entry specs one device: what it is, which existing capabilities it declares,
the single thing it proves, and the hand-waves it's allowed. If an idea outgrows
"viability test" and becomes a thing the system should genuinely support, it
graduates to an ADR and/or a satellite repo and leaves this log.

## The guiding principle: API-possible, not build-realistic

Every device here is judged by one question — **does the protocol already support
the action?** — *not* by how hard the hardware would be to build. The point is to
stress-test the capability model with hypothetically plausible devices someone
could end up wiring into trainframe, so the hardware (a vision model, a crate
crane, a coupling wedge, a lifting span) is allowed to be hand-waved. What is
**not** hand-waved is the wire: everything a device puts on the bus must be real
and use only the public capability seams a built-in would. A good entry often
proves a *negative* — that a whole category of physical behaviour needs **no new
wire surface** — which is exactly the extensibility promise these logs exist to
test.

## The "Experiments" box in the toy-box tray

Conceptually, these devices live together in an **"Experiments" box** in the
simulator-ui parts tray — a third group alongside *Track* and *Devices*. It is the
shared home for speculative, viability-test pieces, kept visually and
organisationally apart from the staples an ordinary layout uses, so an operator
reaching for one knows they are picking up a stress-test, not a standard part.

The box is **built but untested** (June 2026): 001, 002, 003 and 005 are real
`TrackPieceType`s in the ADR-024 workshop style, presented in an "Experiments"
tray group derived from the piece registry (`TOYBOX_TRAYS` in
`packages/simulator-ui/src/track/pieces.ts`) — automated suites cover them,
but none has yet been exercised in a real operator session against a live
server. 004 (the wedge decoupler) ships no piece — it was superseded by the
railyard (006), whose wedge unit owns the coupling-split job. Each built piece carries the wire identity its entry
declares — and nothing else — and they all move on the table: the lift
bridge's leaf lifts (foreshortening toward its hinge over the opening gap) as
its gate withholds; the turntable's bridge swings inside its recessed pit to
the confirmed switch position; the crane works crates between its trackside
stack and the wagon under its hook, pinning the train with a clearance pulse
and putting nothing cargo-specific on the wire; the vision station's LED
lights while a train is measured (and its `VLS-` identity really asserts
`train_length_changed` from the consist it observes). Per-entry build status
is noted under each doc's **Status** line.

## What every entry must cover

Beyond "what it is / capabilities / proves / hand-waves", each design doc should
describe, so the device is specified as a *thing a user interacts with* and not
just a wire contract:

1. **The API events and data it acts on** — what it reads off the bus and what it
   emits, named concretely, so the "does the protocol support this?" claim is
   checkable.
2. **The action-oriented goal** — the one physical thing the device is *for*,
   stated as an action.
3. **The visible goal** — what a real user should *see* when the device acts.
   Cause and effect should be readable from the table without status text.
4. **The toy-box element's visual style** — and, off the back of the visible
   goal, how its tray piece looks and especially how it **animates and moves**
   (these devices are defined as much by motion as by shape).

Where relevant, an entry should also address the cross-cutting **held-state**
question: a physical-action device needs the train in a known, held state before
it acts (present-and-held for the crane/decoupler; absent-and-held-out for the
bridge). The honest answer is usually `core.gates_clearance`, not a dwell timer.

| #                                          | Device                | Proves                                                                              | Builds on               |
| ------------------------------------------ | --------------------- | ----------------------------------------------------------------------------------- | ----------------------- |
| [001](001-vision-length-station.md)        | Vision length station | A device other than the train can report and change `train_length_mm` at runtime    | ADR-023, ADR-007        |
| [002](002-turntable-junction.md)           | Turntable junction    | The switch seam is already N-way; a 3-way junction needs no core change, only a piece | switch seam (`layout.ts`/`layout-state.ts`) |
| [003](003-crane-cargo-station.md)          | Crane cargo station   | A device manipulates a train's payload via dwell + identity + clearance, payload stays out of core | ADR-016, ADR-007 |
| [004](004-wedge-decoupler.md)              | Wedge decoupler       | The decrease direction of ADR-023 (**superseded by 006** — the railyard's wedge owns the split) | ADR-023, ADR-007 |
| [005](005-lift-bridge.md)                  | Lift bridge           | `core.gates_clearance` carries *physical track availability*, not just traffic policy | ADR-018 (gates)         |
| [006](006-railyard.md)                     | Railyard              | A device owns a capacity-territory and gates admission by its own asserted occupancy (**graduated → ADR-026, partly built**) | ADR-026, ADR-016, ADR-023 |
