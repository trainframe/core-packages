/**
 * BEHAVIOUR GATE for ADR-022 reverse authority — the SIMULATOR-side enactment,
 * driven through the REAL `@trainframe/server` scheduler + a REAL
 * `ScheduledTrainDevice` on a REAL `PhysicsWorld`, over the synchronous
 * in-memory broker. Nothing is mocked.
 *
 * ADR-022 adds a bounded, signed (backward) clearance, `grant_reverse`, that the
 * scheduler issues to break a closed nose-to-nose standoff: it backs one train
 * OUT of a block it occupies, over track it provably holds, so a peer can
 * proceed. The scheduler's DECISION (when to grant, which train, how far back,
 * the safety walk) is proven at the scheduler level in
 * `packages/core/src/scheduler/scheduler.test.ts`.
 *
 * This file proves the OTHER half of the vertical slice: that a real loco, on
 * receiving a `grant_reverse` off the wire, physically BACKS UP — its body
 * moving backward along the rail to the granted marker, emitting a `tag_observed`
 * for each marker it backs onto, then stopping at the cleared limit. Application
 * code cannot tell this virtual reverse from a physical one (ADR-013). The
 * command is published exactly as the scheduler would publish it
 * (`railway/commands/{device}` with `{command_type, payload}`) via
 * `server.publishCommand`, so the device's real command path is exercised. Then
 * `revoke_clearance` is shown to end the reverse.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PhysicsEnv, startPhysicsEnv, straightLoop } from './physics-env.js';

/* A rail carrying evenly spaced markers M0..M5. A loco placed at M3 facing
   forward (+rail) backs DOWN the rail under a reverse grant — toward M2, then M1
   — reporting each marker as it crosses it. Wide spacing so the loco's brief
   braking overshoot past the limit marker never reaches the previous one. The
   retreat targets (M2, M1) sit well clear of the loop's railPos-0 seam, so the
   reverse never runs up against the wrap point. */
const SPACING_MM = 300;

function buildScene() {
  return straightLoop(
    [
      { id: 'M0', kind: 'block_boundary' },
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'block_boundary' },
      { id: 'M4', kind: 'block_boundary' },
      { id: 'M5', kind: 'block_boundary' },
    ],
    { spacingMm: SPACING_MM, name: 'reverse-authority' },
  );
}

let env: PhysicsEnv;

beforeEach(() => {
  env = startPhysicsEnv(buildScene());
});

afterEach(() => {
  env.shutdown();
});

/* World x of a marker on the straight loop: marker i sits at i * SPACING_MM. */
const markerX = (index: number): number => index * SPACING_MM;

/* The reverse-direction marks reported by the train, in the order they fired —
   the proof that the loco backed over real track and re-fixed at each tag. */
const reverseMarks = (): string[] =>
  env
    .eventsOfType('tag_observed')
    .filter((e) => e.device_id === 'T1' && e.payload.direction === 'reverse')
    .map((e) => (typeof e.payload.tag_id === 'string' ? e.payload.tag_id : ''));

const bodyX = (): number => env.world.bodies().find((b) => b.id === 'T1')?.x ?? Number.NaN;
const bodySpeed = (): number => env.world.bodies().find((b) => b.id === 'T1')?.speed ?? Number.NaN;

/* Publish a reverse grant exactly as the scheduler would: head-first over the
   held edges to `limit`, on the device command topic. */
const grantReverse = (limit: string, edges: ReadonlyArray<{ from: string; to: string }>): void => {
  env.server.publishCommand('T1', 'grant_reverse', {
    limit_marker_id: limit,
    edges: edges.map((e) => ({ from_marker_id: e.from, to_marker_id: e.to })),
    reason: 'deadlock_reverse',
  });
};

describe('reverse authority — simulator enactment (ADR-022)', () => {
  it('backs the train up to the granted marker, reporting the marker it crosses', () => {
    /* A reverse-capable loco placed at M3 facing forward. It has driven up to
       here; a reverse grant backs it one block, from M3 to M2. */
    env.spawnTrain('T1', { atMarker: 'M3', facing: 1, canReverse: true });
    env.advance(200); // settle the spawn-time marker read at M3

    grantReverse('M2', [{ from: 'M2', to: 'M3' }]);

    /* Advance the clock; the body backs up under physics. Deterministic. */
    env.advance(6000);

    /* It reported backing onto M2 — the scheduler tracks the retreat from this. */
    expect(reverseMarks()).toContain('M2');
    /* The body has stopped, and stopped near M2 without backing on past it to M1
       (it gave up exactly the one block it was granted). */
    expect(bodySpeed()).toBeLessThan(1);
    expect(bodyX()).toBeLessThan(markerX(2) + 30); // not still up at M3
    expect(bodyX()).toBeGreaterThan(markerX(1) + 60); // never reached M1's block
  });

  it('backs up across multiple held edges to a deeper target, in order', () => {
    /* At M3 facing forward; reverse two blocks back to M1 across two held edges
       {M2->M3, M1->M2}, head-first. */
    env.spawnTrain('T1', { atMarker: 'M3', facing: 1, canReverse: true });
    env.advance(200);

    grantReverse('M1', [
      { from: 'M2', to: 'M3' },
      { from: 'M1', to: 'M2' },
    ]);
    env.advance(10_000);

    /* Reached M1, stopped, and reported M2 (intermediate) BEFORE M1 (target). */
    const marks = reverseMarks();
    expect(marks.indexOf('M2')).toBeGreaterThanOrEqual(0);
    expect(marks.indexOf('M1')).toBeGreaterThan(marks.indexOf('M2'));
    expect(bodySpeed()).toBeLessThan(1);
    expect(bodyX()).toBeLessThan(markerX(1) + 30); // stopped at/near M1
    expect(bodyX()).toBeGreaterThan(markerX(0) + 60); // never reached M0's block
  });

  it('revoke_clearance ends the reverse and the train stops giving ground', () => {
    env.spawnTrain('T1', { atMarker: 'M3', facing: 1, canReverse: true });
    env.advance(200);

    grantReverse('M1', [
      { from: 'M2', to: 'M3' },
      { from: 'M1', to: 'M2' },
    ]);
    env.advance(500); // back up partway, not yet to the deeper target

    const xMidReverse = bodyX();
    expect(xMidReverse).toBeLessThan(markerX(3)); // it has begun retreating
    expect(xMidReverse).toBeGreaterThan(markerX(1)); // not yet at the target

    /* Revoke ends reversing: the train decelerates to a stop and does not reach
       the deeper target M1. */
    env.server.publishCommand('T1', 'revoke_clearance', { reason: 'admin', immediate: true });
    env.advance(4000);

    expect(bodySpeed()).toBeLessThan(1);
    /* It did not complete the reverse to M1 — it stopped where revoke caught it,
       short of M1's marker. */
    expect(bodyX()).toBeGreaterThan(markerX(1) + 30);
    expect(reverseMarks()).not.toContain('M1');
  });
});
