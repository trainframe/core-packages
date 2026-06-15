# ADR-034: Zone owned-marker declaration ("the track under the frame")

## Status

Accepted (drafted 2026-06-15). Builds on [ADR-026](026-delegated-capacity-territory.md)
(delegated capacity territory), [ADR-031](031-provider-boundary-platform-and-honest-actuators.md)
(the provider boundary / world–core separation), and [ADR-030](030-device-provider-simulator-separation.md).

## Context

A railyard, in this system, is a **composition of ordinary real track** (straights,
turnouts, dead-end slots) with a **device** — physically, a metal frame stretched
over that track that "claims ownership" of everything beneath it. To core the yard
is one opaque `core.gates_zone` territory: a boundary throat marker, a capacity, and
a device-asserted occupancy (ADR-026). Core cannot see the interior — the ladder
turnouts, the slots, the carriages.

But the interior is real track, and that track has markers and switches. Two things
must not happen:

1. **Two owners.** A switch device must not separately register to control a turnout
   that sits under the frame — the frame owns it. Today nothing prevents a stray
   `core.controls_switch` device from claiming an interior junction and fighting the
   yard for it.
2. **Core computing geometry.** Core must never work out *which* markers fall under a
   frame. That is a physical fact about where the metal sits over the wood — a
   sim-side (or, on hardware, an installer-side) concern, never something core
   derives. This is the world/core boundary of ADR-031.

The frozen architectural commitment is "the railyard declares the markers under its
control" — over the wire, declaratively — and "the method cannot violate the
world/core boundary."

## Decision

A `core.gates_zone` device MAY declare, on its `device_registered` event, an optional
`owned_marker_ids: string[]` — the interior markers it owns (the track under the
frame). This mirrors the existing optional `controls_marker_id` on `core.controls_switch`:
an additive, capability-specific field carried flat on the registration payload.

- **Core RECORDS the list. It never computes it.** The device derives the list from
  its own footprint (in the simulator, from the yard's real-piece segments + switch
  ids; on hardware, from installation config). Core stores `marker id → owning device
  id` and nothing more — no positions, no geometry.
- **Single ownership is enforced.** If a declared marker is already owned (by another
  frame, or by a switch device that already controls it), the claim is refused with an
  `anomaly` and the marker keeps its first owner. Symmetrically, a `core.controls_switch`
  device that names a `controls_marker_id` a frame already owns is refused its pairing
  with an `anomaly`. Two things cannot own the same piece of track.
- **Interior markers stay opaque.** They are not part of the routable `Layout` (the
  scheduler never sees them as edges), so this declaration does not make core route
  through them; it records ownership and prevents conflicting control. The running
  line still crosses the zone via the opaque throat → far spine edge (ADR-026).

Protocol bumped 0.10.0 → 0.11.0 (backward-compatible optional field; no new event or
command, so the TCF registry epoch is unchanged). A device that omits the field owns
nothing beyond its zone boundary, exactly as before.

## Consequences

- The yard device declares `[throat, …interior switch markers]` at registration; the
  composition root computes that list from the yard's footprint (the "frame"), keeping
  core geometry-free.
- A misconfigured layout that double-owns track is now surfaced as an anomaly at
  registration rather than producing two devices silently fighting one switch.
- This does NOT resolve the open *multi-gate* question (several `gates_clearance`
  devices gating one marker) — that is contention over a shared marker, a different
  problem from single ownership of interior track. Deliberately out of scope.
