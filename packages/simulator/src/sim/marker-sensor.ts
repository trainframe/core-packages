/**
 * Sim-backed `MarkerSensor` (ADR-030/031): a tag reader modelled by watching one
 * loco body's pose against the markers' world points. This is sim-wiring, NOT
 * device logic — the only layer permitted to touch the world. The device receives
 * the `MarkerSensor` and never knows a world exists.
 *
 * Fires AT MOST once per pass over a marker: a marker the body is currently within
 * range of is "armed off" until the body has left that range, so dwelling on top
 * of a marker does not spam crossings. Deterministic (a function of the sampled
 * poses, nothing else).
 */
import type { MarkerObservation, MarkerPoint, MarkerSensor } from '../devices/marker-sensor.js';
import type { PhysicsWorld } from '../physics/world.js';

/** Capture radius (mm): the body's centre must come within this of a marker point
 *  for the reader to see it. Generous enough to catch a fast body between ticks,
 *  tight enough that adjacent markers don't both fire. */
const DEFAULT_CAPTURE_RADIUS = 36;

/**
 * A physics-backed marker sensor. It tracks one body's pose across `sample()`
 * calls; on the tick the body's centre enters a marker's capture radius it fires
 * the crossing once, tagging the direction by projecting the body's movement since
 * the last sample onto its heading (moving the way it points → `forward`, the
 * opposite way → `reverse`).
 */
export function physicsMarkerSensor(
  world: PhysicsWorld,
  bodyId: string,
  markers: readonly MarkerPoint[],
  captureRadius: number = DEFAULT_CAPTURE_RADIUS,
  /** Maps each network segment to its height layer. When supplied, a marker that
   *  declares a `layer` only fires while the body is on a same-layer segment — the
   *  grade-separation guard (a ground train ignores a deck marker overhead). Omit
   *  for single-layer scenes (pure 2D proximity). */
  segmentLayer?: ReadonlyMap<string, number>,
): MarkerSensor {
  const handlers = new Set<MarkerObservation>();
  /** Marker ids the body is currently within range of — armed-off until it leaves. */
  const within = new Set<string>();
  let prev: { x: number; y: number } | undefined;

  const poseOf = ():
    | { x: number; y: number; headingDeg: number; layer: number | undefined }
    | undefined => {
    const body = world.bodies().find((b) => b.id === bodyId);
    if (body === undefined) return undefined;
    return {
      x: body.x,
      y: body.y,
      headingDeg: body.rotationDeg,
      layer: segmentLayer?.get(body.segment),
    };
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
    pose: { x: number; y: number; layer: number | undefined },
    direction: 'forward' | 'reverse',
  ): void => {
    /* Grade-separation guard: a marker on a known layer is invisible to a body
     *  known to be on a different one (the deck-over-bypass crossing). When either
     *  layer is unknown, fall back to pure 2D proximity. */
    const wrongLayer = m.layer !== undefined && pose.layer !== undefined && m.layer !== pose.layer;
    const inRange = !wrongLayer && Math.hypot(pose.x - m.x, pose.y - m.y) <= captureRadius;
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
