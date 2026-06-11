/**
 * Crane-drop accident, rendered (ADR-030). The crane is a physical gantry that
 * carries a crate, travels along the running line, and — on the operator's
 * (here, scripted) release — sets the crate DOWN ON THE RAIL as foreign matter.
 * A train then sets off, strikes the crate at speed, and derails on it. Nothing
 * is keyframed: the crate is a real physics body the world places via
 * `placeBodyAt`, and the wreck is the ordinary derail fate resolving on contact.
 *
 * Mounted by `App` on `?physics=crane-drop`. Exposes `window.__tfPhysics` so the
 * harness can assert the train derailed and the crate landed on the line.
 */
import { useEffect, useState } from 'react';
import { Crane } from '../devices/crane.js';
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { straightSeg } from '../physics/yard.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const RAIL_Y = 600;
const RAIL_X0 = 150;
const RAIL_X1 = 2050;
const DROP_X = 1200; // where the crate is set down, ahead of the train

/** A vertical girder truss (two chords + a zig-zag web) the crane head rides. */
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
    <g data-testid="crane-truss">
      <line x1={x - w} y1={top} x2={x - w} y2={bot} stroke="#8893a0" strokeWidth={3} />
      <line x1={x + w} y1={top} x2={x + w} y2={bot} stroke="#8893a0" strokeWidth={3} />
      <path d={web.join(' ')} fill="none" stroke="#a7b1bd" strokeWidth={2} />
    </g>
  );
}

export function CraneDropScenarioView() {
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [crane, setCrane] = useState<{ x: number; y: number; carrying: boolean }>({
    x: 1900,
    y: RAIL_Y,
    carrying: true,
  });

  useEffect(() => {
    const w = new PhysicsWorld(straightSeg(RAIL_X0, RAIL_Y, RAIL_X1, RAIL_Y));
    w.addBody({ id: 'T', kind: 'loco', railPos: 120, facing: 1, color: '#c0392b' });
    const train = new TrainDevice('T', physicsMotorActuator(w, 'T'));
    const gantry = new Crane(
      { minX: RAIL_X0, maxX: RAIL_X1, minY: RAIL_Y - 120, maxY: RAIL_Y + 120 },
      { x: 1900, y: RAIL_Y },
    );
    gantry.grab(); // it arrives carrying a crate
    let dropped = false;

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(w.bodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        gantry.moveTo(DROP_X, RAIL_Y);
        gantry.step(STEP_S);
        if (!dropped && gantry.carrying && gantry.arrived) {
          // Set the crate down on the rail, then send the train off into it.
          if (gantry.release()) {
            w.placeBodyAt(
              {
                id: 'crate',
                kind: 'carriage',
                facing: 1,
                color: '#7c5a33',
                mass: 0.8,
                halfLen: 18,
                obstacle: true,
              },
              gantry.pos.x,
              gantry.pos.y,
            );
          }
          train.forward();
          dropped = true;
        }
        w.step(STEP_S);
        elapsed += STEP_S;
        acc -= STEP_S;
      }
      setPoses(w.bodies());
      setCrane({ x: gantry.pos.x, y: gantry.pos.y, carrying: gantry.carrying });
      window.__tfPhysics = { name: 'crane-drop', elapsedS: elapsed, bodies: () => w.bodies() };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
    };
  }, []);

  const minX = RAIL_X0 - 160;
  const maxX = RAIL_X1 + 160;
  const minY = RAIL_Y - 320;
  const maxY = RAIL_Y + 220;
  const railTop = RAIL_Y - 120;
  const railBot = RAIL_Y + 120;

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
        Crane drop: the gantry sets a crate down on the line, the train hits it and derails
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Crane-drop accident</title>
        <WoodDefs />
        {/* The running line. */}
        <path
          d={`M${RAIL_X0} ${RAIL_Y} L${RAIL_X1} ${RAIL_Y}`}
          fill="none"
          stroke="#cba460"
          strokeWidth={14}
          strokeLinecap="round"
        />
        <path
          d={`M${RAIL_X0} ${RAIL_Y} L${RAIL_X1} ${RAIL_Y}`}
          fill="none"
          stroke="#6f4c28"
          strokeWidth={2.6}
          strokeLinecap="round"
        />
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* Foundation girders the gantry bridge rolls along. */}
        {[railTop, railBot].map((gy) => (
          <rect
            key={gy}
            x={minX + 40}
            y={gy - 5}
            width={maxX - minX - 80}
            height={10}
            rx={2}
            fill="#8893a0"
            stroke="#5e6772"
            strokeWidth={1}
          />
        ))}
        <Truss x={crane.x} top={railTop} bot={railBot} />
        <g transform={`translate(${crane.x},${crane.y})`} data-testid="crane-head">
          <rect
            x={-17}
            y={-40}
            width={34}
            height={30}
            rx={4}
            fill="#5a6470"
            stroke="#39414b"
            strokeWidth={2}
          />
          <line
            x1={0}
            y1={-10}
            x2={0}
            y2={crane.carrying ? -2 : 6}
            stroke="#39414b"
            strokeWidth={3}
          />
          {crane.carrying && (
            <rect
              x={-16}
              y={-2}
              width={32}
              height={20}
              rx={2}
              fill="#7c5a33"
              stroke="#523a20"
              strokeWidth={1.5}
            />
          )}
        </g>
      </svg>
    </div>
  );
}
