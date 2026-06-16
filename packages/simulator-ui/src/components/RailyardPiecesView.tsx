import { Crane } from '@trainframe/simulator/devices/crane.js';
import {
  LadderYardController,
  type SlotGeom,
} from '@trainframe/simulator/devices/ladder-yard-controller.js';
import { TrainDevice } from '@trainframe/simulator/devices/train-device.js';
import { buildFullRailyardScene } from '@trainframe/simulator/physics/railyard-pieces.js';
import { type BodyPose, PhysicsWorld } from '@trainframe/simulator/physics/world.js';
import { physicsMotorActuator } from '@trainframe/simulator/sim/motor-actuator.js';
import { physicsSwitchActuator } from '@trainframe/simulator/sim/switch-actuator.js';
/**
 * The real-piece railyard, rendered (ADR-030/034). Builds the whole running circuit
 * from REAL track pieces (`buildFullRailyardScene` — straights, 45° curves, real
 * turnouts), then runs ONE visitor through a complete journey driven only by the
 * `LadderYardController` looking through its crane camera:
 *
 *   it drives the running line, the passing-loop switch diverting it round the
 *   siding; it pulls down the yard lead onto the headshunt; it scans the slots,
 *   SKIPS the one already holding a parked cut, and BACKS into a free slot; the
 *   gantry crane travels over the coupling and decouples; the loco pulls clear.
 *
 * Nothing is keyframed — the train self-drives the real rails, couples by proximity,
 * and the crane only ever decouples. Mounted by `App` on `?physics=railyard-pieces`;
 * exposes `window.__tfPhysics` so the video harness can assert the service happened.
 */
import { useEffect, useMemo, useState } from 'react';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const CAM_R = 30;

/** An SVG path traced along a rail by sampling its real (possibly curved) centre. */
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

/** A vertical girder truss the camera-crane rides across the yard. */
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

export function RailyardPiecesView() {
  const scene = useMemo(() => buildFullRailyardScene(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [crane, setCrane] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  /* The yard region (slot mouths/buffers + headshunt) — where the gantry lives. */
  const yardBounds = useMemo(() => {
    const slotGeoms = scene.yard.slots
      .map((id) => scene.geom.get(id))
      .filter((g) => g !== undefined);
    const headG = scene.geom.get(scene.yard.headshunt);
    const pts = [
      ...slotGeoms.flatMap((g) => [g.start, g.end]),
      ...(headG ? [headG.start, headG.end] : []),
    ];
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }, [scene]);

  useEffect(() => {
    const w = new PhysicsWorld(scene.net);
    /* The passing-loop switch diverts the visitor round the siding on its way. */
    w.setSwitch(scene.passingLoop.switchId, scene.passingLoop.loopPos);

    /* A cut already parked in slot 0, so the service must choose a later slot. */
    const slot0 = scene.yard.slots[0];
    if (slot0 !== undefined) {
      w.addBody({
        id: 'parked0',
        kind: 'carriage',
        segment: slot0,
        railPos: 200,
        facing: 1,
        color: '#8e44ad',
      });
      w.addBody({
        id: 'parked1',
        kind: 'carriage',
        segment: slot0,
        railPos: 132,
        facing: 1,
        color: '#8e44ad',
      });
      w.couple('parked0', 'parked1');
    }

    /* The visitor: a loco + two carriages on the bottom running line, BEFORE the
     *  passing loop, so it diverts round the siding on its way to the yard. */
    w.addBody({
      id: 'V',
      kind: 'loco',
      railPos: 300,
      facing: 1,
      segment: scene.startSegment,
      color: '#c0392b',
      maxSpeed: 150,
    });
    for (let i = 0; i < 2; i++) {
      const id = `V-c${i}`;
      w.addBody({
        id,
        kind: 'carriage',
        railPos: 300 - (i + 1) * 68,
        facing: 1,
        segment: scene.startSegment,
        color: '#e08a1e',
      });
      w.couple(i === 0 ? 'V' : `V-c${i - 1}`, id);
    }

    const slots: SlotGeom[] = scene.yard.slots.map((id) => {
      const g = scene.geom.get(id);
      if (g === undefined) throw new Error(`no geom for ${id}`);
      return { mouth: g.end, buffer: g.start };
    });
    const headG = scene.geom.get(scene.yard.headshunt);
    const bounds = {
      minX: yardBounds.minX - 60,
      maxX: yardBounds.maxX + 60,
      minY: yardBounds.minY - 60,
      maxY: yardBounds.maxY + 60,
    };
    const craneActuator = new Crane(bounds, { x: (bounds.minX + bounds.maxX) / 2, y: bounds.minY });
    const ctrl = new LadderYardController({
      train: new TrainDevice('V', physicsMotorActuator(w, 'V')),
      throat: physicsSwitchActuator(w, scene.yard.throatSwitch),
      enterPos: scene.yard.enterPos,
      thruPos: scene.yard.thruPos,
      ladder: scene.yard.ladderSwitches.map((sw) => physicsSwitchActuator(w, sw)),
      ladderThruPos: scene.yard.ladderThruPos,
      ladderSlotPos: scene.yard.ladderSlotPos,
      slots,
      headshuntRest: headG?.end ?? { x: 0, y: 0 },
      look: (x, y) => {
        const s = w.sampleAt(x, y, CAM_R);
        return s === null
          ? { occupied: false }
          : { occupied: true, colour: s.colour, at: { x: s.x, y: s.y } };
      },
      cameraRadius: CAM_R,
      wedgeAt: (x, y) => {
        w.uncoupleAt(x, y);
      },
      crane: craneActuator,
    });

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(w.bodies());
    setCrane(craneActuator.pos);
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        ctrl.tick(STEP_S);
        craneActuator.step(STEP_S);
        w.step(STEP_S);
        elapsed += STEP_S;
        acc -= STEP_S;
      }
      setPoses(w.bodies());
      setCrane(craneActuator.pos);
      window.__tfPhysics = {
        name: 'railyard-pieces',
        elapsedS: elapsed,
        phase: ctrl.currentPhase,
        chosenSlot: ctrl.chosenSlot,
        bodies: () => w.bodies(),
      };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
    };
  }, [scene, yardBounds]);

  const segs = scene.net.segments();
  const allPts = segs.map((id) => scene.net.railOf(id)).flatMap((r) => [r.at(0), r.at(r.length)]);
  const minX = Math.min(...allPts.map((p) => p.x)) - 120;
  const maxX = Math.max(...allPts.map((p) => p.x)) + 120;
  const minY = Math.min(...allPts.map((p) => p.y)) - 120;
  const maxY = Math.max(...allPts.map((p) => p.y)) + 120;
  const railTop = yardBounds.minY - 70;
  const railBot = yardBounds.maxY + 70;

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
        Railyard from real pieces — divert round the passing loop, reverse-in to a free slot, crane
        decouples
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Real-piece railyard — reverse-in service</title>
        <WoodDefs />
        {segs.map((id) => (
          <SegArt key={id} d={railPath(scene.net.railOf(id))} />
        ))}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* The yard gantry: two foundation girders + a truss bridge at the crane's x. */}
        {[railTop, railBot].map((gy) => (
          <rect
            key={gy}
            x={yardBounds.minX - 50}
            y={gy - 5}
            width={yardBounds.maxX - yardBounds.minX + 100}
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
        </g>
      </svg>
    </div>
  );
}
