import { MqttBrokerClient } from '@trainframe/simulator/broker/mqtt-client.js';
import { mqttPlatform } from '@trainframe/simulator/broker/mqtt-platform.js';
import {
  type BranchingDemo,
  buildBranchingDemo,
} from '@trainframe/simulator/demo/branching-demo.js';
import {
  type BranchingScene,
  type Station,
  buildBranchingScene,
} from '@trainframe/simulator/physics/branching-scene.js';
import type { BodyPose } from '@trainframe/simulator/physics/world.js';
/**
 * The BRANCHING layout, RENDERED (FROZEN SPEC §5). This view is the BROWSER-side
 * DEVICE composition root for `?physics=branching`: it builds the REAL
 * `buildBranchingDemo` assembly — ONE `PhysicsWorld`, a `ScheduledTrainDevice` per
 * loco, the `Jspur` `SwitchDevice`, and the `YardZoneDevice` — each wired over
 * `mqttPlatform` to the configured broker (URL from `localStorage`). It `start()`s
 * those devices, steps `demo.step(STEP_S)` every `requestAnimationFrame`, and
 * RENDERS the authoritative `demo.world.bodies()` poses in the ADR-024 workshop
 * aesthetic (the local `railPath`/`SegArt`/`Platform`/`YardGantry`/`Truss` plus
 * `BodyG`).
 *
 * The browser is the DEVICE side, exactly as the headless gate and the render
 * script are: routing, clearance, switch resolution and yard occupancy all come
 * from the REAL `@trainframe/server` scheduler running in Node (the harness / the
 * render script). The devices here register over the bus and execute the routes
 * the scheduler assigns — this view NEVER assigns a route. If the broker is
 * unreachable (e.g. the jsdom unit test, or a standalone preview) the devices
 * simply receive no commands and the world renders idle.
 *
 * Exposes `window.__tfPhysics` (world handle, for assertions), and the DEV hooks
 * `window.__tfLoadBranching()` (rebuild/restart the demo) + `window.__tfFitView()`
 * (frame the whole layout) the render script calls before scheduling.
 */
import { useEffect, useMemo, useState } from 'react';
import { loadBrokerUrl } from '../config/broker-config.js';
import { BodyG } from './PhysicsScenarioView.js';
import { WoodDefs } from './piece-art.js';

declare global {
  interface Window {
    /** DEV-only: (re)seed the branching physics world. The render script calls
     *  this after pointing `localStorage` at the harness broker. Registered behind
     *  `import.meta.env.DEV`; absent in production. */
    __tfLoadBranching?: (() => void) | undefined;
  }
}

const STEP_S = 1 / 120;
/* The slot count the demo composition root uses (`branching-demo.ts`); the
 * furniture scene drawn here is built with the same value so its geometry matches
 * the device-side world exactly. */
const SLOT_COUNT = 3;

/* The following presentational SVG helpers render the ADR-024 workshop aesthetic
 * (rails as routed wooden planks, a station slab, the CV gantry). They mirror the
 * bespoke `RailyardDemoScenarioView` look intentionally — kept local here because
 * that file is owned by another module and exports none of them; the shapes are
 * pure furniture, no logic. */

/** An SVG path traced along a rail (straight or curved) by sampling it. */
function railPath(rail: { length: number; at: (d: number) => { x: number; y: number } }): string {
  const n = Math.max(8, Math.ceil(rail.length / 14));
  let d = '';
  for (let i = 0; i <= n; i++) {
    const p = rail.at((rail.length * i) / n);
    d += `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d;
}

/** A rail segment drawn as a wooden plank band with a routed groove. */
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
        stroke="#9a7b46"
        strokeWidth={14}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.25}
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

/** A vertical girder truss (two chords + a zig-zag web) the crane rides across. */
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

/** The yard's CV gantry: two foundation rails, the truss at the crane's x, and the
 *  crane head (camera + wedge) at its position. */
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

/** A station platform beside the running line: a planked slab offset to one side, a
 *  coloured edge, and a hanging name board. */
function Platform({ station }: { station: Station }) {
  const rad = (station.angleDeg * Math.PI) / 180;
  const nx = Math.sin(rad) * station.side;
  const ny = -Math.cos(rad) * station.side;
  const off = 28;
  const cx = station.x + nx * off;
  const cy = station.y + ny * off;
  const depth = 40;
  const seams = Math.round(station.length / 30);
  return (
    <g
      data-testid={`station-${station.id}`}
      transform={`translate(${cx},${cy}) rotate(${station.angleDeg})`}
    >
      <rect
        x={-station.length / 2}
        y={-depth / 2}
        width={station.length}
        height={depth}
        rx={5}
        fill="#cdbca0"
        stroke="#9c8866"
        strokeWidth={1.5}
      />
      {Array.from({ length: seams }, (_, i) => {
        const px = -station.length / 2 + (i + 1) * 30;
        return (
          <line
            key={px}
            x1={px}
            y1={-depth / 2}
            x2={px}
            y2={depth / 2}
            stroke="#9c8866"
            strokeWidth={0.8}
            opacity={0.5}
          />
        );
      })}
      <rect
        x={-station.length / 2}
        y={(-depth / 2) * station.side - 2 * station.side}
        width={station.length}
        height={4}
        fill="#e7b53b"
        opacity={0.9}
      />
      <g transform={`rotate(${-station.angleDeg})`}>
        <rect x={-44} y={-11} width={88} height={22} rx={4} fill="#2f3b2c" stroke="#1c241a" />
        <text
          x={0}
          y={5}
          textAnchor="middle"
          fontFamily="sans-serif"
          fontSize={13}
          fontWeight={700}
          fill="#f0ead6"
        >
          {station.name}
        </text>
      </g>
    </g>
  );
}

/** The yard footprint (for the gantry frame): the bbox of its segments + a margin
 *  so the foundation rails clear the slots. */
function yardBounds(scene: BranchingScene): {
  minX: number;
  maxX: number;
  top: number;
  bot: number;
} {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const g of scene.yard.geom.values()) {
    minX = Math.min(minX, g.ax, g.bx);
    maxX = Math.max(maxX, g.ax, g.bx);
    minY = Math.min(minY, g.ay, g.by);
    maxY = Math.max(maxY, g.ay, g.by);
  }
  return { minX: minX - 30, maxX: maxX + 30, top: minY - 42, bot: maxY + 42 };
}

/** The crane head's idle rest position — centred over the yard footprint. The
 *  Node-side `YardController` owns the real crane; this is just where the gantry
 *  head sits for the render until live state says otherwise. */
function craneHome(bounds: { minX: number; maxX: number; top: number; bot: number }): {
  x: number;
  y: number;
} {
  return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.top + bounds.bot) / 2 };
}

/** A points-blade marker drawn at a junction node so the diverge reads as a real
 *  junction. Mirrors the bespoke view's points mark. */
function Junction({ x, y, active }: { x: number; y: number; active: boolean }) {
  return (
    <g data-testid="branching-junction" transform={`translate(${x},${y})`}>
      <circle r={9} fill={active ? '#e7b53b' : '#8893a0'} stroke="#5e6772" strokeWidth={1.5} />
      <line x1={-6} y1={0} x2={10} y2={-8} stroke="#39414b" strokeWidth={3} strokeLinecap="round" />
    </g>
  );
}

/** The scene viewBox: the bbox of every segment endpoint plus a margin. */
function sceneViewBox(scene: BranchingScene): string {
  const segs = [...scene.geom.values()];
  const xs = segs.flatMap((s) => [s.ax, s.bx]);
  const ys = segs.flatMap((s) => [s.ay, s.by]);
  const minX = Math.min(...xs) - 180;
  const maxX = Math.max(...xs) + 180;
  const minY = Math.min(...ys) - 200;
  const maxY = Math.max(...ys) + 200;
  return `${minX} ${minY} ${maxX - minX} ${maxY - minY}`;
}

/** A built demo together with the broker clients it wired — one `MqttBrokerClient`
 *  per device (the same per-device wiring the headless gate uses). */
interface BuiltDemo {
  readonly demo: BranchingDemo;
  readonly clients: readonly MqttBrokerClient[];
}

/** Build the REAL branching demo as the DEVICE side: a `ScheduledTrainDevice` per
 *  loco + the `Jspur` `SwitchDevice` + the `YardZoneDevice`, each on its own broker
 *  client wired through `mqttPlatform`. Connecting is guarded: a broker that can't
 *  be reached (the jsdom unit test, a standalone preview) is non-fatal — the
 *  devices simply receive no routes and the world renders idle. `start()` is
 *  likewise guarded so a transport hiccup never breaks the render or the test. */
function buildDemo(): BuiltDemo {
  const clients: MqttBrokerClient[] = [];
  const url = loadBrokerUrl();
  const demo = buildBranchingDemo((deviceId) => {
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

/** The live world subtree: builds the REAL demo (device side) inside the mount
 *  effect, steps it, and renders the authoritative world poses. The furniture
 *  (rails/stations/junctions/gantry) is drawn from the SAME pure `scene` geometry
 *  the demo's world is built on — `buildBranchingScene` is pure, so the independent
 *  copy used for furniture is identical to `demo.scene`. The parent gives this a
 *  `key` so the DEV reseed hook simply remounts it — a clean teardown (devices
 *  stopped, clients disconnected) + rebuild. */
function BranchingWorld({ scene }: { scene: BranchingScene }) {
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);

  const gantry = useMemo(() => yardBounds(scene), [scene]);
  const crane = useMemo(() => craneHome(gantry), [gantry]);
  const viewBox = useMemo(() => sceneViewBox(scene), [scene]);
  const segIds = useMemo(() => [...scene.geom.keys()], [scene]);

  useEffect(() => {
    /* Build + start the device-side demo here (an effect, not render) so a double
     *  mount under React StrictMode is matched by a clean teardown each time. */
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
        name: 'branching',
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
        Branching layout — the real scheduler routes four trains down distinct branches (main loop,
        scenic branch, the CV railyard); clearance, switches and yard occupancy are all the
        scheduler's
      </div>
      <svg data-testid="physics-canvas" viewBox={viewBox} style={{ width: '100%', height: '100%' }}>
        <title>Branching layout — scheduler-driven main loop, scenic branch, and CV railyard</title>
        <WoodDefs />
        {segIds.map((id) => (
          <SegArt key={id} d={railPath(scene.net.railOf(id))} />
        ))}
        {scene.stations.map((s: Station) => (
          <Platform key={s.id} station={s} />
        ))}
        {scene.junctions.map((j) => {
          const g = scene.geom.get(j.switchId === 'Jspur' ? 'rightB' : 'leftA');
          if (g === undefined) return null;
          return <Junction key={j.markerId} x={g.bx} y={g.by} active={false} />;
        })}
        {poses.map((p) => (
          <BodyG key={p.id} pose={p} />
        ))}
        <YardGantry bounds={gantry} crane={crane} />
      </svg>
    </div>
  );
}

export function BranchingSceneView() {
  const scene = useMemo(() => buildBranchingScene(SLOT_COUNT), []);
  /* A reseed key: bumping it remounts `BranchingWorld`, tearing the world down +
   *  rebuilding it fresh. This is what `__tfLoadBranching()` does. */
  const [seedNonce, setSeedNonce] = useState(0);

  useEffect(() => {
    window.__tfLoadBranching = () => setSeedNonce((n) => n + 1);
    window.__tfFitView = () => {
      /* The viewBox already frames the whole layout; nothing to pan. The hook
       *  exists so the render script's call resolves. */
    };
    return () => {
      window.__tfLoadBranching = undefined;
      window.__tfFitView = undefined;
    };
  }, []);

  return <BranchingWorld key={seedNonce} scene={scene} />;
}
