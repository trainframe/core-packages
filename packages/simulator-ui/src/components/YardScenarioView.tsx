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
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import { physicsSwitchActuator } from '../devices/switch-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { YardController } from '../devices/yard-controller.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { type YardSegGeom, buildYardLayout } from '../physics/yard.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const CAM_R = 20;

/** Draw one rail segment as a wooden plank with a routed groove. */
function Plank({ seg }: { seg: YardSegGeom }) {
  const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay);
  const ang = (Math.atan2(seg.by - seg.ay, seg.bx - seg.ax) * 180) / Math.PI;
  const ph = 7;
  return (
    <g transform={`translate(${(seg.ax + seg.bx) / 2},${(seg.ay + seg.by) / 2}) rotate(${ang})`}>
      <rect
        x={-len / 2}
        y={-ph}
        width={len}
        height={2 * ph}
        rx={3}
        fill="url(#tf-wood)"
        stroke="#9a7b46"
        strokeWidth={1}
      />
      <line
        x1={-len / 2}
        y1={0}
        x2={len / 2}
        y2={0}
        stroke="#6f4c28"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
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
      segment: 'slotB',
      color: '#8e44ad',
    });
    w.addBody({
      id: 'p1',
      kind: 'carriage',
      railPos: 132,
      facing: 1,
      segment: 'slotB',
      color: '#8e44ad',
    });
    w.couple('p0', 'p1');

    const train = new TrainDevice('L', physicsMotorActuator(w, 'L'));
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
      entrySlot: 'slotA',
      sparesSlot: 'slotB',
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
        {segs.map(([id, s]) => (
          <Plank key={id} seg={s} />
        ))}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* The XY gantry: two foundation rails, the bridge at the crane's x, and the
            crane head (camera + wedge) at its current working position. */}
        <line
          x1={minX + 40}
          y1={railTop}
          x2={maxX - 40}
          y2={railTop}
          stroke="#9aa6b3"
          strokeWidth={6}
        />
        <line
          x1={minX + 40}
          y1={railBot}
          x2={maxX - 40}
          y2={railBot}
          stroke="#9aa6b3"
          strokeWidth={6}
        />
        <line
          x1={crane.x}
          y1={railTop}
          x2={crane.x}
          y2={railBot}
          stroke="#b7c0cb"
          strokeWidth={5}
        />
        <g transform={`translate(${crane.x},${crane.y})`} data-testid="yard-crane">
          <rect
            x={-16}
            y={-16}
            width={32}
            height={32}
            rx={4}
            fill="#5a6470"
            stroke="#39414b"
            strokeWidth={2}
          />
          <circle cx={0} cy={-4} r={4} fill="#bcdcea" stroke="#5d7f8e" strokeWidth={1} />
          <line x1={0} y1={6} x2={0} y2={20} stroke="#39414b" strokeWidth={3} />
          <path d="M -6 20 L 0 30 L 6 20 Z" fill="#caa033" stroke="#8a6c1f" strokeWidth={1} />
        </g>
      </svg>
    </div>
  );
}
