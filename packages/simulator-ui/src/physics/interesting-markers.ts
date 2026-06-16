/**
 * The SPARSE marker layer + station→station routes for the interesting layout
 * (`interesting-layout.ts`). Markers sit only where the scheduler needs them: the two
 * satellite junctions + a STATION on each satellite loop, the yard junction, and a
 * couple of running-line stations. Operators route STATION → STATION; different trains
 * target different satellite stations (only some trains visit each).
 *
 * Reuses the railyard `Layout` compiler — same marker model, same projection of the
 * opaque physics network onto the logical marker graph. Pure: positions from `rail.at`.
 */
import type { Layout } from '@trainframe/protocol';
import type { MainLoopScene } from './interesting-layout.js';
import type { SceneJunction, SceneMarker } from './markers.js';
import { type EdgeSpec, type RailyardMarkerLayer, railyardToLayout } from './railyard-markers.js';

/** The interesting layout's marker ids (internal/demo names — operators see stations). */
export const INTERESTING_MARKERS = {
  north: 'M-north',
  south: 'M-south',
  satA: 'M-satA-jn',
  satAStation: 'M-satA',
  satB: 'M-satB-jn',
  satBStation: 'M-satB',
  yard: 'M-yard',
} as const;

/** A train's cyclic station→station route. */
export interface DemoRoute {
  readonly trainId: string;
  readonly stops: readonly string[];
}

export interface InterestingMarkers extends RailyardMarkerLayer {
  /** Station→station routes; different trains target different satellite stations. */
  readonly routes: readonly DemoRoute[];
}

/** Build the sparse marker layer + routes for the scene. */
export function buildInterestingMarkers(scene: MainLoopScene): InterestingMarkers {
  const M = INTERESTING_MARKERS;
  const mid = (seg: string) => scene.net.railOf(seg).length / 2;
  const a = scene.branches.satA;
  const bsat = scene.branches.satB;
  const yardTap = scene.branches.yard;

  const markers: SceneMarker[] = [
    {
      id: M.north,
      segment: scene.startSegment,
      end: 'start',
      distAlongMm: mid(scene.startSegment),
      kind: 'station_stop',
    },
    { id: M.satA, segment: a.loopBranch, end: 'start', kind: 'junction' },
    {
      id: M.satAStation,
      segment: a.loop,
      end: 'start',
      distAlongMm: mid(a.loop),
      kind: 'station_stop',
    },
    { id: M.satB, segment: bsat.loopBranch, end: 'start', kind: 'junction' },
    {
      id: M.satBStation,
      segment: bsat.loop,
      end: 'start',
      distAlongMm: mid(bsat.loop),
      kind: 'station_stop',
    },
    {
      id: M.south,
      segment: 'bot-c',
      end: 'start',
      distAlongMm: mid('bot-c'),
      kind: 'station_stop',
    },
    /* The yard THROAT — the divert point on the running line (the start of the divert
     *  branch, which a circulating train crosses on the bypass and a serviced train
     *  takes into the yard). The drive-through detour sits below it. */
    { id: M.yard, segment: yardTap.branchSeg, end: 'start', kind: 'yard_entry' },
  ];

  const junctions: SceneJunction[] = [
    { markerId: M.satA, switchId: a.switchId, positions: [a.mainPos, a.loopPos] },
    { markerId: M.satB, switchId: bsat.switchId, positions: [bsat.mainPos, bsat.loopPos] },
    {
      markerId: M.yard,
      switchId: yardTap.switchId,
      positions: [yardTap.mainPos, yardTap.divertPos],
    },
  ];

  /* The running-line cycle in PHYSICAL order (the bypass a circulating train takes):
   *  north → satA → satB → yard throat → south → north. Each satellite is a diamond
   *  (junction → station → rejoin, or straight past); the yard throat sits on the
   *  bottom run BEFORE south, the drive-through yard diverting BELOW it. */
  const edges: EdgeSpec[] = [
    { from: M.north, to: M.satA },
    { from: M.satA, to: M.satB, requiresSwitch: a.mainPos }, // stay on the main
    { from: M.satA, to: M.satAStation, requiresSwitch: a.loopPos }, // divert into the loop
    { from: M.satAStation, to: M.satB },
    { from: M.satB, to: M.yard, requiresSwitch: bsat.mainPos },
    { from: M.satB, to: M.satBStation, requiresSwitch: bsat.loopPos },
    { from: M.satBStation, to: M.yard },
    { from: M.yard, to: M.south, requiresSwitch: yardTap.mainPos }, // bypass the yard
    { from: M.south, to: M.north },
    // (yard divert → the drive-through interior is the gated zone — milestone 3)
  ];

  const routes: DemoRoute[] = [
    /* Distinct station rotas — only SOME trains target each satellite station. */
    { trainId: 'T-express', stops: [M.north, M.satAStation, M.south] },
    { trainId: 'T-local', stops: [M.north, M.satBStation, M.south] },
    { trainId: 'T-shuttle', stops: [M.south, M.north] },
  ];

  return { markers, junctions, edges, throatMarker: M.yard, routes };
}

/** Compile the interesting layout to a protocol `Layout`. */
export function interestingToLayout(scene: MainLoopScene, name = 'interesting'): Layout {
  return railyardToLayout(scene.net, buildInterestingMarkers(scene), name);
}
