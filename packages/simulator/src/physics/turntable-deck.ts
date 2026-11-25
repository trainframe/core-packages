import type { RailPose } from '../track/pieces.js';
import type { Rail } from './rail.js';
import type { DeckAngleHolder } from './turntable.js';

/** One point of the deck's geometry: the trunk rim and the pit centre, world mm. */
export interface DeckGeometry {
  readonly trunk: { readonly x: number; readonly y: number };
  readonly centre: { readonly x: number; readonly y: number };
}

/**
 * The deck of a placed turntable as one rail: a fixed arm from the trunk rim to the
 * pit centre, then the rotating bridge from the centre out to the rim at the live
 * `angle` (world degrees). The far end therefore sits wherever the actuator has
 * swung the bridge, and a body parked at the centre pivots with it.
 *
 * `reversed` runs the same span end to start, for a layout that drives the deck
 * from its rotating end towards the trunk.
 */
export function placedDeckRail(
  geometry: DeckGeometry,
  angle: DeckAngleHolder,
  reversed: boolean,
): Rail {
  const { trunk, centre } = geometry;
  const arm = Math.hypot(centre.x - trunk.x, centre.y - trunk.y);
  const armHeading = (Math.atan2(centre.y - trunk.y, centre.x - trunk.x) * 180) / Math.PI;
  const length = 2 * arm;

  const forward = (d: number): RailPose => {
    const clamped = Math.max(0, Math.min(length, d));
    if (clamped <= arm) {
      const t = clamped / arm;
      return {
        x: trunk.x + (centre.x - trunk.x) * t,
        y: trunk.y + (centre.y - trunk.y) * t,
        headingDeg: normalise(armHeading),
      };
    }
    const rad = (angle.deg * Math.PI) / 180;
    const out = clamped - arm;
    return {
      x: centre.x + out * Math.cos(rad),
      y: centre.y + out * Math.sin(rad),
      headingDeg: normalise(angle.deg),
    };
  };

  const at = reversed
    ? (d: number): RailPose => {
        const pose = forward(length - Math.max(0, Math.min(length, d)));
        return { ...pose, headingDeg: normalise(pose.headingDeg + 180) };
      }
    : forward;

  return {
    length,
    at,
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

function normalise(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
