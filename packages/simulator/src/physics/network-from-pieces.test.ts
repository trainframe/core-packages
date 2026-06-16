import { describe, expect, it } from 'vitest';
import { compileLayout } from '../track/layout-from-pieces.js';
import type { TrackPiece } from '../track/pieces.js';
import { buildMainLoopScene } from './interesting-layout.js';
import { compileNetwork } from './network-from-pieces.js';
import { type Cursor, PieceNetworkBuilder } from './piece-network.js';
import { PhysicsWorld } from './world.js';

/**
 * Source the acid test's input from REAL placed pieces. `PieceNetworkBuilder` lays
 * pieces with world positions then assembles them into a network we DON'T use —
 * we throw the network away and keep only `.pieces`, the free-placed
 * `TrackPiece[]`, then re-derive a network from scratch with `compileNetwork`. If
 * `compileNetwork`'s orientation/linking is correct, a train drives that
 * re-derived network identically to the builder's.
 */

/** A rounded-square loop of real pieces — eight 45° curves (360°) + straights, so
 *  it closes. (The `PieceNetworkBuilder` from its own test.) */
function ovalPieces(): readonly TrackPiece[] {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const side = [{ type: 'straight' as const }, { type: 'straight' as const }];
  const corner = [{ type: 'curve' as const }, { type: 'curve' as const }];
  b.run('loop', start, [
    ...side,
    ...corner,
    ...side,
    ...corner,
    ...side,
    ...corner,
    ...side,
    ...corner,
  ]);
  return b.build().pieces;
}

/** A facing turnout: a short main run into a junction, with a through run and a
 *  branch run off it (the builder's own `branchBuilder`). Free-placed pieces. */
function branchPieces(): readonly TrackPiece[] {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const after = b.run('main', start, [{ type: 'straight' }, { type: 'straight' }]);
  const { thruExit, branchExit } = b.junction('jt', 'jb', after);
  b.run('thruRun', thruExit, [{ type: 'straight' }, { type: 'straight' }]);
  b.run('branchRun', branchExit, [{ type: 'straight' }, { type: 'straight' }]);
  return b.build().pieces;
}

/** The segment id `compileNetwork` gave a piece (its first / only segment). */
function segOf(compiled: ReturnType<typeof compileNetwork>, pieceId: string): string {
  const segs = compiled.segmentsForPiece.get(pieceId);
  const s = segs?.[0];
  if (s === undefined) throw new Error(`no segment for piece ${pieceId}`);
  return s;
}

/** What driving a single body around the network for `ticks` reveals. */
interface DriveResult {
  /** The distinct segments the body visited (transitions actually fired). */
  readonly segments: Set<string>;
  /** The farthest the body ever got from where it started. */
  readonly maxDist: number;
  /** Whether it got far from start, then came back near it (a closed lap). */
  readonly returnedAfterFar: boolean;
  /** Whether it ever left the rails (derailed / ran off). */
  readonly everLeftRails: boolean;
}

/** Step the world driving the (single) body for `ticks` 1/60 s steps, recording
 *  what it does — the shared body of the loop-drive assertions. */
function drive(world: PhysicsWorld, ticks: number): DriveResult {
  const start = world.bodies()[0];
  if (start === undefined) throw new Error('no body');
  const startPt = { x: start.x, y: start.y };
  const segments = new Set<string>();
  let maxDist = 0;
  let returnedAfterFar = false;
  let everLeftRails = false;
  const DT = 1 / 60;
  for (let i = 0; i < ticks; i++) {
    world.step(DT);
    const b = world.bodies()[0];
    if (b === undefined) continue;
    segments.add(b.segment);
    if (b.fate !== 'on-rail' || b.mode !== 'railed') everLeftRails = true;
    const dist = Math.hypot(b.x - startPt.x, b.y - startPt.y);
    maxDist = Math.max(maxDist, dist);
    if (maxDist > 300 && dist < 40) returnedAfterFar = true;
  }
  return { segments, maxDist, returnedAfterFar, everLeftRails };
}

describe('compileNetwork — a physics network from free-placed pieces', () => {
  it('emits one segment per non-device piece (two for a junction) + their geometry', () => {
    const pieces = ovalPieces();
    const compiled = compileNetwork(pieces);
    /* 16 simple pieces → 16 segments, each with start/end geometry. */
    expect(compiled.net.segments()).toHaveLength(16);
    expect(compiled.geom.size).toBe(16);
    for (const piece of pieces) {
      const segs = compiled.segmentsForPiece.get(piece.id);
      expect(segs).toHaveLength(1);
      const g = compiled.geom.get(segOf(compiled, piece.id));
      expect(g).toBeDefined();
    }
  });

  it('a train drives the whole closed loop and returns, never leaving the rails', () => {
    const pieces = ovalPieces();
    const compiled = compileNetwork(pieces);
    const world = new PhysicsWorld(compiled.net);

    /* Start on some piece's segment near its start. */
    const firstPiece = pieces[0];
    if (firstPiece === undefined) throw new Error('no pieces');
    const startSeg = segOf(compiled, firstPiece.id);
    world.addBody({
      id: 'loco',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: startSeg,
      color: 'red',
      motion: 'forward',
      maxSpeed: 240,
    });

    const r = drive(world, 60 * 90);
    expect(r.everLeftRails).toBe(false); // links + orientation hold the body to the rails
    expect(r.maxDist).toBeGreaterThan(300); // it genuinely circulated
    expect(r.returnedAfterFar).toBe(true); // it came back — the loop closed on itself
    /* It transitioned through MANY segments (the links actually fire), not stuck on
     * one or two. */
    expect(r.segments.size).toBeGreaterThanOrEqual(8);
  });

  it('drives the loop the OTHER way too (links are bidirectional)', () => {
    const pieces = ovalPieces();
    const compiled = compileNetwork(pieces);
    const world = new PhysicsWorld(compiled.net);
    const firstPiece = pieces[0];
    if (firstPiece === undefined) throw new Error('no pieces');
    world.addBody({
      id: 'loco',
      kind: 'loco',
      railPos: 10,
      facing: -1, // face the other way → drives in reverse along the chain
      segment: segOf(compiled, firstPiece.id),
      color: 'blue',
      motion: 'forward',
      maxSpeed: 240,
    });
    const r = drive(world, 60 * 60);
    expect(r.everLeftRails).toBe(false); // stayed on the rails the whole way round
    expect(r.segments.size).toBeGreaterThanOrEqual(8); // circulated through the loop
  });

  it('agrees with compileLayout on the marker/segment count for the same pieces', () => {
    const pieces = ovalPieces();
    const compiled = compileNetwork(pieces);
    const layout = compileLayout(pieces, 'oval');
    /* One physics segment per non-junction piece, one logical marker per piece —
     * they describe the same 16 pieces. */
    expect(compiled.net.segments().length).toBe(layout.markers.length);
  });

  /** Map each segment id to the run ('through' / 'branch' / 'other') it belongs to,
   *  from the piece ids in the branch scene (the runs are prefixed `thruRun-` /
   *  `branchRun-`). */
  function runOfSegment(compiled: ReturnType<typeof compileNetwork>): Map<string, string> {
    const out = new Map<string, string>();
    for (const [pid, segs] of compiled.segmentsForPiece) {
      const run = pid.startsWith('thruRun-')
        ? 'through'
        : pid.startsWith('branchRun-')
          ? 'branch'
          : 'other';
      for (const s of segs) out.set(s, run);
    }
    return out;
  }

  /** Drive a train from the main run with the junction thrown to `pos`; return the
   *  run it ends up on (the through run or the branch run). */
  function runReachedWithSwitch(pos: string): string {
    const pieces = branchPieces();
    const compiled = compileNetwork(pieces);
    const world = new PhysicsWorld(compiled.net);

    /* The junction piece is the only junction; its marker id is the switch id. */
    const junction = pieces.find((p) => p.type === 'junction');
    if (junction === undefined) throw new Error('no junction piece');
    world.setSwitch(`M-${junction.id}`, pos);

    /* Start on the first main-run piece (ids prefixed `main-`). */
    const firstMain = pieces.find((p) => p.id.startsWith('main-'));
    if (firstMain === undefined) throw new Error('no main pieces');
    world.addBody({
      id: 'loco',
      kind: 'loco',
      railPos: 5,
      facing: 1,
      segment: segOf(compiled, firstMain.id),
      color: 'green',
      motion: 'forward',
      maxSpeed: 200,
    });

    const runOf = runOfSegment(compiled);
    const DT = 1 / 60;
    for (let i = 0; i < 60 * 30; i++) {
      world.step(DT);
      const run = runOf.get(world.bodies()[0]?.segment ?? '');
      if (run === 'through' || run === 'branch') return run;
    }
    return 'neither';
  }

  it('a junction routes the train down the through OR branch run per the switch', () => {
    /* `switchStateForEndpoint`: through endpoint → 'main', branch endpoint → 'divert'. */
    expect(runReachedWithSwitch('main')).toBe('through');
    expect(runReachedWithSwitch('divert')).toBe('branch');
  });

  it('the junction switch id equals the compileLayout junction marker id', () => {
    const pieces = branchPieces();
    const layout = compileLayout(pieces, 'branch');
    const junction = pieces.find((p) => p.type === 'junction');
    if (junction === undefined) throw new Error('no junction');
    /* The logical compiler declares the junction marker under the SAME id the
     * physics switch uses, so one `setSwitch` drives both views. */
    expect(layout.junctions.map((j) => j.marker_id)).toContain(`M-${junction.id}`);
  });

  it('skips device pieces (they contribute no segment)', () => {
    const pieces: readonly TrackPiece[] = [
      ...ovalPieces(),
      {
        id: 'dev-train',
        type: 'train',
        position: { x: 9999, y: 9999 },
        rotationDeg: 0,
        tagged: false,
      },
    ];
    const compiled = compileNetwork(pieces);
    expect(compiled.segmentsForPiece.has('dev-train')).toBe(false);
    expect(compiled.net.segments()).toHaveLength(16);
  });

  it('throws on a turntable (deferred) rather than emit a wrong network', () => {
    const pieces: readonly TrackPiece[] = [
      { id: 'tt', type: 'turntable', position: { x: 0, y: 0 }, rotationDeg: 0, tagged: false },
    ];
    expect(() => compileNetwork(pieces)).toThrow(/turntable/);
  });

  it('compiles multiple disconnected components', () => {
    /* Two separate ovals far apart — both should compile (32 segments). */
    const a = ovalPieces();
    const b = ovalPieces().map((p) => ({
      ...p,
      id: `b-${p.id}`,
      position: { x: p.position.x + 5000, y: p.position.y },
    }));
    const compiled = compileNetwork([...a, ...b]);
    expect(compiled.net.segments()).toHaveLength(32);
  });

  /* ── ACID TESTS — the real, multi-junction layout (the whole point) ─────────
   * The synthetic oval/branch tests above pass on the GREEDY orientation too; these
   * prove the layout that DERAILED it: 177 real pieces, 14 junctions, cycles, merges,
   * a sub-snap filler, satellite loops crossing the main on a height layer. A train
   * must lap it BOTH ways without ever leaving the rails, and a junction must let a
   * train CONVERGE through it (not only diverge). */

  /** Build the real scene, compile it, set EVERY junction through ('main'), and spawn
   *  a loco on the first non-junction piece facing `facing`. Returns the world + the
   *  compiled network so a test can drive it. */
  function realLoopWorld(facing: 1 | -1): {
    world: PhysicsWorld;
    compiled: ReturnType<typeof compileNetwork>;
  } {
    const scene = buildMainLoopScene();
    const compiled = compileNetwork(scene.pieces);
    const world = new PhysicsWorld(compiled.net);
    for (const piece of scene.pieces) {
      if (piece.type === 'junction') world.setSwitch(`M-${piece.id}`, 'main');
    }
    const firstSimple = scene.pieces.find(
      (p) => p.type !== 'junction' && compiled.segmentsForPiece.has(p.id),
    );
    if (firstSimple === undefined) throw new Error('no non-junction piece');
    world.addBody({
      id: 'T',
      kind: 'loco',
      segment: segOf(compiled, firstSimple.id),
      railPos: 20,
      facing,
      color: 'red',
      motion: 'forward',
      maxSpeed: 600,
    });
    return { world, compiled };
  }

  it('laps the REAL main-loop layout forwards without ever leaving the rails', () => {
    const { world, compiled } = realLoopWorld(1);
    expect(compiled.contradictions).toHaveLength(0); // the orientation is consistent
    const r = drive(world, 6000);
    expect(r.everLeftRails).toBe(false); // it stayed railed every single tick
    expect(r.maxDist).toBeGreaterThan(800); // it got genuinely far from start
    expect(r.returnedAfterFar).toBe(true); // and came back — a closed lap
  });

  it('laps the REAL main-loop layout the OTHER way too', () => {
    const { world } = realLoopWorld(-1);
    const r = drive(world, 6000);
    expect(r.everLeftRails).toBe(false);
    expect(r.maxDist).toBeGreaterThan(800);
    expect(r.returnedAfterFar).toBe(true);
  });

  it('a train CONVERGES through a junction from the branch onto the trunk side', () => {
    /* Drive a body sitting on the BRANCH run heading INTO the junction (toward the
     * trunk), switch thrown to 'divert', and assert it reaches the MAIN run — it
     * converged through the junction (a merge), not merely diverged out of one. */
    const pieces = branchPieces();
    const compiled = compileNetwork(pieces);
    expect(compiled.contradictions).toHaveLength(0);
    const world = new PhysicsWorld(compiled.net);

    const junction = pieces.find((p) => p.type === 'junction');
    if (junction === undefined) throw new Error('no junction piece');
    world.setSwitch(`M-${junction.id}`, 'divert');

    /* Start on the LAST branch-run piece (nearest the junction) facing back toward it.
     * The branch run was laid heading AWAY from the junction, so facing -1 drives the
     * body back into the junction. We try both facings and keep the one that heads in. */
    const branchRunPieces = pieces.filter((p) => p.id.startsWith('branchRun-'));
    const nearest = branchRunPieces[branchRunPieces.length - 1];
    if (nearest === undefined) throw new Error('no branch-run pieces');
    const branchSeg = segOf(compiled, nearest.id);

    const reachedMain = (facing: 1 | -1): boolean => {
      const w = new PhysicsWorld(compiled.net);
      w.setSwitch(`M-${junction.id}`, 'divert');
      w.addBody({
        id: 'loco',
        kind: 'loco',
        railPos: 5,
        facing,
        segment: branchSeg,
        color: 'green',
        motion: 'forward',
        maxSpeed: 200,
      });
      const mainSegs = new Set(
        pieces.filter((p) => p.id.startsWith('main-')).map((p) => segOf(compiled, p.id)),
      );
      for (let i = 0; i < 60 * 30; i++) {
        w.step(1 / 60);
        const seg = w.bodies()[0]?.segment;
        if (seg !== undefined && mainSegs.has(seg)) return true;
      }
      return false;
    };

    /* Whichever facing drives INTO the junction must converge onto the main run. */
    expect(reachedMain(1) || reachedMain(-1)).toBe(true);
  });
});
