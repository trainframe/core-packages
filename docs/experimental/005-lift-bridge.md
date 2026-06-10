# Experimental device 005: Lift bridge

**Status:** speculative viability test. NOT normative; not expected in a typical
setup.

**Built (June 2026), untested:** toy-table piece in the Experiments tray (`lift-bridge`
in `pieces.ts`) — two fixed wooden approaches with a visible seam, and the
hinged span as a separate sub-shape. The raised state reads as a LIFT, not a
swing: seen from above, the leaf **foreshortens toward its hinge** (plan-view
length compresses as it tilts up), its dark underside end face comes into view
at the free end, it floats on a longer cast shadow, and the gap opens beyond
it. The proof runs: scanning registers `BRIDGE-{piece.id}` with
`core.gates_clearance` (a real `VirtualGate`); the "Raise span" affordance
withholds clearance across the bridge's own marker the instant it is pressed,
and "Lower span" grants it — the drawn deck state is read off the gate, so the
picture can never disagree with the wire. Confirmed-clear-before-raising
remains the open question below.

**Proves:** that `core.gates_clearance` carries a **"the track is physically not
there right now"** fact for a reason the core never models — and that this needs
no new seam. A bascule/lift bridge that raises a span to let something pass
*underneath* withholds clearance across its marker while raised, and grants it
when lowered and seated. The core never learns what a "bridge" is, or why it is
up; it sees a capability-bearing device withholding clearance, identical to a
level-crossing gate withholding for road traffic. If a train correctly waits for
the span to come down and seat, the clearance model has been shown to express
*physical track availability*, not just *traffic policy*.

## What it is

A section of track on a hinged or lifting span. Normally the span is down and
seated, the rails are continuous, and trains run across as if it were a straight.
On demand the span **raises** (one end tilts up, or the whole deck lifts),
breaking the rail so that some other entity — a boat on a waterway beneath, a road
vehicle, a taller train on a lower deck — can pass under. While raised, no train
may enter the span. When the entity has passed, the span lowers, re-seats, and
trains resume. The passing entity itself is **out of scope** — the system models
only that the bridge is up or down.

## Capabilities it declares

- `core.gates_clearance` — it withholds and grants clearance for entry onto the
  span's marker, exactly as a level-crossing gate does. This is its entire
  protocol identity.
- A marker on the layout for the span itself (it is real track when down).

## API events and data it acts on

- **Emits** a clearance withhold across its span marker whenever the span is
  raised (or in transit), and a grant once it is lowered **and seated**. This is
  the ordinary `core.gates_clearance` interaction — the same machinery
  [ADR-018](../adr/018-multi-gate-semantics.md) reasons about when several gates
  cover one marker.
- **Emits nothing about the entity underneath.** There is no `boat_passing`
  event, no waterway model, no reason code. The bridge is up; that is all the wire
  carries. *Why* it is up is a device-local decision (a button, a timer, a sensor
  the device owns) the core never sees.
- The scheduler holds any train routed across the span at the span's approach
  until clearance is granted — the existing withhold-holds-the-train behaviour, no
  new logic.

## Action-oriented goal

Make the span's track conditionally unavailable: raise (withhold), let the
out-of-scope entity pass, lower and seat (grant). A train routed across simply
waits at the approach while the span is up.

## How the held state is guaranteed (the cross-cutting question)

This is the **inverse** of the crane ([003](003-crane-cargo-station.md)) and
decoupler ([004](004-wedge-decoupler.md)): where those pin a train *in place* to
work on it, the bridge holds trains *out* of a region while it works. Both are the
same primitive — withhold clearance — pointed in opposite directions. The bridge's
safety rule is simply: **never grant entry until the span is down and seated**,
and **withhold the instant a raise is requested**, with the span only beginning to
move once the marker is confirmed clear of any train. Because default state is
withheld/safe (the clearance model's core invariant), a bridge that loses power or
crashes mid-cycle fails to "no entry," which is correct.

## Visible goal

A real operator should see the **span lift and a train wait**: a length of track
tilts or rises, opening a gap; a train approaching from either side slows and
holds at the edge; when the span lowers and clicks back into line, the train rolls
across. The cause-and-effect ("the bridge is up, so the train waits") is readable
purely from the geometry — no status text needed.

## Toy-box element & animation

- **Shape:** a wooden span like a straight, but visibly a **separate hinged
  deck** — a beech plank with a pivot fitting (a small `metal` feature) at one
  end and a seam where it parts from the fixed approaches. It is *track*, so it
  stays wooden (ADR-024 §4), unlike the manufactured crane/decoupler/gate bodies.
- **Animation:** the span **tilts up** about its pivot (in top-down, faked as the
  free end foreshortening + a lengthening cast shadow, or a simple hinge-rotate of
  the plank), opening a dark gap in the rail; a waiting train sits at the approach.
  On lower, the plank swings back and the grooves re-align with the fixed
  approaches. The animated unit is a *whole sub-piece pivoting*, a different motion
  again from the turntable's spin and the crane's trolley-and-hook.
- **Hand-wave:** the lift mechanism, the trigger (what decides to raise it), and
  the entity passing under are all out of scope. The geometry of a plank that
  visibly parts from its neighbours and tilts is the real spatial task.

## Why it's experimental, not the norm

- Opening bridges are a set-piece; ordinary layouts have continuous track.
- The value is showing that `core.gates_clearance` already expresses *physical
  availability of track*, not merely *right-of-way policy* — a withhold can mean
  "there is literally no rail here right now," and the train-holds-at-approach
  behaviour is identical. It also exercises [ADR-018](../adr/018-multi-gate-semantics.md)
  territory if a bridge and another gate cover overlapping markers.
- Nothing here suggests the core should model bridges, waterways, or the entity
  beneath. If a future feature wants the system to *coordinate* the bridge with
  the thing passing under (a scheduled boat), that is a new conversation and an
  ADR — this entry proves the bridge needs none of it to function as track that
  comes and goes.

## Open questions (for the someday-session that builds it)

- **Span geometry.** A plank that parts from and re-seats with its neighbours,
  and how snapping/overlap treat a piece whose rails are sometimes discontinuous.
- **Confirmed-clear before raising.** The device must verify no train occupies the
  span before it begins to lift; this is a held-state + occupancy check worth an
  explicit crossing test (cf. the scheduler cross-feature occupancy concerns).
- **Where it lives.** A satellite device (e.g. `trainframe/lift-bridge`) declaring
  only `core.gates_clearance` + the marker role. Core untouched.
