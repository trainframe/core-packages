# Experimental device 006: Railyard (delegated capacity-territory)

**Status:** viability test, now **partially built** — it has graduated to a core
mechanism. The admission/capacity seam it proves is specified in
[ADR-026](../adr/026-delegated-capacity-territory.md) and implemented
(`core.gates_zone` + `zone_state_changed` + `VirtualRailyard`); the opaque-interior
maneuvering remains the hand-wave. Still not something a typical setup has.

**Proves:** that a device can own a **capacity-limited territory** and gate
admission to it by its **own asserted occupancy** — a fact core *cannot* compute,
because a slot can be locked by a cut of carriages with no locomotive and
carriages are invisible to core (ADR-016). Occupancy joins train length (ADR-023)
and tag bindings (ADR-007) as a third *asserted, capability-gated, no-oracle*
fact. If a routed train holds at a full yard's throat and is admitted the instant
a slot frees — through nothing but the existing clearance-consultation veto — the
"delegated territory" model holds end-to-end.

## What it is

A railyard: a fan of N sidings off a single **lead** (the working track), with one
**throat** where the lead meets the main line. A train enters with carriages, is
separated, shuffles on the lead, re-couples with different carriages waiting on
another siding, and leaves — all choreographed by the device, inside its own
territory. To the rest of the system the yard is one **boundary marker** with a
capacity; what happens past it is the device's business.

This is the device the decoupler ([004](004-wedge-decoupler.md)) needed: 004
proves the atomic length-decrease; the railyard is the *territory* that contains
the back-and-forth shunting 004 deliberately parked.

## Capabilities it declares

- `core.gates_zone` (ADR-026) — owns a zone behind a boundary marker and gates
  admission to it by asserted occupancy.
- It would also use `core.reports_length` (ADR-023) to reconcile a train's length
  on exit, and interior movement authority (ADR-015/ADR-022 primitives) once the
  opaque-interior handoff is built.

## API events and data it acts on

- **Emits** `zone_state_changed { zone_marker_id, capacity, occupancy }` whenever
  its occupancy changes — a consist parks or leaves, or a siding is locked by
  carriages alone. This is the load-bearing fact; everything else is interior.
- **Gates** admission through the `core.gates_zone` capability's
  `onClearanceConsultation`: a `deny` vote on any train whose proposed clearance
  limit is the `zone_marker_id` while `occupancy >= capacity`. A denied train
  holds at the throat; the scheduler's existing `retryBlockedClearances` admits it
  automatically when the device next asserts a lower occupancy. **No scheduler
  change** — the same deny-and-hold cycle a gate uses.
- **Emits nothing about carriages, slots, or maneuvers.** Which siding, the
  coupling, the shuffle order — none of it crosses the wire. Core sees a capacity
  count and (on exit) a scalar length, exactly as ADR-016/023 intend.

## Action-oriented goal

Admit a train only when the yard has room *by the device's reckoning*, take it in,
rearrange its carriages, and let it back out — while telling core only how full
the yard is and how long the train is when it leaves.

## How the held state is guaranteed (the cross-cutting question)

The railyard sits on both sides of the held-state question this log keeps
returning to. At the **boundary** it holds trains *out* (like the bridge,
[005](005-lift-bridge.md)) by denying admission while full. In the **interior** it
holds and moves trains under its own authority (like the crane/decoupler hold a
train *in*). The discipline that keeps interior safety tractable is **single-lead**:
only one train moves at a time on the lead; parked consists are stationary and
cannot collide. Interior safety thus reduces to core's own one-mover rule, applied
privately by the device — capacity (how many *park*, N slots) stays independent of
concurrency (how many *move*, which is one).

## Visible goal

A real operator should see a **busy yard that turns trains away when full**: a
train approaches a full railyard and **waits at the throat**; sidings hold parked
consists; when one consist pulls out, the waiting train rolls in. Inside, the lead
does the back-and-forth — a loco drawing carriages out, propelling them onto
another siding, coupling up — one move at a time. The capacity is legible from the
table: full yard → train waits; slot frees → train enters.

## Toy-box element & animation

- **Shape:** the largest toy-box element — a wooden multi-track fan (the sidings)
  meeting a single lead at a throat, drawn in the same beech material as track
  (ADR-024), since it *is* track. A small manufactured (non-wood) control cabin
  marks the device itself and carries the **occupancy readout** (e.g. N pips, lit
  per filled slot) so "how full" is readable at a glance.
- **Animation:** two registers. At the **throat**, a waiting train and an
  admit/deny state (the lead's mouth open or barred). On the **lead**, the
  single-mover shuffle — a loco easing back and forth, a carriage detaching
  ([004]'s wedge) and re-coupling, parked consists sliding into and out of
  sidings. Only one thing moves on the lead at once, which is also what makes the
  animation legible rather than chaotic.
- **Hand-wave:** the *interior choreography* — which siding, the coupling
  mechanics, the move sequencing — is modelled in the simulator at the
  wire-faithful level (the device emits real occupancy facts) but is not a solved
  planner; the full opaque-interior transit handoff is ADR-026 future work.

## What's built, and what proves it

Two seams are implemented and tested end-to-end through a real broker +
scheduler (`packages/integration/src/zone-admission.test.ts`): **admission** — a
`VirtualRailyard` (scalable to N slots) asserts occupancy, and a routed train
holds at the throat of a full yard and is admitted when a slot frees, via the
`core.gates_zone` consultation veto and the existing retry machinery; and
**length reconcile on exit** — the yard reports a train out at a different length
via `core.reports_length` (ADR-023, now built), and the scheduler updates it. The
"yard swallows length X, emits length Y" headline is real. The remaining hand-wave
is the *interior maneuvering itself* (the single-lead shuffle driving interior
markers under the device's authority), which needs the opaque-interior transit
handoff — ADR-026 future work.

## Why it's experimental, not the norm

- Almost no layout has a working yard; this is the most elaborate set-piece in the
  log.
- Its value was as proof, and it paid off by *graduating*: the dialogue around it
  surfaced a general core concept (delegated capacity-territory, ADR-026) that
  generalises block exclusivity (ADR-011) from a capacity-1 mutex core computes to
  a capacity-N semaphore the device asserts. The railyard is that ADR's end-to-end
  proof — the vision-station ([001](001-vision-length-station.md)) ↔ ADR-023
  pattern, repeated.

## Open questions (for the someday-session that finishes it)

- **The opaque-interior transit handoff.** Core formally suspending its management
  of a *tracked* train inside the yard, and the device issuing that train's
  interior movement authority — the genuinely new core surface ADR-026 defers.
- **Multi-occupant interior concurrency.** Single-lead is the accepted default;
  concurrent leads would need the device to run an internal scheduler.
- **Capacity advertisement to the planner.** `ZoneRetainedState` is defined so a
  planner could avoid routing toward a full yard rather than stalling at the
  throat; consuming it is a later refinement.
- **Where it lives.** A satellite device (e.g. `trainframe/railyard`) declaring
  `core.gates_zone` (+ `core.reports_length` for exits). Core gains the *mechanism*
  (ADR-026); it never learns what a "railyard" is.
