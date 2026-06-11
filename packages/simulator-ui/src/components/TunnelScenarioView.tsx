/**
 * The tunnel demo, rendered (ADR-030 sensing-only). A train drives a straight run
 * straight THROUGH a roofed tunnel section partway along: it enters the near
 * portal and is hidden under a stone-mouthed grassy hill (the roof is drawn OVER
 * the bodies for the covered span, so the loco is genuinely occluded beneath it),
 * then emerges deterministically at the far portal and carries on — the rail
 * leads it out exactly where its own speed takes it.
 *
 * The headline contrast (surfaced on `window.__tfPhysics`):
 *   - entry + exit MARKER tripwires fire as the loco crosses their fixed x, so the
 *     hidden train is tracked through the dark (`markers` log);
 *   - an in-tunnel CAMERA sample of the covered midpoint stays BLIND over a DARK
 *     tunnel (`cameraSawInside === false`) — markers keep firing while the camera
 *     goes dark, the two sensing modalities contrasted.
 *
 * Nothing is keyframed: the train is its authoritative physics pose, the camera
 * honestly returns empty when occluded (ADR-031 §2). Wood/stone aesthetic
 * (ADR-024) in plan view.
 *
 * Mounted by `App` on `?physics=tunnel` (dark) and `?physics=tunnel-lit` (a LIT
 * tunnel where the same camera DOES see inside — proving occlusion is a per-tunnel
 * property, not inherent: `cameraSawInside === true`).
 */
import { useEffect, useMemo, useState } from 'react';
import { TunnelRun } from '../physics/tunnel-run.js';
import { makeTunnel } from '../physics/tunnel.js';
import type { BodyPose } from '../physics/world.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

const STEP_S = 1 / 120;
const RAIL_Y = 600;
const RAIL_X0 = 150;
const RAIL_X1 = 2050;
/* The roofed span sits partway along the run, well clear of either rail end. */
const TUNNEL_X0 = 900;
const TUNNEL_X1 = 1350;
const TUNNEL_HALF_W = 60;

/** The stone portal arch at a covered span's mouth — a plan-view ring of voussoirs
 *  framing a dark opening across the track. Drawn at both portal faces. */
function Portal({ x, y }: { x: number; y: number }) {
  return (
    <g data-testid="tunnel-portal">
      <rect
        x={x - 9}
        y={y - TUNNEL_HALF_W}
        width={18}
        height={2 * TUNNEL_HALF_W}
        rx={4}
        fill="#9aa0a6"
        stroke="#5c6065"
        strokeWidth={2}
      />
      {/* The dark mouth at the rail. */}
      <rect x={x - 4} y={y - 20} width={8} height={40} rx={2} fill="#1c1a17" />
    </g>
  );
}

/** The roof: a grassy hill spanning the covered rail, drawn OVER the bodies so the
 *  train is occluded beneath it. A `lit` tunnel glows a warm interior light at its
 *  mouth so the contrast (camera sees inside) reads visually too. */
function Roof({
  x0,
  x1,
  y,
  lit,
}: {
  x0: number;
  x1: number;
  y: number;
  lit: boolean;
}) {
  return (
    <g data-testid="tunnel-roof">
      <rect
        x={x0}
        y={y - TUNNEL_HALF_W}
        width={x1 - x0}
        height={2 * TUNNEL_HALF_W}
        rx={10}
        fill="#5f7d4f"
        stroke="#3f5734"
        strokeWidth={3}
        style={{ filter: 'drop-shadow(0 2px 3px rgba(31,40,22,0.4))' }}
      />
      {/* A lighter crown ridge along the hilltop. */}
      <line
        x1={x0 + 14}
        y1={y}
        x2={x1 - 14}
        y2={y}
        stroke="#6f9159"
        strokeWidth={2 * TUNNEL_HALF_W - 26}
        strokeLinecap="round"
        opacity={0.55}
      />
      {lit && (
        <text
          x={(x0 + x1) / 2}
          y={y + 5}
          fontSize={20}
          textAnchor="middle"
          fill="#ffd98a"
          data-testid="tunnel-lit-glow"
        >
          ☀ lit
        </text>
      )}
    </g>
  );
}

/** A portal marker tripwire's furniture + its fired state (green = fired). */
function MarkerTick({
  x,
  y,
  label,
  fired,
}: {
  x: number;
  y: number;
  label: string;
  fired: boolean;
}) {
  return (
    <g data-testid={`tunnel-marker-${label}`}>
      <line
        x1={x}
        y1={y - 70}
        x2={x}
        y2={y + 70}
        stroke={fired ? '#1a6' : '#9aa'}
        strokeWidth={fired ? 4 : 2}
        strokeDasharray={fired ? undefined : '5 5'}
      />
      <text x={x} y={y - 78} fontSize={15} textAnchor="middle" fill={fired ? '#157' : '#888'}>
        {label} {fired ? '✓' : ''}
      </text>
    </g>
  );
}

export function TunnelScenarioView({ lit = false }: { lit?: boolean }) {
  const tunnel = useMemo(
    () =>
      makeTunnel({
        id: 'tunnel-1',
        x0: TUNNEL_X0,
        x1: TUNNEL_X1,
        y: RAIL_Y,
        halfWidth: TUNNEL_HALF_W,
        lighting: lit ? 'lit' : 'dark',
      }),
    [lit],
  );
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [markers, setMarkers] = useState<readonly string[]>([]);
  const [sawInside, setSawInside] = useState(false);

  useEffect(() => {
    const run = new TunnelRun({
      railX0: RAIL_X0,
      railX1: RAIL_X1,
      railY: RAIL_Y,
      startRailPos: 200,
      tunnel,
    });
    const name = lit ? 'tunnel-lit' : 'tunnel';

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    /* One fixed physics step: the train runs the rail under the roof, markers fire
     *  at the portals, the in-tunnel camera samples (blind in the dark). */
    const advance = (): void => {
      run.step(STEP_S);
      elapsed += STEP_S;
    };
    const publish = (): void => {
      setPoses(run.physicsWorld().bodies());
      setMarkers(run.firedMarkers());
      setSawInside(run.cameraSawInside());
      window.__tfPhysics = {
        name,
        elapsedS: elapsed,
        bodies: () => run.physicsWorld().bodies(),
        markers: run.firedMarkers(),
        cameraSawInside: run.cameraSawInside(),
      };
    };
    publish();
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        advance();
        acc -= STEP_S;
      }
      publish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
    };
  }, [tunnel, lit]);

  const minX = RAIL_X0 - 160;
  const maxX = RAIL_X1 + 160;
  const minY = RAIL_Y - 220;
  const maxY = RAIL_Y + 220;
  const markerFired = (id: string): boolean => markers.includes(id);

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
        {lit
          ? 'Tunnel (lit): the train runs through a roofed section; markers fire AND the interior camera sees it'
          : 'Tunnel (dark): the train runs through a roofed section; the camera goes blind while the entry/exit markers track it through'}
      </div>
      <div
        style={{
          position: 'absolute',
          top: 38,
          left: 16,
          fontFamily: 'sans-serif',
          fontSize: 13,
          color: '#5a4a2a',
        }}
        data-testid="tunnel-readout"
      >
        markers fired: [{markers.join(', ')}] · camera saw inside: {sawInside ? 'yes' : 'no'}
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Tunnel — a roofed stretch of ordinary track</title>
        <WoodDefs />
        {/* The running line, end to end (it runs UNDER the roof unbroken). */}
        <path
          d={`M${RAIL_X0} ${RAIL_Y} L${RAIL_X1} ${RAIL_Y}`}
          fill="none"
          stroke="#cba460"
          strokeWidth={14}
          strokeLinecap="round"
        />
        <path
          d={`M${RAIL_X0} ${RAIL_Y} L${RAIL_X1} ${RAIL_Y}`}
          fill="none"
          stroke="#6f4c28"
          strokeWidth={2.6}
          strokeLinecap="round"
        />
        {/* Portal arches at both mouths (beneath the roof, framing the openings). */}
        <Portal x={TUNNEL_X0} y={RAIL_Y} />
        <Portal x={TUNNEL_X1} y={RAIL_Y} />
        {/* The bodies at their authoritative poses. */}
        {poses.map((pose) => (
          <BodyG key={pose.id} pose={pose} />
        ))}
        {/* The roof LAST over the covered span, so a body under it is occluded. */}
        <Roof x0={TUNNEL_X0} x1={TUNNEL_X1} y={RAIL_Y} lit={lit} />
        {/* The portal markers (drawn over the roof so their state is always read). */}
        <MarkerTick x={TUNNEL_X0} y={RAIL_Y} label="entry" fired={markerFired('entry')} />
        <MarkerTick x={TUNNEL_X1} y={RAIL_Y} label="exit" fired={markerFired('exit')} />
      </svg>
    </div>
  );
}
