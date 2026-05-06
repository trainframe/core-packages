# ADR-004: Edge-based routes

## Status

Accepted.

## Context

A route assigned to a train needs an unambiguous representation of "where to go." The natural choice was an ordered list of markers: `[A, B, C, D]`.

But this fails on layouts where the same marker appears more than once: figure-8s, loops, shunting moves. A route `[A, B, C, B, D, A]` is unambiguous to write, but when the train reports `marker_traversed: B`, the server can't tell which B: the second visit, or the train going backward through the first?

The clearance system, the route progress index, and the visualiser all need to disambiguate.

## Decision

Routes are sequences of *edges*, not markers. Each edge is a `{ from_marker_id, to_marker_id }` pair. A route through a figure-8 looks like `[A→B, B→C, C→B, B→D, D→A]`. Each edge is unique even though B appears multiple times.

Train progress is "I am on edge index N of M": unambiguous regardless of how many times the route revisits any marker.

`marker_traversed` events carry an `inferred_edge` field that tells consumers which edge the train is now on, computed by the server from the route plus the marker that was just crossed.

## Consequences

- Routes are slightly more verbose to read and write. We accept this for unambiguity.
- The clearance system aligns naturally: clearances are granted for sequences of edges, blocks are edges, exclusivity is per-edge.
- Layouts with passive (manually-flicked) junctions work without changes: the route says which exit edge to take, the kid flicks the switch, the train traverses the chosen edge and reports its `marker_traversed` with the correct `inferred_edge`.
- The visualiser renders routes as paths through the graph, which it had to do anyway. No extra work.
- Building routes by hand is annoying for trivial layouts. A helper that converts marker sequences to edge sequences is a quality-of-life feature; it's a one-line lookup so the helper is cheap.
