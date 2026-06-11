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
 * physics pose. The raise reads as a LIFT, not a swing — the deck foreshortens
 * toward its hinge as it tilts up, its dark underside comes into view, and a gap
 * opens in the rail.
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

/**
 * The liftable span, drawn at its REAL raise fraction `r` (0 down … 1 up). It is
 * track, so it stays wooden (ADR-024 §4). The hinge is at the NEAR (left) gap
 * edge; the free (right) end tilts up. In top-down we fake the lift by
 * FORESHORTENING the plank toward its hinge (its drawn length compresses as it
 * rises), revealing a dark underside end-face at the free end and casting a
 * lengthening shadow — so the gap beyond it opens up.
 */
function SpanArt({
  hingeX,
  freeX,
  y,
  r,
}: {
  hingeX: number;
  freeX: number;
  y: number;
  r: number;
}) {
  const full = freeX - hingeX;
  /* Plan-view foreshortening: length × cos(tilt). Tilt goes 0 → ~75°. */
  const tiltRad = (r * 75 * Math.PI) / 180;
  const drawnLen = full * Math.cos(tiltRad);
  const tipX = hingeX + drawnLen;
  /* The raised deck floats on a longer cast shadow offset down-right. */
  const shadowOff = r * 18;
  return (
    <g data-testid="lift-bridge-span" data-span-raise={r.toFixed(3)}>
      {r > 0.02 && (
        <line
          x1={hingeX}
          y1={y + shadowOff}
          x2={tipX}
          y2={y + shadowOff}
          stroke="rgba(63,43,19,0.28)"
          strokeWidth={14}
          strokeLinecap="round"
        />
      )}
      {/* The wooden deck band, foreshortened toward the hinge. */}
      <line x1={hingeX} y1={y} x2={tipX} y2={y} stroke="#cba460" strokeWidth={14} />
      <line x1={hingeX} y1={y} x2={tipX} y2={y} stroke="#6f4c28" strokeWidth={2.6} />
      {/* The dark underside end-face, revealed as the free end tilts up. */}
      {r > 0.02 && (
        <rect
          x={tipX - 3}
          y={y - 8}
          width={Math.max(2, r * 10)}
          height={16}
          fill="#3a2c1a"
          stroke="#241a10"
          strokeWidth={1}
        />
      )}
      {/* The pivot fitting — a small steel boss at the hinge (a `metal` feature). */}
      <circle cx={hingeX} cy={y} r={5} fill="#8a929b" stroke="#4a4f55" strokeWidth={1.5} />
    </g>
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
    setPoses(w.bodies());
    setRaise(span.raise);
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
        {/* The two fixed approaches (the span is drawn separately so it can lift). */}
        {segs
          .filter(([id]) => id !== layout.span)
          .map(([id, s]) => (
            <SegArt key={id} ax={s.ax} ay={s.ay} bx={s.bx} by={s.by} />
          ))}
        <SpanArt
          hingeX={layout.spanStart.x}
          freeX={layout.spanEnd.x}
          y={layout.spanStart.y}
          r={raise}
        />
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
      </svg>
    </div>
  );
}
