/**
 * BEHAVIOUR GATE for ADR-022 reverse authority — the SIMULATOR-side enactment,
 * driven through the real Simulation + BrokerBridge + in-process broker (no
 * mocks, injected virtual clock, pristine fault profile, fixed seed).
 *
 * ADR-022 adds a bounded, signed (backward) clearance, `grant_reverse`, that the
 * scheduler issues to break a closed nose-to-nose standoff: it backs one train
 * OUT of a block it occupies, over track it provably holds, so a peer can
 * proceed. The scheduler's DECISION (when to grant, which train, how far back,
 * the safety walk) is proven at the scheduler level in
 * `packages/core/src/scheduler/scheduler.test.ts` — including the resolvable
 * standoff that now reverses and the report-don't-force fallback.
 *
 * This file proves the OTHER half of the vertical slice: that a real
 * `VirtualTrain`, on receiving a `grant_reverse` off the wire, physically BACKS
 * UP — moving its head backward along the held edges to the granted marker via
 * the virtual clock (deterministic, no Math.random / Date.now), emitting a
 * `tag_observed` for each marker it backs onto, then stopping. Application code
 * cannot tell this virtual reverse from a physical one — the simulator-as-peer
 * commitment (ADR-013). The command is published exactly as the server would
 * publish it (`railway/commands/{device}` with `{command_type, payload}`), so
 * the bridge → `simulation.handleCommand` path is the real one.
 */

import type { Layout } from '@trainframe/protocol';
import { InMemoryBrokerClient } from '@trainframe/server';
import { describe, expect, it } from 'vitest';
import { BrokerBridge } from './broker-bridge.js';
import { Simulation } from './simulation.js';

/* A short single-track spur: a train sits with its head at SM having driven
   L1->L2->S1->SM, occupying that run. A reverse grant backs it to S1. */
const SPUR: Layout = {
  name: 'reverse-spur',
  markers: [
    { id: 'L1', kind: 'block_boundary' },
    { id: 'L2', kind: 'block_boundary' },
    { id: 'S1', kind: 'block_boundary' },
    { id: 'SM', kind: 'block_boundary' },
    { id: 'S2', kind: 'block_boundary' },
  ],
  edges: [
    { from_marker_id: 'L1', to_marker_id: 'L2', estimated_length_mm: 200 },
    { from_marker_id: 'L2', to_marker_id: 'S1', estimated_length_mm: 200 },
    { from_marker_id: 'S1', to_marker_id: 'SM', estimated_length_mm: 200 },
    { from_marker_id: 'SM', to_marker_id: 'S2', estimated_length_mm: 200 },
  ],
  junctions: [],
};

interface Observed {
  device_id: string;
  tag_id: string;
}

/* Pristine physics + zero detection latency so marker observations land
   synchronously and deterministically, with no missed reads — the test asserts
   on the exact retreat reports. `train_status_interval_ms: 0` silences status
   broadcasts the test does not consume. */
const PRISTINE = {
  miss_rate: 0,
  double_read_rate: 0,
  spurious_read_rate: 0,
  stopping_noise: 0,
  overshoot_rate: 0,
  detection_latency_ms: { mean: 0, stddev: 0 },
  train_status_interval_ms: 0,
  length_mm: 100,
} as const;

/**
 * Wire a real Simulation to a real in-process broker via the BrokerBridge, with
 * identity tags seeded so `tag_observed` payloads carry marker IDs. Returns the
 * sim, the broker client, the captured marker observations, and a teardown.
 */
function setup(seed: number): {
  sim: Simulation;
  client: InMemoryBrokerClient;
  observed: Observed[];
  stop: () => void;
} {
  const sim = new Simulation({ layout: SPUR, seed, tick_ms: 50 });
  const client = new InMemoryBrokerClient();
  const observed: Observed[] = [];
  client.subscribe('railway/events/+/+', (message) => {
    const parts = message.topic.split('/');
    if (parts[2] !== 'tag_observed') return;
    try {
      const env = JSON.parse(new TextDecoder().decode(message.payload)) as {
        device_id?: unknown;
        payload?: { tag_id?: unknown };
      };
      const device_id = typeof env.device_id === 'string' ? env.device_id : (parts[3] ?? '');
      const tag_id = typeof env.payload?.tag_id === 'string' ? env.payload.tag_id : '';
      if (tag_id) observed.push({ device_id, tag_id });
    } catch {
      /* ignore */
    }
  });
  let seq = 0;
  const newId = (): string => {
    seq += 1;
    return `id-${seq}`;
  };
  const bridge = new BrokerBridge(sim, client, { newId });
  bridge.start();
  sim.seedIdentityTags(SPUR);
  return { sim, client, observed, stop: () => bridge.stop() };
}

/** Publish a command exactly as the server would (envelope on the device topic). */
function sendCommand(
  client: InMemoryBrokerClient,
  device_id: string,
  command_type: string,
  payload: unknown,
): void {
  const envelope = JSON.stringify({ command_type, payload });
  client.publish(`railway/commands/${device_id}`, new TextEncoder().encode(envelope));
}

describe('reverse authority — simulator enactment (ADR-022)', () => {
  it('backs the train up to the granted marker, reporting each marker it crosses', () => {
    const { sim, client, observed, stop } = setup(5);

    /* Place the train with its head at SM, occupying the run S1->SM->...: it has
       driven L2->S1->SM. `grant_reverse` will back it from SM to S1. */
    const train = sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'S1', to_marker_id: 'SM' },
      config: PRISTINE,
    });
    /* Snap the head onto SM (end of the S1->SM block) — its occupied position. */
    train.placeAt({ from_marker_id: 'S1', to_marker_id: 'SM' }, 200);
    expect(train.getCurrentEdge()).toEqual({ from_marker_id: 'S1', to_marker_id: 'SM' });

    observed.length = 0; // ignore the spawn-time observation

    /* The scheduler-issued reverse grant: back to S1, over the held edge S1->SM
       (head-first). Published on the wire exactly as the server would. */
    sendCommand(client, 'T1', 'grant_reverse', {
      limit_marker_id: 'S1',
      edges: [{ from_marker_id: 'S1', to_marker_id: 'SM' }],
      reason: 'deadlock_reverse',
    });

    /* Advance the virtual clock; the train backs up. Deterministic — same seed,
       same motion. */
    for (let t = 0; t < 10_000; t += 50) {
      sim.advance(50);
      if (train.getCurrentEdge()?.from_marker_id === 'S1' && train.getDistanceIntoEdge() === 0) {
        break;
      }
    }
    /* One more advance to flush the detection-latency-scheduled marker emit for
       the marker reached on the final tick. */
    sim.advance(50);

    /* The head has reached S1 (distance 0 at the from-end of S1->SM) and stopped. */
    expect(train.getDistanceIntoEdge()).toBe(0);
    expect(train.getVelocity()).toBe(0);
    /* It reported backing onto S1 — the scheduler tracks the retreat from this. */
    expect(observed.some((o) => o.device_id === 'T1' && o.tag_id === 'S1')).toBe(true);

    stop();
  });

  it('backs up across multiple held edges to a deeper target, in order', () => {
    const { sim, client, observed, stop } = setup(9);

    /* Head at SM having driven L2->S1->SM; reverse all the way back to L2 across
       two held edges {S1->SM, L2->S1}, head-first. */
    const train = sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'S1', to_marker_id: 'SM' },
      config: PRISTINE,
    });
    train.placeAt({ from_marker_id: 'S1', to_marker_id: 'SM' }, 200);
    observed.length = 0;

    sendCommand(client, 'T1', 'grant_reverse', {
      limit_marker_id: 'L2',
      edges: [
        { from_marker_id: 'S1', to_marker_id: 'SM' },
        { from_marker_id: 'L2', to_marker_id: 'S1' },
      ],
      reason: 'deadlock_reverse',
    });

    for (let t = 0; t < 20_000; t += 50) {
      sim.advance(50);
      if (train.getCurrentEdge()?.from_marker_id === 'L2' && train.getDistanceIntoEdge() === 0) {
        break;
      }
    }
    /* Flush the latency-scheduled emit for the final marker (L2). */
    sim.advance(50);

    /* Reached L2, stopped, and reported S1 (intermediate) BEFORE L2 (target). */
    expect(train.getCurrentEdge()).toEqual({ from_marker_id: 'L2', to_marker_id: 'S1' });
    expect(train.getDistanceIntoEdge()).toBe(0);
    expect(train.getVelocity()).toBe(0);
    const t1marks = observed.filter((o) => o.device_id === 'T1').map((o) => o.tag_id);
    expect(t1marks.indexOf('S1')).toBeGreaterThanOrEqual(0);
    expect(t1marks.indexOf('L2')).toBeGreaterThan(t1marks.indexOf('S1'));

    stop();
  });

  it('revoke_clearance ends the reverse and the train stops giving ground', () => {
    const { sim, client, stop } = setup(3);
    const train = sim.spawnTrain('T1', {
      startEdge: { from_marker_id: 'S1', to_marker_id: 'SM' },
      config: PRISTINE,
    });
    train.placeAt({ from_marker_id: 'S1', to_marker_id: 'SM' }, 200);

    sendCommand(client, 'T1', 'grant_reverse', {
      limit_marker_id: 'L2',
      edges: [
        { from_marker_id: 'S1', to_marker_id: 'SM' },
        { from_marker_id: 'L2', to_marker_id: 'S1' },
      ],
      reason: 'deadlock_reverse',
    });
    sim.advance(500); // back up partway
    const distMidReverse = train.getDistanceIntoEdge();

    /* Revoke ends reversing: the train decelerates to a stop and does not reach
       the deeper target. */
    sendCommand(client, 'T1', 'revoke_clearance', { reason: 'admin', immediate: true });
    for (let t = 0; t < 3_000; t += 50) sim.advance(50);
    expect(train.getVelocity()).toBe(0);
    /* It did not complete the reverse to L2 — it stopped where revoke caught it
       (still on the first backward edge S1->SM, having moved less than a full
       edge back). */
    expect(train.getCurrentEdge()?.from_marker_id).toBe('S1');
    expect(distMidReverse).toBeLessThan(200);

    stop();
  });
});
