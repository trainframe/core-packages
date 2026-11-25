/**
 * The `YardLayout` seam the `YardController` drives (slot geometry, the two leads and
 * the nominal ladder switch labels), plus the straight-rail helper the piece-free
 * physics scenes build on.
 */
import type { RailNetwork } from './network.js';
import type { Rail } from './rail.js';

/** A straight rail segment between two world points (curvature/slope zero). */
export function straightSeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ends: { startBuffered?: boolean; endBuffered?: boolean } = {},
): Rail {
  const dx = bx - ax;
  const dy = by - ay;
  const length = Math.hypot(dx, dy);
  const headingDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
  return {
    length,
    at: (d) => {
      const t = length === 0 ? 0 : d / length;
      return { x: ax + dx * t, y: ay + dy * t, headingDeg };
    },
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: ends.startBuffered ?? false,
    endBuffered: ends.endBuffered ?? false,
  };
}

/** A segment's world endpoints — for bounds + the controller's slot positions. */
export interface YardSegGeom {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

export interface YardLayout {
  readonly net: RailNetwork;
  /** Segment id → world endpoints. */
  readonly geom: ReadonlyMap<string, YardSegGeom>;
  readonly leadWest: string;
  readonly leadEast: string;
  readonly slots: readonly string[];
  readonly westSwitch: string;
  readonly eastSwitch: string;
}
