import type { ClearanceControl } from './clearance.js';
import type { DeviceTable } from './devices.js';
import { type SchedulerEffect, effects } from './effects.js';
import type { LayoutState } from './layout-state.js';
import { planTransit } from './planner.js';
import type { ClearanceRetry } from './seams.js';
import type { TrainRoster } from './train-roster.js';
import type { TrainState } from './train-state.js';
import type { ZoneAuthority } from './zones.js';

/**
 * Deterministic dwell at a scheduled stop, in milliseconds. When a train
 * arrives at its scheduled stop the scheduler holds it (no onward clearance,
 * no pointer advance) until this much injected-clock time has elapsed, so
 * trains visibly pause at stations. A named constant, not a magic number.
 */
export const STATION_DWELL_MS = 2500;

/**
 * Running a train's schedule (ADR-010, ADR-028): assigning the stops, planning
 * each leg from where the train is, sending the route and its first horizon,
 * advancing along the transit as markers are crossed, and dwelling at a stop
 * before moving on to the next.
 */
export class ScheduleRunner {
  constructor(
    private readonly layout: LayoutState,
    private readonly trains: Pick<TrainRoster, 'get'>,
    private readonly devices: Pick<DeviceTable, 'declares'>,
    private readonly zones: Pick<ZoneAuthority, 'admissionRefusal'>,
    private readonly clearance: Pick<ClearanceControl, 'extendHorizon'>,
    private readonly retry: ClearanceRetry,
    private readonly now: () => number,
  ) {}

  // ---------- schedule assignment (driven by external API, not events) ----------

  /**
   * Assign a *schedule* — the operator-facing intent for a train. The
   * schedule is an ordered list of stops (marker IDs); the planner computes
   * the transit between consecutive stops on demand, and the scheduler emits
   * the per-leg `assign_route` command (carrying the computed transit) and
   * the initial clearance grant. See ADR-010.
   *
   * Cycle behaviour is implicit: after the last stop, the train heads back
   * to the first. There is no `cyclic` flag.
   *
   * Starting position: the train's `last_marker_id`, or — if the train has
   * never moved — `stops[0]` (the schedule's first stop is treated as the
   * spawn marker).
   *
   * Returns effects. Empty list on a no-op (unknown train, empty stops list,
   * train at the only stop of a single-stop schedule). Anomaly + no
   * execution effects on referential errors (unknown stops) or when the
   * planner can't reach the next stop from the current marker.
   */
  assignSchedule(
    trainId: string,
    routeId: string,
    stops: ReadonlyArray<string>,
  ): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];
    if (stops.length === 0) return [];

    const unknownStops = stops.filter((s) => !this.layout.hasMarker(s));
    if (unknownStops.length > 0) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Schedule ${routeId} for ${trainId} references unknown marker(s): ${unknownStops.join(', ')}`,
        }),
      ];
    }

    train.cleared_edges = [];
    train.transit = undefined;
    /* An explicit operator gesture (reassign) lifts any scheduler-owned hold:
     * the train is being given fresh intent, so a stale `unknown_topology` flag
     * must not ride the retained clearance state once it is cleared and moving
     * again (ADR-019). This is distinct from the train's own next traversal
     * report, which must NOT auto-clear the hold. The same gesture lifts an
     * operator revoke: a new schedule is the operator releasing the stop. */
    train.block_reason = undefined;
    train.operator_hold = undefined;

    /* ADR-036: a not-yet-introduced train has NO known position — its
     * `last_marker_id` must NOT be guessed from `stops[0]` (that is exactly the
     * position-guess the ADR forbids, and it would make the train's first real
     * crossing auto-introduce on a bogus heading). Store the schedule pending,
     * pointer at the first stop, leaving position unset. When the vector resolves
     * (roll / zone / operator / discovered) the planner picks the leg from the
     * train's REAL resolved marker, and the schedule auto-starts then. */
    if (!train.introduced) {
      train.schedule = { route_id: routeId, stops, current_stop_index: 0 };
      return [this.scheduleStateEffect(train)];
    }

    // Determine starting marker. The schedule's first stop is the
    // conventional spawn point for a train already on the map.
    const startMarker = train.last_marker_id ?? stops[0];
    if (startMarker === undefined) return [];
    train.last_marker_id = startMarker;

    // The schedule's pointer is "the stop we are heading to next."
    // Convention: if the train starts AT stops[0], the next target is
    // stops[1] (or wraps around for a single-stop schedule, handled below).
    const startsAtFirstStop = startMarker === stops[0];
    const initialStopIndex = startsAtFirstStop ? Math.min(1, stops.length - 1) : 0;
    train.schedule = {
      route_id: routeId,
      stops,
      current_stop_index: initialStopIndex,
    };

    return [this.scheduleStateEffect(train), ...this.planAndExecuteCurrentTransit(train)];
  }

  /**
   * Retained-state snapshot of the train's operator-facing schedule. The
   * payload mirrors `train.schedule`; subscribers (e.g. the visualiser's
   * schedule list) read which stops the train cycles through and which
   * stop it's currently heading to. Published from `assignSchedule` (when
   * the operator picks the stops) and `advanceScheduleAndReplan` (when
   * the train arrives at its current target and the pointer advances).
   */
  private scheduleStateEffect(train: TrainState): SchedulerEffect {
    if (!train.schedule) {
      return effects.updateState('schedule', train.train_id, { train_id: train.train_id });
    }
    return effects.updateState('schedule', train.train_id, {
      train_id: train.train_id,
      route_id: train.schedule.route_id,
      stops: train.schedule.stops,
      current_stop_index: train.schedule.current_stop_index,
    });
  }

  /**
   * Plan a transit from the train's current marker to
   * `schedule.stops[current_stop_index]`, install it on the train, and emit
   * the `assign_route` command + the initial clearance grant. Internal —
   * callers are `assignSchedule` (first leg) and `advanceScheduleAndReplan`
   * (every subsequent leg).
   */
  planAndExecuteCurrentTransit(train: TrainState): ReadonlyArray<SchedulerEffect> {
    /* ADR-036: a not-yet-introduced train has no known vector — never plan it.
     * The schedule may already be stored (held pending); it starts the instant
     * the vector resolves via `TrainIntroduction.resolve`. */
    if (!train.introduced) return [];
    if (!train.schedule || train.last_marker_id === undefined) return [];
    if (!this.devices.declares(train.train_id, 'core.accepts_route')) {
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Train ${train.train_id} cannot be sent route ${train.schedule.route_id} without core.accepts_route`,
        }),
      ];
    }
    const targetStop = train.schedule.stops[train.schedule.current_stop_index];
    if (targetStop === undefined) return [];

    if (train.last_marker_id === targetStop) {
      // Already at the target stop. If the schedule is multi-stop, advance
      // and replan to the next stop. If it's a single-stop schedule, park.
      if (train.schedule.stops.length === 1) {
        train.transit = undefined;
        train.clearance_limit_marker_id = train.last_marker_id;
        return [];
      }
      return this.advanceScheduleAndReplan(train);
    }

    // Keep the route directional: a train may not flip 180° to take a shortcut.
    // `current_edge` carries the heading mid-route; at a zone throat (edge
    // cleared) `zone_entry_edge` carries the arrival heading so the resume drives
    // the train onward, not back in.
    const heading = train.current_edge ?? train.zone_entry_edge;
    const transitEdges = planTransit(this.layout, train.last_marker_id, targetStop, heading);
    if (transitEdges === null) {
      // Structural unreachability. Surface and leave the train parked —
      // the operator must fix the layout or the schedule.
      return [
        effects.publishEvent('anomaly', {
          severity: 'warning',
          description: `Schedule ${train.schedule.route_id} for ${train.train_id}: no path from ${train.last_marker_id} to stop ${targetStop}`,
        }),
      ];
    }
    if (transitEdges.length === 0) {
      // planTransit only returns [] when from === to, which is the
      // already-at-target case handled above. Defensive.
      return [];
    }

    const refusal = this.zones.admissionRefusal(train, targetStop);
    if (refusal) return [refusal];

    train.transit = { edges: transitEdges, progress_index: 0 };
    const firstEdge = transitEdges[0];
    if (!firstEdge) return [];
    train.clearance_limit_marker_id = firstEdge.from_marker_id;

    const out: SchedulerEffect[] = [
      effects.sendCommand(train.train_id, 'assign_route', {
        route_id: train.schedule.route_id,
        edges: transitEdges,
      }),
    ];
    // Grant the whole initial horizon, not just the first edge, so a fresh
    // train pulls away with several blocks of clearance ahead of it.
    out.push(...this.clearance.extendHorizon(train));

    // Wiping cleared_edges in assignSchedule may have released blocks that
    // peer trains were waiting on. Retry so they don't sit blocked until an
    // unrelated event triggers retry elsewhere.
    out.push(...this.retry.retryBlockedClearances());
    return out;
  }

  /**
   * Move the schedule's stop pointer to the next stop (mod stops.length)
   * and replan a transit toward it. Called when the train arrives at the
   * current target stop.
   */
  advanceScheduleAndReplan(train: TrainState): ReadonlyArray<SchedulerEffect> {
    if (!train.schedule) return [];
    const nextIndex = (train.schedule.current_stop_index + 1) % train.schedule.stops.length;
    train.schedule = { ...train.schedule, current_stop_index: nextIndex };
    // Publish the updated schedule pointer so the visualiser's schedule
    // list highlights the new target stop.
    return [this.scheduleStateEffect(train), ...this.planAndExecuteCurrentTransit(train)];
  }

  /**
   * Advance the train's transit progress when it reports the to_marker of
   * the edge it's currently on. Idempotent: a marker that doesn't match the
   * current edge is a no-op.
   *
   * If the advance completes the transit AND the train has arrived at its
   * scheduled target stop, advance the schedule's stop pointer and replan
   * the next transit — emitting an `assign_route` command for the new
   * transit and an initial clearance grant. The returned effects flow
   * straight back to the caller.
   */
  advanceTransit(train: TrainState, markerId: string): ReadonlyArray<SchedulerEffect> {
    if (!train.transit) return [];
    const currentEdge = train.transit.edges[train.transit.progress_index];
    if (!currentEdge || currentEdge.to_marker_id !== markerId) return [];

    const newIndex = train.transit.progress_index + 1;
    train.transit = { ...train.transit, progress_index: newIndex };
    /* Advance the heading to the next edge while the transit is in progress; but
     * when it COMPLETES (no next edge) KEEP the arrival edge as the heading. The
     * heading is what `planAndExecuteCurrentTransit` feeds the planner to forbid a
     * 180° U-turn — wiping it to `undefined` here let a schedule WRAP (last stop →
     * first stop) plan the reverse shortcut on a bidirectional loop, so the train
     * was handed a route it can't drive (no `grant_reverse`) and parked at the
     * last stop instead of looping. Keeping the arrival heading makes the wrap
     * continue FORWARD around the loop. */
    train.current_edge = train.transit.edges[newIndex] ?? currentEdge;

    // Transit still in progress — caller continues with maybeExtendClearance
    // against the same transit.
    if (newIndex < train.transit.edges.length) return [];

    // Transit complete. If we've landed on the scheduled stop, begin the
    // deterministic dwell rather than replanning immediately: hold the train
    // here (no pointer advance, no onward grant) until the dwell elapses. The
    // expiry is observed on a later `train_status` (the parked train keeps
    // emitting status), which triggers `advanceScheduleAndReplan`.
    if (train.schedule && train.schedule.stops[train.schedule.current_stop_index] === markerId) {
      train.dwell_until = this.now() + STATION_DWELL_MS;
      return [];
    }

    return [];
  }

  /**
   * End a station dwell whose time has elapsed and move the train on to its
   * next stop. Undefined while the train is not dwelling or the dwell still
   * has time to run. Checked on every `train_status`, which a parked train
   * keeps emitting, so the expiry is reliably observed.
   */
  resumeIfDwellElapsed(train: TrainState): ReadonlyArray<SchedulerEffect> | undefined {
    if (train.dwell_until === undefined || this.now() < train.dwell_until) return undefined;
    train.dwell_until = undefined;
    return this.advanceScheduleAndReplan(train);
  }
}
