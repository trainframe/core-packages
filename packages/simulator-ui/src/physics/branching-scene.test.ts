import { describe, expect, it } from 'vitest';
import { type BranchingScene, buildBranchingScene } from './branching-scene.js';
import { edgeRequiresSwitch, markerAt, sceneToLayout } from './scene-markers.js';
import { PhysicsWorld } from './world.js';

/** Drive a body forward for `seconds` of simulated time, collecting every
 *  segment it ever occupied. Fixed dt (no clock/RNG). */
function visitedSegments(world: PhysicsWorld, seconds: number): Set<string> {
  const visited = new Set<string>();
  const steps = Math.round(seconds * 60);
  for (let i = 0; i < steps; i++) {
    world.step(1 / 60);
    const b = world.bodies()[0];
    if (b !== undefined) visited.add(b.segment);
  }
  return visited;
}

/** Build the directed adjacency from the compiled layout. */
function adjacency(scene: BranchingScene): Map<string, string[]> {
  const layout = sceneToLayout(scene, 'test');
  const adj = new Map<string, string[]>();
  for (const e of layout.edges) {
    const list = adj.get(e.from_marker_id) ?? [];
    list.push(e.to_marker_id);
    adj.set(e.from_marker_id, list);
  }
  return adj;
}

/** Whether a directed cycle of the given marker sequence exists (each
 *  consecutive pair, wrapping, is an edge). */
function isCycle(adj: ReadonlyMap<string, string[]>, seq: readonly string[]): boolean {
  for (let i = 0; i < seq.length; i++) {
    const from = seq[i];
    const to = seq[(i + 1) % seq.length];
    if (from === undefined || to === undefined) return false;
    if (!(adj.get(from)?.includes(to) ?? false)) return false;
  }
  return true;
}

describe('buildBranchingScene', () => {
  it('embeds the real yard network (segments, switches, slots) wholesale', () => {
    const scene = buildBranchingScene(3);
    const segs = scene.net.segments();
    expect(segs).toContain(scene.yard.leadWest);
    expect(segs).toContain(scene.yard.leadEast);
    expect(segs).toContain(scene.entrySlot);
    expect(segs).toContain(scene.sparesSlot);
    expect(segs).toContain('connIn');
    expect(segs).toContain('connOut');
    /* Two running loops: main (feeds yard) + branch (independent ring). */
    expect(scene.loops.map((l) => l.id).sort()).toEqual(['branch', 'main']);
    expect(scene.loops.find((l) => l.id === 'main')?.feedsYard).toBe(true);
    expect(scene.loops.find((l) => l.id === 'branch')?.feedsYard).toBe(false);
  });

  it('is a connected branching graph with multiple distinct cycles', () => {
    const scene = buildBranchingScene(3);
    const adj = adjacency(scene);
    /* The main loop cycle. */
    expect(
      isCycle(adj, ['M-top', 'M-main-w', 'M-main-wlow', 'M-central', 'M-main-e', 'M-spur']),
    ).toBe(true);
    /* The branch loop cycle — a DISTINCT cycle sharing only M-spur/M-top. */
    expect(
      isCycle(adj, [
        'M-spur',
        'M-branch-top',
        'M-branch-bot',
        'M-top',
        'M-main-w',
        'M-main-wlow',
        'M-central',
        'M-main-e',
      ]),
    ).toBe(true);
    /* The yard branch cycle — diverges at M-main-w, rejoins at M-main-e. */
    expect(
      isCycle(adj, ['M-main-w', 'M-yard-throat', 'M-yard-far', 'M-main-e', 'M-spur', 'M-top']),
    ).toBe(true);
    /* Every marker is reachable from M-top (connected). */
    const reached = new Set<string>(['M-top']);
    const queue = ['M-top'];
    while (queue.length > 0) {
      const cur = queue.shift();
      if (cur === undefined) continue;
      for (const nxt of adj.get(cur) ?? []) {
        if (!reached.has(nxt)) {
          reached.add(nxt);
          queue.push(nxt);
        }
      }
    }
    for (const m of scene.markers) expect(reached.has(m.id)).toBe(true);
  });
});

describe('sceneToLayout', () => {
  it('compiles markers, switched diverge edges, and junctions', () => {
    const scene = buildBranchingScene(3);
    const layout = sceneToLayout(scene, 'branching');
    expect(layout.name).toBe('branching');

    const throat = layout.markers.find((m) => m.id === 'M-yard-throat');
    expect(throat?.kind).toBe('yard_entry');

    const toYard = layout.edges.find(
      (e) => e.from_marker_id === 'M-main-w' && e.to_marker_id === 'M-yard-throat',
    );
    expect(toYard?.requires_switch_state).toBe('yard');
    const toBranch = layout.edges.find(
      (e) => e.from_marker_id === 'M-spur' && e.to_marker_id === 'M-branch-top',
    );
    expect(toBranch?.requires_switch_state).toBe('branch');
    /* The thru continuation off each junction carries the thru position. */
    const thruDown = layout.edges.find(
      (e) => e.from_marker_id === 'M-main-w' && e.to_marker_id === 'M-main-wlow',
    );
    expect(thruDown?.requires_switch_state).toBe('thru');

    /* Junctions present with valid positions. */
    const jLoop = layout.junctions.find((j) => j.marker_id === 'M-main-w');
    expect(jLoop?.valid_positions).toEqual(['thru', 'yard']);
    const jSpur = layout.junctions.find((j) => j.marker_id === 'M-spur');
    expect(jSpur?.valid_positions).toEqual(['thru', 'branch']);
  });

  it('emits zero markers/edges for opaque yard interior segments', () => {
    const scene = buildBranchingScene(3);
    const layout = sceneToLayout(scene, 'branching');
    const interior = new Set([
      'thru',
      'leadW',
      'leadE',
      scene.entrySlot,
      scene.sparesSlot,
      'wleg0',
      'eleg0',
    ]);
    /* No marker is anchored such that it surfaces an interior slot/leg as a node:
     *  only M-yard-throat (leadW.start) and M-yard-far (leadE.end) touch the yard. */
    const yardMarkers = layout.markers.filter((m) => m.id.startsWith('M-yard'));
    expect(yardMarkers.map((m) => m.id).sort()).toEqual(['M-yard-far', 'M-yard-throat']);
    /* No edge mentions any opaque interior marker (there are none). */
    for (const e of layout.edges) {
      expect(interior.has(e.from_marker_id)).toBe(false);
      expect(interior.has(e.to_marker_id)).toBe(false);
    }
  });

  it('edge lengths are consistent with the physics segments (all positive)', () => {
    const scene = buildBranchingScene(3);
    const layout = sceneToLayout(scene, 'branching');
    for (const e of layout.edges) {
      expect(e.estimated_length_mm ?? 0).toBeGreaterThan(0);
    }
    /* Every edge's markers exist as compiled markers. */
    const ids = new Set(layout.markers.map((m) => m.id));
    for (const e of layout.edges) {
      expect(ids.has(e.from_marker_id)).toBe(true);
      expect(ids.has(e.to_marker_id)).toBe(true);
    }
  });
});

describe('markerAt / edgeRequiresSwitch', () => {
  it('round-trips every end-anchored marker through markerAt', () => {
    const scene = buildBranchingScene(3);
    for (const m of scene.markers) {
      if (m.distAlongMm !== undefined) continue;
      expect(markerAt(scene, m.segment, m.end)).toBe(m.id);
    }
    /* A segment with no marker at an end returns undefined. */
    expect(markerAt(scene, 'cSW', 'start')).toBeUndefined();
  });

  it('resolves diverge edges to switch + position, plain edges to undefined', () => {
    const scene = buildBranchingScene(3);
    expect(edgeRequiresSwitch(scene, 'M-main-w', 'M-yard-throat')).toEqual({
      switchId: 'Jloop',
      position: 'yard',
    });
    expect(edgeRequiresSwitch(scene, 'M-spur', 'M-branch-top')).toEqual({
      switchId: 'Jspur',
      position: 'branch',
    });
    /* Non-junction from-marker: no switch constraint. */
    expect(edgeRequiresSwitch(scene, 'M-central', 'M-main-e')).toBeUndefined();
  });
});

describe('physics traversal', () => {
  it('drives a full MAIN cycle on-rail (Jloop=thru, Jspur=thru), never straying to yard/branch', () => {
    const scene = buildBranchingScene(3);
    const w = new PhysicsWorld(scene.net);
    w.setSwitch('Jloop', 'thru');
    w.setSwitch('Jspur', 'thru');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      segment: 'bottom',
      motion: 'forward',
      power: 1100,
    });
    const visited = visitedSegments(w, 60);
    const b = w.bodies()[0];
    expect(b?.fate).toBe('on-rail');
    const main = scene.loops.find((l) => l.id === 'main');
    for (const block of main?.blocks ?? []) expect(visited.has(block.id)).toBe(true);
    /* It never took the yard or the branch. */
    expect(visited.has('connIn')).toBe(false);
    expect(visited.has(scene.entrySlot)).toBe(false);
    expect(visited.has('bTop')).toBe(false);
  });

  it('drives the BRANCH cycle on-rail (Jspur=branch), rejoining the main top straight', () => {
    const scene = buildBranchingScene(3);
    const w = new PhysicsWorld(scene.net);
    w.setSwitch('Jloop', 'thru');
    w.setSwitch('Jspur', 'branch');
    /* Start on the right ascending straight approaching the spur. */
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: 'rightB',
      motion: 'forward',
      power: 800,
      maxSpeed: 260,
    });
    const visited = visitedSegments(w, 50);
    expect(w.bodies()[0]?.fate).toBe('on-rail');
    /* It diverged up the branch and rejoined the main top straight. */
    expect(visited.has('bTop')).toBe(true);
    expect(visited.has('bBottom')).toBe(true);
    expect(visited.has('top')).toBe(true);
  });

  it('diverts into the yard branch when Jloop=yard, staying on-rail', () => {
    const scene = buildBranchingScene(3);
    const w = new PhysicsWorld(scene.net);
    w.setSwitch('Jloop', 'yard');
    w.setSwitch('Jspur', 'thru');
    w.setSwitch(scene.yard.westSwitch, 'thru');
    w.setSwitch(scene.yard.eastSwitch, 'thru');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      segment: 'leftA',
      motion: 'forward',
      power: 700,
      maxSpeed: 220,
    });
    const visited = visitedSegments(w, 40);
    expect(visited.has('connIn')).toBe(true);
    expect(visited.has(scene.yard.leadWest)).toBe(true);
    expect(w.bodies()[0]?.fate).toBe('on-rail');
  });
});
