import type { Layout } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

const SIMPLE_LOOP: Layout = {
  name: 'simple-loop',
  markers: [
    { id: 'M1', kind: 'block_boundary' },
    { id: 'M2', kind: 'block_boundary' },
    { id: 'M3', kind: 'station_stop' },
    { id: 'M4', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
    { from_marker_id: 'M3', to_marker_id: 'M4', estimated_length_mm: 200 },
    { from_marker_id: 'M4', to_marker_id: 'M1', estimated_length_mm: 200 },
  ],
  junctions: [],
};

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ layout: SIMPLE_LOOP });
  await harness.testClient.seedIdentityTags(['M1', 'M2', 'M3', 'M4']);
});

afterEach(async () => {
  await harness.shutdown();
});

describe('Clearance flow through a real broker', () => {
  it('Given a registered train, when the operator assigns a route, the train is permitted to advance as far as M2', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);

    // The train hears that it may run up to M2 (but not yet beyond).
    const permission = await harness.testClient.waitForCommand('T1', 'grant_clearance');
    expect((permission.payload as { limit_marker_id: string }).limit_marker_id).toBe('M2');
  });

  it('Given a gate withholds M3, when the train reports passing M2 it receives no further clearance', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.publishEvent('device_registered', 'GATE-M3', {
      capabilities: ['core.gates_clearance'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    await harness.testClient.waitForState('railway/state/devices/GATE-M3');
    await harness.testClient.publishEvent('gate_state_changed', 'GATE-M3', {
      marker_id: 'M3',
      state: 'withholding',
      reason: 'crane busy',
    });

    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    await harness.testClient.waitForCommand('T1', 'grant_clearance'); // initial M2 grant

    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M1' });
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M2' });

    // Give the broker round-trip a beat to reflect any further commands.
    await new Promise((r) => setTimeout(r, 200));

    const grants = harness.testClient
      .commandsFor('T1')
      .filter((c) => c.command_type === 'grant_clearance');
    expect(grants).toHaveLength(1); // still only the initial M2 grant
  });

  it('When the gate releases, the train sees the previously-withheld clearance arrive', async () => {
    await harness.testClient.publishEvent('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.publishEvent('device_registered', 'GATE-M3', {
      capabilities: ['core.gates_clearance'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');
    await harness.testClient.waitForState('railway/state/devices/GATE-M3');
    await harness.testClient.publishEvent('gate_state_changed', 'GATE-M3', {
      marker_id: 'M3',
      state: 'withholding',
    });
    harness.server.assignRoute('T1', 'route-1', [
      { from_marker_id: 'M1', to_marker_id: 'M2' },
      { from_marker_id: 'M2', to_marker_id: 'M3' },
    ]);
    await harness.testClient.waitForCommand('T1', 'grant_clearance');
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M1' });
    await harness.testClient.publishEvent('tag_observed', 'T1', { tag_id: 'M2' });

    await harness.testClient.publishEvent('gate_state_changed', 'GATE-M3', {
      marker_id: 'M3',
      state: 'granting',
    });

    // The second grant_clearance with limit M3 should arrive after gate release.
    const start = Date.now();
    let grants = harness.testClient
      .commandsFor('T1')
      .filter((c) => c.command_type === 'grant_clearance');
    while (grants.length < 2 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 20));
      grants = harness.testClient
        .commandsFor('T1')
        .filter((c) => c.command_type === 'grant_clearance');
    }
    expect(grants).toHaveLength(2);
    expect((grants[1]?.payload as { limit_marker_id: string }).limit_marker_id).toBe('M3');
  });

  it('When the server starts, a fresh subscriber receives the active layout via retained state', async () => {
    const layoutMsg = harness.testClient.retained().get('railway/state/layout/simple-loop');
    expect(layoutMsg).toBeDefined();
    expect((layoutMsg as { name: string }).name).toBe('simple-loop');
  });
});
