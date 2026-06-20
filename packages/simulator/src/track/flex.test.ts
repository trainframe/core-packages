import { describe, expect, it } from 'vitest';
import { FLEX_BUDGET_DEG, type FlexState, clampFlex, effectivePoses, jointKey } from './flex.js';
import { buildJoints } from './loops.js';
import type { TrackPiece } from './pieces.js';

/* Three straight pieces snapped end-to-end in a horizontal open chain.
 * Piece 0: centre at (0, 0)   → endpoints at (−100, 0) and (100, 0)
 * Piece 1: centre at (200, 0) → endpoints at (100, 0)  and (300, 0)
 * Piece 2: centre at (400, 0) → endpoints at (300, 0)  and (500, 0)
 * Joints (canonical lex ordering): joints[0] = p0:ep1 | p1:ep0 at x=100
 *                                  joints[1] = p1:ep1 | p2:ep0 at x=300
 */
function buildOpenChainOfThree(): [TrackPiece, TrackPiece, TrackPiece] {
  return [
    { id: 'p0', type: 'straight', position: { x: 0, y: 0 }, rotationDeg: 0, tagged: false },
    { id: 'p1', type: 'straight', position: { x: 200, y: 0 }, rotationDeg: 0, tagged: false },
    { id: 'p2', type: 'straight', position: { x: 400, y: 0 }, rotationDeg: 0, tagged: false },
  ];
}

describe('clampFlex', () => {
  it('clamps heading to ±budget and give to ≤2 mm', () => {
    expect(clampFlex(10, 5, 0).deg).toBe(FLEX_BUDGET_DEG);
    expect(clampFlex(-10, 0, -5).deg).toBe(-FLEX_BUDGET_DEG);
    expect(clampFlex(0, 5, 0).dx).toBeCloseTo(2, 5);
  });

  it('passes through values within budget unchanged', () => {
    const r = clampFlex(1, 1, 1);
    expect(r.deg).toBe(1);
    expect(r.dx).toBeCloseTo(1, 10);
    expect(r.dy).toBeCloseTo(1, 10);
  });

  it('preserves give direction when clamping magnitude', () => {
    const r = clampFlex(0, 3, 4); /* magnitude = 5 → scale to 2 */
    expect(r.dx).toBeCloseTo((3 / 5) * 2, 5);
    expect(r.dy).toBeCloseTo((4 / 5) * 2, 5);
  });

  it('handles zero give without NaN', () => {
    const r = clampFlex(0, 0, 0);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
  });
});

describe('effectivePoses', () => {
  it('returns rest poses when flex is empty', () => {
    const [p0] = buildOpenChainOfThree();
    const chain = buildOpenChainOfThree();
    const poses = effectivePoses(chain, new Map() as FlexState, p0.id);
    expect(poses.get(p0.id)).toEqual({
      x: p0.position.x,
      y: p0.position.y,
      rotationDeg: p0.rotationDeg,
    });
  });

  it('all three pieces at rest pose when flex is empty', () => {
    const chain = buildOpenChainOfThree();
    const [p0] = chain;
    const poses = effectivePoses(chain, new Map() as FlexState, p0.id);
    for (const p of chain) {
      expect(poses.get(p.id)).toEqual({
        x: p.position.x,
        y: p.position.y,
        rotationDeg: p.rotationDeg,
      });
    }
  });

  it('a +2° joint deviation rotates the downstream subtree about the joint point', () => {
    const chain = buildOpenChainOfThree();
    const [p0, p1, p2] = chain;
    const joints = buildJoints(chain);
    const joint0 = joints[0];
    if (joint0 === undefined) throw new Error('expected at least one joint');
    const flex: FlexState = new Map([[jointKey(joint0), { joint: joint0, deg: 2, dx: 0, dy: 0 }]]);
    const poses = effectivePoses(chain, flex, p0.id);

    /* anchor is unchanged */
    expect(poses.get(p0.id)?.rotationDeg).toBe(p0.rotationDeg);

    /* piece 1 rotates by 2° */
    expect(poses.get(p1.id)?.rotationDeg).toBeCloseTo(p1.rotationDeg + 2, 3);

    /* piece 2 (downstream of piece 1) also accumulates the 2° */
    expect(poses.get(p2.id)?.rotationDeg).toBeCloseTo(p2.rotationDeg + 2, 3);
  });

  it('pivot is about the joint point, not the anchor', () => {
    const chain = buildOpenChainOfThree();
    const [p0, p1] = chain;
    const joints = buildJoints(chain);
    const joint0 = joints[0];
    if (joint0 === undefined) throw new Error('expected at least one joint');
    /* joint at (100, 0): rotating piece 1 by 2° about it should shift it */
    const flex: FlexState = new Map([[jointKey(joint0), { joint: joint0, deg: 2, dx: 0, dy: 0 }]]);
    const poses = effectivePoses(chain, flex, p0.id);
    const p1pose = poses.get(p1.id);
    expect(p1pose).toBeDefined();
    if (p1pose === undefined) return;

    /* After rotating piece 1's rest position (200, 0) about (100, 0) by 2°:
     * vector (100, 0) → rotated → (100·cos2°, 100·sin2°)
     * effective position ≈ (100 + 100·cos2°, 100·sin2°) */
    const expectedX = 100 + 100 * Math.cos((2 * Math.PI) / 180);
    const expectedY = 100 * Math.sin((2 * Math.PI) / 180);
    expect(p1pose.x).toBeCloseTo(expectedX, 3);
    expect(p1pose.y).toBeCloseTo(expectedY, 3);
  });

  it('give translation shifts child position without changing rotation', () => {
    const chain = buildOpenChainOfThree();
    const [p0, p1] = chain;
    const joints = buildJoints(chain);
    const joint0 = joints[0];
    if (joint0 === undefined) throw new Error('expected at least one joint');
    const flex: FlexState = new Map([[jointKey(joint0), { joint: joint0, deg: 0, dx: 1, dy: 0 }]]);
    const poses = effectivePoses(chain, flex, p0.id);
    const p1pose = poses.get(p1.id);
    expect(p1pose?.rotationDeg).toBeCloseTo(0, 5);
    expect(p1pose?.x).toBeCloseTo(201, 5);
  });

  it('returns all pieces in the map', () => {
    const chain = buildOpenChainOfThree();
    const [p0] = chain;
    const poses = effectivePoses(chain, new Map() as FlexState, p0.id);
    expect(poses.size).toBe(3);
  });
});
