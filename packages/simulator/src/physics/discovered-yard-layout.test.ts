/**
 * `discoveredYardLayout` — the general adapter that turns an arbitrary fan of REAL,
 * discovered slot segments (in the operator's `compileNetwork` net) into a
 * `YardController`-ready `YardLayout`, driving the operator's ACTUAL segments. No
 * synthetic net, no translation.
 *
 * We build a closed DRIVE-THROUGH yard (a passing-loop fan — two parallel roads between a
 * facing and a trailing turnout) from real Brio pieces (`PieceNetworkBuilder`), compile it
 * with `compileNetwork` exactly as the toy table does, DISCOVER the slots under a gantry
 * footprint, and prove the returned layout's slot geom matches those real segments'
 * endpoints, its leads + ladder switches are real junctions in the SAME net, and a
 * `YardController` constructs over it.
 */
import { describe, expect, it } from 'vitest';
import { Crane } from '../devices/crane.js';
import type { MotorActuator } from '../devices/motor-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { YardController, craneBounds } from '../devices/yard-controller.js';
import type { TrackPiece } from '../track/pieces.js';
import { discoverYardSlots } from './discover-yard.js';
import { discoveredYardLayout } from './discovered-yard-layout.js';
import { compileNetwork } from './network-from-pieces.js';
import { addPassingLoop } from './passing-loop.js';
import { type Cursor, PieceNetworkBuilder } from './piece-network.js';

/** A closed drive-through yard from real pieces: an approach lead, a passing loop (a
 *  facing turnout into a parallel siding rejoining at a trailing turnout — two stabling
 *  roads), and an onward lead. The two roads (the main mid + the loop siding) are the
 *  gantry's slots; the approach + onward are its leads. Free-placed pieces the toy table
 *  would compile. */
function yardFanPieces(): readonly TrackPiece[] {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 0, layer: 0 };
  const lead = b.run('approach', start, [
    { type: 'straight' },
    { type: 'straight' },
    { type: 'straight' },
  ]);
  const { exit, segments, inbound } = addPassingLoop(b, lead, {
    prefix: 'P',
    parallelStraights: 3,
  });
  b.link('approach', inbound);
  b.run('onward', exit, [{ type: 'straight' }, { type: 'straight' }, { type: 'straight' }]);
  b.link(segments.mergeThrough, 'onward');
  b.link(segments.mergeBranch, 'onward');
  return b.build().pieces;
}

/** A gantry footprint over the parallel band only — the two roads (the main mid at y≈0
 *  and the loop siding at y≈129), with the approach / onward leads running out either
 *  side of it. */
const FOOTPRINT = { minX: 1050, maxX: 1700, minY: -30, maxY: 160 } as const;

function junctionSwitchIds(pieces: readonly TrackPiece[]): string[] {
  return pieces.filter((p) => p.type === 'junction').map((p) => `M-${p.id}`);
}

function discoverFan(pieces: readonly TrackPiece[]): {
  compiled: ReturnType<typeof compileNetwork>;
  slots: string[];
  swIds: string[];
} {
  const compiled = compileNetwork(pieces);
  const slots = discoverYardSlots(compiled.net.segments(), compiled.geom, FOOTPRINT, 150);
  return { compiled, slots, swIds: junctionSwitchIds(pieces) };
}

describe('discoveredYardLayout — a YardLayout from an arbitrary discovered slot fan', () => {
  it('discovers the two parallel roads under the footprint', () => {
    const pieces = yardFanPieces();
    const { slots } = discoverFan(pieces);
    /* The two stabling roads (the main mid + the loop siding) arrive as several
     *  collinear segments each — at least four under the band. */
    expect(slots.length).toBeGreaterThanOrEqual(4);
  });

  it('coalesces the discovered segments into two slots and projects their REAL endpoints', () => {
    const pieces = yardFanPieces();
    const { compiled, slots, swIds } = discoverFan(pieces);

    const yard = discoveredYardLayout(compiled.net, compiled.geom, slots, {
      junctionSwitchIds: swIds,
    });
    expect(yard).not.toBeNull();
    if (yard === null) return;

    /* Two coalesced roads → two slots. */
    expect(yard.layout.slots).toHaveLength(2);

    /* Each slot's geom spans the FULL road (mouth → foot), and both extreme endpoints
     *  coincide with a real discovered segment endpoint — the operator's actual rail. */
    const pts = slots.flatMap((s) => {
      const sg = compiled.geom.get(s);
      return sg === undefined ? [] : [sg.start, sg.end];
    });
    const onPoint = (x: number, y: number): boolean =>
      pts.some((p) => Math.hypot(p.x - x, p.y - y) < 1);
    for (const slotId of yard.layout.slots) {
      const g = yard.layout.geom.get(slotId);
      expect(g).toBeDefined();
      if (g === undefined) continue;
      const span = Math.hypot(g.ax - g.bx, g.ay - g.by);
      /* A road of multiple 200 mm pieces — genuinely long, not a collapsed point. */
      expect(span).toBeGreaterThan(360);
      expect(onPoint(g.ax, g.ay)).toBe(true);
      expect(onPoint(g.bx, g.by)).toBe(true);
    }
  });

  it('infers the entry + exit leads and the per-slot ladder throws (real junction switches)', () => {
    const pieces = yardFanPieces();
    const { compiled, slots, swIds } = discoverFan(pieces);

    const yard = discoveredYardLayout(compiled.net, compiled.geom, slots, {
      junctionSwitchIds: swIds,
    });
    expect(yard).not.toBeNull();
    if (yard === null) return;

    /* The leads are real, distinct, non-slot segments in the SAME compiled net (the
     *  running line, not internal connectors). */
    expect(compiled.net.segments()).toContain(yard.layout.leadWest);
    expect(compiled.net.segments()).toContain(yard.layout.leadEast);
    expect(yard.layout.leadWest).not.toBe(yard.layout.leadEast);
    expect(yard.layout.slots).not.toContain(yard.layout.leadWest);
    expect(yard.layout.slots).not.toContain(yard.layout.leadEast);

    /* Every ladder throw names a REAL discovered junction switch and a valid position. */
    const throws = yard.ladder.flatMap((l) => [l.west, l.east].filter((t) => t !== null));
    expect(throws.length).toBeGreaterThan(0);
    for (const t of throws) {
      if (t === null) continue;
      expect(swIds).toContain(t.switchId);
      expect(['main', 'divert']).toContain(t.position);
    }
    /* Both slots appear in the ladder; at least one is selected by a `divert` (the loop
     *  siding diverts off the facing turnout). */
    expect(yard.ladder.map((l) => l.slot).sort()).toEqual([...yard.layout.slots].sort());
    expect(throws.some((t) => t?.position === 'divert')).toBe(true);
  });

  it('returns null when fewer than two roads are discovered (the gantry stalls)', () => {
    const pieces = yardFanPieces();
    const { compiled, swIds } = discoverFan(pieces);
    /* Hand it a single road's segments only — no fan. */
    const oneRoad = discoverYardSlots(
      compiled.net.segments(),
      compiled.geom,
      { minX: 1050, maxX: 1700, minY: 100, maxY: 160 },
      150,
    );
    const yard = discoveredYardLayout(compiled.net, compiled.geom, oneRoad, {
      junctionSwitchIds: swIds,
    });
    expect(yard).toBeNull();
  });

  it('a YardController constructs over the discovered layout and ticks without throwing', () => {
    const pieces = yardFanPieces();
    const { compiled, slots, swIds } = discoverFan(pieces);
    const yard = discoveredYardLayout(compiled.net, compiled.geom, slots, {
      junctionSwitchIds: swIds,
    });
    expect(yard).not.toBeNull();
    if (yard === null) return;

    const entrySlot = yard.layout.slots[0];
    const sparesSlot = yard.layout.slots[1];
    expect(entrySlot).toBeDefined();
    expect(sparesSlot).toBeDefined();
    if (entrySlot === undefined || sparesSlot === undefined) return;

    /* A real `TrainDevice` over a no-op motor + no-op point actuators proves the
     *  controller binds over the discovered layout — its geometry (slot far ends, crane
     *  bounds) is well-formed. */
    const noMotor: MotorActuator = { set: () => undefined };
    const train = new TrainDevice('probe-loco', noMotor);
    const noop = { set: () => undefined };
    const bounds = craneBounds(yard.layout);
    const crane = new Crane(bounds, {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    });
    const controller = new YardController({
      layout: yard.layout,
      train,
      westPoints: noop,
      eastPoints: noop,
      look: () => ({ occupied: false }),
      cameraRadius: 20,
      wedgeAt: () => undefined,
      crane,
      entrySlot,
      sparesSlot,
    });
    expect(controller.currentPhase).toBe('route-in');
    controller.tick(0.1);
    expect(['route-in', 'rest']).toContain(controller.currentPhase);
  });
});
