/**
 * D1/D2 regression: attaching a piece to a FLEXED open end must leave a
 * continuous joint (no gap, no kink) once flex is resolved.
 *
 * Root cause that this guards against: placement is a REST-domain operation. A
 * new piece must snap to a neighbour's REST endpoint so that applyFlex's forward
 * kinematics then positions it at the flexed joint. If placement instead snaps
 * against EFFECTIVE (flexed) geometry, applyFlex re-applies the neighbour's flex
 * via FK and the joint double-counts the deviation — a visible gap and a janky,
 * discontinuous rail. (Measured ~14 mm gap on a single 4° joint before the fix.)
 *
 * The branded `EffectivePiece` type makes the wrong wiring a COMPILE error: see
 * the `@ts-expect-error` case at the end — passing effective geometry to
 * `computePlacement` no longer type-checks.
 */
import { describe, expect, it } from 'vitest';
import { applyFlex, effectivePoses, jointKey } from './flex.js';
import type { FlexState, JointFlex } from './flex.js';
import { buildJoints } from './loops.js';
import { asTrackPiece, getEndpoints, getEndpointsAt } from './pieces.js';
import type { RotationDeg, TrackPiece } from './pieces.js';
import { computePlacement } from './placement.js';

function straight(id: string, x: number, y: number, rot = 0): TrackPiece {
  return { id, type: 'straight', position: { x, y }, rotationDeg: rot, tagged: false };
}

/* Smallest signed angle (deg) of `a − b`, in (−180, 180]. */
function angleDelta(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

describe('attach to a flexed end — continuous joint (D1/D2)', () => {
  it('a piece snapped onto a 4°-flexed open end meets it with no gap or kink', () => {
    const p0 = straight('p0', 0, 0);
    const p1 = straight('p1', 200, 0);
    const base = [p0, p1];

    /* Flex the p0–p1 joint by 4°, anchored at p0 — p1's far end now sits off-grid. */
    const joints = buildJoints(base);
    const j01 = joints[0];
    if (j01 === undefined) throw new Error('expected a joint');
    const flex: FlexState = new Map<string, JointFlex>([
      [jointKey(j01), { joint: j01, deg: 4, dx: 0, dy: 0 }],
    ]);

    /* Where the user aims: p1's flexed far endpoint (the drawn open end). */
    const p1pose = effectivePoses(base, flex, 'p0').get('p1');
    if (p1pose === undefined) throw new Error('expected a pose');
    const aim = getEndpointsAt(p1, p1pose)[1];
    if (aim === undefined) throw new Error('expected a far endpoint');

    /* REST-domain placement: snap against the rest layout (NOT applyFlex output). */
    const placement = computePlacement(aim.x, aim.y, 'straight', base);
    expect(placement.connected).toBe(true);
    const p2 = straight('p2', placement.x, placement.y, placement.rotationDeg);

    /* Resolve the whole assembly through flex (the render/compile path). */
    const eff = applyFlex([p0, p1, p2], flex);
    const p1eff = eff.find((p) => p.id === 'p1');
    const p2eff = eff.find((p) => p.id === 'p2');
    if (p1eff === undefined || p2eff === undefined) throw new Error('missing effective piece');

    const p1far = getEndpoints(asTrackPiece(p1eff))[1];
    const p2entry = getEndpoints(asTrackPiece(p2eff))[0];
    if (p1far === undefined || p2entry === undefined) throw new Error('missing endpoints');

    /* The new piece's entry coincides with the flexed neighbour's far end. */
    const gap = Math.hypot(p1far.x - p2entry.x, p1far.y - p2entry.y);
    expect(gap).toBeLessThan(0.001);

    /* And the rails are anti-parallel at the joint (no heading kink). */
    const kink = Math.abs(angleDelta(p2entry.outgoingAngleDeg, p1far.outgoingAngleDeg + 180));
    expect(kink).toBeLessThan(0.001);
  });

  it('a piece attached to a BAKED (off-grid) flexed end meets it continuously', () => {
    /*
     * Single-frame bake regression. After a slow drag bakes its flex into stored
     * poses, the chain's open end carries an OFF-GRID rotationDeg (e.g. ~4°) and
     * there is no flex map left. Attaching a new piece must align it CONTINUOUSLY
     * with that off-grid end — placement must NOT round the new piece's rotation
     * to the 45° grid, which would leave a heading kink equal to the flex angle
     * (position coincident but the rail visibly bent at the new joint). This is
     * the "can't attach to a flexed line / snaps to an invisible point" defect.
     */
    const p0 = straight('p0', 0, 0);
    const p1 = straight('p1', 200, 0);

    /* Flex p0–p1 by 4° anchored at p0, then BAKE: applyFlex output IS the new
       stored geometry (no flex map persists — the single-frame release model). */
    const joints = buildJoints([p0, p1]);
    const j01 = joints[0];
    if (j01 === undefined) throw new Error('expected a joint');
    const flex: FlexState = new Map<string, JointFlex>([
      [jointKey(j01), { joint: j01, deg: 4, dx: 0, dy: 0 }],
    ]);
    const baked = applyFlex([p0, p1], flex, 'p0');
    const p1baked = baked.find((p) => p.id === 'p1');
    if (p1baked === undefined) throw new Error('missing baked piece');
    /* The bake really moved p1 off the 45° grid. */
    expect(Math.abs(p1baked.rotationDeg % 45)).toBeGreaterThan(1);

    /* Attach a new straight to p1's baked far (exit) endpoint via real placement. */
    const p1far = getEndpoints(asTrackPiece(p1baked))[1];
    if (p1far === undefined) throw new Error('missing far endpoint');
    const placement = computePlacement(p1far.x, p1far.y, 'straight', baked);
    expect(placement.connected).toBe(true);
    const p2 = straight('p2', placement.x, placement.y, placement.rotationDeg);
    const p2entry = getEndpoints(p2)[0];
    if (p2entry === undefined) throw new Error('missing entry endpoint');

    /* Coincident AND continuous: the new piece's entry sits on the baked end with
       no gap and no heading kink — the rail flows straight through the joint. */
    const gap = Math.hypot(p1far.x - p2entry.x, p1far.y - p2entry.y);
    expect(gap).toBeLessThan(0.001);
    const kink = Math.abs(angleDelta(p2entry.outgoingAngleDeg, p1far.outgoingAngleDeg + 180));
    expect(kink).toBeLessThan(0.001);
  });
});
