/**
 * The 4-TRAIN INTERESTING-RAILWAY demo, rendered live (ADR-030) — the SAME headless
 * `buildInterestingRailwayDemo` assembly the integration gates drive, now drawn in the
 * browser. The browser owns the DEVICE side: one `PhysicsWorld`, a `ScheduledTrainDevice`
 * per loco, a `SwitchDevice` per junction, and the `YardZoneDevice` — each on its own
 * broker client through `mqttPlatform`. The REAL `@trainframe/server` scheduler runs in
 * Node (the UI harness); it routes, clears, throws switches and gates the yard. Mounted
 * by `App` on `?physics=interesting-demo`.
 *
 * A broker that can't be reached (the jsdom unit test, a standalone preview) is
 * non-fatal — the world renders idle. Exposes `window.__tfPhysics` for the video harness.
 */
import { useEffect, useMemo, useState } from 'react';
import { MqttBrokerClient } from '../broker/mqtt-client.js';
import { mqttPlatform } from '../broker/mqtt-platform.js';
import { loadBrokerUrl } from '../config/broker-config.js';
import {
  type InterestingRailwayDemo,
  buildInterestingRailwayDemo,
} from '../demo/interesting-railway-demo.js';
import { buildMainLoopScene } from '../physics/interesting-layout.js';
import { buildInterestingMarkers } from '../physics/interesting-markers.js';
import { railOfPiece } from '../physics/rail.js';
import type { BodyPose } from '../physics/world.js';
import { pierSuppressed } from '../track/overlap.js';
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

/** A track segment drawn in the workshop wood style; a raised deck (a bridge) gets a
 *  halo that breaks the rail beneath so the crossing reads as over-and-under. */
function SegArt({ d, raised = false }: { d: string; raised?: boolean }) {
  return (
    <>
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

/** A latticework girder of the gantry, a chevron web between two chords at the crane's x. */
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

/** The yard's CV gantry: two foundation rails, the truss at the crane's x, and the crane
 *  head (camera + wedge) at the device-driven position. */
function YardGantry({
  bounds,
  crane,
}: {
  bounds: { minX: number; maxX: number; top: number; bot: number };
  crane: { x: number; y: number };
}) {
  const { minX, maxX, top, bot } = bounds;
  return (
    <g data-testid="yard-gantry">
      {[top, bot].map((gy) => (
        <g key={gy}>
          <rect
            x={minX}
            y={gy - 5}
            width={maxX - minX}
            height={10}
            rx={2}
            fill="#8893a0"
            stroke="#5e6772"
            strokeWidth={1}
          />
          <line x1={minX} y1={gy} x2={maxX} y2={gy} stroke="#c3cbd4" strokeWidth={1.5} />
        </g>
      ))}
      <Truss x={crane.x} top={top} bot={bot} />
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
    </g>
  );
}

/** A station platform: a planked slab beside the line with a coloured edge. */
function StationPlatform({ x, y }: { x: number; y: number }) {
  return (
    <g data-testid="station">
      <rect
        x={x - 34}
        y={y - 30}
        width={68}
        height={15}
        rx={3}
        fill="#c9b48c"
        stroke="#6f4c28"
        strokeWidth={1.5}
      />
      <rect x={x - 34} y={y - 16} width={68} height={3} fill="#8a6a3e" />
    </g>
  );
}

/** Build the REAL interesting-railway demo as the DEVICE side, each device on its own
 *  broker client through `mqttPlatform`. Connecting + starting are guarded so an
 *  unreachable broker renders idle rather than throwing. */
function buildDemo(): { demo: InterestingRailwayDemo; clients: MqttBrokerClient[] } {
  const clients: MqttBrokerClient[] = [];
  const url = loadBrokerUrl();
  const demo = buildInterestingRailwayDemo((deviceId) => {
    const client = new MqttBrokerClient();
    clients.push(client);
    try {
      client.connect(url);
    } catch {
      /* No broker reachable — render idle; the device just never gets commands. */
    }
    return mqttPlatform(client, deviceId);
  });
  try {
    demo.start();
  } catch {
    /* A transport hiccup at register time is non-fatal: the world still renders. */
  }
  return { demo, clients };
}

/** Station platforms (each station marker's world point) + the yard's bounding box (for
 *  the gantry truss) — derived once from the pure scene. */
function sceneFurniture(scene: ReturnType<typeof buildMainLoopScene>) {
  const ml = buildInterestingMarkers(scene);
  const stations = ml.markers
    .filter((m) => m.kind === 'station_stop')
    .map((m) => {
      const rail = scene.net.railOf(m.segment);
      const d = m.distAlongMm ?? (m.end === 'start' ? 0 : rail.length);
      const p = rail.at(d);
      return { id: m.id, x: p.x, y: p.y };
    });
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const seg of [scene.yard.topLeadIn, scene.yard.bottomLeadOutSeg, ...scene.yard.slots]) {
    const g = scene.geom.get(seg);
    if (g === undefined) continue;
    for (const pt of [g.start, g.end]) {
      minX = Math.min(minX, pt.x);
      maxX = Math.max(maxX, pt.x);
      minY = Math.min(minY, pt.y);
      maxY = Math.max(maxY, pt.y);
    }
  }
  return { stations, yard: { minX, maxX, minY, maxY } };
}

export function InterestingRailwayDemoView() {
  const scene = useMemo(() => buildMainLoopScene(), []);
  const furniture = useMemo(() => sceneFurniture(scene), [scene]);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);
  const [crane, setCrane] = useState<{ x: number; y: number }>({
    x: (furniture.yard.minX + furniture.yard.maxX) / 2,
    y: furniture.yard.minY,
  });

  useEffect(() => {
    const { demo, clients } = buildDemo();
    const world = demo.world;
    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(world.bodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        demo.step(STEP_S);
        elapsed += STEP_S;
        acc -= STEP_S;
      }
      setPoses(world.bodies());
      setCrane(demo.yardCranePos());
      window.__tfPhysics = {
        name: 'interesting-demo',
        elapsedS: elapsed,
        bodies: () => world.bodies(),
      };
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.__tfPhysics = undefined;
      demo.stop();
      for (const c of clients) c.disconnect();
    };
  }, []);

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

  const bridgePieces = scene.pieces.filter((p) => layerOf(p) >= 1 || p.type === 'ramp');
  const raisedDecks = bridgePieces.map((p) => ({ id: p.id, d: railPath(railOfPiece(p, 0, 1)) }));
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
        Interesting railway — the real scheduler runs four trains on the winding loop; one calls at
        the drive-through yard, where its carriages are swapped on-rail
      </div>
      <svg
        data-testid="physics-canvas"
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        style={{ width: '100%', height: '100%' }}
      >
        <title>Interesting railway — 4-train scheduled demo with the on-rail yard swap</title>
        <WoodDefs />
        {segs.map((id) => (
          <SegArt key={id} d={railPath(scene.net.railOf(id))} />
        ))}
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
        {raisedDecks.map((deck) => (
          <SegArt key={deck.id} d={deck.d} raised />
        ))}
        {/* Station platforms beside each station marker. */}
        {furniture.stations.map((s) => (
          <StationPlatform key={`stn-${s.id}`} x={s.x} y={s.y} />
        ))}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        {/* The yard's CV gantry — metal truss riding foundation rails, with the live head. */}
        <YardGantry
          bounds={{
            minX: furniture.yard.minX - 12,
            maxX: furniture.yard.maxX + 12,
            top: furniture.yard.minY - 20,
            bot: furniture.yard.maxY + 20,
          }}
          crane={crane}
        />
      </svg>
    </div>
  );
}
