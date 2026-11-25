import type { EdgeRef } from '@trainframe/core';
import {
  type PhysicsEnv,
  startPhysicsEnv,
  straightLoop,
} from '@trainframe/simulator/physics-env.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/*
 * ADR-036 Integration test suite — six introduction lifecycle scenarios driven
 * through the REAL stack: real in-process broker, real @trainframe/server
 * scheduler, real physics world, real devices. No mocks of any kind.
 *
 * Layout for all scenarios: a 6-marker straight loop (single segment, identity
 * tags, evenly spaced at 500 mm). Marker order around the loop:
 *
 *   MA → MB → MC → MD → ME → MF → MA
 *
 * Observation notes:
 *   - `marker_traversed` is emitted by the SERVER (device_id = 'server');
 *     the train is identified by payload.train_id.
 *   - `commandsFor(deviceId)` filters by the device the command is addressed
 *     to (the topic suffix), which IS the train id for train commands.
 *   - `train_introduced` and `train_introduction_conflict` are also server
 *     events (device_id = 'server'); train ids live in their payloads.
 */

const MARKERS = [
  { id: 'MA', kind: 'block_boundary' },
  { id: 'MB', kind: 'block_boundary' },
  { id: 'MC', kind: 'station_stop' },
  { id: 'MD', kind: 'block_boundary' },
  { id: 'ME', kind: 'station_stop' },
  { id: 'MF', kind: 'block_boundary' },
] as const satisfies readonly { id: string; kind: string }[];

/* Encode a payload to the wire format the in-process bus expects. */
const encode = (payload: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify({ payload }));

/* Check if a train traversed a given marker (server-emitted events). */
const didTraverse = (env: PhysicsEnv, trainId: string, markerId: string): boolean =>
  env
    .eventsOfType('marker_traversed')
    .some((e) => e.payload.train_id === trainId && e.payload.marker_id === markerId);

let env: PhysicsEnv;

afterEach(() => {
  env.shutdown();
});

/* -------------------------------------------------------------------------
 * Scenario 1 — Clean roll introduction (ADR-036 §3a)
 *
 * A train spawned with introduced:false receives an introduceTrain() call
 * with no heading. The scheduler sends an `introduce_train` command to the
 * device. The device does a two-marker forward roll. After crossing two
 * distinct markers the scheduler emits `train_introduced` and the train
 * becomes routable — a subsequently-assigned schedule produces movement to
 * the target stop.
 * ------------------------------------------------------------------------- */
describe('Scenario 1 — clean roll introduction (§3a)', () => {
  beforeEach(() => {
    env = startPhysicsEnv(straightLoop(MARKERS));
  });

  it('train crosses two markers during roll then becomes routable via a subsequent schedule', () => {
    /* Spawn un-introduced at MA (railPos 0). */
    env.spawnTrain('T1', {
      atMarker: 'MA',
      railPos: 0,
      facing: 1,
      introduced: false,
    });

    /* Let registration reach the scheduler. */
    env.advance(200);

    /* No train_introduced event yet. */
    expect(env.eventsOfType('train_introduced')).toHaveLength(0);

    /* Operator issues the introduction gesture — begins the two-marker roll. */
    env.introduceTrain('T1');

    /* The scheduler must have sent an introduce_train command to the device. */
    const rollCmd = env.commandsFor('T1').find((c) => c.command_type === 'introduce_train');
    expect(rollCmd, 'introduce_train command sent to device for §3a roll').toBeDefined();

    /* Advance until the two-marker roll resolves (generous cap). */
    for (let i = 0; i < 40 && env.eventsOfType('train_introduced').length === 0; i++) {
      env.advance(1_000);
    }

    /* train_introduced must be on the bus after the two-marker roll. */
    const introEvts = env.eventsOfType('train_introduced');
    expect(introEvts, 'train_introduced event emitted after two-marker roll').toHaveLength(1);
    const hdg = introEvts[0]?.payload?.heading_edge;
    expect(typeof hdg, 'heading_edge present in payload').toBe('object');

    /* Now assign a schedule and verify the train moves to the stop. */
    env.assignSchedule('T1', ['ME']);
    for (let i = 0; i < 60 && !didTraverse(env, 'T1', 'ME'); i++) {
      env.advance(2_000);
    }

    expect(didTraverse(env, 'T1', 'ME'), 'train reaches ME station after roll introduction').toBe(
      true,
    );

    /* No "no path" anomalies. */
    const noPath = env
      .eventsOfType('anomaly')
      .some((e) => String(e.payload.description).includes('no path'));
    expect(noPath, 'no "no path" anomaly emitted').toBe(false);
  });
});

/* -------------------------------------------------------------------------
 * Scenario 2 — Pending-schedule auto-start (ADR-036 §4)
 *
 * A schedule is assigned BEFORE introduction. The scheduler holds it pending
 * (no clearance grant). The instant the vector resolves — via the operator
 * vector path (§3c) for deterministic timing — the train begins executing
 * the schedule and reaches the scheduled stop.
 * ------------------------------------------------------------------------- */
describe('Scenario 2 — pending-schedule auto-start (§4)', () => {
  beforeEach(() => {
    env = startPhysicsEnv(straightLoop(MARKERS));
  });

  it('schedule assigned before introduction auto-starts the moment the vector resolves', () => {
    env.spawnTrain('T1', {
      atMarker: 'MA',
      railPos: 0,
      facing: 1,
      introduced: false,
    });

    env.advance(200);

    /* Assign schedule BEFORE introducing — it must be held pending. */
    env.assignSchedule('T1', ['ME']);

    /* No clearance has been granted yet (train not yet routable). */
    const grantsBefore = env.commandsFor('T1').filter((c) => c.command_type === 'grant_clearance');
    expect(grantsBefore, 'no clearance granted before introduction').toHaveLength(0);

    /* Introduce with a known operator vector (§3c) — instant resolution. */
    const headingEdge: EdgeRef = { from_marker_id: 'MA', to_marker_id: 'MB' };
    env.introduceTrain('T1', headingEdge);

    /* A clearance grant must be dispatched synchronously by the scheduler. */
    const grantsAfter = env.commandsFor('T1').filter((c) => c.command_type === 'grant_clearance');
    expect(grantsAfter, 'clearance granted immediately on vector resolution').not.toHaveLength(0);

    /* Drive to the stop. */
    for (let i = 0; i < 60 && !didTraverse(env, 'T1', 'ME'); i++) {
      env.advance(2_000);
    }

    expect(didTraverse(env, 'T1', 'ME'), 'train reaches ME after pending-schedule auto-start').toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------
 * Scenario 3 — Operator/placer-provided vector (ADR-036 §3c)
 *
 * introduceTrain(id, headingEdge) resolves the vector immediately — no roll
 * command is sent to the device, no two-marker wait — and the train becomes
 * routable at once. The train then runs its schedule.
 * ------------------------------------------------------------------------- */
describe('Scenario 3 — operator-provided vector (§3c)', () => {
  beforeEach(() => {
    env = startPhysicsEnv(straightLoop(MARKERS));
  });

  it('resolves immediately with NO introduce_train command and makes the train routable', () => {
    env.spawnTrain('T1', {
      atMarker: 'MA',
      railPos: 0,
      facing: 1,
      introduced: false,
    });

    env.advance(200);

    const headingEdge: EdgeRef = { from_marker_id: 'MA', to_marker_id: 'MB' };
    env.introduceTrain('T1', headingEdge);

    /* No introduce_train roll command must have been sent to the device. */
    const rollCmd = env.commandsFor('T1').find((c) => c.command_type === 'introduce_train');
    expect(rollCmd, 'no introduce_train roll command sent for §3c path').toBeUndefined();

    /* train_introduced event is on the bus immediately. */
    const introEvts = env.eventsOfType('train_introduced');
    expect(introEvts, 'train_introduced event published').toHaveLength(1);
    const hdg = introEvts[0]?.payload?.heading_edge as
      | { from_marker_id: string; to_marker_id: string }
      | undefined;
    expect(hdg?.from_marker_id, 'heading_edge from_marker_id').toBe('MA');
    expect(hdg?.to_marker_id, 'heading_edge to_marker_id').toBe('MB');

    /* Train is now routable — assign a schedule and verify movement. */
    env.assignSchedule('T1', ['ME']);
    for (let i = 0; i < 60 && !didTraverse(env, 'T1', 'ME'); i++) {
      env.advance(2_000);
    }

    expect(didTraverse(env, 'T1', 'ME'), 'train reaches ME without a roll').toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Scenario 4 — Zone-provided heading (ADR-036 §3b)
 *
 * A device registered with `core.provides_train_heading` publishes a
 * `train_introduced` event. The scheduler resolves the vector from that
 * event with no roll and the train becomes routable immediately.
 *
 * Authority gate: a device WITHOUT the capability publishing the same event
 * is ignored — the train remains un-introduced.
 * ------------------------------------------------------------------------- */
describe('Scenario 4 — zone-provided heading (§3b)', () => {
  beforeEach(() => {
    env = startPhysicsEnv(straightLoop(MARKERS));
  });

  it('capable zone resolves vector with no roll; non-capable emitter is ignored', () => {
    env.spawnTrain('T1', {
      atMarker: 'MA',
      railPos: 0,
      facing: 1,
      introduced: false,
    });

    env.advance(200);

    /*
     * Authority-gate check: a plain device (no capability) publishes
     * train_introduced. The bus is synchronous, so the scheduler has
     * already processed it by the time we read state below.
     */
    env.client.publish(
      'railway/events/device_registered/PLAIN-DEVICE',
      encode({ capabilities: [], device_kind_hint: 'plain-device' }),
    );
    env.client.publish(
      'railway/events/train_introduced/PLAIN-DEVICE',
      encode({
        train_id: 'T1',
        marker_id: 'MA',
        heading_edge: { from_marker_id: 'MA', to_marker_id: 'MB' },
      }),
    );

    /* Train must still be un-introduced (authority gate rejected the non-capable emitter). */
    const state0 = env.server.getScheduler().getTrainState('T1');
    expect(
      state0?.introduced,
      'non-capable emitter ignored — train still not introduced',
    ).toBeFalsy();

    /* Register a heading-capable zone device and emit train_introduced. */
    env.client.publish(
      'railway/events/device_registered/YARD-ZONE',
      encode({ capabilities: ['core.provides_train_heading'], device_kind_hint: 'railyard' }),
    );
    env.client.publish(
      'railway/events/train_introduced/YARD-ZONE',
      encode({
        train_id: 'T1',
        marker_id: 'MA',
        heading_edge: { from_marker_id: 'MA', to_marker_id: 'MB' },
      }),
    );

    /* No roll command — the zone resolved it directly. */
    const rollCmd = env.commandsFor('T1').find((c) => c.command_type === 'introduce_train');
    expect(rollCmd, 'no roll command for zone-resolved introduction').toBeUndefined();

    /* The train is now introduced. */
    const state1 = env.server.getScheduler().getTrainState('T1');
    expect(state1?.introduced, 'train introduced via zone capability').toBe(true);

    /* And is routable. */
    env.assignSchedule('T1', ['ME']);
    for (let i = 0; i < 60 && !didTraverse(env, 'T1', 'ME'); i++) {
      env.advance(2_000);
    }

    expect(didTraverse(env, 'T1', 'ME'), 'train reaches ME after zone introduction').toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Scenario 5 — Trailing-follow yields (ADR-036 §5 resolvable)
 *
 * T1 is introduced at MA holding the MA→MB block (no schedule, stationary).
 * T2 is introduced with vector MF→MA — it resolves into the block immediately
 * BEHIND T1, not the same block T1 holds.
 *
 * The resolvable path: trailing T2 yields under ordinary block exclusivity.
 * No `train_introduction_conflict` is raised. T1 runs on when given a
 * schedule; T2 follows once the block clears.
 * ------------------------------------------------------------------------- */
describe('Scenario 5 — trailing-follow yields, not a conflict (§5 resolvable)', () => {
  beforeEach(() => {
    env = startPhysicsEnv(straightLoop(MARKERS));
  });

  it('introduced train resolving behind a leader does NOT escalate; only the trailer waits', () => {
    /*
     * Layout of this scenario:
     *
     *   MF → MA → MB → MC → MD → ME → MF (loop)
     *
     * T1 starts at MA and is given a schedule to ME immediately. We let T1
     * advance past MB (so it releases the MA→MB block) before introducing
     * T2. T2 resolves with vector MF→MA — the block immediately behind where
     * T1 was. Once T1 has released MA→MB, T2's block (MF→MA) no longer
     * shares an active boundary marker with T1's held blocks, so T2 is
     * granted clearance normally (no conflict escalation).
     */
    env.spawnTrain('T1', {
      atMarker: 'MA',
      railPos: 0,
      facing: 1,
      introduced: true,
      headingEdge: { from_marker_id: 'MA', to_marker_id: 'MB' },
    });

    env.advance(200);

    /* T1 is introduced — give it a long schedule so it keeps moving. */
    env.assignSchedule('T1', ['ME']);

    /* Advance until T1 has crossed MB (released the MA→MB block). */
    for (let i = 0; i < 20 && !didTraverse(env, 'T1', 'MB'); i++) {
      env.advance(500);
    }
    expect(didTraverse(env, 'T1', 'MB'), 'T1 crosses MB before T2 is introduced').toBe(true);

    /* T2: spawned at MF (the block behind MA on the loop), un-introduced. */
    env.spawnTrain('T2', {
      atMarker: 'MF',
      railPos: 2_500 /* MF is at index 5 × 500 mm on the straightLoop */,
      facing: 1,
      introduced: false,
    });

    env.advance(200);

    /* Introduce T2 with vector MF→MA. T1 has already released MA→MB so there
     * is no shared active boundary marker — this is the resolvable path. */
    const t2Edge: EdgeRef = { from_marker_id: 'MF', to_marker_id: 'MA' };
    env.introduceTrain('T2', t2Edge);

    /* NO conflict event — this is the resolvable trailing-follow path. */
    expect(
      env.eventsOfType('train_introduction_conflict'),
      'no train_introduction_conflict for trailing-follow',
    ).toHaveLength(0);

    /* Both trains are introduced. */
    expect(env.server.getScheduler().getTrainState('T1')?.introduced, 'T1 remains introduced').toBe(
      true,
    );
    expect(
      env.server.getScheduler().getTrainState('T2')?.introduced,
      'T2 introduced successfully',
    ).toBe(true);

    /* Give T2 a schedule: MC (it gets clearance normally and follows T1). */
    env.assignSchedule('T2', ['MC']);

    /* T1 should reach MD. */
    for (let i = 0; i < 80 && !didTraverse(env, 'T1', 'MD'); i++) {
      env.advance(2_000);
    }
    expect(didTraverse(env, 'T1', 'MD'), 'T1 runs on to MD unimpeded').toBe(true);

    /* T2 should eventually reach MC once T1 has cleared the blocks ahead. */
    for (let i = 0; i < 80 && !didTraverse(env, 'T2', 'MC'); i++) {
      env.advance(2_000);
    }
    expect(didTraverse(env, 'T2', 'MC'), 'T2 proceeds to MC after the block clears').toBe(true);
  });
});

/* -------------------------------------------------------------------------
 * Scenario 6 — Deadlock/overlap escalates (ADR-036 §5 unresolvable)
 *
 * T1 is introduced at MA with vector MA→MB and is stationary (holding the
 * MA→MB block as its seed occupancy). T2 is introduced with the SAME vector
 * MA→MB — it resolves directly into the block T1 already occupies.
 *
 * The scheduler must emit `train_introduction_conflict` naming both trains
 * and the contested block, and T2's pending schedule must NOT start.
 * ------------------------------------------------------------------------- */
describe('Scenario 6 — co-occupation escalates to conflict (§5 unresolvable)', () => {
  beforeEach(() => {
    env = startPhysicsEnv(straightLoop(MARKERS));
  });

  it('vector resolving into a held block emits train_introduction_conflict and starts no schedule', () => {
    /* T1: introduced, stationary, holds MA→MB. */
    env.spawnTrain('T1', {
      atMarker: 'MA',
      railPos: 0,
      facing: 1,
      introduced: true,
      headingEdge: { from_marker_id: 'MA', to_marker_id: 'MB' },
    });

    env.advance(200);

    /*
     * T2: un-introduced, at MA (slightly offset in physics so the bodies
     * don't collide), with a pending schedule.
     */
    env.spawnTrain('T2', {
      atMarker: 'MA',
      railPos: 30,
      facing: 1,
      introduced: false,
    });

    env.advance(200);

    env.assignSchedule('T2', ['ME']);

    /* No clearance for T2 before introduction. */
    expect(
      env.commandsFor('T2').filter((c) => c.command_type === 'grant_clearance'),
      'no clearance for T2 before introduction',
    ).toHaveLength(0);

    /* Introduce T2 with the SAME vector as T1 — direct co-occupation. */
    const conflictEdge: EdgeRef = { from_marker_id: 'MA', to_marker_id: 'MB' };
    env.introduceTrain('T2', conflictEdge);

    /* train_introduction_conflict must be raised. */
    const conflicts = env.eventsOfType('train_introduction_conflict');
    expect(conflicts, 'train_introduction_conflict event emitted').toHaveLength(1);

    const cp = conflicts[0]?.payload;
    const involvedTrains = [String(cp?.train_id ?? ''), String(cp?.conflicting_train_id ?? '')];
    expect(involvedTrains, 'conflict names T1').toContain('T1');
    expect(involvedTrains, 'conflict names T2').toContain('T2');

    /* T2's pending schedule must NOT have started — no clearance granted. */
    expect(
      env.commandsFor('T2').filter((c) => c.command_type === 'grant_clearance'),
      'T2 schedule does not start while conflict is unresolved',
    ).toHaveLength(0);

    /* Allow some time — T2 must not traverse any markers. */
    env.advance(10_000);

    expect(
      env.eventsOfType('marker_traversed').some((e) => e.payload.train_id === 'T2'),
      'T2 does not move while conflict is unresolved',
    ).toBe(false);
  });
});
