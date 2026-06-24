# Toy-table editing, junction-surveying learn, and readable layout — spec

**Date:** 2026-06-25
**Surfaces:** `packages/simulator-ui` (toy table), `packages/simulator/src/track` (geometry),
`packages/server` (LearnMode), `packages/visualiser` (layout view).

Five fixes/features from live operator feedback, executed to the project standard:
**reproduce live FIRST → root-cause with evidence → fix at root cause + a regression
test that FAILS first → adversarial CANNOT-REFUTE (+ frame-reviewed recording for
UI-visible parts) → green gate** (typecheck/lint/test green, coverage floors held,
prior invariants intact, docs updated). Commit each part separately.

Fixture for parts 3–4: `test-track-layout.json` (29 pieces, 2 junctions, 2 stations,
3 loops; currently 2 connected components — one isolated piece).

## Part 1 — Single-piece flex is meaningless (bug)

**Symptom:** press-and-hold a piece that's on no flexable chain → flex mode engages
(ripple), but flex does nothing; a hold-then-drag move then springs back to the
original position (the move is discarded).

**Root cause (confirmed):** `ToyTable.tsx` `PieceRenderer.handlePointerDown` hold-dwell
timer sets `mode = 'flex'` + `onFlexEnter` UNCONDITIONALLY after `FLEX_HOLD_MS`,
regardless of whether the piece has a flex anchor. On release the flex path
springs the (un-flexed) piece back to rest.

**Fix:** the parent passes a `flexable` prop (`hasFlexAnchor(restPieces, piece.id)`);
the hold-dwell only engages flex when `flexable`. A non-flexable piece's hold-then-
drag is a plain MOVE that commits on release.

**Test:** component test — a lone piece, press-hold-drag, asserts it relocated and
STAYS (no spring-back) and never entered flex (no ripple / flex state).

## Part 2 — Drag is the single placement path (remove arming) and attaches cleanly (bug + UX)

**Operator feedback:** arming is confusing (a second placement path) AND unusable (you
can't see the piece's angle/direction before you click). The drag-from-menu path
(Feature B) already carries the real piece, orientable with R/F in-flight, and snaps —
so it strictly supersedes arming.

**Decision (locked):** REMOVE the arm-then-click canvas placement. Tapping a parts-menu
tile only opens its variant options (straight length, carriage/loco livery) to
configure the next drag — it no longer arms anything. Dragging a tile is the SOLE
placement path.

**Bug to fix (the user's actual report):** a menu-DRAG (not the armed click) dropped
against an existing open end VANISHES; the workaround is drop-in-open-space-then-drag.
The drag commits via the Feature-B place-then-`computeMovePlacement` sequence — reproduce
live first (which piece is lost, where it goes), root-cause that commit, fix so a drag
onto an occupied open end attaches in one action.

**Test:** migrate the click-based `placePieceOnToyTable` helper + its callers to the
drag path; deterministic + e2e — a menu-drag onto an occupied open end keeps both pieces
(finite + on-canvas, one component); R/F set orientation in-flight; the variant fan still
configures a dragged piece; NO canvas-click placement path remains.

## Part 3 — Connectivity under flex on a real layout (bug)

**Symptom:** `test-track-layout.json` renders disconnected in multiple places, and
flexing one piece breaks the visual connection elsewhere.

**Leads:** (a) `buildJoints` requires heading alignment within `JOINT_HEADING_TOL_DEG`
(7°); near-touching ends slightly off render as gaps. (b) Flexing re-derives the whole
component's geometry, which can push a different joint past tolerance → a false sever.

**Fix:** root-cause on the real layout; ensure operator-joined pieces render connected
and a single-piece flex never changes the connected-component count elsewhere.

**Test:** deterministic on the loaded layout — component count is stable across a flex
of each piece; no joint the operator made renders as a gap.

## Part 4 — Junction-surveying learn (feature)

**Symptom:** a train told to learn a layout with junctions surveys ONE loop; it never
throws the junctions to explore the diverging legs.

**Design (locked):**
- On approaching a junction, `LearnMode` throws the switch toward a **not-yet-traversed
  outgoing leg** (track traversed edges per junction).
- **Survey complete** when a full pass yields no newly-traversed edges (every reachable
  edge covered).
- Forward-only — no reverse (directional-running invariant holds); legs are reached by
  re-routing through the junction with the switch thrown.
- Emits `set_switch_position` for the chosen leg; re-plans the train through it.

**Test:** integration on a branched layout (≥1 junction, both legs lead to learnable
track) — asserts EVERY edge (both legs) is learned, not just one loop.

## Part 5 — Readable discovered-layout view (feature)

**Symptom:** the visualiser layout view is muddled with crossings.

**Root cause (confirmed):** an inferred topology has no spatial coordinates, so
`computeMarkerPositions` falls back to "evenly spaced around a circle, in marker-array
order" — arbitrary order, every edge cuts the circle.

**Design (locked):** a **deterministic force-directed layout** — pure function
`layoutMarkers(markers, edges) → Map<id, point>`, seeded circular init, fixed iteration
count, **no `Math.random`** (so it's reproducible and headless-testable; the e-paper
frontend reuses it). Junction legs stay visually distinct.

**Test:** count edge crossings before (circular) and after on `test-track-layout.json`;
assert a material reduction. Pure-function unit tests for determinism + a small known
graph.

## Order of execution

1 → 2 → 3 → 5 → 4 (quick win first; the biggest feature, junction-learn, last). Each
part: failing test → fix → green; commit. Adversarial + recording for the UI-visible
parts (1, 2, 3, 5) once their fixes land.
