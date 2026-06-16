/**
 * BEHAVIOUR GATE for the train POWER model (inert-in-place, not despawn), now on
 * the physics test-env: a real @trainframe/server scheduler driving real physics
 * locos over the synchronous in-memory bus.
 *
 * Powering a loco OFF must NOT remove it the way a despawn does. The correct
 * model, exercised end-to-end here:
 *   (a) a running loco, powered off mid-transit, STAYS on the rail at its position
 *       (it comes to rest as an inert obstacle; it is not despawned, not teleported);
 *   (b) it goes SILENT — no further events of its own, and crucially NO
 *       `device_disconnected` (a dead loco doesn't announce its departure);
 *   (c) because the scheduler hears silence (not a disconnect) it keeps the loco's
 *       block reserved — a follower closing up behind is held short of it and
 *       stalls (the line is fouled but safe);
 *   (d) powering it back ON resumes it — it drives on and crosses its next marker,
 *       and the follower is subsequently released too.
 *
 * No scheduler change is needed: the scheduler frees a block only on
 * `device_disconnected` (none here) or a tail-clearance `train_status` (a silent
 * loco emits none), so the block simply stays held until the loco speaks again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type PhysicsEnv, startPhysicsEnv, straightLoop } from './physics-env.js';

/** An eight-marker ring of plain block boundaries (no station dwell), long enough
 *  that the leader holds its edge plus a clearance horizon while the follower has
 *  room to move up and then stall behind it. */
const SPACING = 600;
const buildScene = () =>
  straightLoop(
    ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map((id) => ({
      id,
      kind: 'block_boundary' as const,
    })),
    { spacingMm: SPACING, name: 'power-ring' },
  );

let env: PhysicsEnv;

beforeEach(() => {
  env = startPhysicsEnv(buildScene());
});

afterEach(() => {
  env.shutdown();
});

const bodyOf = (id: string) => env.world.bodies().find((b) => b.id === id);
const traversals = (trainId: string) =>
  env.eventsOfType('marker_traversed').filter((e) => e.payload.train_id === trainId).length;
const eventsFrom = (deviceId: string) => env.events.filter((e) => e.device_id === deviceId).length;

describe('train power model — inert-in-place, block held on silence', () => {
  it('power-off keeps the loco on the rail, silent, holds its block; power-on resumes', () => {
    // Stage the leader A alone first, so there is no ambiguity about which leads.
    const a = env.spawnTrain('A', { atMarker: 'P1' });
    env.assignSchedule('A', ['P1', 'P8']);
    // Run A until it is moving DEEP inside a block (well past the block's entry
    // marker), so the follower — held at that entry marker — stalls a clear gap
    // behind it rather than coasting into contact.
    let guard = 0;
    while (guard++ < 200) {
      env.advance(200);
      const x = bodyOf('A')?.x ?? 0;
      const intoBlock = x % SPACING;
      if (
        (bodyOf('A')?.speed ?? 0) > 0 &&
        intoBlock > 0.55 * SPACING &&
        intoBlock < 0.9 * SPACING
      ) {
        break;
      }
    }

    // Mid-transit precondition: A is genuinely moving, not parked at a limit.
    expect(bodyOf('A')?.speed ?? 0).toBeGreaterThan(0);
    const aXBefore = bodyOf('A')?.x ?? 0;

    // Bring the follower B up behind A on the same loop.
    env.spawnTrain('B', { atMarker: 'P1' });
    env.assignSchedule('B', ['P1', 'P8']);

    // === POWER OFF A, mid-transit. ===
    const aEventsBefore = eventsFrom('A');
    a.power(false);
    env.advance(20000); // let B close up behind A

    // (a) A is still on the rail, at rest near where it stopped (not despawned).
    expect(a.isPowered).toBe(false);
    expect(bodyOf('A')).toBeDefined();
    expect(bodyOf('A')?.speed ?? 1).toBe(0);
    expect(Math.abs((bodyOf('A')?.x ?? 0) - aXBefore)).toBeLessThan(SPACING); // didn't run on

    // (b) A went silent: nothing further from A, and never a device_disconnected.
    expect(eventsFrom('A')).toBe(aEventsBefore);
    expect(env.eventsOfType('device_disconnected').filter((e) => e.device_id === 'A')).toHaveLength(
      0,
    );

    // (c) B is held behind A: capture its state, advance more, assert no progress.
    const bXStalled = bodyOf('B')?.x ?? 0;
    const bTraversalsStalled = traversals('B');
    env.advance(15000);
    expect(bodyOf('B')?.speed ?? 1).toBe(0);
    expect(bodyOf('B')?.x ?? 0).toBeCloseTo(bXStalled, 0);
    expect(traversals('B')).toBe(bTraversalsStalled);
    expect(env.eventsOfType('device_disconnected').filter((e) => e.device_id === 'A')).toHaveLength(
      0,
    );

    // (d) POWER A BACK ON — it resumes and crosses its next marker, and B is then
    // released too once A vacates the block.
    const aTraversalsBeforeResume = traversals('A');
    a.power(true);
    expect(a.isPowered).toBe(true);
    env.advance(20000);
    expect(traversals('A')).toBeGreaterThan(aTraversalsBeforeResume);
    expect(traversals('B')).toBeGreaterThan(bTraversalsStalled);
  });
});
