# ADR-032: Nested capacity territories (recursive opaque zones)

## Status

Proposed (drafted 2026-06-11). Builds on [ADR-026](026-delegated-capacity-territory.md)
(delegated capacity territory), [ADR-027](027-zone-interior-handoff.md) (zone
interior handoff), and [ADR-031](031-provider-boundary-platform-and-honest-actuators.md)
(the provider boundary).

## Context

ADR-026 established the **opaque zone**: a device owns a capacity-limited
territory; core sees only a boundary marker, a capacity, and the device's own
**asserted occupancy** — the interior is the device's business, because core cannot
compute it (a slot may be locked by a cut of carriages with no loco, and carriages
are invisible to core, ADR-016).

We now have two concrete zones built on the ADR-030 physics model:

- the **railyard** — capacity-N, interior maneuver = shunting;
- the **turntable** — capacity-1, interior maneuver = rotate (± a 180° facing flip).

A natural and desirable composition then appears: a **depot / roundhouse** — a
capacity-N zone whose *interior* is organised around a central **turntable** (a
capacity-1 zone). A train is admitted to the depot, the depot drives the turntable
to turn or route it to a stall, and it later leaves. The question this ADR answers:
**how does a zone-within-a-zone work without core ever needing to know the inner
one exists?**

## Decision

**Opacity is relative to an observer, and a device's "core" is simply whoever
provides its platform link (ADR-031).** Nesting falls straight out of that.

- **Core** sees the outer zone (the depot) as one boundary marker + a capacity + one
  asserted occupancy. It does not see the turntable, the stalls, or the carriages.
- **The outer device** (depot) sees its interior and orchestrates it, driving the
  inner turntable **as a sub-device through the same provider seams** any device uses
  for an actuator — and answering the turntable's clearance/occupancy as if it were
  core.
- **The inner device** (turntable) sees only its own deck. Its controller is
  *identical* to the standalone one; the only difference is what its **platform
  provider** points at.

The mechanism is ADR-031's platform provider: **a nested zone's platform provider is
its parent, not the broker.** The turntable inside a depot asks the *depot* for
clearance and reports occupancy to the *depot*; the depot is "core-shaped" to it.

Rules:

1. **Report upward, never sideways to core.** A nested zone requests clearance from
   and reports occupancy to its **parent only** — never directly to core.
2. **The parent rolls up.** The parent folds its children's occupancy into its **own
   single asserted occupancy**, which it reports to *its* parent (or to core if it is
   outermost). Core still sees one number for the outer boundary, whatever the
   interior nesting.
3. **The clearance seam just chains.** Admission and egress at every boundary are the
   same ADR-026 clearance seam; nesting links them: `core → depot → turntable`.
4. **No new protocol.** It is `core.gates_zone` / `gates_clearance` + asserted
   occupancy + the platform-provider indirection of ADR-031. Recursion to arbitrary
   depth needs nothing more.

Interior boundary markers (the turntable's own boundary) are *interior* to the depot
— core never sees them; the parent maps them within its own territory.

## Consequences

- **Composability with zero protocol cost.** Zones nest to arbitrary depth. A depot
  is just a capacity-N zone whose interior maneuver happens to include driving a
  capacity-1 turntable; a hump yard could contain sub-yards; and so on.
- **Core stays trivial.** It only ever sees the outermost boundary + one occupancy
  number, regardless of how deep the interior goes. The complexity is pushed to the
  device that chose to own a territory — exactly where ADR-026 put it.
- **The parent bears the orchestration.** It must (a) implement the platform-provider
  interface *toward its children* (be core-shaped), (b) roll child occupancy up
  correctly, and (c) gate its own admission so it never exceeds capacity given live
  interior state — including a turntable that locks a stall while it is mid-rotation.
- **Open problems inherit downward.** Interior contention / deadlock within a nested
  territory is the parent's problem, the same unresolved question the railyard's
  interior already has (conflict-resolution policy). Nesting does not create it, but
  it does mean a parent must reason about a child that can be *busy* (the turntable
  mid-turn), not just full.
- **Testing** is unchanged in shape: drive the depot through events at its boundary,
  observe the single occupancy it asserts to core, and assert interior correctness
  (which stall, which facing) through the simulator.

## Relationship

ADR-026 is the zone; ADR-031 is the enabler (parent-as-core via the platform
provider); ADR-027 is the interior handoff at a boundary. The **turntable**
(`devices/turntable-*`, `physics/turntable.ts`) is the canonical inner zone this ADR
is grounded in; a depot/roundhouse device wrapping it would be the first concrete
two-level nesting to build.
