import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation.js';

/**
 * VirtualGate's public observers, through the Simulation seam — added so a
 * renderer (the toy table's lift bridge, experimental 005) can draw a gate's
 * true mechanical state without parsing the event stream.
 */
describe('Simulation.getGate / VirtualGate.isWithholding', () => {
  const LAYOUT = {
    name: 'test',
    markers: [{ id: 'M1', kind: 'block_boundary' as const }],
    edges: [],
    junctions: [],
  };

  it('exposes the spawned gate; unknown ids are undefined', () => {
    const sim = new Simulation({ layout: LAYOUT, seed: 1 });
    const gate = sim.spawnGate('BRIDGE-1');
    expect(sim.getGate('BRIDGE-1')).toBe(gate);
    expect(sim.getGate('BRIDGE-nope')).toBeUndefined();
  });

  it('isWithholding follows withhold/release per marker', () => {
    const sim = new Simulation({ layout: LAYOUT, seed: 1 });
    const gate = sim.spawnGate('BRIDGE-1');
    expect(gate.isWithholding('M1')).toBe(false);
    gate.withhold('M1', 'span raised');
    expect(gate.isWithholding('M1')).toBe(true);
    expect(gate.isWithholding('M2')).toBe(false);
    gate.release('M1');
    expect(gate.isWithholding('M1')).toBe(false);
  });
});
