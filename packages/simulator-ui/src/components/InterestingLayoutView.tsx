import { buildMainLoopScene } from '@trainframe/simulator/physics/interesting-layout.js';
import { railOfPiece } from '@trainframe/simulator/physics/rail.js';
import type { BodyPose } from '@trainframe/simulator/physics/world.js';
import { buildInterestingDemo } from '@trainframe/simulator/sim/interesting-demo.js';
import { pierSuppressed } from '@trainframe/simulator/track/overlap.js';
import { layerOf } from '@trainframe/simulator/track/pieces.js';
/**
 * The "interesting" layout, rendered (ADR-030) — a winding main loop of REAL track
 * pieces that crosses OVER itself once on a bridge (the `satB` crossover teardrop),
 * with a railyard tucked bottom-left. Mounted by `App` on `?physics=interesting`.
 *
 * Nothing is keyframed: a lapping train self-drives the rails, diverting through both
 * satellites and riding over the flyover. The yard's on-rail carriage-SWAP service is
 * being rebuilt as a shunting move, so it is not driven here yet (the yard shows
 * stabled stock). Exposes `window.__tfPhysics` so the video harness can assert
 * movement.
 */
import { useEffect, useMemo, useState } from 'react';
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
      {/* A raised deck (a bridge) clears the track it passes over: a background-colour
       *  halo breaks the LOWER rail beneath the span, so the crossing reads as
       *  over-and-under rather than a flat X. */}
      {raised && (
        <path
          d={d}
          fill="none"
          stroke="#efe6d3"
          strokeWidth={26}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
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

export function InterestingLayoutView() {
  const scene = useMemo(() => buildMainLoopScene(), []);
  const demo = useMemo(() => buildInterestingDemo(scene), [scene]);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);

  useEffect(() => {
    const w = demo.world;
    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(w.bodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        w.step(STEP_S);
        elapsed += STEP_S;
        acc -= STEP_S;
      }
      setPoses(w.bodies());
      window.__tfPhysics = {
        name: 'interesting',
        elapsedS: elapsed,
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

  /* The flyover structure: the elevated DECK pieces (on a height layer) PLUS the RAMP
   *  pieces (the inclined approaches), all drawn raised so the whole bridge — ramp up,
   *  span over, ramp down — reads as one elevated run, not a flat junction. */
  const bridgePieces = scene.pieces.filter((p) => layerOf(p) >= 1 || p.type === 'ramp');
  const raisedDecks = bridgePieces.map((p) => ({
    id: p.id,
    d: railPath(railOfPiece(p, 0, 1)),
    ramp: p.type === 'ramp',
  }));
  /* Support piers under the elevated deck (omitted where track runs beneath the span —
   *  a pier never plants on the rail below). */
  const piers = scene.pieces
    .filter((p) => layerOf(p) >= 1 && !pierSuppressed(p, scene.pieces))
    .map((p) => ({ id: p.id, x: p.position.x, y: p.position.y }));

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
        Interesting layout — winding main loop (real pieces) that bridges over itself, with a
        railyard tucked bottom-left
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
        {/* Support piers beneath the deck — drawn before the deck so the deck sits on
         *  top of them. */}
        {piers.map((pier) => (
          <g key={`pier-${pier.id}`}>
            <ellipse cx={pier.x} cy={pier.y + 13} rx={9} ry={4} fill="rgba(63,43,19,0.28)" />
            <rect
              x={pier.x - 5}
              y={pier.y - 2}
              width={10}
              height={15}
              rx={2}
              fill="#9a7b4f"
              stroke="#6f4c28"
              strokeWidth={1.5}
            />
          </g>
        ))}
        {/* The flyover: ramps + deck, raised over the ground track it crosses. */}
        {raisedDecks.map((deck) => (
          <SegArt key={deck.id} d={deck.d} raised />
        ))}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
      </svg>
    </div>
  );
}
