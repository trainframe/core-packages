/**
 * A trackside-marker SENSE seam (the dual of the actuators) — how a
 * `ScheduledTrainDevice` learns it has crossed a marker WITHOUT reading the
 * physics world's ground-truth position. A real loco carries a tag reader that
 * fires when a marker tag passes beneath it; here the reader is modelled by
 * watching the loco BODY's world pose against the markers' world points.
 *
 * It owns no marker↔core mapping logic and no envelope: it only answers "which
 * marker did the body just pass, and which way along its heading was it going?".
 * The device turns each crossing into a `tag_observed`. DOM-free, deterministic
 * (a function of the world poses it samples, nothing else).
 *
 * The sensor fires AT MOST once per pass over a marker: a marker the body is
 * currently within range of is "armed off" until the body has left that range,
 * so dwelling on top of a marker does not spam crossings.
 */
import type { PhysicsWorld } from '../physics/world.js';

/** A marker projected to a fixed world point — what the reader physically meets.
 *  The composition root derives these from the scene's marker geometry. */
export interface MarkerPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** A single marker crossing: which marker, and the travel sense relative to the
 *  body's heading at the moment it crossed. */
export type MarkerObservation = (markerId: string, direction: 'forward' | 'reverse') => void;

export interface MarkerSensor {
  /** Subscribe to marker crossings. Returns an unsubscribe function. */
  onMarker(handler: MarkerObservation): () => void;
  /** Sample the world once: fire `onMarker` for any marker the body has entered
   *  range of since the previous sample. Driven each tick by the device. */
  sample(): void;
}

/** Capture radius (mm): the body's centre must come within this of a marker
 *  point for the reader to see it. Generous enough to catch a fast body between
 *  ticks, tight enough that adjacent markers don't both fire. */
const DEFAULT_CAPTURE_RADIUS = 36;

/**
 * A physics-backed marker sensor. It tracks one body's pose across `sample()`
 * calls; on the tick the body's centre enters a marker's capture radius it fires
 * the crossing once, tagging the direction by projecting the body's movement
 * since the last sample onto its heading (moving the way it points → `forward`,
 * the opposite way → `reverse`).
 */
export function physicsMarkerSensor(
  world: PhysicsWorld,
  bodyId: string,
  markers: readonly MarkerPoint[],
  captureRadius: number = DEFAULT_CAPTURE_RADIUS,
): MarkerSensor {
  const handlers = new Set<MarkerObservation>();
  /** Marker ids the body is currently within range of — armed-off until it leaves. */
  const within = new Set<string>();
  let prev: { x: number; y: number } | undefined;

  const poseOf = (): { x: number; y: number; headingDeg: number } | undefined => {
    const body = world.bodies().find((b) => b.id === bodyId);
    if (body === undefined) return undefined;
    return { x: body.x, y: body.y, headingDeg: body.rotationDeg };
  };

  const directionFrom = (
    pose: { x: number; y: number; headingDeg: number },
    from: { x: number; y: number } | undefined,
  ): 'forward' | 'reverse' => {
    if (from === undefined) return 'forward';
    const dx = pose.x - from.x;
    const dy = pose.y - from.y;
    const rad = (pose.headingDeg * Math.PI) / 180;
    const along = dx * Math.cos(rad) + dy * Math.sin(rad);
    return along >= 0 ? 'forward' : 'reverse';
  };

  const fire = (markerId: string, direction: 'forward' | 'reverse'): void => {
    for (const h of [...handlers]) h(markerId, direction);
  };

  /** Update one marker's armed/within state against the body pose, firing the
   *  crossing the first tick the body enters range and re-arming once it leaves. */
  const visit = (
    m: MarkerPoint,
    pose: { x: number; y: number },
    direction: 'forward' | 'reverse',
  ): void => {
    const inRange = Math.hypot(pose.x - m.x, pose.y - m.y) <= captureRadius;
    if (inRange && !within.has(m.id)) {
      within.add(m.id);
      fire(m.id, direction);
    } else if (!inRange && within.has(m.id)) {
      within.delete(m.id);
    }
  };

  return {
    onMarker(handler: MarkerObservation): () => void {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    sample(): void {
      const pose = poseOf();
      if (pose === undefined) return;
      const direction = directionFrom(pose, prev);
      for (const m of markers) visit(m, pose, direction);
      prev = { x: pose.x, y: pose.y };
    },
  };
}
