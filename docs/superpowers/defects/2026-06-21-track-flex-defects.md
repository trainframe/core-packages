# Track-flex defect register

Date opened: 2026-06-21
Surface: toybox (`ToyTable.tsx`) + `@trainframe/simulator/track/*`
Status legend: 🔴 open · 🟡 repro'd (red test exists) · 🟢 fixed (test green) · ⚪ unconfirmed

A defect closes only when **(a)** a test reproduces it red at the right seam and
**(b)** that test goes green. "Unit tests pass" is not a close condition — every
prior unit test passed while all of these shipped.

## RESOLUTION (2026-06-21)

The diagnosis took THREE tries; the final cause was found by **direct
measurement**, not reasoning (two prior hypotheses — "placement reads rest" and
"`snapToAnchor` quantises rotation" — were both disproved by a probe).

Final, verified cause of D1/D2: placement is a **rest-domain** operation, but the
toybox was feeding it **effective** (flexed) geometry, so `applyFlex`'s forward
kinematics double-counted the neighbour's deviation → a ~14 mm gap at the joint.

The branded-`EffectivePiece` refactor turned out to be the RIGHT enforcement,
once pointed the correct way: placement takes rest `TrackPiece[]`, render/closure
take branded `EffectivePiece[]`, and the two are non-interassignable — so feeding
effective geometry to placement is now a **compile error** that catches this
exact bug class. Status: D1, D2 fixed + regression-tested; brand shipped.

D3/D4 remain open (see below) — interaction bugs best confirmed by the
deterministic flex trace, not reasoning.

---

## D1 — Track appended to a flexed end is displaced from the joint 🟢 (FIXED)

**Repro:** flex a line so its open end is off the 45° grid. Attach a new piece to
that end (click/drop).
**Expected:** new piece meets the flexed end; rails continuous.
**Actual:** new piece displaced from the joint — "snaps to the proper/true
position, looks odd."
**VERIFIED cause (measured, not reasoned):** placement is a **rest-domain**
operation — it computes a new piece's REST pose, and `applyFlex`'s forward
kinematics then positions that piece at the flexed joint. But the toybox fed
placement the **effective** (flexed) geometry (`pieces={effectivePieces}`), so
the new piece's rest pose was snapped to the *already-flexed* neighbour endpoint,
and `applyFlex` then re-applied the neighbour's deviation via FK — **double-
counting**. A probe measured a **13.96 mm gap** at a single 4° joint (tangent was
fine; position double-counted). NB: two earlier hypotheses (placement reads rest;
`snapToAnchor` rotation quantisation) were both wrong — disproved by direct
measurement.
**Fix (shipped):** placement is rest-domain again (`computePlacement` etc. take
`TrackPiece[]`); the toybox feeds it REST pieces via a new `restPieces` prop. The
branded `EffectivePiece` type makes feeding effective geometry a **compile
error** — so this bug class can't recur silently.
**Regression test:** `packages/simulator/src/track/flex-attach.test.ts` — attach
to a 4°-flexed end → gap < 0.001 mm, kink < 0.001°; plus a `@ts-expect-error`
proving placement rejects effective geometry.

## D2 — Physics goes janky after attaching to a flexed line 🟢 (FIXED, downstream of D1)

Same root cause as D1 (the ~14 mm joint gap). Fixed by the same rest-domain
placement change. The continuous-rail proof (`flex-closed-loop.test.ts`, a train
laps a flex-closed ring) and the new attach regression both pass.

## D3 — Closure flash / wave never appears in live use ⚪ (hypotheses, unconfirmed)

**Repro:** build a near-closed loop; slow-drag the open end toward the closing
endpoint.
**Actual:** no flash, no wave observed.
**Verified facts:** the wave IS wired (`:1849`, `:1852`); `newLoopCenterline`
runs `findLoops` on *flexed* geometry (`:2612`). So the path exists.
**Leading hypotheses (must be confirmed by the trace, NOT by reasoning):**
  1. **Clustering threshold.** `findLoops`/`buildJoints` cluster endpoints within
     `SNAP_DISTANCE_MM` (30 mm). Flex closes gaps in the 30–60 mm band; if the
     solved closure leaves the endpoints > 30 mm apart, no joint is formed → no
     cycle → `newLoopCenterline` returns null → no wave. The `:2615` comment
     *assumes* gaps are ≤ 30 mm, which flex closures routinely are not.
  2. **Anchor mismatch (see D4)** makes the live free-endpoint/target gap differ
     from what the solver believes, so closure feasibility is rarely hit.
**Catching mechanism:** the flex trace (below) records, per commit:
`{ gapAtClose, clustered?, findLoops→cycle?, waveFired? }`. A pure replay test
feeds a known closing drag and asserts the cycle is found and the wave fires.

## D4 — Flex animation shakes / blurs during drag 🟡 (cause likely; confirm via trace)

**Repro:** slow-drag a piece in a flexed chain; watch the line.
**Actual:** shake / blur frame-to-frame; piece appears to lag the cursor.
**Likely cause (strong, from code):** the **render and solver use different FK
anchors.** Render derives poses via `applyFlex(pieces, flex)` which pins the
*first piece of the component* (`:214`). The drag solver derives `flex` relative
to `selectAnchor(pieces, draggedId)` — a junction or far-point (`flex-solver.ts:209`).
Same δ, different FK root → the whole component is rigidly offset in render vs
solver frame, and the offset changes each frame as δ changes → the dragged piece
jitters relative to the cursor.
**Fix direction:** thread the solver's anchor into the render so both reconstruct
under one anchor (`applyFlex(pieces, flex, anchorId)`), and persist that anchor
with the flex so committed geometry doesn't jump.
**Catching test:** assert `applyFlex(pieces, flex, anchorId)` reproduces exactly
the pose `effectivePoses(pieces, flex, anchorId)` (solver frame) for the dragged
piece — i.e. render frame ≡ solver frame.

## D5 — Detached piece no longer vanishes 🟢 (regression fixed earlier)

Kept here as a closed entry so the register is the whole picture. Detach now frees
the piece into the cursor (`handlePieceDragStart`/detach path).

---

## How we verify from here (process)

The headless suite missed these because it tested the pieces in isolation; the
bugs live in the *live, per-frame pipeline*. The fix for "untestable" is to make
that pipeline emit **deterministic, inspectable trace data** — then both manual
repro and automated replay assert on the same facts.

1. **Flex trace.** Instrument the drag/closure pipeline to emit a structured
   record per frame and per commit:
   `{ frame, draggedId, solverAnchorId, renderAnchorId, freeEndpoint, nearestTarget, gap, feasible }`
   and on commit `{ gapAtClose, clustered, cycleFound, waveFired }`. Surfaced in
   dev (console / debug panel) so a human drag turns "it's flaky" into concrete
   numbers — no screenshot-puppeting required.
2. **Pure replay test.** The flex logic is pure: feed a recorded sequence of
   cursor points to `solveFollow`/`detectLoopClosure`/`newLoopCenterline` and
   assert the trace invariants (render anchor ≡ solver anchor; gap monotonically
   closes; cycle found on close; wave fires). This is the net the unit tests
   weren't — it exercises the *seam*, headless and deterministic.
3. **D1/D2 are confirmed** — fix surgically (joint-flex on attach) with the
   tangent-continuity tests above; no trace needed.
4. Flip an entry 🟢 only when its catching test is green AND, where it's an
   interaction bug, the live trace shows the invariant holding.

## D4-bis — Drag jumps to "proper" spot on release 🟢 (FIXED, = D4)

Fixed in three parts: (1) `applyFlex(pieces, flex, anchorOverride?)` can reconstruct
a component under a given FK anchor; (2) the toybox persists the solver's anchor
(`flexAnchorId`) and renders the live drag under it, so the dragged piece tracks
the cursor instead of rendering rigidly offset; (3) releasing a slow flex-drag
that didn't close now KEEPS the bend (flex persists) instead of rest-snapping the
piece — the re-snap was the visible jump. To move a piece OUT of a chain, fast-
yank it (the velocity gate detaches). Regression test: `flex.test.ts` asserts the
render frame ≡ the solver frame under the anchor; existing flex Playwright specs
(slow-bend, fast-yank) still pass. **D6 caveat still applies** for junction-less
chains across gestures.

### Original grounding (kept)

**Repro (user, 2026-06-21):** grab a piece in an open near-ring and drag; the
piece renders in a wrong/laggy spot during the drag, then snaps to the correct
joint on release.
**Grounded cause:** dragging a piece in an *anchored* chain takes the FLEX path
(`handlePieceDragMove` → `solveFollow` → `onDragFlex`), which renders the chain
live via `applyFlex` — pinned at the *first piece of the component* (`flex.ts`),
while the solver computed the flex relative to `selectAnchor` (junction/far). Same
δ, different FK root → the dragged piece renders rigidly offset from the cursor
(this is D4). On release with no closure, `handlePieceDragEnd` falls through to
`onMovePiece`, which REST-snaps the piece correctly → the visible jump.
**NOT the same as D1/D2** (which was the *new-piece attach* double-count, fixed).
This is the existing-piece flex-drag render, still open.
**Fix direction:** unify the anchor — render the live drag under the solver's
anchor (`applyFlex(pieces, flex, anchorId)` + persist the anchor with the flex);
and reconcile the flex-drag-vs-move-snap intent at release.

## D7 — A scheduled train never moves (can't be localized) 🟢 (FIXED via marker-gated-by-scan)

Resolved by the user's model: a piece has a marker only once SCANNED — visually
(the dot, gated on `liveIds`) AND mechanically (`ToyHardware.markerPoints()` now
filters to scanned pieces, so the virtual train emits `tag_observed` only over
scanned markers; rails exist for every piece, so the train still drives the full
geometry). Unscanned pieces therefore emit nothing → no "unknown tag" → no failed
localization. A train localizes at scanned markers and routes over the scanned-
marker graph; to run a loop, scan the pieces you want as waypoints. The
scheduler's unknown-tag anomaly + the scan→`tag_assignment`→bind flow are
UNTOUCHED, so a genuinely-unknown marker (hardware, reset, timing) still raises
the anomaly and is bound by scanning. Tests: `toy-hardware.test.ts` proves a train
driving over an unscanned piece emits no `tag_observed` for it; `ToyTable.test.tsx`
proves the dot appears only after scan.

### Original grounding (kept)

**Repro (user, 2026-06-21):** a train discovers/laps a hand-built ring (with a
small break it "jumps"), but given a loop schedule it never moves. Logs show
`device_registered` then `tag_observed M-curve-5` then `anomaly: Unknown tag
observed: M-curve-5 (not in the tag registry)`.
**Grounded cause:** `scheduler.handleTagObserved` (`scheduler.ts:421`) resolves
the tag via `TagRegistry`; an unknown tag emits the anomaly and returns —
**no marker_traversed, no position update**. So a train sitting at an unbound
marker is never localized, and the scheduler can't grant clearance → it stays
stopped (default-safe). Tags are bound ONLY by `tag_assignment` events
(`tag-registry.ts`), never by traversal; and `reset()` calls `tags.clear()`
(`scheduler.ts:184`). So a blank-slate reset (Feature 1) — or a build where the
M-curve-5 piece was never scanned/bound — leaves that marker unresolvable even
though neighbours (M-curve-6, M-curve-2) resolve.
**Open question it touches:** "Tag→marker resolution at runtime" (CLAUDE.md). Fix
options to weigh with the user: (a) re-derive marker tag-bindings from the
current inferred layout on (re)registration; (b) let discovery-mode traversal
bind the marker it lands on; (c) localize a train from an unknown tag in
discovery rather than dropping it. NOT a flex issue.

## C — R/Flip targeted the selected piece, not the grabbed one 🟢 (FIXED)

Grabbing a piece now selects it at drag-start (`onSelectPiece` → `setSelectedId`
in `handlePieceDragStart`), so keyboard actions act on the piece in hand.

## D8 — Blank slate didn't clear the Unknown-Tags affordance 🟢 (FIXED, driven)

**Found by driving Chrome.** Blank slate DOES clear server retained state (verified:
"cleared 34 retained topics", markers/trains gone). But the visualiser's Unknown
Tags list (`use-unknown-tags.ts`) is local state derived from the anomaly stream;
it drops a tag only when a retained `railway/state/tags/<id>` message lands — and
an *unbound* unknown tag never had one, so nothing tombstones it. Fix: blank-slate
bumps a `resetNonce` (App → MaintenancePanel `onReset`); `useUnknownTags` clears on
it (React adjust-state-during-render). Verified: injected an `M-ghost` anomaly →
affordance appeared → blank slate → affordance gone. Guardrail: `UnknownTags.test`.

## D9 — Ordinary drag bent the chain & created phantom snaps 🟢 (FIXED, driven — was D4-bis regression)

**Found by driving Chrome — and it was a regression I introduced** with the D4-bis
"keep the bend on release" change. A slow drag of ANY connected piece bent the whole
chain and PERSISTED it (measured: a 4-straight line left rotated 4.5°/−0.5°/−5.5°/
−10° after one drag). That stray flex is the "invisible snap point": a new piece
snaps to a flexed neighbour's REST (phantom) endpoint, not where it's drawn. And it
broke building → the train couldn't traverse → "can't learn". Fix: flex is now
TRANSIENT — it bends live during a drag but reverts to the pre-drag shape on release
UNLESS the drag committed a loop closure (snapshot at drag-start, revert on
non-closure release). Verified: chain bends mid-drag, reverts to rest (all 0°) on
release. Learning re-verified end-to-end (train drove a scanned line; edges inferred
2→3→4→5). Guardrail: updated `ToyTable.test` ("bends live but REVERTS on release").

Note: blank-slate RESURRECTION (sim re-announcing scanned pieces) could NOT be
reproduced — an idle sim did not re-announce after reset. If it recurs it's a
separate sim/server-coupling path, not D8.

## D10 — Flex closure is non-functional for real layouts 🔴 (verified un-mocked, 2026-06-22)

**The big one, found by testing with NO mocks** (every prior closure/wave test
mocked `solveClose`). Built a genuinely flexable-looking near-loop with the app's
real `computePlacement` (7 curves + a short straight + an 8th curve) and ran the
real solver:

| straight | closing gap | heading err | `solveClose` feasible | joints flexed | gap after solve |
|---|---|---|---|---|---|
| 30 mm | 115 mm | 0° | **false** | 1 | 110 mm |
| 60 mm | 130 mm | 0° | **false** | 1 | 125 mm |

Findings:
1. **No real operating range.** Curve/straight loops on the 45° grid close
   EXACTLY (gap 0 — measured live on an 8-curve ring) or leave a gap (~115–130 mm)
   FAR beyond flex reach (~70 mm). Inserting a short straight does NOT yield a
   30–60 mm gap. So realistic near-closures are never in the flex band.
2. **Solver barely engages** — flexed 1 joint, moved the free end ~5 mm against a
   115 mm gap (`afterGap ≈ gap`); not distributing bend across the chain.
3. **Anchor picks the straight** (`anchor=S`); `hasFlexAnchor=false` for the 30 mm
   case.
4. Therefore `solveClose` returns infeasible → `onClosureCommit` never fires →
   **the wave never runs** for any realistic loop. It only ever "worked" against
   artificial small swung-target gaps in unit tests with a mocked UI.

**Implication:** the flex-closure feature has effectively no working operating
range in real use. Strong candidate for REMOVAL (let loops close rigidly — 8
curves do this perfectly — and delete the flex/solver/wave machinery), rather
than continued nursing. Pending user decision.

## D6 — Cross-gesture anchor re-root may shift a junction-less component 🟢 (MEASURED — sound; guarded 2026-06-24)

When the FK anchor changes between drags (a junction-less open chain whose
far-point depends on which piece is dragged), re-rooting pins a different piece
at rest. Out of scope for the D4 fix (which pins one anchor per gesture); logged
so it isn't mistaken for "covered." Junction components are unaffected (the
junction is a stable anchor).

**Resolution (2026-06-24, by direct measurement — see the vanish-report entry
below):** the re-root does NOT rigid-shift the component. Measured across many
alternating-end flex+bake gestures on junction-less curve/straight/tight chains:
the gesture's anchor stays pinned to within < 0.5 mm, every pose stays finite,
and no piece ever sits beyond the chain's own geometric reach of the anchor (it
cannot teleport / fling / go NaN). The earlier "rigid offset" was D4 (render vs
solver anchor), already fixed; the residual cross-gesture concern logged here is
benign in the current (post bake-on-release / authoritative-connection) code.
**Guard:** `packages/simulator/src/track/flex-reroot-vanish.property.test.ts`
(anchor pinned + finite + within-reach + count-preserved, 15 seeds/types).

---

## Vanish report — "flex a chain, add a piece, the anchor or a far piece disappears" 🟢 (REPRODUCED on `38423a5`; ROOT-CAUSED; fixed by per-component `applyFlex`; regression-guarded 2026-06-24)

**Repro (user):** place a set of pieces, flex the chain, then add a new piece —
*sometimes* the presumed anchor, or a piece far down the flexed line, vanishes
(gone from the rendered set / flung off-canvas / to NaN).

**CAPTURED FAILING OBSERVATION (the original flex commit `38423a5`, run live in an
isolated worktree):** input pieces `[a0, a1, b0]` (chain A = `a0`+`a1`, plus a
detached piece `b0`) under a flex of chain A → `effectivePoses(pieces, flex, 'a0')`
returned `[a0, a1]`. **`b0` VANISHED** — present in the input, absent from the
rendered set (omitted from the result map → never drawn).

**ROOT CAUSE (with evidence):** the original `effectivePoses` rendered a flex by
walking a spanning tree from a SINGLE anchor (`walkTree`) and returning ONLY the
pieces it reached; `loops.ts` had no `connectedComponents`. So on any flex render
of a layout with >1 connected component, every piece NOT in the anchor's
component was omitted → vanished. The "set of pieces, flex, then add" recipe hits
this exactly: adding a piece that doesn't snap onto the chain (or a flex that
over-bends a joint past the heading tolerance and SPLITS the chain) creates a
second component — and whichever component the single anchor isn't in disappears
(its pieces can be "the anchor" you presumed, or any piece "far down the line").
**Intermittent** because it requires >1 component during a flex render; with one
fully-connected chain the walk reaches everything.

**Why the existing flex/closure tests didn't catch it:** they all flexed a SINGLE
connected chain from an end, so the single-anchor walk reached every piece — the
multi-component case was never exercised.

**FIX (current `applyFlex`, `flex.ts` ~380–410):** split the layout into
`connectedComponents`, root EACH at its own anchor (the drag's anchor when it is
in that component, else the component's first piece), and return
`pieces.map(p => poses.get(p.id) ?? {...rest})` — so EVERY input piece is in the
output (its FK pose, or its rest pose). A piece can no longer be dropped, in any
number of components. This was the bake-on-release / authoritative-connection
rewrite (2026-06-22), which is why the vanish does not reproduce in current code.

**Regression test (red on `38423a5`, green now):**
`packages/simulator/src/track/flex-multicomponent-vanish.property.test.ts` —
replays the multi-component place→flex→add (a flexed chain + a detached piece;
place→flex→add a non-connecting piece; three separate components) and asserts
applyFlex returns EVERY piece, all finite. Plus the broader soundness guards:
- LIVE (real browser, real flex of the end AND anchor-side piece, then add): no
  vanish, second-adversary CANNOT-REFUTE;
- deterministic place→flex→add over curves/tight/flips/warm-start/compounding
  (`flex-add-vanish.property.test.ts`);
- branching junctions/crossings, random-piece flex (`flex-branch-vanish.property.test.ts`);
- junction-less cross-gesture re-root, D6 (`flex-reroot-vanish.property.test.ts`).

**Why current code is sound:** `applyFlex` maps *every* input piece across all
components (never drops one); the FK is finite; the DLS solve is damped +
pivot-guarded (no NaN); bake clears the flex map; the renderer draws all pieces
by layer; the gesture anchor stays pinned (D6). A DEV vanish-watch
(`window.__tfVanishLog`) also captures any future non-finite/off-canvas piece live.

**Also addressed:** the parts-menu drag was reworked (feature B, 2026-06-24) to a
controlled pointer drag, removing the native-HTML5-DnD add path; and the D6
junction-less re-root concern was measured benign (above). The report was REAL
(it bit on `38423a5`) and is fixed — not a misperception.
