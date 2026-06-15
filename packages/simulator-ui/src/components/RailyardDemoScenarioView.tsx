/**
 * The RAILYARD DEMO, rendered (ADR-030). A multi-loop layout: a rounded MAIN loop with
 * real curved corners that ENCLOSES the railyard (a JUNCTION splits trains off into
 * it and they rejoin on the far side), plus an independent INNER ring, plus station
 * platforms. The MAIN loop's trains take turns being shunted through the real
 * railyard — its CV gantry crane rides a truss over the slots and works the wedge —
 * while the inner ring runs its own trains past its own halt.
 *
 * Everything self-drives through the `RailyardDemoController`: each loop is its own
 * block-clearance cycle (collision-free by construction), and the controller peels
 * main-loop trains into the yard one at a time for a full physics service (camera
 * scan + crane wedge + proximity coupling on the real rails — the CORRECT physics
 * yard, no phantom flip, no floating rakes).
 *
 * Nothing here is keyframed; the view only renders authoritative physics state plus
 * the crane head's sensed position. Mounted by `App` on `?physics=railyard-demo`.
 * Exposes `window.__tfPhysics` so the video harness can assert progress + the swaps.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  RailyardDemoController,
  type RailyardDemoTrain,
  type RailyardLoopRun,
  type YardJob,
} from '../devices/railyard-demo-controller.js';
import { TrainDevice } from '../devices/train-device.js';
import { type RailyardScene, type Station, buildRailyardScene } from '../physics/railyard-scene.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { physicsMotorActuator } from '../sim/motor-actuator.js';
import { physicsSwitchActuator } from '../sim/switch-actuator.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const CAM_R = 20;

const RED = '#c0392b';
const BLUE = '#2d6cdf';
const GREEN = '#27ae60';
const GOLD = '#e0a81e';
const ORANGE = '#d4761e';
const PURPLE = '#8e44ad';

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
    <g data-testid="railyard-junction" transform={`translate(${x},${y})`}>
      <circle r={9} fill="#8893a0" stroke="#5e6772" strokeWidth={1.5} />
      <line x1={-6} y1={0} x2={10} y2={-8} stroke="#39414b" strokeWidth={3} strokeLinecap="round" />
    </g>
  );
}

/** A vertical girder truss (two chords + a zig-zag web) — the camera-crane rides
 *  this across the yard. */
function Truss({ x, top, bot }: { x: number; top: number; bot: number }) {
  const w = 9;
  const bays = Math.max(4, Math.round((bot - top) / 70));
  const web: string[] = [];
  for (let i = 0; i < bays; i++) {
    const y0 = top + ((bot - top) * i) / bays;
    const y1 = top + ((bot - top) * (i + 1)) / bays;
    web.push(`M${x - w} ${y0} L${x + w} ${y1}`);
    web.push(`M${x + w} ${y0} L${x - w} ${y1}`);
  }
  return (
    <g data-testid="yard-truss">
      <line x1={x - w} y1={top} x2={x - w} y2={bot} stroke="#8893a0" strokeWidth={3} />
      <line x1={x + w} y1={top} x2={x + w} y2={bot} stroke="#8893a0" strokeWidth={3} />
      <path d={web.join(' ')} fill="none" stroke="#a7b1bd" strokeWidth={2} />
    </g>
  );
}

/** The yard's CV gantry: two foundation rails the truss bridge rolls along (the
 *  metal frame), the truss at the crane's x, and the crane head (camera + wedge)
 *  at its sensed position. Bounded to the yard footprint. */
function YardGantry({
  bounds,
  crane,
}: {
  bounds: { minX: number; maxX: number; top: number; bot: number };
  crane: { x: number; y: number };
}) {
  const { minX, maxX, top, bot } = bounds;
  return (
    <g data-testid="yard-gantry">
      {[top, bot].map((gy) => (
        <g key={gy}>
          <rect
            x={minX}
            y={gy - 5}
            width={maxX - minX}
            height={10}
            rx={2}
            fill="#8893a0"
            stroke="#5e6772"
            strokeWidth={1}
          />
          <line x1={minX} y1={gy} x2={maxX} y2={gy} stroke="#c3cbd4" strokeWidth={1.5} />
        </g>
      ))}
      <Truss x={crane.x} top={top} bot={bot} />
      <g transform={`translate(${crane.x},${crane.y})`} data-testid="yard-crane">
        <rect
          x={-17}
          y={-17}
          width={34}
          height={34}
          rx={4}
          fill="#5a6470"
          stroke="#39414b"
          strokeWidth={2}
        />
        <circle cx={0} cy={-4} r={4.5} fill="#bcdcea" stroke="#5d7f8e" strokeWidth={1} />
        <line x1={0} y1={6} x2={0} y2={22} stroke="#39414b" strokeWidth={3} />
        <path d="M -6 22 L 0 32 L 6 22 Z" fill="#caa033" stroke="#8a6c1f" strokeWidth={1} />
      </g>
    </g>
  );
}

/** A station platform beside the running line: a planked slab offset to one side
 *  of the track, a coloured platform edge, and a hanging name board. */
function Platform({ station }: { station: Station }) {
  const rad = (station.angleDeg * Math.PI) / 180;
  /* Perpendicular to travel, toward `side`; offset the slab clear of the rail. */
  const nx = Math.sin(rad) * station.side;
  const ny = -Math.cos(rad) * station.side;
  const off = 28;
  const cx = station.x + nx * off;
  const cy = station.y + ny * off;
  const depth = 40;
  return (
    <g
      data-testid={`station-${station.id}`}
      transform={`translate(${cx},${cy}) rotate(${station.angleDeg})`}
    >
      <rect
        x={-station.length / 2}
        y={-depth / 2}
        width={station.length}
        height={depth}
        rx={5}
        fill="#cdbca0"
        stroke="#9c8866"
        strokeWidth={1.5}
      />
      {/* Plank seams across the platform. */}
      {Array.from({ length: Math.round(station.length / 30) }, (_, i) => {
        const px = -station.length / 2 + (i + 1) * 30;
        return (
          <line
            key={px}
            x1={px}
            y1={-depth / 2}
            x2={px}
            y2={depth / 2}
            stroke="#9c8866"
            strokeWidth={0.8}
            opacity={0.5}
          />
        );
      })}
      {/* The platform edge nearest the track (yellow safety line). */}
      <rect
        x={-station.length / 2}
        y={(-depth / 2) * station.side - 2 * station.side}
        width={station.length}
        height={4}
        fill="#e7b53b"
        opacity={0.9}
      />
      {/* Name board. */}
      <g transform={`rotate(${-station.angleDeg})`}>
        <rect x={-44} y={-11} width={88} height={22} rx={4} fill="#2f3b2c" stroke="#1c241a" />
        <text
          x={0}
          y={5}
          textAnchor="middle"
          fontFamily="sans-serif"
          fontSize={13}
          fontWeight={700}
          fill="#f0ead6"
        >
          {station.name}
        </text>
      </g>
    </g>
  );
}

/** Seed the railyard demo world and controller: three trains on the main (yard-fed)
 *  loop spaced around it, two trains on the inner ring, a gold spare cut in slot1,
 *  and three slot-rotated yard jobs so carriages migrate train→train across three
 *  successive services. Returns the world + controller. */
function buildRailyardDemoRun(layout: RailyardScene): {
  world: PhysicsWorld;
  ctrl: RailyardDemoController;
} {
  const world = new PhysicsWorld(layout.net);
  const seedTrain = (loco: string, color: string, seg: string, railPos: number, cars = 3): void => {
    world.addBody({
      id: loco,
      kind: 'loco',
      railPos,
      facing: 1,
      segment: seg,
      color,
      power: 820,
      maxSpeed: 300,
    });
    for (let i = 0; i < cars; i++) {
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
  /* Main (yard-fed) loop. LA starts near the top-west corner — a short run to the
   *  diverge, so the first yard service begins promptly rather than after a lap. */
  seedTrain('LA', RED, 'top', 1780);
  seedTrain('LB', BLUE, 'bottom', 700);
  seedTrain('LC', GREEN, 'rightA', 150);
  /* Inner ring. */
  seedTrain('LD', ORANGE, 'iBottom', 320, 2);
  seedTrain('LE', PURPLE, 'iTop', 320, 2);

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

  const train = (id: string): RailyardDemoTrain => ({
    train: new TrainDevice(id, physicsMotorActuator(world, id)),
    locoId: id,
  });
  const loops: RailyardLoopRun[] = [
    {
      order: layout.loops[0]?.blocks.map((b) => b.id) ?? [],
      trains: [train('LA'), train('LB'), train('LC')],
    },
    {
      order: layout.loops[1]?.blocks.map((b) => b.id) ?? [],
      trains: [train('LD'), train('LE')],
    },
  ];
  /* Three slot-rotated jobs → a carriage migrates along the whole chain:
   *  LA sheds→slot0, picks slot1 (gold); LB sheds→slot1, picks slot0 (LA's cut);
   *  LC sheds→slot0, picks slot1 (LB's cut). */
  const yardJobs: YardJob[] = [
    { locoId: 'LA', entrySlot: 'slot0', sparesSlot: 'slot1' },
    { locoId: 'LB', entrySlot: 'slot1', sparesSlot: 'slot0' },
    { locoId: 'LC', entrySlot: 'slot0', sparesSlot: 'slot1' },
  ];
  const ctrl = new RailyardDemoController({
    layout,
    loops,
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

/** The yard's footprint (for placing the gantry frame) — the bbox of its segments
 *  plus a margin so the foundation rails clear the slots. */
function yardBounds(layout: RailyardScene): {
  minX: number;
  maxX: number;
  top: number;
  bot: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const id of layout.yard.geom.keys()) {
    const g = layout.yard.geom.get(id);
    if (g === undefined) continue;
    minX = Math.min(minX, g.ax, g.bx);
    maxX = Math.max(maxX, g.ax, g.bx);
    minY = Math.min(minY, g.ay, g.by);
    maxY = Math.max(maxY, g.ay, g.by);
  }
  return { minX: minX - 30, maxX: maxX + 30, top: minY - 42, bot: maxY + 42 };
}

export function RailyardDemoScenarioView() {
  const layout = useMemo(() => buildRailyardScene(3), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [crane, setCrane] = useState<{ x: number; y: number }>({ x: 1100, y: 600 });
  const [services, setServices] = useState(0);

  useEffect(() => {
    const { world, ctrl } = buildRailyardDemoRun(layout);

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
      setCrane(ctrl.cranePos);
      setServices(ctrl.servicesCompleted);
      window.__tfPhysics = {
        name: 'railyard-demo',
        elapsedS: elapsed,
        bodies: () => world.bodies(),
      };
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
  const gantry = yardBounds(layout);

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
        Railyard demo — trains run two loops past their stations; the main loop's trains take turns
        through the CV railyard (services {services})
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Railyard demo — multi-loop layout with a railyard split</title>
        <WoodDefs />
        {/* Every rail (loop straights + curved corners + inner ring + branch
            connectors + yard spine/slots/legs) traced from its real centre-line. */}
        {segs.map(([id]) => (
          <SegArt key={id} d={railPath(layout.net.railOf(id))} />
        ))}
        {layout.stations.map((s) => (
          <Platform key={s.id} station={s} />
        ))}
        {diverge !== undefined && <PointsMark x={diverge.bx} y={diverge.by} />}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* The CV gantry (metal frame + truss + crane head) rides over the yard,
            drawn last so the overhead crane head sits above the train it works. */}
        <YardGantry bounds={gantry} crane={crane} />
      </svg>
    </div>
  );
}
