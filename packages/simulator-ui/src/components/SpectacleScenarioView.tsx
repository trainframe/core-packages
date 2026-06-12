/**
 * The SPECTACLE, rendered (ADR-030). A multi-train running LOOP with real curved
 * corners and a JUNCTION that splits off into the railyard, with the yard
 * reachable through the split and rejoining the loop. Builds the combined
 * switched network (`buildSpectacle`), seeds three trains + a spare cut, and runs
 * the `SpectacleController`, which keeps the fleet collision-free with block
 * clearance and periodically peels ONE train into the real `YardController`
 * service (camera scan + crane wedge + proximity coupling on the real rails — the
 * CORRECT physics yard, no phantom flip, no floating rakes).
 *
 * Nothing here is keyframed; the view only renders authoritative physics state.
 * Mounted by `App` on `?physics=spectacle`. Exposes `window.__tfPhysics` so the
 * video harness can assert progress, the swap, and that nothing collided.
 */
import { useEffect, useMemo, useState } from 'react';
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import {
  SpectacleController,
  type SpectacleTrain,
  type YardJob,
} from '../devices/spectacle-controller.js';
import { physicsSwitchActuator } from '../devices/switch-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { type SpectacleLayout, buildSpectacle } from '../physics/spectacle.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const CAM_R = 20;

const RED = '#c0392b';
const BLUE = '#2d6cdf';
const GREEN = '#27ae60';
const GOLD = '#e0a81e';

/** An SVG path traced along a rail (straight or curved) by sampling it. */
function railPath(rail: { length: number; at: (d: number) => { x: number; y: number } }): string {
  const n = Math.max(8, Math.ceil(rail.length / 14));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const p = rail.at((rail.length * i) / n);
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d;
}

/** A rail segment drawn as a wooden plank band with a routed groove, following
 *  the real (possibly curved) centre-line — the ADR-024 workshop aesthetic. */
function SegArt({ d }: { d: string }) {
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke="#cba460"
        strokeWidth={14}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={d}
        fill="none"
        stroke="#9a7b46"
        strokeWidth={14}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.25}
      />
      <path
        d={d}
        fill="none"
        stroke="#6f4c28"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

/** A points blade marker at a junction throat — a small steel tongue, so the
 *  split where the running line diverges to the yard reads as a real junction. */
function PointsMark({ x, y }: { x: number; y: number }) {
  return (
    <g data-testid="spectacle-junction" transform={`translate(${x},${y})`}>
      <circle r={9} fill="#8893a0" stroke="#5e6772" strokeWidth={1.5} />
      <line x1={-6} y1={0} x2={10} y2={-8} stroke="#39414b" strokeWidth={3} strokeLinecap="round" />
    </g>
  );
}

/** Seed the spectacle world: three trains (loco + 3 carriages) spaced around the
 *  loop, a gold spare cut in slot1, and the controller with two slot-swapped yard
 *  jobs so a carriage migrates train→train. Returns the world + controller. */
function buildSpectacleRun(layout: SpectacleLayout): {
  world: PhysicsWorld;
  ctrl: SpectacleController;
} {
  const world = new PhysicsWorld(layout.net);
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
  return { world, ctrl };
}

export function SpectacleScenarioView() {
  const layout = useMemo(() => buildSpectacle(3), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [services, setServices] = useState(0);

  useEffect(() => {
    const { world, ctrl } = buildSpectacleRun(layout);

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    /* One fixed physics step: tick the controller (block clearance + the yard
     *  service), then step the world. Extracted so the rAF tick stays simple. */
    const advance = (): void => {
      ctrl.tick(STEP_S);
      world.step(STEP_S);
      elapsed += STEP_S;
    };
    setPoses(world.bodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        advance();
        acc -= STEP_S;
      }
      setPoses(world.bodies());
      setServices(ctrl.servicesCompleted);
      window.__tfPhysics = { name: 'spectacle', elapsedS: elapsed, bodies: () => world.bodies() };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
    };
  }, [layout]);

  const segs = [...layout.geom.entries()];
  const xs = segs.flatMap(([, s]) => [s.ax, s.bx]);
  const ys = segs.flatMap(([, s]) => [s.ay, s.by]);
  const minX = Math.min(...xs) - 180;
  const maxX = Math.max(...xs) + 180;
  const minY = Math.min(...ys) - 200;
  const maxY = Math.max(...ys) + 200;
  /* The junction throat: the diverge block's east end (where the branch leaves). */
  const diverge = layout.geom.get(layout.divergeBlock);

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#efe6d3' }}>
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 16,
          fontFamily: 'sans-serif',
          fontSize: 15,
          color: '#5a4a2a',
        }}
        data-testid="physics-title"
      >
        Spectacle — three trains run the curved loop on block clearance; one peels off into the yard
        (services {services})
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Spectacle — multi-train loop with a railyard split</title>
        <WoodDefs />
        {/* Every rail (loop straights + curved corners + branch connectors + yard
            spine/slots/legs) traced from its real centre-line. */}
        {segs.map(([id]) => (
          <SegArt key={id} d={railPath(layout.net.railOf(id))} />
        ))}
        {diverge !== undefined && <PointsMark x={diverge.bx} y={diverge.by} />}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
      </svg>
    </div>
  );
}
