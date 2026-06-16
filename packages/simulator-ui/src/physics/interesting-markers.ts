/**
 * The marker layer + station→station routes for the interesting layout
 * (`interesting-layout.ts`). Markers sit where the scheduler needs them: the two
 * satellite junctions + a STATION on each satellite loop, the yard junction, four
 * cardinal running-line stations, and a few plain BLOCK boundaries that split the long
 * sections so four trains have the line capacity to circulate without saturating into a
 * waits-for deadlock. Operators route STATION → STATION; different trains target
 * different satellite stations (only some trains visit each).
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
  east: 'M-east',
  south: 'M-south',
  west: 'M-west',
  satA: 'M-satA-jn',
  satAStation: 'M-satA',
  satB: 'M-satB-jn',
  satBStation: 'M-satB',
  /** The yard DIVERT junction on the running line — circulating trains cross it on the
   *  bypass; a visitor is switched off here into the yard. */
  yardJn: 'M-yard-jn',
  /** The yard ZONE THROAT — a marker on the yard's own approach lead, reached ONLY by a
   *  train switched into the yard. A train whose route terminates here is handed to the
   *  `gates_zone` device for service; circulating trains never reach it. */
  yard: 'M-yard',
  /* Intermediate BLOCK markers (no stop, no junction) that split the long running-line
   *  sections into shorter blocks. A single-track ring grants clearance per marker, so
   *  N trains need more than N markers of slack or they saturate into a waits-for cycle
   *  (every marker a head or a tail). These extra block boundaries raise line capacity —
   *  the real-railway fix — so four trains circulate live. One per long section. */
  blkAB: 'M-blk-ab', // satA → satB (on the top-b run)
  blkEY1: 'M-blk-ey1', // east → yard (on the right semicircle)
  blkEY2: 'M-blk-ey2', // east → yard (on the bottom approach run)
  blkWN: 'M-blk-wn', // west → north (on the left semicircle)
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
      id: M.east,
      segment: 'top-c',
      end: 'start',
      distAlongMm: mid('top-c'),
      kind: 'station_stop',
    },
    {
      id: M.south,
      segment: 'bot-c',
      end: 'start',
      distAlongMm: mid('bot-c'),
      kind: 'station_stop',
    },
    {
      id: M.west,
      segment: 'bot-d',
      end: 'start',
      distAlongMm: mid('bot-d'),
      kind: 'station_stop',
    },
    /* Block boundaries (kind `unspecified`) on the long through-segments. */
    { id: M.blkAB, segment: 'top-b', end: 'start', distAlongMm: mid('top-b'), kind: 'unspecified' },
    {
      id: M.blkEY1,
      segment: 'semi-r',
      end: 'start',
      distAlongMm: mid('semi-r'),
      kind: 'unspecified',
    },
    {
      id: M.blkEY2,
      segment: 'bot-a',
      end: 'start',
      distAlongMm: mid('bot-a'),
      kind: 'unspecified',
    },
    {
      id: M.blkWN,
      segment: 'semi-l',
      end: 'start',
      distAlongMm: mid('semi-l'),
      kind: 'unspecified',
    },
    /* The DIVERT junction on the running line (the start of the divert branch, where the
     *  bypass and the into-yard branch split). A circulating train crosses it on the
     *  bypass; the scheduler throws it to `divert` to send a visitor into the yard. */
    { id: M.yardJn, segment: yardTap.branchSeg, end: 'start', kind: 'junction' },
    /* The ZONE THROAT — on the yard's own approach lead (`topLeadIn`), reached ONLY by a
     *  train switched into the yard, so a circulating train never parks here and the
     *  zone never mistakes a passer for a visitor. */
    { id: M.yard, segment: yardTap.yard.topLeadIn, end: 'start', kind: 'yard_entry' },
  ];

  const junctions: SceneJunction[] = [
    { markerId: M.satA, switchId: a.switchId, positions: [a.mainPos, a.loopPos] },
    { markerId: M.satB, switchId: bsat.switchId, positions: [bsat.mainPos, bsat.loopPos] },
    {
      markerId: M.yardJn,
      switchId: yardTap.switchId,
      positions: [yardTap.mainPos, yardTap.divertPos],
    },
  ];

  /* The running-line cycle in PHYSICAL order (the bypass a circulating train takes):
   *  north → satA → satB → east → yard throat → south → west → north. Each satellite is
   *  a diamond (junction → station → rejoin, or straight past); the yard throat sits on
   *  the bottom run BEFORE south, the drive-through yard diverting BELOW it. The four
   *  cardinal markers (north/east/south/west) are running-line stations spread around
   *  the loop so four trains seed clear and never bunch into one block. */
  const edges: EdgeSpec[] = [
    { from: M.north, to: M.satA },
    { from: M.satA, to: M.blkAB, requiresSwitch: a.mainPos }, // stay on the main
    { from: M.satA, to: M.satAStation, requiresSwitch: a.loopPos }, // divert into the loop
    { from: M.satAStation, to: M.blkAB }, // loop rejoins the through on top-b
    { from: M.blkAB, to: M.satB },
    { from: M.satB, to: M.east, requiresSwitch: bsat.mainPos },
    { from: M.satB, to: M.satBStation, requiresSwitch: bsat.loopPos },
    { from: M.satBStation, to: M.east },
    { from: M.east, to: M.blkEY1 },
    { from: M.blkEY1, to: M.blkEY2 },
    { from: M.blkEY2, to: M.yardJn },
    { from: M.yardJn, to: M.south, requiresSwitch: yardTap.mainPos }, // bypass the yard
    { from: M.yardJn, to: M.yard, requiresSwitch: yardTap.divertPos }, // divert into the yard
    { from: M.yard, to: M.south }, // released visitor rejoins past the merge (opaque interior)
    { from: M.south, to: M.west },
    { from: M.west, to: M.blkWN },
    { from: M.blkWN, to: M.north },
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
