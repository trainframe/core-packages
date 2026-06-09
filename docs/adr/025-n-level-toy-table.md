# ADR-025: N-level toy table — supports, per-deck height cue, growable deck selector

## Status

Accepted — implemented (June 2026). Implementation notes at the end.

Builds on the design research in
[`docs/research/bridges-and-height-layers.md`](../research/bridges-and-height-layers.md)
(Option A: a discrete editor `layer`, the logical graph stays height-free) and on
the wooden aesthetic of [ADR-024](024-wooden-track-aesthetic.md). Purely
presentational and editor-only: it changes how raised track is *drawn* and how
the operator *authors* decks. It does not touch the wire protocol, the scheduler,
or the logical graph.

## Context

The toy table already supported stacked track: a piece carries an optional
`layer` (0 = ground), endpoint clustering and placement snapping are layer-aware
so a bridge deck never auto-connects to the ground beneath it, and pieces paint
in layer order so a deck reads as over/under. But two things were quietly
hard-wired to *exactly two* decks:

- The deck selector (`SELECTABLE_LAYERS`) was a literal `[Ground, Upper]`.
- The per-layer height cue (`layerStyle`) branched on `layer === 1` and clamped
  everything deeper to a single "layer-2" shadow.

So a third deck could exist in data but the operator had no way to author it and
it looked identical to the second. The number two was arbitrary — physically a
Brio table stacks as many graduated decks as you have risers. Separately, the
only height cue was a drop-shadow; raised track had no *structure* holding it up,
so a bridge read as "floating" rather than "standing on piers."

## Decision

### 1. The height cue scales with depth, and saturates

`layerStyle(layer)` becomes a smooth ramp — drop-shadow offset, blur and opacity
grow with the deck index — capped (`SHADOW_*_MAX`) so a deep stack stays legible
instead of casting an absurd shadow. Layer 1 keeps its original `{6, 4, 0.35}`
values, so existing two-deck layouts are visually unchanged; layers 2, 3, … now
each read as progressively higher.

### 2. Raised track stands on support piers

A raised track piece gets a single slim support column under its centre — the
point the layout marker sits on, which lands on the wooden band for every piece
type (a curve's origin is its arc midpoint). The column is darker, in-shadow wood
(`tf-pier`) dropping by the layer's shadow offset to a soft contact shadow, so
pier and shadow agree and the deck reads as standing, not floating. Ground track
and device pieces (trains/gates/carriages) never carry a pier.

**Piers avoid the rail below.** Where a deck bridges directly over lower track
(the legitimate crossing case), the pier is *suppressed* so a column never lands
on the rail passing underneath — `pierSuppressed` reuses the same footprint test
as the same-layer overlap detector, so "is there track under here?" has one
consistent answer. The piers then sit beside the span, as a real overpass does.

### 3. The deck selector grows with the layout

The selector is derived, not fixed: it shows Ground up to the highest deck in use
(or the active one, so a freshly-added empty deck stays visible), plus a
"+ Add level" button that authors one deck higher. Decks are labelled `Ground`,
`Level 1`, `Level 2`, … and an empty top deck falls away on its own. While a
piece is armed for placement, decks other than the active one fade gently, so the
operator can see which deck a drop will land on — the one disambiguation a
stacked 2D top-down view needs (research open question #7).

### What stays the same

`packages/protocol` and `packages/core` are untouched. Height never crosses the
wire; the scheduler still reasons only in markers and edges, and a bridge is
still "two markers at the same `(x, y)` on disjoint loops" (ADR-011). Rendering
stays 2D top-down with layer-ordered draw; isometric/3D remain deferred (research
open question #6) — the pier + scaling shadow give enough height read without it.

## Consequences

- **N decks, no special-casing.** The render pipeline already buckets by
  arbitrary layer and sorts; removing the two literals is all that "n levels"
  needed. There is no cap beyond what the shadow saturation and table size make
  sensible.
- **The visualiser still can't render height.** It never sees the editor's
  `layer` (it subscribes to the wire `Layout`, which has none). Two stacked
  markers render at the same `(x, y)` there. Putting `layer`/`z_mm` on
  `LayoutMarker.position` is a protocol bump and remains the open decision
  (research open question #1) — deliberately out of scope here.
- **Pier placement is per-piece, mid-span.** One column per raised plank gives a
  regular rhythm of legs. If operators later want piers at joins or fewer/denser
  columns, the anchor is a single pure helper (`supportColumn`) to revisit.
- **Known: suppression doesn't distinguish a ground crossing from deck-on-deck.**
  `pierSuppressed` omits the pier whenever *any* lower track sits under the pier
  point. For a level-2 piece bridging over a level-1 deck, you'd physically want
  a shorter pier standing *on* the level-1 deck rather than no pier at all. The
  user's stated case is the rail-below crossing, where suppression is exactly
  right, so this is acceptable for now; a future refinement could shorten the
  pier to the nearest lower deck instead of dropping it.

## Implementation notes

- `packages/simulator-ui/src/track/pieces.ts` — generalised `layerStyle`; added
  `supportColumn` + `SUPPORT_COLUMN_WIDTH_MM` (pure geometry).
- `packages/simulator-ui/src/track/overlap.ts` — added `pierSuppressed`, reusing
  `centreDistance` / `OVERLAP_CENTRE_DISTANCE_MM`.
- `packages/simulator-ui/src/components/ToyTable.tsx` — `SupportLeg` component +
  `tf-pier` gradient; supports render sub-pass per layer; derived growable deck
  selector with "+ Add level"; authoring fade of non-active decks.
- Tests: unit (`pieces.test.ts`, `overlap.test.ts`) for the scaling cue, pier
  geometry and suppression; a Playwright journey (`ui-tests/multi-level-toybox`)
  adding decks, authoring on Level 2, and proving a pier is omitted over ground
  track.
