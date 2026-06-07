# ADR-016: Train consists (carriages) and length-aware visualisation

## Status

Proposed

Builds on [ADR-012](012-train-length-and-tail-clearance.md) (a train has a
physical `train_length_mm` that drives tail-clearance) and
[ADR-013](013-simulator-physical-twin-visualiser-system-view.md) (the visualiser
renders the system's view). This ADR is a plan for a future session: it records
the intended design for making carriages first-class and for *showing* train
length, neither of which exists yet.

## Context

Two gaps, raised by the operator after the bridge demo:

1. **Carriages aren't simulated.** Today a `carriage` is (a) a toy-table piece
   type that is wire-invisible (no RFID tag, emits nothing) and (b) a
   render-only trail: `packages/simulator-ui/src/track/coupling.ts`
   (`computeTrainTrails`, `carriageWorldPos`, `CARRIAGE_SPACING_MM`) places
   carriage sprites behind a live train by 2D proximity, clamped to the train's
   single current edge. The physics `Simulation` has no notion of a carriage;
   the scheduler never hears about them.

2. **Length is known but invisible.** Per ADR-012 the scheduler already knows
   each train's `train_length_mm` (announced on `device_registered`, used for
   tail-clearance). But the simulator renders a fixed-size sprite and the
   visualiser (`LayoutCanvas`) draws every train as one fixed pointed icon — so
   the most consequential physical fact about a train, and the tail-clearance
   behaviour it drives, are nowhere on screen.

The unifying observation: **a train's length and its carriages are the same
fact viewed two ways.** A consist (locomotive + carriages) *is* the thing whose
total length ADR-012 already locks sections behind.

## Decision

### 1. A train is a consist; its length is the wire quantity

Model a train as a **consist**: a head plus an ordered list of carriages, each
with a physical length. The consist's **total length is exactly ADR-012's
`train_length_mm`** — the value the scheduler already uses for tail-clearance.
"Adding carriages" therefore means giving that scalar a physical make-up, not
inventing a new scheduling concept.

**No mandatory protocol change.** `train_length_mm` (the sum) stays the only
length the scheduler needs, and carriages stay wire-invisible (they carry no
tags). An *optional* `consist` descriptor (ordered carriage lengths) MAY later
ride `device_registered` if the visualiser wants exact segment boundaries; ship
length-only first (zero protocol surface), add the descriptor only if segment
detail is wanted. Any such addition is a flagged protocol decision, not a
silent one.

### 2. The sim owns consist occupancy; carriages trail along the rail

Extend `@trainframe/simulator` so a `VirtualTrain` knows its consist length (it
already has `length_mm`). The sim positions the **head** at
`distance_into_edge_mm` and each trailing segment at a cumulative offset behind
it **measured along the rail** — walking backwards across edges/markers, not the
2D chord. This generalises today's single-edge, UI-side proximity trailing
(`coupling.ts`) into a real, multi-edge sim behaviour: carriages become sim
entities that genuinely occupy the track behind the head. The toy-table then
consumes these positions instead of re-deriving them by proximity.

### 3. The visualiser draws the consist to scale, making tail-clearance visible

`LayoutCanvas` already scales `x_mm/y_mm` to SVG units; **reuse that mm→SVG
scale to convert `train_length_mm` to SVG length.** Render a train not as a
fixed icon but as a **body swept along the edge bezier** from the head's
`distance_into_edge_mm` back by its length (sampling the same curve the head
rides, crossing back over the previous marker when the tail hasn't cleared). A
long train then visibly straddles into its previous section until the tail
clears — i.e. ADR-012's tail-clearance becomes legible on screen. With a
`consist` descriptor present, draw discrete carriage segments; without it, draw
one elongated body of the correct length.

## Consequences

- **Inherits ADR-012's `length < shortest edge` constraint.** A consist longer
  than one edge spans multiple sections, which needs ADR-012's deferred
  multi-edge tail-release (a release queue keyed by progress distance). That is
  a **prerequisite** for long consists and should land with, or before, real
  multi-carriage trains.
- **Length-only first is cheap and protocol-free.** Both the sim occupancy and
  the visualiser body can be built from `train_length_mm` alone; the `consist`
  descriptor is a later, optional enrichment.
- **Coupling / decoupling stay out of scope.** This ADR assumes a fixed consist
  per train. Dynamic coupling is an existing open question (see CLAUDE.md) and a
  separate ADR.
- **Carriages remain wire-invisible.** The scheduler's surface is unchanged; the
  only system-relevant fact is total length, already present. If carriages ever
  gain tags/identity, revisit.
- **The render becomes the teaching tool.** Showing the consist to scale turns
  the otherwise-invisible tail-clearance rule into something an operator can
  watch — a chaser visibly held until the lead's tail clears.

## Suggested sequencing for the implementing session

1. Sim: consist length → multi-edge trailing occupancy in `VirtualTrain` /
   `Simulation`; expose segment positions for renderers.
2. Visualiser: swept length-scaled train body along the edge bezier (length-only).
3. Toy-table: re-point `coupling.ts` at the sim's consist positions.
4. (If wanted) optional `consist` descriptor on `device_registered` + discrete
   carriage segments in both renderers — a flagged protocol bump.
5. (Prerequisite for long consists) ADR-012's multi-edge tail-release queue.
