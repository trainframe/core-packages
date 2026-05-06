import type { Layout, LayoutEdge, LayoutMarker } from '@trainframe/protocol';

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
  private readonly markers = new Map<string, LayoutMarker>();
  private readonly outgoingEdges = new Map<string, LayoutEdge[]>();
  private readonly incomingEdges = new Map<string, LayoutEdge[]>();
  private readonly switchPositions = new Map<string, string>();

  constructor(layout: Layout) {
    for (const marker of layout.markers) {
      this.markers.set(marker.id, marker);
      this.outgoingEdges.set(marker.id, []);
      this.incomingEdges.set(marker.id, []);
    }

    for (const edge of layout.edges) {
      this.addEdgeInternal(edge);
    }

    for (const junction of layout.junctions) {
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
}
