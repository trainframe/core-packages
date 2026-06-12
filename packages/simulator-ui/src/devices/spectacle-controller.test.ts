import { describe, expect, it } from 'vitest';
import { type SpectacleLayout, buildSpectacle } from '../physics/spectacle.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { physicsMotorActuator } from './motor-actuator.js';
import { SpectacleController, type SpectacleTrain, type YardJob } from './spectacle-controller.js';
import { physicsSwitchActuator } from './switch-actuator.js';
import { TrainDevice } from './train-device.js';

const CAM_R = 20;
const DT = 1 / 60;

const RED = '#c0392b';
const BLUE = '#2d6cdf';
const GREEN = '#27ae60';
const GOLD = '#e0a81e';

/** Stage the spectacle: three locos (loco + 3 carriages each) spaced around the
 *  loop on three different straights, a gold spare cut pre-parked in slot1, and
 *  the controller with TWO yard jobs whose slots SWAP — so the rear cut the first
 *  visit sheds becomes the pick-up of the second (train→train migration). */
function stage(): {
  layout: SpectacleLayout;
  world: PhysicsWorld;
  ctrl: SpectacleController;
  poseOf: (id: string) => BodyPose | undefined;
  step: () => void;
} {
  const layout = buildSpectacle(3);
  const world = new PhysicsWorld(layout.net);

  /* All three trains face along travel (+rail) and run the SAME direction. Gentle
   *  power so the yard service runs in its calibrated regime. */
  const seedTrain = (loco: string, color: string, seg: string, railPos: number): void => {
    world.addBody({
      id: loco,
      kind: 'loco',
      railPos,
      facing: 1,
      segment: seg,
      color,
      power: 700,
      maxSpeed: 260,
    });
    for (let i = 0; i < 3; i++) {
      const id = `${loco}c${i}`;
      world.addBody({
        id,
        kind: 'carriage',
        railPos: railPos - (i + 1) * 68,
        facing: 1,
        segment: seg,
        color,
      });
      world.couple(i === 0 ? loco : `${loco}c${i - 1}`, id);
    }
  };
  seedTrain('LA', RED, 'bottom', 700);
  seedTrain('LB', BLUE, 'top', 700);
  seedTrain('LC', GREEN, 'rightA', 150);

  /* A gold spare cut pre-parked in slot1 (the first job's pick-up). */
  world.addBody({
    id: 'g0',
    kind: 'carriage',
    railPos: 200,
    facing: 1,
    segment: 'slot1',
    color: GOLD,
  });
  world.addBody({
    id: 'g1',
    kind: 'carriage',
    railPos: 132,
    facing: 1,
    segment: 'slot1',
    color: GOLD,
  });
  world.couple('g0', 'g1');

  const train = (id: string): SpectacleTrain => ({
    train: new TrainDevice(id, physicsMotorActuator(world, id)),
    locoId: id,
  });
  /* Job 1: LA sheds into slot0, picks up the gold spares from slot1.
   *  Job 2: LB sheds into slot1, picks up LA's shed cut from slot0 (migration). */
  const yardJobs: YardJob[] = [
    { locoId: 'LA', entrySlot: 'slot0', sparesSlot: 'slot1' },
    { locoId: 'LB', entrySlot: 'slot1', sparesSlot: 'slot0' },
  ];

  const ctrl = new SpectacleController({
    layout,
    trains: [train('LA'), train('LB'), train('LC')],
    loopPoints: physicsSwitchActuator(world, layout.loopSwitch),
    westPoints: physicsSwitchActuator(world, layout.yard.westSwitch),
    eastPoints: physicsSwitchActuator(world, layout.yard.eastSwitch),
    bodies: () => world.bodies(),
    look: (x, y) => {
      const s = world.sampleAt(x, y, CAM_R);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
    cameraRadius: CAM_R,
    wedgeAt: (x, y) => {
      world.uncoupleAt(x, y);
    },
    yardJobs,
  });

  return {
    layout,
    world,
    ctrl,
    poseOf: (id) => world.bodies().find((b) => b.id === id),
    step: () => {
      ctrl.tick(DT);
      world.step(DT);
    },
  };
}

/** The set of body ids coupled into `id`'s rake, by flood-fill over couplings. */
function rake(world: PhysicsWorld, id: string): Set<string> {
  const seen = new Set<string>([id]);
  const stack = [id];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) continue;
    for (const n of world.coupledTo(cur))
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
  }
  return seen;
}

/** Whether any two railed, NON-coupled bodies interpenetrate (centres closer than
 *  the sum of their half-lengths, ~minus a small tolerance). Coupled bodies sit
 *  legitimately at contact, so they are excluded. A true positive here is a
 *  collision/overlap the block discipline was meant to prevent. */
function anyOverlap(world: PhysicsWorld): boolean {
  const bodies = world.bodies().filter((b) => b.mode === 'railed');
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i];
      const b = bodies[j];
      if (a === undefined || b === undefined) continue;
      if (a.coupledTo.includes(b.id)) continue; // coupled — contact is expected
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 50) return true; // < ~2 half-lengths apart and uncoupled → overlap
    }
  }
  return false;
}

const LOCOS = ['LA', 'LB', 'LC'] as const;

/** What the run observed, accumulated step by step (so the `it` block only
 *  asserts). `worstBottomRotation` is the no-flip witness (see below). */
interface RunObservations {
  readonly visited: Map<string, Set<string>>;
  overlapped: boolean;
  leftRails: boolean;
  worstBottomRotation: number;
}

/** Run the spectacle until two services complete (or a generous step cap),
 *  accumulating progress, collision/derail, and the no-flip witness. */
function runSpectacle(sim: ReturnType<typeof stage>): RunObservations {
  const obs: RunObservations = {
    visited: new Map(LOCOS.map((id) => [id, new Set<string>()])),
    overlapped: false,
    leftRails: false,
    worstBottomRotation: 0,
  };
  const STEPS = 60 * 360; // generous: room for two full yard services
  for (let i = 0; i < STEPS && sim.ctrl.servicesCompleted < 2; i++) {
    sim.step();
    const bodies = sim.world.bodies();
    for (const id of LOCOS) {
      const p = bodies.find((b) => b.id === id);
      if (p === undefined) continue;
      obs.visited.get(id)?.add(p.segment);
      /* No-flip witness: on the `bottom` straight (due EAST, world rotation 0°) a
       *  body facing +rail reads ~0 and a FLIPPED one reads ~180. */
      if (p.segment === 'bottom') {
        const dev = Math.abs(((p.rotationDeg + 180) % 360) - 180);
        obs.worstBottomRotation = Math.max(obs.worstBottomRotation, dev);
      }
    }
    if (anyOverlap(sim.world)) obs.overlapped = true;
    if (bodies.some((b) => b.fate !== 'on-rail' || b.mode !== 'railed')) obs.leftRails = true;
  }
  return obs;
}

describe('SpectacleController — multi-train loop + serialised yard', () => {
  it('runs collision-free, traverses the curves + split, services the yard with a train→train swap, and never flips a facing', () => {
    const sim = stage();
    const { visited, overlapped, leftRails, worstBottomRotation } = runSpectacle(sim);

    /* 1. The yard serviced ≥1 train (in fact both jobs ran to completion). */
    expect(sim.ctrl.servicesCompleted).toBeGreaterThanOrEqual(2);

    /* 2. No collision/overlap and no unexpected derail or run-off anywhere — every
     *    body stayed railed throughout. */
    expect(overlapped).toBe(false);
    expect(leftRails).toBe(false);

    /* 3. Every train made real progress AND took the curved corners; the two
     *    serviced trains also traversed the split (the diverge block). */
    for (const id of ['LA', 'LB', 'LC']) {
      const segs = visited.get(id) ?? new Set<string>();
      expect(segs.size).toBeGreaterThan(4); // advanced through many blocks
      const corners = ['cSW', 'cSE', 'cNE', 'cNW'];
      expect(corners.filter((c) => segs.has(c)).length).toBeGreaterThanOrEqual(2);
    }
    expect(visited.get('LA')?.has(sim.layout.divergeBlock)).toBe(true);
    expect(visited.get('LB')?.has(sim.layout.divergeBlock)).toBe(true);

    /* 4. The CORRECT swap, demonstrated train→train. LA picked up the gold spares;
     *    LB then picked up the cut LA shed — carriages migrated train→train. */
    const laRake = rake(sim.world, 'LA');
    expect(laRake.has('g0')).toBe(true); // gold spare migrated yard→LA
    const lbRake = rake(sim.world, 'LB');
    const aCarsOnB = ['LAc0', 'LAc1', 'LAc2'].filter((c) => lbRake.has(c));
    expect(aCarsOnB.length).toBeGreaterThanOrEqual(1); // a former-A car now on B

    /* 5. NO phantom 180° facing flip and NO floating rakes. On the east-heading
     *    `bottom` straight every loco — serviced or not — always read rotation
     *    near 0°, never ~180°: a serviced loco came back through the yard facing
     *    the SAME way (it left forward, no flip). And every body stayed railed —
     *    no carriage teleported or floated free. */
    expect(worstBottomRotation).toBeLessThan(45);
    expect(sim.world.bodies().every((b) => b.mode === 'railed')).toBe(true);
  });
});
