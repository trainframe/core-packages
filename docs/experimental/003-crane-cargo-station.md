# Experimental device 003: Crane cargo station

**Status:** speculative viability test. NOT normative; not expected in a typical
setup.

**Built (June 2026):** toy-table piece in the Experiments tray (`crane-station`
in `pieces.ts`) — a station plank with a grey gantry, trolley + hook, and a
warm-accent crate stack. Scanning registers `CRANE-{piece.id}` with
`core.gates_clearance`, backed by a real `VirtualGate` (the hold-the-train
seam). The cargo itself stays as documented design: the carriage cargo slot and
the trolley/crate animation are NOT built — they wait on the simulator change
this entry describes below. that a device can perform a **meaningful physical manipulation of a
train's payload** — lifting a crate off, or placing one on, a carriage — using
only the seams that already exist: scheduled **dwell**, **tag identity**
([ADR-007](../adr/007-tag-resolution-registry.md)), and **clearance**. The crate,
like the carriage that holds it, **stays entirely out of core** — exactly the
ADR-016 / ADR-023 decision that carriages are a simulator/visualiser detail,
never a wire entity. This is a *negative-space* proof: the interesting result is
that nothing new crosses the wire. If the crane works end-to-end emitting no
cargo-specific protocol, the "payload lives outside the core" boundary holds for
a second kind of payload.

## What it is

An ordinary trackside station — a marker trains route to and dwell at — with a
gantry crane straddling the track. While a train sits at the station, the crane
lifts a crate from a passing carriage onto a trackside stack, or places a waiting
crate onto an empty carriage slot. Everything else is a normal station: trains
are scheduled to it, dwell, and depart per the existing model. The crane is
purely additive — remove it and you still have a working station.

## Capabilities it declares

- Whatever a normal station/marker needs for its stop role (it is a real marker).
- `core.gates_clearance` — see **Held state** below; the crane must be able to
  guarantee the train cannot depart mid-lift, and the honest way to do that is to
  withhold departure clearance while the arm is over the train, rather than trust
  a dwell timer.
- Tag identity: co-located with (or itself performing) tag reading, so the train
  at the station resolves to a known `train_id` via the ADR-007 registry. It does
  **not** need to know *which carriage* — see the hand-wave below.

## API events and data it acts on

The load-bearing claim is that this list is **short and entirely existing**:

- **Reads** `marker_traversed` / dwell to know a train has arrived and settled.
- **Reads** the ADR-007 tag resolution to identify the dwelling train.
- **Emits** a clearance withhold/grant on `core.gates_clearance` to pin the train
  in place during the lift and release it after (the same boom a level-crossing
  gate uses, repurposed as a "don't leave yet" hold).
- **Emits nothing cargo-specific on the wire.** No `crate_loaded`, no manifest,
  no carriage id. The crate transfer is a simulator/visualiser fact, invisible to
  protocol and scheduler — the whole point.

## The small simulator change it would need (documented, not built)

Today a carriage is a dumb visual piece (`DEVICE_PIECE_TYPES`, no MQTT identity,
[`pieces.ts`](../../packages/simulator-ui/src/track/pieces.ts)). For the crane to
have something to act on, a carriage gains an **optional cosmetic cargo slot** — a
nullable "is a crate riding on this wagon?" flag the simulator and visualiser
render and the crane toggles. Crucially the carriage **stays dumb**: no comms, no
RFID, no `device_registered`, nothing on the bus. Cargo is to a carriage what a
carriage is to a train — a layer of physical detail the core never sees. This is
the only code change the device implies, and it is confined to the
simulator/visualiser carriage model; protocol, core, and the scheduler are
untouched.

## Action-oriented goal

While a train dwells, move a crate between a trackside stack and a carriage slot:
pick the train (tag), hold it (clearance), lift/place (simulator cargo toggle),
release it (clearance). Success is the train departing one crate heavier or
lighter, with the system none the wiser at the protocol level.

## How the held state is guaranteed (the cross-cutting question)

A crane must not swing a load over a train that then rolls out from under it.
Relying on a scheduled dwell *timer* is not enough — a timer is a guess about
when the train leaves, not a guarantee. So the crane **withholds departure
clearance** for the duration of the lift (`core.gates_clearance`), making "the
train is held" a fact the scheduler enforces, not a race. The train is pinned the
moment it is identified at the station and released only when the arm is clear.
This is the same answer the decoupler ([004](004-wedge-decoupler.md)) needs, and
the inverse of the bridge ([005](005-lift-bridge.md)) which holds a train *out*.

## Visible goal

A real operator should see the **arm swing and the crate move**: the gantry
traverses over the dwelling train, a crate lifts off a wagon (or lowers onto an
empty wagon), and the train departs visibly changed — one fewer or one more box
on its back. The trackside crate stack visibly grows or shrinks to match. The
payload change is legible *without any UI text*: you can see the cargo move.

## Toy-box element & animation

- **Shape:** a manufactured object, **not** wooden (ADR-024 §4) — a grey gantry
  frame straddling the track band, with two uprights and a cross-beam, drawn
  top-down. A small stack of warm-accent crates sits beside it on the trackside.
  The track band beneath is ordinary station wood with a platform feature.
- **Animation:** a two-part motion — the **trolley** slides along the cross-beam
  to position over a wagon, then the **hook/crate** drops and rises (a short
  vertical bob, faked in top-down as a scale-and-shadow pulse). On release, the
  crate either joins the trackside stack or rides away on the departing wagon.
  Like the turntable, this animates *a feature relative to the body*, not the
  whole piece.
- **Hand-wave:** which carriage slot a crate lands on, crate identity, and any
  notion of a manifest are out of scope — the simulator picks a slot; the proof
  cares only that payload manipulation needs no new wire surface.

## Why it's experimental, not the norm

- Almost no layout has freight-handling robotics; this is a showpiece.
- The value is the boundary test: it confirms that a *second* category of
  physical payload (cargo, after carriages) can be manipulated by a real device
  through dwell + identity + clearance alone, with the payload staying out of
  core. That is the ADR-016/023 "the wire fact is a scalar; everything physical
  below it is simulator/visualiser" principle, re-proven on new ground.
- If it graduates — e.g. someone genuinely wants the system to *route by cargo* —
  that is a real protocol conversation (a cargo entity, a manifest event) and an
  ADR, explicitly **not** what this entry assumes. This entry proves the opposite:
  you can have the crane without any of that.

## Open questions (for the someday-session that builds it)

- **Carriage slot model.** Even cosmetically, the simulator needs to decide how
  many crate slots a carriage has and how the crane chooses one.
- **Cargo-aware routing (a real future satellite, but not now).** The natural
  next step someone may one day want: certain *classes* of crate are not allowed
  on certain paths (a hazardous load barred from a tunnel, say), so a train that
  is loaded must be **rerouted**. That is a genuine, interesting extension — but
  it is the cargo-entity step this entry deliberately does **not** take. It would
  arrive as a *satellite capability* (e.g. `vendor.transfers_cargo` plus a
  cargo-class fact the device asserts and the planner constrains routes on), with
  its own ADR — exactly the kind of third-party extension the capability model
  exists to allow. Today the crate is cosmetic and core-invisible; the moment
  routing depends on it, cargo becomes a modelled entity, and that is a separate,
  larger conversation. Flagged as the obvious graduation path, not built here.
- **Where it lives.** A satellite device (e.g. `trainframe/crane`) declaring only
  `core.gates_clearance` + the marker role, plus the small simulator carriage
  cargo-slot change. Core untouched.
