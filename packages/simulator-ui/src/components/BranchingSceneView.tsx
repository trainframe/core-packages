/**
 * The BRANCHING layout, RENDERED (FROZEN SPEC §5). This view is the BROWSER-side
 * composition root for `?physics=branching`: it builds the SAME branching scene +
 * compiled `Layout` as the Node gate (Engineer A's `buildBranchingScene` /
 * `sceneToLayout`), stages a `PhysicsWorld` from `scene.net`, and RENDERS it in the
 * ADR-024 workshop aesthetic (reusing `railPath`, `SegArt`, `Platform`,
 * `YardGantry`/`Truss`, `BodyG` from `RailyardDemoScenarioView`).
 *
 * Unlike the bespoke `RailyardDemoScenarioView`, NOTHING here drives logic: routing,
 * clearance and occupancy all come from the REAL `@trainframe/server` scheduler
 * running in Node (the harness / the render script), which talks to the devices over
 * MQTT. This view connects to that broker via `mqttPlatform` (URL from
 * `localStorage`), so the live switch positions it draws are the scheduler's, and it
 * NEVER assigns a route. It is a pure consumer of the spatial layout (`scene.geom`)
 * plus the authoritative `world.bodies()` poses each `requestAnimationFrame`.
 *
 * Exposes `window.__tfPhysics` (world handle, for assertions), and the DEV hooks
 * `window.__tfLoadBranching()` (seed/restart the world) + `window.__tfFitView()`
 * (frame the whole layout) the render script calls before scheduling.
 */
import { useEffect, useMemo, useState } from 'react';
import { MqttBrokerClient } from '../broker/mqtt-client.js';
import { mqttPlatform } from '../broker/mqtt-platform.js';
import { loadBrokerUrl } from '../config/broker-config.js';
import {
  type BranchingScene,
  type Station,
  buildBranchingScene,
} from '../physics/branching-scene.js';
import { type BodyPose, PhysicsWorld } from '../physics/world.js';
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

const RED = '#c0392b';
const BLUE = '#2d6cdf';
const GREEN = '#27ae60';
const ORANGE = '#d4761e';
const GOLD = '#e0a81e';

/** The four scheduler-driven trains, with the segment + rail position each is
 *  seeded at and a livery. These match §8's roster (T1 Express, T2 Yard turn, T3
 *  Branch local, T4 Yard reliever). The Node scheduler routes them; this view only
 *  renders where physics puts them. */
const TRAIN_SEED: ReadonlyArray<{
  id: string;
  color: string;
  segment: string;
  railPos: number;
  cars: number;
}> = [
  { id: 'T1', color: RED, segment: 'top', railPos: 1500, cars: 3 },
  { id: 'T2', color: BLUE, segment: 'bottom', railPos: 900, cars: 3 },
  { id: 'T3', color: GREEN, segment: 'rightA', railPos: 120, cars: 2 },
  { id: 'T4', color: ORANGE, segment: 'leftB', railPos: 200, cars: 3 },
];

/** Seed a loco + its rake of carriages onto the world, coupled head-to-tail. */
function seedTrain(
  world: PhysicsWorld,
  spec: { id: string; color: string; segment: string; railPos: number; cars: number },
): void {
  world.addBody({
    id: spec.id,
    kind: 'loco',
    railPos: spec.railPos,
    facing: 1,
    segment: spec.segment,
    color: spec.color,
    power: 820,
    maxSpeed: 300,
  });
  for (let i = 0; i < spec.cars; i++) {
    const id = `${spec.id}c${i}`;
    world.addBody({
      id,
      kind: 'carriage',
      railPos: spec.railPos - (i + 1) * 68,
      facing: 1,
      segment: spec.segment,
      color: spec.color,
    });
    world.couple(i === 0 ? spec.id : `${spec.id}c${i - 1}`, id);
  }
}

/** Stage the branching world: the four trains spaced around the layout and a gold
 *  spares cut pre-parked in the yard's entry slot (what the crane migrates). */
function buildBranchingWorld(scene: BranchingScene): PhysicsWorld {
  const world = new PhysicsWorld(scene.net);
  for (const t of TRAIN_SEED) seedTrain(world, t);

  /* A gold spares cut in the entry slot — the interior service's pick-up. */
  const slot = scene.entrySlot;
  world.addBody({
    id: 'g0',
    kind: 'carriage',
    railPos: 200,
    facing: 1,
    segment: slot,
    color: GOLD,
  });
  world.addBody({
    id: 'g1',
    kind: 'carriage',
    railPos: 132,
    facing: 1,
    segment: slot,
    color: GOLD,
  });
  world.couple('g0', 'g1');
  return world;
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

/** Open a broker connection over `mqttPlatform` so the view participates on the bus
 *  the Node scheduler drives (the spec's "browser subscribes via mqttPlatform").
 *  Returns the client so the caller can disconnect on cleanup. The view never
 *  publishes a route — it only listens. A connect failure (no broker yet) is
 *  non-fatal: the world still renders. */
function connectBroker(): MqttBrokerClient {
  const client = new MqttBrokerClient();
  try {
    client.connect(loadBrokerUrl());
    /* Touch `mqttPlatform` at the IO edge so the view is wired exactly as a device
     *  composition root would be (the same adapter the gate/script use). We
     *  subscribe to commands for a non-device id only to exercise the seam; the
     *  view itself never acts on them. */
    mqttPlatform(client, 'branching-view').onCommand(() => {});
  } catch {
    /* No broker reachable (e.g. standalone preview) — render the world anyway. */
  }
  return client;
}

/** The live world subtree: builds + steps a `PhysicsWorld`, opens the broker, and
 *  renders the poses. The parent gives it a `key` so a reseed (the DEV hook) simply
 *  remounts this — a clean teardown/rebuild without a nonce in the effect deps. */
function BranchingWorld({ scene }: { scene: BranchingScene }) {
  const [poses, setPoses] = useState<readonly BodyPose[]>([]);

  const gantry = useMemo(() => yardBounds(scene), [scene]);
  const crane = useMemo(() => craneHome(gantry), [gantry]);
  const viewBox = useMemo(() => sceneViewBox(scene), [scene]);
  const segIds = useMemo(() => [...scene.geom.keys()], [scene]);

  useEffect(() => {
    const world = buildBranchingWorld(scene);
    const client = connectBroker();

    let elapsed = 0;
    let acc = 0;
    let last = performance.now();
    let raf = 0;
    setPoses(world.bodies());
    const tick = (now: number) => {
      acc += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (acc >= STEP_S) {
        world.step(STEP_S);
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
      client.disconnect();
    };
  }, [scene]);

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
