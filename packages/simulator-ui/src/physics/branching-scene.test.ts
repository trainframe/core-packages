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
  it('embeds the real yard network (segments, switches, slots) IN-LINE on the spine', () => {
    const scene = buildBranchingScene(3);
    const segs = scene.net.segments();
    expect(segs).toContain(scene.yard.leadWest);
    expect(segs).toContain(scene.yard.leadEast);
    expect(segs).toContain('thru');
    expect(segs).toContain(scene.entrySlot);
    expect(segs).toContain(scene.sparesSlot);
    /* Two running loops: main (runs through the in-line yard) + branch (an
     *  independent scenic ring). */
    expect(scene.loops.map((l) => l.id).sort()).toEqual(['branch', 'main']);
    expect(scene.loops.find((l) => l.id === 'main')?.feedsYard).toBe(true);
    expect(scene.loops.find((l) => l.id === 'branch')?.feedsYard).toBe(false);
    /* The main loop's travel order includes the yard spine in-line. */
    const mainBlocks = scene.loops.find((l) => l.id === 'main')?.blocks.map((b) => b.id) ?? [];
    expect(mainBlocks).toContain(scene.yard.leadWest);
    expect(mainBlocks).toContain('thru');
    expect(mainBlocks).toContain(scene.yard.leadEast);
  });

  it('is a connected branching graph with multiple distinct cycles', () => {
    const scene = buildBranchingScene(3);
    const adj = adjacency(scene);
    /* The main loop cycle — runs straight through the in-line yard, with a spare
     *  mid-top block boundary (M-north). */
    expect(
      isCycle(adj, [
        'M-top',
        'M-main-w',
        'M-central',
        'M-yard-throat',
        'M-yard-far',
        'M-main-e',
        'M-spur',
        'M-north',
      ]),
    ).toBe(true);
    /* The branch loop cycle — a DISTINCT cycle sharing only M-spur/M-north/M-top
     *  with the main loop (the branch rejoins the top run at its start, before the
     *  spare M-north boundary). */
    expect(
      isCycle(adj, [
        'M-spur',
        'M-branch-top',
        'M-branch-bot',
        'M-north',
        'M-top',
        'M-main-w',
        'M-central',
        'M-yard-throat',
        'M-yard-far',
        'M-main-e',
      ]),
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
  it('compiles markers, the switched spur diverge edge, and the spur junction', () => {
    const scene = buildBranchingScene(3);
    const layout = sceneToLayout(scene, 'branching');
    expect(layout.name).toBe('branching');

    const throat = layout.markers.find((m) => m.id === 'M-yard-throat');
    expect(throat?.kind).toBe('yard_entry');

    /* The yard is IN-LINE: the throat→far spine edge is a plain edge (no switch). */
    const throughYard = layout.edges.find(
      (e) => e.from_marker_id === 'M-yard-throat' && e.to_marker_id === 'M-yard-far',
    );
    expect(throughYard?.requires_switch_state).toBeUndefined();
    /* The approach to the yard is plain too (no tap junction). */
    const intoYard = layout.edges.find(
      (e) => e.from_marker_id === 'M-central' && e.to_marker_id === 'M-yard-throat',
    );
    expect(intoYard?.requires_switch_state).toBeUndefined();

    const toBranch = layout.edges.find(
      (e) => e.from_marker_id === 'M-spur' && e.to_marker_id === 'M-branch-top',
    );
    expect(toBranch?.requires_switch_state).toBe('branch');
    /* The thru continuation off the spur (toward the top run, via the spare
     *  mid-top boundary) carries the thru position. */
    const thruTop = layout.edges.find(
      (e) => e.from_marker_id === 'M-spur' && e.to_marker_id === 'M-north',
    );
    expect(thruTop?.requires_switch_state).toBe('thru');

    /* The only junction is the spur (the yard is an in-line zone, not a tap). */
    expect(layout.junctions.map((j) => j.marker_id)).toEqual(['M-spur']);
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
    /* Only M-yard-throat (leadW.start) and M-yard-far (leadE.end) touch the yard;
     *  the slots/legs/thru surface no markers. */
    const yardMarkers = layout.markers.filter((m) => m.id.startsWith('M-yard'));
    expect(yardMarkers.map((m) => m.id).sort()).toEqual(['M-yard-far', 'M-yard-throat']);
    /* No edge mentions any opaque interior SEGMENT id as a marker. */
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

  it('resolves the spur diverge edge to switch + position, plain edges to undefined', () => {
    const scene = buildBranchingScene(3);
    expect(edgeRequiresSwitch(scene, 'M-spur', 'M-branch-top')).toEqual({
      switchId: 'Jspur',
      position: 'branch',
    });
    /* The in-line yard spine carries no switch constraint. */
    expect(edgeRequiresSwitch(scene, 'M-yard-throat', 'M-yard-far')).toBeUndefined();
    expect(edgeRequiresSwitch(scene, 'M-central', 'M-yard-throat')).toBeUndefined();
  });
});

describe('physics traversal', () => {
  it('drives a full MAIN cycle on-rail through the in-line yard (Jspur=thru), never straying to a slot/branch', () => {
    const scene = buildBranchingScene(3);
    const w = new PhysicsWorld(scene.net);
    w.setSwitch('Jspur', 'thru');
    /* Interior ladder defaults to thru by being unset (the spine joints are
     *  unconditional), so a non-serviced train runs straight through. */
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      segment: 'leftA',
      motion: 'forward',
      power: 1100,
    });
    const visited = visitedSegments(w, 70);
    const b = w.bodies()[0];
    expect(b?.fate).toBe('on-rail');
    /* It ran the yard spine in-line (leadW → thru → leadE). */
    expect(visited.has(scene.yard.leadWest)).toBe(true);
    expect(visited.has('thru')).toBe(true);
    expect(visited.has(scene.yard.leadEast)).toBe(true);
    /* It never diverted into a slot or took the branch. */
    expect(visited.has(scene.entrySlot)).toBe(false);
    expect(visited.has('bTop')).toBe(false);
  });

  it('drives the BRANCH cycle on-rail (Jspur=branch), rejoining the main top straight', () => {
    const scene = buildBranchingScene(3);
    const w = new PhysicsWorld(scene.net);
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

  it('diverts into a yard slot when the interior west point is thrown, staying on-rail', () => {
    const scene = buildBranchingScene(3);
    const w = new PhysicsWorld(scene.net);
    w.setSwitch('Jspur', 'thru');
    /* Throw BOTH interior points to the entry slot: the train diverts off the
     *  spine into the slot and rejoins it on the far side (the divert-and-return a
     *  service uses, here with both legs open so it stays on-rail end to end). */
    w.setSwitch(scene.yard.westSwitch, scene.entrySlot);
    w.setSwitch(scene.yard.eastSwitch, scene.entrySlot);
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
    expect(visited.has(scene.yard.leadWest)).toBe(true);
    expect(visited.has(scene.entrySlot)).toBe(true);
    expect(w.bodies()[0]?.fate).toBe('on-rail');
  });
});
