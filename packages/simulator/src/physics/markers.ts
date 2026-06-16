/**
 * The shared marker model: a logical marker pinned to a physics segment, and a
 * junction marker paired to a physics switch. Core's view of a layout is the set
 * of these (`SceneMarker[]` + `SceneJunction[]`); physics knows only segments.
 *
 * One source of truth for both scene families — the bezier `BranchingScene`
 * (`branching-scene.ts`) and the real-piece railyard (`railyard-markers.ts`) —
 * so the two compilers cannot drift in what a marker anchor means.
 *
 * Pure data shapes: no I/O, no clock, no randomness.
 */
import type { LayoutMarker } from '@trainframe/protocol';

/** Which segment end a marker is anchored at. */
export type MarkerEnd = 'start' | 'end';

/** The protocol marker-kind union (no `MarkerKind` type is exported from the
 *  protocol package, so derive it from `LayoutMarker.kind` — the canonical
 *  source, which includes `yard_entry`/`unspecified`). */
export type MarkerKind = LayoutMarker['kind'];

/** A logical marker pinned to a physics segment. Core's view of the layout is
 *  the set of these; physics knows only segments. */
export interface SceneMarker {
  readonly id: string;
  /** Physics segment id this marker is anchored to. */
  readonly segment: string;
  /** Anchored at this segment end (omit when `distAlongMm` is set). */
  readonly end: MarkerEnd;
  /** Set instead of `end` for a mid-segment station marker (distance along the
   *  rail from its start, mm). */
  readonly distAlongMm?: number;
  /** Protocol marker kind. */
  readonly kind: MarkerKind;
}

/** A junction-kind marker paired to a physics switch + its valid positions. */
export interface SceneJunction {
  readonly markerId: string;
  readonly switchId: string;
  readonly positions: readonly string[];
}
