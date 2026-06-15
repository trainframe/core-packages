# ADR-033: The railyard demo runs on the real scheduler (and the yard is in-line)

Status: Accepted

## Context

The watchable railyard demo had been driven by a bespoke in-scene controller
(`RailyardDemoController`) that scripted the trains and the yard service directly.
That demo looked busy but it did NOT exercise the actual system: routing,
clearance, junction throwing and yard occupancy were all faked by foreknowledge
rather than emerging from `@trainframe/server`. The crane visibly "knew" where a
train would go the moment a route was planned — because the controller WAS the
plan. A demo that bypasses the scheduler is not a demonstration of the platform.

The scheduler is Node-only (it is the real server). It cannot run in a browser
scene. The existing live toy-table demo already shows the resolution: the
scheduler + broker run in a Node harness, and the devices run as MQTT clients
(in the browser, for rendering) — the browser is the DEVICE side.

## Decision

1. **The demo is driven by the real scheduler over the ADR-031 PlatformProvider.**
   The physics world's trains, the main-line junction, and the railyard are real
   protocol devices:
   - `ScheduledTrainDevice` — registers `core.controls_motion` + length +
     `core.can_reverse`, senses markers from the world to publish `tag_observed` /
     `train_status`, and obeys `assign_route` / `grant_clearance` /
     `revoke_clearance`. It carries no route foreknowledge — it executes and reports.
   - `SwitchDevice` (`core.controls_switch`) — the scheduler throws junctions.
   - `YardZoneDevice` (`core.gates_zone`) — asserts occupancy so the scheduler
     deny-and-holds trains at the throat (they QUEUE), and runs the interior
     `YardController` on the resident via a `ParentPlatform` (ADR-032).
   The browser scene (`?physics=branching`) and the headless integration gate run
   the SAME assembly (`buildBranchingDemo`); only the transport differs.

2. **The yard is IN-LINE, not a branch.** A yard hung off the loop as a
   diverge/rejoin gridlocks a concurrent run: a re-merging yard train and a train
   occupying the rejoin block form a circular wait, and the scheduler does no
   deadlock avoidance (conflict-resolution is an open design question — see the
   spec/CLAUDE.md). So the main running line passes straight THROUGH the yard
   spine (`leadW → thru → leadE`, default-`thru` interior points); the throat is a
   `yard_entry` marker ON the ring; a service diverts the visitor into a slot and
   returns it to the SAME through line. This mirrors the legacy 4-train demo's
   deadlock-free shape (ADR-029).

3. **Deadlock-freedom is a tested invariant, not a hope.** Because the scheduler
   cannot break a gridlock, the demo must be deadlock-free by construction (enough
   ring capacity / staggered yard access; three trains on this layout). A liveness
   gate (`branching-liveness.test.ts`) drives the full concurrent run on the real
   broker + scheduler for 200 sim-seconds and asserts no train freezes — it fails
   on the old gridlock and passes on the in-line design.

## Consequences

- The demo now genuinely demonstrates the platform: emergent routing, clearance,
  junction control and zone queueing, with nothing scripted.
- The bespoke `?physics=railyard-demo` scene remains (it is a useful pure-physics
  view), but the headline demo is the scheduler-driven `?physics=branching`.
- Adding deadlock AVOIDANCE to the scheduler (the open conflict-resolution
  question) would let denser/branch-hung layouts run concurrently without the
  by-construction discipline. Until then, demo layouts must keep a spare block.
