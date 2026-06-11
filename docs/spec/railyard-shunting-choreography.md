# Railyard interior shunting — behaviour spec

The authoritative description of how the **railyard interior choreography** must
look and behave in the simulator + toy-table demo. This is the spec the
[ADR-029](../adr/029-railyard-interior-shunting.md) implementation must satisfy;
where the build and this doc disagree, **this doc wins** until it is revised.

Status: agreed, not yet met. The first cut got the crane wrong (it lifted and
ferried carriages) and teleported the train at the throat — see "What was wrong"
at the end.

## Scope

This is a **simulator + toy-table concern only**. Core and the wire protocol do
not change: the throat handoff (ADR-027 entry-suspend / `zone_train_released`),
length reconcile (ADR-023 `train_length_changed`), and carriages-invisible-to-core
(ADR-016) are all unchanged. The whole point of the exercise is to **stress the
system** with a believable shunting yard, not to add protocol.

## The yard

- **Wide/long enough that a whole train (loco + its full rake) fits inside one
  slot** with nothing leaking out onto the lead/spine. The current yard is too
  tight; it must be enlarged.
- When widening, **lengthen the ladder legs / junctions too** — they are
  currently pinched. The legs scale with the slot length so they stay gentle
  crossovers, not tight kinks.
- **One-way system, like the rest of the track.** A train enters by one throat
  and leaves by the **opposite** throat. Reversing is allowed *inside* the yard
  (that is what a yard is for, and admission already requires `core.can_reverse`),
  but the net flow through the yard is one-way.
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
