# Railyard interior shunting — behaviour spec

The authoritative description of how the **railyard interior choreography** must
look and behave. The **observable** behaviour below is unchanged from the original
spec; the **mechanism** is now the [ADR-030](../adr/030-device-provider-simulator-separation.md)
device/provider/physics model (it supersedes the hand-animated ADR-029 approach).
Where the build and this doc disagree on observable behaviour, **this doc wins**.

Status: observable spec agreed; built on the ADR-030 substrate (physics + the
device sense/act seams), `YardController` in progress. The first hand-animated cut
got the crane wrong (it lifted/ferried carriages) and teleported the train at the
throat — both are gone by construction now (the train self-drives real rails; the
crane only ever moves itself + splits a coupling).

## Mechanism (ADR-030)

The yard is a **device** on the simulator's physical substrate, exactly like any
other: it perceives only through a **camera** (footprint-limited — it sees just the
track beneath the crane) and acts only through **actuators** (the self-propelled
train's motor, the junction-switch points, and the crane's two gantry axes + wedge).
Nothing is keyframed: the train drives itself on real rails, junctions switch,
carriages couple by magnetic proximity and split when the wedge prises them apart —
all emergent from the physics. The yard **maintains its own internal state by
looking** (it is never told what is where): it drives the camera along a train to
read each carriage's colour and over each slot to learn occupancy, and from those
observations keeps its slot/capacity model.

## Scope

Core and the wire protocol do not change: the throat handoff (ADR-027 entry-suspend
/ `zone_train_released`), length reconcile (ADR-023 `train_length_changed`),
carriages-invisible-to-core (ADR-016), and the **zone capacity the yard reports**
(`zone_state_changed`, ADR-026 — now derived from what the yard observes) are all
unchanged. The point is to **stress the system** with a believable, sighted
shunting yard, not to add protocol.

## The yard

- **Wide/long enough that a whole train (loco + its full rake) fits inside one
  slot** with nothing leaking out onto the lead/spine. The current yard is too
  tight; it must be enlarged.
- When widening, **lengthen the ladder legs / junctions too** — they are
  currently pinched. The legs scale with the slot length so they stay gentle
  crossovers, not tight kinks.
- **Pass-through ladder**: a single running line from each throat, a **diverging
  ladder** fanning into the slots and a **converging ladder** rejoining them on the
  far side (the existing drawn `railyard` piece's layout). A train enters by one
  throat and leaves by the **opposite** throat; reversing is allowed *inside* (that
  is what a yard is for, and admission requires `core.can_reverse`).
- **Indifferent to which throat is IN.** The yard does not assume a direction — it
  services a train from whichever throat it *actually arrived at*, routing it
  through to the opposite one, and can hold trains arriving from both sides at once
  (single-lead interior discipline, ADR-026, keeps one moving inside at a time).
  Keeping global flow one-way is the *operator's* job (placing trains consistently),
  not the yard's.
- **Seeded with 2 spare carriages** already sitting in a slot at the start — this
  is the *demo* seeding it, not the device booting with spares.

## The crane

- The crane is **only a decoupler**. It moves *itself* along the gantry to the
  exact coupling that needs breaking, guided by its **camera**, and splits that
  coupling. That is the entire job.
- It **never** lifts a carriage, carries one, holds one, sets one down, or couples
  anything. The only things it ever moves are itself; the only thing it ever
  changes is one coupling.

## How carriages move

- **Only trains move carriages.** A decoupled carriage simply sits where it was
  left until a train comes for it.
- A train moves carriages **only by pulling, after coupling** — it must never
  intentionally *push* a carriage. (Pushing is physically possible but is never an
  intentional move.)
- **Coupling** happens by a train reversing **just until it contacts** stationary
  carriages (magnetic auto-couple). The instant of contact aside, the train then
  *pulls* them.

## The choreography — one visit

1. **Enter.** The train arrives at its throat and drives **straight in — same
   heading, no teleport** — into a free slot, coming to rest at the slot's **far
   end** so its whole rake is contained (nothing leaks out of the slot).
2. **Decouple (if a swap is due).** The **crane moves itself over the coupling**
   (camera-guided) and splits it. The train then **pulls forward away**, leaving
   the shed carriages parked in that slot. The crane has touched nothing but the
   coupling.
3. **Pull out.** The train pulls out onto the lead **far enough that its whole
   attached rake is safely clear** of the slot it is about to back into — the
   distance keys off the number of carriages still attached — then reverses toward
   the spares slot.
4. **Pick up.** It backs up **only until it couples** with the spares, then
   **pulls forward** to the stable rest position at the slot's far end and waits
   for the yard's next instruction. It does **not** reverse on through to the far
   side.
5. **Release / exit.** On the crane camera's OK, the train is released and drives
   **forward out the opposite throat**, continuing the one-way loop — **no
   teleport**, heading continuous.

## Touring (why the swap exists)

The carriages a train **sheds** in step 2 become the **next** visitor's spares;
the spares it **picks up** in step 4 leave the yard on the train. So a given wagon
keeps touring the fleet across laps. There is no purpose beyond stressing the
system: a carriage migrates train → yard → another train indefinitely, and must
never be lost in the shuffle.

## Hard requirements (the things that were wrong before)

- **No teleport at either throat.** The interior motion must begin from exactly
  where the train parked at the throat and in its travel direction, and end so the
  main-line resume is seamless. (The first cut jumped the loco ~230 px and flipped
  its facing on entry, and jumped again on exit.)
- **The crane never moves a carriage.** (The first cut had it lift the shed pair
  and ferry it onto the spares — wrong.)
- **The shed train shows its true remaining makeup** the whole time (e.g. 2 left
  after shedding 2), never reading as empty.
- **Rest at the slot end, rake contained** — never parked mid-slot with carriages
  spilling onto the lead.
- **Pull, never push**; **back only to couple, then forward to rest**.
- **Exit the opposite throat**, one-way.

## Verification (the bar for "done")

Record a single-train run, extract frames with **ffmpeg** at each step, and check
each against the spec — do not declare it fixed from state probes or numbers
alone, **watch the frames**:

- entry frame: train continuous at the throat, no jump, heading unchanged;
- rest frame: loco at the slot's far end, no carriage outside the slot;
- decouple frame: crane positioned over the coupling, no carriage on the crane;
- shed frame: train pulled clear, shed cut parked in the slot;
- pull-out frame: whole rake clear of the target slot before reversing;
- pickup frames: contact → couple → pull **forward** to rest (never reverses
  through);
- exit frame: leaving forward by the opposite throat;
- across laps: the shed cut is the next train's spares; no carriage lost.
