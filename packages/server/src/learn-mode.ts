import type { LayoutState } from '@trainframe/core';
import type { LayoutEdge } from '@trainframe/protocol';

/**
 * Operator-facing state of the track-learn machine. Mirrors the retained
 * `railway/state/track_learning/active` payload.
 *
 *  - `idle`               No learning in progress.
 *  - `waiting_for_train`  Learn-start received but no live train yet. Operator
 *                         is told to place + scan a train.
 *  - `driving`            A train has been seized; LearnMode is issuing route
 *                         + clearance commands one edge at a time.
 *  - `paused_terminus`    The train hit a `terminus` marker and can't continue
 *                         on this section. Operator picks it up and re-scans
 *                         elsewhere to resume.
 *  - `complete`           The train returned to its start marker with no
 *                         unexplored outgoing edges. The reachable graph from
 *                         the start is fully traversed.
 */
export type LearnModeStateName =
  | 'idle'
  | 'waiting_for_train'
  | 'driving'
  | 'paused_terminus'
  | 'complete';

/** Retained snapshot shape published to `railway/state/track_learning/active`. */
export interface LearnModeStateSnapshot {
  readonly state: LearnModeStateName;
  readonly train_id?: string;
  readonly markers_visited?: number;
  readonly edges_learned?: number;
  readonly start_marker_id?: string;
  readonly last_marker_id?: string;
}

/**
 * Side-effect ports for LearnMode. The Server wires these to the broker +
 * scheduler; tests stub them. LearnMode never mutates scheduler state — it
 * reads `LayoutState` after the scheduler has updated it, and emits commands
 * directly to the train.
 */
export interface LearnModePorts {
  /** The shared LayoutState owned by the scheduler. Read-only access. */
  readonly layoutState: LayoutState;
  /** The set of train IDs currently registered. */
  readonly registeredTrains: () => ReadonlyArray<string>;
  /** The train's most recently observed marker, or undefined. */
  readonly trainLastMarker: (trainId: string) => string | undefined;
  /** Publish a command to a device on `railway/commands/<device_id>`. */
  readonly sendCommand: (deviceId: string, commandType: string, payload: unknown) => void;
  /** Publish the retained state snapshot. */
  readonly publishState: (snapshot: LearnModeStateSnapshot) => void;
}

interface ActiveSession {
  trainId: string;
  /** First marker the train reported after learn-start. */
  startMarkerId: string | undefined;
  /** Last marker the train was observed at. */
  lastMarkerId: string | undefined;
  /** Edges (by edgeKey) confirmed traversed by *this* train this session. */
  readonly visitedEdges: Set<string>;
  /** Markers (by id) the train has visited this session. */
  readonly visitedMarkers: Set<string>;
  /** Whether the open-ended exploration clearance has been issued this session. */
  exploring: boolean;
  /**
   * Per-junction (marker id → switch position) the position LearnMode last
   * commanded this session. Anti-thrash: an identical `set_switch_position` is
   * suppressed, and since the chosen leg only advances when the current one is
   * traversed, a junction is re-thrown at most once per leg.
   */
  readonly commandedSwitch: Map<string, string>;
  /** Current operator-visible state. */
  status: LearnModeStateName;
}

/**
 * Track-learn mode. A separate concern from the scheduler: when active, it
 * actively drives one operator-blessed train around the layout, issuing
 * `set_switch_position`, `assign_route` (single-edge), and `grant_clearance`
 * commands. While active, the scheduler is not used to *plan* this train —
 * it simply hasn't been given a `schedule`. Passive discovery
 * (`recordTraversal`, `upsertMarker`) keeps running on the scheduler side,
 * which is precisely what we want: every traversal LearnMode provokes still
 * flows through the scheduler first, so the layout is genuinely learned
 * before LearnMode reads it.
 *
 * Ordering invariant: `Server.handleMessage` MUST dispatch the event to the
 * scheduler (`dispatchEffects`) *before* forwarding it to `LearnMode.onEvent`.
 * Otherwise LearnMode would query a stale `LayoutState`.
 */
export class LearnMode {
  private session: ActiveSession | null = null;

  constructor(private readonly ports: LearnModePorts) {}

  /**
   * Publish the current state (or idle) as the initial retained snapshot.
   * Called from `Server.start()` so a fresh visualiser subscriber renders
   * the button immediately.
   */
  publishInitialState(): void {
    if (this.session) {
      this.ports.publishState(this.snapshotFromSession(this.session));
      return;
    }
    this.ports.publishState({ state: 'idle' });
  }

  /** Is learn mode currently active? Test/observability helper. */
  isActive(): boolean {
    return this.session !== null;
  }

  /** The active train ID, if any. Test/observability helper. */
  activeTrainId(): string | undefined {
    if (!this.session || this.session.trainId === '') return undefined;
    return this.session.trainId;
  }

  /**
   * Handle an operator command from `railway/operator/<command>`. Returns
   * true iff the command was recognised so the caller knows not to fall
   * through to other handlers.
   */
  handleOperatorCommand(commandType: string, payload: unknown): boolean {
    if (commandType === 'learn_track_start') {
      this.start(extractTrainId(payload));
      return true;
    }
    if (commandType === 'learn_track_stop') {
      this.stop();
      return true;
    }
    return false;
  }

  /**
   * Forward a wire event *after* the scheduler has handled it. Only
   * `tag_observed` from our train matters here — that's the moment the
   * scheduler has just recorded the traversal (`recordTraversal`) so
   * `LayoutState` is fresh.
   */
  onEvent(eventType: string, deviceId: string, _payload: unknown): void {
    if (!this.session) return;
    if (eventType !== 'tag_observed') return;
    // While waiting for a train, latch onto whichever train just produced
    // its first tag_observed (only if no specific train was requested).
    if (this.session.status === 'waiting_for_train') {
      const trains = this.ports.registeredTrains();
      if (trains.length === 0) return;
      // Prefer the device that just emitted the tag, if it is registered.
      const next = trains.includes(deviceId) ? deviceId : trains[0];
      if (next === undefined) return;
      this.session.trainId = next;
      this.session.status = 'driving';
    }
    if (deviceId !== this.session.trainId) return;
    this.reviewProgress();
  }

  // -------------------- internals --------------------

  private start(requestedTrainId: string | undefined): void {
    // Stop any in-flight session first.
    this.session = null;

    const trainId = requestedTrainId ?? this.ports.registeredTrains()[0];
    if (trainId === undefined) {
      this.session = {
        trainId: '',
        startMarkerId: undefined,
        lastMarkerId: undefined,
        visitedEdges: new Set(),
        visitedMarkers: new Set(),
        exploring: false,
        commandedSwitch: new Map(),
        status: 'waiting_for_train',
      };
      this.publishCurrentState();
      return;
    }

    /*
     * A registered train is driven straight away. If it has already been seen at
     * a marker (its `last_marker_id` is set), `reviewProgress` records that start
     * marker and issues the open exploration clearance. If it has NOT yet been
     * seen — a freshly-scanned loco sitting mid-piece, not pixel-perfect on a
     * marker, so its sensor has fired nothing — we must STILL drive it: cold-start
     * discovery is a chicken-and-egg (you cannot observe the first marker without
     * moving, and cannot move without clearance), so LearnMode breaks the tie by
     * issuing `begin_exploration` to make the loco roll until it crosses its first
     * marker. Waiting passively here was the deadlock that stopped a scanned train
     * from ever taking Learn track. `waiting_for_train` is reserved for when NO
     * train is registered at all (handled above).
     */
    const seen = this.ports.trainLastMarker(trainId);
    this.session = {
      trainId,
      startMarkerId: undefined,
      lastMarkerId: undefined,
      visitedEdges: new Set(),
      visitedMarkers: new Set(),
      exploring: false,
      commandedSwitch: new Map(),
      status: 'driving',
    };
    if (seen !== undefined) {
      this.reviewProgress();
    } else {
      this.ensureExploring();
      this.publishCurrentState();
    }
  }

  private stop(): void {
    if (!this.session) return;
    // Revoke the open-ended exploration clearance so the train actually halts.
    // Without this the loco keeps its `begin_exploration` grant and wanders on
    // after the operator clicks "Stop learning", leaving the scheduler unable
    // to cleanly route it (it never parks at a known marker to plan from).
    // The terminus/completion paths already release; the manual-stop path must
    // too. Guarded on `exploring` so stopping a session that never started
    // driving (waiting_for_train) doesn't emit a spurious revoke.
    if (this.session.exploring) this.releaseTrain();
    this.session = null;
    this.ports.publishState({ state: 'idle' });
  }

  /**
   * Observe the train's progress after each `tag_observed` and decide whether
   * to keep exploring or to stop. LearnMode does NOT route the train edge by
   * edge (ADR-015): it issues one open-ended `begin_exploration` and the train
   * drives itself, following the rails. The scheduler learns the edges from the
   * resulting traversals; here we just track progress and recognise when to
   * release the train (terminus reached, or the reachable loop fully mapped).
   */
  private reviewProgress(): void {
    if (!this.session) return;

    const markerId = this.ports.trainLastMarker(this.session.trainId);
    if (markerId === undefined) return;

    this.session.visitedMarkers.add(markerId);
    if (this.session.startMarkerId === undefined) {
      this.session.startMarkerId = markerId;
    }
    if (this.session.lastMarkerId !== undefined && this.session.lastMarkerId !== markerId) {
      this.session.visitedEdges.add(edgeKey(this.session.lastMarkerId, markerId));
    }
    this.session.lastMarkerId = markerId;

    // Terminus: a dead end. The exploring train stops there of its own accord;
    // release it and pause for an operator lift-and-rescan elsewhere.
    if (this.ports.layoutState.getMarker(markerId)?.kind === 'terminus') {
      this.releaseTrain();
      this.session.status = 'paused_terminus';
      this.publishCurrentState();
      return;
    }

    // Junction surveying: aim every junction's points at a not-yet-traversed
    // leg, so the self-driving loco takes the diverging legs instead of only the
    // loop the points happened to point at. Forward-only — this throws switches,
    // never routes or reverses the train.
    this.armJunctions();

    // Completion: back at the start marker with every outgoing edge from every
    // visited marker already traversed — the reachable loop is fully mapped.
    if (this.reachableGraphFullyTraversed(markerId)) {
      this.releaseTrain();
      this.session.status = 'complete';
      this.publishCurrentState();
      return;
    }

    // Otherwise keep exploring. The train drives itself; we only have to make
    // sure the open clearance has been granted (idempotent).
    this.ensureExploring();
    this.publishCurrentState();
  }

  /**
   * Aim every junction's points at a deterministically-chosen not-yet-traversed
   * outgoing leg, commanding the OWNING switch device (never the marker id).
   * Anti-thrash: skip a junction already aimed at that position, and a junction
   * with all legs traversed. The chosen leg advances only as legs get traversed,
   * so a junction is re-thrown at most once per leg — survey progress is
   * monotone and the pass terminates.
   */
  private armJunctions(): void {
    if (!this.session) return;
    for (const junction of this.ports.layoutState.junctionMarkerIds()) {
      const target = this.firstUntraversedLeg(junction);
      const position = target?.requires_switch_state;
      if (position === undefined) continue; // all legs surveyed (or none switched)
      if (this.session.commandedSwitch.get(junction) === position) continue; // already aimed
      const device = this.ports.layoutState.switchDeviceForMarker(junction);
      if (device === undefined) continue; // no controller registered yet
      this.session.commandedSwitch.set(junction, position);
      this.ports.sendCommand(device, 'set_switch_position', {
        junction_marker_id: junction,
        position,
      });
    }
  }

  /**
   * The first not-yet-traversed outgoing leg of `junction`, by a stable order
   * (switch position then destination marker) so the choice is deterministic.
   * `undefined` when every leg has been traversed.
   *
   * A leg is throwable only if it carries `requires_switch_state` — which the
   * layout inference (`compileLayout`) always emits for a junction's legs, and a
   * declared layout always carries. (A junction whose legs were discovered as bare
   * inferred edges with no switch state is not produced by the toy-table's
   * inference, so it is out of scope here.)
   */
  private firstUntraversedLeg(junction: string): LayoutEdge | undefined {
    if (!this.session) return undefined;
    const session = this.session;
    return this.ports.layoutState
      .edgesFrom(junction)
      .filter((e) => !session.visitedEdges.has(edgeKey(e.from_marker_id, e.to_marker_id)))
      .sort(compareLegs)[0];
  }

  /** Issue the open-ended exploration clearance once per session. */
  private ensureExploring(): void {
    if (!this.session || this.session.exploring) return;
    this.session.exploring = true;
    this.ports.sendCommand(this.session.trainId, 'begin_exploration', { reason: 'track-learn' });
  }

  /** Release the train: revoke its exploration clearance so it stops. */
  private releaseTrain(): void {
    if (!this.session) return;
    this.session.exploring = false;
    this.ports.sendCommand(this.session.trainId, 'revoke_clearance', {
      reason: 'track-learn',
      immediate: false,
    });
  }

  /**
   * True once the train is back at its start marker and every outgoing edge
   * from every marker it has visited has been traversed — i.e. a full lap that
   * discovered nothing new. Guarded so it can't fire before the train has moved.
   */
  private reachableGraphFullyTraversed(markerId: string): boolean {
    if (!this.session) return false;
    if (markerId !== this.session.startMarkerId) return false;
    if (this.session.visitedEdges.size === 0) return false;
    for (const visited of this.session.visitedMarkers) {
      for (const edge of this.ports.layoutState.edgesFrom(visited)) {
        if (!this.session.visitedEdges.has(edgeKey(edge.from_marker_id, edge.to_marker_id))) {
          return false;
        }
      }
    }
    return true;
  }

  private publishCurrentState(): void {
    if (!this.session) {
      this.ports.publishState({ state: 'idle' });
      return;
    }
    this.ports.publishState(this.snapshotFromSession(this.session));
  }

  private snapshotFromSession(session: ActiveSession): LearnModeStateSnapshot {
    const out: {
      state: LearnModeStateName;
      train_id?: string;
      markers_visited?: number;
      edges_learned?: number;
      start_marker_id?: string;
      last_marker_id?: string;
    } = { state: session.status };
    if (session.trainId !== '') out.train_id = session.trainId;
    if (session.startMarkerId !== undefined) out.start_marker_id = session.startMarkerId;
    if (session.lastMarkerId !== undefined) out.last_marker_id = session.lastMarkerId;
    if (session.visitedMarkers.size > 0) out.markers_visited = session.visitedMarkers.size;
    if (session.visitedEdges.size > 0) out.edges_learned = session.visitedEdges.size;
    return out;
  }
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

/** Stable total order over a junction's legs: by required switch position, then
 *  destination marker. Makes the surveyed-leg choice deterministic. */
function compareLegs(a: LayoutEdge, b: LayoutEdge): number {
  const sa = a.requires_switch_state ?? '';
  const sb = b.requires_switch_state ?? '';
  if (sa !== sb) return sa < sb ? -1 : 1;
  return a.to_marker_id < b.to_marker_id ? -1 : a.to_marker_id > b.to_marker_id ? 1 : 0;
}

function extractTrainId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  return typeof obj.train_id === 'string' ? obj.train_id : undefined;
}
