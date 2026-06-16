import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Gate hold/release: the operator holds a real `GateDevice` at M3 (the physical
 * button — its `hold()` — or the server's `hold_gate` override). The device emits
 * `gate_state_changed: withholding`; the scheduler's `core.gates_clearance`
 * capability vetoes any clearance whose limit is M3, so a physics loco routed
 * `M1 → M3` is cleared only to M2 and self-stops there. Releasing the gate lets the
 * scheduler extend clearance to M3.
 *
 * Everything is real and over the broker — gate device, scheduler, physics train —
 * driven synchronously through the in-memory bus. The unique signal is the operator
 * round-trip: hold → gate_state_changed → scheduler veto → held train.
 *
 * Safety-critical regression: a held gate must prevent the train from crossing the
 * gated marker, and must unblock it promptly on release.
 */

const buildScene = () =>
  straightLoop(
    [
      { id: 'M1', kind: 'block_boundary' },
      { id: 'M2', kind: 'block_boundary' },
      { id: 'M3', kind: 'block_boundary' },
      { id: 'M4', kind: 'block_boundary' },
    ],
    { spacingMm: 200, name: 'gate-hold-release' },
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

describe('Operator hold/release gate: the scheduler obeys the gate state', () => {
  it('holding GATE-1 at M3 stops the train at M2; releasing lets it advance to M3', () => {
    // A gate over M3, registered with core.gates_clearance, held before the train
    // has any clearance toward M3.
    const gate = env.spawnGate('GATE-1', { markers: ['M3'] });
    gate.hold('M3', 'operator hold test');

    // A loco routed through the gated marker. The scheduler clears it to M2 (the
    // marker before the gate) but no further while M3 is withheld.
    env.spawnTrain('T1', { atMarker: 'M1' });
    env.assignSchedule('T1', ['M1', 'M3']);
    env.advance(4000);

    expect(grants()[0]?.payload.limit_marker_id).toBe('M2');
    expect(grants('M3')).toHaveLength(0);
    // The body is held at M2 — it never crossed into M3's block.
    const x = env.world.bodies().find((b) => b.id === 'T1')?.x ?? 0;
    expect(x).toBeLessThan(400); // M3 sits at x=400

    // Release the gate: the scheduler re-evaluates and extends clearance to M3.
    gate.release('M3');
    env.advance(4000);

    expect(grants('M3').length).toBeGreaterThanOrEqual(1);
  });

  it('the server hold_gate / release_gate override drives the same veto', () => {
    env.spawnGate('GATE-1', { markers: ['M3'] });
    env.server.publishCommand('GATE-1', 'hold_gate', { marker_id: 'M3', reason: 'maintenance' });

    env.spawnTrain('T1', { atMarker: 'M1' });
    env.assignSchedule('T1', ['M1', 'M3']);
    env.advance(4000);

    expect(grants('M3')).toHaveLength(0);

    env.server.publishCommand('GATE-1', 'release_gate', { marker_id: 'M3' });
    env.advance(4000);

    expect(grants('M3').length).toBeGreaterThanOrEqual(1);
  });
});
