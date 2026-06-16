import { describe, expect, it } from 'vitest';
import { compileLayout } from '../track/layout-from-pieces.js';
import { detectSameLayerOverlaps } from '../track/overlap.js';
import { buildRailyardDemo } from './railyard-demo.js';

const demo = buildRailyardDemo();
const layout = compileLayout(demo.pieces, 'railyard-demo');

function buildAdjacency(): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  for (const m of layout.markers) adj.set(m.id, new Set());
  for (const e of layout.edges) {
    adj.get(e.from_marker_id)?.add(e.to_marker_id);
    adj.get(e.to_marker_id)?.add(e.from_marker_id);
  }
  return adj;
}

function reachable(adj: ReadonlyMap<string, Set<string>>, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const next = queue.pop();
    if (next === undefined) break;
    for (const n of adj.get(next) ?? []) {
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen;
}

describe('railyard demo layout', () => {
  it('closes into one connected loop with no same-layer overlaps', () => {
    // A single large main loop with the railyard, turntable and lift-bridge all
    // spliced in-line — so the whole thing connects with nothing overlapping.
    const overlaps = detectSameLayerOverlaps(demo.pieces);
    expect([...overlaps]).toEqual([]);

    const adj = buildAdjacency();
    // Every marker reachable from the yard — one connected component.
    const fromYard = reachable(adj, demo.yardMarker);
    expect(fromYard.size).toBe(layout.markers.length);

    // No dead ends and no spurs: every marker has EXACTLY two neighbours — the
    // loop is a clean ring. The yard, turntable and lift-bridge all sit IN the
    // running line (degree two), so nothing trails off as a foul-prone branch.
    for (const m of layout.markers) {
      expect(adj.get(m.id)?.size ?? 0, `marker ${m.id} degree`).toBe(2);
    }
  });

  it('splices the railyard in-line on the running loop', () => {
    const markerIds = new Set(layout.markers.map((m) => m.id));
    // The yard's throat is a marker ON the ring (an in-line zone, not a branch) —
    // the topology railyard-swap-concurrent proves safe under concurrent trains.
    expect(markerIds.has(demo.yardMarker)).toBe(true);
    expect(demo.yardDeviceId).toBe('YARD-yard');
  });

  it('puts the turntable in the running line as a switched junction', () => {
    // The turntable is the demo's one switched point: it compiles to a junction
    // with THREE valid positions on a single marker (experimental 002's N-way
    // proof), and a circulating train routes trunk → stub through it, so the
    // scheduler throws it each pass.
    const junctionIds = layout.junctions.map((j) => j.marker_id);
    expect(junctionIds).toEqual(['M-turntable']);
    const turntable = layout.junctions.find((j) => j.marker_id === 'M-turntable');
    expect(turntable?.valid_positions).toEqual(['stub-a', 'stub-b', 'stub-c']);
    expect([...demo.switchDeviceIds]).toEqual(['SWITCH-turntable']);

    const switchedOutOfTurntable = layout.edges.filter(
      (e) => e.from_marker_id === 'M-turntable' && e.requires_switch_state !== undefined,
    );
    expect(switchedOutOfTurntable.length).toBeGreaterThanOrEqual(1);
  });

  it('puts the lift-bridge gate in the running line', () => {
    const markerIds = new Set(layout.markers.map((m) => m.id));
    // The lift-bridge is an inline block boundary the trains traverse; a
    // BRIDGE-{id} clearance gate gates its marker (seated/passable for the demo).
    expect(markerIds.has(demo.liftBridgeMarker)).toBe(true);
    expect(demo.liftBridgeDeviceId).toBe('BRIDGE-lift-bridge');
  });

  it('runs four trains, each homed at a distinct station with a yard-calling cycle', () => {
    const markerIds = new Set(layout.markers.map((m) => m.id));
    expect(demo.trains.length).toBe(4);

    // Four home stations, one per train, spread around the loop.
    for (const s of ['stn-red', 'stn-green', 'stn-blue', 'stn-amber']) {
      expect(markerIds.has(`M-${s}`), `station ${s}`).toBe(true);
    }

    // Each active train homes at a DISTINCT station and calls at the yard.
    const homes = demo.trains.map((t) => t.homeMarker);
    expect(new Set(homes).size).toBe(demo.trains.length);
    const liveIds = new Set(demo.liveIds);
    for (const train of demo.trains) {
      expect(train.stops, `${train.deviceId} calls at the yard`).toContain(demo.yardMarker);
      expect(markerIds.has(train.homeMarker), `${train.deviceId} home`).toBe(true);
      for (const stop of train.stops) {
        expect(markerIds.has(stop), `${train.deviceId} stop ${stop}`).toBe(true);
      }
      // Each train carries a three-wagon rake of one livery; those carriage
      // pieces exist and are live so the loader can seed + render them.
      expect(train.consist).toHaveLength(3);
      for (const carriage of train.consist) {
        expect(liveIds.has(carriage.id), `carriage ${carriage.id} live`).toBe(true);
      }
    }
  });

  it('staggers the yard visit so the four do not converge on the throat at once', () => {
    // Part of the deadlock fix: the four trains do NOT all hit the single-marker
    // yard throat at the same point in their cycles. Two opposite-side trains
    // call it first (half a loop apart, so spaced in time) and two call it later,
    // giving several distinct yard slots rather than one shared moment.
    const yardSlots = demo.trains.map((t) => t.stops.indexOf(demo.yardMarker));
    expect(new Set(yardSlots).size).toBeGreaterThanOrEqual(3);
  });

  it('seeds the yard with two purple spares', () => {
    expect(demo.yardSpares.map((c) => c.colorId)).toEqual(['purple', 'purple']);
  });
});
