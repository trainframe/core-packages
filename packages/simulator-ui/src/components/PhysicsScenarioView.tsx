/**
 * A self-contained view that runs ONE physics acceptance scenario (ADR-030) and
 * renders it — the toy table's wooden pieces drawn from `getPieceShape`, the
 * bodies drawn from the authoritative `PhysicsWorld`. No broker, no core: these
 * scenarios exercise the physical layer in isolation ("no markers required").
 *
 * Mounted by `App` when the URL carries `?physics=<name>`. Exposes
 * `window.__tfPhysics` so the video harness can read body fates/poses and assert.
 */
import { useEffect, useMemo, useState } from 'react';
import { physicsMotorActuator } from '../devices/motor-actuator.js';
import { TrainDevice } from '../devices/train-device.js';
import { buildRail } from '../physics/rail.js';
import { type PhysicsScenario, type TrackSpec, buildScenario } from '../physics/scenarios.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { physicsCameraProvider } from '../sensors/camera-provider.js';
import { VisionStation } from '../sensors/vision-station.js';
import { PIECE_TINT, type TrackPiece, getEndpoints, getPieceShape } from '../track/pieces.js';
import { PieceBody, WOOD_FILL, WoodDefs } from './piece-art.js';

declare global {
  interface Window {
    __tfPhysics?:
      | {
          name: string;
          elapsedS: number;
          bodies: () => readonly BodyPose[];
        }
      | undefined;
    __tfVision?: { reportedMm: number | null; expectedMm: number } | undefined;
  }
}

const STEP_S = 1 / 120; // fixed physics step

function pieceTransform(p: TrackPiece): string {
  const flip = p.flipped === true ? ' scale(1,-1)' : '';
  return `translate(${p.position.x},${p.position.y}) rotate(${p.rotationDeg})${flip}`;
}

/** A track piece drawn in the real beech-wood toy-table style (ADR-024), reusing
 *  the shared `PieceBody`. A soft contact shadow matches the live table. */
function PieceG({ piece }: { piece: TrackPiece }) {
  return (
    <g
      transform={pieceTransform(piece)}
      data-piece-id={piece.id}
      style={{ filter: 'drop-shadow(0 1px 1.4px rgba(63,43,19,0.34))' }}
    >
      <PieceBody
        shape={getPieceShape(piece)}
        bodyFill={WOOD_FILL}
        tint={PIECE_TINT[piece.type]}
        isDevice={false}
        dim={1}
      />
    </g>
  );
}

/** The real device sprite to draw for each body kind, and its native length (mm)
 *  — `trainBody` spans 80, `carriageBody` 60. We scale the sprite so its visual
 *  extent matches the body's physics half-length, so contact reads true. */
const BODY_SPRITE: Record<
  BodyPose['kind'],
  { type: TrackPiece['type']; nativeLen: number; halfLen: number }
> = {
  loco: { type: 'train', nativeLen: 80, halfLen: 34 },
  carriage: { type: 'carriage', nativeLen: 60, halfLen: 30 },
};

/** A loco / carriage drawn as the REAL toy-table device sprite (rounded hull,
 *  boiler, windows…) in its livery, at the body's authoritative pose — not a
 *  plain physics rectangle. A red outline marks a body that has left the rails. */
function BodyG({ pose }: { pose: BodyPose }) {
  const spec = BODY_SPRITE[pose.kind];
  const shape = getPieceShape({
    id: pose.id,
    type: spec.type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
  });
  const scale = (spec.halfLen * 2) / spec.nativeLen;
  const fill = pose.color ?? (pose.kind === 'loco' ? '#c0392b' : '#8e44ad');
  return (
    <g
      transform={`translate(${pose.x},${pose.y}) rotate(${pose.rotationDeg}) scale(${scale})`}
      data-body-id={pose.id}
      data-fate={pose.fate}
      data-mode={pose.mode}
      style={{ filter: 'drop-shadow(0 1px 1.4px rgba(63,43,19,0.34))' }}
    >
      <PieceBody shape={shape} bodyFill={fill} tint={null} isDevice={true} dim={1} />
      {pose.fate !== 'on-rail' && (
        <path d={shape.svgPath} fill="none" stroke="#b00020" strokeWidth={3} />
      )}
    </g>
  );
}

function viewBoxFor(pieces: readonly TrackPiece[], pad = 320): string {
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1e9;
  let maxY = -1e9;
  for (const p of pieces) {
    for (const e of getEndpoints(p)) {
      minX = Math.min(minX, e.x, p.position.x);
      minY = Math.min(minY, e.y, p.position.y);
      maxX = Math.max(maxX, e.x, p.position.x);
      maxY = Math.max(maxY, e.y, p.position.y);
    }
  }
  return `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`;
}

type VisionConfig = NonNullable<PhysicsScenario['vision']>;

/** A track being run: its world, the TrainDevice per loco (the scenario commands
 *  these, not the world directly), its script, and which steps have fired. */
interface RunningTrack {
  readonly world: PhysicsWorld;
  readonly devices: Map<string, TrainDevice>;
  readonly script: TrackSpec['script'];
  readonly fired: Set<number>;
}

/** Stage one track: build its rail + world, seed bodies + couplings, and wire a
 *  TrainDevice (over a sim-backed motor actuator) for each loco. */
function buildTrack(spec: TrackSpec): RunningTrack {
  const world = new PhysicsWorld(buildRail(spec.pieces));
  for (const b of spec.bodies) world.addBody(b);
  for (const [a, b] of spec.couples ?? []) world.couple(a, b);
  const devices = new Map<string, TrainDevice>();
  for (const b of spec.bodies) {
    if (b.kind === 'loco')
      devices.set(b.id, new TrainDevice(b.id, physicsMotorActuator(world, b.id)));
  }
  return { world, devices, script: spec.script, fired: new Set() };
}

/** Apply any script intents now due by COMMANDING THE TRAIN DEVICE (forward/
 *  stop/reverse) — the device acts on the world through its motor actuator. */
function fireTrackScripts(track: RunningTrack, elapsedS: number): void {
  const script = track.script ?? [];
  for (let i = 0; i < script.length; i++) {
    const s = script[i];
    if (s !== undefined && !track.fired.has(i) && elapsedS >= s.atS) {
      track.devices.get(s.id)?.drive(s.motion);
      track.fired.add(i);
    }
  }
}

/** Drive a VisionStation over a passing rake: tick the camera each step and fire
 *  a marker crossing when the loco's x passes each marker. The station measures
 *  speed (baseline ÷ crossing interval) and reports length = speed × dwell. */
function makeVisionRunner(
  v: VisionConfig,
  world: PhysicsWorld,
  onReport: (mm: number) => void,
): (elapsedS: number) => void {
  const camera = physicsCameraProvider(world, {
    x: v.footprintX,
    y: v.railY,
    radiusMm: v.footprintRadiusMm,
  });
  const station = new VisionStation({
    markerA: 'mA',
    markerB: 'mB',
    baselineMm: Math.abs(v.markerBx - v.markerAx),
    camera,
    onLength: onReport,
  });
  let prevX: number | null = null;
  const crossed = { a: false, b: false };
  return (elapsedS: number) => {
    station.tick(STEP_S);
    const loco = world.bodies().find((b) => b.id === v.locoId);
    if (loco === undefined) return;
    if (prevX !== null) {
      if (!crossed.a && prevX < v.markerAx && loco.x >= v.markerAx) {
        station.onMarkerCrossed('mA', elapsedS);
        crossed.a = true;
      }
      if (!crossed.b && prevX < v.markerBx && loco.x >= v.markerBx) {
        station.onMarkerCrossed('mB', elapsedS);
        crossed.b = true;
      }
    }
    prevX = loco.x;
  };
}

export function PhysicsScenarioView({ name }: { name: string }) {
  const scenario = useMemo(() => buildScenario(name), [name]);
  const allPieces = useMemo(
    () =>
      scenario
        ? [scenario.pieces, ...(scenario.moreTracks?.map((t) => t.pieces) ?? [])].flat()
        : [],
    [scenario],
  );
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [visionMm, setVisionMm] = useState<number | null>(null);

  useEffect(() => {
    if (scenario === undefined) return;
    const specs: TrackSpec[] = [
      {
        pieces: scenario.pieces,
        bodies: scenario.bodies,
        couples: scenario.couples,
        script: scenario.script,
      },
      ...(scenario.moreTracks ?? []),
    ];
    const tracks = specs.map(buildTrack);
    const first = tracks[0];
    if (first === undefined) return;
    const allBodies = (): readonly BodyPose[] => tracks.flatMap((t) => t.world.bodies());

    const v = scenario.vision;
    let reported: number | null = null;
    const runVision = v
      ? makeVisionRunner(v, first.world, (mm) => {
          reported = mm;
          setVisionMm(mm);
        })
      : null;
    const expectedMm = v ? v.rakeSpanMm + 2 * v.footprintRadiusMm : 0;
    if (v) window.__tfVision = { reportedMm: null, expectedMm };

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(allBodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        elapsed += STEP_S;
        for (const t of tracks) {
          fireTrackScripts(t, elapsed);
          t.world.step(STEP_S);
        }
        runVision?.(elapsed);
        acc -= STEP_S;
      }
      setPoses(allBodies());
      window.__tfPhysics = { name, elapsedS: elapsed, bodies: allBodies };
      if (v) window.__tfVision = { reportedMm: reported, expectedMm };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
      window.__tfVision = undefined;
    };
  }, [scenario, name]);

  if (scenario === undefined) {
    return (
      <div style={{ padding: 40, fontFamily: 'sans-serif' }}>Unknown physics scenario: {name}</div>
    );
  }

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
        {scenario.title}
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={viewBoxFor(allPieces, scenario.viewPad)}
        style={{ width: '100%', height: '100%' }}
      >
        <title>{scenario.title}</title>
        <WoodDefs />
        {allPieces.map((p) => (
          <PieceG key={p.id} piece={p} />
        ))}
        {scenario.vision && <VisionOverlay v={scenario.vision} measuredMm={visionMm} />}
        {poses.map((pose) => (
          <BodyG key={pose.id} pose={pose} />
        ))}
      </svg>
    </div>
  );
}

/** The vision station's furniture: its two baseline markers, the camera
 *  footprint, and the measured-length readout. */
function VisionOverlay({ v, measuredMm }: { v: VisionConfig; measuredMm: number | null }) {
  const y = v.railY;
  const marker = (x: number, label: string) => (
    <g key={label}>
      <line x1={x} y1={y - 46} x2={x} y2={y + 46} stroke="#1a6" strokeWidth={3} />
      <text x={x} y={y - 54} fontSize={16} textAnchor="middle" fill="#157">
        {label}
      </text>
    </g>
  );
  return (
    <g data-testid="vision-overlay">
      {marker(v.markerAx, 'M-A')}
      {marker(v.markerBx, 'M-B')}
      <line
        x1={v.markerAx}
        y1={y - 38}
        x2={v.markerBx}
        y2={y - 38}
        stroke="#1a6"
        strokeWidth={1.5}
        strokeDasharray="6 5"
      />
      <text
        x={(v.markerAx + v.markerBx) / 2}
        y={y - 44}
        fontSize={14}
        textAnchor="middle"
        fill="#157"
      >
        baseline {Math.abs(v.markerBx - v.markerAx)} mm
      </text>
      {/* the fixed camera footprint over the line */}
      <circle
        cx={v.footprintX}
        cy={y}
        r={34}
        fill="none"
        stroke="#b06000"
        strokeWidth={2}
        strokeDasharray="5 4"
      />
      <text x={v.footprintX} y={y + 70} fontSize={16} textAnchor="middle" fill="#b06000">
        camera
      </text>
      <text
        x={v.footprintX}
        y={y - 90}
        fontSize={22}
        textAnchor="middle"
        fill="#222"
        data-testid="vision-readout"
      >
        {measuredMm === null ? 'measuring…' : `measured length ≈ ${Math.round(measuredMm)} mm`}
      </text>
    </g>
  );
}
