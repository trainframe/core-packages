# ADR-011: A section is an edge plus its two boundary markers

## Status

Accepted

Amends [ADR-002](002-clearance-model.md) ("Clearance model"). ADR-002's
description of block exclusivity ("an edge already cleared to another
train always denies") is the *old* rule. This ADR replaces it with a
strictly stronger rule.

## Context

Before this ADR, the scheduler's block-exclusivity check was edge identity:
two clearances conflicted only when they referenced the *same*
`(from_marker_id, to_marker_id)` pair. That worked for the trivial linear
case but left two real-world classes of correctness gap:

1. **Crossings.** At a figure-8 crossing marker X, the four incident edges
   (`R_SE→X`, `X→L_NW`, `L_SW→X`, `X→R_NE`) are four distinct edge
   identities. The old rule granted clearance to two trains transiting X
   on opposite diagonals at the same instant. On a real diamond crossing
   they'd physically share rail at X; the system saw no conflict and
   permitted simultaneous occupancy.
2. **Following spacing on a straight loop.** On `M1→M2→M3→M4→M1`, a
   chaser given clearance for `M1→M2` while the leader was on `M2→M3`
   would be granted, leaving the two trains nose-to-tail at M2 the instant
   the leader vacated. Nothing in the rule enforced one-block separation.

Both gaps came from the same modelling error: a section was treated as a
disembodied identifier rather than as a piece of track *bounded by two
markers it shares with adjacent sections*.

The user — driving the demo and watching two trains converge at X —
called this out directly: the section should be the edge plus its
boundary markers, and the rule should be innate.

## Decision

A section is an edge **plus its two boundary markers**. Two sections
conflict when they share *any* boundary marker, not when they have the
same identity. The check becomes:

```ts
// scheduler.ts
private edgeConflictsWithAnotherTrain(trainId, edge): boolean {
  for (const other of this.trains.values()) {
    if (other.train_id === trainId) continue;
    for (const held of other.cleared_edges) {
      if (
        held.from_marker_id === edge.from_marker_id ||
        held.from_marker_id === edge.to_marker_id ||
        held.to_marker_id === edge.from_marker_id ||
        held.to_marker_id === edge.to_marker_id
      ) return true;
    }
  }
  return false;
}
```

This is the only scheduler change. Release logic is unchanged — edges
still leave `cleared_edges` when the head reports its `to_marker_id`. The
*lock set* a train transitively owns slides forward one section at a
time: at any moment, a train holds the markers spanning its currently
cleared edges.

### What this gives us, all from one rule

- **Crossings protected.** Every X-incident edge shares X with every
  other X-incident edge. As soon as one train holds any of them, the
  rest are denied to peers until X drops out of the holder's lock set
  (i.e. the train has moved past X).
- **Junctions protected.** Same logic applies to any marker with degree
  > 2.
- **One-block following spacing on a single loop.** A chaser cannot
  acquire the section behind the leader's current section while the
  leader still holds the boundary marker they share.
- **No new wire events, no new commands, no new capabilities.** Same
  retry path (`retryBlockedClearances`), same gating, same revocation —
  they all consult the new check.

### What it costs

- A handful of existing tests need their timing updated. The shift is
  always in the same direction: a follower's grant arrives later than
  before, after the leader has moved two markers past the contested
  point rather than one. Tests become stricter, not weaker.
- On a *physical* layout with a true crossover piece (where two tracks
  pass through the same spatial point without sharing metal — common in
  Brio sets), this rule incorrectly serialises. The model fix isn't to
  loosen the rule but to author the crossover as **two separate
  markers** at the same `x_mm,y_mm`, one for each track, connected only
  to its own loop. With no shared marker, no shared section, no
  conflict. Operators who want a "real" crossover layout author it that
  way; the scheduler stays innately safe.

### What it does not address

- **Trains longer than a single section.** Today the release filter
  fires on the head crossing the boundary marker, treating each train
  as a point. A long train's tail might still occupy the section behind
  it. Tail-aware release is handled in a follow-up: trains report
  `length_mm` at registration, the scheduler watches `train_status`
  events and defers release until `distance_into_edge_mm >= length_mm`.
  Out of scope for this ADR.
- **Deadlock detection.** Two trains in a head-on standoff on a
  single-track section between passing loops still produce the same
  cycle they always have. Deadlock detection (per ADR-010 §"Deadlock")
  remains a future ADR.
- **Layouts with intentional shared markers used by separate tracks.**
  See "crossover piece" note above — those need an authoring change,
  not a code change.

## Consequences

- **Behaviour change is global.** Every scheduler — embedded in the
  sim-ui or running in `@trainframe/server` — applies the new rule from
  this commit forward. No flag, no opt-in.
- **Existing tests shift.** The two tests in `scheduler.test.ts` that
  relied on edge-equality timing now expect the stricter follow-on
  behaviour. Integration tests pass unchanged because their scenarios
  use widely-separated edges.
- **Two new tests document the guarantee.** One asserts
  one-block-separation on a single loop, the other asserts
  no-simultaneous-crossing at a figure-8 X.
- **Crossing protection is now a property of the protocol, not a
  capability.** No `core.protects_crossing` capability, no
  `CROSSING-X` virtual device — the safety comes from the section
  definition itself. This matches the operator's mental model:
  "obviously two trains can't be at the same place at the same time."
- **The `data-cleared-to` overlay** (ADR-010's follow-up: live
  clearance visualisation) will render the boundary-marker semantics
  visibly — when a chaser is held behind the leader, the operator can
  see *which* marker is locked and *why*.
