/**
 * The "interesting" layout, rendered — a winding main loop from real pieces with its
 * branch taps, grown slice by slice (see `physics/interesting-layout.ts`). Mounted by
 * `App` on `?physics=interesting`; a shape check + the eventual demo canvas.
 */
import { useEffect, useMemo, useState } from 'react';
import { buildMainLoopScene } from '../physics/interesting-layout.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
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

export function InterestingLayoutView() {
  const scene = useMemo(() => buildMainLoopScene(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);

  useEffect(() => {
    const w = new PhysicsWorld(scene.net);
    /* Keep the running line over the yard, but DIVERT the lapping train through both
     *  satellite loops, so the demo shows them being used. */
    w.setSwitch(scene.branches.yard.switchId, scene.branches.yard.mainPos);
    w.setSwitch(scene.branches.satA.switchId, scene.branches.satA.loopPos);
    w.setSwitch(scene.branches.satB.switchId, scene.branches.satB.loopPos);

    /* The lapping train: a loco + two carriages. */
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 10,
      facing: 1,
      segment: scene.startSegment,
      color: '#c0392b',
      maxSpeed: 200,
    });
    for (let i = 0; i < 2; i++) {
      const id = `T-c${i}`;
      w.addBody({
        id,
        kind: 'carriage',
        railPos: 10 - (i + 1) * 68,
        facing: 1,
        segment: scene.startSegment,
        color: '#e08a1e',
      });
      w.couple(i === 0 ? 'T' : `T-c${i - 1}`, id);
    }

    /* A rake stabled in a yard siding (the bottom-left fan). */
    const siding = scene.yard.sidings[1];
    if (siding !== undefined) {
      w.addBody({
        id: 'S0',
        kind: 'carriage',
        railPos: 200,
        facing: 1,
        segment: siding,
        color: '#8e44ad',
      });
      w.addBody({
        id: 'S1',
        kind: 'carriage',
        railPos: 132,
        facing: 1,
        segment: siding,
        color: '#8e44ad',
      });
      w.couple('S0', 'S1');
    }
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
      window.__tfPhysics = { name: 'interesting', elapsedS: elapsed, bodies: () => w.bodies() };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
    };
  }, [scene]);

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
        Interesting layout — winding main loop (real pieces), branch taps for yard + two satellites
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
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
      </svg>
    </div>
  );
}
