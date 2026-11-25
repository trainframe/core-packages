import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Layout } from '@trainframe/protocol';
import { type PhysicsEnv, startPhysicsEnv } from '@trainframe/simulator/physics-env.js';
import { compileNetwork } from '@trainframe/simulator/physics/network-from-pieces.js';
import { compileLayout } from '@trainframe/simulator/track/layout-from-pieces.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Learn track's switch throws run through the scheduler's `controls_switch`
 * hooks, so an unconfirmed throw is re-sent and flagged like a routed one.
 * The real operator layout, with switches whose motors never answer.
 */

const FIXTURE_PATH = resolve(import.meta.dirname, '__fixtures__', 'test-track-layout.json');

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

  /* Real switch device per junction (the physics switch id IS the junction marker
   *  id, so one throw drives both the logical and physical views). */
  for (const j of JUNCTIONS) {
    const sw = env.spawnSwitch(j.device, {
      junctionMarkerId: j.marker,
      switchLabel: j.marker,
      positions: ['main', 'divert'],
    });
    /* A switch whose motor never answers: it stays registered but ignores commands. */
    sw.stop();
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

describe('LearnMode switch throws use the controls_switch actuation path', () => {
  it('re-sends an unconfirmed throw after the timeout and flags it, like a routed throw', () => {
    env.advance(500);
    env.client.publish('railway/operator/learn_track_start', encode({}));
    env.advance(60_000);

    const j = JUNCTIONS[0];
    const throws = env
      .commandsFor(j.device)
      .filter((c) => c.command_type === 'set_switch_position' && c.payload.position === 'main');
    expect(throws.length, 'throw re-sent while unconfirmed').toBeGreaterThanOrEqual(2);
    const flagged = env
      .eventsOfType('anomaly')
      .some((e) => String(e.payload.description).includes('did not confirm'));
    expect(flagged, 'overdue throw flagged').toBe(true);
  });
});
