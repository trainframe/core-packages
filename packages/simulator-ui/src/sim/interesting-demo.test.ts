import { describe, expect, it } from 'vitest';
import { buildMainLoopScene } from '../physics/interesting-layout.js';
import { buildInterestingDemo } from './interesting-demo.js';

const STEP_S = 1 / 120;

describe('interesting-demo — the running world behind the view', () => {
  it('the lapping train MOVES and rides over the self-crossing flyover', () => {
    const { world } = buildInterestingDemo(buildMainLoopScene());
    const startT = world.bodies().find((b) => b.id === 'T');
    if (startT === undefined) throw new Error('no lapping train');
    const startPt = { x: startT.x, y: startT.y };

    let maxDist = 0;
    let rodeFlyover = false;
    for (let i = 0; i < 120 * 120; i++) {
      world.step(STEP_S);
      const t = world.bodies().find((b) => b.id === 'T');
      if (t === undefined) continue;
      maxDist = Math.max(maxDist, Math.hypot(t.x - startPt.x, t.y - startPt.y));
      if (t.segment === 'satB-loop') rodeFlyover = true;
    }

    /* Movement: the train genuinely circulated (not the zero-movement bug). */
    expect(maxDist).toBeGreaterThan(600);
    /* It diverted over the self-crossing flyover. */
    expect(rodeFlyover).toBe(true);
    /* Nothing fell off the rails. */
    expect(world.bodies().every((b) => b.mode === 'railed')).toBe(true);
  });
});
