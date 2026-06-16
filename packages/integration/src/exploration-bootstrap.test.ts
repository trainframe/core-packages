import type { Layout } from '@trainframe/protocol';
import {
  type PhysicsEnv,
  type PhysicsScene,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * The cold-start discovery bootstrap (ADR-015), end-to-end through real seams:
 * a real `Server` booted in pure discovery (its markers known but NOT one edge),
 * a real physics loco rolling on a REAL closed loop, and the operator's single
 * *Learn track* gesture. We drive no train physics by hand and route nothing: the
 * operator presses one button (`learn_track_start` on `railway/operator/...`), the
 * scheduler's LearnMode issues ONE open `begin_exploration` clearance, the loco
 * drives itself around the rails, and the server learns every edge from the
 * traversals it reports. This is the deadlock ADR-014 named — markers without
 * edges, edges only discoverable by driving, driving impossible without a route —
 * finally breaking.
 *
 * Everything is real and synchronous over the in-memory bus: scheduler, LearnMode,
 * physics world, marker sensors. No mocking, no polling, no real-time waits.
 */

/* Build the PHYSICAL ring the loco rolls on with the harness's straightLoop, then
 * hand the SERVER an edgeless layout of the same markers: the broker-seeded
 * identity tags resolve marker crossings, but the scheduler starts knowing zero
 * edges — exactly the cold-start the operator must break. */
const buildColdStartScene = (): PhysicsScene => {
  const loop = straightLoop(
    [
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'block_boundary' },
      { id: 'M4', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'ring' },
  );
  const discoveryLayout: Layout = {
    name: loop.layout.name,
    markers: loop.layout.markers,
    edges: [],
    junctions: [],
  };
  return { net: loop.net, layout: discoveryLayout, markers: loop.markers };
};

const RING_EDGES: ReadonlyArray<{ readonly from: string; readonly to: string }> = [
  { from: 'M1', to: 'M2' },
  { from: 'M2', to: 'M3' },
  { from: 'M3', to: 'M4' },
  { from: 'M4', to: 'M1' },
];

const encode = (payload: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(payload));

let env: PhysicsEnv;

beforeEach(() => {
  env = startPhysicsEnv(buildColdStartScene());
});

afterEach(() => {
  env.shutdown();
});

const everyEdgeLearned = (): boolean =>
  RING_EDGES.every((e) => env.server.getLayoutState().findEdge(e.from, e.to) !== undefined);

describe('Cold-start discovery via exploration (ADR-015)', () => {
  it('learns every edge of a fresh loop from one Learn-track press', () => {
    /* Place the loco on the ring at M1. Its sensor fires the marker it sits on on
     *  the first sample, giving LearnMode a train + first marker to latch onto. */
    env.spawnTrain('T1', { atMarker: 'M1' });
    env.advance(100);

    /* The deadlock precondition: markers known, not one edge. */
    expect(env.server.getLayoutState().findEdge('M1', 'M2')).toBeUndefined();

    /* The single operator gesture — published exactly as the visualiser would. */
    env.client.publish('railway/operator/learn_track_start', encode({}));

    /* Pump physics time forward; the loco explores autonomously and the server
     *  learns the graph from the traversals it reports. We route nothing. A full
     *  lap of the 800mm ring at ~400mm/s is ~2s; give it generous slack. */
    env.advance(15_000);

    expect(everyEdgeLearned()).toBe(true);

    /* It was driven by one open exploration clearance, never routed edge-by-edge. */
    const commands = env.commandsFor('T1');
    expect(
      commands.filter((c) => c.command_type === 'begin_exploration').length,
    ).toBeGreaterThanOrEqual(1);
    expect(commands.filter((c) => c.command_type === 'assign_route')).toHaveLength(0);
  });
});
