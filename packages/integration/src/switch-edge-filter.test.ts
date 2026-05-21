import type { Layout } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const FIGURE_8: Layout = {
  name: 'figure-8',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'junction' },
    { id: 'M3', kind: 'block_boundary' },
    { id: 'M4', kind: 'block_boundary' },
    { id: 'M5', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    {
      from_marker_id: 'M2',
      to_marker_id: 'M3',
      estimated_length_mm: 200,
      requires_switch_state: 'main',
    },
    {
      from_marker_id: 'M2',
      to_marker_id: 'M5',
      estimated_length_mm: 280,
      requires_switch_state: 'diverge',
    },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
    { from_marker_id: 'M5', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [{ marker_id: 'M2' }],
};

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ layout: FIGURE_8 });
});

afterEach(async () => {
  await harness.shutdown();
});

const grantsFor = (trainId: string) =>
  harness.testClient.commandsFor(trainId).filter((c) => c.command_type === 'grant_clearance');

describe('Switch-state edge filtering through a real broker', () => {
  it('Given the switch is misaligned, when the train reaches the junction it gets no further clearance', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.publishEvent('device_registered', 'SW-M2', {
      capabilities: ['core.controls_switch'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    await harness.testClient.waitForState('railway/state/devices/SW-M2');

    await harness.testClient.publishEvent('switch_state_changed', 'SW-M2', {
      junction_marker_id: 'M2',
      position: 'diverge',
      confirmed: true,
    });

    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    await harness.testClient.waitForCommand('T1', 'grant_clearance'); // initial M2 grant

    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M1' });
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M2' });

    await new Promise((r) => setTimeout(r, 200));

    expect(grantsFor('T1')).toHaveLength(1);
  });

  it('When the switch confirms a matching position, the previously-withheld clearance arrives', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.publishEvent('device_registered', 'SW-M2', {
      capabilities: ['core.controls_switch'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    await harness.testClient.waitForState('railway/state/devices/SW-M2');

    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    await harness.testClient.waitForCommand('T1', 'grant_clearance');

    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M1' });
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M2' });

    await harness.testClient.publishEvent('switch_state_changed', 'SW-M2', {
      junction_marker_id: 'M2',
      position: 'main',
      confirmed: true,
    });

    const start = Date.now();
    let grants = grantsFor('T1');
    while (grants.length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
      grants = grantsFor('T1');
    }
    expect(grants).toHaveLength(2);
    expect((grants[1]?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M3');
  });

  it('Unconfirmed switch reports do not unblock clearance', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.publishEvent('device_registered', 'SW-M2', {
      capabilities: ['core.controls_switch'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    await harness.testClient.waitForState('railway/state/devices/SW-M2');

    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    await harness.testClient.waitForCommand('T1', 'grant_clearance');
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M1' });
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M2' });

    await harness.testClient.publishEvent('switch_state_changed', 'SW-M2', {
      junction_marker_id: 'M2',
      position: 'main',
      confirmed: false,
    });

    await new Promise((r) => setTimeout(r, 200));
    expect(grantsFor('T1')).toHaveLength(1);
  });
});
