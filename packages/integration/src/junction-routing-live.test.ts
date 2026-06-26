import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Layout } from '@trainframe/protocol';
import { type PhysicsEnv, startPhysicsEnv } from '@trainframe/simulator/physics-env.js';
import { compileNetwork } from '@trainframe/simulator/physics/network-from-pieces.js';
import { compileLayout } from '@trainframe/simulator/track/layout-from-pieces.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE LIVE GATE for bug 3 (operator, real 2-loop layout): "if a train was on the
 * outer loop and needed to go round to the inner-loop station, it got stuck at
 * the junction rather than continuing round to catch the inner station from the
 * other side."
 *
 * Root cause was in the planner (Dijkstra keyed by marker, not by
 * (marker, arrival) — see junction-routing.test.ts / planner.test.ts): a
 * standing train has no heading, so `planTransit` ran the heading-free search,
 * which falsely returned `null`, and the scheduler parked the train with a
 * "no path" anomaly. This drives the WHOLE real stack — physics world + the
 * real `@trainframe/server` scheduler + a real switch device per junction —
 * spawns the outer-loop train STOPPED (no heading), schedules it to the inner
 * station, and asserts it actually gets there: it must traverse the inner
 * station's marker, and the scheduler must NOT raise "no path".
 */
const FIXTURE = resolve(import.meta.dirname, '__fixtures__', '2-looped-track.json');
const TRAIN = 'T1';
const START_MARKER = 'M-curve-2';
const START_PIECE = 'curve-2';
/** railPos that seats the body squarely on M-curve-2's sensor (so it self-reports
 *  its start marker while stopped) facing along the outer loop. */
const START_RAILPOS = 80;
const INNER_STATION = 'M-station-23';
/** The junction whose diverging leg the route round takes onto the inner loop —
 *  the scheduler must throw its points for the train to leave the outer loop. */
const DIVERT_JUNCTION = 'M-junction-3';
const JUNCTIONS = ['M-junction-1', 'M-junction-3'] as const;

let env: PhysicsEnv;

beforeEach(() => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, TrackPiece>;
  const pieces = Object.values(raw);
  const compiled = compileNetwork(pieces);
  /* The FULL compiled layout (edges + junctions) — this is a routing test, not a
   *  learning one: the scheduler must plan over the known graph. */
  const layout: Layout = compileLayout(pieces, '2loop');
  const markers = layout.markers.map((m) => ({
    id: m.id,
    x: m.position?.x_mm ?? 0,
    y: m.position?.y_mm ?? 0,
  }));

  env = startPhysicsEnv({ net: compiled.net, layout, markers });

  for (const marker of JUNCTIONS) {
    env.spawnSwitch(`SW-${marker}`, {
      junctionMarkerId: marker,
      switchLabel: marker,
      positions: ['main', 'divert'],
    });
  }

  const seg = compiled.segmentsForPiece.get(START_PIECE)?.[0];
  if (seg === undefined) throw new Error(`no segment for start piece ${START_PIECE}`);
  env.spawnTrain(TRAIN, {
    atMarker: START_MARKER,
    segment: seg,
    railPos: START_RAILPOS,
    facing: 1,
  });
});

afterEach(() => {
  env.shutdown();
});

describe('THE LIVE GATE — outer-loop train routes round to the inner station', () => {
  it('reaches the inner station instead of stalling at the junction', () => {
    /* Let the train register and sense its start marker (still STOPPED — default
     *  clearance is safe/stopped, so it has no heading when scheduled). */
    env.advance(500);
    env.assignSchedule(TRAIN, [INNER_STATION]);

    const reached = (): boolean =>
      env.eventsOfType('marker_traversed').some((e) => e.payload.marker_id === INNER_STATION);

    /* Pump in chunks until it arrives (a generous cap for a full lap round the
     *  far side of the layout). */
    for (let i = 0; i < 40 && !reached(); i++) env.advance(5_000);

    const anomalies = env
      .eventsOfType('anomaly')
      .map((e) => String(e.payload.description))
      .filter((d) => d.includes('no path'));
    const threwDivert = env
      .commandsFor(`SW-${DIVERT_JUNCTION}`)
      .some((c) => c.command_type === 'set_switch_position' && c.payload.position === 'divert');

    expect(anomalies, 'scheduler must not park the train with a "no path" anomaly').toEqual([]);
    expect(reached(), 'train traverses the inner station the long way round').toBe(true);
    expect(threwDivert, 'scheduler threw the junction onto the inner loop for the route').toBe(
      true,
    );
  });
});
