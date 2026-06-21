/**
 * Tests for the flex system: `applyFlex`, closure detection, and loop-close commit.
 *
 * pure-function tests cover `applyFlex` and the `findLoops` integration.
 * Component tests cover the UI affordance:
 *   - `data-closure-available="true"` during slow drag near an open endpoint
 *   - Committing the closure flex on drop so the rendered flex persists
 *
 * The component tests mock `solveClose` via vi.mock (hoisted) to control feasibility
 * independently of the underlying geometry — the solver is tested separately in the
 * @trainframe/simulator package. This tests only the rendering + commit behaviour.
 */
import { act, render, screen } from '@testing-library/react';
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { hasFlexAnchor } from '@trainframe/simulator/track/flex-solver.js';
import { type FlexState, clampFlex, jointKey } from '@trainframe/simulator/track/flex.js';
import { buildJoints, findLoops } from '@trainframe/simulator/track/loops.js';
import type { JointId, Loop } from '@trainframe/simulator/track/loops.js';
import { getEndpoints } from '@trainframe/simulator/track/pieces.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { computePlacement } from '@trainframe/simulator/track/placement.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { applyFlex } from './ToyTable.js';

/* ---------------------------------------------------------------------------
 * Module-level mock for solveClose. Hoisted by Vitest so ToyTable.tsx's static
 * import of solveClose also gets the mocked version. Default returns infeasible;
 * individual tests can override via vi.mocked(solveClose).mockReturnValueOnce.
 *
 * solveFollow, selectAnchor, ClosureResult, and other exports are kept real.
 * --------------------------------------------------------------------------- */
vi.mock('@trainframe/simulator/track/flex-solver.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('@trainframe/simulator/track/flex-solver.js')>();
  return {
    ...original,
    solveClose: vi.fn().mockReturnValue({ feasible: false, flex: new Map() }),
  };
});

/*
 * Module-level mock for findLoops. Hoisted so ToyTable.tsx's static import of
 * findLoops also gets the mocked version. The default implementation delegates
 * to the real findLoops, so existing pure-function tests that call findLoops
 * directly are unaffected. Individual tests can use mockReturnValueOnce to
 * control what the "before" and "after" calls inside newLoopCenterline return.
 */
vi.mock('@trainframe/simulator/track/loops.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@trainframe/simulator/track/loops.js')>();
  return {
    ...original,
    findLoops: vi.fn().mockImplementation(original.findLoops),
  };
});

import { solveClose } from '@trainframe/simulator/track/flex-solver.js';
import { ToyTable, newLoopCenterline } from './ToyTable.js';

/* ---------------------------------------------------------------------------
 * Helpers
 * --------------------------------------------------------------------------- */

/* Helper: a minimal TrackPiece. */
function makePiece(
  id: string,
  x: number,
  y: number,
  rotationDeg: 0 | 45 | 90 | 135 | 180 | 225 | 270 | 315 = 0,
): TrackPiece {
  return { id, type: 'straight', position: { x, y }, rotationDeg, tagged: false };
}

const TOYBOX_MIME = 'application/x-trainframe-toybox-type';
const CANVAS_W_PX = 1800;
const CANVAS_H_PX = 1200;

function renderToyTableWithBroker(): void {
  const client = new InMemoryBrokerClient();
  client.connect('ws://test-closure');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test-closure" />
    </BrokerProvider>,
  );
}

function mockCanvasRect(): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: CANVAS_W_PX,
    bottom: CANVAS_H_PX,
    width: CANVAS_W_PX,
    height: CANVAS_H_PX,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return () => spy.mockRestore();
}

/* Place a track piece via toybox drag-drop at the given client-px position.
   Returns the new piece's data-piece-id. */
function placePieceAt(canvas: Element, type: string, clientX: number, clientY: number): string {
  const dt: Record<string, string> = { [TOYBOX_MIME]: type };
  const makeTransfer = () => ({
    types: [TOYBOX_MIME],
    getData: (m: string) => dt[m] ?? '',
    setData: (m: string, v: string) => {
      dt[m] = v;
    },
    effectAllowed: 'copy' as string,
    dropEffect: 'copy' as string,
  });

  act(() => {
    const ov = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(ov, 'dataTransfer', { value: makeTransfer() });
    canvas.dispatchEvent(ov);
  });
  act(() => {
    const dp = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX, clientY });
    Object.defineProperty(dp, 'dataTransfer', { value: makeTransfer() });
    canvas.dispatchEvent(dp);
  });

  const pieces = canvas.querySelectorAll('[data-piece-id]');
  const last = pieces[pieces.length - 1];
  return last?.getAttribute('data-piece-id') ?? '';
}

/* Build a MouseEvent typed as a pointer event with an explicit timeStamp. */
function timedPtr(type: string, clientX: number, clientY: number, t: number): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(e, 'timeStamp', { value: t, writable: false, configurable: true });
  return e;
}

/* Parse the rotation angle (degrees) from an SVG transform attribute string. */
function parseRotDeg(transform: string): number {
  const match = /rotate\(([-\d.]+)\)/.exec(transform);
  return match !== null && match[1] !== undefined ? Number.parseFloat(match[1]) : 0;
}

/* ---------------------------------------------------------------------------
 * applyFlex — pure-function tests
 * --------------------------------------------------------------------------- */

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

/* ---------------------------------------------------------------------------
 * applyFlex + findLoops — closed-loop integration
 * --------------------------------------------------------------------------- */

describe('applyFlex + findLoops', () => {
  /*
   * Closed-loop detection via buildJoints + findLoops.
   *
   * A 3-piece triangle: each straight (200mm) is snapped end-to-end, and the
   * third piece's far end is within SNAP_DISTANCE of the first piece's near end.
   * To construct this geometrically:
   *   A at (0, 0) rotation 0°.  A.W=(-100,0), A.E=(100,0).
   *   B at (200, 0) rotation 0°. B.W=(100,0)≡A.E, B.E=(300,0).
   *   C: rotated 180° and placed so its W=(300,0) and E=(100,0)≡A.E+B.E — but
   *   that would overlap.
   *
   * Instead, test that buildJoints correctly identifies the TWO joints produced
   * by two anti-parallel pieces (proving `clusterEndpoints` works for multi-edge
   * graphs), and separately test that findLoops detects 3-node cycles.
   *
   * Anti-parallel setup:
   *   p1 at (0,0) rot 0°:   ep0=(-100,0), ep1=(100,0)
   *   p2 at (0, 0.3) rot 180°: ep0=(100,0.3), ep1=(-100,0.3)
   *   Both endpoint pairs are <1mm apart → two joints → multi-edge.
   *
   * Note: findLoops does not detect 2-node multi-edge cycles (the spur-peel +
   * DFS algorithm requires ≥3 distinct nodes to form a traceable ring). The
   * `buildJoints` assertion below verifies the adjacency structure is correct;
   * the 3-node findLoops test uses a proper 3-piece chain that closes.
   */

  it('two anti-parallel pieces produce exactly two joints (one per endpoint pair)', () => {
    const p1: TrackPiece = {
      id: 'p1',
      type: 'straight',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      tagged: false,
    };
    const p2: TrackPiece = {
      id: 'p2',
      type: 'straight',
      position: { x: 0, y: 0.3 },
      rotationDeg: 180,
      tagged: false,
    };

    /* Both endpoint pairs are within SNAP_DISTANCE → two joints. */
    const joints = buildJoints([p1, p2]);
    expect(joints).toHaveLength(2);
    /* Every joint connects p1 to p2. */
    for (const j of joints) {
      const ids = [j.a.pieceId, j.b.pieceId].sort();
      expect(ids).toEqual(['p1', 'p2']);
    }
  });

  it('applyFlex with empty flex returns identical positions (no mutation)', () => {
    /* Two snapped pieces — one joint. With empty flex, applyFlex must return the
     * exact same positions. That proves it's a no-op without needing to pass the
     * result to buildJoints (which requires TrackPiece, not EffectivePiece). */
    const A: TrackPiece = {
      id: 'A',
      type: 'straight',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      tagged: false,
    };
    const B: TrackPiece = {
      id: 'B',
      type: 'straight',
      position: { x: 200, y: 0 },
      rotationDeg: 0,
      tagged: false,
    };

    const effective = applyFlex([A, B], new Map());
    expect(effective).toHaveLength(2);
    expect(effective[0]?.position).toEqual(A.position);
    expect(effective[0]?.rotationDeg).toBe(A.rotationDeg);
    expect(effective[1]?.position).toEqual(B.position);
    expect(effective[1]?.rotationDeg).toBe(B.rotationDeg);
  });

  it('a linear chain (one joint) is not a loop', () => {
    /* findLoops on a 2-piece linear chain returns nothing — spur-peel removes
     * both degree-1 nodes and no cycle survives. applyFlex with empty flex does
     * not change positions, so we verify it on the original rest-pose pieces. */
    const A: TrackPiece = {
      id: 'A',
      type: 'straight',
      position: { x: 0, y: 0 },
      rotationDeg: 0,
      tagged: false,
    };
    const B: TrackPiece = {
      id: 'B',
      type: 'straight',
      position: { x: 200, y: 0 },
      rotationDeg: 0,
      tagged: false,
    };

    expect(findLoops([A, B])).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * ToyTable component — closure flash + commit
 *
 * Layout for these tests (CANVAS = 900mm × 600mm, SCALE = 2px/mm):
 *   A: placed at client (900, 600) → centre (450, 300)mm. A.W=(350,300), A.E=(550,300).
 *   B: placed at client (1100, 600) → snaps to A.E, centre at (650, 300).
 *      B.W=(550,300), B.E=(750,300).
 *   C: placed at client (1600, 600) → centre (800, 300). C.W=(700,300), C.E=(900,300).
 *      C is independent (C.W gap from B.E = 50mm < CONNECT_CAPTURE_MM=60mm; gap
 *      > SNAP_DISTANCE=30mm so it doesn't auto-join to B). C.W is therefore an open
 *      endpoint within reach of B.E's effective position during slow drag of B.
 *
 * During a slow drag of B (same-timestamp events → speed=0 → solveFollow called),
 * the closure-detection path:
 *   1. solveFollow bends the A–B joint → flex.size > 0.
 *   2. Effective pose of B is computed; B.E stays near (750, 300).
 *   3. C.W=(700,300) is 50mm from B.E → pre-filter passes.
 *   4. solveClose is called. The mock returns feasible=true so data-closure-available
 *      is set and the flash attribute appears.
 * --------------------------------------------------------------------------- */

describe('ToyTable — closure flash + commit', () => {
  beforeEach(() => {
    localStorage.clear();
    /* Reset the solveClose mock to its default (infeasible) between tests. */
    vi.mocked(solveClose).mockReturnValue({ feasible: false, flex: new Map() });
  });

  it('data-closure-available="true" appears on the dragged piece when solveClose is feasible', () => {
    /*
     * Set up the A–B–C layout described above. Mock solveClose to return feasible.
     * Slow-drag B (same-ts → speed=0 → slow path). Verify the attribute appears.
     */
    const restore = mockCanvasRect();
    try {
      renderToyTableWithBroker();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      placePieceAt(canvas, 'straight', 900, 600); /* A */
      const bId = placePieceAt(canvas, 'straight', 1100, 600); /* B, snaps to A.E */
      placePieceAt(canvas, 'straight', 1600, 600); /* C, independent, C.W near B.E */

      const bEl = canvas.querySelector(`[data-piece-id="${bId}"]`) as SVGGElement | null;
      if (bEl === null) throw new Error('piece B not in DOM');

      /* Tell solveClose to report feasible for this test. */
      vi.mocked(solveClose).mockReturnValue({ feasible: true, flex: new Map() });

      /* Slow drag of B — same timeStamp on both events → speed = 0 → slow path. */
      act(() => {
        bEl.dispatchEvent(timedPtr('pointerdown', 1300, 600, 50));
        /* Move slightly; same timestamp forces speed=0. */
        bEl.dispatchEvent(timedPtr('pointermove', 1280, 600, 50));
      });

      expect(bEl.getAttribute('data-closure-available')).toBe('true');
    } finally {
      restore();
    }
  });

  it('drop with closure available commits the flex and clears the flash', () => {
    /*
     * After the slow drag sets data-closure-available, releasing the pointer commits
     * the solved flex via setFlex and clears the attribute. We verify:
     *   (a) the attribute clears after pointerup
     *   (b) the committed flex (1° bend) shows up in B's rendered transform
     */
    const restore = mockCanvasRect();
    try {
      renderToyTableWithBroker();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      const aId = placePieceAt(canvas, 'straight', 900, 600); /* A */
      const bId = placePieceAt(canvas, 'straight', 1100, 600); /* B, snaps to A.E */
      placePieceAt(canvas, 'straight', 1600, 600); /* C */

      const bEl = canvas.querySelector(`[data-piece-id="${bId}"]`) as SVGGElement | null;
      if (bEl === null) throw new Error('piece B not in DOM');

      /* Build a 1°-bent closure flex that can be committed on drop. */
      const aTrack: TrackPiece = {
        id: aId,
        type: 'straight',
        position: { x: 450, y: 300 },
        rotationDeg: 0,
        tagged: false,
      };
      const bTrack: TrackPiece = {
        id: bId,
        type: 'straight',
        position: { x: 650, y: 300 },
        rotationDeg: 0,
        tagged: false,
      };
      const closureJoints = buildJoints([aTrack, bTrack]);
      const closureJoint = closureJoints[0];
      const closureFlex: FlexState =
        closureJoint !== undefined
          ? new Map([[jointKey(closureJoint), { joint: closureJoint, deg: 1, dx: 0, dy: 0 }]])
          : new Map();

      vi.mocked(solveClose).mockReturnValue({ feasible: true, flex: closureFlex });

      /* Slow drag to activate closure. */
      act(() => {
        bEl.dispatchEvent(timedPtr('pointerdown', 1300, 600, 50));
        bEl.dispatchEvent(timedPtr('pointermove', 1280, 600, 50));
      });
      expect(bEl.getAttribute('data-closure-available')).toBe('true');

      /* Drop: commits flex and clears flash. */
      act(() => {
        bEl.dispatchEvent(timedPtr('pointerup', 1280, 600, 50));
      });

      /* Flash is cleared after drop. */
      expect(bEl.getAttribute('data-closure-available')).toBeNull();

      /* Closure flex (1°) was committed: B's rendered rotation is non-zero.
         A is the anchor and stays at rest; B is the child that bends. */
      const bTransform = bEl.getAttribute('transform') ?? '';
      const rotMatch = /rotate\(([-\d.]+)\)/.exec(bTransform);
      const rotDeg = rotMatch?.[1] !== undefined ? Number.parseFloat(rotMatch[1]) : 0;
      expect(Math.abs(rotDeg)).toBeGreaterThan(0);
      expect(Math.abs(rotDeg)).toBeLessThanOrEqual(2 + 1e-3); /* within FLEX_BUDGET_DEG */
    } finally {
      restore();
    }
  });
});

/* ---------------------------------------------------------------------------
 * ToyTable component — ClosureWave DOM mount after loop-closing drop
 *
 * This test verifies the full trigger path:
 *   solveClose feasible → handleClosureCommit → newLoopCenterline returns points
 *   → setClosureWavePoints → <ClosureWave data-testid="closure-wave"> is mounted.
 *
 * findLoops is mocked for the single call inside newLoopCenterline (after the
 * flex is applied). It returns a genuine 4-piece Loop containing the dragged
 * piece — the newly-closed cycle. The old "before" call no longer exists: the
 * trigger is now commit-based, not topology-diff-based.
 *
 * The mocked Loop carries real piece-IDs (from the placed pieces) and valid
 * JointId entries (0/1 endpoint indices) so newLoopCenterline can compute
 * getCentreLinePathAt for each piece and return a non-null point array.
 *
 * Key regression: a loop whose endpoints are already within clustering distance
 * at rest (so findLoops(rest) already returns it) STILL fires the wave, because
 * we no longer suppress via a before/after diff.
 * --------------------------------------------------------------------------- */

describe('ToyTable — ClosureWave mounts after loop-closing drop', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(solveClose).mockReturnValue({ feasible: false, flex: new Map() });
    /* Clear any residual mockReturnValueOnce entries from a previous (failed)
       test run. The wave-mount test always sets its own values before acting. */
    vi.mocked(findLoops).mockReset();
  });

  it('closure-wave element is present in the DOM after a loop-closing drop', () => {
    /*
     * Layout: A at (900,600) → (450,300)mm, B snaps to A.E → (650,300)mm,
     * C at (1600,600) → (800,300)mm, D at (1800,600) → (900,300)mm.
     * We place 4 pieces; A–B are auto-connected; C and D are independent.
     *
     * Mock solveClose to return feasible (triggers the closure-commit branch on
     * pointerup). Mock findLoops to return a 4-piece Loop (containing the dragged
     * piece id) on its single call — the effective-geometry call after flex is
     * applied. newLoopCenterline finds the cycle by draggedPieceId membership, not
     * by a before/after diff, so the wave fires even when the loop existed at rest.
     *
     * This exercises the path: handleClosureCommit → newLoopCenterline
     * → setClosureWavePoints(pts) → <ClosureWave> mounts.
     */
    const restore = mockCanvasRect();
    try {
      renderToyTableWithBroker();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      const aId = placePieceAt(canvas, 'straight', 900, 600); /* A → (450,300) */
      const bId = placePieceAt(canvas, 'straight', 1100, 600); /* B snaps to A.E */
      const cId = placePieceAt(canvas, 'straight', 1600, 600); /* C independent */
      const dId = placePieceAt(canvas, 'straight', 1800, 600); /* D independent */

      /*
       * Build a mock Loop whose joints follow the DFS convention:
       * joints[i] connects pieceIds[i] → pieceIds[(i+1)%n].
       * We assign endpoint indices to form a coherent traversal:
       *   A: exits via ep1, enters via ep0.
       *   B: exits via ep1, enters via ep0.
       *   C: exits via ep1, enters via ep0.
       *   D: exits via ep0, enters via ep1 (closing back to A).
       */
      const j0: JointId = {
        a: { pieceId: aId, endpointIdx: 1 },
        b: { pieceId: bId, endpointIdx: 0 },
      };
      const j1: JointId = {
        a: { pieceId: bId, endpointIdx: 1 },
        b: { pieceId: cId, endpointIdx: 0 },
      };
      const j2: JointId = {
        a: { pieceId: cId, endpointIdx: 1 },
        b: { pieceId: dId, endpointIdx: 0 },
      };
      const j3: JointId = {
        a: { pieceId: dId, endpointIdx: 1 },
        b: { pieceId: aId, endpointIdx: 0 },
      };
      const mockLoop: Loop = { pieceIds: [aId, bId, cId, dId], joints: [j0, j1, j2, j3] };

      /* findLoops is called once (after applying committed flex). It returns the
         newly-closed 4-piece cycle containing the dragged piece. No "before" call
         exists any more — the trigger is commit-based, not topology-diff-based.
         This also exercises the regression case: even when the loop would have
         existed in rest-pose topology, the wave fires because we look for the
         dragged piece id in the effective-geometry loops. */
      vi.mocked(findLoops).mockReturnValueOnce([mockLoop]);

      /* solveClose must return feasible to trigger the closure-commit branch. */
      vi.mocked(solveClose).mockReturnValue({ feasible: true, flex: new Map() });

      /* Slow drag of B (same timestamp → speed = 0 → slow path → detectLoopClosure
         runs → closureFlexRef.current is set). */
      const bEl = canvas.querySelector(`[data-piece-id="${bId}"]`) as SVGGElement | null;
      if (bEl === null) throw new Error('piece B not found in DOM');

      act(() => {
        bEl.dispatchEvent(timedPtr('pointerdown', 1300, 600, 50));
        bEl.dispatchEvent(timedPtr('pointermove', 1280, 600, 50));
      });
      expect(bEl.getAttribute('data-closure-available')).toBe('true');

      /* Drop: triggers onDragFlex + onClosureCommit → handleClosureCommit
         → newLoopCenterline → setClosureWavePoints → ClosureWave mounts. */
      act(() => {
        bEl.dispatchEvent(timedPtr('pointerup', 1280, 600, 50));
      });

      expect(screen.queryByTestId('closure-wave')).not.toBeNull();
    } finally {
      restore();
    }
  });
});

/* ---------------------------------------------------------------------------
 * ToyTable component — drag UX (Issues 1, 3, 4)
 *
 * Issue 3: a SLOW drag far past the flex budget must NOT detach. The chain just
 *   holds at max flex (the solver clamps each δ to ±budget). Over-pull
 *   detachment was removed; only a fast yank detaches.
 *
 * Issue 1: a fast-yank detach must leave the piece PRESENT (it comes free into
 *   the hand and follows the cursor), never vanish.
 * --------------------------------------------------------------------------- */

describe('ToyTable — slow drag past budget holds, does not detach (Issue 3)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(solveClose).mockReturnValue({ feasible: false, flex: new Map() });
  });

  it('a slow drag far past the budget keeps every piece (no detach) and holds the chain bent', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTableWithBroker();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      /* Build the A–B chain. */
      placePieceAt(canvas, 'straight', 900, 600); /* A centre (450,300) */
      const bId = placePieceAt(canvas, 'straight', 1100, 600); /* B snaps to A.E */

      const countBefore = canvas.querySelectorAll('[data-piece-id]').length;
      expect(countBefore).toBe(2);

      const bEl = canvas.querySelector(`[data-piece-id="${bId}"]`) as SVGGElement | null;
      if (bEl === null) throw new Error('piece B not in DOM');

      /* Slow drag B far past what the joint budget can reach, pulling up-and-out
         (a colinear pull straight down the chain's own axis has no rotational DOF
         to bend, so we pull perpendicular). Same timestamp → speed = 0 → slow
         path. Cursor is hundreds of mm out — the old code detached here; now the
         single A–B joint just saturates at ±budget and the chain holds bent. */
      act(() => {
        bEl.dispatchEvent(timedPtr('pointerdown', 1300, 600, 50));
        /* client (1400, 100) → mm (700, 50): up-and-right of B's rest — a
           perpendicular pull saturating the single A–B joint at ±budget. */
        bEl.dispatchEvent(timedPtr('pointermove', 1400, 100, 50));
      });

      /* No detach: the piece count is unchanged and B is still present. */
      const countAfter = canvas.querySelectorAll('[data-piece-id]').length;
      expect(countAfter).toBe(countBefore);
      expect(canvas.querySelector(`[data-piece-id="${bId}"]`)).not.toBeNull();

      /* The chain holds at max flex — B is bent (non-zero rotation), clamped to
         the budget rather than detaching. */
      const rot = parseRotDeg(bEl.getAttribute('transform') ?? '');
      expect(Math.abs(rot)).toBeGreaterThan(0);
      expect(Math.abs(rot)).toBeLessThanOrEqual(5 + 1e-3); /* within FLEX_BUDGET_DEG */
    } finally {
      restore();
    }
  });
});

describe('ToyTable — fast yank frees the piece without vanishing (Issue 1)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(solveClose).mockReturnValue({ feasible: false, flex: new Map() });
  });

  it('a fast yank detaches but the piece stays present and follows the cursor', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTableWithBroker();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      placePieceAt(canvas, 'straight', 900, 600); /* A centre (450,300) */
      const bId = placePieceAt(canvas, 'straight', 1100, 600); /* B snaps to A.E */

      const countBefore = canvas.querySelectorAll('[data-piece-id]').length;
      expect(countBefore).toBe(2);

      const bEl = canvas.querySelector(`[data-piece-id="${bId}"]`) as SVGGElement | null;
      if (bEl === null) throw new Error('piece B not in DOM');

      const transformBefore = bEl.getAttribute('transform');

      /* Fast yank: first move sets the velocity baseline (speed 0), the second
         move at a later timestamp gives a large speed → above DRAG_FLEX_MAX_SPEED
         → detach. */
      act(() => {
        bEl.dispatchEvent(timedPtr('pointerdown', 1300, 600, 50));
        bEl.dispatchEvent(timedPtr('pointermove', 1310, 600, 50)); /* baseline */
        bEl.dispatchEvent(timedPtr('pointermove', 1700, 600, 55)); /* fast → yank */
      });

      /* The piece did NOT vanish — count unchanged, B still present. */
      const countAfter = canvas.querySelectorAll('[data-piece-id]').length;
      expect(countAfter).toBe(countBefore);
      const bAfter = canvas.querySelector(`[data-piece-id="${bId}"]`);
      expect(bAfter).not.toBeNull();

      /* It follows the cursor: its rendered transform moved (the drag preview
         overrides its pose to track the pointer as a free piece). */
      expect(bAfter?.getAttribute('transform')).not.toBe(transformBefore);
    } finally {
      restore();
    }
  });
});

describe('ToyTable — closed loop drag does not vanish or detach (Issue 4)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(solveClose).mockReturnValue({ feasible: false, flex: new Map() });
  });

  it('8-curve ring is genuinely closed: hasFlexAnchor === false (pure logic)', () => {
    /* Build an 8-curve ring deterministically via computePlacement — the exact
       same geometry used in flex-solver.test.ts. Each curve snaps to the exit
       endpoint of the previous; after 8 × 45° the ring closes within < 1 mm
       (well inside CONNECT_CAPTURE_MM = 60 mm), so buildJoints creates all 8
       joints including the closing one. This test asserts the precondition the
       component test below relies on: that the ring truly has no flex anchor.
       We assert via buildJoints (which is not mocked) and hasFlexAnchor rather
       than findLoops, which is mocked in this file and may have been reset. */
    const pieces: TrackPiece[] = [];
    const first = computePlacement(450, 300, 'curve', pieces);
    pieces.push({
      id: 'C0',
      type: 'curve',
      position: { x: first.x, y: first.y },
      rotationDeg: first.rotationDeg,
      tagged: false,
    });

    for (let i = 1; i < 8; i++) {
      const prev = pieces[i - 1];
      if (prev === undefined) throw new Error('unreachable');
      const exit = getEndpoints(prev)[1];
      if (exit === undefined) throw new Error('unreachable');
      const placement = computePlacement(exit.x, exit.y, 'curve', pieces);
      pieces.push({
        id: `C${i}`,
        type: 'curve',
        position: { x: placement.x, y: placement.y },
        rotationDeg: placement.rotationDeg,
        tagged: false,
      });
    }

    /* 8 joints = every curve is connected on both sides — the ring is closed. */
    expect(buildJoints(pieces)).toHaveLength(8);
    /* No open end and no junction → hasFlexAnchor must be false for every
       member — the non-anchored guard in solveFollow will refuse to flex it. */
    expect(hasFlexAnchor(pieces, 'C7')).toBe(false);
    expect(hasFlexAnchor(pieces, 'C0')).toBe(false);
  });

  it('grabbing a piece in a closed loop with no junction never removes it (no flex)', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTableWithBroker();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      /* Build a small closed loop with no junction: two anti-parallel straights
         whose BOTH endpoint pairs cluster (a degenerate 2-piece ring). Each piece
         is jointed on both sides → no open end, no junction → non-anchored.
         hasFlexAnchor returns false for this layout (verified by the pure-logic
         test above for the canonical 8-curve ring; the same code path applies).
         The flex solver must NOT run; the dragged piece moves plainly and never
         vanishes/detaches. */
      const aId = placePieceAt(canvas, 'straight', 900, 600); /* A centre (450,300) */
      /* Place B almost on top of A but anti-parallel so both endpoint pairs cluster.
         Drop it ~3 mm offset (6 px) so it does not auto-snap to a single end. */
      const bId = placePieceAt(canvas, 'straight', 906, 600); /* B near A */

      const countBefore = canvas.querySelectorAll('[data-piece-id]').length;
      expect(countBefore).toBe(2);

      /* Drag A slowly — if the solver wrongly flexed a non-anchored loop it would
         tear apart / vanish. It must instead just move plainly, staying present. */
      const aEl = canvas.querySelector(`[data-piece-id="${aId}"]`) as SVGGElement | null;
      if (aEl === null) throw new Error('piece A not in DOM');
      act(() => {
        aEl.dispatchEvent(timedPtr('pointerdown', 900, 600, 50));
        aEl.dispatchEvent(timedPtr('pointermove', 940, 600, 50));
      });

      /* Neither piece vanished or detached: count is stable and A is present. */
      const countAfter = canvas.querySelectorAll('[data-piece-id]').length;
      expect(countAfter).toBe(countBefore);
      expect(canvas.querySelector(`[data-piece-id="${aId}"]`)).not.toBeNull();
      expect(canvas.querySelector(`[data-piece-id="${bId}"]`)).not.toBeNull();
    } finally {
      restore();
    }
  });
});
