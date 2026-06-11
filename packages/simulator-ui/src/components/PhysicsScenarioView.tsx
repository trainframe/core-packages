/**
 * A self-contained view that runs ONE physics acceptance scenario (ADR-030) and
 * renders it — the toy table's wooden pieces drawn from `getPieceShape`, the
 * bodies drawn from the authoritative `PhysicsWorld`. No broker, no core: these
 * scenarios exercise the physical layer in isolation ("no markers required").
 *
 * Mounted by `App` when the URL carries `?physics=<name>`. Exposes
 * `window.__tfPhysics` so the video harness can read body fates/poses and assert.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildRail } from '../physics/rail.js';
import { type PhysicsScenario, buildScenario } from '../physics/scenarios.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
import { physicsCameraProvider } from '../sensors/camera-provider.js';
import { VisionStation } from '../sensors/vision-station.js';
import { type TrackPiece, getEndpoints, getPieceShape } from '../track/pieces.js';

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

function PieceG({ piece }: { piece: TrackPiece }) {
  const shape = getPieceShape(piece);
  return (
    <g transform={pieceTransform(piece)} data-piece-id={piece.id}>
      <path d={shape.svgPath} fill="#caa46a" stroke="#9a7b46" strokeWidth={1} />
      {shape.grooves.map((d, i) => (
        <path
          // biome-ignore lint/suspicious/noArrayIndexKey: grooves are a fixed positional list
          key={i}
          d={d}
          fill="none"
          stroke="#8a6c3e"
          strokeWidth={2}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

function BodyG({ pose }: { pose: BodyPose }) {
  const halfLen = pose.kind === 'loco' ? 34 : 30;
  const h = pose.kind === 'loco' ? 20 : 17;
  const fill = pose.color ?? (pose.kind === 'loco' ? '#c0392b' : '#8e44ad');
  const stroke = pose.fate === 'on-rail' ? '#222' : '#b00020';
  return (
    <g
      transform={`translate(${pose.x},${pose.y}) rotate(${pose.rotationDeg})`}
      data-body-id={pose.id}
      data-fate={pose.fate}
      data-mode={pose.mode}
    >
      <rect
        x={-halfLen}
        y={-h / 2}
        width={halfLen * 2}
        height={h}
        rx={4}
        fill={fill}
        stroke={stroke}
        strokeWidth={pose.fate === 'on-rail' ? 1.5 : 3}
      />
      {pose.kind === 'loco' && (
        // a nose mark so facing/direction is legible
        <rect
          x={halfLen - 8}
          y={-h / 2}
          width={8}
          height={h}
          rx={2}
          fill="#1a1a1a"
          opacity={0.55}
        />
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

/** Apply any script motion-intents now due (the device's only command). */
function fireDueScripts(
  scenario: PhysicsScenario,
  world: PhysicsWorld,
  elapsedS: number,
  fired: Set<number>,
): void {
  for (let i = 0; i < scenario.script.length; i++) {
    const s = scenario.script[i];
    if (s !== undefined && !fired.has(i) && elapsedS >= s.atS) {
      world.setMotion(s.id, s.motion);
      fired.add(i);
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
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [visionMm, setVisionMm] = useState<number | null>(null);
  const worldRef = useRef<PhysicsWorld | null>(null);

  useEffect(() => {
    if (scenario === undefined) return;
    const rail = buildRail(scenario.pieces);
    const world = new PhysicsWorld(rail);
    for (const b of scenario.bodies) world.addBody(b);
    for (const [a, b] of scenario.couples) world.couple(a, b);
    worldRef.current = world;
    const v = scenario.vision;
    let reported: number | null = null;
    const runVision = v
      ? makeVisionRunner(v, world, (mm) => {
          reported = mm;
          setVisionMm(mm);
        })
      : null;
    const expectedMm = v ? v.rakeSpanMm + 2 * v.footprintRadiusMm : 0;
    if (v) window.__tfVision = { reportedMm: null, expectedMm };
    const fired = new Set<number>();
    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(world.bodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        elapsed += STEP_S;
        fireDueScripts(scenario, world, elapsed, fired);
        world.step(STEP_S);
        runVision?.(elapsed);
        acc -= STEP_S;
      }
      setPoses(world.bodies());
      window.__tfPhysics = { name, elapsedS: elapsed, bodies: () => world.bodies() };
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
        viewBox={viewBoxFor(scenario.pieces, scenario.viewPad)}
        style={{ width: '100%', height: '100%' }}
      >
        <title>{scenario.title}</title>
        {scenario.pieces.map((p) => (
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
