import type { Layout } from '@trainframe/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, startHarness } from './harness.js';

/**
 * ADR-007 runtime tag→entity resolution, exercised end-to-end through a real
 * broker and a real server.
 *
 * The point of these tests is the *indirection*: a `tag_observed` carries an
 * opaque physical tag id that bears no relation to the logical marker id. The
 * server resolves it through its `TagRegistry` (populated by `tag_assignment`
 * events) before the scheduler acts. The identity scheme (tag_id === marker_id)
 * used in most other tests would NOT prove this — so here every tag id is
 * deliberately *not* a marker id.
 *
 * The feature is fully shipped; these are regression guards over the wire seam,
 * not red→green TDD.
 */
const SIMPLE_LOOP: Layout = {
  name: 'tag-resolution-loop',
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
});

afterEach(async () => {
  await harness.shutdown();
});

const publishWire = (event_type: string, device_id: string, payload: unknown) =>
  harness.testClient.publishEvent(event_type, device_id, payload);

interface MarkerTraversedPayload {
  readonly train_id: string;
  readonly marker_id: string;
}

const markerTraversals = () =>
  harness.testClient
    .events()
    .filter((e) => e.event_type === 'marker_traversed')
    .map((e) => e.payload as MarkerTraversedPayload);

describe('ADR-007: runtime tag→marker resolution over the wire', () => {
  it('resolves an opaque tag id to a DIFFERENT marker id before the scheduler acts', async () => {
    // The operator, via a garage, binds two physical RFID tags whose ids are
    // nothing like the marker ids they identify. This is the real-hardware
    // case the registry exists for.
    await publishWire('device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    await harness.testClient.waitForState('railway/state/devices/GARAGE');

    await publishWire('tag_assignment', 'GARAGE', {
      tag_id: 'RFID-AA01',
      assigned_kind: 'marker',
      target_id: 'M1',
    });
    await publishWire('tag_assignment', 'GARAGE', {
      tag_id: 'RFID-BB02',
      assigned_kind: 'marker',
      target_id: 'M2',
    });
    await harness.testClient.waitForState('railway/state/tags/RFID-BB02');

    await publishWire('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    // The train reads the two opaque tags as it moves. Each MUST surface as a
    // marker_traversed for the BOUND marker, never for the tag id.
    await publishWire('tag_observed', 'T1', { tag_id: 'RFID-AA01' });
    await publishWire('tag_observed', 'T1', { tag_id: 'RFID-BB02' });

    await expect
      .poll(() => markerTraversals().some((p) => p.train_id === 'T1' && p.marker_id === 'M2'), {
        timeout: 2_000,
      })
      .toBe(true);

    const traversals = markerTraversals();
    // The indirection is load-bearing: no traversal is ever reported against
    // the raw tag id. If the marker-id-as-tag-id shortcut were still in play,
    // we'd see a marker_traversed for 'RFID-BB02' here.
    expect(traversals.some((p) => p.marker_id === 'RFID-AA01')).toBe(false);
    expect(traversals.some((p) => p.marker_id === 'RFID-BB02')).toBe(false);
    expect(traversals.map((p) => p.marker_id)).toContain('M2');

    // And the server's authoritative layout position for the train is the
    // resolved marker, M2.
    await expect
      .poll(() => harness.server.getScheduler().getTrainState('T1')?.last_marker_id, {
        timeout: 2_000,
      })
      .toBe('M2');
  });

  it('emits an info anomaly for an observed tag with no registry binding (unknown tag still anomalies)', async () => {
    await publishWire('device_registered', 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    await harness.testClient.waitForState('railway/state/devices/T1');

    // No tag_assignment for this tag has ever been published.
    await publishWire('tag_observed', 'T1', { tag_id: 'RFID-GHOST-9' });

    await expect
      .poll(
        () =>
          harness.testClient
            .events()
            .some(
              (e) =>
                e.event_type === 'anomaly' &&
                typeof (e.payload as { description?: string }).description === 'string' &&
                (e.payload as { description: string }).description.includes('RFID-GHOST-9'),
            ),
        { timeout: 2_000 },
      )
      .toBe(true);

    // The unknown tag produces no phantom traversal — it does not advance any
    // train into the logical graph.
    expect(markerTraversals().length).toBe(0);
  });
});
