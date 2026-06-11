import { describe, expect, it } from 'vitest';
import { buildTurntableLayout, stubSensePoint } from '../physics/turntable.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsMotorActuator } from './motor-actuator.js';
import { physicsSwitchActuator } from './switch-actuator.js';
import { TrainDevice } from './train-device.js';
import { TurntableActuator } from './turntable-actuator.js';
import { TurntableController } from './turntable-controller.js';

/** Stage the turntable, a visiting loco on the trunk, and run the controller to
 *  completion (or a step cap). Returns the world + final phase + a pose reader. */
function serviceRun(): {
  world: PhysicsWorld;
  phase: string;
  poseOf: (id: string) => ReturnType<PhysicsWorld['bodies']>[number] | undefined;
} {
  const layout = buildTurntableLayout();
  const w = new PhysicsWorld(layout.net);
  w.addBody({ id: 'L', kind: 'loco', railPos: 200, facing: 1, segment: 'trunk', color: 'red' });

  const train = new TrainDevice('L', physicsMotorActuator(w, 'L'));
  const deck = new TurntableActuator({
    exits: [
      { position: layout.trunk, angleDeg: 0 },
      ...layout.stubs.map((s) => ({ position: s.position, angleDeg: s.angleDeg })),
    ],
    switchId: layout.switchId,
    points: physicsSwitchActuator(w, layout.switchId),
    limits: { minDeg: 0, maxDeg: 360 },
    startDeg: 0,
  });
  const ctrl = new TurntableController({
    train,
    deck,
    look: (x, y) => {
      const s = w.sampleAt(x, y, 22);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    deckCentre: layout.deckCentre,
    trunkExit: layout.trunk,
    departExit: 'stub-e',
    departSensePoint: stubSensePoint(layout, 'stub-e'),
  });

  const dt = 1 / 60;
  for (let i = 0; i < 6000 && ctrl.currentPhase !== 'done'; i++) {
    ctrl.tick(dt);
    w.step(dt);
  }
  return {
    world: w,
    phase: ctrl.currentPhase,
    poseOf: (id) => w.bodies().find((b) => b.id === id),
  };
}

describe('TurntableController — a full turn-around service', () => {
  it('boards the loco, swings the deck, and the loco LEAVES FACING THE OTHER WAY', () => {
    const { phase, poseOf } = serviceRun();
    expect(phase).toBe('done'); // ran the whole choreography

    const loco = poseOf('L');
    expect(loco).toBeDefined();
    // It left via the intended turn-around stub…
    expect(loco?.segment).toBe('seg-stub-e');
    // …and is now FACING THE OTHER WAY: it boarded heading east (rotation 0), and
    // departs reversed (rotation 180), the honest 180° turn-around.
    expect(loco?.rotationDeg).toBe(180);
    // It actually drove clear of the deck centre out onto the stub.
    expect(loco?.x).toBeGreaterThan(800);
  });

  it('holds the loco off a moving deck (never released onto/off a mid-swing bridge)', () => {
    const layout = buildTurntableLayout();
    const w = new PhysicsWorld(layout.net);
    w.addBody({ id: 'L', kind: 'loco', railPos: 200, facing: 1, segment: 'trunk' });
    const train = new TrainDevice('L', physicsMotorActuator(w, 'L'));
    const deck = new TurntableActuator({
      exits: [
        { position: layout.trunk, angleDeg: 0 },
        ...layout.stubs.map((s) => ({ position: s.position, angleDeg: s.angleDeg })),
      ],
      switchId: layout.switchId,
      points: physicsSwitchActuator(w, layout.switchId),
      limits: { minDeg: 0, maxDeg: 360 },
      // Start the deck pointing AWAY from the trunk so it must swing to board.
      startDeg: 135,
    });
    const ctrl = new TurntableController({
      train,
      deck,
      look: (x, y) => {
        const s = w.sampleAt(x, y, 22);
        return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
      },
      deckCentre: layout.deckCentre,
      trunkExit: layout.trunk,
      departExit: 'stub-e',
      departSensePoint: stubSensePoint(layout, 'stub-e'),
    });
    const dt = 1 / 60;
    /* Tick a few frames while the deck is still swinging toward the trunk. */
    for (let i = 0; i < 3; i++) {
      ctrl.tick(dt);
      w.step(dt);
    }
    // Deck not yet aligned with the trunk → the loco is held on the trunk lead.
    expect(deck.alignedExit).not.toBe('trunk');
    expect(train.motion).toBe('stopped');
    expect(w.bodies().find((b) => b.id === 'L')?.segment).toBe('trunk');
  });
});
