import { describe, expect, it } from 'vitest';
import type { Rail } from '../physics/rail.js';
import { PhysicsWorld } from '../physics/world.js';
import { type CameraFootprint, physicsCameraProvider } from './camera-provider.js';
import { VisionStation } from './vision-station.js';

/** A synthetic straight rail along +x — railPos maps directly to world x. */
function straightRail(length: number): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered: false,
  };
}

const LOCO_HALF = 34;
const CARRIAGE_HALF = 30;

/**
 * Build a coupled rake (loco leading at +x, carriages trailing behind it) with
 * adjacent centres spaced exactly at the sum of their half-lengths, so the bodies
 * sit nose-to-tail and the camera sees one continuous blob. Returns the world,
 * the body ids, and the physical span (front edge of loco → rear edge of last
 * carriage) the camera should perceive (before adding footprint radius).
 */
function buildRake(
  rail: Rail,
  opts: { locoTail: number; carriages: number; maxSpeed: number },
): { world: PhysicsWorld; locoId: string; spanMm: number } {
  const world = new PhysicsWorld(rail);
  const locoCentre = opts.locoTail + LOCO_HALF;
  world.addBody({
    id: 'L',
    kind: 'loco',
    railPos: locoCentre,
    facing: 1,
    motion: 'forward',
    maxSpeed: opts.maxSpeed,
    // Huge power so it pins to the maxSpeed cap near-instantly → a known constant
    // speed for the dwell→length maths (the dynamics otherwise vary speed by load).
    power: 1_000_000,
  });
  let prevCentre = locoCentre;
  let prevHalf = LOCO_HALF;
  let prevId = 'L';
  for (let i = 0; i < opts.carriages; i++) {
    const centre = prevCentre - (prevHalf + CARRIAGE_HALF);
    const id = `C${i}`;
    world.addBody({ id, kind: 'carriage', railPos: centre, facing: 1 });
    world.couple(prevId, id);
    prevCentre = centre;
    prevHalf = CARRIAGE_HALF;
    prevId = id;
  }
  const rearEdge = prevCentre - prevHalf;
  const frontEdge = locoCentre + LOCO_HALF;
  return { world, locoId: 'L', spanMm: frontEdge - rearEdge };
}

/**
 * Run a rake past the camera, firing the two marker crossings as the loco centre
 * passes them, and return the length the VisionStation reports.
 */
function measureLength(opts: {
  carriages: number;
  maxSpeed: number;
  footprint: CameraFootprint;
  markerAX: number;
  markerBX: number;
}): { reported: number | undefined; spanMm: number; footprint: CameraFootprint } {
  const rail = straightRail(4000);
  const { world, locoId, spanMm } = buildRake(rail, {
    locoTail: 400,
    carriages: opts.carriages,
    maxSpeed: opts.maxSpeed,
  });
  const camera = physicsCameraProvider(world, opts.footprint);

  let reported: number | undefined;
  const station = new VisionStation({
    markerA: 'MA',
    markerB: 'MB',
    baselineMm: Math.abs(opts.markerBX - opts.markerAX),
    camera,
    onLength: (mm) => {
      reported = mm;
    },
  });

  const dt = 0.01;
  let t = 0;
  let crossedA = false;
  let crossedB = false;
  for (let i = 0; i < 4000; i++) {
    const before = locoX(world, locoId);
    world.step(dt);
    t += dt;
    const after = locoX(world, locoId);
    if (!crossedA && before < opts.markerAX && after >= opts.markerAX) {
      station.onMarkerCrossed('MA', t);
      crossedA = true;
    }
    if (!crossedB && before < opts.markerBX && after >= opts.markerBX) {
      station.onMarkerCrossed('MB', t);
      crossedB = true;
    }
    station.tick(dt);
    if (reported !== undefined) break;
  }
  return { reported, spanMm, footprint: opts.footprint };
}

function locoX(world: PhysicsWorld, id: string): number {
  const p = world.bodies().find((b) => b.id === id);
  if (p === undefined) throw new Error(`no body ${id}`);
  return p.x;
}

describe('VisionStation — measures length honestly via two-marker speed', () => {
  const footprint: CameraFootprint = { x: 1500, y: 0, radiusMm: 20 };
  const markerAX = 600;
  const markerBX = 1100;

  /* The camera reports occupied while a body centre is within halfLen + radius
   * of the footprint, so the dwell-derived span exceeds the physical span by the
   * footprint radius at each end. */
  const expectedFor = (spanMm: number) => spanMm + 2 * footprint.radiusMm;
  /* Both the marker crossings and the dwell are sampled on the discrete tick, so
   * the reading carries a few mm of quantisation error — exactly the kind of
   * tolerance a real vision sensor lives with. */
  const TOLERANCE_MM = 6;

  it('measures a single-carriage rake at a slow speed', () => {
    const { reported, spanMm } = measureLength({
      carriages: 1,
      maxSpeed: 200,
      footprint,
      markerAX,
      markerBX,
    });
    expect(reported).toBeDefined();
    expect(Math.abs((reported ?? Number.NaN) - expectedFor(spanMm))).toBeLessThan(TOLERANCE_MM);
  });

  it('measures a three-carriage rake at a fast speed (speed is MEASURED, not assumed)', () => {
    const slow = measureLength({ carriages: 3, maxSpeed: 200, footprint, markerAX, markerBX });
    const fast = measureLength({ carriages: 3, maxSpeed: 500, footprint, markerAX, markerBX });

    expect(slow.reported).toBeDefined();
    expect(fast.reported).toBeDefined();
    /* Same physical train, two different speeds → same measured length. If speed
     * were assumed rather than measured from the markers, these would diverge. */
    expect(Math.abs((slow.reported ?? Number.NaN) - expectedFor(slow.spanMm))).toBeLessThan(
      TOLERANCE_MM,
    );
    expect(Math.abs((fast.reported ?? Number.NaN) - expectedFor(fast.spanMm))).toBeLessThan(
      TOLERANCE_MM,
    );
    expect(Math.abs((fast.reported ?? Number.NaN) - (slow.reported ?? Number.NaN))).toBeLessThan(
      2 * TOLERANCE_MM,
    );
  });

  it('a longer rake reads longer than a shorter one', () => {
    const short = measureLength({ carriages: 1, maxSpeed: 300, footprint, markerAX, markerBX });
    const long = measureLength({ carriages: 4, maxSpeed: 300, footprint, markerAX, markerBX });
    expect(long.reported ?? 0).toBeGreaterThan((short.reported ?? 0) + 100);
  });

  it('does NOT emit a bogus length when only one marker is crossed (no speed)', () => {
    const rail = straightRail(4000);
    const { world, locoId, spanMm } = buildRake(rail, {
      locoTail: 400,
      carriages: 2,
      maxSpeed: 300,
    });
    expect(spanMm).toBeGreaterThan(0);
    const camera = physicsCameraProvider(world, footprint);

    let reported: number | undefined;
    const station = new VisionStation({
      markerA: 'MA',
      markerB: 'MB',
      baselineMm: 500,
      camera,
      onLength: (mm) => {
        reported = mm;
      },
    });

    const dt = 0.01;
    let t = 0;
    let crossedA = false;
    /* Drive the whole train past the camera but only ever fire markerA: with no
     * second crossing the station has no speed, so it must stay silent. */
    for (let i = 0; i < 4000; i++) {
      const before = locoX(world, locoId);
      world.step(dt);
      t += dt;
      const after = locoX(world, locoId);
      if (!crossedA && before < markerAX && after >= markerAX) {
        station.onMarkerCrossed('MA', t);
        crossedA = true;
      }
      station.tick(dt);
    }
    expect(crossedA).toBe(true);
    expect(reported).toBeUndefined();
  });
});
