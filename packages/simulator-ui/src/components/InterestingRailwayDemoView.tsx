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

export function InterestingRailwayDemoView() {
  const scene = useMemo(() => buildMainLoopScene(), []);
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);

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
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
      </svg>
    </div>
  );
}
