import { Crane } from '@trainframe/simulator/devices/crane.js';
import { TrainDevice } from '@trainframe/simulator/devices/train-device.js';
import { YardController, craneBounds } from '@trainframe/simulator/devices/yard-controller.js';
import { type BodyPose, PhysicsWorld } from '@trainframe/simulator/physics/world.js';
import { buildYardLayout } from '@trainframe/simulator/physics/yard.js';
import { physicsMotorActuator } from '@trainframe/simulator/sim/motor-actuator.js';
import { physicsSwitchActuator } from '@trainframe/simulator/sim/switch-actuator.js';
/**
 * The railyard service, rendered (ADR-030 Plan §4). Builds the yard interior as a
 * switched network, stages a visiting loco+rake on the west lead and a spare cut
 * in a slot, and runs the `YardController` — which drives the train, throws the
 * ladder points, and works the crane wedge, all by looking through its camera.
 * Nothing here is keyframed; the view only renders authoritative physics state.
 *
 * Mounted by `App` on `?physics=railyard`. Exposes `window.__tfPhysics` so the
 * video harness can assert the service happened.
 */
import { useEffect, useMemo, useState } from 'react';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const CAM_R = 20;

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
 *  the real (possibly curved) centre-line. */
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

/** A vertical girder truss (two chords + a zig-zag web) — the camera-crane rides
 *  this across the railing. */
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

export function YardScenarioView() {
  const yard = useMemo(() => buildYardLayout(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [crane, setCrane] = useState<{ x: number; y: number }>({ x: 1100, y: 600 });

  useEffect(() => {
    const w = new PhysicsWorld(yard.net);
    w.addBody({
      id: 'L',
      kind: 'loco',
      railPos: 400,
      facing: 1,
      segment: 'leadW',
      color: '#c0392b',
    });
    for (let i = 0; i < 3; i++) {
      const id = `a${i}`;
      w.addBody({
        id,
        kind: 'carriage',
        railPos: 400 - (i + 1) * 68,
        facing: 1,
        segment: 'leadW',
        color: '#e08a1e',
      });
      w.couple(i === 0 ? 'L' : `a${i - 1}`, id);
    }
    w.addBody({
      id: 'p0',
      kind: 'carriage',
      railPos: 200,
      facing: 1,
      segment: 'slot1',
      color: '#8e44ad',
    });
    w.addBody({
      id: 'p1',
      kind: 'carriage',
      railPos: 132,
      facing: 1,
      segment: 'slot1',
      color: '#8e44ad',
    });
    w.couple('p0', 'p1');

    const train = new TrainDevice('L', physicsMotorActuator(w, 'L'));
    const b = craneBounds(yard);
    const crane = new Crane(b, { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    const ctrl = new YardController({
      layout: yard,
      train,
      westPoints: physicsSwitchActuator(w, 'Jw'),
      eastPoints: physicsSwitchActuator(w, 'Je'),
      look: (x, y) => {
        const s = w.sampleAt(x, y, CAM_R);
        return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
      },
      cameraRadius: CAM_R,
      wedgeAt: (x, y) => {
        w.uncoupleAt(x, y);
      },
      crane,
      entrySlot: 'slot0',
      sparesSlot: 'slot1',
    });

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(w.bodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        ctrl.tick(STEP_S);
        crane.step(STEP_S);
        w.step(STEP_S);
        elapsed += STEP_S;
        acc -= STEP_S;
      }
      setPoses(w.bodies());
      setCrane(ctrl.cranePos);
      window.__tfPhysics = { name: 'railyard', elapsedS: elapsed, bodies: () => w.bodies() };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
    };
  }, [yard]);

  const segs = [...yard.geom.entries()];
  const xs = segs.flatMap(([, s]) => [s.ax, s.bx]);
  const ys = segs.flatMap(([, s]) => [s.ay, s.by]);
  const minX = Math.min(...xs) - 160;
  const maxX = Math.max(...xs) + 160;
  const minY = Math.min(...ys) - 200;
  const maxY = Math.max(...ys) + 170;
  const railTop = Math.min(...ys) - 120;
  const railBot = Math.max(...ys) + 120;

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
        Railyard — CV-driven shunting: camera reads the rake, points route it, the wedge decouples
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Railyard CV-driven service</title>
        <WoodDefs />
        {/* Every rail (spine, slots, smooth S-bend legs) traced from its real
            centre-line, so curved legs render as curves. */}
        {segs.map(([id]) => (
          <SegArt key={id} d={railPath(yard.net.railOf(id))} />
        ))}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* The XY gantry: two foundation girders the bridge rolls along, a truss
            bridge at the crane's x, and the crane head (camera + wedge). */}
        {[railTop, railBot].map((gy) => (
          <g key={gy}>
            <rect
              x={minX + 40}
              y={gy - 5}
              width={maxX - minX - 80}
              height={10}
              rx={2}
              fill="#8893a0"
              stroke="#5e6772"
              strokeWidth={1}
            />
            <line
              x1={minX + 40}
              y1={gy}
              x2={maxX - 40}
              y2={gy}
              stroke="#c3cbd4"
              strokeWidth={1.5}
            />
          </g>
        ))}
        <Truss x={crane.x} top={railTop} bot={railBot} />
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
      </svg>
    </div>
  );
}
