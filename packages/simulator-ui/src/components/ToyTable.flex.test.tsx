import { type FlexState, clampFlex, jointKey } from '@trainframe/simulator/track/flex.js';
/**
 * Unit tests for `applyFlex` — the effective-pose helper that bends a rest-pose
 * layout through a FlexState.
 *
 * These are pure-function tests: no React rendering, no broker, no physics.
 * The test validates:
 *   1. Empty flex → output is structurally identical to input (byte-identical
 *      positions, same rotation values as numbers).
 *   2. A non-zero joint flex → the second piece in a chain acquires the bent
 *      (non-45°-lattice) effective rotation, while the anchor stays at rest.
 *   3. Disconnected pieces (no joint) are unaffected by flex entries.
 */
import { buildJoints } from '@trainframe/simulator/track/loops.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { describe, expect, it } from 'vitest';
import { applyFlex } from './ToyTable.js';

/* Helper: a minimal TrackPiece. */
function makePiece(
  id: string,
  x: number,
  y: number,
  rotationDeg: 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315 = 0,
): TrackPiece {
  return { id, type: 'straight', position: { x, y }, rotationDeg, tagged: false };
}

describe('applyFlex', () => {
  it('with empty flex returns pieces with same positions and rotations', () => {
    const pieces: ReadonlyArray<TrackPiece> = [makePiece('A', 0, 0, 0), makePiece('B', 200, 0, 0)];
    const emptyFlex: FlexState = new Map();
    const effective = applyFlex(pieces, emptyFlex);

    expect(effective).toHaveLength(2);
    expect(effective[0]?.position.x).toBeCloseTo(0);
    expect(effective[0]?.position.y).toBeCloseTo(0);
    expect(effective[0]?.rotationDeg).toBeCloseTo(0);
    expect(effective[1]?.position.x).toBeCloseTo(200);
    expect(effective[1]?.position.y).toBeCloseTo(0);
    expect(effective[1]?.rotationDeg).toBeCloseTo(0);
  });

  it('with empty flex preserves all other piece fields', () => {
    const pieces: ReadonlyArray<TrackPiece> = [
      { ...makePiece('A', 0, 0), tagged: true, flipped: true },
    ];
    const emptyFlex: FlexState = new Map();
    const effective = applyFlex(pieces, emptyFlex);

    expect(effective[0]?.id).toBe('A');
    expect(effective[0]?.type).toBe('straight');
    expect(effective[0]?.tagged).toBe(true);
    expect(effective[0]?.flipped).toBe(true);
  });

  it('bends the second piece when a joint flex is applied', () => {
    /* Two straights snapped end-to-end along the x-axis.
     * Piece A at (0, 0) rotation 0°: endpoints at (-100, 0) and (100, 0).
     * Piece B at (200, 0) rotation 0°: endpoints at (100, 0) and (300, 0).
     * They join at (100, 0): A's endpoint 1 ↔ B's endpoint 0. */
    const pieces: ReadonlyArray<TrackPiece> = [makePiece('A', 0, 0, 0), makePiece('B', 200, 0, 0)];

    /* Discover the joint so we can build its key correctly. */
    const joints = buildJoints(pieces);
    expect(joints).toHaveLength(1);
    const joint = joints[0];
    if (joint === undefined) throw new Error('expected one joint');

    const delta = clampFlex(1, 0, 0); /* 1° rotational flex at the joint. */
    const flex: FlexState = new Map([[jointKey(joint), { joint, ...delta }]]);

    const effective = applyFlex(pieces, flex);

    /* Anchor (A) stays at rest. */
    expect(effective[0]?.id).toBe('A');
    expect(effective[0]?.position.x).toBeCloseTo(0);
    expect(effective[0]?.position.y).toBeCloseTo(0);
    expect(effective[0]?.rotationDeg).toBeCloseTo(0);

    /* Child (B) is bent by 1°: rotationDeg is no longer on the 45° lattice. */
    expect(effective[1]?.id).toBe('B');
    expect(effective[1]?.rotationDeg).toBeCloseTo(1);
    /* The joint at (100, 0) rotates B's attachment vector by 1°, so B's centre
     * moves off the x-axis — the y-coordinate becomes sin(1°)×100 ≈ 1.74 mm. */
    expect(effective[1]?.position.y).toBeCloseTo(Math.sin((1 * Math.PI) / 180) * 100, 3);
  });

  it('does not affect a disconnected piece when flex is applied elsewhere', () => {
    /* Three pieces: A-B are snapped; C is floating alone. */
    const pieces: ReadonlyArray<TrackPiece> = [
      makePiece('A', 0, 0, 0),
      makePiece('B', 200, 0, 0),
      makePiece('C', 800, 400, 90),
    ];
    const joints = buildJoints(pieces);
    /* Only A–B joint exists. */
    const joint = joints[0];
    if (joint === undefined) throw new Error('expected one joint');

    const delta = clampFlex(1.5, 0, 0);
    const flex: FlexState = new Map([[jointKey(joint), { joint, ...delta }]]);
    const effective = applyFlex(pieces, flex);

    /* C is in its own component; its rest pose is unchanged. */
    const c = effective.find((p) => p.id === 'C');
    expect(c?.position.x).toBeCloseTo(800);
    expect(c?.position.y).toBeCloseTo(400);
    expect(c?.rotationDeg).toBeCloseTo(90);
  });

  it('returns empty array for empty input', () => {
    expect(applyFlex([], new Map())).toHaveLength(0);
  });
});
