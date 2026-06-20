# Track flex & loop closure

Date: 2026-06-20
Status: approved design, pending implementation plan

## Problem

Building a closed loop in the toybox is fiddly and often impossible. Track
pieces are rigid: headings are hard-quantized to 45° and lengths are discrete,
so the cumulative transform of a run almost never returns exactly to its start.
Two pain points follow:

1. **You can't tell when a loop *can* close** — there's no feedback that the
   open end is close enough to meet another endpoint.
2. **Even when it's close, it won't meet** — real wooden track closes because it
   *flexes*; ours has no give, so the final piece leaves a gap or overlaps.

Separately, there's a concrete bug: the **smallest straight piece (30 mm) can't
be snapped to at its ends**.

This is entirely a **physics-world / toybox geometry** concern. It does not
touch the core scheduler, the protocol, devices, or MQTT.

## Goals

- Track flexes like real wooden track: joints have a small, bounded give, so a
  near-closed loop can be nudged shut.
- Closing is **live and visible**: as you drag a piece, the connected line bends
  to follow your hand, and when a closure is achievable the dragged piece
  flashes — you see the bent, closed shape before releasing.
- Works for **local loops**: a cycle anywhere in the connectivity graph counts,
  spurs ignored — a circle with an open junction branch is a valid closed loop.
- A closed loop is **geometrically continuous** — a physics train can run it.
- A **one-shot wave** travels a loop the moment it closes.
- Fix the 30 mm-straight snapping bug.

## Non-goals

- No editing UI on the ADR-030 physics-world canvas (it stays a test surface).
- No core/protocol/device/MQTT changes.
- No "perfect closing piece" synthesis (the rejected option B).
- No full soft-body/friction simulation — flex is a bounded kinematic model, not
  a physics solve with mass.

## The flex model

**Persistent, bounded, rest-relative.** Each piece keeps its canonical **rest
pose** — the 45°-quantized, exact-length transform it snaps to. Each *joint*
carries a flex deviation δ (a small heading change plus ≤2 mm positional give).

- **Persistent:** δ *sticks*. The line holds whatever shape you bent it into.
  Pulling a piece out of a flexed loop leaves the remainder in its bent shape —
  it does **not** spring back to perfect.
- **Bounded, rest-relative:** δ is hard-clamped to ±budget *from the joint's rest
  heading* (default **±2° per joint**). The clamp is absolute-from-rest, so flex
  can never drift past the physical limit no matter how many times it's re-bent
  — it holds its shape but never runs away.
- The clamp is what produces detachment: within it the joint bends to follow you;
  at the limit, further pull detaches the piece (see Drag interaction).

A piece's world transform is its rest pose composed down the chain with each
upstream joint's δ (forward kinematics). δ is stored per joint as part of the
toybox layout state.

## Anchoring a drag

To deform rather than rigidly slide, a drag pins **one reference** and
distributes the bend across the joints between it and the dragged piece. (Pin
nothing → the whole assembly slides rigidly with no bend; pin everything-but-one
→ the piece is trapped between fixed neighbours. Neither is wanted; pinning a
single reference is the resolution — verified against the 8-curve-circle thought
experiment.)

Reference selection, in order:

1. **Junctions / branch pieces are anchors.** A junction wired into more than
   one loop is the most-constrained piece on the table, so it's the natural
   fixed reference. If the dragged piece's connected component contains
   junction/branch pieces, those are pinned and the bend distributes between them
   and your hand.
2. **Otherwise, the far point.** For a loop, the piece roughly opposite the
   dragged one; for an open chain, the far end. Dragging then ovalises a ring
   (most movement at your hand, the opposite side ~still, both arms sharing the
   bend) or bends an open line like a ruler held at the far end.
3. **Dragging a junction itself:** it can't anchor — each loop it joins flexes
   against its own far point.

## Drag interaction

A **velocity gate** disambiguates intent:

- **Slow, deliberate drag → flex.** Each frame, an iterative relaxation solve
  (CCD/FABRIK-style, a few iterations — cheap for the small chains involved)
  finds joint δ within budget that moves the dragged piece toward the cursor,
  pinned per the anchor rules. The flexed chain renders live.
- **Fast yank → detach, no flex.** Above a tunable pointer-speed threshold, the
  solve is skipped and the dragged piece detaches immediately and comes free.

The two over-pull paths unify: a fast yank detaches instantly; a slow drag
detaches only once the joints between hand and anchor max out. On detach the
dragged piece comes **fully free** (a piece closed on both sides releases from
*both* neighbours at once, rather than dangling), and the remainder **holds its
flexed shape**. A freed piece re-snaps normally wherever it's dropped.

## Closure

- **Local-loop detection:** cycle detection on the endpoint-connectivity graph
  finds closed loops, ignoring spurs. An open junction branch is not part of the
  cycle, so a circle-with-a-spur is a valid loop.
- **Flash affordance:** while dragging, when the held piece's free endpoint comes
  within capture of another open endpoint *and* a closing solution exists within
  the joints' combined budget, the held piece **flashes** — "a valid closure is
  available right now." This *is* the "can it close" feedback; it replaces a
  separate indicator.
- **Commit:** release with a valid closure → the flexed solution commits, the
  cycle closes, and the loop becomes geometrically continuous.
- **Infeasible:** gap beyond budget → no flash; release falls back to today's
  rigid placement.

## The wave

The moment a loop closes (commit of a closing drag, or any edit that completes a
cycle within budget), a **one-shot glow pulse** travels the loop's ordered rail
centerline once (~1 s) and ends. Not a persistent shimmer. Rendered in the
toybox. A loop with a spur waves around the *cycle* only.

## The 30 mm-straight bug (separate first step)

Root cause: the occupancy/clustering tolerance (`SNAP_DISTANCE_MM = 30`) is ≥ the
30 mm piece's own length, so when one end snaps, the piece's *other* endpoint is
within 30 mm of it and is treated as already-connected — its ends stop
registering as snap targets.

Fix: a piece's **own** endpoints must be excluded from its occupancy check (an
endpoint can't be "blocked" by its sibling on the same piece). TDD'd and shipped
on its own before the flex work, since it's a clear standalone defect.

## Architecture

Pure geometry in the shared track package; interaction and wave in the toybox;
the physics canvas only verifies results.

- **`packages/simulator/src/track/flex.ts` (pure)** — the flexible-chain model:
  rest poses, per-joint δ, clamping, and forward-kinematics world transforms.
- **`packages/simulator/src/track/loops.ts` (pure)** — cycle detection over the
  endpoint-connectivity graph; returns each local loop as an ordered piece/edge
  ring, spurs excluded.
- **`packages/simulator/src/track/flex-solver.ts` (pure)** — iterative relaxation
  with two modes: **follow** (dragged piece → cursor, within per-joint budget,
  given pinned anchors) and **close** (does a δ-within-budget solution bring the
  free endpoint onto a target open endpoint in position *and* heading? → yes/no +
  solution). Anchor selection (junctions → far point) lives here as a pure input.
- **Toybox UI (`ToyTable` and its placement/drag handlers)** — wires the solver
  into dragging: velocity gate, live flexed render, closure flash, detach, commit;
  and renders the closure wave. On commit, the existing rebuild-on-edit path
  recompiles the world from the flexed transforms.
- **Physics-world canvas** — unchanged as an editor; used as a *test* surface to
  prove a flexed-closed loop yields a continuous `RailNetwork` a train laps.

## Data flow

```
Toybox drag (pointer + velocity)
  └─ slow → flex-solver.follow(chain, anchors, cursor)  → flexed δ → live render
  │         └─ near open endpoint → flex-solver.close(...) → flash if feasible
  └─ fast → detach (no solve)
Release with feasible closure
  └─ commit flexed δ → loops.ts confirms cycle closed
     └─ rebuild PhysicsWorld/RailNetwork from flexed transforms (existing path)
     └─ toybox plays the one-shot wave along the loop
```

## Edge cases & error handling

- Over-pull (fast, or slow past budget) → detach, piece fully free, remainder
  holds shape.
- Multiple candidate closure endpoints in range → nearest wins.
- Free-floating chain (no anchor / nothing else placed) → drag translates
  rigidly until an end snaps; no flex needed.
- Dragging a junction → flex each connected loop against its own far point.
- A spur on a closed loop → ignored by cycle detection; wave runs the cycle only.
- Flex never compounds (rest-relative clamp), so repeated bend/detach/re-add is
  stable and repeatable.

## Testing

- **Pure unit (`packages/simulator/src/track/`):** flex clamps to ±budget and is
  rest-relative (no compounding across remove/re-add); solver `close` succeeds
  within budget and refuses beyond it; solver `follow` distributes bend and
  respects anchors; `loops.ts` finds the cycle and ignores a spur; the 30 mm
  snapping fix.
- **Toybox ui-tests (Playwright):** drag a closing piece slowly → it flashes →
  release → loop closes → wave plays; a fast yank detaches without flexing; a
  circle-with-open-junction-spur closes and waves.
- **Physics-world canvas (behavior):** a flexed-closed loop compiles to a
  continuous `RailNetwork` and a train laps it without derailing.

## Tunable constants

- Per-joint flex budget: **±2°** heading, **≤2 mm** positional give.
- Velocity gate threshold: chosen by feel during implementation, exposed as a
  named constant.
- Closure capture distance: reuse the existing endpoint capture (`CONNECT_CAPTURE_MM`).

## Decisions

- **Global relaxation, capped per joint** (not last-joint absorption, not a
  synthesized closing piece).
- **Flex is persistent state**, clamped ±budget *from rest* — holds its shape,
  never reverts, never drifts.
- **Single far reference** anchors a drag; **junctions are preferred anchors**.
- **Velocity gate:** slow drag flexes, fast yank detaches without flexing.
- **Over-pull detaches the piece fully**; the remainder keeps its bend.
- **Live flex during drag** (not solve-on-release) for the clearest feedback.
- **Toybox is the build surface**; the physics-world canvas stays test-only.
