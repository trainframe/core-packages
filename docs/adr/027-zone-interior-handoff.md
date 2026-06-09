# ADR-027: Zone interior handoff (entry-hold / exit-reclaim)

## Status

Proposed. The core mechanism [ADR-026](026-delegated-capacity-territory.md)
deferred: how a *tracked* train is handed to a zone-owning device while it is
inside, and handed back. Additive when accepted (a minor bump): one new event,
one new capability, a scheduler state machine over a new zone-boundary registry.

Builds on:

- [ADR-026](026-delegated-capacity-territory.md) — the zone presents to core as
  one boundary marker; the device asserts capacity/occupancy and gates admission.
  This ADR adds what happens *after* admission: the train crosses into the
  device's opaque interior and, later, back out.
- [ADR-002](002-clearance-model.md) — clearance, not commands; default-stopped.
  The exit rule below is a direct consequence: a train leaves the interior only
  under core clearance, never driven across the boundary by the device.
- [ADR-011](011-section-as-edge-plus-boundary-markers.md) — block exclusivity.
  The throat is where that guarantee is suspended (inside) and re-asserted (on
  exit). Getting the seam right is the whole safety argument.
- [ADR-016](016-train-consists-and-length-visualisation.md) / [ADR-023](023-coupling-and-decoupling.md)
  — length is the only physical fact that crosses the wire; a train may be
  reconciled to a new length while inside (ADR-023, implemented).
- [ADR-022](022-reverse-authority.md) — reverse authority. Interior shunting
  requires reversing; this ADR makes "can this train reverse?" an explicit,
  declared fact (see §4).

## Context

After ADR-026, a train can be *admitted* to a zone (a railyard) when the device
asserts a free slot. ADR-026 stopped there: the admitted train still sits on
core's main line at the throat. To actually use the yard — park, shuffle,
decouple, re-couple — the train must pass into the device's territory, where core
neither routes it nor guarantees its safety, and later return.

The interior is **opaque** (ADR-026): its track is not in core's graph; core
models the zone as its single boundary marker (the throat). So the question is
purely a **handoff protocol** at the throat: when does authority over a train
pass from core to the device, and when does it pass back — without ever letting a
train move onto core-managed track that core has not cleared.

The realisation that keeps this small: **core never routes a train inside.** The
interior choreography (the single-lead back-and-forth) is the device's and the
simulator's concern, hand-waved exactly as every experimental device hand-waves
its hardware. Core's entire job is to *suspend* a train at the throat on the way
in and *reclaim* it on the way out. This is a suspend/reclaim state machine, not
an interior router.

## Decision

### 1. Core gains a zone-boundary registry

The scheduler records which markers are zone boundaries and which device owns
each, populated from `zone_state_changed` (which already carries
`zone_marker_id`). This is the new coupling ADR-026 implied: until now only the
`core.gates_zone` capability knew where zones were; the handoff needs the
scheduler itself to recognise a boundary marker. `zone_state_changed` is still
dispatched to the capability (admission is unchanged); the scheduler additionally
notes the boundary.

### 2. Entry = an admitted train reaching the boundary as its route terminus

A zone boundary marker keeps its ordinary main-line edges (trains pass *by* a
yard, and depart *from* its throat). So "entering the yard" cannot be inferred
from crossing the marker — a pass-through train crosses it too. Entry is:

> an **admitted** train arrives at a zone-boundary marker that is the **terminus
> of its current route**.

A train whose route continues past the throat is just passing through and is
untouched. A train routed *to* the throat (route ends there) and admitted (the
device asserted room — ADR-026) is pulling in. On entry the scheduler:

- sets the train's `in_zone = <boundary marker>`;
- **releases every edge the train holds** (the approach and the throat), so it
  occupies no core block — the throat immediately frees for the next admission;
- suspends the train's transit: core routes it no further.

A train held `in_zone` holds **no core blocks**. Zone fullness is the device's
asserted occupancy count (ADR-026), *not* block exclusivity — this is precisely
the head-position-≠-physical-occupancy seam: core's occupancy model goes quiet
inside the zone and the device's count takes over.

**Multi-occupant falls out for free.** Trains enter one at a time through the
throat (throat block-exclusivity serialises it — which *is* the single-lead
discipline), each becoming suspended-inside holding no block, until the device's
asserted capacity is reached and admission denies the next. No new concurrency
machinery.

### 3. Exit = device-asserted release, then core-cleared departure

This is the safety crux. A train inside the yard is at the throat; the track
*outside* the throat is a main-line block under core's exclusivity. If the device
drove a train across the throat outward, it would place it on a main-line block
core never checked — a collision risk against another train holding that block.
So **the device never moves a train across the throat.** Instead:

> **New event `zone_train_released { zone_marker_id, train_id }`**, emitted by the
> `core.gates_zone` device when a train has finished inside and is ready to
> leave. It is honoured only from the device that owns that zone boundary.

On receipt the scheduler **reclaims** the train (still parked at the throat):

- clears `in_zone`;
- re-derives occupancy against the train's **current** length (which the device
  may have changed via `train_length_changed`, ADR-023, while it was inside);
- resumes normal scheduling — the train is once more an ordinary train at the
  throat marker, and departs onward **only when core grants clearance**, which
  applies main-line block exclusivity exactly as for any train.

Release and length-change are **separate**: a train may leave unchanged (it
parked and pulled out), or the device may emit `train_length_changed` (carriages
rearranged) before/with the release. `zone_train_released` names only the train;
length rides its own seam.

### 4. Admission requires a declared reverse capability

Interior shunting is back-and-forth: a train that cannot reverse would pull in and
get stuck. So a train may be **admitted to a zone only if it can reverse**.

> **New capability `core.can_reverse`**, declared by trains whose hardware can run
> backward. Today reversibility is implicit — ADR-022's `grant_reverse` is simply
> ignored by trains that cannot (default-stopped/safe). This ADR makes it an
> explicit declared fact so the system can *know* rather than discover by silence.

The scheduler — already zone-boundary-aware (§1) — **denies clearance into a zone
boundary to a train that has not declared `core.can_reverse`**, with a warning
anomaly. The check lives in the scheduler, not in `ClearanceConsultation`, to
keep the core consultation type (which every gating capability sees) unchanged.

**Honest scope note:** the interior is hand-waved (the train parks at the throat;
core never sees it reverse), so this gate *models the real-world constraint
without exercising it*. That is deliberate — it is the right gate to have the
moment interior maneuvering becomes real, and it costs nothing now. `core.can_reverse`
could later let ADR-022 stop granting reverse to trains that cannot (replacing
ignore-by-silence); that is **out of scope here**.

## What this ADR deliberately does NOT do

- **No interior router.** Core never plans or clears a move inside the zone. The
  single-lead choreography is the device's/simulator's concern.
- **No topology-violation exemption.** ADR-026 floated exempting interior marker
  reports from ADR-019. With the interior hand-waved, a suspended train parks at
  the throat and never traverses interior markers, so there are no reports to
  exempt — it would be dead code. Deferred to if/when interior markers become
  real core entities.
- **No multi-lead / concurrent interior motion.** Single-lead (one mover inside)
  stays the device's discipline (ADR-026); core models none of it.
- **No identity change.** A train in a zone is the same train, suspended. Nothing
  is minted or retired (ADR-023 upheld).

## Consequences

- **The throat is the authority boundary, and the only one.** Authority passes to
  the device when a train parks at the throat (entry) and returns when the device
  releases it (exit); a train crosses the throat onto the main line only under
  core clearance. Block exclusivity is never violated, because the device never
  moves a train onto a core block.
- **Core's occupancy goes quiet inside, by design.** A suspended train holds no
  block; the device's asserted count is the only fullness signal. This is the
  cross-feature occupancy seam stated plainly, with a crossing test to prove it.
- **Small surface for a real capability.** One event, one capability, a scheduler
  state machine over a boundary registry. No new motion primitive, no interior
  graph, no identity machinery.

## Test plan (the crossing tests)

- **Entry frees the throat (multi-occupant).** Two reversible trains, a 1-slot…
  no: a 2-slot yard. T1 routed to the throat is admitted and enters (suspends,
  releases the throat); T2 is then admitted through the *same* throat and enters.
  Asserts a suspended train holds no block and the throat is reusable.
- **Exit is core-cleared.** A resident train is released by the device; assert it
  departs onward only when the main-line block ahead is free (hold it with a peer
  and prove the released train waits — exclusivity re-asserted on exit).
- **Length reconciled across the handoff.** A train enters at length X, the device
  emits `train_length_changed` to Y and releases it; on reclaim its occupancy is
  re-derived against Y.
- **Reverse gate.** A train lacking `core.can_reverse` routed to a zone boundary is
  denied admission with a warning anomaly.

## Open questions

- **Onward routing after release.** A reclaimed train is at the throat; its onward
  journey is ordinary scheduling (operator schedule / planner). This ADR resumes
  scheduling; it does not prescribe the next route.
- **Release of a stranded train.** If a `core.gates_zone` device disconnects with
  a train suspended inside, the train is parked with no owner. Fail-safe is core's
  default (it stays suspended/stopped until an operator intervenes); a clean
  reclaim-on-disconnect is a refinement.
- **`core.can_reverse` ↔ ADR-022.** Whether `grant_reverse` should consult the
  declared capability rather than relying on ignore-by-silence — out of scope,
  flagged for an ADR-022 revision.
