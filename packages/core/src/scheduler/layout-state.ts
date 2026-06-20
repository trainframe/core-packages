import type { Layout, LayoutEdge, LayoutMarker } from '@trainframe/protocol';

export interface LayoutStateOptions {
  /**
   * Number of traversals after which an inferred edge is automatically
   * confirmed (its `inferred` flag flips to false). Default 3, per the
   * simulator spec §"Incremental discovery".
   */
  readonly confirmTraversals?: number;
  /**
   * Clock callback used to timestamp traversals for learned traversal time
   * computation. REQUIRED: core never reads the wall clock directly
   * (determinism contract). The IO layer supplies `Date.now`; tests and the
   * simulator inject a virtual clock.
   */
  readonly now: () => number;
}

export interface RecordTraversalResult {
  readonly inferredEdgeAdded: boolean;
  readonly edgeConfirmed: boolean;
}

/**
 * Runtime representation of the layout graph. Built from a Layout document
 * and updated by discovery as trains move through unknown territory.
 *
 * Operations the scheduler needs:
 *   - "Given a marker, what edges leave it?"
 *   - "Given a from/to marker pair, find the edge."
 *   - "Is this edge currently traversable given switch states?"
 *
 * Intentionally not a generic graph library; the operations are specific to
 * the railway domain.
 */
export class LayoutState {
  readonly name: string;
  private readonly markers = new Map<string, LayoutMarker>();
  private readonly outgoingEdges = new Map<string, LayoutEdge[]>();
  private readonly incomingEdges = new Map<string, LayoutEdge[]>();
  private readonly switchPositions = new Map<string, string>();
  /**
   * Pairing from junction marker id → switch device id, populated when a
   * `device_registered` event with `core.controls_switch` + `controls_marker_id`
   * is processed by the scheduler. Read by LearnMode when it needs to target
   * the hardware device, not the logical marker.
   */
  private readonly switchDeviceByMarker = new Map<string, string>();
  private readonly junctionsByMarkerId = new Map<
    string,
    { marker_id: string; initial_state?: string }
  >();
  /** Traversal counter per edge for discovery-mode confirmation (ADR-009). */
  private readonly traversalCounts = new Map<string, number>();
  private readonly confirmTraversals: number;
  /**
   * Timestamp of the previous `recordTraversal` call, used to compute the
   * time taken to traverse the most-recently-recorded edge.
   */
  private lastRecordedAt: number | null = null;
  /**
   * EWMA of traversal time in ms per edge key, populated as trains run.
   * Alpha = 0.3: new value contributes 30%, prior average 70%.
   */
  private readonly learnedMs = new Map<string, number>();
  /**
   * Per-train EWMA of traversal time in ms. Outer key is train ID, inner key
   * is the same edge key used by `learnedMs`. Populated when `recordTraversal`
   * is called with a `trainId`. Allows fast trains and slow shunters to maintain
   * independent estimates without polluting each other.
   */
  private readonly learnedMsByTrain = new Map<string, Map<string, number>>();
  /**
   * Per-train timestamp of the previous `recordTraversal` call, used to compute
   * per-train traversal deltas independently of the global `lastRecordedAt`.
   */
  private readonly lastRecordedAtByTrain = new Map<string, number>();
  private readonly now: () => number;
  private readonly initialLayout: Layout;

  constructor(layout: Layout, options: LayoutStateOptions) {
    this.name = layout.name;
    this.confirmTraversals = options.confirmTraversals ?? 3;
    this.now = options.now;
    this.initialLayout = layout;
    this.loadFromLayout(layout);
  }

  /*
   * Build the graph maps from a declared layout. Used by the constructor and
   * by reset(). Validates that every edge references a known marker — the same
   * guard enforced inline before this extraction.
   */
  private loadFromLayout(layout: Layout): void {
    for (const marker of layout.markers) {
      this.markers.set(marker.id, marker);
      this.outgoingEdges.set(marker.id, []);
      this.incomingEdges.set(marker.id, []);
    }

    for (const edge of layout.edges) {
      this.addEdgeInternal(edge);
    }

    for (const junction of layout.junctions) {
      this.junctionsByMarkerId.set(junction.marker_id, junction);
      if (junction.initial_state) {
        this.switchPositions.set(junction.marker_id, junction.initial_state);
      }
    }
  }

  /*
   * Revert the live graph to the layout it was constructed with, discarding
   * every learned marker, edge, switch position, and traversal statistic. In
   * discovery mode (constructed empty) this clears the graph entirely.
   */
  reset(): void {
    this.markers.clear();
    this.outgoingEdges.clear();
    this.incomingEdges.clear();
    this.switchPositions.clear();
    this.switchDeviceByMarker.clear();
    this.junctionsByMarkerId.clear();
    this.traversalCounts.clear();
    this.learnedMs.clear();
    this.learnedMsByTrain.clear();
    this.lastRecordedAtByTrain.clear();
    this.lastRecordedAt = null;
    this.loadFromLayout(this.initialLayout);
  }

  private addEdgeInternal(edge: LayoutEdge): void {
    const out = this.outgoingEdges.get(edge.from_marker_id);
    const inc = this.incomingEdges.get(edge.to_marker_id);
    if (!out || !inc) {
      throw new Error(
        `Edge references unknown marker: ${edge.from_marker_id} -> ${edge.to_marker_id}`,
      );
    }
    out.push(edge);
    inc.push(edge);
  }

  getMarker(id: string): LayoutMarker | undefined {
    return this.markers.get(id);
  }

  hasMarker(id: string): boolean {
    return this.markers.has(id);
  }

  /** Edges leaving a marker, regardless of switch state. */
  edgesFrom(markerId: string): ReadonlyArray<LayoutEdge> {
    return this.outgoingEdges.get(markerId) ?? [];
  }

  /** Edges entering a marker, regardless of switch state. The mirror of
   *  `edgesFrom`; used to walk the graph backwards (e.g. resolving where a
   *  train's trailing consist sits on the track behind the head). */
  edgesInto(markerId: string): ReadonlyArray<LayoutEdge> {
    return this.incomingEdges.get(markerId) ?? [];
  }

  /** Edge from one marker to another, if it exists. */
  findEdge(fromMarkerId: string, toMarkerId: string): LayoutEdge | undefined {
    return this.outgoingEdges.get(fromMarkerId)?.find((e) => e.to_marker_id === toMarkerId);
  }

  /**
   * Does the marker have any incident edges (incoming or outgoing)? A marker
   * unknown to the graph, or known but with no edges at all (an orphan), is not
   * wired into the topology. Used by ADR-019 to refine the operator-facing
   * `suspected_cause` hint: a wired-in but non-adjacent marker is more likely a
   * missed read than brand-new track.
   */
  hasIncidentEdges(markerId: string): boolean {
    return (
      (this.outgoingEdges.get(markerId)?.length ?? 0) > 0 ||
      (this.incomingEdges.get(markerId)?.length ?? 0) > 0
    );
  }

  /**
   * The currently-active outgoing edge from a marker, considering switch
   * state. Returns the only edge for non-junctions, the switch-selected edge
   * for junctions with a known position, or undefined if the position is
   * unknown.
   */
  activeEdgeFrom(markerId: string): LayoutEdge | undefined {
    const edges = this.edgesFrom(markerId);
    if (edges.length === 0) return undefined;
    if (edges.length === 1) return edges[0];

    const requested = this.switchPositions.get(markerId);
    if (!requested) return undefined;
    return edges.find((e) => e.requires_switch_state === requested);
  }

  setSwitchPosition(junctionMarkerId: string, position: string): void {
    this.switchPositions.set(junctionMarkerId, position);
  }

  getSwitchPosition(junctionMarkerId: string): string | undefined {
    return this.switchPositions.get(junctionMarkerId);
  }

  /**
   * Record the pairing between a junction marker and its controlling switch
   * device. Called by the scheduler when a `device_registered` event carries
   * `core.controls_switch` + a `controls_marker_id` field. Idempotent —
   * re-registering the same device updates the record.
   */
  recordSwitchPairing(deviceId: string, junctionMarkerId: string): void {
    this.switchDeviceByMarker.set(junctionMarkerId, deviceId);
  }

  /**
   * Return the switch device id that controls the given junction marker, or
   * `undefined` if no device has declared itself as the controller. Used by
   * LearnMode to address `set_switch_position` commands to the real device
   * rather than the marker id.
   */
  switchDeviceForMarker(junctionMarkerId: string): string | undefined {
    return this.switchDeviceByMarker.get(junctionMarkerId);
  }

  /**
   * Add a newly-discovered edge to the graph (from discovery mode).
   * No-op if the edge already exists.
   */
  addInferredEdge(fromMarkerId: string, toMarkerId: string): void {
    if (this.findEdge(fromMarkerId, toMarkerId)) return;
    if (!this.markers.has(fromMarkerId) || !this.markers.has(toMarkerId)) return;
    this.addEdgeInternal({
      from_marker_id: fromMarkerId,
      to_marker_id: toMarkerId,
      inferred: true,
    });
  }

  /**
   * Add a marker to the layout if it doesn't already exist. Used by
   * discovery mode when an operator binds a tag to a previously-unknown
   * marker target (ADR-009). Returns whether the marker was newly added.
   */
  upsertMarker(id: string, kind: LayoutMarker['kind']): boolean {
    if (this.markers.has(id)) return false;
    this.markers.set(id, { id, kind });
    this.outgoingEdges.set(id, []);
    this.incomingEdges.set(id, []);
    return true;
  }

  /**
   * Remove every marker that has no incoming and no outgoing edges — the
   * disconnected "floating dots" left behind by deleted track. Returns the
   * removed marker ids in ascending order. Edge-keyed maps (traversalCounts,
   * learnedMs) need no cleanup: an orphan has no edges, so no key references it.
   */
  pruneOrphanMarkers(): string[] {
    const removed: string[] = [];
    for (const id of [...this.markers.keys()]) {
      const out = this.outgoingEdges.get(id)?.length ?? 0;
      const inc = this.incomingEdges.get(id)?.length ?? 0;
      if (out !== 0 || inc !== 0) continue;
      this.markers.delete(id);
      this.outgoingEdges.delete(id);
      this.incomingEdges.delete(id);
      this.switchPositions.delete(id);
      this.switchDeviceByMarker.delete(id);
      this.junctionsByMarkerId.delete(id);
      removed.push(id);
    }
    removed.sort((a, b) => a.localeCompare(b));
    return removed;
  }

  /**
   * Record a train traversing from `fromMarkerId` to `toMarkerId`. If no
   * edge exists, infer one; if one does, increment its traversal count.
   * Inferred edges flip to confirmed once their counter hits the
   * configured threshold.
   *
   * Returns flags describing what changed so the scheduler can publish
   * a fresh layout snapshot when discovery has moved the graph forward.
   */
  recordTraversal(
    fromMarkerId: string,
    toMarkerId: string,
    trainId?: string,
  ): RecordTraversalResult {
    if (!this.markers.has(fromMarkerId) || !this.markers.has(toMarkerId)) {
      return { inferredEdgeAdded: false, edgeConfirmed: false };
    }

    let added = false;
    if (!this.findEdge(fromMarkerId, toMarkerId)) {
      this.addEdgeInternal({
        from_marker_id: fromMarkerId,
        to_marker_id: toMarkerId,
        inferred: true,
      });
      added = true;
    }

    const key = edgeKey(fromMarkerId, toMarkerId);
    const count = (this.traversalCounts.get(key) ?? 0) + 1;
    this.traversalCounts.set(key, count);

    const edge = this.findEdge(fromMarkerId, toMarkerId);
    const shouldConfirm = edge?.inferred === true && count >= this.confirmTraversals;
    if (shouldConfirm) {
      this.confirmEdge(fromMarkerId, toMarkerId);
    }

    // Update learned traversal time. `lastRecordedAt` holds the timestamp of
    // the previous call, so the delta is the time spent on the edge that just
    // completed (from→to). Skip the very first call (no prior timestamp to
    // diff); record the timestamp for every valid traversal so the next call
    // can compute a delta.
    const ts = this.now();
    if (this.lastRecordedAt !== null) {
      const delta = ts - this.lastRecordedAt;
      const prior = this.learnedMs.get(key);
      this.learnedMs.set(key, prior === undefined ? delta : prior * 0.7 + delta * 0.3);
    }
    this.lastRecordedAt = ts;

    if (trainId !== undefined) {
      this.updatePerTrainEwma(trainId, key, ts);
    }

    return { inferredEdgeAdded: added, edgeConfirmed: shouldConfirm };
  }

  /**
   * Returns the EWMA traversal time in ms for the given edge, or `undefined`
   * if the edge has been traversed fewer than twice (not enough data to
   * compute a delta). Per the protocol spec §"Incremental discovery",
   * `learned_traversal_time_ms_at_speed`.
   *
   * When `trainId` is supplied, the per-train EWMA takes precedence over the
   * global one. If no per-train value exists yet, falls back to the global
   * estimate. If neither exists, returns `undefined`.
   */
  getLearnedTraversalMs(
    fromMarkerId: string,
    toMarkerId: string,
    trainId?: string,
  ): number | undefined {
    const key = edgeKey(fromMarkerId, toMarkerId);
    if (trainId !== undefined) {
      const perTrain = this.learnedMsByTrain.get(trainId)?.get(key);
      if (perTrain !== undefined) return perTrain;
    }
    return this.learnedMs.get(key);
  }

  /**
   * Update the per-train EWMA for a given train and edge key.
   * Uses its own per-train `lastRecordedAt` so different trains' timings are
   * completely independent of each other and of the global timestamp.
   */
  private updatePerTrainEwma(trainId: string, key: string, ts: number): void {
    const lastAt = this.lastRecordedAtByTrain.get(trainId);
    if (lastAt !== undefined) {
      const delta = ts - lastAt;
      let edgeMap = this.learnedMsByTrain.get(trainId);
      if (edgeMap === undefined) {
        edgeMap = new Map<string, number>();
        this.learnedMsByTrain.set(trainId, edgeMap);
      }
      const prior = edgeMap.get(key);
      edgeMap.set(key, prior === undefined ? delta : prior * 0.7 + delta * 0.3);
    }
    this.lastRecordedAtByTrain.set(trainId, ts);
  }

  /** Flip the inferred flag off on every copy of the edge stored in the indexes. */
  private confirmEdge(fromMarkerId: string, toMarkerId: string): void {
    const promote = (e: LayoutEdge): LayoutEdge => ({ ...e, inferred: false });
    const replaceIn = (list: LayoutEdge[] | undefined) => {
      if (!list) return;
      const idx = list.findIndex(
        (e) => e.from_marker_id === fromMarkerId && e.to_marker_id === toMarkerId,
      );
      if (idx >= 0) list[idx] = promote(list[idx] as LayoutEdge);
    };
    replaceIn(this.outgoingEdges.get(fromMarkerId));
    replaceIn(this.incomingEdges.get(toMarkerId));
  }

  /** Has the given edge been traversed enough to drop the inferred flag? */
  traversalCount(fromMarkerId: string, toMarkerId: string): number {
    return this.traversalCounts.get(edgeKey(fromMarkerId, toMarkerId)) ?? 0;
  }

  /**
   * Serialise the current graph back to a `Layout` document, suitable for
   * republishing as retained state. Edges retain their `inferred` flag so
   * subscribers can distinguish learned from declared topology.
   */
  toLayout(): Layout {
    const markers = [...this.markers.values()];
    const edges: LayoutEdge[] = [];
    for (const out of this.outgoingEdges.values()) edges.push(...out);
    const junctions = [...this.junctionsByMarkerId.values()];
    return { name: this.name, markers, edges, junctions };
  }
}

function edgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}
