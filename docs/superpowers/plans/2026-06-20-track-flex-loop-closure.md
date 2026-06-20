# Track Flex & Loop Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make closing a track loop in the toybox viable by giving joints a small, bounded, persistent flex — with live bending on drag, a closure flash, and a one-shot wave when a local loop closes — plus fix the 30 mm-straight snapping bug.

**Architecture:** Pure geometry in `packages/simulator/src/track/` — a flex model (per-joint deviation δ composed into continuous *effective poses* by forward kinematics), local-loop detection (cycle in the endpoint-connectivity graph, spurs excluded), and a relaxation solver (follow-cursor / close-loop, with junction-or-far-point anchoring). The toybox (`ToyTable.tsx`) wires the solver into dragging (velocity gate, live flexed render, flash, detach, commit) and renders the wave. The physics-world canvas stays a test-only surface that proves a flexed-closed loop yields a continuous rail a train laps. No core/protocol/device/MQTT changes.

**Tech Stack:** TypeScript (strict), Vitest, React + SVG (toybox), Playwright (ui-tests). 2D rigid transforms; iterative IK relaxation.

## Global Constraints

- **No `any`** — not in casts, generics, or suppressions.
- **Biome clean** — `pnpm lint` zero errors/warnings; no `biome-ignore`.
- **TS strictness** — `strict`, `noUncheckedIndexedAccess` (`arr[0]` is `T | undefined`; narrow, never `!`), `exactOptionalPropertyTypes` (clear optionals with `undefined`, never `delete`), `verbatimModuleSyntax` (`import type` for types; `.js` extensions on imports).
- **No `Date.now()` / `Math.random()`** in `simulator` or `simulator-ui` geometry/sim code — the simulator is deterministic; pass time/seed in.
- **Comments** — multi-line uses `/* */` blocks, never stacked `//`. Human-length.
- **Commits** — short subject, minimal body, NO `Co-Authored-By` trailer. Commit direct to `main` (trunk-style) per execution mode.
- **Physics-world layer only** — nothing in this plan imports from `@trainframe/core`, the scheduler, the protocol, or publishes MQTT.
- **Flex budget (verbatim values):** per-joint **±2°** heading deviation, **≤2 mm** positional give. Closure capture distance reuses `CONNECT_CAPTURE_MM = 60`. `SNAP_DISTANCE_MM = 30` is the endpoint-adjacency threshold.
- **Determinism:** the solver is a pure function of (pieces, flex state, target); no time/random inside it.

## File Structure

- `packages/simulator/src/track/placement.ts` — *modify*: fix same-piece occupancy (the 30 mm bug).
- `packages/simulator/src/track/pieces.ts` — *modify*: add pose-parameterized `getEndpointsAt` / `getCentreLinePathAt` (continuous effective pose, not the quantized stored fields).
- `packages/simulator/src/track/flex.ts` — *new*: joint identity, the connectivity graph, per-joint δ state, forward-kinematics `effectivePoses`, and the ±budget clamp.
- `packages/simulator/src/track/loops.ts` — *new*: local-loop (cycle) detection over the connectivity graph, spurs excluded.
- `packages/simulator/src/track/flex-solver.ts` — *new*: anchor selection + `solveFollow` + `solveClose`.
- `packages/simulator-ui/src/components/ToyTable.tsx` — *modify*: flex state, effective-pose plumbing, drag interaction (velocity gate, live render, flash, detach, commit), wave trigger.
- `packages/simulator-ui/src/components/ClosureWave.tsx` — *new*: one-shot wave overlay.
- Tests: `placement.test.ts`, `flex.test.ts`, `loops.test.ts`, `flex-solver.test.ts` (unit, in `packages/simulator/src/track/`); a physics-canvas behavior test under `packages/simulator-ui/src/sim/` or `packages/integration/`; `packages/ui-tests/tests/toybox-flex-closure.spec.ts`.

---

### Task 1: Fix the 30 mm-straight snapping bug

**Files:**
- Modify: `packages/simulator/src/track/placement.ts:92` (`isCoincidentWithAnother`)
- Test: `packages/simulator/src/track/placement.test.ts`

**Interfaces:**
- Consumes: `TrackPiece` (`pieces.ts:140`), `getEndpoints`, the existing `WorldEndpoint` type used by `allEndpoints`/`openEndpoints`.
- Produces: a `WorldEndpoint` that carries its owning piece id (if it doesn't already), and an `isCoincidentWithAnother` that ignores endpoints on the *same piece*.

- [ ] **Step 1: Read the current code.** Read `placement.ts:80-120` to confirm the `WorldEndpoint` shape and whether it carries a piece id. The fix needs to know each endpoint's owning piece.

- [ ] **Step 2: Write the failing test**

In `placement.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { computeMovePlacement, computePlacement } from './placement.js';
import type { TrackPiece } from './pieces.js';

describe('30 mm straight snapping', () => {
  it('treats both ends of a 30 mm straight as open snap targets', () => {
    /* A lone 30 mm straight at the origin, lying along x (ends at -15 and +15). */
    const existing: TrackPiece = {
      id: 'S30', type: 'straight', position: { x: 0, y: 0 }, rotationDeg: 0,
      tagged: false, lengthMm: 30,
    };
    /* Dropping a new straight near the +15 end must snap (connect) to it. */
    const placement = computePlacement(15, 0, 'straight', [existing], false, 0);
    expect(placement.connected).toBe(true);
    /* And near the -15 end must also snap. */
    const placement2 = computePlacement(-15, 0, 'straight', [existing], false, 0);
    expect(placement2.connected).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @trainframe/simulator test -- placement`
Expected: FAIL — both ends are filtered out of `openEndpoints` (each marks the other occupied at 30 mm), so `connected` is `false`.

- [ ] **Step 4: Implement the fix**

In `isCoincidentWithAnother`, skip endpoints belonging to the same piece. If `WorldEndpoint` lacks a piece id, add one where `allEndpoints` builds them (carry `pieceId: piece.id`). Then:

```typescript
function isCoincidentWithAnother(ep: WorldEndpoint, all: ReadonlyArray<WorldEndpoint>): boolean {
  for (const other of all) {
    if (other === ep) continue;
    /* A piece's own sibling endpoint can never "occupy" it — otherwise a piece
     * shorter than SNAP_DISTANCE (the 30 mm straight) marks its own ends closed. */
    if (other.pieceId === ep.pieceId) continue;
    if (other.layer !== ep.layer) continue;
    if (distance(ep.x, ep.y, other.x, other.y) <= SNAP_DISTANCE) return true;
  }
  return false;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @trainframe/simulator test -- placement`
Expected: PASS — both ends snap. Run the full placement suite too: `pnpm --filter @trainframe/simulator test -- placement` (all pre-existing placement tests still green).

- [ ] **Step 6: Commit**

```bash
git add packages/simulator/src/track/placement.ts packages/simulator/src/track/placement.test.ts
git commit -m "fix: 30 mm straight ends snap (exclude same-piece endpoints from occupancy)"
```

---

### Task 2: Pose-parameterized geometry (`getEndpointsAt` / `getCentreLinePathAt`)

Flexed pieces have *continuous* effective poses, but `getEndpoints`/`getCentreLinePath` read the quantized stored `position`/`rotationDeg`. Add variants that take an explicit continuous pose so flexed geometry can be computed without mutating `TrackPiece`.

**Files:**
- Modify: `packages/simulator/src/track/pieces.ts`
- Test: `packages/simulator/src/track/pieces.test.ts` (create if absent)

**Interfaces:**
- Consumes: existing `transformPoint`, `normaliseAngle`, `PIECES`, `worldHalfPath`, `LocalEndpoint`, `TrackEndpoint`, `CentreLinePath`, `TrackPiece`.
- Produces:
  - `type PiecePose = { readonly x: number; readonly y: number; readonly rotationDeg: number }` (continuous rotation, unlike `RotationDeg`).
  - `getEndpointsAt(piece: TrackPiece, pose: PiecePose): ReadonlyArray<TrackEndpoint>`
  - `getCentreLinePathAt(piece: TrackPiece, pose: PiecePose, endpointIndex: number): CentreLinePath | undefined`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { getEndpoints, getEndpointsAt } from './pieces.js';
import type { TrackPiece } from './pieces.js';

describe('getEndpointsAt', () => {
  const piece: TrackPiece = {
    id: 'S', type: 'straight', position: { x: 0, y: 0 }, rotationDeg: 0, tagged: true, lengthMm: 200,
  };
  it('matches getEndpoints when pose equals the stored pose', () => {
    const at = getEndpointsAt(piece, { x: 0, y: 0, rotationDeg: 0 });
    expect(at).toEqual(getEndpoints(piece));
  });
  it('applies a continuous (non-45°) rotation', () => {
    const at = getEndpointsAt(piece, { x: 0, y: 0, rotationDeg: 2 });
    /* +2° rotates the +100 end slightly +y. */
    const plusEnd = at.find((e) => e.x > 0);
    expect(plusEnd?.y).toBeGreaterThan(0);
    expect(plusEnd?.outgoingAngleDeg).toBeCloseTo(2, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @trainframe/simulator test -- pieces`
Expected: FAIL — `getEndpointsAt` not exported.

- [ ] **Step 3: Implement**

Factor the body of `getEndpoints` to read from an explicit pose. Keep `getEndpoints(piece)` delegating with the stored pose so existing callers are unchanged:

```typescript
export interface PiecePose {
  readonly x: number;
  readonly y: number;
  readonly rotationDeg: number;
}

export function getEndpointsAt(piece: TrackPiece, pose: PiecePose): ReadonlyArray<TrackEndpoint> {
  const locals = PIECES[piece.type].endpoints(piece.radiusMm, piece.lengthMm);
  const flip = piece.flipped === true;
  const baseLayer = layerOf(piece);
  return locals.map(({ lx, ly, localAngle, layerDelta }) => {
    const ly2 = flip ? -ly : ly;
    const localAngle2 = flip ? -localAngle : localAngle;
    const world = transformPoint(lx, ly2, pose.rotationDeg, pose.x, pose.y);
    return {
      x: world.x,
      y: world.y,
      outgoingAngleDeg: normaliseAngle(localAngle2 + pose.rotationDeg),
      layer: baseLayer + (layerDelta ?? 0),
    };
  });
}

export function getEndpoints(piece: TrackPiece): ReadonlyArray<TrackEndpoint> {
  return getEndpointsAt(piece, { x: piece.position.x, y: piece.position.y, rotationDeg: piece.rotationDeg });
}
```

Do the same for `getCentreLinePathAt` by factoring `worldHalfPath` to accept a `PiecePose` (the existing `worldHalfPath(piece, local)` keeps working by passing the stored pose). Show:

```typescript
export function worldHalfPathAt(piece: TrackPiece, pose: PiecePose, local: CentreLinePath): CentreLinePath {
  const flip = piece.flipped === true;
  return {
    length: local.length,
    at(d) {
      const p = local.at(d);
      const ly = flip ? -p.y : p.y;
      const heading = flip ? -p.headingDeg : p.headingDeg;
      const world = transformPoint(p.x, ly, pose.rotationDeg, pose.x, pose.y);
      return { x: world.x, y: world.y, headingDeg: normaliseAngle(heading + pose.rotationDeg) };
    },
  };
}

export function getCentreLinePathAt(piece: TrackPiece, pose: PiecePose, endpointIndex: number): CentreLinePath | undefined {
  const local = PIECES[piece.type].centreLine(endpointIndex, piece.radiusMm, piece.lengthMm);
  if (local === undefined) return undefined;
  return worldHalfPathAt(piece, pose, local);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @trainframe/simulator test -- pieces && pnpm --filter @trainframe/simulator test -- placement`
Expected: PASS (and existing geometry consumers unaffected — `getEndpoints`/`getCentreLinePath` delegate).

- [ ] **Step 5: Commit**

```bash
git add packages/simulator/src/track/pieces.ts packages/simulator/src/track/pieces.test.ts
git commit -m "track: pose-parameterized getEndpointsAt/getCentreLinePathAt for flex"
```

---

### Task 3: Connectivity graph + local-loop detection (`loops.ts`)

**Files:**
- Create: `packages/simulator/src/track/loops.ts`
- Test: `packages/simulator/src/track/loops.test.ts`

**Interfaces:**
- Consumes: `TrackPiece`, `collectEndpoints` + `clusterEndpoints` (`layout-from-pieces.ts:27,76`) — clusters are arrays of indices into the `EndpointRef[]`.
- Produces:
  - `interface JointId { readonly a: { pieceId: string; endpointIdx: number }; readonly b: { pieceId: string; endpointIdx: number } }` (a is the lexicographically-smaller `pieceId:endpointIdx` for stable identity).
  - `function buildJoints(pieces): ReadonlyArray<JointId>` — one per cluster that contains exactly two endpoints from *different* pieces. (Clusters with >2 are junctions; handle by emitting a joint per connected pair sharing the cluster — but for v1, a junction cluster yields joints between the trunk endpoint and each branch endpoint it actually abuts; document the rule in code.)
  - `function findLoops(pieces): ReadonlyArray<Loop>` where `interface Loop { readonly pieceIds: ReadonlyArray<string>; readonly joints: ReadonlyArray<JointId> }` — each a *cycle*, spurs excluded.

- [ ] **Step 1: Write the failing tests** (these define correctness)

```typescript
import { describe, expect, it } from 'vitest';
import { findLoops } from './loops.js';
import type { TrackPiece } from './pieces.js';
/* Helper: build an 8-curve circle by snapping each curve to the previous.
 * Reuse computePlacement from placement.ts to assemble it exactly as the editor would. */

describe('findLoops', () => {
  it('finds the single cycle in an 8-curve circle', () => {
    const circle = buildEightCurveCircle(); /* see placement.test.ts:159 pattern */
    const loops = findLoops(circle);
    expect(loops).toHaveLength(1);
    expect(loops[0]?.pieceIds).toHaveLength(8);
  });

  it('ignores a spur: a circle with one extra straight hanging off a junction', () => {
    const circleWithSpur = buildCircleWithJunctionSpur();
    const loops = findLoops(circleWithSpur);
    expect(loops).toHaveLength(1);
    /* The spur piece is NOT part of the cycle. */
    expect(loops[0]?.pieceIds).not.toContain('SPUR');
  });

  it('returns no loops for an open chain', () => {
    expect(findLoops(buildOpenChainOfThree())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `pnpm --filter @trainframe/simulator test -- loops`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — build the joint graph from clusters, then detect cycles. Algorithm: nodes = pieces, edges = joints. Find cycles via DFS; a back-edge closes a cycle. Iteratively peel degree-1 nodes (spurs) before/after cycle extraction so a junction's open branch is dropped. Keep the file focused (one responsibility: graph + cycles). Provide complete `buildJoints` and `findLoops` implementations.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @trainframe/simulator test -- loops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/simulator/src/track/loops.ts packages/simulator/src/track/loops.test.ts
git commit -m "track: local-loop (cycle) detection over the joint graph, spurs excluded"
```

---

### Task 4: Flex model — joint δ state, clamp, forward kinematics (`flex.ts`)

**Files:**
- Create: `packages/simulator/src/track/flex.ts`
- Test: `packages/simulator/src/track/flex.test.ts`

**Interfaces:**
- Consumes: `TrackPiece`, `PiecePose`, `getEndpointsAt` (Task 2), `JointId`, `buildJoints` (Task 3).
- Produces:
  - `const FLEX_BUDGET_DEG = 2;` and `const FLEX_GIVE_MM = 2;`
  - `interface JointFlex { readonly joint: JointId; readonly deg: number; readonly dx: number; readonly dy: number }` — δ for one joint (clamped on construction).
  - `function clampFlex(deg: number, dx: number, dy: number): { deg: number; dx: number; dy: number }` — clamps to ±budget / ≤give.
  - `type FlexState = ReadonlyMap<string, JointFlex>` keyed by a stable joint key (`jointKey(JointId)`).
  - `function effectivePoses(pieces, flex: FlexState, anchorPieceId: string): ReadonlyMap<string, PiecePose>` — forward kinematics: anchor stays at its rest pose; every other piece's effective pose is the rest relative-transform composed along the joint spanning-tree, applying each joint's δ (rotation about the joint point) and give. Pure.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import { FLEX_BUDGET_DEG, clampFlex, effectivePoses, type FlexState } from './flex.js';

describe('clampFlex', () => {
  it('clamps heading to ±budget and give to ≤2 mm', () => {
    expect(clampFlex(10, 5, 0).deg).toBe(FLEX_BUDGET_DEG);
    expect(clampFlex(-10, 0, -5).deg).toBe(-FLEX_BUDGET_DEG);
    expect(clampFlex(0, 5, 0).dx).toBeCloseTo(2, 5);
  });
});

describe('effectivePoses', () => {
  it('returns rest poses when flex is empty', () => {
    const chain = buildOpenChainOfThree(); /* anchored at piece 0 */
    const poses = effectivePoses(chain, new Map() as FlexState, chain[0]!.id);
    expect(poses.get(chain[0]!.id)).toEqual({ x: chain[0]!.position.x, y: chain[0]!.position.y, rotationDeg: chain[0]!.rotationDeg });
  });

  it('a +2° joint deviation rotates the downstream subtree about the joint point', () => {
    const chain = buildOpenChainOfThree();
    const joints = buildJoints(chain);
    const flex: FlexState = new Map([[jointKey(joints[0]!), { joint: joints[0]!, deg: 2, dx: 0, dy: 0 }]]);
    const poses = effectivePoses(chain, flex, chain[0]!.id);
    /* downstream pieces shift; anchor unchanged */
    expect(poses.get(chain[0]!.id)?.rotationDeg).toBe(chain[0]!.rotationDeg);
    expect(poses.get(chain[2]!.id)?.rotationDeg).toBeCloseTo(chain[2]!.rotationDeg + 2, 3);
  });
});
```

- [ ] **Step 2–4:** Run-fail / implement FK / run-pass.
Run: `pnpm --filter @trainframe/simulator test -- flex`. The FK walks the joint spanning tree from the anchor; at each joint, compose parent effective pose with the rest relative transform, then rotate the child subtree by `deg` about the shared joint point and translate by `(dx,dy)`. Complete implementation required.

- [ ] **Step 5: Commit**

```bash
git add packages/simulator/src/track/flex.ts packages/simulator/src/track/flex.test.ts
git commit -m "track: flex model — clamped per-joint deviation + forward kinematics"
```

---

### Task 5: Flex solver — anchors + follow mode (`flex-solver.ts`)

**Files:**
- Create: `packages/simulator/src/track/flex-solver.ts`
- Test: `packages/simulator/src/track/flex-solver.test.ts`

**Interfaces:**
- Consumes: `TrackPiece`, `FlexState`, `JointId`, `effectivePoses`, `getEndpointsAt`, `findLoops`/`buildJoints`, `FLEX_BUDGET_DEG`.
- Produces:
  - `function selectAnchor(pieces, draggedPieceId): string` — returns a junction/branch piece id if the component has one (and it isn't the dragged piece); else the far piece (max joint-distance from the dragged piece around the component).
  - `function solveFollow(pieces, draggedPieceId, target: { x: number; y: number }): FlexState` — iterative relaxation (CCD-style: walk joints from anchor to dragged piece, rotate each toward the target within ±budget, a few iterations). Returns the flex that best brings the dragged piece's handle to `target` within budget. Pure.

- [ ] **Step 1: Write the failing tests** (behavioral contract for the solver)

```typescript
import { describe, expect, it } from 'vitest';
import { selectAnchor, solveFollow } from './flex-solver.js';
import { effectivePoses, FLEX_BUDGET_DEG } from './flex.js';

describe('selectAnchor', () => {
  it('prefers a junction piece as the anchor', () => {
    const layout = buildLoopWithOneJunction(); /* junction id 'JN' */
    expect(selectAnchor(layout, 'someCurve')).toBe('JN');
  });
  it('falls back to the far piece when there is no junction', () => {
    const circle = buildEightCurveCircle(); /* ids C0..C7 */
    expect(selectAnchor(circle, 'C0')).toBe('C4'); /* opposite */
  });
});

describe('solveFollow', () => {
  it('every joint stays within ±budget', () => {
    const circle = buildEightCurveCircle();
    const flex = solveFollow(circle, 'C0', { x: /* C0 handle + 40mm outward */ } );
    for (const jf of flex.values()) expect(Math.abs(jf.deg)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 1e-6);
  });
  it('moves the dragged piece toward the target (within reachable budget)', () => {
    const chain = buildOpenChainOfFive();
    const target = { x: /* a point a few mm off the rest handle */ };
    const flex = solveFollow(chain, chain[4]!.id, target);
    const poses = effectivePoses(chain, flex, selectAnchor(chain, chain[4]!.id));
    const handle = poses.get(chain[4]!.id)!;
    /* closer to target than the rest pose was */
    expect(dist(handle, target)).toBeLessThan(dist(restHandle, target));
  });
});
```

- [ ] **Step 2–4:** Run-fail / implement CCD relaxation + anchor selection / run-pass.
Run: `pnpm --filter @trainframe/simulator test -- flex-solver`. Keep iterations bounded (e.g. ≤16) and the function pure/deterministic. Complete implementation required; the tests above are the contract.

- [ ] **Step 5: Commit**

```bash
git add packages/simulator/src/track/flex-solver.ts packages/simulator/src/track/flex-solver.test.ts
git commit -m "track: flex solver — anchor selection + follow-cursor relaxation"
```

---

### Task 6: Flex solver — close mode (feasibility + solution)

**Files:**
- Modify: `packages/simulator/src/track/flex-solver.ts`
- Test: `packages/simulator/src/track/flex-solver.test.ts`

**Interfaces:**
- Consumes: Task 5 internals, `getEndpointsAt`, `effectivePoses`.
- Produces:
  - `interface ClosureResult { readonly feasible: boolean; readonly flex: FlexState }`
  - `function solveClose(pieces, draggedPieceId, freeEndpointIdx: number, targetEndpoint: { x: number; y: number; outgoingAngleDeg: number }): ClosureResult` — solves for flex that brings the dragged piece's free endpoint onto `targetEndpoint` in BOTH position (≤ ~1 mm) and heading (anti-parallel within ~1°), within every joint's budget. `feasible: false` if no within-budget solution exists.

- [ ] **Step 1: Write the failing tests**

```typescript
describe('solveClose', () => {
  it('closes a near-complete ring whose residual is within total budget', () => {
    const almost = buildRingOnePieceShortByOneDegreePerJoint(); /* closable */
    const res = solveClose(almost, draggedId, freeIdx, targetEp);
    expect(res.feasible).toBe(true);
    const poses = effectivePoses(almost, res.flex, anchorId);
    expect(gapAt(poses, freeIdx, targetEp)).toBeLessThan(1.0);
  });
  it('refuses when the residual exceeds the combined budget', () => {
    const tooFar = buildRingWithA30mmGap(); /* needs > 2°×N */
    expect(solveClose(tooFar, draggedId, freeIdx, targetEp).feasible).toBe(false);
  });
});
```

- [ ] **Step 2–4:** Run-fail / implement (the closure constraint is the cursor-target replaced by a pose constraint on the free endpoint; reuse the relaxation, add a feasibility check on the final residual + per-joint clamp) / run-pass.
Run: `pnpm --filter @trainframe/simulator test -- flex-solver`.

- [ ] **Step 5: Commit**

```bash
git add packages/simulator/src/track/flex-solver.ts packages/simulator/src/track/flex-solver.test.ts
git commit -m "track: flex solver — loop closure feasibility + solution"
```

---

### Task 7: Toybox — flex state + effective-pose plumbing (no interaction yet)

Make the toybox *able* to hold flex and render/compile through effective poses, before wiring any drag behavior. After this task, setting flex state programmatically bends the rendered/compiled layout; dragging is unchanged.

**Files:**
- Modify: `packages/simulator-ui/src/components/ToyTable.tsx`
- Modify: the rebuild path consumer (`toy-hardware.ts` `syncLayout`/`rebuildDevices`) so compilation uses effective poses.
- Test: `packages/simulator-ui/src/components/ToyTable.flex.test.tsx` (component/render test) or a focused unit test on the effective-pieces helper.

**Interfaces:**
- Consumes: `FlexState`, `effectivePoses`, `getEndpointsAt`, `buildJoints`, `selectAnchor`.
- Produces:
  - In `ToyTable`: `const [flex, setFlex] = useState<FlexState>(new Map())`.
  - A helper `applyFlex(pieces: ReadonlyArray<TrackPiece>, flex: FlexState): ReadonlyArray<TrackPiece>` that returns pieces whose `position`/`rotationDeg` are replaced by their effective pose (rotation widened to `number` via an effective-piece type — define `type EffectivePiece = Omit<TrackPiece,'rotationDeg'> & { rotationDeg: number }`, and make the render + compile paths accept `EffectivePiece`). Anchor per connected component.

- [ ] **Step 1: Read the render + rebuild call sites** (`ToyTable.tsx:2570-2647`, `2798-2976`; `toy-hardware.ts:412-457`) to see exactly where `pieces` flows into render and into `compileLayout`. The plumbing replaces those `pieces` reads with `applyFlex(pieces, flex)`.

- [ ] **Step 2: Write the failing test** — render `ToyTable`, programmatically set a flex on a known joint, assert the rendered piece group transform reflects the bent (non-45°) rotation (read the `data-piece-id` group's transform attribute). Use the ui-kit/test-setup render idiom.

- [ ] **Step 3–4:** Implement `applyFlex` + thread effective pieces into render and `compileLayout`; run-pass.
Run: `pnpm --filter @trainframe/simulator-ui test -- ToyTable.flex`

- [ ] **Step 5: Commit**

```bash
git add packages/simulator-ui/src/components/ToyTable.tsx packages/simulator-ui/src/sim/toy-hardware.ts packages/simulator-ui/src/components/ToyTable.flex.test.tsx
git commit -m "toybox: flex state + effective-pose plumbing into render and compile"
```

---

### Task 8: Toybox — live flex on slow drag + velocity gate + detach on fast yank

**Files:**
- Modify: `packages/simulator-ui/src/components/ToyTable.tsx` (drag handlers `2451-2485`, `2839-2879`)
- Test: extend `ToyTable.flex.test.tsx`

**Interfaces:**
- Consumes: `solveFollow`, `selectAnchor`, `setFlex`, the existing drag state ref.
- Produces: pointer-velocity tracking in the drag ref (`lastX/lastY/lastTime`), a `DRAG_FLEX_MAX_SPEED_MM_PER_S` constant (default by feel, start ~1500), and drag-move behavior: slow → `setFlex(solveFollow(...))` (live bend); fast → detach the dragged piece (remove from `pieces`, it follows the cursor as a free placement per existing logic).

- [ ] **Step 1: Write the failing tests** — simulate a slow drag of a piece in a chain → assert the chain's effective poses bend (a downstream piece's rendered rotation changes within ±2°). Simulate a fast drag (large delta, small dt) → assert the dragged piece detaches (its joint to the neighbor is gone; it's now free). Use fake timers / explicit timestamps (no `Date.now()` — feed timestamps into the handler).

- [ ] **Step 2–4:** Run-fail / implement velocity gate + live solveFollow + detach / run-pass.

- [ ] **Step 5: Commit**

```bash
git commit -am "toybox: live flex on slow drag; fast yank detaches"
```

---

### Task 9: Toybox — closure flash + commit

**Files:**
- Modify: `packages/simulator-ui/src/components/ToyTable.tsx`
- Test: extend `ToyTable.flex.test.tsx`

**Interfaces:**
- Consumes: `solveClose`, `findLoops`, the drag handlers, `CONNECT_CAPTURE_MM`.
- Produces: during a slow drag, when the dragged piece's free endpoint is within `CONNECT_CAPTURE_MM` of an open endpoint and `solveClose(...).feasible`, set a `closureAvailable` flag → the dragged piece renders a flash class (`data-closure-available="true"`). On drop with closure available, commit the solved flex (`setFlex`), keep the piece, and the layout closes.

- [ ] **Step 1: Write the failing tests** — slow-drag a near-closing piece so its free end approaches the target → assert `data-closure-available="true"` appears on the dragged piece; drop → assert `findLoops(applyFlex(pieces, flex))` now returns the cycle (loop closed).

- [ ] **Step 2–4:** Run-fail / implement / run-pass.

- [ ] **Step 5: Commit**

```bash
git commit -am "toybox: closure flash on drag + commit closes the loop"
```

---

### Task 10: Toybox — over-pull detach (slow drag past budget) + remainder holds shape

**Files:**
- Modify: `packages/simulator-ui/src/components/ToyTable.tsx`
- Test: extend `ToyTable.flex.test.tsx`

**Interfaces:**
- Consumes: `solveFollow` (its returned flex saturates at budget), the drag handlers.
- Produces: when a slow drag's target is beyond what `solveFollow` can reach (the solved dragged-piece handle stays > a threshold from the cursor after solving, i.e. joints saturated), detach the dragged piece; the remaining pieces keep their current `flex` (shape holds — do NOT clear flex on detach).

- [ ] **Step 1: Write the failing test** — slow-drag a chain-end piece far beyond budget → assert it detaches AND a previously-bent neighbor's effective pose is unchanged after the detach (remainder holds its shape).

- [ ] **Step 2–4:** Run-fail / implement saturation-detach / run-pass.

- [ ] **Step 5: Commit**

```bash
git commit -am "toybox: over-pull detaches; remainder holds its flexed shape"
```

---

### Task 11: Closure wave overlay

**Files:**
- Create: `packages/simulator-ui/src/components/ClosureWave.tsx`
- Modify: `packages/simulator-ui/src/components/ToyTable.tsx` (mount the wave; trigger on close)
- Test: `packages/simulator-ui/src/components/ClosureWave.test.tsx`

**Interfaces:**
- Consumes: a closed `Loop` (Task 3) + effective poses → the ordered rail centerline points (sample `getCentreLinePathAt` for each loop piece). React render only; animation via CSS/requestAnimationFrame with an injected clock (no `Date.now()` — accept a time source prop defaulting to `performance.now` but overridable in tests).
- Produces: `ClosureWave({ pathPoints, durationMs, onDone })` — renders a glow pulse travelling the polyline once, then calls `onDone`. ToyTable triggers it when a drop closes a loop (or any edit completes a cycle), passing the loop's centerline.

- [ ] **Step 1: Write the failing test** — render `ClosureWave` with a simple polyline and a controllable clock; advance time → assert the pulse position advances along the path and `onDone` fires after `durationMs`. Assert `data-testid="closure-wave"` present during, absent after.

- [ ] **Step 2–4:** Run-fail / implement / run-pass.

- [ ] **Step 5: Commit**

```bash
git add packages/simulator-ui/src/components/ClosureWave.tsx packages/simulator-ui/src/components/ClosureWave.test.tsx packages/simulator-ui/src/components/ToyTable.tsx
git commit -m "toybox: one-shot closure wave along a newly-closed loop"
```

---

### Task 12: Physics-canvas behavior test — a flexed-closed loop is continuous and laps

**Files:**
- Create: `packages/integration/src/flex-closed-loop.test.ts` (or `packages/simulator-ui/src/sim/flex-closed-loop.test.ts` — match where `train-power.test.ts` lives)

**Interfaces:**
- Consumes: the flex solver + `applyFlex` + `compileLayout`, and the physics test harness pattern from `train-power.test.ts:54-103` (`startPhysicsEnv(...)`, spawn train, assert `marker_traversed` events).

- [ ] **Step 1: Write the test** — build a ring that's one-degree-per-joint short of closing; solve closure; apply the flex; compile the layout; spawn a train; advance; assert the train traverses all the loop's markers in order and laps (returns to start) without derailing — proving the flexed geometry is a continuous rail.

- [ ] **Step 2: Run** — `pnpm --filter @trainframe/integration test -- flex-closed-loop` (or the simulator-ui filter). Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git commit -am "test: a flexed-closed loop compiles to a continuous rail a train laps"
```

---

### Task 13: ui-tests — toybox flex/closure/wave journey

**Files:**
- Create: `packages/ui-tests/tests/toybox-flex-closure.spec.ts`

**Interfaces:**
- Consumes: the toybox harness + helpers (model: `toybox-junction-probe.spec.ts:30-106`), data attributes `[data-piece-id]`, `[data-testid="piece-{id}"]`, `[data-testid="toy-table-canvas"]`, and the new `data-closure-available` / `data-testid="closure-wave"`.

- [ ] **Step 1: Read the model spec + helpers** (`toybox-junction-probe.spec.ts`, `packages/ui-tests/src/playwright-helpers.ts`) for the place-piece + drag idiom.

- [ ] **Step 2: Write the journey spec** — build a nearly-closed loop by placing pieces; slow-drag the closing piece toward the start endpoint → assert `data-closure-available="true"` flashes on it; release → assert the wave (`data-testid="closure-wave"`) appears then disappears, and the loop is closed (piece count / connectivity). Add a second case: a circle with an open junction spur closes and waves (the spur stays open). Add a third: a fast yank on a piece detaches it (count drops, no flex).

- [ ] **Step 3: Run** — `pnpm --filter @trainframe/ui-tests test -- toybox-flex-closure`. (ui-tests run against built output — rebuild `simulator`/`simulator-ui` first if needed.) Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -am "ui-tests: toybox flex/closure/wave journey + spur + fast-yank cases"
```

---

## Final verification

- [ ] `pnpm --filter @trainframe/protocol --filter @trainframe/core build` (deps), then `pnpm -w typecheck && pnpm -w lint && pnpm -r test` — all green, coverage floors held.
- [ ] Live smoke (optional, against the dev stack): open the toybox, build a near-loop, slow-drag the last piece — watch it bend and flash, drop, see the wave; fast-yank a piece to pull it out; confirm a circle-with-spur still closes.

## Self-review notes (resolved during planning)

- **Flex can't live in `TrackPiece`** (quantized `rotationDeg`) → represented as per-joint δ composed into continuous effective poses (Tasks 2, 4, 7).
- **The 30 mm bug** is `isCoincidentWithAnother` not excluding same-piece endpoints (Task 1) — confirmed against `placement.ts:92`.
- **Anchor model** (junction → far point) is the resolution of the 8-curve-circle thought experiment (Task 5).
- **Persistence/hold-shape:** flex is never cleared on detach (Task 10); rest-relative clamp prevents drift (Task 4).
- **Solver tasks are TDD-by-contract:** the tests pin behavior (within-budget, moves-toward-target, closes/refuses); the iteration is the implementer's, bounded and deterministic.
- **Parallelism:** Tasks 1, 3, and 4 are independent pure modules (different files) and can run concurrently; Task 2 is independent too. Tasks 5–6 depend on 4 (+3). Tasks 7–11 are all in `ToyTable.tsx` and must serialize. Tasks 12–13 can run in parallel at the end.
