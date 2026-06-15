import { describe, expect, it } from 'vitest';
import { buildNetwork } from '../physics/network.js';
import type { Rail } from '../physics/rail.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsLinkActuator } from '../sim/link-actuator.js';

function seg(length: number, endBuffered = false): Rail {
  return {
    length,
    at: (d) => ({ x: d, y: 0, headingDeg: 0 }),
    curvatureAt: () => 0,
    pieceTypeAt: () => 'straight',
    slopeAt: () => 0,
    startBuffered: false,
    endBuffered,
  };
}

function bridgeWorld(): PhysicsWorld {
  /* The near approach buffers at its gap end, so a train held by a raised span
   *  comes to rest there rather than running off. */
  const segments = new Map<string, Rail>([
    ['near', seg(500, true)],
    ['span', seg(500)],
  ]);
  return new PhysicsWorld(buildNetwork(segments, [{ from: 'near', to: 'span', id: 'BRIDGE' }]));
}

const step = (a: { step: (dt: number) => void }, secs: number, dt = 0.05): void => {
  for (let i = 0; i < Math.round(secs / dt); i++) a.step(dt);
};

describe('LinkActuator — honest lift-bridge span', () => {
  it('starts raised → the link is disconnected from the off', () => {
    const w = bridgeWorld();
    const span = physicsLinkActuator(w, 'BRIDGE', { startRaised: true });
    expect(span.connected).toBe(false);
    /* A raised span means the rail is absent immediately: a body driving off the
     *  near end finds nothing connected and stays put. */
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 480,
      facing: 1,
      motion: 'forward',
      segment: 'near',
    });
    for (let i = 0; i < 20; i++) w.step(0.05);
    expect(w.bodies().find((b) => b.id === 'T')?.segment).toBe('near');
  });

  it('disconnects the instant a raise is commanded, before any motion', () => {
    const w = bridgeWorld();
    const span = physicsLinkActuator(w, 'BRIDGE'); // starts down/connected
    expect(span.connected).toBe(true);
    span.setConnected(false);
    /* Default-safe: the link drops immediately, without waiting for the deck. */
    expect(span.connected).toBe(false);
    expect(span.raise).toBeGreaterThan(0);
  });

  it('takes TIME to lower and only reconnects once fully seated', () => {
    const w = bridgeWorld();
    const span = physicsLinkActuator(w, 'BRIDGE', { startRaised: true });
    expect(span.connected).toBe(false);
    expect(span.raise).toBeCloseTo(1, 5);
    span.setConnected(true);
    /* Half a step in, it is still part-way down — NOT yet connected. */
    step(span, 0.5);
    expect(span.raise).toBeGreaterThan(0);
    expect(span.connected).toBe(false);
    /* Given enough time it seats fully and the link reconnects. */
    step(span, 3);
    expect(span.raise).toBeCloseTo(0, 5);
    expect(span.connected).toBe(true);
    expect(span.settled).toBe(true);
  });

  it('drives the world link active flag so a train can then cross', () => {
    const w = bridgeWorld();
    const span = physicsLinkActuator(w, 'BRIDGE', { startRaised: true });
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 200,
      facing: 1,
      motion: 'forward',
      segment: 'near',
    });
    /* Span up: the train cannot leave `near`. */
    for (let i = 0; i < 60; i++) {
      span.step(0.05);
      w.step(0.05);
    }
    expect(w.bodies().find((b) => b.id === 'T')?.segment).toBe('near');
    /* Lower it; once it has physically SEATED, drive on — the train crosses. */
    span.setConnected(true);
    let drove = false;
    for (let i = 0; i < 120; i++) {
      span.step(0.05);
      if (span.connected && !drove) {
        w.setMotion('T', 'forward');
        drove = true;
      }
      w.step(0.05);
    }
    expect(w.bodies().find((b) => b.id === 'T')?.segment).toBe('span');
  });
});
