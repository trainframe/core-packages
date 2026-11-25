import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * A train always has a length (protocol 0.16.0, ADR-012): a registration
 * without one is rejected at the server, and a stopped train with no onward
 * grant keeps holding the block it stands in.
 */

const TRAIN_CAPABILITIES = [
  'core.controls_motion',
  'core.reports_marker_traversal',
  'core.accepts_route',
];

describe('a train registered without a length', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.shutdown();
    harness = undefined;
  });

  it.each([
    ['no length', {}],
    ['a zero length', { train_length_mm: 0 }],
  ])(
    'is rejected with %s and never appears in the retained device state',
    async (_label, extra) => {
      harness = await startHarness({
        layout: { name: 'length-required', markers: [], edges: [], junctions: [] },
      });

      await harness.testClient.publishEvent('device_registered', 'T-BAD', {
        device_kind_hint: 'scheduled-loco',
        capabilities: TRAIN_CAPABILITIES,
        ...extra,
      });
      await harness.testClient.waitForEvent('anomaly', 'server');

      expect(harness.testClient.retained().has('railway/state/devices/T-BAD')).toBe(false);
    },
  );

  it('is accepted once it carries a positive length', async () => {
    harness = await startHarness({
      layout: { name: 'length-required', markers: [], edges: [], junctions: [] },
    });

    await harness.testClient.publishEvent('device_registered', 'T-OK', {
      device_kind_hint: 'scheduled-loco',
      capabilities: TRAIN_CAPABILITIES,
      train_length_mm: 150,
    });

    const state = await harness.testClient.waitForState('railway/state/devices/T-OK');
    expect((state as { train_length_mm: number }).train_length_mm).toBe(150);
  });
});

describe('a stopped train with no onward grant', () => {
  let env: PhysicsEnv | undefined;

  afterEach(() => {
    env?.shutdown();
    env = undefined;
  });

  it('keeps holding its block, so a train behind is never granted into it', () => {
    env = startPhysicsEnv(
      straightLoop(
        [
          { id: 'M1', kind: 'block_boundary' },
          { id: 'M2', kind: 'block_boundary' },
          { id: 'M3', kind: 'block_boundary' },
          { id: 'M4', kind: 'block_boundary' },
        ],
        { spacingMm: 200, name: 'stopped-train-holds-block' },
      ),
    );
    env.spawnTrain('T1', { atMarker: 'M3' });
    env.spawnTrain('T2', { atMarker: 'M1' });
    env.assignSchedule('T2', ['M1', 'M4']);
    env.advance(6000);

    const t2Grants = env.commandsFor('T2').filter((c) => c.command_type === 'grant_clearance');
    expect(t2Grants.map((c) => c.payload.limit_marker_id)).not.toContain('M3');
    expect(t2Grants.map((c) => c.payload.limit_marker_id)).not.toContain('M4');
  });
});
