import type { LayoutState } from '@trainframe/core';
import type { VirtualClock } from './clock.js';
import type { SeededRandom } from './random.js';

interface RouteEdge {
  from_marker_id: string;
  to_marker_id: string;
}

/**
 * A dumb wagon coupled behind a train. Physical only: a carriage carries an id
 * and an opaque `colorId` (its livery, for presentation) and NOTHING crosses
 * the wire — the simulator models carriages because they are physical things,
 * but they are invisible to core (ADR-016). A railyard rearranges them
 * (`swapLeadingPair`); the toy-table renders them by colour so an individual
 * wagon stays trackable as it is shunted between trains.
 */
export interface VirtualCarriage {
  readonly id: string;
  /** Opaque livery label carried for the renderer; never emitted on the bus. */
  readonly colorId?: string;
}

export interface VirtualTrainConfig {
  /** Maximum velocity in mm/s. */
  max_velocity_mm_s: number;
  /** Acceleration in mm/s². */
  acceleration_mm_s2: number;
  /** Stopping distance noise factor (multiplicative, e.g. 0.1 = ±10%). */
  stopping_noise: number;
  /** Probability of missing a marker on traversal. */
  miss_rate: number;
  /** Detection latency in ms (mean, stddev). */
  detection_latency_ms: { mean: number; stddev: number };
  /**
   * Probability the brakes fail to engage when the train should be slowing for
   * its clearance limit. Rolled once per edge (sticky for that edge) — see
   * docs/adr/006-physical-mishap-simulation.md. When this fires the train
   * crosses the limit at speed and an `anomaly` event is emitted.
   */
  overshoot_rate: number;
  /**
   * Probability of a double-read on each marker crossing. When this fires, a
   * second `tag_observed` event for the same tag is emitted after an additional
   * latency of `N(10ms, 5ms)` on top of the primary read latency.
   */
  double_read_rate: number;
  /**
   * Per-tick probability of a spurious `tag_observed` event with a fabricated
   * tag ID (`spurious-<random 0-999999>`). Simulates a reader picking up an
   * unrelated or unknown tag, which triggers an `Unknown tag observed` anomaly
   * downstream. Default 0.
   */
  spurious_read_rate: number;
  /**
   * Interval at which the train emits `train_status` events while moving or
   * on-edge. Setting this to 0 disables emission (useful in unit tests that
   * don't care about position broadcasts). Default 250 ms - frequent enough
   * for smooth visualiser interpolation, sparse enough to not flood the bus.
   */
  train_status_interval_ms: number;
  /**
   * Physical length of the train in mm. Used by the scheduler to determine
   * when the tail has cleared a boundary (tail release). Default 0 means
   * the train is treated as a point mass (tail coincides with the head).
   */
  length_mm: number;
  /**
   * Whether the train's hardware can run backward (ADR-027). When true the train
   * declares `core.can_reverse` at registration, which the scheduler requires
   * before admitting it to a zone (a railyard, whose interior is worked by
   * shunting). Default false — many toy locos only run forward.
   */
  can_reverse: boolean;
}

export const DEFAULT_TRAIN_CONFIG: VirtualTrainConfig = {
  max_velocity_mm_s: 100, // 10 cm/s, slow toy speed
  acceleration_mm_s2: 200,
  stopping_noise: 0.05,
  miss_rate: 0.01,
  detection_latency_ms: { mean: 20, stddev: 5 },
  overshoot_rate: 0,
  double_read_rate: 0,
  spurious_read_rate: 0,
  train_status_interval_ms: 250,
  length_mm: 0,
  can_reverse: false,
};

interface TrainEvent {
  event_type: string;
  device_id: string;
  payload: unknown;
}

/* Maximum number of completed edges kept in traversal history. Older entries
   are dropped when this cap is exceeded. 32 edges covers even long trains on
   the shortest reasonable layouts. */
const MAX_TRAVERSAL_HISTORY = 32;

/* Track each coupled wagon takes up, mm — the pitch the toy-table renders rakes
   at, so a train's reported occupancy length matches what's drawn (and what core
   must keep clear behind the head). */
const CARRIAGE_OCCUPANCY_MM = 68;

/* Safety cap on how many graph edges `getTrailingPosition` will walk backwards
   when history runs out (a freshly-spawned train with a long rake). A real
   consist spans a couple of edges; this only stops a closed loop spinning on a
   pathological offset. */
const MAX_TRAILING_GRAPH_STEPS = 64;

/**
 * A virtual train that simulates motion along edges and emits tag_observed
 * events as it crosses markers.
 *
 * Driven by `tick(dt_ms)`. Emits events via an injected sink.
 */
export class VirtualTrain {
  private velocity_mm_s = 0;
  private target_velocity_mm_s = 0;
  private current_edge: RouteEdge | null = null;
  private distance_into_edge_mm = 0;
  private route: ReadonlyArray<RouteEdge> = [];
  private route_index = 0;
  private clearance_limit_marker_id: string | null = null;
  /* Once we've emitted the to_marker for the current edge, don't emit it
     again on subsequent ticks while parked. Reset on every edge transition. */
  private emitted_current_edge_end = false;
  /* Per-edge sticky flag for the overshoot mishap. Once the brake fails to
     engage on this edge, it stays failed until the train transitions to the
     next edge. See ADR-006. */
  private overshoot_engaged_this_edge = false;
  // Accumulator for the train_status emission cadence.
  private ms_since_status = 0;
  private route_id: string | null = null;
  private route_progress_edge_index = 0;
  /* Exploration mode (ADR-015): when true the train drives forward across
     markers indefinitely, choosing the next edge from its own layout (the
     physical rails) rather than a route, until released by revoke/emergency. */
  private exploring = false;
  /* Reverse authority (ADR-022): a bounded backward grant to break a closed
     standoff. When non-null the train is backing UP along the forward-oriented
     edges it holds, head-first edge first, to `reverse_target_marker_id`. Each
     entry is the edge currently being backed over; on reaching its from_marker
     the train emits a tag_observed and advances to the next backward edge, until
     the head reaches the target, then stops. Cleared by revoke/emergency or on
     arrival. Distinct from `exploring`: bounded, signed, scheduler-issued. */
  private reverse_edges: ReadonlyArray<RouteEdge> = [];
  private reverse_index = 0;
  private reverse_target_marker_id: string | null = null;
  /* Power state. A powered-off train is INERT (does not move; ignores
     commands) and SILENT (emits nothing, including any already-scheduled
     detection-latency callbacks). It stays physically on the track — its
     edge, distance, route, and clearance limit are all retained, frozen — so
     power-on resumes exactly where it stopped. This is distinct from despawn:
     a powered-off train remains in the simulation and never emits
     `device_disconnected`, so a server on the bus keeps its block reserved. */
  private powered = true;
  /* Ordered list of edges the head has fully traversed, oldest first.
     Capped at MAX_TRAVERSAL_HISTORY; oldest entry is dropped when the cap
     is exceeded. Physical fact — persists across route re-assignment.
     Starts empty at spawn; grows at each edge-transition site. */
  private readonly traversal_history: RouteEdge[] = [];
  /* Ordered consist, head-first: index 0 is the wagon directly behind the loco.
     Physical state, never emitted on the wire (ADR-016). A railyard mutates it
     via setConsist when it shunts the train's leading pair. */
  private consist: VirtualCarriage[] = [];

  constructor(
    private readonly device_id: string,
    private readonly config: VirtualTrainConfig,
    private readonly layout: LayoutState,
    private readonly random: SeededRandom,
    private readonly clock: VirtualClock,
    private readonly emit: (e: TrainEvent) => void,
    /**
     * marker_id → tag_id resolution for emission. Markers absent from this
     * map produce no `tag_observed` event when crossed. Real layouts would
     * use opaque tag IDs; tests can populate identity mappings via
     * `Simulation`'s `register_tags: 'identity'` option.
     */
    private readonly markerToTag: ReadonlyMap<string, string> = new Map(),
  ) {}

  /** Place the train at the start of an edge with no route yet. */
  placeAt(edge: RouteEdge, distance_mm = 0): void {
    this.current_edge = edge;
    this.distance_into_edge_mm = distance_mm;
  }

  /* Record that the head has just fully traversed `edge`. Maintains the cap:
     once the history reaches MAX_TRAVERSAL_HISTORY the oldest entry is
     dropped so the array never grows beyond the bound. */
  private recordCompletedEdge(edge: RouteEdge): void {
    this.traversal_history.push({
      from_marker_id: edge.from_marker_id,
      to_marker_id: edge.to_marker_id,
    });
    if (this.traversal_history.length > MAX_TRAVERSAL_HISTORY) {
      this.traversal_history.shift();
    }
  }

  /** Apply commands sent by the scheduler. */
  acceptCommand(command_type: string, payload: unknown): void {
    // A powered-off train ignores all commands — it is electrically dead. The
    // server keeps its last-known clearance; commands are not buffered because
    // a silent train elicits no new commands from an event-driven scheduler.
    if (!this.powered) return;
    switch (command_type) {
      case 'begin_exploration': {
        // Open-ended clearance: drive forward and keep reporting markers until
        // released. The train follows its own layout at each marker; no route
        // or limit is set.
        this.exploring = true;
        this.route = [];
        this.route_id = null;
        this.clearance_limit_marker_id = null;
        this.target_velocity_mm_s = this.config.max_velocity_mm_s;
        break;
      }
      case 'assign_route': {
        const { edges, route_id } = payload as { edges: RouteEdge[]; route_id?: string };
        this.applyAssignedRoute(edges, route_id);
        // Speed will be set when clearance arrives.
        break;
      }
      case 'grant_clearance': {
        const { limit_marker_id } = payload as { limit_marker_id: string };
        this.clearance_limit_marker_id = limit_marker_id;
        /* If parked at end of current edge (= old limit), transition to next.
           Use the real edge length, not a hardcoded 200 — short edges would
           otherwise leave a parked train unable to advance when its
           extension grant arrives. */
        if (
          this.current_edge &&
          this.distance_into_edge_mm >= this.currentEdgeLength() &&
          this.velocity_mm_s === 0
        ) {
          const at_marker = this.current_edge.to_marker_id;
          const next_edge = this.route[this.route_index + 1];
          if (next_edge && next_edge.from_marker_id === at_marker) {
            this.recordCompletedEdge(this.current_edge);
            this.route_index += 1;
            this.current_edge = next_edge;
            this.distance_into_edge_mm = 0;
            this.emitted_current_edge_end = false;
          }
        }
        this.target_velocity_mm_s = this.config.max_velocity_mm_s;
        break;
      }
      case 'grant_reverse': {
        const { edges, limit_marker_id } = payload as {
          edges: RouteEdge[];
          limit_marker_id: string;
        };
        this.beginReverse(edges, limit_marker_id);
        break;
      }
      case 'revoke_clearance': {
        // Releases an exploration grant and a reverse grant as well as a bounded
        // clearance.
        this.exploring = false;
        this.endReversing();
        this.clearance_limit_marker_id = null;
        this.target_velocity_mm_s = 0;
        break;
      }
      case 'emergency_stop':
        this.exploring = false;
        this.endReversing();
        this.velocity_mm_s = 0;
        this.target_velocity_mm_s = 0;
        break;
    }
  }

  /**
   * Adopt a freshly assigned route, superseding any exploration. Always snaps to
   * the new route's first edge — without this a moving train would ignore the
   * reassignment and keep walking its old plan with a mismatched `route_id`.
   *
   * If the head is parked at the END of its current edge and the new route
   * continues forward from there (the usual case: a station stop replanned
   * onward), that current edge has been FULLY TRAVERSED — record it in the
   * history before we drop it, so a trailing rake doesn't skip it and jump
   * backward a whole edge when the train pulls out. Mirrors the
   * `grant_clearance` transition, which already records the completed edge.
   */
  private applyAssignedRoute(edges: ReadonlyArray<RouteEdge>, route_id?: string): void {
    this.exploring = false;
    this.route = [...edges];
    this.route_index = 0;
    this.route_id = route_id ?? null;
    this.route_progress_edge_index = 0;
    const first = edges[0];
    if (first === undefined) return;
    if (
      this.current_edge &&
      this.distance_into_edge_mm >= this.currentEdgeLength() &&
      first.from_marker_id === this.current_edge.to_marker_id
    ) {
      this.recordCompletedEdge(this.current_edge);
    }
    this.current_edge = { from_marker_id: first.from_marker_id, to_marker_id: first.to_marker_id };
    this.distance_into_edge_mm = 0;
    this.emitted_current_edge_end = false;
  }

  /**
   * Enter the reversing state under a `grant_reverse` (ADR-022). `edges` is the
   * head-first run of forward-oriented edges to traverse in reverse;
   * `targetMarkerId` is the backward target X. Snap the head onto the to-marker
   * end of the first backward edge and drive backward from there. A concrete
   * reverse supersedes exploration and any forward clearance limit — the train
   * is giving ground, not advancing. No-op for an empty run.
   */
  private beginReverse(edges: ReadonlyArray<RouteEdge>, targetMarkerId: string): void {
    const first = edges[0];
    if (first === undefined) return;
    this.exploring = false;
    this.clearance_limit_marker_id = null;
    this.reverse_edges = edges.map((e) => ({
      from_marker_id: e.from_marker_id,
      to_marker_id: e.to_marker_id,
    }));
    this.reverse_index = 0;
    this.reverse_target_marker_id = targetMarkerId;
    this.current_edge = { from_marker_id: first.from_marker_id, to_marker_id: first.to_marker_id };
    /* Head sits at the to-marker end of the first backward edge; backing
       decrements distance toward the from-marker. */
    this.distance_into_edge_mm = this.currentEdgeLength();
    this.emitted_current_edge_end = false;
    this.target_velocity_mm_s = this.config.max_velocity_mm_s;
  }

  tick(dt_ms: number): void {
    // A powered-off train is inert and silent: it does not advance and emits
    // nothing. Its position, edge, route, and clearance limit stay frozen so
    // power-on resumes from exactly here.
    if (!this.powered) return;
    const dt_s = dt_ms / 1000;

    // Spurious reads happen regardless of whether the train is on an edge.
    if (
      this.config.spurious_read_rate > 0 &&
      this.random.bernoulli(this.config.spurious_read_rate)
    ) {
      const tag_id = `spurious-${Math.floor(this.random.range(0, 1_000_000))}`;
      this.emitEvent({
        event_type: 'tag_observed',
        device_id: this.device_id,
        payload: { tag_id, direction: 'forward' },
      });
    }

    this.adjustVelocity(dt_s);
    if (!this.current_edge) return;

    /* Reverse authority (ADR-022): when backing up, motion runs BACKWARD along
       the held edges (distance decreases) toward the target marker. Handled on
       its own path — the forward braking/limit/cross logic does not apply. */
    if (this.reverse_target_marker_id !== null) {
      this.tickReverse(dt_s);
      this.maybeEmitStatus(dt_ms);
      return;
    }

    this.distance_into_edge_mm += this.velocity_mm_s * dt_s;
    const edge_length_mm = this.currentEdgeLength();

    this.maybeBrakeForClearanceLimit(edge_length_mm);
    this.maybeSnapToClearanceLimit(edge_length_mm);
    this.maybeCrossEdgeEnd(edge_length_mm);

    this.maybeEmitStatus(dt_ms);
  }

  /**
   * One tick of BACKWARD motion under a reverse grant (ADR-022). The head moves
   * from the to-marker end of the current backward edge toward its from-marker
   * (distance decreases). On reaching the from-marker the train emits a
   * `tag_observed` for it (so the scheduler tracks the retreat) and advances to
   * the next backward edge; when the head reaches the target marker it stops and
   * leaves the reversing state. Deterministic — clock-driven kinematics only.
   */
  private tickReverse(dt_s: number): void {
    if (!this.current_edge) return;
    this.distance_into_edge_mm -= this.velocity_mm_s * dt_s;
    if (this.distance_into_edge_mm > 0) return;

    // Reached the from-marker (the near end) of the current backward edge.
    const reachedMarker = this.current_edge.from_marker_id;
    this.distance_into_edge_mm = 0;
    this.emitMarkerObservation(reachedMarker);

    if (reachedMarker === this.reverse_target_marker_id) {
      // Arrived at the backward target X. Stop and leave the reversing state;
      // the head now rests at X with the train's tail trailing forward.
      this.velocity_mm_s = 0;
      this.target_velocity_mm_s = 0;
      this.endReversing();
      return;
    }

    // Otherwise continue onto the next backward edge, snapping the head to its
    // to-marker end.
    this.reverse_index += 1;
    const next = this.reverse_edges[this.reverse_index];
    if (next === undefined) {
      // Ran out of backward edges before reaching the target (should not happen
      // for a well-formed grant); stop conservatively.
      this.velocity_mm_s = 0;
      this.target_velocity_mm_s = 0;
      this.endReversing();
      return;
    }
    this.current_edge = { from_marker_id: next.from_marker_id, to_marker_id: next.to_marker_id };
    this.distance_into_edge_mm = this.currentEdgeLength();
  }

  /** Leave the reversing state (ADR-022). Idempotent. */
  private endReversing(): void {
    this.reverse_edges = [];
    this.reverse_index = 0;
    this.reverse_target_marker_id = null;
  }

  /**
   * Emit a `train_status` event when enough wall time has elapsed since the
   * previous one. Frequent enough for smooth visualiser interpolation; not
   * so frequent that it floods the bus. Disabled when interval is 0.
   */
  private maybeEmitStatus(dt_ms: number): void {
    if (this.config.train_status_interval_ms <= 0) return;
    this.ms_since_status += dt_ms;
    if (this.ms_since_status < this.config.train_status_interval_ms) return;
    this.ms_since_status = 0;

    const payload: Record<string, unknown> = {
      train_id: this.device_id,
      speed_normalised:
        this.config.max_velocity_mm_s > 0
          ? Math.min(1, Math.max(0, this.velocity_mm_s / this.config.max_velocity_mm_s))
          : 0,
    };
    if (this.current_edge) {
      payload.current_edge = {
        from_marker_id: this.current_edge.from_marker_id,
        to_marker_id: this.current_edge.to_marker_id,
      };
      payload.estimated_distance_from_edge_start_mm = this.distance_into_edge_mm;
    }
    if (this.clearance_limit_marker_id) {
      payload.clearance_limit_marker_id = this.clearance_limit_marker_id;
    }
    if (this.route_id) {
      payload.route_id = this.route_id;
      payload.route_progress_edge_index = this.route_index;
    }
    this.emitEvent({
      event_type: 'train_status',
      device_id: this.device_id,
      payload,
    });
  }

  private adjustVelocity(dt_s: number): void {
    const accel_mm = this.config.acceleration_mm_s2 * dt_s;
    if (this.velocity_mm_s < this.target_velocity_mm_s) {
      this.velocity_mm_s = Math.min(this.target_velocity_mm_s, this.velocity_mm_s + accel_mm);
    } else if (this.velocity_mm_s > this.target_velocity_mm_s) {
      this.velocity_mm_s = Math.max(this.target_velocity_mm_s, this.velocity_mm_s - accel_mm);
    }
  }

  private currentEdgeLength(): number {
    if (!this.current_edge) return 200;
    const edge = this.layout.findEdge(
      this.current_edge.from_marker_id,
      this.current_edge.to_marker_id,
    );
    return edge?.estimated_length_mm ?? 200;
  }

  private maybeBrakeForClearanceLimit(edge_length_mm: number): void {
    if (!this.current_edge || this.velocity_mm_s <= 0) return;
    if (this.clearance_limit_marker_id !== this.current_edge.to_marker_id) return;

    const distance_to_limit_mm = edge_length_mm - this.distance_into_edge_mm;
    // Kinematic stopping distance: v² / (2a). Apply multiplicative noise.
    const ideal_stopping_mm =
      (this.velocity_mm_s * this.velocity_mm_s) / (2 * this.config.acceleration_mm_s2);
    const stopping_distance_mm =
      ideal_stopping_mm * (1 + this.random.normal(0, this.config.stopping_noise));
    if (distance_to_limit_mm > stopping_distance_mm) return;

    // Brake should engage. Roll the overshoot mishap once per edge — if the
    // brake fails, leave target_velocity at max and let the train cross the
    // limit at speed. The anomaly is emitted from maybeCrossEdgeEnd.
    if (!this.overshoot_engaged_this_edge && this.config.overshoot_rate > 0) {
      this.overshoot_engaged_this_edge = this.random.bernoulli(this.config.overshoot_rate);
    }
    if (this.overshoot_engaged_this_edge) return;

    this.target_velocity_mm_s = 0;
  }

  /**
   * When the train has braked to a full stop *because* it was cleared exactly
   * to this edge's end marker, kinematic discretisation can leave it a hair
   * short of the edge length — so `maybeCrossEdgeEnd` never fires and the train
   * stalls a millimetre short forever, never reporting that it reached its
   * clearance limit. Snap it onto the marker so the crossing is registered and
   * the scheduler can extend clearance.
   *
   * Guards keep this from firing on a fresh spawn (target still accelerating),
   * on a revoke (clearance limit cleared), or on a mid-edge stop (only snaps
   * when already close to the end).
   */
  private maybeSnapToClearanceLimit(edge_length_mm: number): void {
    if (!this.current_edge) return;
    if (this.clearance_limit_marker_id !== this.current_edge.to_marker_id) return;
    if (this.velocity_mm_s !== 0 || this.target_velocity_mm_s !== 0) return;
    const remaining_mm = edge_length_mm - this.distance_into_edge_mm;
    if (remaining_mm <= 0 || remaining_mm > edge_length_mm * 0.1) return;
    this.distance_into_edge_mm = edge_length_mm;
  }

  private maybeCrossEdgeEnd(edge_length_mm: number): void {
    if (!this.current_edge) return;
    if (this.distance_into_edge_mm < edge_length_mm) return;
    if (this.emitted_current_edge_end) return;

    const marker_id = this.current_edge.to_marker_id;
    this.emitMarkerObservation(marker_id);
    this.emitted_current_edge_end = true;

    // Exploration: keep rolling onto the next physical edge from the layout
    // rather than parking. The rails (and the switch at a junction) decide.
    if (this.exploring) {
      this.continueExploring(marker_id);
      return;
    }

    if (this.clearance_limit_marker_id === marker_id) {
      if (this.overshoot_engaged_this_edge) {
        this.emitOvershootAnomaly(marker_id, this.distance_into_edge_mm - edge_length_mm);
      }
      // Park at the limit. A grant_clearance will transition us to the next edge.
      this.distance_into_edge_mm = edge_length_mm;
      this.velocity_mm_s = 0;
      this.target_velocity_mm_s = 0;
      return;
    }

    this.transitionToNextEdge(marker_id);
  }

  /**
   * Continue exploring from `at_marker_id`: pick the next physical edge from the
   * layout and roll onto it. If there is none (a dead end, or the points are set
   * against every onward branch) the train stops here — LearnMode will see it
   * parked at the marker and decide what to do (terminus pause / switch flip).
   */
  private continueExploring(at_marker_id: string): void {
    const next = this.pickExploreEdge(at_marker_id);
    if (next === undefined) {
      this.velocity_mm_s = 0;
      this.target_velocity_mm_s = 0;
      return;
    }
    if (this.current_edge !== null) {
      this.recordCompletedEdge(this.current_edge);
    }
    this.current_edge = next;
    this.distance_into_edge_mm = 0;
    this.emitted_current_edge_end = false;
    this.overshoot_engaged_this_edge = false;
  }

  /**
   * The edge an exploring train takes out of `marker_id`: a physically-connected
   * outgoing edge, preferring not to immediately reverse, and — at a junction —
   * the branch matching the current switch position. Returns undefined at a dead
   * end or when the points are set against every onward branch.
   */
  private pickExploreEdge(marker_id: string): RouteEdge | undefined {
    const outgoing = this.layout.edgesFrom(marker_id);
    if (outgoing.length === 0) return undefined;

    const cameFrom = this.current_edge?.from_marker_id;
    const onward = outgoing.filter((e) => e.to_marker_id !== cameFrom);
    const candidates = onward.length > 0 ? onward : outgoing;

    // Honour the switch position at a junction; otherwise take the first onward
    // edge (a plain marker has exactly one).
    const position = this.layout.getSwitchPosition(marker_id);
    const switched = candidates.find((e) => e.requires_switch_state === position);
    const chosen = switched ?? candidates.find((e) => e.requires_switch_state === undefined);
    const edge = chosen ?? candidates[0];
    if (edge === undefined) return undefined;
    return { from_marker_id: edge.from_marker_id, to_marker_id: edge.to_marker_id };
  }

  private transitionToNextEdge(at_marker_id: string): void {
    /* Record the edge we're leaving before reassigning current_edge — covers
       both the route-advance and end-of-route (→ null) branches. */
    if (this.current_edge !== null) {
      this.recordCompletedEdge(this.current_edge);
    }
    const next_edge = this.route[this.route_index + 1];
    if (next_edge && next_edge.from_marker_id === at_marker_id) {
      this.route_index += 1;
      this.current_edge = next_edge;
      this.distance_into_edge_mm = 0;
      this.emitted_current_edge_end = false;
      this.overshoot_engaged_this_edge = false;
      return;
    }
    // End of route. Park here. No more ticks should emit anything.
    this.velocity_mm_s = 0;
    this.target_velocity_mm_s = 0;
    this.current_edge = null;
  }

  private emitOvershootAnomaly(marker_id: string, overshoot_mm: number): void {
    this.emitEvent({
      event_type: 'anomaly',
      device_id: this.device_id,
      payload: {
        severity: 'warning',
        description: `Train ${this.device_id} overshot clearance limit at ${marker_id} by ${overshoot_mm.toFixed(1)}mm`,
        context: { train_id: this.device_id, marker_id, overshoot_mm },
      },
    });
  }

  private emitMarkerObservation(marker_id: string): void {
    if (this.random.bernoulli(this.config.miss_rate)) return;
    const tag_id = this.markerToTag.get(marker_id);
    if (!tag_id) return;
    const latency_ms = Math.max(
      0,
      this.random.normal(
        this.config.detection_latency_ms.mean,
        this.config.detection_latency_ms.stddev,
      ),
    );
    this.clock.schedule(latency_ms, () => {
      this.emitEvent({
        event_type: 'tag_observed',
        device_id: this.device_id,
        payload: { tag_id, direction: 'forward' },
      });
    });

    // Double-read: schedule a second emission after an additional short delay.
    if (this.config.double_read_rate > 0 && this.random.bernoulli(this.config.double_read_rate)) {
      const extra_ms = Math.max(0, this.random.normal(10, 5));
      this.clock.schedule(latency_ms + extra_ms, () => {
        this.emitEvent({
          event_type: 'tag_observed',
          device_id: this.device_id,
          payload: { tag_id, direction: 'forward' },
        });
      });
    }
  }

  /**
   * The single chokepoint every event flows through. When the train is
   * powered off it is silent: nothing reaches the injected sink — not status,
   * not marker reads, not spurious reads, not anomalies, and not detection-
   * latency callbacks that were scheduled *before* the power-off and would
   * otherwise fire during the off period.
   */
  private emitEvent(e: TrainEvent): void {
    if (!this.powered) return;
    this.emit(e);
  }

  /**
   * Set the train's power state. Power OFF freezes it inert-in-place: motion
   * stops immediately (velocity 0) but its edge, distance, retained target
   * velocity, route, and clearance limit are kept so power ON resumes exactly
   * where it stopped — `adjustVelocity` pulls back up to the retained target
   * on the next tick, with no need for the server to re-issue clearance. Idempotent.
   */
  setPowered(powered: boolean): void {
    if (this.powered === powered) return;
    this.powered = powered;
    if (!powered) {
      // Stop dead. The target is retained, so power-on re-accelerates toward
      // whatever clearance the train still held.
      this.velocity_mm_s = 0;
    }
  }

  /** Whether the train is currently powered (driven) vs inert-in-place. */
  isPowered(): boolean {
    return this.powered;
  }

  // Observers for tests
  getVelocity(): number {
    return this.velocity_mm_s;
  }
  getDistanceIntoEdge(): number {
    return this.distance_into_edge_mm;
  }
  getCurrentEdge(): RouteEdge | null {
    return this.current_edge;
  }

  /** The train's ordered consist, head-first (index 0 = behind the loco). */
  getConsist(): ReadonlyArray<VirtualCarriage> {
    return this.consist;
  }

  /**
   * The train's PHYSICAL occupancy length: the loco (`config.length_mm`) plus
   * each coupled wagon. Carriages are invisible to core (ADR-016), but they do
   * take up track — so a train's reported length must include its rake, or block
   * exclusivity frees the blocks the wagons still sit on and another train drives
   * straight through them. Zero stays zero (a point-mass train with no rake keeps
   * point-mass semantics).
   */
  private effectiveLengthMm(): number {
    if (this.config.length_mm <= 0) return 0;
    return this.config.length_mm + this.consist.length * CARRIAGE_OCCUPANCY_MM;
  }

  /** Replace the consist (used by a railyard shunting carriages, and at attach
   *  time when the toy-table couples hand-placed wagons). Copied defensively.
   *  When the coupled length changes, the train REPORTS its new physical length
   *  (it declares `core.reports_length`) so the scheduler holds the right blocks
   *  for the rake — ADR-023/ADR-029 §0. */
  setConsist(carriages: ReadonlyArray<VirtualCarriage>): void {
    const before = this.effectiveLengthMm();
    this.consist = [...carriages];
    const after = this.effectiveLengthMm();
    if (after !== before && after > 0) {
      this.emit({
        event_type: 'train_length_changed',
        device_id: this.device_id,
        payload: { train_id: this.device_id, train_length_mm: after },
      });
    }
  }

  /**
   * True when the head is parked — stopped and not trying to move — at the
   * to-marker end of its current edge being `markerId`. A zone device uses this
   * to detect an admitted train that has pulled into its throat and suspended
   * there (ADR-027). A pass-through train never parks at an intermediate marker
   * (its clearance limit lies beyond), so this cleanly separates entry from
   * transit. Limitation: it cannot distinguish a zone entry from a train that
   * happens to terminate its route exactly at this marker for unrelated reasons
   * — the caller owns that marker, so that ambiguity does not arise in practice.
   */
  isParkedAt(markerId: string): boolean {
    if (this.current_edge === null) return false;
    if (this.current_edge.to_marker_id !== markerId) return false;
    if (this.velocity_mm_s !== 0 || this.target_velocity_mm_s !== 0) return false;
    return this.distance_into_edge_mm >= this.currentEdgeLength();
  }

  /**
   * Return the point on the rail `offset_mm` behind the head, walking
   * backwards through the traversal history. Pure query: no state mutation.
   *
   * The base the offset is measured back from is the head's edge + distance —
   * EXCEPT when parked (no current edge): then the head sits at the END of its
   * last traversed edge, so we trail back from there, keeping a stopped train's
   * rake on the rail instead of snapping to static placement.
   * - No current edge AND no history (never moved) → null.
   * - offset_mm <= 0 → head position itself.
   * - offset <= base distance → same edge, moved back by offset.
   * - Otherwise walk history newest-first consuming each edge's length; if
   *   the remaining offset fits inside an historical edge, return that point.
   * - History exhausted → keep walking the LAYOUT GRAPH backwards onto the real
   *   predecessor edge(s), so a long rake behind a freshly-spawned (history-less)
   *   train still trails along the track behind it instead of piling at the edge
   *   start. Bounded by the edge count so a closed loop can't spin forever; a
   *   genuine dead-end (no predecessor edge) still clamps at the edge start.
   *   (Query is UI-only — carriage rendering — so this never affects scheduling.)
   */
  getTrailingPosition(
    offset_mm: number,
  ): { edge: RouteEdge; distance_into_edge_mm: number } | null {
    // Resolve the base (head) edge + distance. Parked → the last traversed edge
    // at its full length (the marker the train stopped on). `historyEnd` is how
    // many history entries the walk-back may consume — one fewer when parked,
    // since the last entry IS the base and must not be re-walked.
    let baseEdge = this.current_edge;
    let baseDist = this.distance_into_edge_mm;
    let historyEnd = this.traversal_history.length;
    if (baseEdge === null) {
      const last = this.traversal_history[this.traversal_history.length - 1];
      if (last === undefined) return null; // never moved — nothing to trail from
      baseEdge = last;
      baseDist = this.edgeLength(last);
      historyEnd -= 1;
    }

    if (offset_mm <= 0) {
      return { edge: baseEdge, distance_into_edge_mm: baseDist };
    }
    if (offset_mm <= baseDist) {
      return { edge: baseEdge, distance_into_edge_mm: baseDist - offset_mm };
    }

    /* Walk history from newest to oldest, consuming offset as we go. */
    let remaining = offset_mm - baseDist;
    for (let i = historyEnd - 1; i >= 0; i--) {
      const histEdge = this.traversal_history[i];
      if (histEdge === undefined) continue;
      const histLen = this.edgeLength(histEdge);
      if (remaining <= histLen) {
        return { edge: histEdge, distance_into_edge_mm: histLen - remaining };
      }
      remaining -= histLen;
    }

    /* History exhausted: keep walking the layout graph backwards onto the real
       predecessor edge(s) so the rake trails on track behind a history-less
       (freshly-spawned) train. */
    return this.trailByGraphWalk(this.traversal_history[0] ?? baseEdge, remaining);
  }

  /** Declared length (mm) of an edge, defaulting when the layout doesn't know it. */
  private edgeLength(edge: RouteEdge): number {
    return this.layout.findEdge(edge.from_marker_id, edge.to_marker_id)?.estimated_length_mm ?? 200;
  }

  /**
   * Resolve a trailing point `remaining` mm back from the start of `oldestKnown`
   * by walking the layout graph backwards onto predecessor edges. At each marker
   * we take an incoming edge that isn't the reverse of the one we just came down
   * (so the walk doesn't fold forward), bounded so a closed loop can't spin
   * forever; a genuine dead-end (no predecessor) clamps at the edge start.
   */
  private trailByGraphWalk(
    oldestKnown: RouteEdge,
    remaining: number,
  ): { edge: RouteEdge; distance_into_edge_mm: number } {
    let backMarker = oldestKnown.from_marker_id;
    let avoidMarker = oldestKnown.to_marker_id;
    let rem = remaining;
    for (let steps = 0; steps < MAX_TRAILING_GRAPH_STEPS; steps++) {
      const pred = this.layout.edgesInto(backMarker).find((e) => e.from_marker_id !== avoidMarker);
      if (pred === undefined) break; // genuine dead-end → clamp below
      const predLen = pred.estimated_length_mm ?? 200;
      if (rem <= predLen) {
        return {
          edge: { from_marker_id: pred.from_marker_id, to_marker_id: pred.to_marker_id },
          distance_into_edge_mm: predLen - rem,
        };
      }
      rem -= predLen;
      avoidMarker = backMarker;
      backMarker = pred.from_marker_id;
    }
    return { edge: oldestKnown, distance_into_edge_mm: 0 };
  }
}
