import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Multi-gate semantics (ADR-018): when several `core.gates_clearance` devices gate
 * the SAME marker, clearance across that marker is conjunctive AND — a train is
 * cleared only when EVERY gate grants, and a single withhold is an absolute veto no
 * peer's grant can cancel.
 *
 * `gate-hold-release.test.ts` locks the n=1 case. This file locks n>1. Two real
 * `GateDevice`s both withhold M3 over the in-memory broker; the scheduler folds
 * their `gates_clearance` votes (veto-on-any-deny) and must hold a physics loco at
 * M2 until BOTH release.
 *
 * The discriminating assertion — the one that distinguishes conjunctive AND from a
 * single-gate veto — is the middle step: after releasing ONE gate, the scheduler
 * re-evaluates (the release re-runs the fold) with the OTHER gate's deny still
 * standing, and clearance must STILL be withheld. The final release is the positive
 * control proving the block was real and the grant path is live.
 *
 * Everything is real and synchronous over the bus: two gate devices, the scheduler,
 * a physics train. No mocks, no polling, no real-time deadlines.
 */

const buildScene = () =>
  straightLoop(
    [
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'block_boundary' },
      { id: 'M4', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'multi-gate-clearance' },
  );

let env: PhysicsEnv;

beforeEach(() => {
  env = startPhysicsEnv(buildScene());
});

afterEach(() => {
  env.shutdown();
});

const grants = (limit?: string) =>
  env
    .commandsFor('T1')
    .filter(
      (c) =>
        c.command_type === 'grant_clearance' &&
        (limit === undefined || c.payload.limit_marker_id === limit),
    );

describe('Multi-gate clearance is conjunctive AND (ADR-018)', () => {
  it('two gates on M3: train held until BOTH release; releasing one alone keeps it held', () => {
    /* Two independent gating devices, each gating the SAME marker M3 for its own
     * reason. Both register via the broker → server → scheduler with
     * core.gates_clearance. Both withhold M3 before the train has any clearance
     * past M2. */
    const gateA = env.spawnGate('GATE-A', { markers: ['M3'] });
    const gateB = env.spawnGate('GATE-B', { markers: ['M3'] });
    gateA.hold('M3', 'gate A reason');
    gateB.hold('M3', 'gate B reason');

    /* A loco routed through the gated marker. The scheduler clears it to M2 (the
     * marker before the gate) but no further while M3 is withheld. */
    env.spawnTrain('T1', { atMarker: 'M1' });
    env.assignSchedule('T1', ['M1', 'M3']);
    env.advance(4000);

    /* The train received the initial M2 clearance, and with both gates holding,
     * no M3 grant arrived. The body is held at M2, never crossing into M3's
     * block (M3 sits at x=400). */
    expect(grants()[0]?.payload.limit_marker_id).toBe('M2');
    expect(grants('M3')).toHaveLength(0);
    const heldX = env.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(heldX).toBeLessThan(400);

    /* Release ONE gate. Its granting event re-runs the scheduler fold — but
     * GATE-B's deny still stands. Under conjunctive AND the train must STILL be
     * held. (Under a broken OR/priority fold, one grant would un-veto the peer
     * and M3 would clear.) */
    gateA.release('M3');
    env.advance(2000);
    expect(grants('M3')).toHaveLength(0); // discriminating: AND, not OR
    const stillHeldX = env.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(stillHeldX).toBeLessThan(400);

    /* Release the SECOND gate. Now no gate withholds M3, so clearance extends.
     * This positive control proves the block above was real and the grant path
     * is live (not merely "the grant hadn't arrived yet"). */
    gateB.release('M3');
    env.advance(4000);
    expect(grants('M3').length).toBeGreaterThanOrEqual(1);
  });

  it('disconnect composes: a gate vanishing mid-withhold drops only its own veto', () => {
    /* "Disconnect composes cleanly" (ADR-018 Consequences): a gate's
     * onDeviceDisconnect releases only THAT device's withholds. With a peer still
     * holding the same marker under AND, the train stays held. */
    const gateA = env.spawnGate('GATE-A', { markers: ['M3'] });
    const gateB = env.spawnGate('GATE-B', { markers: ['M3'] });
    gateA.hold('M3', 'gate A reason');
    gateB.hold('M3', 'gate B reason');

    env.spawnTrain('T1', { atMarker: 'M1' });
    env.assignSchedule('T1', ['M1', 'M3']);
    env.advance(4000);

    expect(grants('M3')).toHaveLength(0);
    const heldX = env.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(heldX).toBeLessThan(400);

    /* GATE-A vanishes. Its disconnect hook releases ONLY its own withhold; the
     * scheduler re-evaluates clearance, but GATE-B's deny survives → still held. */
    env.server.injectEvent('device_disconnected', 'GATE-A', {});
    env.advance(2000);
    expect(grants('M3')).toHaveLength(0); // peer veto outlives the vanished gate
    const stillHeldX = env.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(stillHeldX).toBeLessThan(400);

    /* Release the surviving gate → clearance extends (positive control). */
    gateB.release('M3');
    env.advance(4000);
    expect(grants('M3').length).toBeGreaterThanOrEqual(1);
  });
});
