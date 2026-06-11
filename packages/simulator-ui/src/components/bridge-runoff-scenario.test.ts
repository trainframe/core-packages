/**
 * Headless integration of the bridge run-off (the same wiring
 * `BridgeRunoffScenarioView` runs, minus React): the span is staged RAISED (its
 * link disconnected) and an UNCONTROLLED train drives forward with NO
 * `LiftBridgeController` to hold it. It must reach the open gap and RUN OFF
 * (fate `ran-off`, mode `free`) — the contrast that proves the controlled demo's
 * hold is doing real work. Mirrors the video harness's `bridge-runoff` CHECK at
 * the physics level, so the re-skin is proven without standing up a browser.
 */
import { describe, expect, it } from 'vitest';
import { physicsLinkActuator } from '../devices/link-actuator.js';
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { buildLiftBridgeLayout } from '../physics/lift-bridge.js';
import { PhysicsWorld } from '../physics/world.js';

const STEP_S = 1 / 120;

describe('bridge run-off — an unheld train drives off the raised span', () => {
  it('runs off into the gap because no controller withholds it (span stays up)', () => {
    const layout = buildLiftBridgeLayout();
    const w = new PhysicsWorld(layout.net);
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 200,
      facing: 1,
      segment: 'near',
      color: '#c0392b',
      power: 280,
      maxSpeed: 130,
    });

    const train = new TrainDevice('T', physicsMotorActuator(w, 'T'));
    /* Span raised and LEFT there — no controller ever lowers it. */
    const span = physicsLinkActuator(w, layout.linkId, { startRaised: true });
    train.forward();

    const poseOf = (id: string): ReturnType<PhysicsWorld['bodies']>[number] | undefined =>
      w.bodies().find((b) => b.id === id);

    /* Drive until the train leaves the rails (or a generous step cap). */
    for (let i = 0; i < 120 * 12 && poseOf('T')?.fate === 'on-rail'; i++) {
      span.step(STEP_S);
      w.step(STEP_S);
    }

    const t = poseOf('T');
    /* The span was never lowered — the rail is still broken. */
    expect(span.connected).toBe(false);
    /* And the unheld train ran clean off into the gap. */
    expect(t?.fate).toBe('ran-off');
    expect(t?.mode).toBe('free');
  });
});
