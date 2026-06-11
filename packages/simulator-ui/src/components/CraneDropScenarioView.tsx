/**
 * Crane-drop accident, rendered (ADR-030/031). A DOCKSIDE JIB CRANE — a static
 * tower set beside the running line whose boom SLEWS about the tower (angle θ)
 * and runs a hook out along the boom (reach r) — arrives carrying a crate over
 * the dock, then slews the boom to swing the crate OUT OVER THE RAIL. On arrival
 * it releases → the world sets the crate DOWN ON THE RAIL as foreign matter. A
 * train then sets off, strikes the crate at speed, and derails on it. Nothing is
 * keyframed: the boom follows the actuator's real (honest) slew + reach (ADR-031
 * §2 — intent out, observation in, no animation), the crate is a real physics
 * body the world places via `placeBodyAt`, and the wreck is the ordinary
 * derail-on-strike fate resolving on contact.
 *
 * Mounted by `App` on `?physics=crane-drop`. Exposes `window.__tfPhysics` so the
 * harness can assert the train derailed and the crate landed on the line —
 * unchanged from the gantry version, so the existing CHECK keeps passing.
 */
import { useEffect, useState } from 'react';
import { JibCrane } from '../devices/jib-crane.js';
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
const DROP_X = 1200; // where the crate is set down on the line, ahead of the train

/* The dock tower stands clear of the line, below it. Its boom slews up and over
 * to deliver the crate to the drop point on the rail. */
const TOWER = { x: DROP_X, y: 940 };
const DELIVER = { x: DROP_X, y: RAIL_Y };
/* Slew/reach limits: the boom swings across the lower → upper arc on the dock
 * side, reaching from just clear of the tower out to past the rail. */
const JIB_LIMITS = { minAngle: -Math.PI, maxAngle: 0, minReach: 120, maxReach: 420 };
/* It arrives parked over the dock (boom low and to the left), crate slung. */
const PARK = { angle: -Math.PI * 0.78, reach: 300 };

/** The jib's lattice boom, drawn from the tower pivot out to the hook along the
 *  actuator's real slew angle + reach (read off, never animated). */
function Boom({
  pivot,
  angle,
  reach,
}: {
  pivot: { x: number; y: number };
  angle: number;
  reach: number;
}) {
  const tip = { x: pivot.x + Math.cos(angle) * reach, y: pivot.y + Math.sin(angle) * reach };
  /* Two parallel chords offset perpendicular to the boom, with a zig-zag web. */
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const w = 7;
  const a0 = { x: pivot.x + nx * w, y: pivot.y + ny * w };
  const b0 = { x: pivot.x - nx * w, y: pivot.y - ny * w };
  const a1 = { x: tip.x + nx * w, y: tip.y + ny * w };
  const b1 = { x: tip.x - nx * w, y: tip.y - ny * w };
  const bays = Math.max(4, Math.round(reach / 70));
  const web: string[] = [];
  for (let i = 0; i < bays; i++) {
    const t0 = i / bays;
    const t1 = (i + 1) / bays;
    const pa = { x: a0.x + (a1.x - a0.x) * t0, y: a0.y + (a1.y - a0.y) * t0 };
    const pb = { x: b0.x + (b1.x - b0.x) * t1, y: b0.y + (b1.y - b0.y) * t1 };
    web.push(`M${pa.x} ${pa.y} L${pb.x} ${pb.y}`);
  }
  return (
    <g data-testid="jib-boom">
      <line x1={a0.x} y1={a0.y} x2={a1.x} y2={a1.y} stroke="#8893a0" strokeWidth={3} />
      <line x1={b0.x} y1={b0.y} x2={b1.x} y2={b1.y} stroke="#8893a0" strokeWidth={3} />
      <path d={web.join(' ')} fill="none" stroke="#a7b1bd" strokeWidth={2} />
    </g>
  );
}

export function CraneDropScenarioView() {
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [jib, setJib] = useState<{
    angle: number;
    reach: number;
    hook: { x: number; y: number };
    carrying: boolean;
  }>({ angle: PARK.angle, reach: PARK.reach, hook: TOWER, carrying: true });

  useEffect(() => {
    const w = new PhysicsWorld(straightSeg(RAIL_X0, RAIL_Y, RAIL_X1, RAIL_Y));
    w.addBody({ id: 'T', kind: 'loco', railPos: 120, facing: 1, color: '#c0392b' });
    const train = new TrainDevice('T', physicsMotorActuator(w, 'T'));
    const crane = new JibCrane({ base: TOWER, limits: JIB_LIMITS, start: PARK });
    crane.grab(); // it arrives carrying a crate over the dock
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
        crane.aimAt(DELIVER.x, DELIVER.y); // slew the boom out over the rail
        crane.step(STEP_S);
        if (!dropped && crane.carrying && crane.arrived) {
          // Set the crate down on the rail, then send the train off into it.
          if (crane.release()) {
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
              crane.pos.x,
              crane.pos.y,
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
      setJib({
        angle: crane.slewAngle,
        reach: crane.reachOut,
        hook: crane.pos,
        carrying: crane.carrying,
      });
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
  const maxY = TOWER.y + 120;

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
        Crane drop: the dock jib slews a crate out over the line, the train hits it and derails
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
        {/* The dock tower: a foundation pad, a lattice mast, and the slew bearing. */}
        <g data-testid="jib-tower">
          <rect
            x={TOWER.x - 46}
            y={TOWER.y + 14}
            width={92}
            height={20}
            rx={3}
            fill="#6b7480"
            stroke="#444c55"
            strokeWidth={1.5}
          />
          <rect
            x={TOWER.x - 14}
            y={TOWER.y - 26}
            width={28}
            height={44}
            rx={3}
            fill="#7a838f"
            stroke="#4c545d"
            strokeWidth={2}
          />
          <circle
            cx={TOWER.x}
            cy={TOWER.y}
            r={13}
            fill="#5a6470"
            stroke="#39414b"
            strokeWidth={2.5}
          />
        </g>
        <Boom pivot={TOWER} angle={jib.angle} reach={jib.reach} />
        {/* The hook + slung crate at the boom tip, at the actuator's real pose. */}
        <g transform={`translate(${jib.hook.x},${jib.hook.y})`} data-testid="jib-hook">
          <circle cx={0} cy={0} r={6} fill="#5a6470" stroke="#39414b" strokeWidth={2} />
          <line x1={0} y1={0} x2={0} y2={jib.carrying ? 12 : 8} stroke="#39414b" strokeWidth={3} />
          {jib.carrying && (
            <rect
              x={-16}
              y={12}
              width={32}
              height={22}
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
