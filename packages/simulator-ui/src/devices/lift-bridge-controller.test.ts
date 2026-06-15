import { describe, expect, it } from 'vitest';
import { buildLiftBridgeLayout } from '../physics/lift-bridge.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsLinkActuator } from '../sim/link-actuator.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { LiftBridgeController } from './lift-bridge-controller.js';
import type { LinkActuator } from './link-actuator.js';
import { TrainDevice } from './train-device.js';

/** Stage the lift bridge (span starts raised) with a train on the near approach
 *  and run the controller to completion (or a step cap). Returns the world, the
 *  span actuator, the final phase, and a pose reader. */
function serviceRun(holdRaisedS: number): {
  world: PhysicsWorld;
  span: LinkActuator;
  phase: string;
  poseOf: (id: string) => ReturnType<PhysicsWorld['bodies']>[number] | undefined;
  stepUntil: (pred: () => boolean, cap?: number) => void;
} {
  const layout = buildLiftBridgeLayout();
  const w = new PhysicsWorld(layout.net);
  w.addBody({ id: 'T', kind: 'loco', railPos: 200, facing: 1, segment: 'near', color: 'red' });

  const train = new TrainDevice('T', physicsMotorActuator(w, 'T'));
  const span = physicsLinkActuator(w, layout.linkId, { startRaised: true });
  const ctrl = new LiftBridgeController({
    train,
    span,
    look: (x, y) => {
      const s = w.sampleAt(x, y, 22);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    farSensePoint: layout.farSensePoint,
    holdRaisedS,
  });
  /* The train wants to move from the start; the controller's withhold is the only
   *  thing keeping it short of the gap. */
  train.forward();

  const dt = 1 / 60;
  const stepUntil = (pred: () => boolean, cap = 6000): void => {
    for (let i = 0; i < cap && !pred(); i++) {
      ctrl.tick(dt);
      w.step(dt);
    }
  };
  return {
    world: w,
    span,
    phase: ctrl.currentPhase,
    poseOf: (id) => w.bodies().find((b) => b.id === id),
    stepUntil,
  };
}

describe('LiftBridgeController — held → lower → cross', () => {
  it('holds the train OUT while the span is raised: it never crosses or runs off', () => {
    const r = serviceRun(2);
    /* Step through the whole hold window (2s) — the span is up the entire time. */
    r.stepUntil(() => false, Math.round(1.5 * 60));
    const t = r.poseOf('T');
    expect(r.span.connected).toBe(false); // withholding — rail broken
    expect(t?.segment).toBe('near'); // held this side of the gap
    expect(t?.fate).toBe('on-rail'); // it did NOT run off
  });

  it('lowers the span and only then releases the train to cross onto the far approach', () => {
    const r = serviceRun(2);
    const ctrlDone = (): boolean => r.poseOf('T')?.segment === 'far';
    r.stepUntil(ctrlDone);
    const t = r.poseOf('T');
    expect(r.span.connected).toBe(true); // granted — span seated
    expect(t?.segment).toBe('far'); // crossed onto the far approach
    expect(t?.fate).toBe('on-rail'); // crossed cleanly, never ran off
  });

  it('the span is physically seated (raise ~0) by the time clearance is granted', () => {
    const r = serviceRun(0);
    r.stepUntil(() => r.poseOf('T')?.segment === 'span' || r.poseOf('T')?.segment === 'far');
    /* Whenever the train is allowed onto the span, the deck must be fully down. */
    expect(r.span.raise).toBeLessThan(0.01);
  });
});
