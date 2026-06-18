/**
 * A trackside-marker SENSE seam (the dual of the actuators) — how a
 * `ScheduledTrainDevice` learns it has crossed a marker. A real loco carries a tag
 * reader that fires when a marker tag passes beneath it. The device consumes this
 * interface; the sim-backed reader (which watches the loco body's pose against the
 * markers' world points) lives in `sim/`. The device is agnostic to the backing.
 *
 * It owns no marker↔core mapping logic and no envelope: it only answers "which
 * marker did the reader just pass, and which way along its heading was it going?".
 * The device turns each crossing into a `tag_observed`.
 */

/** A marker projected to a fixed world point — what the reader physically meets.
 *  The composition root derives these from the scene's marker geometry. */
export interface MarkerPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /**
   * Discrete height layer the marker sits on (0 = ground). Optional: when set —
   * and the reader knows the body's own layer — a crossing only fires if the two
   * agree, so a ground train passing UNDER a grade-separated deck does not trip a
   * marker on the deck overhead (their world x,y coincide at the crossing). Absent
   * ⇒ pure 2D proximity (the single-layer default).
   */
  readonly layer?: number;
}

/** A single marker crossing: which marker, and the travel sense relative to the
 *  reader's heading at the moment it crossed. */
export type MarkerObservation = (markerId: string, direction: 'forward' | 'reverse') => void;

export interface MarkerSensor {
  /** Subscribe to marker crossings. Returns an unsubscribe function. */
  onMarker(handler: MarkerObservation): () => void;
  /** Sample once: fire `onMarker` for any marker the reader has entered range of
   *  since the previous sample. Driven each tick by the device. */
  sample(): void;
}
