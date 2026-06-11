/**
 * The turntable service, rendered (ADR-030, ADR-031, experimental/002). Builds the
 * turntable interior as a switched network, stages a visiting loco on the trunk,
 * and runs the `TurntableController` — which boards the loco onto the deck, commands
 * the deck to swing 180°, waits for it to physically seat, then drives the loco off
 * FACING THE OTHER WAY. Nothing here is keyframed; the deck is drawn at the
 * actuator's REAL angle (read off it, never animated) and the loco at its
 * authoritative physics pose.
 *
 * Mounted by `App` on `?physics=turntable`. Exposes `window.__tfPhysics` so the
 * video harness can assert the loco left via the intended stub with flipped facing.
 */
import { useEffect, useMemo, useState } from 'react';
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import { physicsSwitchActuator } from '../devices/switch-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { TurntableActuator } from '../devices/turntable-actuator.js';
import { TurntableController } from '../devices/turntable-controller.js';
import { buildTurntableLayout, stubSensePoint } from '../physics/turntable.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const CAM_R = 22;

/** An SVG path traced along a rail by sampling it (straight or curved). */
function railPath(rail: { length: number; at: (d: number) => { x: number; y: number } }): string {
  const n = Math.max(8, Math.ceil(rail.length / 14));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const p = rail.at((rail.length * i) / n);
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d;
}

/** A rail drawn as a wooden plank band with a routed groove. */
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
        stroke="#6f4c28"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

export function TurntableScenarioView() {
  const layout = useMemo(() => buildTurntableLayout(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [deckAngle, setDeckAngle] = useState(0);

  useEffect(() => {
    const w = new PhysicsWorld(layout.net);
    /* The visitor: one loco on the trunk, facing east toward the deck. */
    w.addBody({
      id: 'L',
      kind: 'loco',
      railPos: 200,
      facing: 1,
      segment: 'trunk',
      color: '#c0392b',
    });

    const train = new TrainDevice('L', physicsMotorActuator(w, 'L'));
    const deck = new TurntableActuator({
      exits: [
        { position: layout.trunk, angleDeg: 0 },
        ...layout.stubs.map((s) => ({ position: s.position, angleDeg: s.angleDeg })),
      ],
      switchId: layout.switchId,
      points: physicsSwitchActuator(w, layout.switchId),
      limits: { minDeg: 0, maxDeg: 360 },
      startDeg: 0,
    });
    const ctrl = new TurntableController({
      train,
      deck,
      look: (x, y) => {
        const s = w.sampleAt(x, y, CAM_R);
        return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
      },
      deckCentre: layout.deckCentre,
      trunkExit: layout.trunk,
      departExit: 'stub-e',
      departSensePoint: stubSensePoint(layout, 'stub-e'),
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
      setDeckAngle(deck.pos);
      window.__tfPhysics = { name: 'turntable', elapsedS: elapsed, bodies: () => w.bodies() };
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
  const minX = Math.min(...xs) - 160;
  const maxX = Math.max(...xs) + 160;
  const minY = Math.min(...ys) - 160;
  const maxY = Math.max(...ys) + 160;
  const c = layout.deckCentre;
  const r = layout.deckRadius;

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
        Turntable — the deck swings 180°, turning the loco around: it leaves facing the other way
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Turntable — honest 180° loco turn-around</title>
        <WoodDefs />
        {/* Trunk + rim stubs, traced from their real centre-lines. */}
        {segs
          .filter(([id]) => id !== layout.deck)
          .map(([id]) => (
            <SegArt key={id} d={railPath(layout.net.railOf(id))} />
          ))}
        {/* The fixed turntable pit: a recessed dark disc with a steel ring rail. */}
        <circle cx={c.x} cy={c.y} r={r + 36} fill="#d8c79f" stroke="#9a7b46" strokeWidth={3} />
        <circle cx={c.x} cy={c.y} r={r + 22} fill="#3a3128" stroke="#241f18" strokeWidth={2} />
        <circle cx={c.x} cy={c.y} r={r + 14} fill="none" stroke="#7d8893" strokeWidth={2.5} />
        {/* The rotating bridge deck — drawn at the actuator's REAL angle (read off
            it, never animated). This is the only piece whose decoration moves
            relative to its body. */}
        <g
          transform={`translate(${c.x},${c.y}) rotate(${deckAngle})`}
          data-testid="turntable-deck"
          data-deck-angle={deckAngle.toFixed(1)}
        >
          <rect
            x={-r - 18}
            y={-15}
            width={2 * (r + 18)}
            height={30}
            rx={4}
            fill="#cba460"
            stroke="#6f4c28"
            strokeWidth={2}
          />
          <line x1={-r - 18} y1={-7} x2={r + 18} y2={-7} stroke="#6f4c28" strokeWidth={2} />
          <line x1={-r - 18} y1={7} x2={r + 18} y2={7} stroke="#6f4c28" strokeWidth={2} />
        </g>
        {/* A red operating knob on the surround (cf. the BRIO mechanical turntable). */}
        <circle
          cx={c.x}
          cy={c.y - r - 36}
          r={7}
          fill="#c0392b"
          stroke="#7d2418"
          strokeWidth={1.5}
        />
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
      </svg>
    </div>
  );
}
