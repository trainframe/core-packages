/**
 * The toy-table vision length station (ADR-030 §5), measuring PHYSICS BODIES.
 *
 * The legacy toy-table cheated: it read the simulator's ground-truth consist
 * (`train.getConsist().length`) and published that as the wire length. That could
 * never port to real hardware, where a fixed camera cannot read a train's makeup
 * off a manifest — it only sees a blob pass beneath it.
 *
 * This drives the SAME honest device as the physics-scenario view: a real
 * `VisionStation` (`sensors/vision-station.ts`). The station owns two sensing
 * reference points a fixed baseline apart and a camera footprint between them
 * (geometry in `pieces.ts`). As a train's HEAD crosses the two reference points it
 * measures speed = baseline ÷ crossing-interval; the camera integrates the dwell
 * the train's body covers the footprint; length = speed × dwell. No train
 * self-report, no consist read for the wire length.
 *
 * The honest sensor inputs are the toy-table's PHYSICS BODIES — exactly the poses
 * the `PhysicsWorld` reports via `world.bodies()` and the renderer draws. The owner
 * (`ToyHardware`) snapshots each live train's loco + coupled carriage bodies and
 * feeds them in via `tick`. The camera reports `occupied` while any body covers the
 * footprint; the head's crossings of the two reference points give the speed. The
 * consist is read ONLY as a physical body (its count + livery a camera sees), never
 * as the length put on the wire.
 *
 * DOM-free and unit-testable headless: time arrives via `tick`, positions via a
 * `TrainBody` snapshot — no dependency on any `Simulation` or `PhysicsWorld`.
 */

import type {
  CameraPerception,
  CameraProvider,
} from '@trainframe/simulator/sensors/camera-provider.js';
import { VisionStation } from '@trainframe/simulator/sensors/vision-station.js';
import {
  type TrackPiece,
  VISION_BASELINE_MM,
  VISION_FOOTPRINT_RADIUS_MM,
  VISION_MARKER_A_LX,
  VISION_MARKER_B_LX,
  transformPoint,
} from '@trainframe/simulator/track/pieces.js';

/** One physical body the camera can perceive: its world centre, half-extent along
 *  the rail (mm), and livery (if any). A loco is ~68 mm long, a carriage ~60 mm. */
export interface VisionBody {
  readonly pos: { readonly x: number; readonly y: number; readonly rotationDeg: number };
  readonly half: number;
  readonly colour: string | undefined;
}

/** A live train as the camera perceives it: its loco head plus coupled carriages,
 *  head-first, each a physical body at a world position. */
export interface TrainBody {
  readonly trainId: string;
  readonly bodies: ReadonlyArray<VisionBody>;
}

/** The station's two world reference points + footprint centre, derived from its
 *  placement (local x along the rail, rotated into world space). */
interface StationRig {
  readonly markerA: WorldPosition2D;
  readonly markerB: WorldPosition2D;
  readonly footprint: WorldPosition2D;
}

interface WorldPosition2D {
  readonly x: number;
  readonly y: number;
}

/** Resolve a vision-station piece's sensing rig in world space. */
export function stationRig(piece: TrackPiece): StationRig {
  const a = transformPoint(
    VISION_MARKER_A_LX,
    0,
    piece.rotationDeg,
    piece.position.x,
    piece.position.y,
  );
  const b = transformPoint(
    VISION_MARKER_B_LX,
    0,
    piece.rotationDeg,
    piece.position.x,
    piece.position.y,
  );
  const footprint = transformPoint(0, 0, piece.rotationDeg, piece.position.x, piece.position.y);
  return { markerA: a, markerB: b, footprint };
}

/**
 * A camera that perceives a single train body snapshot at a fixed footprint — the
 * toy-table analogue of `physicsCameraProvider`. `occupied` is true while any of the
 * train's physical bodies covers the footprint; the nearest body's livery wins,
 * exactly as one fixed sensor resolves overlapping blobs.
 */
function snapshotCamera(
  footprint: WorldPosition2D,
  radiusMm: number,
  body: () => TrainBody | undefined,
): CameraProvider {
  return {
    perceive(): CameraPerception {
      const tb = body();
      if (tb === undefined) return { occupied: false };
      let nearest: { gap: number; colour: string | undefined } | undefined;
      for (const b of tb.bodies) {
        const gap = Math.hypot(b.pos.x - footprint.x, b.pos.y - footprint.y);
        const reach = b.half + radiusMm;
        if (gap <= reach && (nearest === undefined || gap < nearest.gap)) {
          nearest = { gap, colour: b.colour };
        }
      }
      if (nearest === undefined) return { occupied: false };
      return nearest.colour === undefined
        ? { occupied: true }
        : { occupied: true, colour: nearest.colour };
    },
  };
}

/** Scalar position of a point projected onto the station's A→B axis (mm), so a head
 *  crossing each reference is a clean monotonic threshold regardless of the piece's
 *  rotation. markerA projects to 0, markerB to the baseline length. */
function projectOntoAxis(rig: StationRig, p: WorldPosition2D): number {
  const ax = rig.markerB.x - rig.markerA.x;
  const ay = rig.markerB.y - rig.markerA.y;
  const len = Math.hypot(ax, ay);
  if (len === 0) return 0;
  const ux = ax / len;
  const uy = ay / len;
  return (p.x - rig.markerA.x) * ux + (p.y - rig.markerA.y) * uy;
}

/**
 * One honest measurement of a single train at a single station. Wraps a real
 * `VisionStation`, feeding it the two head crossings (detected by the head's
 * projection passing each reference along the axis) and the camera dwell. A crossing
 * fires in EITHER axis direction so a train passing from either end is measured. Once
 * both crossings and a dwell are in, the `VisionStation` reports.
 */
class TrainMeasurement {
  private readonly rig: StationRig;
  private readonly station: VisionStation;
  private currentBody: TrainBody | undefined;
  private prevProj: number | undefined;
  private crossedA = false;
  private crossedB = false;

  constructor(rig: StationRig, onLength: (mm: number) => void) {
    this.rig = rig;
    this.station = new VisionStation({
      markerA: 'A',
      markerB: 'B',
      baselineMm: VISION_BASELINE_MM,
      camera: snapshotCamera(rig.footprint, VISION_FOOTPRINT_RADIUS_MM, () => this.currentBody),
      onLength: (mm) => {
        /* The VisionStation resets its own per-pass state after reporting; clear ours
         *  too so the SAME train measured again on a later pass re-fires. */
        this.crossedA = false;
        this.crossedB = false;
        onLength(mm);
      },
    });
  }

  /** Advance by `dtS`, given the train's latest body snapshot (or undefined if the
   *  train is gone) and the absolute sim timestamp (s). */
  step(dtS: number, body: TrainBody | undefined, timestampS: number): void {
    this.currentBody = body;
    const head = body?.bodies[0]?.pos;
    if (head !== undefined) {
      const proj = projectOntoAxis(this.rig, head);
      if (this.prevProj !== undefined) {
        if (!this.crossedA && crossedThreshold(this.prevProj, proj, 0)) {
          this.station.onMarkerCrossed('A', timestampS);
          this.crossedA = true;
        }
        if (!this.crossedB && crossedThreshold(this.prevProj, proj, VISION_BASELINE_MM)) {
          this.station.onMarkerCrossed('B', timestampS);
          this.crossedB = true;
        }
      }
      this.prevProj = proj;
    }
    this.station.tick(dtS);
  }
}

/** True when the scalar moved across `threshold` between `prev` and `now`, in either
 *  direction (a train may pass the station from either end). */
function crossedThreshold(prev: number, now: number, threshold: number): boolean {
  return (prev < threshold && now >= threshold) || (prev > threshold && now <= threshold);
}

/**
 * Drives the honest `VisionStation` for every live vision-station piece against the
 * live trains, one measurement per (station, train) pair. The owner (`ToyHardware`)
 * calls `tick` each frame with the elapsed sim time and the live train bodies
 * (sampled from the `PhysicsWorld`); reported lengths arrive via
 * `onLength(stationDeviceId, trainId, lengthMm)`.
 */
export class ToyVisionStations {
  private readonly onLength: (stationDeviceId: string, trainId: string, lengthMm: number) => void;
  /* Per-station rig + per-train measurement, keyed `${stationId}|${trainId}`. */
  private rigs = new Map<string, StationRig>();
  private stationDeviceIds = new Map<string, string>();
  private measurements = new Map<string, TrainMeasurement>();
  private elapsedS = 0;

  constructor(onLength: (stationDeviceId: string, trainId: string, lengthMm: number) => void) {
    this.onLength = onLength;
  }

  /** Re-index the live vision stations from the placed pieces + live set. Drops
   *  measurements for stations that are gone. */
  index(pieces: ReadonlyArray<TrackPiece>, liveIds: ReadonlySet<string>): void {
    const rigs = new Map<string, StationRig>();
    const deviceIds = new Map<string, string>();
    for (const p of pieces) {
      if (p.type === 'vision-station' && liveIds.has(p.id)) {
        rigs.set(p.id, stationRig(p));
        deviceIds.set(p.id, `VLS-${p.id}`);
      }
    }
    this.rigs = rigs;
    this.stationDeviceIds = deviceIds;
    for (const key of [...this.measurements.keys()]) {
      const stationId = key.split('|')[0];
      if (stationId === undefined || !rigs.has(stationId)) this.measurements.delete(key);
    }
  }

  /** Whether any vision station is currently live (so the owner knows whether to pay
   *  the per-sub-step body-snapshot cost). */
  hasLiveStation(): boolean {
    return this.rigs.size > 0;
  }

  /** The world was rebuilt: its clock + event stream start over, so reset. */
  reset(): void {
    this.measurements.clear();
    this.elapsedS = 0;
  }

  /** Advance every station's measurement of every live train by `dtMs`. */
  tick(dtMs: number, bodies: ReadonlyArray<TrainBody>): void {
    if (this.rigs.size === 0) return;
    const dtS = dtMs / 1000;
    this.elapsedS += dtS;
    const bodyByTrain = new Map<string, TrainBody>();
    for (const b of bodies) bodyByTrain.set(b.trainId, b);

    for (const [stationId, rig] of this.rigs) {
      const deviceId = this.stationDeviceIds.get(stationId);
      if (deviceId === undefined) continue;
      for (const b of bodies) {
        const key = `${stationId}|${b.trainId}`;
        let m = this.measurements.get(key);
        if (m === undefined) {
          const trainId = b.trainId;
          m = new TrainMeasurement(rig, (mm) => this.onLength(deviceId, trainId, mm));
          this.measurements.set(key, m);
        }
        m.step(dtS, bodyByTrain.get(b.trainId), this.elapsedS);
      }
    }
  }
}
