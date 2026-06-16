import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Delegated capacity-territory admission (ADR-026): a railyard owns a
 * capacity-limited zone behind a single boundary marker (the throat M3). It asserts
 * its own occupancy via `zone_state_changed`; the `core.gates_zone` capability
 * denies a train clearance INTO the zone while it is full, and the scheduler's
 * deny-and-hold / retry machinery admits it the moment a slot frees. The unique
 * signal is the operator round-trip through the broker: a real ZoneDevice asserting
 * a count core cannot itself compute (carriages are invisible to core, ADR-016).
 *
 * Driven synchronously on the physics test-env: real scheduler, real ZoneDevice,
 * real physics loco. Safety-relevant: a full yard must not admit a train; a freed
 * slot must.
 */

const buildScene = () =>
  straightLoop(
    [
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'yard_entry' },
      { id: 'M4', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'zone-admission' },
  );

let env: PhysicsEnv;

beforeEach(() => {
  env = startPhysicsEnv(buildScene());
});

afterEach(() => {
  env.shutdown();
});

const grants = (limit?: string) =>
  env
    .commandsFor('T1')
    .filter(
      (c) =>
        c.command_type === 'grant_clearance' &&
        (limit === undefined || c.payload.limit_marker_id === limit),
    );

describe('Railyard zone admission: the scheduler obeys the device-asserted occupancy', () => {
  it('a full yard holds the train at the throat; freeing a slot admits it', () => {
    // A 2-slot yard owning the M3 throat, FULL (2/2) before the train has any
    // clearance toward M3.
    const yard = env.spawnYardZone('YARD-1', {
      throatMarker: 'M3',
      capacity: 2,
      initialOccupancy: 2,
    });

    // The train declares core.can_reverse (a zone-admission prerequisite) and is
    // routed through the throat.
    env.spawnTrain('T1', { atMarker: 'M1', canReverse: true });
    env.assignSchedule('T1', ['M1', 'M3']);
    env.advance(4000);

    // Cleared up to M2 (before the throat) but no further while the yard is full.
    expect(grants()[0]?.payload.limit_marker_id).toBe('M2');
    expect(grants('M3')).toHaveLength(0);

    // A consist leaves the yard: one slot frees (1/2). The scheduler re-consults
    // and admits the held train to the throat.
    yard.vacate();
    env.advance(4000);
    expect(grants('M3').length).toBeGreaterThanOrEqual(1);
  });

  it('reconciles a train length on its way out of the yard (ADR-023)', () => {
    const yard = env.spawnYardZone('YARD-1', { throatMarker: 'M3', capacity: 2 }); // room to admit
    env.spawnTrain('T1', { atMarker: 'M1', canReverse: true, lengthMm: 250 });
    env.advance(200);
    expect(env.stateOf('railway/state/devices/T1')?.train_length_mm).toBe(250);

    // The yard reports the train out at a shorter length (a carriage was dropped
    // inside). Honoured because the yard declared core.reports_length — the train
    // itself is unaware.
    yard.reportLength('T1', 100);
    env.advance(200);
    expect(env.stateOf('railway/state/devices/T1')?.train_length_mm).toBe(100);
  });

  it('refuses to admit a train that cannot reverse (ADR-027)', () => {
    env.spawnYardZone('YARD-1', { throatMarker: 'M3', capacity: 2, initialOccupancy: 0 });

    // A train that does NOT declare core.can_reverse. Interior shunting needs
    // reversing, so the scheduler must refuse it admission and warn.
    env.spawnTrain('T1', { atMarker: 'M1', canReverse: false });
    env.assignSchedule('T1', ['M1', 'M3']);
    env.advance(2000);

    expect(grants('M3')).toHaveLength(0);
    const refused = env
      .eventsOfType('anomaly')
      .some((e) => JSON.stringify(e.payload).includes('can_reverse'));
    expect(refused).toBe(true);
  });
});
