# Experimental device 002: Turntable junction (N-way)

**Status:** speculative viability test. NOT normative; not expected in a typical
setup.

**Proves:** that the switch seam is **already N-way** and a junction is not
limited to two exits. A rotating turntable that aligns its single bridge rail to
any one of three (or more) radiating tracks is, to the scheduler, *just a switch
with more position strings*. If a train can route through it end-to-end, the
"multi-way junction" the protocol already advertises is real, and the only thing
missing from a 3-way junction is **spatial** (a piece shape with >2 exits) and
**device-timing** (rotate, then confirm), never a core change.

## What it is

A circular turntable track piece, the size of a junction, with one short
**bridge rail** across its diameter and three or more stub tracks radiating from
its rim. The deck rotates to line the bridge up with a chosen stub; a train then
runs straight across onto that stub. Functionally it is a 3-way (or N-way)
junction whose "branch selection" is an angle rather than a thrown point blade.
Strip the rotation and it is an ordinary junction marker.

## The seam it leans on (already exists — verify in code)

Nothing here is hand-waved at the protocol layer; the seam is built:

- `switch_state_changed { junction_marker_id, position, confirmed }` —
  `position` is a free `Type.String()`
  ([`events.ts`](../../packages/protocol/src/events.ts)), not a `through|branch`
  enum. Any number of distinct position labels are valid.
- `LayoutJunction.valid_positions` is `Type.Array(Type.String(), { minItems: 2 })`
  with the standing comment *"Custom positions enable multi-way junctions"*
  ([`layout.ts`](../../packages/protocol/src/layout.ts)). The N-way door was
  designed open.
- `LayoutState.activeOutgoingEdge` selects the live exit with
  `edges.find((e) => e.requires_switch_state === requested)`
  ([`layout-state.ts`](../../packages/core/src/scheduler/layout-state.ts)) — a
  string-equality match over *all* outgoing edges, with no arity assumption. A
  junction marker with three outgoing edges, each carrying a different
  `requires_switch_state`, resolves correctly today.

So a turntable marker with `valid_positions: ['stub-a', 'stub-b', 'stub-c']` and
three outgoing edges tagged to match is a routable, schedulable junction with no
new event, capability, or scheduler branch.

## Capabilities it declares

- `core.controls_switch` — it is the device that owns the junction marker's
  position and emits `switch_state_changed`. Identical declaration to a
  two-position point motor; only the set of positions it can confirm is larger.
- Whatever a junction marker needs to sit on the layout (it is a real
  `junction`-kind marker with N outgoing edges).

## Action-oriented goal

Place the bridge rail on the exit a route requires, so that a train arriving on
the trunk can run through onto the selected stub. The scheduler asks for a
position (via the same `set_switch_position` path a point motor receives); the
device rotates and, when aligned, emits `switch_state_changed { …, confirmed:
true }`.

## How the held state is guaranteed (the cross-cutting question)

A train must never roll onto a deck that is mid-rotation or aligned elsewhere.
This needs **no new mechanism** — it falls out of `activeOutgoingEdge`: while the
deck is rotating, the device has *not* confirmed a position matching the train's
intended edge, so there is no active outgoing edge and the scheduler holds the
train at the junction's approach exactly as it already holds for an unset point.
The turntable is "safe by default" in precisely the clearance sense the rest of
the system is: motion is the *absence* of a withhold, and an unaligned deck
withholds by simply not being aligned. The only device-honesty requirement is
that it not emit `confirmed: true` until the bridge is mechanically seated.

## Slow actuation: a longer hold, not a new problem

A point motor throws in a fraction of a second; a turntable deck may take several
seconds to swing 120° and seat. This is the one place a turntable genuinely
*differs* from an ordinary junction — but it differs in **duration, not in
mechanism**, and the existing seam already absorbs it. The scheduler's
switched-junction handling **requests** the switch early and then **stops on the
gap**, withholding clearance, until a confirmed `switch_state_changed` arrives —
"the horizon reaching a junction's divert/main edge requests the switch early,
then stalls there until `switch_state_changed` → `retryBlockedClearances` resumes
the walk" ([`scheduler.ts`](../../packages/core/src/scheduler/scheduler.ts),
STOP-ON-GAP). A turntable simply makes that stall *longer*: the train holds at the
approach for the rotation time instead of a point-throw time, and resumes the
instant the deck confirms. Nothing about correctness changes; the train is never
released onto a moving or mis-aligned deck.

What slow actuation *does* expose is a **throughput / ETA** question, not a safety
one: a planner that estimates transit lead times (ADR-010) would plan better if it
knew a turntable's expected actuation latency, so it does not treat a multi-second
swing as a free instant switch. That is a planner refinement (a per-device
actuation-time hint feeding lead-time estimation), explicitly **out of scope** for
this viability test — the seam works correctly today regardless; it would just
plan *tighter* with the hint. The device should still be honest in the meantime:
emit `confirmed: false` (or stay silent) for the whole rotation and `confirmed:
true` only when the bridge is mechanically seated.

## Visible goal

A real operator watching the table should see the **disc turn**: the circular
deck rotates about its centre, swinging its single bridge rail from one stub to
another, and the train waits at the rim until the rail clicks into line, then
runs straight across. The legibility win is that the *branch choice is a visible
angle* — you can see which way the train will go before it moves, unlike a point
blade that throws in a few millimetres.

## Toy-box element & animation

- **Shape:** a beech-wood **circle** (not the Y-fork junction silhouette), the
  diameter of a junction, with a single routed twin-groove bridge across the
  middle and short groove stubs at each rim exit. The round body is its own
  silhouette — like the junction and crossing it carries **no tint** (ADR-024
  §3); the circle reads on its own.
- **Animation:** the bridge rail (and its grooves) **rotate** about the deck
  centre to the selected stub angle, a short eased spin. A faint rim ring marks
  the fixed outer body so the rotation of the inner bridge is legible. On
  `confirmed`, a brief settle. This is the first piece whose *decoration moves
  relative to its body* — every other piece animates only as a whole — so it is a
  good stress of the renderer's per-feature transform.
- **Hand-wave:** the geometry of an N-exit round piece and its snap endpoints is
  not designed; that spatial work (and whether stubs are fixed at 120°/90° or
  free) is the real open task, deliberately out of scope here.

## Why it's experimental, not the norm

- Most layouts route fine on two-way points; a turntable is a set-piece, not a
  staple.
- The proof is the interesting part: it demonstrates the switch seam was N-way
  all along, converting a vague "could we do multi-way junctions?" into a
  concrete "yes — the wire and scheduler already do; build the *piece*." If it
  ever graduates, it is a spatial-layout + satellite-piece task, with an ADR for
  the round-piece geometry, not a protocol change.

## Open questions (for the someday-session that builds it)

- **Spatial geometry.** Endpoint angles, snap behaviour, and whether a round
  piece can co-exist with the rectangular snap grid the layout compiler assumes.
- **Rotate-through-occupied.** If the deck itself is a block a train sits *on*
  while crossing, rotating it under that train must be impossible — same
  held-state argument, but worth an explicit test (a train on the bridge holds
  the position).
- **Where it lives.** A satellite piece + device (e.g. `trainframe/turntable`),
  declaring only `core.controls_switch`. Core is untouched.
