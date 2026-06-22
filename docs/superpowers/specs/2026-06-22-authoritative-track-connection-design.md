# Authoritative Geometric Track Connection — Design Spec

**Date:** 2026-06-22
**Status:** draft for review
**Supersedes the connection/detach behaviour of:** `2026-06-22-flex-closure-bake-on-release-design.md`

## Problem

The toy-table drag/connection path is a state machine of interacting heuristics:

- a velocity-yank detach (`DRAG_FLEX_MAX_SPEED = 1.5 px/ms`),
- a reach-residual detach gate (`DETACH_RESIDUAL_MM = 70`),
- three per-frame render branches (`flex` / `free` / `detached`),
- a transient-flex-then-bake commit on release,
- and `buildJoints` connecting endpoints by **position only** (30 mm), heading ignored.

A real session (logged + recorded) exposed an emergent failure: slow-dragging the
open end of a 7-curve chain toward a cursor it cannot physically reach **severs the
held piece** — it renders at the cursor, unflexed, disconnected — and the operator
is left holding a loose piece. Forensics proved the cause is NOT the math:

- `solveFollow` replayed over the exact logged 70-sample cursor path keeps every
  joint ≤ 4.99° (budget 5°) and the chain one connected component throughout;
  curve-8 bakes *connected* at rot 245°.
- The velocity gate **cannot** have fired: measured drag speed was 0.1–0.3 px/ms,
  far below the 1.5 px/ms threshold (the operator was moving slowly, as reported).
- The bake reads a live ref, not stale state.

The disconnect is an emergent product of the branch state-machine and the **two
competing render sources** for the held piece (its flexed effective pose vs a
`pieceDragPreview` pinned to the cursor). It resists line-level root-causing even
with the full event log. That opacity is the defect.

Separately, position-only `buildJoints` lets a 45°-misaligned near-touch be declared
"connected" — so the rendered track can **lie** about connectivity (a kink the rails
don't actually seat into).

## Principle (the north star)

**The rendered track is the single source of truth.** Two pieces are connected when
their rail-ends seat — coincident in position AND anti-parallel in heading, within
the flex give — and only then. The rule runs both ways: connected means seated, and
seated means connected. No overlay, ghost, or hint layer — the visible gap or
kink *is* the feedback. The close wave stays, because it is authoritative *positive*
confirmation: it fires exactly when the geometric rule completes a cycle.

## Design

### 1. Connection rule — `buildJoints` requires heading + proximity (within give)

Today: two endpoints from different pieces joint iff clustered within
`SNAP_DISTANCE_MM` (position only). New: they joint iff

- within `SNAP_DISTANCE_MM` positionally, **and**
- anti-parallel within `JOINT_HEADING_TOL_DEG = FLEX_BUDGET_DEG + ε`
  (i.e. `abs(normaliseDeg(headingA + 180 − headingB)) ≤ JOINT_HEADING_TOL_DEG`).

Junction clusters (>2 endpoints) apply the heading check pairwise per emitted joint.
A 45°-misaligned near-touch is therefore **not** a joint — it renders as crossing
rails (a kink), never silently snapped. This single change makes the joint graph
agree with what the eye sees.

### 2. Single-source rendering of the held piece

During a drag the held piece renders from **one** geometric source — its computed
effective pose (flexed within budget, or free once genuinely separated). The
`pieceDragPreview` cursor-override for the dragged piece is removed; there is no path
by which the held piece renders at the cursor while still jointed. What you see is
the geometry.

### 3. Separation is geometric, not velocity-based

- Dragging a piece in a chain flexes the chain toward the cursor within budget. When
  the cursor exceeds flex reach, the held end **holds at max flex (still seated,
  rubber-bands)** — it never falls off from flexing alone.
- A piece **separates** only when the drag pulls its jointed endpoint beyond the seat
  tolerance of its neighbour (translation beyond `SNAP_DISTANCE_MM` + give, or heading
  beyond tol) — i.e. the rails visibly come apart. Computed from geometry every frame;
  re-attaches when they re-seat.
- **Remove** `DRAG_FLEX_MAX_SPEED` and the reach-residual detach. The `flex` / `free`
  / `detached` branch trichotomy collapses into one rule driven by "are the rails
  still seated."

### 4. Release: spring back unless a loop closed (REVISED — adversary finding)

On release:

- If the drag **completed a loop** (the new joint graph has a cycle through the
  dragged piece): bake the closing effective poses into `rotationDeg` and fire the
  wave. A closed loop is a stable cycle that holds its shape.
- Otherwise (open chain): **spring back** to the stored on-grid rest poses — just
  drop the transient flex map (the pieces were never mutated during the drag).

**Why not bake an open chain (supersedes the prior bake-on-release for open
chains):** an adversarial probe of the running UI refuted the budget invariant —
baking an unclosed open chain drifts its rest frame off-grid, and because the next
drag re-flexes from that drifted baseline the per-joint deviation **compounds across
releases** (the budget is measured from the 45° grid, but the baseline keeps
moving). After ~2 drags a joint's heading mismatch exceeds tolerance and the chain
visibly **severs** (1 → 3+ components, permanent). Within a single drag the budget
holds; the leak is across drags. An open chain isn't held bent by anything, so
springing back is also the honest, authoritative behaviour. Regression:
`ToyTable.connection-authoritative.test.tsx` "REPEATED drags … never accumulate
over-budget bend or sever it".

### 5. Close wave

Keep the blue spreading wave. Trigger condition is now stated against the authoritative
rule: a drag that completes a real geometric cycle (proximity + heading + give) mounts
the wave; nothing else does.

### Authoritative invariant (machine-checked, the regression spine)

At every frame and after every bake:

1. No piece is rendered flowing into a neighbour unless `buildJoints` (new rule)
   joints them.
2. The held piece's rendered pose equals its computed effective pose (no override).
3. The number of rendered disconnected assemblies equals `connectedComponents` count.
4. The close wave is mounted iff a new cycle exists through the dragged piece.

## Removal gesture — DECIDED: option (a), geometric-only

A piece separates when you drag it bodily so its jointed endpoint leaves the
neighbour's seat (translation beyond the give). Flexing — rotating about the joint to
follow the cursor — never separates; it rubber-bands at max flex. This is the most
faithful to real wooden track and keeps the visual authoritative: a piece comes off
exactly when you can see the rails part. There is no separate lift/delete gesture and
no velocity heuristic.

## Files

- `packages/simulator/src/track/loops.ts` — `buildJoints` heading rule;
  `JOINT_HEADING_TOL_DEG`.
- `packages/simulator/src/track/flex.ts` / `flex-solver.ts` — `isSeated(epA, epB)`
  helper; geometric separation (reach), not velocity.
- `packages/simulator-ui/src/components/ToyTable.tsx` — collapse branch trichotomy
  into one geometric path; single-source held-piece render; remove
  `DRAG_FLEX_MAX_SPEED` & residual detach; bake fed by single source.
- Tests: `loops.test.ts`, `flex(-solver).test.ts`, `ToyTable.*` component tests,
  `packages/ui-tests` replay/fuzz spec, `scripts/record-session.mjs` harness.

## Testing strategy — why this won't repeat the last miss

The previous goal verified a **hand-crafted happy-path demo video**: an adversary
confirmed the wave appeared, returned CANNOT-REFUTE, yet the feature was badly buggy
in real use. The demo used near-perfect click-drags that never crossed the bug
triggers. The verification proved "the wave can appear," not "connection behaves
correctly under real, arbitrary input." Fixes:

1. **Regression tests from REAL failing sessions, not happy paths.** Encode the exact
   on-grid 7-curve chain and the slow-drag-to-unreachable-cursor of curve-8 from the
   session log; assert the held piece stays seated and connected (never severs,
   joints ≤ budget). This reproduces the original bug and proves it fixed.
2. **Property/invariant tests.** Over seeded randomized drag sequences on generated
   chains, assert the authoritative invariant holds **every frame** (no false
   connect/disconnect; rendered == geometric; component count matches).
3. **Adversarial verification by replay/fuzz, not a curated demo.** Drive the UI via
   the record-session harness with replayed real input AND adversarial drags; the
   adversary's job is to make the visual *lie* (force a false connect, a false
   disconnect, a piece rendered connected while severed, or a wave without a true
   closure) and must fail.
4. **Video/image of the SAME scenario that failed,** showing it now behaves
   authoritatively (held piece rubber-bands at max flex, never falls off; gap/kink
   honest; wave only on true closure), reviewed frame-by-frame by a second adversary.

## Success criteria

- `pnpm typecheck && pnpm lint && pnpm test` green; coverage floors held (no lowering).
- Zero `any`; Biome clean; failing test written before each fix.
- All four testing-strategy items delivered; both adversaries return CANNOT-REFUTE
  after genuine attempts.
