import type { Layout } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { BUILTIN_CAPABILITIES } from '../builtins/index.js';
import { CapabilityRegistry } from '../registry.js';
import { LayoutState } from './layout-state.js';
import { Scheduler } from './scheduler.js';

/**
 * A runtime length report (ADR-023) republishes the train's retained device
 * state. That snapshot replaces the previous one wholesale, so it must still
 * carry everything else the train's retained state says: its presentation
 * fields and that it has been introduced.
 */
const LINE: Layout = {
  name: 'line',
  markers: ['M1', 'M2', 'M3'].map((id) => ({ id, kind: 'block_boundary' as const })),
  edges: [
    { from_marker_id: 'M1', to_marker_id: 'M2', estimated_length_mm: 200 },
    { from_marker_id: 'M2', to_marker_id: 'M3', estimated_length_mm: 200 },
  ],
  junctions: [],
};

const TRAIN_CAPABILITIES = ['core.controls_motion', 'core.reports_marker_traversal'];

const makeScheduler = (): Scheduler => {
  const registry = new CapabilityRegistry();
  registry.registerAll(BUILTIN_CAPABILITIES);
  registry.freeze();
  const now = () => 0;
  const scheduler = new Scheduler(registry, new LayoutState(LINE, { now }), { now });
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'T1',
    payload: { capabilities: TRAIN_CAPABILITIES, name: 'Puffer', livery: 'green' },
  });
  scheduler.handleEvent({
    event_type: 'device_registered',
    device_id: 'YARD',
    payload: { capabilities: ['core.reports_length'] },
  });
  return scheduler;
};

const reportLength = (scheduler: Scheduler, lengthMm: number) =>
  scheduler.handleEvent({
    event_type: 'train_length_changed',
    device_id: 'YARD',
    payload: { train_id: 'T1', train_length_mm: lengthMm },
  });

describe('a runtime length report', () => {
  it('keeps the name, livery and introduced flag in the republished device state', () => {
    const scheduler = makeScheduler();
    scheduler.introduceTrainWithVector('T1', { from_marker_id: 'M1', to_marker_id: 'M2' });

    expect(reportLength(scheduler, 300)).toEqual([
      {
        kind: 'update_state_snapshot',
        entity_type: 'devices',
        entity_id: 'T1',
        state: {
          capabilities: TRAIN_CAPABILITIES,
          train_length_mm: 300,
          name: 'Puffer',
          livery: 'green',
          introduced: true,
        },
      },
    ]);
  });

  it('leaves the introduced flag out for a train still off the map', () => {
    const scheduler = makeScheduler();

    expect(reportLength(scheduler, 300)).toEqual([
      {
        kind: 'update_state_snapshot',
        entity_type: 'devices',
        entity_id: 'T1',
        state: {
          capabilities: TRAIN_CAPABILITIES,
          train_length_mm: 300,
          name: 'Puffer',
          livery: 'green',
        },
      },
    ]);
  });
});
