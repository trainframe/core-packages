import type { Layout, LayoutEdge, LayoutMarker } from '@trainframe/protocol';

export interface LayoutStateOptions {
  /**
   * Number of traversals after which an inferred edge is automatically
   * confirmed (its `inferred` flag flips to false). Default 3, per the
   * simulator spec §"Incremental discovery".
   */
  readonly confirmTraversals?: number;
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
  private readonly junctionsByMarkerId = new Map<
    string,
    { marker_id: string; initial_state?: string }
  >();
  /** Traversal counter per edge for discovery-mode confirmation (ADR-009). */
  private readonly traversalCounts = new Map<string, number>();
  private readonly confirmTraversals: number;

  constructor(layout: Layout, options: LayoutStateOptions = {}) {
    this.name = layout.name;
    this.confirmTraversals = options.confirmTraversals ?? 3;

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

  /** Edge from one marker to another, if it exists. */
  findEdge(fromMarkerId: string, toMarkerId: string): LayoutEdge | undefined {
    return this.outgoingEdges.get(fromMarkerId)?.find((e) => e.to_marker_id === toMarkerId);
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
   * Record a train traversing from `fromMarkerId` to `toMarkerId`. If no
   * edge exists, infer one; if one does, increment its traversal count.
   * Inferred edges flip to confirmed once their counter hits the
   * configured threshold.
   *
   * Returns flags describing what changed so the scheduler can publish
   * a fresh layout snapshot when discovery has moved the graph forward.
   */
  recordTraversal(fromMarkerId: string, toMarkerId: string): RecordTraversalResult {
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
    return { inferredEdgeAdded: added, edgeConfirmed: shouldConfirm };
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
