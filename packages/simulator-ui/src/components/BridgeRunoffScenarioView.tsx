import type { LinkActuator } from '@trainframe/simulator/devices/link-actuator.js';
import { TrainDevice } from '@trainframe/simulator/devices/train-device.js';
import { buildLiftBridgeLayout } from '@trainframe/simulator/physics/lift-bridge.js';
import { type BodyPose, PhysicsWorld } from '@trainframe/simulator/physics/world.js';
import { physicsLinkActuator } from '@trainframe/simulator/sim/link-actuator.js';
import { physicsMotorActuator } from '@trainframe/simulator/sim/motor-actuator.js';
/**
 * The CONTRASTING lift-bridge demo (ADR-030, ADR-031, experimental/005). It is the
 * `?physics=lift-bridge` scene with the safety taken away: there is NO
 * `LiftBridgeController` holding the train out. The span is staged RAISED (its
 * link disconnected via the `LinkActuator`) so the rail is physically broken, and
 * an uncontrolled train simply drives forward. With nothing withholding it, it
 * reaches the open gap and RUNS OFF into the channel (fate `ran-off`, mode
 * `free`) — proving the hold in the controlled demo is doing real work.
 *
 * Nothing is keyframed: the leaf is drawn at the actuator's REAL raise fraction
 * (read off, never animated) via the SHARED `LiftBridgeArt` — the same polished
 * bridge the controlled demo renders — and the train at its authoritative physics
 * pose. The run-off is the world's ordinary open-end coast (no controller, no
 * marker), and the dark channel beneath the raised leaf makes it read as a plunge.
 *
 * Mounted by `App` on `?physics=bridge-runoff`. Exposes `window.__tfPhysics` so
 * the harness can assert the train's fate is `ran-off` (it was NOT held).
 */
import { useEffect, useMemo, useState } from 'react';
import { LiftBridgeArt } from './LiftBridgeArt.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;

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

export function BridgeRunoffScenarioView() {
  const layout = useMemo(() => buildLiftBridgeLayout(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [raise, setRaise] = useState(1);

  useEffect(() => {
    const w = new PhysicsWorld(layout.net);
    /* The same visitor as the controlled demo — but with NO controller to hold it. */
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
    /* Stage the span RAISED and leave it there — the link stays disconnected, so
     *  the near approach's gap end is open. No controller will ever lower it. */
    const span: LinkActuator = physicsLinkActuator(w, layout.linkId, { startRaised: true });
    /* The train just drives. Nothing withholds it, so it runs off into the gap. */
    train.forward();

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    /* One fixed physics step: the span owns its (static, raised) state, the world
     *  advances the uncontrolled train toward — and over — the open gap. */
    const advance = (): void => {
      span.step(STEP_S);
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
      window.__tfPhysics = { name: 'bridge-runoff', elapsedS: elapsed, bodies: () => w.bodies() };
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
        Bridge run-off — NO controller holds the train; the span is up so the rail is broken, and
        the train drives straight off into the gap
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Bridge run-off — an unheld train drives off the raised span into the gap</title>
        <WoodDefs />
        {/* The same bridge as the controlled demo (shared art). */}
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
