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
  it('closes into one connected layout with no same-layer overlaps', () => {
    // Main loop + yard bypass branch, all on the 200 mm grid and snapping at the
    // junction branches — so the whole thing connects with nothing overlapping.
    const overlaps = detectSameLayerOverlaps(demo.pieces);
    expect([...overlaps]).toEqual([]);

    const adj = buildAdjacency();
    // Every marker reachable from the yard — one connected component (the yard is
    // off the main path, so this proves the bypass branch actually joins up).
    const fromYard = reachable(adj, demo.yardMarker);
    expect(fromYard.size).toBe(layout.markers.length);

    // No dead ends: every marker has at least two neighbours, and the SIX
    // junctions (yard branch J1/J2, two station branches J3/J4 and J5/J6) are
    // genuine three-way splits (trunk + through + branch).
    const junctions = [...adj].filter(([, n]) => n.size === 3).map(([id]) => id);
    expect(junctions.sort()).toEqual(['M-J1', 'M-J2', 'M-J3', 'M-J4', 'M-J5', 'M-J6']);
    for (const m of layout.markers) {
      expect(adj.get(m.id)?.size ?? 0, `marker ${m.id} degree`).toBeGreaterThanOrEqual(2);
    }
  });

  it('has the yard zone, six junctions, six stations, and trains on distinct journeys', () => {
    const markerIds = new Set(layout.markers.map((m) => m.id));
    expect(markerIds.has(demo.yardMarker)).toBe(true);
    // The yard + two branch loops are reached only through the junctions, which
    // carry switch devices.
    expect(demo.switchDeviceIds).toEqual([
      'SWITCH-J1',
      'SWITCH-J2',
      'SWITCH-J3',
      'SWITCH-J4',
      'SWITCH-J5',
      'SWITCH-J6',
    ]);
    for (const j of ['M-J1', 'M-J2', 'M-J3', 'M-J4', 'M-J5', 'M-J6']) {
      expect(markerIds.has(j), j).toBe(true);
    }

    // Four main stations (one home per train) + the two branch-loop stations.
    // The branch stations are BUILT even though no active train currently dwells
    // at them (the temporary scale-back — see railyard-demo.ts); they come back
    // into the schedules when the layout is enlarged.
    for (const s of ['stn-red', 'stn-green', 'stn-blue', 'stn-amber', 'stn-A', 'stn-B']) {
      expect(markerIds.has(`M-${s}`), `station ${s}`).toBe(true);
    }
    // Each active train calls at the yard, on its own main-line journey.
    for (const train of demo.trains) {
      expect(train.stops, `${train.deviceId} calls at the yard`).toContain(demo.yardMarker);
    }

    // Each active train homes at a DISTINCT station.
    const homes = demo.trains.map((t) => t.homeMarker);
    expect(new Set(homes).size).toBe(demo.trains.length);
    expect(demo.trains.length).toBeGreaterThanOrEqual(1);
    for (const train of demo.trains) {
      // The home (schedule stops[0]) and the yard stop are real markers.
      expect(markerIds.has(train.homeMarker), `${train.deviceId} home`).toBe(true);
      for (const stop of train.stops) {
        expect(markerIds.has(stop), `${train.deviceId} stop ${stop}`).toBe(true);
      }
      // Each train carries a 4-wagon rake of one livery; those carriage pieces
      // exist and are live so the loader can seed + render them.
      expect(train.consist).toHaveLength(4);
      const liveIds = new Set(demo.liveIds);
      for (const carriage of train.consist) {
        expect(liveIds.has(carriage.id), `carriage ${carriage.id} live`).toBe(true);
      }
    }
  });

  it('seeds the yard with two purple spares', () => {
    expect(demo.yardSpares.map((c) => c.colorId)).toEqual(['purple', 'purple']);
  });
});
