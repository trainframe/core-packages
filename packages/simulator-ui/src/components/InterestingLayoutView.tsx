/**
 * The "interesting" layout, rendered (ADR-030) — a winding main loop of REAL track
 * pieces that crosses OVER itself once on a bridge (the `satB` crossover teardrop),
 * with a railyard tucked bottom-left where a gantry CRANE services a parked train:
 * it lifts the train's rear two carriages off, sets two spares on in their place, and
 * loops (the shed cut becomes the next train's spares). Mounted by `App` on
 * `?physics=interesting`.
 *
 * Nothing is keyframed: a lapping train self-drives the rails (diverting through both
 * satellites, riding over the flyover), and the crane MOVES only because the
 * `CraneSwapController` has a job — its gantry is drawn from the physics crane's live
 * position, never animated on a timer. Exposes `window.__tfPhysics` so the video
 * harness can assert movement + the swap actually happened.
 */
import { useEffect, useMemo, useState } from 'react';
import { buildMainLoopScene } from '../physics/interesting-layout.js';
import { railOfPiece } from '../physics/rail.js';
import type { BodyPose } from '../physics/world.js';
import { buildInterestingDemo } from '../sim/interesting-demo.js';
import { layerOf } from '../track/pieces.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;

function railPath(rail: { length: number; at: (d: number) => { x: number; y: number } }): string {
  const n = Math.max(8, Math.ceil(rail.length / 14));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const p = rail.at((rail.length * i) / n);
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d;
}

function SegArt({ d, raised = false }: { d: string; raised?: boolean }) {
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={raised ? '#d8b777' : '#cba460'}
        strokeWidth={raised ? 15 : 14}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={raised ? { filter: 'drop-shadow(3px 6px 3px rgba(63,43,19,0.5))' } : undefined}
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

/** A vertical girder truss the gantry crane rides across the yard. */
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

export function InterestingLayoutView() {
  const scene = useMemo(() => buildMainLoopScene(), []);
  const demo = useMemo(() => buildInterestingDemo(scene), [scene]);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [crane, setCrane] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [carrying, setCarrying] = useState(false);

  const yardRect = demo.yardRect;

  useEffect(() => {
    const w = demo.world;
    const ctrl = demo.ctrl;
    const craneActuator = demo.crane;

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(w.bodies());
    if (craneActuator !== undefined) setCrane(craneActuator.pos);
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        ctrl?.tick(STEP_S);
        craneActuator?.step(STEP_S);
        w.step(STEP_S);
        elapsed += STEP_S;
        acc -= STEP_S;
      }
      setPoses(w.bodies());
      if (craneActuator !== undefined) {
        setCrane(craneActuator.pos);
        setCarrying(craneActuator.carrying);
      }
      window.__tfPhysics = {
        name: 'interesting',
        elapsedS: elapsed,
        phase: ctrl?.currentPhase,
        carrying: craneActuator?.carrying ?? false,
        bodies: () => w.bodies(),
      };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
    };
  }, [demo]);

  const segs = scene.net.segments();
  const pts = segs
    .map((id) => scene.net.railOf(id))
    .flatMap((r) => {
      const out: { x: number; y: number }[] = [];
      const n = Math.max(2, Math.ceil(r.length / 40));
      for (let i = 0; i <= n; i++) out.push(r.at((r.length * i) / n));
      return out;
    });
  const minX = Math.min(...pts.map((p) => p.x)) - 120;
  const maxX = Math.max(...pts.map((p) => p.x)) + 120;
  const minY = Math.min(...pts.map((p) => p.y)) - 120;
  const maxY = Math.max(...pts.map((p) => p.y)) + 120;

  /* The flyover deck: the pieces on a height layer, drawn raised (shadowed) on top
   *  so the crossing reads as a bridge, not a flat junction. */
  const raisedDecks = scene.pieces
    .filter((p) => layerOf(p) >= 1)
    .map((p) => ({ id: p.id, d: railPath(railOfPiece(p, 0, 1)) }));

  const railTop = yardRect.minY - 70;
  const railBot = yardRect.maxY + 70;

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
        Interesting layout — winding main loop (real pieces) that bridges over itself, with a yard
        crane swapping a parked train’s carriages
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Interesting layout</title>
        <WoodDefs />
        {segs.map((id) => (
          <SegArt key={id} d={railPath(scene.net.railOf(id))} />
        ))}
        {/* The flyover deck on top of the ground track it crosses. */}
        {raisedDecks.map((deck) => (
          <SegArt key={deck.id} d={deck.d} raised />
        ))}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* The yard gantry: two foundation girders + a truss bridge at the crane's x. */}
        {[railTop, railBot].map((gy) => (
          <rect
            key={gy}
            x={yardRect.minX - 50}
            y={gy - 5}
            width={yardRect.maxX - yardRect.minX + 100}
            height={10}
            rx={2}
            fill="#8893a0"
            stroke="#5e6772"
            strokeWidth={1}
          />
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
          {/* The carried cut — two wagons on the hook while the crane is lifting. */}
          {carrying &&
            (['cut-l', 'cut-r'] as const).map((id, i) => (
              <rect
                key={id}
                x={-14 + i * 16}
                y={26}
                width={13}
                height={11}
                rx={2}
                fill="#8e44ad"
                stroke="#5b2d72"
                strokeWidth={1}
              />
            ))}
        </g>
      </svg>
    </div>
  );
}
