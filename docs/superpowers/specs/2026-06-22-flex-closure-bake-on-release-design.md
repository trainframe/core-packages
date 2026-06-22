# Track flex & loop closure — bake-on-release (single frame)

Date: 2026-06-22
Status: design, pending adversarial hardening + implementation
Supersedes: 2026-06-21-flex-rewrite-closure-bake-design.md (extends bake to open chains)

## Problem

Real wooden track *flexes* to close a loop: rigid, 45°-quantised pieces almost
never return exactly to the start, so the loop is nudged shut by a little give at
every joint. The platform needs this — without it the physics world can't build
realistic closed layouts. Two earlier attempts failed:

- **Persistent per-joint flex state** (a `FlexState` map composed by forward
  kinematics into "effective" poses, rendered in a second coordinate frame
  alongside the stored "rest" poses) generated a long tail of bugs: the wave
  never fired, the live render and the solver disagreed on the FK anchor, a
  "keep the bend" change made every drag leave stray flex, new pieces snapped to
  flexed neighbours' *rest* (phantom) endpoints, and moving a piece left orphan
  flex entries that corrupted later edits. All trace to one root: **two
  coordinate frames + a mutable flex map that every edit path must keep in sync.**
- **Reverting non-closure flex** (the current `main`) avoids those bugs but threw
  away a real capability: you can no longer flex an open length and have it hold.

This spec keeps the single-frame model that fixed the bugs **and** restores
persistent flex — safely — by baking.

## Core decision: bake on release, one coordinate frame

There is exactly **one** representation: a piece's stored `position` +
`rotationDeg` (continuous `number`) IS its drawn pose. There is **no** persistent
flex map and **no** rest/effective split.

Flex is a *transient, compute-on-the-fly* thing used only while a drag is in
flight; the moment the drag ends it is **baked** into the pieces' stored poses
and discarded. Baking applies whether or not the drag closed a loop:

- **Open chain** → the bent poses are baked; the length keeps its flexed shape.
- **Closing** → the bent poses are baked, the loop's ends become coincident so
  the joint graph closes the cycle, and a one-shot **wave** runs.

Because committed state is always single-frame baked poses (never a flex map),
the *stale-map* bug classes above are structurally impossible: snap targets, the
drawn track, compile, and render all read the same stored poses; there is no map
to go stale on an edit.

**One bug the single frame does NOT fix for free (caught by adversarial review).**
Baking an open chain leaves its open end at an *off-grid* `rotationDeg` (the
flex angle). The placement snap (`snapToAnchor`) historically rounded a new
piece's rotation to the nearest 45°, so attaching to a baked off-grid end left
the rail kinked by the flex angle even though the position coincided — the
"can't attach to a flexed line / snaps to an invisible point" defect, just
relocated from the flex map into the stored pose. The fix is mandatory and
specific: **`snapToAnchor` must align the new piece CONTINUOUSLY anti-parallel
to the anchor's actual `outgoingAngleDeg`, never quantised to the grid** (a
no-op for on-grid neighbours; the difference only shows on baked ends). Guarded
by an explicit attach-after-bake regression (`flex-attach.test.ts`): gap < ε AND
heading kink < ε with an empty flex map.

## The anchor (why a slow drag deforms instead of sliding)

To bend rather than rigidly translate, a drag pins one **anchor** and distributes
the bend across the joints between it and the dragged piece. The anchor is the
surrogate for the mass/friction that, in real life, holds the rest of the track
still while you flex one end. Selection, in order:

1. A **junction/branch** piece in the dragged piece's connected component (it is
   the most-constrained piece — the natural fixed reference).
2. Otherwise the **far open end** — the piece at maximum joint-distance from the
   dragged piece (BFS over the joint graph).

**Robustness requirement (hardened).** `selectAnchor` must return a piece that
yields a *long* anchor→dragged chain so the bend distributes across many joints.
The original code returned the *first* junction in iteration order regardless of
its distance — an adjacent junction gives a degenerate 1-joint chain. Hardened:
among junctions it now picks the **farthest** one (max BFS distance), falling
back to the farthest open end when there is no junction. Covered by a
discriminating test (two junctions, the near one ordered first in the array,
assert the far one is chosen) plus the ≥3-non-zero-δ distribution assertion in
the closure test.

A **free / non-anchored** component (a closed loop with no junction, nothing else
placed) has no fixed reference, so a drag there translates rigidly — no flex.
This is correct: you cannot flex a thing with nothing holding it.

## Drag interaction (velocity gate)

- **Slow drag of an anchored chain** → the solver bends the chain live each frame
  (transient render only). When the dragged piece's free endpoint comes within
  `CONNECT_CAPTURE_MM` of another open endpoint *and* a closing solution exists
  within budget, the dragged piece **flashes** (`data-closure-available`).
- **Mouse-up (release):**
  - *closure feasible* → bake the solved closing poses; the ends coincide so the
    joint graph forms the cycle; fire the **wave**.
  - *no closure* → bake the current bent poses (the open length holds its shape).
  - *(either way: no flex map persists; transient flex is cleared.)*
- **Fast yank** (pointer speed ≥ `DRAG_FLEX_MAX_SPEED`) → detach the dragged
  piece and move it rigidly (re-snaps on drop). This is how you reposition a
  piece without bending the chain.

## Closure solve & reach

`solveClose(pieces, draggedId, freeEndpointIdx, target)` (damped least squares
over the anchor→dragged joint chain) drives the free endpoint onto the target in
*position and heading*. Feasible ⇒ within per-joint budget.

**Open reach question — ANSWERED empirically (2026-06-22).** The worry was that
realistic curve/straight loops only ever land at a gap of ~0 (close exactly) or
~one piece-span (>100 mm — beyond budget), leaving the flex band empty. Measured
against valid builds (snapped end-to-end, no detached pieces, `findLoops = 0` at
rest), the **uneven stadium oval** disproves it:

- Two semicircle ends (4×45° curves each) joined by two straight sides of
  *unequal* length close with a **pure-position gap equal to the side difference
  and 0.00° heading error** (the loop still sweeps exactly 360°, so the closing
  joint stays anti-parallel; only the position is off). This is the most common
  real near-miss — people build slightly-uneven ovals constantly.
- **The gap depends on construction, not just the nominal side lengths** (a point
  the adversarial review made and the test now pins). The closing gap is a
  property of *where the closing piece's free end actually sits*, which the
  accumulated curve geometry and the exact build order affect. The same nominal
  "200/150 stadium" can land either auto-snapped-shut at rest (residual ≤ 30 mm →
  placement closes it, `findLoops = 1`, nothing for the solver to do) or in-band,
  depending on how it was laid. So the figures below are **the verified gap of
  the specific build in the test**, not a guarantee derived from side lengths.
- The `closure-bakes-cycle` test layout — sides **150 / 110 built piece-by-piece
  through `computePlacement`** — lands a **~40 mm** gap that sits in the flex band:
  above auto-snap (`SNAP_DISTANCE_MM = 30`), below capture
  (`CONNECT_CAPTURE_MM = 60`), and genuinely open at rest. The test asserts these
  preconditions *before* solving (gap in (30, 60), `findLoops = 0`) so it cannot
  silently pass on an auto-snapped loop.
- `solveClose` closes it to **post-gap 0.00 mm** within the existing
  `FLEX_BUDGET_DEG = 5` budget (max |δ| ≈ 3.25°), distributing the bend across
  ≥3 joints (≥1 non-zero δ asserted). `selectAnchor` returns the far piece, not
  an adjacent one.

So the band is genuinely reachable and **no constant change is needed**:
`FLEX_BUDGET_DEG = 5`, `FLEX_GIVE_MM = 2` stand. The acceptance bar — "a
hand-buildable near-closed loop flexes shut" — is met and pinned by the test,
which asserts the rest gap is in-band and the loop genuinely open *before* it
solves. (Gaps below 30 mm auto-snap at rest and never reach the solver; gaps
above ~64 mm exceed reach and are correctly reported infeasible.)

## The wave

The instant a loop closes on release, a one-shot glow pulse travels the loop's
ordered rail centreline once (~1 s) and ends. Computed from the *baked* closed
geometry (`newLoopCenterline` over `findLoops` of the baked pieces). It fires
from the closure-commit (mouse-up) path only — never from rigid placement. A loop
with a spur waves the cycle only.

## Architecture (what changes from `main`)

`main` already has the single-frame foundation (`rotationDeg: number`,
`EffectivePiece` collapsed to `TrackPiece`, closures bake, non-closure drags
revert). This spec changes:

1. **Bake non-closure flex too** (`ToyTable` drag-end): replace the "revert on
   non-closure release" branch with "bake the transient bent poses into the
   pieces." Same bake path the closure uses, minus the join + wave. *(Done:
   `handleFlexBake`.)*
2. **Continuous snap to baked off-grid ends** (`placement.ts` `snapToAnchor`):
   align a new piece anti-parallel to the anchor's actual heading instead of
   rounding to the 45° grid — required so attaching to a baked flexed end does
   not kink. *(Done; attach-after-bake regression added.)*
3. **Length-aware placement** (`placement.ts` `computePlacement`): thread the
   candidate's `lengthMm` so a LILLABO straight variant snaps flush — otherwise
   the uneven oval can't be laid flush at all. *(Done; flush-placement test
   added. BOTH UI call sites — click AND drop — pass the armed straight length;
   the drop site was a second-pass review finding, now fixed + tested.)*
7. **Free-endpoint selection by OPEN endpoint** (`flex-solver.ts`
   `freeEndpointIndex`, used by `solveFollow` and `detectLoopClosure`): the
   handle the cursor drags / a closure snaps onto is the dragged piece's OPEN
   (unjointed) endpoint, not "farthest from the anchor by straight-line
   distance." The old rule mispicked for a near-closed loop — there the closing
   free end is physically NEAR the anchor — so a real closing drag drove the
   chain the wrong way and never flashed/closed. Exposed by the un-mocked wave
   test; fixed and regression-guarded. *(Done.)*
4. **Harden `selectAnchor`** (`flex-solver.ts`): pick the farthest junction (then
   farthest open end). *(Done; discriminating two-junction test added.)*
5. **Validate the solver reach** (`flex-solver.ts` constants): per "Closure solve
   & reach" above — no change needed; the uneven oval lands in band. *(Done.)*
6. **Un-mock the closure path in tests**: a real `solveClose` + real
   `newLoopCenterline`/bake integration test. *(Done: `flex-closure-bake.test.ts`
   bakes a real solve; the UI wave test drives an un-mocked solver.)*
8. **Fix the frozen wave animation** (`ClosureWave.tsx`): the default clock
   `now = () => performance.now()` was an inline default — a fresh function each
   render — so the RAF effect (deps `[durationMs, now]`) re-ran on every `setT`
   and reset the start time, freezing the pulse at the loop's start. Every unit
   test passed because they inject a stable clock; only the recorded live demo
   exposed it. Hoisted the default to a module-level constant; regression drives
   the DEFAULT-clock path to completion. *(Done.)*

Pure geometry stays in `packages/simulator/src/track/{flex,flex-solver,loops,
placement,pieces}.ts`; interaction + wave in `ToyTable`; the physics canvas is a
test surface only.

## Testing (the goal's clause 2)

Deterministic, all green, adversarially reviewed (no hollow/mocked/tautological
asserts):

- **open-flex-holds:** drive a slow drag of a chained piece in the rendered
  `ToyTable`, mouse-up *without* closing; assert the chain's pieces are at bent
  (non-rest) poses *after* release and stay there (baked, not reverted).
- **closure-bakes-cycle:** build a valid near-closed loop via the real placement
  path; run the real `solveClose`; bake; assert `findLoops` returns exactly one
  loop covering all pieces and every joint is continuous (gap < ε, anti-parallel
  headings).
- **wave-fires-on-mouse-up:** drive the real closing drag to mouse-up with a real
  (un-mocked) solver; assert `data-closure-available` flashes during the drag and
  the wave element (`[data-testid="closure-wave"]`) mounts with a non-null
  centreline on release.
- **anchor-distribution:** on a multi-piece anchored chain, assert `selectAnchor`
  returns the far piece (not an adjacent one) and a closing solve spreads δ across
  ≥3 joints (not 1).
- Full suite stays green (no regression to scan-gating, select-on-drag, etc.).

## Demo video (the goal's clause 3)

A Playwright recording driving the live sim: build a near-closed loop, slow-drag
the open end so the chain visibly flexes, and on mouse-up the loop closes and the
wave animates across it. The raw video is handed to an adversarial agent that
extracts its own frames and must fail to refute (i) genuine flex (not a rigid
translate) and (ii) a wave animating across the closing loop on the mouse-up.

*(Done.)* `packages/ui-tests/tests/flex-closure-wave-demo.spec.ts` builds the
uneven stadium oval through real mouse events, slow-drags the open end shut, and
records the run to `packages/ui-tests/videos/`. An adversarial frame reviewer,
handed only the raw video, **could not refute either claim**: it confirmed the
flex by overlaying the rail outline (zero displacement at the anchored end,
growing toward the dragged end — deformation, not a uniform translate) and
confirmed the wave by tracking the gold pulse's centroid through a full clockwise
lap (top→left→bottom→right). The wave traversal was slowed to 2.2 s so the pulse
is appreciable across a large loop. *(An earlier recording was refuted on the
wave — the 1 s traversal moved the pulse ~108 px/frame at 25 fps, too sparse to
read as animation; slowing it resolved that, and the second review confirmed.)*

## Non-goals

- No real mass / soft-body physics — the anchor is the deformation reference.
- No core/protocol/MQTT changes (TrackPiece is sim-only).
- No "perfect synthesised closing piece."
- No explicit "close loop" button — closure is detected mid-drag.

## Open risks (to resolve in implementation, flagged honestly)

- **Solver reach vs. real gaps** — RESOLVED: the uneven stadium oval lands a
  40–50 mm gap in the flex band with anti-parallel heading, closed to 0 within
  the existing ±5° budget. See "Closure solve & reach". No constant change.
- **Cross-gesture stability of baked open flex** — baking writes absolute poses,
  so re-flexing a baked chain re-solves from the baked poses (fine); confirm no
  drift accumulates over repeated bend/re-bend.
- **Anchor for a closed loop with no junction** — non-anchored ⇒ rigid (no flex);
  acceptable, documented.
