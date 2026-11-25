import type { DeviceTable } from './devices.js';
import { type SchedulerEffect, clearanceStateEffect, effects } from './effects.js';
import type { ClearanceRetry, TransitPlanning } from './seams.js';
import type { TrainRoster } from './train-roster.js';
import type { TrainState } from './train-state.js';
import { type EdgeRef, edgesEqual } from './types.js';

/**
 * Bringing a registered train onto the map (ADR-036). A train is never routed
 * or cleared until its position and heading vector resolve, by a two-marker
 * roll, a `core.provides_train_heading` zone, an operator-supplied vector, or
 * two ordinary consecutive crossings. A vector that would co-occupy a peer's
 * block is refused.
 */
export class TrainIntroduction {
  constructor(
    private readonly devices: Pick<DeviceTable, 'declares' | 'stateEffect'>,
    private readonly trains: Pick<TrainRoster, 'get' | 'values'>,
    private readonly clearance: ClearanceRetry,
    private readonly schedules: TransitPlanning,
  ) {}

  // ---------- train introduction (ADR-036) ----------

  /**
   * Begin vector resolution for a registered-but-not-introduced train. The
   * operator calls this when they have placed a loco at a known-safe location.
   * This emits `introduce_train` to the train (authorising the bounded
   * introduction roll) and sets `introducing = true`. No-op when the train is
   * unknown or already introduced.
   *
   * Returns effects (empty on no-op). Mirrors the shape of `assignSchedule`.
   */
  introduceTrain(trainId: string): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];
    if (train.introduced) return [];
    /* Already mid-roll: a second call must not restart the roll or re-send the
     * command (which would re-arm the device while it is already rolling). */
    if (train.introducing) return [];

    train.introducing = true;
    train.introduction_first_marker_id = undefined;

    return [effects.sendCommand(trainId, 'introduce_train', {})];
  }

  /**
   * ADR-036 §3c — operator/placer-provided vector introduction. When whatever
   * places a train already knows its facing (the simulator, a scene composer,
   * or an operator who set the loco down a known way), the placer supplies the
   * vector directly. No roll, no zone — the train is introduced immediately
   * with the given heading edge.
   *
   * `headingEdge.from_marker_id` is where the train sits; `to_marker_id` is
   * the direction it is committed to. Both markers must already exist in the
   * layout; the caller is responsible for that precondition (the server's
   * operator-command path checks this by virtue of passing an EdgeRef from a
   * validated protocol envelope).
   *
   * No-op (`[]`) if the train is unknown or already introduced — idempotent,
   * mirrors `introduceTrain`.
   */
  introduceTrainWithVector(trainId: string, headingEdge: EdgeRef): ReadonlyArray<SchedulerEffect> {
    const train = this.trains.get(trainId);
    if (!train) return [];
    if (train.introduced) return [];
    return this.resolve(train, headingEdge.from_marker_id, headingEdge, 'operator');
  }

  /**
   * Handle a marker crossed during the two-marker introduction roll (ADR-036
   * §3a). On the first crossing: record the marker. On the second DISTINCT
   * crossing: resolve the heading, end the roll, emit `train_introduced`, and
   * run resolution (schedule start / conflict check).
   *
   * Re-reading the same marker (the train hasn't moved) is ignored — we wait for
   * a genuinely distinct second marker.
   */
  handleRollMarker(train: TrainState, markerId: string): ReadonlyArray<SchedulerEffect> {
    if (!train.introduction_first_marker_id) {
      /* First crossing of the roll — anchor the origin marker. */
      train.introduction_first_marker_id = markerId;
      return [];
    }

    /* Re-read of the same marker: the train hasn't moved yet — ignore. */
    if (train.introduction_first_marker_id === markerId) return [];

    /* Second distinct crossing — heading resolved. */
    const headingEdge = {
      from_marker_id: train.introduction_first_marker_id,
      to_marker_id: markerId,
    };
    return this.resolve(train, markerId, headingEdge, 'roll');
  }

  /**
   * Handle an inbound `train_introduced` event emitted by a
   * `core.provides_train_heading` zone before it releases the train (ADR-036
   * §3b). Honoured ONLY when the emitting device declared that capability — a
   * device without it cannot hijack a train's vector. If the named train exists
   * and is not yet introduced, resolve its vector from the event payload.
   *
   * Idempotent: if the train is already introduced, this is a no-op — so the
   * core's OWN roll-path emission echoing back onto the bus does nothing (and it
   * is harmless that the echo is dropped on the authority check too, since the
   * roll path set the train's state directly before publishing).
   */
  handleTrainIntroducedEvent(deviceId: string, payload: unknown): ReadonlyArray<SchedulerEffect> {
    /* Producer-authority gate (mirrors `core.assigns_tags`/`core.reports_length`):
     * only a device that declared `core.provides_train_heading` may supply a
     * train's vector. */
    if (!this.devices.declares(deviceId, 'core.provides_train_heading')) return [];

    const { train_id, marker_id, heading_edge } = payload as {
      train_id: string;
      marker_id: string;
      heading_edge: { from_marker_id: string; to_marker_id: string };
    };

    const train = this.trains.get(train_id);
    if (!train) return [];

    /* Idempotent: already introduced (e.g. our own emission echoing back). */
    if (train.introduced) return [];

    return this.resolve(train, marker_id, heading_edge, 'zone');
  }

  /**
   * Shared resolution step for all introduction paths. Sets the train's position
   * and heading, marks it introduced, updates retained state, then applies the
   * ADR-036 §5 safety check before starting any pending schedule.
   *
   * `source` controls which wire effects are emitted and whether an idle train
   * seeds occupancy:
   *   'roll'       — sends `revoke_clearance` (ends the §3a roll) and publishes
   *                  `train_introduced`. An idle (no-schedule) train seeds its
   *                  resolved block as occupancy (it has STOPPED there).
   *   'zone'       — neither command nor event: the zone device owns the release
   *                  and its OWN `train_introduced` was the incoming trigger. An
   *                  idle train seeds its resolved block (it rests at the throat).
   *   'operator'   — publishes `train_introduced` but does NOT `revoke_clearance`
   *                  (the train was stationary, never granted a roll clearance).
   *                  An idle train seeds its resolved block.
   *   'discovered' — the vector was established by ordinary MOVING traversal
   *                  (exploration / learn driving), not a dedicated introduce
   *                  gesture. Publishes `train_introduced` but NEITHER stops the
   *                  train (it is moving on) NOR seeds occupancy: a moving train's
   *                  block protection comes from its clearance GRANTS, not a seed,
   *                  and seeding the behind-the-head edge would orphan exactly as
   *                  the earlier auto-start bug. §5 + pending-schedule start still apply.
   */
  resolve(
    train: TrainState,
    markerId: string,
    headingEdge: { from_marker_id: string; to_marker_id: string },
    source: 'roll' | 'zone' | 'operator' | 'discovered',
  ): ReadonlyArray<SchedulerEffect> {
    train.introducing = undefined;
    train.introduction_first_marker_id = undefined;

    /* ADR-036 §5 conflict check, BEFORE the vector is committed: is the train
     * resolving into a block an active peer occupies? See `findIntroductionConflict`. */
    const conflictingTrain = this.findIntroductionConflict(train, markerId, headingEdge);
    if (conflictingTrain !== undefined) {
      return this.refuseConflictingIntroduction(train, conflictingTrain, headingEdge, source);
    }

    /* Commit the resolved vector. Any block held from an earlier refused
     * introduction is stale: the train has a fresh, safe vector now. */
    train.current_edge = headingEdge;
    train.last_marker_id = markerId;
    train.introduced = true;
    train.cleared_edges = [];

    const out: SchedulerEffect[] = [];

    /* The roll path owns the release (ADR-036 §3a): end the roll by stopping the
     * train on the wire, AND publish the resolved vector as `train_introduced`.
     * The zone path needs neither — the zone device controls the train's motion
     * until it releases, and its OWN `train_introduced` was the incoming trigger
     * (re-emitting would duplicate it).
     * The operator and discovered paths publish `train_introduced` so bus
     * subscribers learn the resolved vector, but do NOT send `revoke_clearance`:
     * the operator path's train was stationary (never granted a roll clearance),
     * and the discovered path's train is MOVING (exploring / about to be
     * scheduled) — there is nothing to stop. */
    if (source === 'roll') {
      out.push(
        effects.sendCommand(train.train_id, 'revoke_clearance', {
          reason: 'introduction_complete',
          immediate: true,
        }),
      );
    }
    if (source !== 'zone') {
      out.push(
        effects.publishEvent('train_introduced', {
          train_id: train.train_id,
          marker_id: markerId,
          heading_edge: headingEdge,
        }),
      );
    }

    /* Update the retained device state to carry `introduced: true`. */
    out.push(this.devices.stateEffect(train.train_id, train));

    /* No co-occupation. What protects the resolved block from a peer differs by
     * whether a schedule is waiting and whether the train is STOPPED or MOVING:
     *
     *  - PENDING SCHEDULE → start it now. `planAndExecuteCurrentTransit` plans
     *    the leg and grants the first horizon, which establishes occupancy from
     *    the PLANNED edges and is released normally as the train drives. We must
     *    NOT seed `headingEdge` here: it is the block BEHIND the head (the train
     *    already crossed `headingEdge.to_marker_id` to resolve), so the point-train
     *    release rule — which drops a held edge only when the train re-crosses
     *    that edge's END marker — would never release it. Since this path does not
     *    wipe `cleared_edges` (unlike `assignSchedule`), a seeded `headingEdge`
     *    would orphan and permanently lock the introduction section. The planned
     *    grant alone is the correct, self-releasing occupancy.
     *
     *  - NO SCHEDULE, train STOPPED at the resolved point ('roll'/'zone'/'operator')
     *    → seed `headingEdge` as occupancy so a peer approaching is excluded under
     *    block exclusivity (ADR-011, Scenario 6). The train holds this block
     *    without onward motion clearance; it cannot orphan because `assignSchedule`
     *    wipes `cleared_edges` when a schedule eventually arrives.
     *
     *  - NO SCHEDULE, train MOVING ('discovered') → do NOT seed. The train is
     *    rolling on (exploring); its block protection comes from its clearance
     *    GRANTS, not a seed, and seeding the behind-the-head edge would orphan
     *    exactly as the auto-start bug. It simply continues; a later schedule
     *    routes it normally. */
    if (train.schedule) {
      out.push(...this.schedules.planAndExecuteCurrentTransit(train));
    } else if (source !== 'discovered') {
      train.clearance_limit_marker_id = headingEdge.to_marker_id;
      if (!train.cleared_edges.some((e) => edgesEqual(e, headingEdge))) {
        train.cleared_edges = [...train.cleared_edges, headingEdge];
      }
      out.push(clearanceStateEffect(train));
    }
    out.push(...this.clearance.retryBlockedClearances());
    return out;
  }

  /**
   * ADR-036 §5 refusal of an unsafe vector. The train resolved into a block a
   * peer occupies, so the resolution is not accepted: the train stays off the
   * map (not introduced, no position committed, so the operator can introduce
   * it again once a train has been moved) and its pending schedule does not
   * start. It is still physically on the track, so its resolved block is held
   * as occupancy: block exclusivity keeps every other train out of it even after
   * the peer drives away. A rolling or exploring train is told to stop; a zone
   * owns its own train's motion and a placed train is already stationary.
   */
  private refuseConflictingIntroduction(
    train: TrainState,
    conflictingTrain: TrainState,
    headingEdge: EdgeRef,
    source: 'roll' | 'zone' | 'operator' | 'discovered',
  ): ReadonlyArray<SchedulerEffect> {
    train.cleared_edges = [headingEdge];
    const out: SchedulerEffect[] = [];
    if (source === 'roll' || source === 'discovered') {
      out.push(
        effects.sendCommand(train.train_id, 'revoke_clearance', {
          reason: 'introduction_conflict',
          immediate: true,
        }),
      );
    }
    out.push(
      effects.publishEvent('train_introduction_conflict', {
        train_id: train.train_id,
        conflicting_train_id: conflictingTrain.train_id,
        block_edge: headingEdge,
        reason: 'resolved vector co-occupies a block held by another train',
      }),
      clearanceStateEffect(train),
    );
    return out;
  }

  /**
   * ADR-036 §5 conflict detector. The train sits at `markerId` having resolved
   * onto `headingEdge`. A peer's held edge makes that unsafe when it is:
   *
   *  - the SAME undirected section (either orientation): co-occupation or head-on;
   *  - running INTO `markerId`: the peer's clearance ends exactly where the
   *    introduced train is standing, so under ADR-011 block exclusivity the two
   *    sections share that boundary marker with the peer approaching it.
   *
   * A peer edge that LEAVES `markerId`, or touches the other end of the resolved
   * block, is the resolvable trailing case (ADR §5 Scenario 4): one train simply
   * follows the other and ordinary block exclusivity holds the one behind.
   *
   * Every peer counts, introduced or not: a train whose own introduction was
   * refused still holds its resolved block as occupancy.
   *
   * Returns the first conflicting peer, or `undefined` if none.
   */
  private findIntroductionConflict(
    train: TrainState,
    markerId: string,
    headingEdge: EdgeRef,
  ): TrainState | undefined {
    for (const other of this.trains.values()) {
      if (other.train_id === train.train_id) continue;
      for (const held of other.cleared_edges) {
        const sameSection =
          held.from_marker_id === headingEdge.from_marker_id &&
          held.to_marker_id === headingEdge.to_marker_id;
        const headOn =
          held.from_marker_id === headingEdge.to_marker_id &&
          held.to_marker_id === headingEdge.from_marker_id;
        const approachingTrain = held.to_marker_id === markerId;
        if (sameSection || headOn || approachingTrain) return other;
      }
    }
    return undefined;
  }
}
