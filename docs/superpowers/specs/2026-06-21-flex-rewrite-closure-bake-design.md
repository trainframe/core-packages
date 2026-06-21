# Flex rewrite — closure-bake (single coordinate frame)

Date: 2026-06-21
Status: design, pending review

## Problem

The current flex implementation has produced a steady stream of bugs — the
closure wave never shows (D3), the render/solver anchor mismatch (D4), the
keep-bend regression (D9), the phantom snap near a flexed track (D8/A), the
move-then-attach corruption (B). A forked deep-review found they share ONE root
cause:

> Flex is **persistent, global, per-joint δ state** that must stay consistent
> with a **mutable rest-pose topology**, and the UI renders **two coordinate
> frames** (rest vs effective). Every edit path (move/flip/rotate/delete) is a
> desync site; every display surface (snap-highlight, drag-preview) can show the
> wrong frame.

Patching individual sites leaves the next edit path and the next surface to find.

## Decision

Eliminate persistent flex and the two-frame model. **A piece stores its actual
drawn pose — there is one coordinate frame.** Flex becomes a transient, compute-
on-the-fly thing used only to (a) preview a closing bend during a drag and (b)
solve the bend that gets **baked** into the pieces' stored poses on closure
commit. Nothing flex-related is ever persisted.

This is the forked review's recommendation (closure-assist + bake-on-commit),
with one addition: keep the **transient live bend preview during a closing drag**,
because the user explicitly preferred during-drag feedback over solve-on-release.
The preview is ephemeral (computed each frame, never committed until the
release-bake), so it cannot corrupt edits the way persistent flex did.

## The model

- **One pose per piece.** `TrackPiece.rotationDeg` widens from the quantized
  `RotationDeg` union to `number` (continuous), because a baked closure produces
  off-grid angles. Producers that need a grid angle (the **Rotate (R)** action,
  **Flip**, and new-piece snap-to-45°) keep producing quantized values; every
  consumer already accepts any `number` (all geometry is trig). The stored pose
  IS the drawn pose.

- **Retire the two-frame machinery.** Delete: the persistent `flex` `FlexState`
  map, `flexAnchorId`, `applyFlex`, the `effectivePieces` memo, the transient
  snapshot/revert (`handleDragBegin`/`handleRevertFlex`), and the
  `EffectivePiece` nominal brand + `asTrackPiece(s)` adapters (with one frame the
  brand has nothing to distinguish). Placement, snapping, the snap-highlight, the
  drag preview, compile, and render all read `pieces` directly.

- **Keep the solver + forward kinematics** (`flex-solver.ts`, `effectivePoses` in
  `flex.ts`) — but as PURE, TRANSIENT computation, never persisted. They compute
  the bent poses during a closing drag (for preview) and the final bent poses to
  bake on commit.

- **Drag interaction** (unchanged velocity gate, new commit semantics):
  - *Slow drag of a chained end piece* → compute the bent chain transiently and
    render it as a preview (the chain bends to follow the hand). When the free
    end is within budget of an open target, flash the dragged piece.
  - *Release with a feasible closure* → **bake** the solved bent poses into the
    affected pieces' stored `position`/`rotationDeg`; the loop is now closed in
    the single frame. No flex stored.
  - *Release without closure* → discard the transient bend (pieces unchanged);
    then a plain rigid reposition of the dragged piece (move/detach), exactly
    like a free piece.
  - *Fast yank* → detach + rigid move (unchanged).

- **Bake = continuous poses.** On closure, walk the solved effective poses and
  write each affected piece's `position` + `rotationDeg` (continuous). Clear all
  transient state. The closed loop is thereafter ordinary geometry.

## Why this kills the bugs structurally

- **Bug A (phantom snap):** there is no rest frame. The snap target, highlight,
  preview, and drawn track are all the one stored pose → they coincide.
- **Bug B (move-then-attach corruption):** there is no persistent flex map to go
  stale when a piece moves; moving a baked piece just moves its stored pose, and
  a new piece snaps to the stored (drawn) endpoint.
- **D3/D4/D9/transient-revert:** the machinery that generated them is deleted.

## Cost / accepted trade-offs

- A new RIGID piece attached to a **baked (off-grid) end** needs its own
  closure-assist to align — it won't sit flush by rigid snap alone. Accepted: a
  closed loop is terminal (you rarely extend it), and open building stays on the
  45° grid until its final closing piece, which is exactly where closure-assist
  applies.
- The one-shot **closure wave** (D3, never worked) is **out of scope** for this
  rewrite; it can be re-added later as a pure animation fired on the bake event.
- `rotationDeg: number` is contained to the simulator + simulator-ui (TrackPiece
  lives in `packages/simulator/src/track/pieces.ts`); the wire protocol uses
  markers/edges, not piece rotation, so nothing on the wire changes.

## Testing

- **Pure unit (`packages/simulator/src/track/`):** closure solver still converges;
  a `bakeClosure(pieces, draggedId, target)` helper returns continuous poses whose
  joints are coincident + anti-parallel within ε; placement/snap on continuous
  poses still snap exactly (no phantom); moving a baked piece then attaching a new
  one leaves a continuous joint (the Bug-B regression).
- **Playwright-driven (`@playwright/mcp` via `browser_run_code`):** TRUSTED pointer
  input with scripted path + velocity — slow-drag-to-close bakes a closed loop;
  drag near a baked end snaps to the drawn endpoint (no phantom); move a middle
  piece of a baked loop then attach a new piece → no corruption. Assert on the SVG
  `transform`/endpoint DOM, with `toHaveScreenshot` as a phantom-snap backstop.
- **End-to-end:** build → scan → train learns/laps a baked closed loop.

## Open decisions (recommended answers)

1. **Keep the slow-drag live bend preview** (recommended) vs. rigid-drag +
   solve-only-on-release. Recommend keeping it — matches the user's stated
   preference; it's transient so it carries no persistence risk.
2. **`rotationDeg: number`** (recommended) vs. an optional continuous override
   field. Recommend widening — it's contained to the sim and lets the brand and
   `applyFlex` be deleted wholesale (one frame).
3. **Drop the closure wave** for now (recommended) — it never worked; re-add as
   a pure animation later.
