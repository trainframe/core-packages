/**
 * Unit tests for the heading-edge derivation baked into `spawnTrain` (ADR-036 §3c).
 *
 * The derivation is internal to `physics-env.ts`; it is tested here by driving
 * `spawnTrain` with controlled geometries and observing:
 *   (a) the `train_introduced` event the server emits back on the bus (proving
 *       the heading resolved correctly), and
 *   (b) that an ambiguous layout causes `spawnTrain` to throw (the caller must
 *       supply an explicit `headingEdge` in that case).
 *
 * No broker, no world, no devices beyond what `startPhysicsEnv` builds — pure
 * control through the env's public API, observed through `env.eventsOfType`.
 */
import { describe, expect, it } from 'vitest';
import { startPhysicsEnv, straightLoop } from './physics-env.js';
import type { PhysicsScene } from './physics-env.js';

/* Build a PhysicsScene from a straightLoop (all markers at y=0, heading east).
 * Used for cases that only need a single forward direction. */
const buildEastwardLoop = (...markerIds: string[]): PhysicsScene =>
  straightLoop(
    markerIds.map((id) => ({ id, kind: 'block_boundary' as const })),
    { spacingMm: 300, name: 'derive-heading-test' },
  );

describe('spawnTrain heading derivation — single outgoing edge', () => {
  it('introduces the train on the only outgoing edge when facing aligns with it', () => {
    /* straightLoop A→B→C→A: one outgoing edge from each marker. Facing 1 (+east),
     * the heading from A must be A→B (the body points at B). */
    const env = startPhysicsEnv(buildEastwardLoop('A', 'B', 'C'));
    try {
      env.spawnTrain('T1', { atMarker: 'A', facing: 1 });
      /* Server emits train_introduced after introduceTrainWithVector. The payload
       * carries the heading_edge the derivation picked. */
      const introduced = env.eventsOfType('train_introduced');
      expect(introduced).toHaveLength(1);
      const edge = (
        introduced[0]?.payload as {
          heading_edge?: { from_marker_id: string; to_marker_id: string };
        }
      ).heading_edge;
      expect(edge?.from_marker_id).toBe('A');
      expect(edge?.to_marker_id).toBe('B');
    } finally {
      env.shutdown();
    }
  });

  it('throws when the body faces AWAY from its only outgoing edge (reversed facing)', () => {
    /* straightLoop A→B→C→A: the only outgoing edge from A is A→B (east). With
     * facing -1 the body points WEST — away from B — so introducing it on A→B
     * would route it opposite its physical heading. The derivation must reject
     * this and demand an explicit headingEdge rather than silently reverse it. */
    const env = startPhysicsEnv(buildEastwardLoop('A', 'B', 'C'));
    try {
      expect(() => env.spawnTrain('T1', { atMarker: 'A', facing: -1 })).toThrow(
        /ambiguous.*explicit headingEdge/,
      );
      expect(env.eventsOfType('train_introduced')).toHaveLength(0);
    } finally {
      env.shutdown();
    }
  });
});

describe('spawnTrain heading derivation — multi-edge: picks by bearing', () => {
  it('east-facing body picks the east neighbour over the north neighbour', () => {
    /* Build a wishbone: A has two outgoing edges — to B (east) and to C (north).
     * On the straight loop A→B→C→A, the layout has only A→B. We build a custom
     * scene with two edges from A to test the bearing pick. */
    const base = buildEastwardLoop('A', 'B', 'C');
    /* Add a north-going edge A→C and a south-going marker (C is at y=0 in the
     * straight loop, so we override the scene with custom markers + edges). */
    const scene: PhysicsScene = {
      net: base.net,
      layout: {
        name: 'bearing-test',
        markers: [
          { id: 'A', kind: 'block_boundary', position: { x_mm: 0, y_mm: 0 } },
          { id: 'B', kind: 'block_boundary', position: { x_mm: 300, y_mm: 0 } } /* east  */,
          { id: 'C', kind: 'block_boundary', position: { x_mm: 0, y_mm: 300 } } /* north */,
        ],
        edges: [
          { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 300 },
          { from_marker_id: 'A', to_marker_id: 'C', estimated_length_mm: 300 },
          { from_marker_id: 'B', to_marker_id: 'C', estimated_length_mm: 300 },
          { from_marker_id: 'C', to_marker_id: 'A', estimated_length_mm: 300 },
        ],
        junctions: [],
      },
      markers: [
        { id: 'A', x: 0, y: 0 },
        { id: 'B', x: 300, y: 0 },
        { id: 'C', x: 0, y: 300 },
      ],
    };
    const env = startPhysicsEnv(scene);
    try {
      /* facing: 1 → body places on the rail, rotationDeg ≈ 0° (east on the
       * single straight rail 'main'). The bearing pick should choose B (east). */
      env.spawnTrain('T1', { atMarker: 'A', facing: 1 });
      const introduced = env.eventsOfType('train_introduced');
      expect(introduced).toHaveLength(1);
      const edge = (
        introduced[0]?.payload as {
          heading_edge?: { from_marker_id: string; to_marker_id: string };
        }
      ).heading_edge;
      /* East-facing body → picks the east neighbour B over the north neighbour C. */
      expect(edge?.from_marker_id).toBe('A');
      expect(edge?.to_marker_id).toBe('B');
    } finally {
      env.shutdown();
    }
  });
});

describe('spawnTrain heading derivation — ambiguous: explicit headingEdge required', () => {
  it('throws when all outgoing neighbours are behind the body facing direction', () => {
    /* Two outgoing edges from A, both pointing east (B and C east of A). Body is
     * on the straight loop facing east (rotationDeg ≈ 0°), but wait — we want
     * the body facing WEST (rotationDeg ≈ 180°). We pass `facing: -1` to place
     * the body facing west, so both east-pointing edges are behind it. */
    const base = buildEastwardLoop('A', 'B', 'C');
    const scene: PhysicsScene = {
      net: base.net,
      layout: {
        name: 'ambiguous-test',
        markers: [
          { id: 'A', kind: 'block_boundary', position: { x_mm: 600, y_mm: 0 } },
          { id: 'B', kind: 'block_boundary', position: { x_mm: 900, y_mm: 0 } },
          { id: 'C', kind: 'block_boundary', position: { x_mm: 1200, y_mm: 0 } },
        ],
        edges: [
          { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 300 },
          { from_marker_id: 'A', to_marker_id: 'C', estimated_length_mm: 600 },
          { from_marker_id: 'B', to_marker_id: 'C', estimated_length_mm: 300 },
          { from_marker_id: 'C', to_marker_id: 'A', estimated_length_mm: 600 },
        ],
        junctions: [],
      },
      markers: [
        { id: 'A', x: 600, y: 0 },
        { id: 'B', x: 900, y: 0 },
        { id: 'C', x: 1200, y: 0 },
      ],
    };
    const env = startPhysicsEnv(scene);
    try {
      /* facing: -1 → body placed on the straight rail pointing west (rotationDeg
       * ≈ 180°). Both outgoing edges from A go east (to B and C), so both are
       * directly behind the body — no forward edge → derivation throws. */
      expect(() => env.spawnTrain('T1', { atMarker: 'A', railPos: 600, facing: -1 })).toThrow(
        /ambiguous.*explicit headingEdge/,
      );
    } finally {
      env.shutdown();
    }
  });

  it('does NOT throw when an explicit headingEdge is supplied for an ambiguous marker', () => {
    /* Same ambiguous layout, but the caller provides an explicit headingEdge. */
    const base = buildEastwardLoop('A', 'B', 'C');
    const scene: PhysicsScene = {
      net: base.net,
      layout: {
        name: 'explicit-heading-test',
        markers: [
          { id: 'A', kind: 'block_boundary', position: { x_mm: 600, y_mm: 0 } },
          { id: 'B', kind: 'block_boundary', position: { x_mm: 900, y_mm: 0 } },
          { id: 'C', kind: 'block_boundary', position: { x_mm: 1200, y_mm: 0 } },
        ],
        edges: [
          { from_marker_id: 'A', to_marker_id: 'B', estimated_length_mm: 300 },
          { from_marker_id: 'A', to_marker_id: 'C', estimated_length_mm: 600 },
          { from_marker_id: 'B', to_marker_id: 'C', estimated_length_mm: 300 },
          { from_marker_id: 'C', to_marker_id: 'A', estimated_length_mm: 600 },
        ],
        junctions: [],
      },
      markers: [
        { id: 'A', x: 600, y: 0 },
        { id: 'B', x: 900, y: 0 },
        { id: 'C', x: 1200, y: 0 },
      ],
    };
    const env = startPhysicsEnv(scene);
    try {
      expect(() =>
        env.spawnTrain('T1', {
          atMarker: 'A',
          railPos: 600,
          facing: -1,
          headingEdge: { from_marker_id: 'A', to_marker_id: 'B' },
        }),
      ).not.toThrow();
      const introduced = env.eventsOfType('train_introduced');
      expect(introduced).toHaveLength(1);
      const edge = (
        introduced[0]?.payload as {
          heading_edge?: { from_marker_id: string; to_marker_id: string };
        }
      ).heading_edge;
      expect(edge?.from_marker_id).toBe('A');
      expect(edge?.to_marker_id).toBe('B');
    } finally {
      env.shutdown();
    }
  });

  it('does NOT introduce when introduced: false — for ADR-036 roll/zone tests', () => {
    const env = startPhysicsEnv(buildEastwardLoop('A', 'B', 'C'));
    try {
      env.spawnTrain('T1', { atMarker: 'A', introduced: false });
      /* No train_introduced event — the train is registered but not introduced. */
      expect(env.eventsOfType('train_introduced')).toHaveLength(0);
    } finally {
      env.shutdown();
    }
  });
});
