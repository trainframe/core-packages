import type { LayoutState } from '@trainframe/core';

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
  /** Monotonic counter so each route id is unique. */
  routeIdCounter: number;
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
    this.driveOneStep();
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
        routeIdCounter: 0,
        status: 'waiting_for_train',
      };
      this.publishCurrentState();
      return;
    }

    // If the train has already been seen at some marker (its `last_marker_id`
    // is set on the scheduler), we can start driving immediately. Otherwise
    // sit in waiting_for_train until the operator places + scans the train.
    const seen = this.ports.trainLastMarker(trainId);
    this.session = {
      trainId,
      startMarkerId: undefined,
      lastMarkerId: undefined,
      visitedEdges: new Set(),
      visitedMarkers: new Set(),
      routeIdCounter: 0,
      status: seen !== undefined ? 'driving' : 'waiting_for_train',
    };
    if (seen !== undefined) {
      this.driveOneStep();
    } else {
      this.publishCurrentState();
    }
  }

  private stop(): void {
    if (!this.session) return;
    this.session = null;
    this.ports.publishState({ state: 'idle' });
  }

  /**
   * Decide the next move and emit commands for it. Called after the scheduler
   * has processed a fresh `tag_observed` for our train.
   */
  private driveOneStep(): void {
    if (!this.session) return;

    const markerId = this.ports.trainLastMarker(this.session.trainId);
    if (markerId === undefined) return;

    // Record the marker as visited.
    this.session.visitedMarkers.add(markerId);
    if (this.session.startMarkerId === undefined) {
      this.session.startMarkerId = markerId;
    }
    // Record the edge we just traversed (if any) so we don't reselect it.
    if (this.session.lastMarkerId !== undefined && this.session.lastMarkerId !== markerId) {
      this.session.visitedEdges.add(edgeKey(this.session.lastMarkerId, markerId));
    }
    this.session.lastMarkerId = markerId;

    // Terminus: pause. Operator picks up the train and rescans elsewhere.
    const marker = this.ports.layoutState.getMarker(markerId);
    if (marker?.kind === 'terminus') {
      this.session.status = 'paused_terminus';
      this.publishCurrentState();
      return;
    }

    // Completion: all outgoing edges from here are visited AND we are back
    // at the start marker.
    const outgoing = this.ports.layoutState.edgesFrom(markerId);
    const unvisited = outgoing.filter(
      (e) => !this.session?.visitedEdges.has(edgeKey(e.from_marker_id, e.to_marker_id)),
    );
    const atStart = markerId === this.session.startMarkerId;
    if (outgoing.length > 0 && unvisited.length === 0 && atStart) {
      this.session.status = 'complete';
      this.publishCurrentState();
      return;
    }

    // Pick the next edge: prefer an unvisited one, otherwise fall back to
    // the first outgoing edge so the train keeps moving. If there are no
    // outgoing edges at all, we publish current state and wait — a future
    // tag_assignment for a neighbour will create one.
    const nextEdge = unvisited[0] ?? outgoing[0];
    if (nextEdge === undefined) {
      this.publishCurrentState();
      return;
    }

    // If the marker is a junction with a known unexplored position, set the
    // switch first. Extracted to keep driveOneStep within complexity budget.
    this.maybeFlipSwitch(markerId, nextEdge.requires_switch_state);

    this.session.routeIdCounter += 1;
    const routeId = `learn-${this.session.routeIdCounter}`;
    const edgeRef = {
      from_marker_id: nextEdge.from_marker_id,
      to_marker_id: nextEdge.to_marker_id,
    };
    this.ports.sendCommand(this.session.trainId, 'assign_route', {
      route_id: routeId,
      edges: [edgeRef],
    });
    this.ports.sendCommand(this.session.trainId, 'grant_clearance', {
      limit_marker_id: nextEdge.to_marker_id,
      reason: 'track-learn',
      edges_newly_cleared: [edgeRef],
    });

    this.publishCurrentState();
  }

  /**
   * If the marker is a junction whose required switch state differs from the
   * current position, send `set_switch_position` to the paired switch device.
   * The device id is resolved via `LayoutState.switchDeviceForMarker`; if no
   * pairing has been recorded yet, the command is silently skipped — the
   * clearance gate will keep the train stopped until the position confirms.
   */
  private maybeFlipSwitch(markerId: string, requiredState: string | undefined): void {
    if (requiredState === undefined) return;
    const current = this.ports.layoutState.getSwitchPosition(markerId);
    if (current === requiredState) return;
    const switchDeviceId = this.ports.layoutState.switchDeviceForMarker(markerId);
    if (switchDeviceId === undefined) return;
    this.ports.sendCommand(switchDeviceId, 'set_switch_position', {
      junction_marker_id: markerId,
      position: requiredState,
    });
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

function extractTrainId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  return typeof obj.train_id === 'string' ? obj.train_id : undefined;
}
