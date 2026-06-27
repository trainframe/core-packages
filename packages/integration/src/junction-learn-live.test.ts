import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Layout } from '@trainframe/protocol';
import { type PhysicsEnv, startPhysicsEnv } from '@trainframe/simulator/physics-env.js';
import { compileNetwork } from '@trainframe/simulator/physics/network-from-pieces.js';
import { compileLayout } from '@trainframe/simulator/track/layout-from-pieces.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE LIVE GATE (goal item 4). The operator's real saved layout — the exact
 * 29-piece `test-track-layout.json`, two junctions, three loops — learned
 * end-to-end through real seams: a real `Server` in pure discovery mode, a real
 * driving loco, and a real `SwitchDevice` per junction, all over the in-memory
 * bus. The operator presses one *Learn track* button; the server's LearnMode must
 * survey the junctions itself — throwing each switch to BOTH legs so the train
 * traverses both — learn every leg's edges, and recognise completion.
 *
 * This is the path the Part-4 unit test bypassed: it drove a DECLARED branched
 * layout (junctions + switch-state edges already present) directly into LearnMode.
 * Discovery produces neither, so the live system loops one branch forever and
 * never throws a switch — the bug this gate exists to catch. Nothing here is
 * mocked; the switch is thrown only if the server decides to.
 */

const FIXTURE_PATH = resolve(import.meta.dirname, '__fixtures__', 'test-track-layout.json');

/**
 * The two junctions, each with its THREE physical connections (the trunk plus
 * both legs), read from the compiled layout. Forward-only learning must reach
 * every one of these — that is what "learn the track" means here.
 *
 * Note on direction (a real forward-only property, not a gap we hide): a junction
 * the train meets FACING (entering from the trunk) is surveyed by throwing the
 * switch to each position and driving out onto each leg — so its directed
 * trunk->leg edges are learned (junction-3). A junction the train only ever meets
 * TRAILING (entering from a leg, merging to the trunk) has its leg TRACKS
 * traversed but cannot yield directed trunk->leg edges forward-only, because that
 * needs a facing approach = the reverse way round its loop (junction-23). The
 * gate therefore asserts full TRACK coverage of all three connections (in either
 * direction) plus both switch throws + completion — the honest ceiling of
 * forward-only learning. Directed trunk->leg edges for a trailing junction are a
 * documented follow-up (a reverse-aware pass), see ADR-035.
 */
const JUNCTIONS = [
  {
    device: 'SWITCH-junction-3',
    marker: 'M-junction-3',
    connections: ['M-straight-22', 'M-curve-4', 'M-curve-5'],
  },
  {
    device: 'SWITCH-junction-23',
    marker: 'M-junction-23',
    connections: ['M-curve-13', 'M-station-8', 'M-curve-37'],
  },
] as const;

const TRAIN = 'T1';
/** The piece the fixture's train sits on — its marker is the exploration start. */
const START_MARKER = 'M-curve-16';

const encode = (payload: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(payload));

let env: PhysicsEnv;
let learnState: string | undefined;

beforeEach(() => {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, TrackPiece>;
  const pieces = Object.values(raw);

  const compiled = compileNetwork(pieces);
  const full = compileLayout(pieces, 'fixture-live');

  /* Discovery: hand the server the markers but ZERO edges/junctions — exactly the
   *  cold layout the operator's server rebuilds from traversals. */
  const discoveryLayout: Layout = {
    name: full.name,
    markers: full.markers,
    edges: [],
    junctions: [],
  };
  const markers = full.markers.map((m) => ({
    id: m.id,
    x: m.position?.x_mm ?? 0,
    y: m.position?.y_mm ?? 0,
  }));

  env = startPhysicsEnv({ net: compiled.net, layout: discoveryLayout, markers });

  learnState = undefined;
  env.client.subscribe('railway/state/track_learning/active', (msg) => {
    try {
      const parsed = JSON.parse(new TextDecoder().decode(msg.payload)) as Record<string, unknown>;
      const snap = (parsed.payload ?? parsed) as { state?: string };
      if (typeof snap.state === 'string') learnState = snap.state;
    } catch {
      /* ignore non-JSON */
    }
  });

  /* Real switch device per junction (the physics switch id IS the junction marker
   *  id, so one throw drives both the logical and physical views). */
  for (const j of JUNCTIONS) {
    env.spawnSwitch(j.device, {
      junctionMarkerId: j.marker,
      switchLabel: j.marker,
      positions: ['main', 'divert'],
    });
  }

  /* Real driving loco on the segment carrying its start marker. */
  const seg = compiled.segmentsForPiece.get('curve-16')?.[0];
  if (seg === undefined) throw new Error('no segment for the train start piece curve-16');
  /* ADR-036: discovery layout has no edges, so heading cannot be derived.
   * The vector is established via the learn-track exploration roll (§3a). */
  env.spawnTrain(TRAIN, {
    atMarker: START_MARKER,
    segment: seg,
    railPos: 30,
    facing: 1,
    introduced: false,
  });
});

afterEach(() => {
  env.shutdown();
});

describe('THE LIVE GATE — junctions learned on the operator real layout', () => {
  it('surveys both legs of both junctions, learns every leg, and completes', () => {
    /* Let registrations (train + switches) reach the scheduler and the loco sense
     *  its first marker, then the single operator gesture. */
    env.advance(500);
    env.client.publish('railway/operator/learn_track_start', encode({}));

    /* The loco explores autonomously; LearnMode must throw the junctions to reach
     *  the diverging legs. Generous slack for a multi-loop survey. */
    env.advance(180_000);

    const ls = env.server.getLayoutState();
    const threw = (device: string, position: string): boolean =>
      env
        .commandsFor(device)
        .some((c) => c.command_type === 'set_switch_position' && c.payload.position === position);
    /** Every marker the learned graph connects to `junction` (either direction). */
    const neighbours = (junction: string): Set<string> =>
      new Set([
        ...ls.edgesFrom(junction).map((e) => e.to_marker_id),
        ...ls.edgesInto(junction).map((e) => e.from_marker_id),
      ]);

    for (const j of JUNCTIONS) {
      /* The server surveyed the junction: it threw the points to BOTH positions
         itself (no one threw them for it) — the bug was zero throws ever. */
      expect(threw(j.device, 'main'), `${j.device} thrown to main`).toBe(true);
      expect(threw(j.device, 'divert'), `${j.device} thrown to divert`).toBe(true);
      /* Forward-only learning reached every one of the junction's three physical
         connections — trunk + both legs — so no leg is left unexplored. */
      const learned = neighbours(j.marker);
      for (const connection of j.connections) {
        expect(
          learned.has(connection),
          `${j.marker} connection ${connection} learned (have: ${[...learned].join(', ')})`,
        ).toBe(true);
      }
    }

    /* The survey reached completion (not stuck mid-drive) AND covered the whole
       reachable component — 27 of 28 markers (the 28th, M-curve-2, is the stray
       disconnected piece in the operator's layout), never just one branch. */
    const visited = new Set(
      env.eventsOfType('marker_traversed').map((e) => String(e.payload.marker_id)),
    );
    expect(learnState, 'track_learning reaches complete').toBe('complete');
    expect(
      visited.size,
      'whole reachable component explored, not one branch',
    ).toBeGreaterThanOrEqual(27);
  });
});
