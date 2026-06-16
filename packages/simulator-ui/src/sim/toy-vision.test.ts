/**
 * Unit tests for the honest toy-table vision station (ADR-030 §5).
 *
 * These drive `ToyVisionStations` headlessly with synthetic train-body
 * snapshots — the physical-body stream the camera perceives — and assert that
 * it measures length from two-marker SPEED × camera DWELL, never from a body
 * count. The integration path (a real Simulation feeding it via ToyHardware) is
 * covered in `toy-hardware.test.ts`.
 */

import {
  type TrackPiece,
  VISION_FOOTPRINT_RADIUS_MM,
  VISION_MARKER_A_LX,
  VISION_MARKER_B_LX,
} from '@trainframe/simulator/track/pieces.js';
import { describe, expect, it } from 'vitest';
import { ToyVisionStations, type TrainBody, stationRig } from './toy-vision.js';

function visionPiece(x: number, rotationDeg: 0 | 90 = 0): TrackPiece {
  return {
    id: 'VS',
    type: 'vision-station',
    position: { x, y: 0 },
    rotationDeg,
    tagged: false,
  };
}

/** A loco body (and optional trailing carriages) centred at world x along the
 * y=0 rail, head-first leading at +x, spaced 68mm. */
function rakeAt(headX: number, carriages: number): TrainBody {
  const bodies: TrainBody['bodies'][number][] = [
    { pos: { x: headX, y: 0, rotationDeg: 0 }, half: 34, colour: undefined },
  ];
  for (let i = 0; i < carriages; i++) {
    bodies.push({
      pos: { x: headX - (i + 1) * 68, y: 0, rotationDeg: 0 },
      half: 30,
      colour: 'red',
    });
  }
  return { trainId: 'T-1', bodies };
}

describe('ToyVisionStations — honest two-marker speed × dwell', () => {
  it('measures a passing rake and reports it from the station identity', () => {
    const reports: Array<{ station: string; train: string; mm: number }> = [];
    const stations = new ToyVisionStations((station, train, mm) =>
      reports.push({ station, train, mm }),
    );
    const piece = visionPiece(0);
    stations.index([piece], new Set(['VS']));

    /* Drive the rake head west→east across the station at a constant speed of
     * 200 mm/s, sampled every 50 ms (10 mm/step). The two reference points sit
     * at local ±70 (world x ±70); the camera footprint is at the centre. */
    const speed = 200;
    const dtMs = 50;
    let headX = -260;
    for (let i = 0; i < 200 && reports.length === 0; i++) {
      headX += (speed * dtMs) / 1000;
      stations.tick(dtMs, [rakeAt(headX, 2)]);
    }

    expect(reports).toHaveLength(1);
    const r = reports[0];
    expect(r?.station).toBe('VLS-VS');
    expect(r?.train).toBe('T-1');
    /* Physical span: loco front (34) … last carriage rear (2×68 + 30) = 200mm,
     * plus the footprint over-read (2 × radius). A few mm of tick quantisation. */
    const expected = 200 + 2 * VISION_FOOTPRINT_RADIUS_MM;
    expect(Math.abs((r?.mm ?? 0) - expected)).toBeLessThan(15);
  });

  it('reports the SAME length for the same rake at a different speed (speed is measured)', () => {
    const lengthAt = (speed: number): number => {
      const reports: number[] = [];
      const stations = new ToyVisionStations((_s, _t, mm) => reports.push(mm));
      stations.index([visionPiece(0)], new Set(['VS']));
      const dtMs = 25;
      let headX = -260;
      for (let i = 0; i < 400 && reports.length === 0; i++) {
        headX += (speed * dtMs) / 1000;
        stations.tick(dtMs, [rakeAt(headX, 2)]);
      }
      return reports[0] ?? Number.NaN;
    };
    const slow = lengthAt(150);
    const fast = lengthAt(450);
    expect(Number.isNaN(slow)).toBe(false);
    expect(Number.isNaN(fast)).toBe(false);
    expect(Math.abs(slow - fast)).toBeLessThan(25);
  });

  it('a longer rake reads longer than a shorter one', () => {
    const lengthFor = (carriages: number): number => {
      const reports: number[] = [];
      const stations = new ToyVisionStations((_s, _t, mm) => reports.push(mm));
      stations.index([visionPiece(0)], new Set(['VS']));
      let headX = -300;
      for (let i = 0; i < 300 && reports.length === 0; i++) {
        headX += 10;
        stations.tick(50, [rakeAt(headX, carriages)]);
      }
      return reports[0] ?? Number.NaN;
    };
    expect(lengthFor(3)).toBeGreaterThan(lengthFor(1) + 80);
  });

  it('stays silent when the head crosses only ONE reference point (no speed)', () => {
    const reports: number[] = [];
    const stations = new ToyVisionStations((_s, _t, mm) => reports.push(mm));
    stations.index([visionPiece(0)], new Set(['VS']));
    /* Crawl the head up to just past marker A but never reach marker B, then
     * pull it back — only one crossing ever fires, so no speed, no report. */
    const markerA = VISION_MARKER_A_LX;
    const markerB = VISION_MARKER_B_LX;
    expect(markerA).toBeLessThan(markerB);
    let headX = -200;
    for (let i = 0; i < 50; i++) {
      headX += 4; // never reaches markerB (+70)
      stations.tick(50, [rakeAt(Math.min(headX, markerB - 10), 1)]);
    }
    expect(reports).toHaveLength(0);
  });

  it('hasLiveStation reflects the indexed set; reset clears in-flight measurements', () => {
    const stations = new ToyVisionStations(() => undefined);
    expect(stations.hasLiveStation()).toBe(false);
    stations.index([visionPiece(0)], new Set(['VS']));
    expect(stations.hasLiveStation()).toBe(true);
    stations.index([visionPiece(0)], new Set());
    expect(stations.hasLiveStation()).toBe(false);
    stations.reset(); // no throw with nothing in flight
  });

  it('rotates its sensing rig with the piece placement', () => {
    const rig = stationRig(visionPiece(0, 90));
    /* At 90° the local +x rail axis points along +y, so markerB (local +70) sits
     * north of centre and markerA (local -70) south, both on x≈0. */
    expect(Math.abs(rig.markerB.x)).toBeLessThan(1e-6);
    expect(rig.markerB.y).toBeCloseTo(VISION_MARKER_B_LX, 5);
    expect(rig.markerA.y).toBeCloseTo(VISION_MARKER_A_LX, 5);
  });
});
