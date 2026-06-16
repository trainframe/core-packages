import {
  type CapturedEvent,
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Station dwell: a train routed toward a `station_stop` marker (M3) that has a
 * withholding gate pauses there. The dwell is gate-driven, not intrinsic to the
 * `station_stop` marker kind — a real `GateDevice` at M3 withholds clearance, so
 * the scheduler's `core.gates_clearance` capability vetoes the M2 → M3 extension.
 * The loco self-stops at M2 (its clearance limit) and, while parked, its real
 * `ScheduledTrainDevice` emits `train_status` with `speed_normalised = 0`.
 *
 * The unique signal preserved from the old-sim test is the dwell observation: the
 * train must be seen MOVING first (a nonzero `speed_normalised`), then settle into
 * a run of consecutive `speed_normalised = 0` samples while the gate withholds —
 * proving it genuinely started and then paused, rather than idling from spawn.
 *
 * Everything is real and synchronous over the in-memory bus: gate device,
 * scheduler, physics train. No polling, no wall-clock deadlines.
 */

const buildScene = () =>
  straightLoop(
    [
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'station_stop' },
      { id: 'M4', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'station-dwell' },
  );

let env: PhysicsEnv;

beforeEach(() => {
  env = startPhysicsEnv(buildScene());
});

afterEach(() => {
  env.shutdown();
});

const trainStatus = (): readonly CapturedEvent[] =>
  env.eventsOfType('train_status').filter((e) => e.device_id === 'T1');

const speedOf = (e: CapturedEvent): number => {
  const speed = e.payload.speed_normalised;
  return typeof speed === 'number' ? speed : Number.NaN;
};

describe('Station dwell: gate-withheld station_stop marker pauses the train', () => {
  it('the train moves, then emits consecutive speed_normalised=0 train_status samples while the gate withholds M3', () => {
    // Spawn and hold the gate at the station marker before the train has any
    // clearance past M2. The scheduler vetoes the M2 → M3 extension, leaving the
    // train parked at M2 with speed = 0.
    const gate = env.spawnGate('GATE-M3', { markers: ['M3'] });
    gate.hold('M3', 'station dwell test');

    // Spawn the train and route it through the station marker.
    env.spawnTrain('T1', { atMarker: 'M1' });
    env.assignSchedule('T1', ['M1', 'M3']);

    // Let the train accelerate, run toward the gate, and settle into its dwell.
    env.advance(6000);

    const statuses = trainStatus();

    // The train must have been observed genuinely moving at some point.
    const hasMoved = statuses.some((e) => speedOf(e) > 0);
    expect(hasMoved).toBe(true);

    // The tail of the status stream must be a run of consecutive zero-speed
    // samples (the dwell), preceded by a nonzero sample (it had been moving).
    let consecutiveZero = 0;
    let nonzeroBeforeZeros = false;
    for (let i = statuses.length - 1; i >= 0; i--) {
      const status = statuses[i];
      if (status === undefined) break;
      if (speedOf(status) === 0) {
        consecutiveZero += 1;
      } else {
        nonzeroBeforeZeros = true;
        break;
      }
    }
    expect(consecutiveZero).toBeGreaterThanOrEqual(2);
    expect(nonzeroBeforeZeros).toBe(true);

    // The scheduler never granted clearance to the gated station marker, and the
    // body never crossed into M3's block (M3 sits at x = 400).
    const grantsToM3 = env
      .commandsFor('T1')
      .filter((c) => c.command_type === 'grant_clearance' && c.payload.limit_marker_id === 'M3');
    expect(grantsToM3).toHaveLength(0);
    const x = env.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(x).toBeLessThan(400);
  });

  it('releasing the gate ends the dwell and the scheduler extends clearance to the station marker', () => {
    const gate = env.spawnGate('GATE-M3', { markers: ['M3'] });
    gate.hold('M3', 'station dwell test');

    env.spawnTrain('T1', { atMarker: 'M1' });
    env.assignSchedule('T1', ['M1', 'M3']);
    env.advance(6000);

    // Mid-dwell: cleared only to M2, never to the station marker.
    expect(
      env
        .commandsFor('T1')
        .filter((c) => c.command_type === 'grant_clearance' && c.payload.limit_marker_id === 'M3'),
    ).toHaveLength(0);

    // Release the gate: the scheduler re-evaluates and extends clearance to M3,
    // ending the dwell.
    gate.release('M3');
    env.advance(6000);

    expect(
      env
        .commandsFor('T1')
        .filter((c) => c.command_type === 'grant_clearance' && c.payload.limit_marker_id === 'M3')
        .length,
    ).toBeGreaterThanOrEqual(1);
  });
});
