import { DepotController } from '@trainframe/simulator/devices/depot-controller.js';
import { TrainDevice } from '@trainframe/simulator/devices/train-device.js';
import { TurntableActuator } from '@trainframe/simulator/devices/turntable-actuator.js';
import { type DepotLayout, buildDepotLayout } from '@trainframe/simulator/physics/depot.js';
import { type BodyPose, PhysicsWorld } from '@trainframe/simulator/physics/world.js';
import { physicsMotorActuator } from '@trainframe/simulator/sim/motor-actuator.js';
import { physicsSwitchActuator } from '@trainframe/simulator/sim/switch-actuator.js';
/**
 * The DEPOT / roundhouse service, rendered (ADR-032 — the first concrete two-level
 * nested opaque zone). Builds the depot interior as a switched network (an entry
 * lead → a central rotating turntable deck → a fan of roundhouse stalls), then
 * runs the `DepotController`, which OWNS and orchestrates the interior turntable
 * (`TurntableActuator`) as a sub-device: it boards a visiting loco onto the deck,
 * swings the deck to a chosen FREE stall, drives the loco off into the bay, and
 * tracks one rolled-up occupancy (filled stalls / capacity) — the single number
 * core would see for the whole opaque zone.
 *
 * The choreography shows the turntable as a SERIALISED inner resource: a first
 * loco is admitted, turned, and parked in one stall; a SECOND loco — held at the
 * throat while the deck was busy — is then admitted and routed to a DIFFERENT
 * stall. Only ever one loco on the deck at a time.
 *
 * Nothing here is keyframed: the deck is drawn at the actuator's REAL angle (read
 * off it, never animated — ADR-031 §2) and the locos at their authoritative
 * physics poses. Mounted by `App` on `?physics=depot`; exposes `window.__tfPhysics`
 * so the video harness can assert both locos ended parked on distinct stalls.
 */
import { useEffect, useMemo, useState } from 'react';
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

/** A pitched shed roof over a stall bay — a beech-wood gable straddling the
 *  parking track, drawn at the stall's outward angle so each shed faces the pit. */
function StallShed({
  ax,
  ay,
  bx,
  by,
  filled,
}: {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  filled: boolean;
}) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  /* Perpendicular (the shed's half-width across the track). */
  const px = -uy;
  const py = ux;
  const hw = 26;
  /* The roof covers the inner ~70% of the bay (mouth open toward the pit). */
  const x0 = ax + ux * len * 0.16;
  const y0 = ay + uy * len * 0.16;
  const x1 = ax + ux * len * 0.96;
  const y1 = ay + uy * len * 0.96;
  const corner = (cx: number, cy: number, s: number) => `${cx + px * hw * s} ${cy + py * hw * s}`;
  const slab = `M${corner(x0, y0, 1)} L${corner(x1, y1, 1)} L${corner(x1, y1, -1)} L${corner(x0, y0, -1)} Z`;
  /* The ridge line down the centre of the roof. */
  return (
    <g data-testid="stall-shed">
      <path d={slab} fill={filled ? '#a07a44' : '#caa56a'} stroke="#6f4c28" strokeWidth={2} />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#6f4c28" strokeWidth={1.6} />
    </g>
  );
}

/** Stage the depot world: the layout, the turntable deck the depot owns, two
 *  visiting locos on the entry lead, and the controller (with both queued). */
function buildDepot(layout: DepotLayout): {
  world: PhysicsWorld;
  ctrl: DepotController;
  deck: TurntableActuator;
} {
  const world = new PhysicsWorld(layout.net);
  /* Two visitors queued nose-to-tail on the entry lead, facing east toward the
   *  deck. Gentle power + a low speed cap so they EASE on and off the bridge. */
  world.addBody({
    id: 'A',
    kind: 'loco',
    railPos: 320,
    facing: 1,
    segment: 'entry',
    color: '#c0392b',
    power: 280,
    maxSpeed: 100,
  });
  world.addBody({
    id: 'B',
    kind: 'loco',
    railPos: 150,
    facing: 1,
    segment: 'entry',
    color: '#2e6da4',
    power: 280,
    maxSpeed: 100,
  });
  const deck = new TurntableActuator({
    exits: [
      { position: layout.entryPosition, angleDeg: 0 },
      ...layout.stalls.map((s) => ({ position: s.id, angleDeg: s.angleDeg })),
    ],
    switchId: layout.switchId,
    points: physicsSwitchActuator(world, layout.switchId),
    /* Endstops spanning the entry (0°) and the whole stall fan. */
    limits: { minDeg: -90, maxDeg: 360 },
    startDeg: 0,
  });
  const ctrl = new DepotController({
    layout,
    deck,
    look: (x, y) => {
      const s = world.sampleAt(x, y, CAM_R);
      return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
    },
  });
  const stallA = layout.stalls[0];
  const stallB = layout.stalls[2];
  if (stallA !== undefined)
    ctrl.arrive({
      train: new TrainDevice('A', physicsMotorActuator(world, 'A')),
      stallId: stallA.id,
    });
  if (stallB !== undefined)
    ctrl.arrive({
      train: new TrainDevice('B', physicsMotorActuator(world, 'B')),
      stallId: stallB.id,
    });
  return { world, ctrl, deck };
}

export function DepotScenarioView() {
  const layout = useMemo(() => buildDepotLayout(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [deckAngle, setDeckAngle] = useState(0);
  /** The stall ids currently filled — the depot's interior, read off the
   *  controller for the view (it darkens each filled shed). */
  const [filled, setFilled] = useState<readonly string[]>([]);

  useEffect(() => {
    const { world, ctrl, deck } = buildDepot(layout);

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    /* One fixed physics step: tick the depot (which steps its owned deck), share
     *  the deck's LIVE angle with the rotating deck rail BEFORE the world steps (so
     *  a body on the deck reads the same θ the bridge is at), then step the world. */
    const advance = (): void => {
      ctrl.tick(STEP_S);
      layout.deckAngle.deg = deck.pos;
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
      layout.deckAngle.deg = deck.pos;
      setPoses(world.bodies());
      setDeckAngle(deck.pos);
      setFilled(layout.stalls.filter((s) => ctrl.isOccupied(s.id)).map((s) => s.id));
      window.__tfPhysics = { name: 'depot', elapsedS: elapsed, bodies: () => world.bodies() };
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
  const minX = Math.min(...xs) - 170;
  const maxX = Math.max(...xs) + 170;
  const minY = Math.min(...ys) - 170;
  const maxY = Math.max(...ys) + 170;
  const c = layout.deckCentre;
  const r = layout.deckRadius;
  const filledCount = filled.length;

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
        Depot roundhouse — the turntable turns each loco onto a free stall; occupancy {filledCount}/
        {layout.stalls.length}
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Depot — nested capacity zone around a turntable</title>
        <WoodDefs />
        {/* Shed roofs over each stall bay (drawn under the rails so the parked loco
            reads as tucked inside the shed). */}
        {layout.stalls.map((s) => {
          const g = layout.geom.get(s.stallSeg);
          if (g === undefined) return null;
          return (
            <StallShed
              key={`shed-${s.id}`}
              ax={g.ax}
              ay={g.ay}
              bx={g.bx}
              by={g.by}
              filled={filled.includes(s.id)}
            />
          );
        })}
        {/* Entry lead + rim stubs + stall tracks, traced from their real
            centre-lines. The deck itself is drawn separately (it rotates). */}
        {segs
          .filter(([id]) => id !== layout.deck)
          .map(([id]) => (
            <SegArt key={id} d={railPath(layout.net.railOf(id))} />
          ))}
        {/* The turntable pit: a beech surround, a recessed wood deck disc filling
            the pit, and a steel ring rail around the rim (reused from the turntable
            view's deck-disc/ring art). */}
        <circle cx={c.x} cy={c.y} r={r + 30} fill="#d8c79f" stroke="#9a7b46" strokeWidth={3} />
        <circle cx={c.x} cy={c.y} r={r + 19} fill="#3a3128" stroke="#241f18" strokeWidth={2} />
        <circle cx={c.x} cy={c.y} r={r + 14} fill="#7a5836" stroke="#5d4326" strokeWidth={1.5} />
        <circle cx={c.x} cy={c.y} r={r + 12} fill="none" stroke="#aab4bf" strokeWidth={2} />
        {/* The rotating bridge — at the actuator's REAL angle (read off it, never
            animated): a planked deck strip carrying twin running rails, with an
            end-carriage clamp riding the ring rail at each end. */}
        <g
          transform={`translate(${c.x},${c.y}) rotate(${deckAngle})`}
          data-testid="depot-deck"
          data-deck-angle={deckAngle.toFixed(1)}
        >
          <rect
            x={-r - 14}
            y={-17}
            width={2 * (r + 14)}
            height={34}
            rx={3}
            fill="#caa56a"
            stroke="#6f4c28"
            strokeWidth={1.5}
          />
          <line x1={-r - 14} y1={-6} x2={r + 14} y2={-6} stroke="#5d4326" strokeWidth={2} />
          <line x1={-r - 14} y1={6} x2={r + 14} y2={6} stroke="#5d4326" strokeWidth={2} />
          <rect
            x={-r - 17}
            y={-13}
            width={15}
            height={26}
            rx={2}
            fill="#8893a0"
            stroke="#5e6772"
            strokeWidth={1.5}
          />
          <rect
            x={r + 2}
            y={-13}
            width={15}
            height={26}
            rx={2}
            fill="#8893a0"
            stroke="#5e6772"
            strokeWidth={1.5}
          />
        </g>
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* A red operating knob on the surround (cf. the BRIO mechanical turntable). */}
        <circle
          cx={c.x}
          cy={c.y + r + 24}
          r={6}
          fill="#c0392b"
          stroke="#7d2418"
          strokeWidth={1.5}
        />
      </svg>
    </div>
  );
}
