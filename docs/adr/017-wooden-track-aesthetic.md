# ADR-017: Wooden-track aesthetic for the toy table (and a cohesive visualiser theme)

## Status

Accepted — implemented (June 2026). Implementation notes at the end.

Builds on [ADR-013](013-simulator-physical-twin-visualiser-system-view.md) (the
simulator-ui is the operator's virtual Brio table; the visualiser is the
system's view). Purely presentational: it changes how pieces are *drawn*, not
the topology, the wire protocol, or the scheduler.

## Context

The toy table rendered every track-piece type as a flat single-colour band in a
different garish hue (blue-grey straight, purple junction, tan station…) with
hash-line "sleepers" baked into one SVG path. It read as a schematic, not as the
wooden train set the product *is*. The operator asked for a "mature passover on
all the track pieces" so they look "more like a real wooden train track — not
stupidly real, but more consistent in shape and style." The visualiser, a
separate logical-graph view, looked like a third unrelated app.

## Decision

### 1. One wooden material, distinguished by shape

Every track piece is a beech-wood plank: a wood-gradient body, a soft rim-light
and contact shadow for a bevelled feel, and **two routed rail grooves**. Piece
*type* is read from silhouette (a straight, a Y-fork junction, a plus crossing, a
platform'd station, a buffered terminus) — not from a rainbow of fills. This is
what "consistent shape and style" means: one material language, many shapes.

### 2. Grooves are derived from the rail a train rides

The twin grooves are not hand-authored per piece. They are sampled from the SAME
`CentreLinePath` (`localHalfPath`) the simulator uses to move a train, offset
±`RAIL_GAUGE` along the local normal. Consequences:

- The routed groove and the running rail can never disagree — including through
  the junction **branch**, whose centre-line is a bezier, not a straight 45°
  chord. (A hand-drawn straight groove there would make a diverting train
  visibly bow off its own rail.)
- Grooves meet cleanly across a snapped joint, because adjacent endpoints
  coincide and the grooves run to the endpoints.

`PLANK_HALF_WIDTH` and `RAIL_GAUGE` are single module constants every builder
reads, so plank widths and gauges cannot drift apart.

### 3. Tints are warm-only; the boldest shapes carry none

The chosen direction was "wood + gentle functional tints" so an operator can
still read a piece's role. But colour theory bites: a **cool** wash (blue/teal)
over warm beech desaturates to a drab grey rather than reading as colour. So the
`PIECE_TINT` wash is **warm-only** and used where it both reads and helps —
station (honey), terminus (brick), ramp (ochre). The pieces with the most
distinctive silhouettes — the junction (Y) and the crossing (+) — carry **no**
tint: their shape already reads, and a grey wash would only muddy the wood.

### 4. Devices are not wooden

Trains, carriages and gates are manufactured objects, not track, so they keep
solid body colours with characterful top-down detail (a loco with a boiler,
funnel, windscreen and headlamp; a carriage with windows; a gate with a
red-and-cream barrier boom).

### 5. Selection/overlap are a glow, not a stroke

Highlighting a piece by stroking its outline would trace the internal seams of a
multi-plank piece (junction, crossing). Selection (blue) and invalid-overlap
(red) are instead a CSS `drop-shadow` **glow** composed with the contact shadow
— seam-free and rotation-invariant.

### 6. A shared "workshop" theme across both apps

A warm palette — wood-desk page surround, paper-card app surface, rounded display
font, wooden tabletop behind the canvas — is applied to BOTH the simulator-ui and
the visualiser (via its `--tf-vis-*` / `--tf-color-*` tokens) so the two apps
read as one product.

## Consequences

- `getPieceShape` now returns `{ svgPath, grooves, features, width, height }`
  (was `{ svgPath, width, height }`). `svgPath` is the wood body outline; the
  renderer (and only the renderer) owns the palette, mapping each feature `role`
  and the tint to colours. `pieces.ts` stays pure geometry with zero colours
  except the semantic `PIECE_TINT` table.
- **Topology is byte-for-byte unchanged**: endpoints, centre-lines, marker
  kinds, snapping, overlap detection. Visual plank width (16 → 26 mm) is cosmetic
  and does not affect snapping (which keys off endpoints) or overlap detection
  (which keys off centres/endpoints).
- The visualiser change is theme/CSS only — no rendering-logic change.

## Alternatives considered

- **Keep bold per-type colours, just unify the shape.** Rejected: the operator
  asked for "real wooden track," and a rainbow of planks is not that.
- **Tint the junction/crossing a cool hue anyway.** Rejected: greys out over
  warm wood (see §3); the Y/plus silhouettes already disambiguate.
- **Make the visualiser render the actual wooden pieces.** Deferred: it is a
  logical-graph view; a cohesive *themed* schematic keeps it legible and dense
  while still feeling part of the same product.

## Implementation notes

- Geometry + decor: `packages/simulator-ui/src/track/pieces.ts`
  (`getPieceShape`, `centreLineGrooves`/`offsetGroove`, `sweptBandAlong` — the
  junction BRANCH wood is a band swept along the same bezier centre-line as its
  grooves, so the wood follows the rails rather than a straight 45° chord — the
  body builders, `PIECE_TINT`, `PieceFeatureRole`).
- The rim-light highlight is drawn BEHIND the wood fill, so the opaque wood hides
  the internal seams where a multi-plank piece's sub-paths overlap (junction
  throat, crossing centre); only the outer silhouette edge shows.
- Rendering: `ToyTable.tsx` (`PieceBody`, `Feature`, `Groove`, `WoodDefs`,
  `pieceFilter`) + `ToyTable.css` (workshop theme).
- Visualiser theme: `packages/visualiser/src/theme/light.css`,
  `src/visualiser.css`.
- Verified live with the bridge demo (real `ToyTable`, connected layout, running
  trains) and the `feature-showcase` visualiser screenshots; 309 simulator-ui +
  138 visualiser tests pass, including new contract tests for grooves, features
  and tints.
