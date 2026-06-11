/**
 * The vision station, done honestly (ADR-030 §5).
 *
 * A fixed two-marker camera that measures a passing train's LENGTH without any
 * train self-reporting and without reading the simulator's ground-truth consist.
 *
 * The retcon in ADR-030 is the crux: a train knows only its motion state
 * (forward / stopped / reversing) — NOT its speed or metric position. So a fixed
 * camera alone yields only a DWELL time, never a length. The station therefore
 * measures speed itself, from its own two markers a known baseline apart:
 *
 *     speed  = baseline ÷ (interval between the two marker crossings)
 *     length = speed × dwell
 *
 * where `dwell` is the time the camera reported `occupied` as the train passed.
 *
 * The device is a pure event-loop controller over a virtual clock:
 *   - `tick(dtS)` polls the CameraProvider each step and integrates dwell;
 *   - `onMarkerCrossed(markerId, timestampS)` feeds the two crossing times;
 *   - when the train has CLEARED (occupied → not, after having been occupied) and
 *     a speed has been measured, it reports `length` via the injected callback.
 *
 * No DOM, no I/O, no clock of its own — time arrives via tick/marker timestamps.
 * It perceives the world ONLY through its CameraProvider.
 */

import type { CameraProvider } from './camera-provider.js';

export interface VisionStationConfig {
  /** The two marker ids the station owns, a known distance apart. */
  readonly markerA: string;
  readonly markerB: string;
  /** Baseline distance (mm) between markerA and markerB. */
  readonly baselineMm: number;
  /** The camera the station perceives its stretch of line through. */
  readonly camera: CameraProvider;
  /** Called once per cleared train with the measured length (mm). */
  readonly onLength: (lengthMm: number) => void;
}

export class VisionStation {
  private readonly cfg: VisionStationConfig;

  /** Accumulated time (s) the camera has reported `occupied` for this pass. */
  private dwellS = 0;
  /** Whether the camera reported `occupied` on the previous tick. */
  private wasOccupied = false;

  /** Crossing timestamps for the two markers within the current pass. */
  private crossA: number | undefined;
  private crossB: number | undefined;

  constructor(cfg: VisionStationConfig) {
    this.cfg = cfg;
  }

  /** Speed (mm/s) measured from the two crossings, or undefined until both seen. */
  private measuredSpeed(): number | undefined {
    if (this.crossA === undefined || this.crossB === undefined) return undefined;
    const interval = Math.abs(this.crossB - this.crossA);
    if (interval <= 0) return undefined;
    return this.cfg.baselineMm / interval;
  }

  /** Feed one of the station's two marker crossings (others are ignored). */
  onMarkerCrossed(markerId: string, timestampS: number): void {
    if (markerId === this.cfg.markerA) this.crossA = timestampS;
    else if (markerId === this.cfg.markerB) this.crossB = timestampS;
  }

  /** Advance the event loop by `dtS`: poll the camera, integrate dwell, and emit
   *  a length when a train clears with a measured speed. */
  tick(dtS: number): void {
    const occupied = this.cfg.camera.perceive().occupied;
    if (occupied) {
      this.dwellS += dtS;
      this.wasOccupied = true;
      return;
    }
    if (this.wasOccupied) this.onCleared();
  }

  /** The train just left the footprint: derive and report its length, if we can. */
  private onCleared(): void {
    const speed = this.measuredSpeed();
    if (speed !== undefined && this.dwellS > 0) {
      this.cfg.onLength(speed * this.dwellS);
    }
    this.reset();
  }

  /** Clear per-pass state so the station is ready for the next train. */
  private reset(): void {
    this.dwellS = 0;
    this.wasOccupied = false;
    this.crossA = undefined;
    this.crossB = undefined;
  }
}
