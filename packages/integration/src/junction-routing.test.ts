import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { LayoutState, planTransit } from '@trainframe/core';
import { compileLayout } from '@trainframe/simulator/track/layout-from-pieces.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { describe, expect, it } from 'vitest';

/**
 * Bug (operator, on the real 2-loop layout): a train on the OUTER loop routed to
 * the INNER-loop station got STUCK at the junction "rather than continuing round
 * to catch the inner station from the other side." Root cause: `planTransit`'s
 * Dijkstra keyed its search state by MARKER alone, but the legal moves out of a
 * junction depend on HOW the train ARRIVED (the leg-to-leg bar). So the search
 * could settle a junction via the cheapest arrival — one that BARS the exit the
 * route needs — and never explore a costlier arrival that ALLOWS it, returning
 * `null` (no route) even though a forward path round exists.
 */
const FIXTURE = resolve(import.meta.dirname, '__fixtures__', '2-looped-track.json');

function layout(): LayoutState {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, TrackPiece>;
  const pieces = Array.isArray(raw) ? raw : Object.values(raw);
  return new LayoutState(compileLayout(pieces, '2loop'), { now: () => 0 });
}

describe('junction routing — a forward path round is found (no false dead-end)', () => {
  it('routes an outer-loop marker to the inner-loop station the long way round', () => {
    const ls = layout();
    // Outer-loop marker → inner-loop station. A forward path exists (the planner
    // with a heading finds a ~20-edge route round); the heading-free plan must
    // find one too, not return null.
    const route = planTransit(ls, 'M-curve-2', 'M-station-23', undefined);
    expect(route, 'a forward route to the inner station exists — must not be null').not.toBeNull();
    expect(route?.[route.length - 1]?.to_marker_id).toBe('M-station-23');
  });

  it('still finds the route when the train has a heading (arrived via an edge)', () => {
    const ls = layout();
    const route = planTransit(ls, 'M-curve-2', 'M-station-23', {
      from_marker_id: 'M-curve-1',
      to_marker_id: 'M-curve-2',
    });
    expect(route).not.toBeNull();
    expect(route?.[route.length - 1]?.to_marker_id).toBe('M-station-23');
  });
});
