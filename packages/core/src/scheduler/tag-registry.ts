/**
 * Runtime tag-to-entity binding. Populated by `tag_assignment` events that
 * flow through the scheduler; queried whenever a `tag_observed` event needs
 * resolving to a marker or a vehicle.
 *
 * Kept separate from `LayoutState` because the layout is the *structural*
 * world (markers, edges, switches) and tag bindings are *operational*: they
 * come and go as devices are registered in the garage, get reassigned, or
 * physically fail. Mixing the two muddles the discovery-mode work that
 * `LayoutState` will grow later.
 *
 * See ADR-007.
 */

export type TagKind = 'marker' | 'vehicle';

export interface TagAssignment {
  readonly kind: TagKind;
  readonly target_id: string;
}

export class TagRegistry {
  private readonly bindings = new Map<string, TagAssignment>();

  /**
   * Bind a tag to an entity. Overwrites any previous binding for the same
   * `tag_id`. The scheduler treats this as authoritative; downstream
   * subscribers see the new binding via retained state.
   */
  assign(tag_id: string, assignment: TagAssignment): void {
    this.bindings.set(tag_id, { kind: assignment.kind, target_id: assignment.target_id });
  }

  /**
   * Resolve a tag to its current binding, if any. Returns `undefined` when
   * the tag is unknown — the scheduler treats this as an anomaly.
   */
  resolve(tag_id: string): TagAssignment | undefined {
    return this.bindings.get(tag_id);
  }

  /**
   * Drop the binding for a tag. No-op if the tag was already unknown.
   * Currently called only from test fixtures; the protocol's
   * `tag_assignment` event has no "remove" flavour today.
   */
  unassign(tag_id: string): void {
    this.bindings.delete(tag_id);
  }

  /** Forget all tag bindings. */
  clear(): void {
    this.bindings.clear();
  }

  /** Snapshot of the current bindings. Test/debug helper. */
  entries(): ReadonlyArray<readonly [string, TagAssignment]> {
    return [...this.bindings.entries()];
  }
}
