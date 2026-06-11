import { describe, expect, it } from 'vitest';
import { PhysicsWorld } from './world.js';
import { buildYardLayout } from './yard.js';

const seg = (w: PhysicsWorld, id: string) => w.bodies().find((b) => b.id === id)?.segment;
/** The set of segments a body visits while running (proves the route taken). */
function visited(w: PhysicsWorld, id: string, steps: number): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < steps; i++) {
    w.step(0.05);
    const s = seg(w, id);
    if (s) seen.add(s);
  }
  return seen;
}

describe('yard interior — symmetric pass-through ladder', () => {
  it('a train from the WEST throat diverts into slot 0 when the west points select it', () => {
    const yard = buildYardLayout();
    const w = new PhysicsWorld(yard.net);
    w.setSwitch('Jw', 'slot0');
    w.setSwitch('Je', 'thru'); // slot 0 not yet cleared to exit → it stays in the slot
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: 'leadW',
    });
    const seen = visited(w, 'T', 120);
    expect(seen.has('slot0')).toBe(true);
    expect(seen.has('slot1')).toBe(false);
  });

  it('routes straight through when both points are set thru', () => {
    const yard = buildYardLayout();
    const w = new PhysicsWorld(yard.net);
    w.setSwitch('Jw', 'thru');
    w.setSwitch('Je', 'thru');
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 100,
      facing: 1,
      motion: 'forward',
      segment: 'leadW',
    });
    const seen = visited(w, 'T', 160);
    expect(seen.has('thru')).toBe(true);
    expect(seen.has('slot0')).toBe(false);
    expect(seen.has('slot1')).toBe(false);
  });

  it('is indifferent to the IN side: a train from the EAST throat diverts into slot 1', () => {
    const yard = buildYardLayout();
    const w = new PhysicsWorld(yard.net);
    w.setSwitch('Je', 'slot1'); // the east points select slot 1 for the eastbound arrival
    // Enter from the east lead facing WEST, driving forward (i.e. westward into the yard).
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 350,
      facing: -1,
      motion: 'forward',
      segment: 'leadE',
    });
    const seen = visited(w, 'T', 160);
    expect(seen.has('slot1')).toBe(true);
    expect(seen.has('slot0')).toBe(false);
  });
});
