/**
 * The lift-bridge service, rendered (ADR-030, ADR-031, experimental/005). Builds
 * two fixed approach rails joined by a liftable SPAN (a disconnectable network
 * link), stages a train on the near approach, and runs the `LiftBridgeController`
 * — which holds the train OUT while the span is raised (the rail is physically
 * broken, so a wrongly-released train would run off the gap), lowers the span,
 * awaits it physically seating, then releases the train to cross onto the far
 * approach.
 *
 * Nothing here is keyframed: the span is drawn at the actuator's REAL raise
 * fraction (read off it, never animated) and the train at its authoritative
 * physics pose. The polished bridge art (piers, abutments, lift tower +
 * counterweight, the dark channel, the cast shadow) is the shared `LiftBridgeArt`
 * — the SAME component the contrasting `?physics=bridge-runoff` demo draws, so the
 * two read identically and only the behaviour differs.
 *
 * Mounted by `App` on `?physics=lift-bridge`. Exposes `window.__tfPhysics` so the
 * video harness can assert the train ended up ACROSS (on the far approach,
 * on-rail) and never ran off the gap.
 */
import { useEffect, useMemo, useState } from 'react';
import { LiftBridgeController } from '../devices/lift-bridge-controller.js';
import { type LinkActuator, physicsLinkActuator } from '../devices/link-actuator.js';
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { buildLiftBridgeLayout } from '../physics/lift-bridge.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { LiftBridgeArt } from './LiftBridgeArt.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const CAM_R = 22;

/** A rail drawn as a wooden plank band with a routed groove (matches the other
 *  physics scenes). */
function SegArt({ ax, ay, bx, by }: { ax: number; ay: number; bx: number; by: number }) {
  const d = `M${ax} ${ay}L${bx} ${by}`;
  return (
    <>
      <path d={d} fill="none" stroke="#cba460" strokeWidth={14} strokeLinecap="round" />
      <path d={d} fill="none" stroke="#6f4c28" strokeWidth={2.6} strokeLinecap="round" />
    </>
  );
}

export function LiftBridgeScenarioView() {
  const layout = useMemo(() => buildLiftBridgeLayout(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [raise, setRaise] = useState(1);

  useEffect(() => {
    const w = new PhysicsWorld(layout.net);
    /* The visitor: one loco on the near approach, facing east toward the span.
     *  Gentle power + a low speed cap so it eases up to the gap and across. */
    w.addBody({
      id: 'T',
      kind: 'loco',
      railPos: 200,
      facing: 1,
      segment: 'near',
      color: '#c0392b',
      power: 280,
      maxSpeed: 130,
    });

    const train = new TrainDevice('T', physicsMotorActuator(w, 'T'));
    const span: LinkActuator = physicsLinkActuator(w, layout.linkId, { startRaised: true });
    const ctrl = new LiftBridgeController({
      train,
      span,
      look: (x, y) => {
        const s = w.sampleAt(x, y, CAM_R);
        return s === null ? { occupied: false } : { occupied: true, colour: s.colour };
      },
      farSensePoint: layout.farSensePoint,
      /* Hold the span up a beat (the out-of-scope boat passing under), then lower. */
      holdRaisedS: 2.2,
    });
    /* The train wants to go from the start; the controller's withhold (stop) is the
     *  only thing keeping it short of the gap while the span is up. */
    train.forward();

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    /* One fixed physics step: the controller commands intent (withhold / lower /
     *  release), the span owns its own raise physics, the world advances. */
    const advance = (): void => {
      ctrl.tick(STEP_S);
      w.step(STEP_S);
      elapsed += STEP_S;
    };
    setPoses(w.bodies());
    setRaise(span.raise);
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        advance();
        acc -= STEP_S;
      }
      setPoses(w.bodies());
      setRaise(span.raise);
      window.__tfPhysics = { name: 'lift-bridge', elapsedS: elapsed, bodies: () => w.bodies() };
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
  const minX = Math.min(...xs) - 120;
  const maxX = Math.max(...xs) + 120;
  const minY = layout.spanStart.y - 220;
  const maxY = layout.spanStart.y + 220;

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
        Lift bridge — the span is up so the rail is broken; the train waits, the span lowers and
        seats, then the train crosses
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Lift bridge — a span that raises to break the track and lowers to complete it</title>
        <WoodDefs />
        {/* The bridge furniture (piers, tower) sits BENEATH the approach rails; the
            leaf is drawn inside LiftBridgeArt at the real raise. */}
        <LiftBridgeArt
          hingeX={layout.spanStart.x}
          freeX={layout.spanEnd.x}
          y={layout.spanStart.y}
          raise={raise}
        />
        {/* The two fixed approaches (the span/leaf is part of LiftBridgeArt). */}
        {segs
          .filter(([id]) => id !== layout.span)
          .map(([id, s]) => (
            <SegArt key={id} ax={s.ax} ay={s.ay} bx={s.bx} by={s.by} />
          ))}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
      </svg>
    </div>
  );
}
