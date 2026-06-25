import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { selectAnchor, solveFollow } from './flex-solver.js';
import { applyFlex } from './flex.js';
import { buildJoints, connectedComponents } from './loops.js';
import { normalizeJointGaps } from './normalize.js';
import { type TrackPiece, getEndpoints } from './pieces.js';

/*
 * Part 3 — connectivity on a real loaded layout (test-track-layout.json).
 *
 * Two invariants the operator relies on:
 *  (1) every joint the operator made renders connected — once a layout loads, the
 *      two endpoints each joint connects sit within the rail width (no false gap);
 *  (2) flexing any one piece never changes the connected-component count elsewhere.
 */

const FIXTURE = fileURLToPath(new URL('../../../../test-track-layout.json', import.meta.url));

/* Sub-rail-width: a 26mm-wide plank (PLANK_HALF_WIDTH 13mm) covers a gap this
   small, so the joint reads as touching, not a gap. */
const RENDERS_CONNECTED_MM = 5;

function loadFixture(): TrackPiece[] {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as TrackPiece[];
}

/* The widest world-space gap (mm) between the two endpoints any joint connects. */
function widestJointGap(pieces: ReadonlyArray<TrackPiece>): number {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  let max = 0;
  for (const j of buildJoints(pieces)) {
    const pa = byId.get(j.a.pieceId);
    const pb = byId.get(j.b.pieceId);
    if (pa === undefined || pb === undefined) continue;
    const ea = getEndpoints(pa)[j.a.endpointIdx];
    const eb = getEndpoints(pb)[j.b.endpointIdx];
    if (ea === undefined || eb === undefined) continue;
    max = Math.max(max, Math.hypot(ea.x - eb.x, ea.y - eb.y));
  }
  return max;
}

describe('Part 3 — loaded layout connectivity', () => {
  it('the raw fixture has a visible false gap (reproduction)', () => {
    // Documents the bug: loaded layouts carry residual loop-closing gaps far
    // wider than the rail, so operator-joined pieces render disconnected.
    expect(widestJointGap(loadFixture())).toBeGreaterThan(RENDERS_CONNECTED_MM);
  });

  it('normalising closes every operator-joined seam to render connected', () => {
    const normalized = normalizeJointGaps(loadFixture());
    const gap = widestJointGap(normalized);
    expect(gap, `widest joint gap after normalise ${gap.toFixed(2)}mm`).toBeLessThan(
      RENDERS_CONNECTED_MM,
    );
  });

  it('normalising preserves the connected-component structure (no joint lost or gained)', () => {
    const raw = loadFixture();
    const normalized = normalizeJointGaps(raw);
    expect(buildJoints(normalized).length).toBe(buildJoints(raw).length);
    expect(connectedComponents(normalized).length).toBe(connectedComponents(raw).length);
  });

  it('normalising is idempotent — re-running moves nothing further', () => {
    const once = normalizeJointGaps(loadFixture());
    const twice = normalizeJointGaps(once);
    let maxMove = 0;
    const byId = new Map(once.map((p) => [p.id, p]));
    for (const p of twice) {
      const o = byId.get(p.id);
      if (o === undefined) continue;
      maxMove = Math.max(
        maxMove,
        Math.hypot(p.position.x - o.position.x, p.position.y - o.position.y),
      );
    }
    expect(maxMove, `max further move ${maxMove.toFixed(3)}mm`).toBeLessThan(0.5);
  });

  it('flexing any one piece never severs a joint elsewhere (realistic flex)', () => {
    // Drive the same solveFollow the toy-table flex gesture uses: bend the chain
    // from the dragged piece's anchor, in several directions. A single flex must
    // never change the connected-component count.
    const pieces = normalizeJointGaps(loadFixture());
    const base = connectedComponents(pieces).length;
    for (const p of pieces) {
      const ep = getEndpoints(p)[0];
      if (ep === undefined) continue;
      const dirs: ReadonlyArray<readonly [number, number]> = [
        [30, 0],
        [0, 30],
        [-30, 0],
        [0, -30],
        [25, 25],
      ];
      for (const [dx, dy] of dirs) {
        const flex = solveFollow(pieces, p.id, { x: ep.x + dx, y: ep.y + dy });
        if (flex.size === 0) continue; // non-anchored (closed loop) — flex disabled
        const flexed = applyFlex(pieces, flex, selectAnchor(pieces, p.id)) as TrackPiece[];
        const comps = connectedComponents(flexed).length;
        expect(comps, `flexing ${p.id} toward (${dx},${dy}) changed components`).toBe(base);
      }
    }
  });
});
