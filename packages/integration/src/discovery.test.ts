import type { Layout } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * Minimal layout: a single marker M1. Discovery mode should add M-NEW
 * once an operator assigns a tag, then learn the M1→M-NEW edge as the
 * train passes both markers.
 */
const SEED_LAYOUT: Layout = {
  name: 'discovery-seed',
  markers: [{ id: 'M1', kind: 'block_boundary' }],
  edges: [],
  junctions: [],
};

let harness: Harness;

beforeEach(async () => {
  harness = await startHarness({ layout: SEED_LAYOUT });
});

afterEach(async () => {
  await harness.shutdown();
});

const publishWire = (event_type: string, device_id: string, payload: unknown) =>
  harness.testClient.publishEvent(event_type, device_id, payload);

describe('Discovery mode: operator + train collaborate to learn a graph', () => {
  it('Given the operator binds a new tag to a new marker, the layout gains the marker via retained state', async () => {
    await publishWire('device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    await harness.testClient.waitForState('railway/state/devices/GARAGE');

    await publishWire('tag_assignment', 'GARAGE', {
      tag_id: 'M-NEW',
      assigned_kind: 'marker',
      target_id: 'M-NEW',
      marker_kind: 'block_boundary',
    });

    await harness.testClient.waitForState('railway/state/tags/M-NEW');
    await expect
      .poll(() => harness.server.getLayoutState().hasMarker('M-NEW'), { timeout: 2_000 })
      .toBe(true);

    // The republished layout retained state should now include M-NEW.
    await expect
      .poll(
        () => {
          const layout = harness.testClient
            .retained()
            .get(`railway/state/layout/${SEED_LAYOUT.name}`) as Layout | undefined;
          return layout?.markers.find((m) => m.id === 'M-NEW') !== undefined;
        },
        { timeout: 2_000 },
      )
      .toBe(true);
  });

  it('Given a train traverses an unknown marker pair, the scheduler infers an edge then confirms after 3 traversals', async () => {
    // Wire up: garage, train, and an extra marker M2 known to the
    // operator but with no edge to M1.
    await publishWire('device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    await publishWire('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await publishWire('tag_assignment', 'GARAGE', {
      tag_id: 'M1',
      assigned_kind: 'marker',
      target_id: 'M1',
    });
    await publishWire('tag_assignment', 'GARAGE', {
      tag_id: 'M2',
      assigned_kind: 'marker',
      target_id: 'M2',
      marker_kind: 'block_boundary',
    });
    await harness.testClient.waitForState('railway/state/tags/M2');

    // Drive M1 ↔ M2 three times to confirm.
    const cross = async (id: string) => publishWire('tag_observed', 'T1', { tag_id: id });
    await cross('M1');
    await cross('M2');
    await cross('M1');
    await cross('M2');
    await cross('M1');
    await cross('M2');

    await expect
      .poll(() => harness.server.getLayoutState().findEdge('M1', 'M2')?.inferred, {
        timeout: 2_000,
      })
      .toBe(false);
  });
});
