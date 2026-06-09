# ADR-028: Cyclic schedules resume through a zone stop

## Status

Accepted — **implemented** (no protocol change). A pure scheduler refinement on
top of [ADR-027](027-zone-interior-handoff.md): when a zone-suspended train is
released, if it is running a cyclic schedule whose *current* stop is that zone,
the scheduler advances the schedule and plans the next leg itself — the train
keeps cycling without any external re-assignment. One-line change in
`handleZoneTrainReleased` (`scheduler.ts`); crossing tests in `scheduler.test.ts`
and the end-to-end loop in `railyard-swap-loop.test.ts`.

Builds on:

- [ADR-010](010-routes-as-schedules-of-stops.md) — a schedule is an ordered list
  of stops the train cycles through indefinitely; the scheduler already plans it
  leg-by-leg, advancing `current_stop_index` mod `stops.length` at each stop.
- [ADR-027](027-zone-interior-handoff.md) — entry-suspend / exit-reclaim. This
  ADR is what happens to a *scheduled* train at exit-reclaim.

## Context

ADR-027 defines a zone *entry* as an admitted train reaching the boundary as its
route **terminus**. On release it is reclaimed at the throat and "resumes normal
scheduling" — but in the original implementation that meant it simply parked,
awaiting a *new* route from the operator. That is fine for a one-off ("send this
train into the yard"), but it breaks the headline use we actually want: a fleet
**continuously cycling** through a railyard that re-works each train's consist on
every visit (`docs/experimental/006-railyard.md`).

The obstacle is real and was surfaced during design: a train cannot sit on one
static cyclic route that passes *through* the yard and still trigger the handoff,
because at a through-waypoint the boundary is not a terminus, so entry never
fires (ADR-027 §2). Two ways out were considered:

1. **An external controller** subscribes to `zone_train_released` and assigns
   each train's next leg via the operator API. Works with zero core change, but
   makes "keep looping" an out-of-band script rather than the train's own
   standing intent — and it fights the project's "routes are cycles" model:
   every lap becomes a re-assigned one-shot, not one cyclic schedule.
2. **The scheduler resumes the cycle itself** (this ADR). The operator assigns
   one cyclic schedule that simply *names the yard as one of its stops*; the
   scheduler suspends there (ADR-027 entry already fires, because each leg is
   planned stop-to-stop, so the current leg *does* terminate at the yard) and,
   on release, advances to the next stop and plans onward — exactly as it does
   when a station dwell expires.

## Decision

A zone stop in a cyclic schedule is a **suspend-and-resume** waypoint.

On `zone_train_released` for train `T` at zone marker `Z`:

- If `T` has a schedule and `stops[current_stop_index] === Z` — the train was
  cycling and the yard *is* its current target stop — clear `in_zone` and call
  the same `advanceScheduleAndReplan` the dwell-expiry path uses: advance the
  pointer (mod `stops.length`) and plan the leg from `Z` to the next stop,
  emitting the `assign_route` + initial clearance. The train drives out and
  carries on round its loop.
- Otherwise (no schedule, or the yard is not the current target — a one-off
  route into the yard) keep ADR-027's original behaviour: clear `in_zone`, retry
  blocked peers, and leave the train parked at the throat awaiting a new route.

Nothing else in ADR-027 changes. In particular the **exit is still core-cleared**:
the onward leg is granted through the ordinary horizon under block exclusivity
(ADR-011), so a peer holding the block beyond the throat still holds the released
train at `Z`. The device never drives a train across the boundary — it only
*released* it; the scheduler decides when it may move. The reverse-admission gate
(ADR-027) is untouched: the next stop after the yard is a normal marker, so the
gate does not re-fire on the way out.

## Consequences

- **Routes stay cycles.** The operator expresses "loop forever, calling at the
  yard each lap" as a single cyclic schedule with the yard among its stops — no
  N-lap unrolling, no per-lap re-assignment, no side-car controller. This is the
  project's standing preference, honoured rather than papered over.
- **The yard stop reads like a station that takes longer.** A normal stop dwells
  a fixed time then resumes; a yard stop suspends until the device releases it
  then resumes. Same shape, same `advanceScheduleAndReplan` exit — the only
  difference is *what* ends the pause (a clock vs. a device assertion).
- **The park branch is a defensive fallback.** Because ADR-010 schedules cycle
  indefinitely, a train that suspended at a yard always reached it as the current
  stop of a live schedule, so in practice the resume branch is the one that
  fires. The "no schedule" branch covers only the corner where a train's schedule
  was cleared while it sat inside (then it parks at the throat, reclaimed,
  awaiting a fresh route) — the guard keeps that case from misrouting rather than
  encoding a separate user-facing "one-off" intent.
- **No protocol or wire change.** Entry already fired for a cyclic yard stop
  (legs are planned stop-to-stop); only the *exit* branch learned to resume. The
  change is a few lines and carries its own crossing tests.

## Alternatives considered

- **External re-assignment controller (option 1 above).** Rejected: pushes the
  loop's intent out of the train and into a script, and unrolls cycles into
  one-shots — the opposite of the routing model. It remains available to anyone
  who *wants* per-lap operator control, since the one-off behaviour is unchanged.
- **A dedicated "yard waypoint" stop kind in the schema.** Rejected as
  over-modelling: the scheduler already knows a stop is a zone (the
  `zoneBoundaries` registry from ADR-026), so it can treat a zone stop specially
  with no new wire shape. Keeping the schedule a plain list of marker ids keeps
  ADR-010 intact.
