/**
 * The headless engine behind the tunnel scenario (ADR-030 sensing-only).
 *
 * A train drives a straight rail straight THROUGH a roofed tunnel. The roof is
 * cosmetic: body motion is the ordinary `PhysicsWorld` rail run. What the tunnel
 * changes is sensing only, and the contrast is the headline:
 *
 *   - MARKER tripwires at the entry + exit portals fire as the loco crosses their
 *     fixed x — UNAFFECTED by the roof, so a hidden train is still tracked.
 *   - An in-tunnel CAMERA samples the covered midpoint every tick. Over a DARK
 *     tunnel the camera is blind (the occlusion predicate makes `perceive()`
 *     return empty even though the body is there), so `cameraSawInside` stays
 *     false; over a LIT tunnel the same camera sees the train, so it goes true.
 *
 * No animation, no reading of body ground truth for the camera — the camera
 * honestly returns empty when blind (ADR-031 §2); the determinism is the rail.
 *
 * Pure, DOM-free, unit-tested headless. The React view drives `step` from rAF and
 * reads the public observers; the harness reads the same.
 */

import { type CameraProvider, physicsCameraProvider } from '../sensors/camera-provider.js';
import { type Tunnel, darkTunnelOcclusion } from './tunnel.js';
import { PhysicsWorld } from './world.js';
import { straightSeg } from './yard.js';

/** A fixed-x marker tripwire on the line: fires once when a body's x crosses it
 *  moving in +x. Track-embedded — entirely independent of any tunnel roof. */
interface Marker {
  readonly id: string;
  readonly x: number;
  fired: boolean;
}

export interface TunnelRunConfig {
  /** Rail start / end world x (rail runs straight along `railY`). */
  readonly railX0: number;
  readonly railX1: number;
  readonly railY: number;
  /** Where the loco starts along the rail. */
  readonly startRailPos: number;
  /** The single roofed tunnel (dark or lit). */
  readonly tunnel: Tunnel;
  /** Capture radius (mm) of the in-tunnel camera footprint. */
  readonly cameraRadiusMm?: number;
}

const DEFAULT_CAMERA_RADIUS = 22;

/** Drives one train through one tunnel, exposing what the system perceived. */
export class TunnelRun {
  private readonly world: PhysicsWorld;
  private readonly camera: CameraProvider;
  private readonly markers: Marker[];
  private readonly cfg: TunnelRunConfig;
  private prevX: number | null = null;
  private readonly markerLog: string[] = [];
  private sawInside = false;

  constructor(cfg: TunnelRunConfig) {
    this.cfg = cfg;
    /* The far rail end is a buffer so the train comes to rest ON the rail after
     *  emerging (rather than running off the open end) — the demo's resting state
     *  reads "emerged and stopped past the tunnel", not "ran off". */
    this.world = new PhysicsWorld(
      straightSeg(cfg.railX0, cfg.railY, cfg.railX1, cfg.railY, { endBuffered: true }),
    );
    this.world.addBody({
      id: 'T',
      kind: 'loco',
      railPos: cfg.startRailPos,
      facing: 1,
      motion: 'forward',
      color: '#c0392b',
      /* Gentle power + a modest cap so the pass is unhurried and reads clearly. */
      power: 260,
      maxSpeed: 150,
    });
    /* The in-tunnel camera looks at the COVERED midpoint of the roof. Its sample
     *  is occluded by a dark tunnel (the predicate), so it stays blind there. */
    this.camera = physicsCameraProvider(
      this.world,
      {
        x: (cfg.tunnel.x0 + cfg.tunnel.x1) / 2,
        y: cfg.railY,
        radiusMm: cfg.cameraRadiusMm ?? DEFAULT_CAMERA_RADIUS,
      },
      darkTunnelOcclusion([cfg.tunnel]),
    );
    /* Entry + exit marker tripwires at the two portal faces. */
    this.markers = [
      { id: 'entry', x: cfg.tunnel.x0, fired: false },
      { id: 'exit', x: cfg.tunnel.x1, fired: false },
    ];
  }

  /** Advance one fixed physics step: run the rail, fire any portal markers the
   *  loco crossed, and poll the in-tunnel camera. */
  step(dtS: number): void {
    this.world.step(dtS);
    const x = this.locoX();
    if (x !== null) {
      this.fireMarkers(x);
      this.prevX = x;
    }
    if (this.camera.perceive().occupied) this.sawInside = true;
  }

  /** Fire any marker whose x the loco crossed (moving +x) this step. */
  private fireMarkers(x: number): void {
    if (this.prevX === null) return;
    const prev = this.prevX;
    for (const m of this.markers) {
      if (!m.fired && prev < m.x && x >= m.x) {
        m.fired = true;
        this.markerLog.push(m.id);
      }
    }
  }

  private locoX(): number | null {
    const t = this.world.bodies().find((b) => b.id === 'T');
    return t === undefined ? null : t.x;
  }

  /** The marker ids fired so far, in crossing order (entry, then exit). */
  firedMarkers(): readonly string[] {
    return [...this.markerLog];
  }

  /** Whether the in-tunnel camera ever saw a body under the roof: false for a
   *  dark tunnel (blind), true for a lit one. */
  cameraSawInside(): boolean {
    return this.sawInside;
  }

  /** The tunnel being run (for the view's geometry / the harness). */
  tunnel(): Tunnel {
    return this.cfg.tunnel;
  }

  /** The authoritative world (for body poses). */
  physicsWorld(): PhysicsWorld {
    return this.world;
  }
}
