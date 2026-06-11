/**
 * The CameraProvider seam (ADR-030 §2).
 *
 * A camera is a DUMB, time-sampled sensor. It perceives ONLY the track
 * physically beneath its footprint at its current position — never identity,
 * never length, never the ground-truth makeup of a train. Each sample answers a
 * single question: is something under the footprint right now, and if so, what
 * colour is it?
 *
 *   - In the simulator the provider is backed by the authoritative physical
 *     world (`PhysicsWorld.bodies()`).
 *   - On real hardware the SAME interface is backed by OpenCV over a video feed.
 *
 * Device logic (the VisionStation) never changes between the two: it only ever
 * calls `perceive()` and integrates the result. To "look elsewhere" a multi-part
 * device must physically MOVE its camera (an actuator move) — there is no
 * whole-world query here, only a fixed spatial footprint.
 */

import type { BodyPose, PhysicsWorld } from '../physics/world.js';

/** A single dumb perception: what (if anything) is under the footprint now. */
export interface CameraPerception {
  /** Whether a body's extent currently overlaps the footprint. */
  readonly occupied: boolean;
  /** The colour of the body under the footprint, if any (and if it has one). */
  readonly colour?: string;
}

/** A swappable camera. The device perceives the world ONLY through this. */
export interface CameraProvider {
  /** Sample what is under the footprint right now. */
  perceive(): CameraPerception;
}

/**
 * A fixed circular footprint in world space: the camera sees the patch of track
 * within `radiusMm` of `(x, y)`. This is the vision station's stationary view of
 * its stretch of line — a fixed spatial footprint, never the whole world.
 */
export interface CameraFootprint {
  readonly x: number;
  readonly y: number;
  /** Capture radius (mm) of the footprint patch. */
  readonly radiusMm: number;
}

/** Body extents along the rail (ADR-030 world model): centre ± halfLen. */
const HALF_LEN_MM: Record<BodyPose['kind'], number> = { loco: 34, carriage: 30 };

/**
 * An optional occlusion predicate: `(x, y) => true` when the world point is
 * hidden from a camera (e.g. under a dark tunnel's roof — see `physics/tunnel`).
 * A camera consulting this returns EMPTY over an occluded footprint even though a
 * body is physically there — the honest blind camera, reading no ground truth.
 */
export type OcclusionPredicate = (x: number, y: number) => boolean;

/**
 * A sim-backed CameraProvider over a `PhysicsWorld`. It reads `world.bodies()`
 * and reports occupied + colour for the body whose extent covers the footprint.
 *
 * A body's extent is `halfLen` either side of its centre along its heading (loco
 * 34 mm, carriage 30 mm). We treat the footprint as a small circle that a body
 * covers when the footprint centre falls within `halfLen + radiusMm` of the
 * body's centre — the honest analogue of a fixed camera seeing the blob pass
 * beneath it. Only railed bodies are visible (a derailed / ran-off body has left
 * the footprint's stretch of line). When several bodies overlap, the nearest
 * centre wins, as a single fixed sensor would resolve.
 *
 * An optional `occluded` predicate models a covered footprint (a dark tunnel): if
 * the footprint centre is occluded the camera reports empty regardless of what is
 * physically beneath it — the sensing is genuinely blind, not a peek at the world.
 */
/** The railed body whose centre is nearest the footprint AND within reach, or
 *  undefined when nothing is beneath it. */
function nearestBodyUnder(
  world: PhysicsWorld,
  footprint: CameraFootprint,
): { colour: string | undefined } | undefined {
  let nearest: { gap: number; colour: string | undefined } | undefined;
  for (const body of world.bodies()) {
    if (body.mode !== 'railed') continue;
    const gap = Math.hypot(body.x - footprint.x, body.y - footprint.y);
    const reach = HALF_LEN_MM[body.kind] + footprint.radiusMm;
    if (gap <= reach && (nearest === undefined || gap < nearest.gap)) {
      nearest = { gap, colour: body.color };
    }
  }
  return nearest;
}

export function physicsCameraProvider(
  world: PhysicsWorld,
  footprint: CameraFootprint,
  occluded?: OcclusionPredicate,
): CameraProvider {
  return {
    perceive(): CameraPerception {
      if (occluded?.(footprint.x, footprint.y) === true) return { occupied: false };
      const nearest = nearestBodyUnder(world, footprint);
      if (nearest === undefined) return { occupied: false };
      return nearest.colour === undefined
        ? { occupied: true }
        : { occupied: true, colour: nearest.colour };
    },
  };
}
