# Experimental device 004: Wedge decoupler

**Status:** **superseded by [006 (railyard)](006-railyard.md)** — kept for the
analysis, not as a device to build. The railyard's wedge unit owns the
coupling-split job inside its own territory, and its `core.reports_length`
declaration covers the decrease direction this entry exists to prove. No
standalone decoupler piece ships in the toy-table Experiments tray; a
free-standing trackside decoupler would re-open exactly the
detached-carriage-as-untracked-obstacle problem the railyard's owned, gated
territory was designed to contain. The shunting-orchestration analysis below
remains the reference for any future maneuver planner.

**Proves:** the **decrease direction** of [ADR-023](../adr/023-coupling-and-decoupling.md).
A trackside device physically separates a carriage from a dwelling train and
emits `train_length_changed` with the *shorter* length; the detached carriage
simply **leaves core's awareness** — no composition model, no lone-carriage
entity, no identity event. ADR-023 §2 names exactly this device ("a station that
physically clips a carriage off … is just a reporter") and says it needs no
special core support. This entry is that claim, made concrete, and it isolates
where the genuine difficulty lives: **not in the device, but in the route
orchestration around it.**

## What it is

A short trackside device with a retractable **wedge** between the rails. A train
is positioned so the gap between two carriages sits over the wedge; the wedge
rises, driving the magnetic coupling apart (Brio carriages couple by magnet — a
physical wedge is a plausible toy mechanism). The front portion of the train can
now pull away, leaving the rear carriage(s) standing on the track. The device's
*only* protocol output is the resulting shorter `train_length_mm`.

## Capabilities it declares

- `core.reports_length` (ADR-023) — the authority to assert a `train_length_mm`.
  A `train_length_changed` is honoured only from a device that declared this, the
  same producer-authority gate `core.assigns_tags` uses. The scheduler trusts the
  value (no oracle exists to validate length — ADR-023 §1).
- `core.gates_clearance` — to pin the train while the wedge is engaged (see
  **Held state**).
- Tag identity (ADR-007) to resolve *which* train it just shortened.

## API events and data it acts on

- **Reads** dwell / `marker_traversed` to know the train is positioned over the
  wedge, and ADR-007 tag resolution to identify it.
- **Holds** the train via `core.gates_clearance` while the wedge is up.
- **Emits** `train_length_changed { train_id, train_length_mm }` carrying the new
  *scalar* length after separation — nothing else. No carriage id, no
  "decoupled" event, no manifest. The detached carriage is now just track
  furniture the system cannot see, exactly as ADR-016/023 intend.
- The scheduler updates `TrainState.length_mm` and re-derives occupancy with the
  existing ADR-012/016 tail-release walk — a shorter train releases edges it was
  holding. That re-derivation is the *whole* downstream effect.

## Action-oriented goal

Reduce a dwelling train's length by detaching its rear, and report the new
length. The device does one mechanical thing (raise wedge) and emits one scalar.

## How the held state is guaranteed (the cross-cutting question)

The wedge must engage only while the train is stationary and stay engaged until
the front has the clearance to pull cleanly away. As with the crane
([003](003-crane-cargo-station.md)), a dwell *timer* is a guess; the device
instead **withholds clearance** (`core.gates_clearance`) to pin the train during
separation, then grants the front portion clearance to depart. The shorter length
is reported at the moment of separation so occupancy is already correct when the
front moves.

## The hard part is NOT the device — it's the shunting (real-world steer)

The device is trivial; *rearranging a train's carriages* is a genuinely hard
orchestration problem, and it is **out of scope** for this entry. But the user
flagged wanting a real-world steer, so here is the honest shape of it, drawn from
how actual railways and model-railway **shunting puzzles** solve exactly this:

- A locomotive can only ever **pull from one end or propel from the other**. To
  take a carriage out of the *middle* of a train, or to re-order carriages, you
  cannot just "detach" — you need a sequence of moves using spare track.
- The classic tools are a **headshunt** (a dead-end spur the loco draws cars onto
  and pushes back from) and a **runaround loop** (a parallel track letting the
  loco uncouple, drive around its train, and re-couple at the *other* end to push
  instead of pull). These convert "I am coupled on the wrong side" into "I am
  coupled on the right side."
- The two canonical demonstrations of the full difficulty are the **Inglenook
  Sidings** and **Timesaver** shunting puzzles: a small fan of sidings plus a
  headshunt, where re-ordering a handful of wagons into a target sequence takes
  many back-and-forth moves. They are *the* reference for "how does a train move
  back and forth to switch and change carriages."

The implication for trainframe: a decoupler device is a one-event reporter, but a
*useful* decoupling **operation** — "swap carriage 3 from train A to train B" — is
a **multi-route plan** the scheduler/planner would have to compose (detach,
runaround, re-couple), gated on a runaround loop existing in the layout. ADR-023
deliberately refused to build that ("no coupling maneuver … no shunting"). So
this entry proves the *atomic* seam (length goes down, cleanly) and explicitly
parks the *orchestration* as a separate, much larger question that would need its
own ADR and a planner extension — informed by the puzzle literature above, not by
this device.

### How trainframe *would* handle the process (the sketch)

To answer "how do we handle a process like this?" concretely: the primitives
already exist; what is missing is a **composer** that sequences them. A decoupling
maneuver is not one autonomous route — routes are cycles a train runs on its own
([routes are cycles, not lists]) — it is an ordered **plan of route segments
punctuated by holds, device actions, and reversals**, advanced by *observing*
each step complete rather than by streaming commands (clearance, not commands).
The simplest "drop the rear carriage at siding B" decomposes to:

1. Plan a route that places the train over the decoupler with the target
   inter-carriage gap on the wedge; the train runs it autonomously and is **held**
   there (`core.gates_clearance`).
2. The decoupler fires and emits `train_length_changed` — the step's
   **completion signal**. The plan advances only when the scheduler observes the
   shorter length, not on a timer.
3. The (now shorter) front train is granted clearance to route away to its
   destination. The rear carriage is parked on a spur routes do not use (see the
   occupancy caveat below).

The genuinely hard variants — taking a carriage from the *middle*, or re-ordering
— add **runaround** steps: the loco uncouples, routes around its own train via a
loop, and **propels** (pushes) from the far end. trainframe already has the pieces
for this: edge-routes for each leg, switch control for the loop, **reverse
authority** ([ADR-022](../adr/022-reverse-authority.md)) for the propel moves, and
hold-until-observed sequencing. What it lacks is (a) a **maneuver planner** that
emits and sequences these legs and watches for each completion event, and (b)
**layout knowledge** that a runaround loop / headshunt exists to plan over. That
planner — a small plan executor above the route layer, gated on layout affordances
— is the real build, and it is its own ADR, deliberately **not** this device.

The load-bearing point: the *device* stays a dumb one-event reporter no matter how
elaborate the maneuver. The back-and-forth lives entirely in the plan composed
*around* it, over primitives that already exist.

[routes are cycles, not lists]: ../adr/004-edge-based-routes.md

## Visible goal

A real operator should see the **train split**: the wedge rises between two
carriages, the rear carriage(s) stay put, and the front of the train rolls away
leaving a visible gap. The remaining carriage stands alone on the track. The
length change is legible as a physical separation, not a number — and the
visualiser's tail-occupancy for that train visibly shrinks to match.

## Toy-box element & animation

- **Shape:** a short, manufactured (non-wooden, ADR-024 §4) trackside fitting
  spanning one track band — a low grey housing with a slot down the rail centre.
  Smaller than a station; reads as a gadget, not a stop.
- **Animation:** the **wedge** rises from the slot (a short vertical pop, faked
  top-down as a bright `pop`-accent triangle growing between the rails), the rear
  carriage decelerates to a stand, and the front consist eases forward, opening a
  visible gap. The wedge then retracts. Two bodies move apart — the clearest
  possible read of "length decreased."
- **Hand-wave:** the magnetics, the exact wedge mechanism, and *which* coupling
  gap the train stops over are not designed. The device assumes the train is
  already positioned correctly; positioning it is the orchestration problem above.

## Why it's experimental, not the norm

- Almost no layout has powered decoupling; children separate Brio carriages by
  hand, and ADR-023 is explicit that the system models only length, not the act.
- The value is twofold: it proves the ADR-023 decrease path end-to-end with a
  real producer, **and** it cleanly demarcates the line between the cheap thing
  (report a shorter length) and the expensive thing (orchestrate a shunting plan)
  — so a future reader does not mistake one for the other.
- If the *orchestration* ever graduates, it is a planner ADR about runaround
  loops and multi-route maneuvers, not a property of this device.

## Open questions (for the someday-session that builds it)

- **Positioning the gap over the wedge.** Stopping a train so a specific
  inter-carriage gap sits over the device is itself a sub-problem (it needs to
  know carriage lengths the core deliberately does not model).
- **The detached carriage is now an untracked obstacle.** When the train shrinks,
  the tail-release walk frees the edge the rear carriage is now standing on — so
  the scheduler considers that block clear while a physical object sits there, and
  a train routed through it would collide with something core cannot see. This is
  **not new**: it is the standing ADR-023 / ADR-016 "carriages are invisible to
  core" consequence, here triggered by an automated detach instead of a child's
  hand. It is the same head-position-vs-physical-occupancy seam flagged elsewhere
  in the scheduler notes, and it is the real reason a *useful* decoupling
  operation needs the orchestration above (park the carriage somewhere routes do
  not run) rather than just a length report.
- **Where the detached carriage goes.** Beyond the occupancy risk, the
  simulator/visualiser must still render a now-static carriage and let a child (or
  a later re-coupling) pick it up. Re-coupling is the *increase* direction — the
  same seam, the [001](001-vision-length-station.md) measure-on-visit answer, or
  an operator assertion.
- **Where it lives.** A satellite device (e.g. `trainframe/decoupler`, the name
  ADR-023 §2 already reserves) declaring `core.reports_length` +
  `core.gates_clearance`. Core untouched.
