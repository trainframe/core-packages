# ADR-035: Device onboarding — discovery, association, and the pairing lifecycle

## Status

Proposed — 2026-06-26. Not implemented. Supersedes nothing; **completes** the
device side of [ADR-007](007-tag-resolution-registry.md) (tag→entity
resolution), fills the pairing handshake [ADR-021](021-esp-now-bridge-wire-format.md)
§5 explicitly deferred ("out-of-band pairing path … out of scope here"), and
adds a fourth backing to the [ADR-031](031-provider-boundary-platform-and-honest-actuators.md)
`PlatformProvider` seam. Builds on [ADR-009](009-discovery-mode.md) (discovery).

## Context

### The bug that exposed the gap

A real layout (29 toy-table pieces, two junctions, three loops) cannot be
learned. Live broker evidence: the train loops one fixed 9-marker circuit
forever, always taking the same leg at each junction, **never a single
`set_switch_position`**, `track_learning` stuck at `markers_visited: 9`,
`state: "driving"` indefinitely.

Root cause, traced through the live system:

1. The server runs in **discovery mode** — it builds the layout from observed
   traversals, not from the toy-table's `compileLayout`. In discovery,
   `LayoutState.junctionMarkerIds()` reads `junctionsByMarkerId`, which is only
   populated from a *declared* `layout.junctions` (`loadFromLayout`). Discovery
   never fills it: `upsertMarker(id, 'junction')` sets the marker's *kind* but
   adds no junction entry, and `maybeRecordSwitchPairing` records only the
   device→marker pairing. So `junctionMarkerIds()` returns `[]`, and
   `LearnMode.armJunctions` iterates nothing — no switch is ever thrown.
2. Even if it weren't empty, discovery's `addInferredEdge` creates bare
   `{from, to}` edges with **no `requires_switch_state`**, so `armJunctions`
   (which reads that field off a leg to decide what to throw) would skip anyway.

The Part-4 `learn-mode.test.ts` passed because it drove `LearnMode` with a
*declared* `BRANCHED_LOOP` — junctions and switch-state edges already present:
the two things discovery does not produce. The test never exercised the live
path.

### The deeper gap

Fixing the junction case forces a question we have never answered: **how does a
device join the system at all?** Today a simulator device just calls
`platform.register()` and the event appears on the bus. There is no handshake by
which an *unpaired* device announces itself, gets noticed, and is bound to the
physical location it sits at. Three prior ADRs each left this hole:

- **ADR-007** built `tag_id → {kind: 'marker' | 'vehicle', target_id}` resolution
  and the `core.assigns_tags` path, but deferred the device side — a device never
  quotes a tag.
- **ADR-021** assigns a constrained device's `device_ref` "at pairing" and
  synthesises its `device_id`, but defers the pairing/discovery handshake itself.
- **ADR-031**'s `PlatformProvider` (the device↔core seam) assumes the device is
  *already connected*: all three backings (in-process, parent-as-core, MQTT edge)
  let `register()`/`publish()` return instantly.

The toy-table's confusing commissioning UX (a device is auto-bound at scan, then
a second name/type prompt appears later) is the same gap surfacing operator-side.

### The operator's mental model (the decision driver)

From design discussion, the intended model is:

- **Every tag defaults to being a track marker.** A bare tag scan stands alone
  and means "marker here." A *device registration* is the only thing that claims
  a tag and upgrades it (→ this tag is a switch / a vehicle / a zone). A plain
  track scan is the lone event with no registration follow-up.
- **Track is passive.** Trains, switches, gates, stations are all *devices* that
  self-register and carry a tag; plain wood has no identity.
- A device knows its own identity, the operator scans the tag at its location,
  and the system **matches** the two on a shared key. Hardware must stay dumb;
  realistically a tag is an RFID on a track piece, separate from the device's
  electronics, so the device must *learn* its marker via an explicit pairing step
  ("type-3"), not be born knowing it ("type-1", e.g. a loco).

## Decision

### 1. Entity model: tag defaults to marker; registration claims it

Extend the ADR-007 registry with a third resolution kind. A tag resolves to a
`marker` by default (existing behaviour). A device registration that quotes a tag
**upgrades** the binding to name the device that owns it:

```
tag_id → { kind: 'marker',  target_id }                 (default — bare scan)
tag_id → { kind: 'vehicle', target_id }                 (ADR-007 — a loco)
tag_id → { kind: 'device',  device_id, marker_id }      (new — a switch/gate/zone
                                                          installed AT that marker)
```

The marker still exists (the position is real); the device binding adds *who
actuates it*. This is what lets discovery learn "M-junction-3 is a junction
controlled by SWITCH-junction-3."

### 2. The onboarding handshake — three wire events

The device never talks to the garage; the **bridge** (ADR-003/021's always-on,
MQTT-connected node) is its mouthpiece. On real hardware the device broadcasts
over ESP-NOW (address-less); the bridge hears it and relays onto MQTT. The
simulator models the identical MQTT-level flow in-process, keeping it a true peer
(ADR-021). The handshake:

1. **`device_discovered`** *(new)*. An unpaired device in pair mode broadcasts an
   announce (its transport id + a device-kind hint + registry epoch, per ADR-021
   §3). The bridge assigns the `device_ref` (ADR-021 §5) and relays
   `device_discovered { device_ref, device_kind_hint }` to MQTT. The garage UI
   subscribes and shows a "new device noticed" modal.
2. **`device_association`** *(new)*. The garage invites the operator to scan a
   tag for this device. The scan binds the just-scanned marker tag to the
   `device_ref`; the system emits `device_association { device_ref, tag_id }`.
   The bridge relays it back to the device over the link; the device **persists**
   the resolved marker id (ideally in non-volatile memory). **Type-1 devices skip
   this step** — they already know their identity.
3. **`device_registered`** *(existing)*. The device now self-declares: its
   `capabilities`, `device_kind_hint`, the resolved `controls_marker_id` (already
   in the schema as of 0.12.0), and — new — its `valid_positions` (§3 below). On
   every subsequent boot a paired device re-announces *with* its stored marker and
   re-registers silently; only unpaired devices ever pop the modal.

Operator naming is **not** part of this. `device_registered` already carries an
optional operator-authored `name`/`livery` (0.12.0); the device self-declares its
kind, so the default is zero typing. A friendly name stays optional (worth
offering for stations, which are otherwise indistinguishable; pointless for
track).

### 3. A switch declares its positions; discovery materialises the junction

Add an optional `valid_positions: string[]` to `device_registered`, meaningful
for `core.controls_switch` devices — the per-state ids the device can be set to
(e.g. `['main', 'divert']`). The device already knows them (today they live
privately in `switch-device.ts` and only gate command validation); it simply
never puts them on the wire.

With that, the scheduler materialises a junction in discovery: when a
`core.controls_switch` device registers with `controls_marker_id` +
`valid_positions`, `LayoutState` records a junction in `junctionsByMarkerId` (so
`junctionMarkerIds()` returns it) carrying those positions. `LearnMode.armJunctions`
then has something to survey.

Two supporting changes close the second gap (untagged inferred legs):

- `armJunctions` drives by **position**, not by reading `requires_switch_state`
  off a possibly-untagged edge: it throws the switch to the first
  not-yet-confirmed-traversed `valid_position`.
- When a traversal is recorded *from* a junction marker, the new inferred edge is
  tagged with the switch position currently requested for that junction, so legs
  acquire their `requires_switch_state` as they are explored.

### 4. The seam: a fourth `PlatformProvider` backing + a mockable link

Per the user's instinct, model the link logic against a mock now. Three small
pieces, all in `@trainframe/simulator` beside the existing backings — **no new
package** (consistent with ADR-021 keeping the TCF codec in `protocol` under the
no-new-package rule; the real ESP-NOW radio is Rust firmware outside this repo):

- **`EspNowLink`** — the mockable radio and the *only* mocked thing. Minimal
  surface: `broadcast(frame)`, `sendTo(peer, frame)`, `onReceive(cb)`, plus test
  knobs to drop/reorder. Logical link semantics only — address-less broadcast +
  directed send — **not** radio physics (channels, retransmit, sleep). YAGNI.
- **`EspNowPlatform implements PlatformProvider`** — sits on the link. When a
  device calls `register()`, this backing runs the announce → discover →
  associate → register handshake over the link instead of publishing
  immediately. The device still imports only `PlatformProvider`; all pairing
  complexity hides here, exactly as the MQTT backing hides MQTT.
- **The pairing-aware bridge** — holds the link on one side, the broker on the
  other: hears announces, assigns `device_ref`, relays `device_discovered` and
  `device_association`. Real code, testable against the mock link + an in-process
  broker.

This matches the integration-test philosophy: mock only the radio; drive real
device + real bridge + real broker; observe the handshake through events.

### 5. Late-bound identity for type-3 devices

The central migration. Today a type-3 device receives its marker at construction
and bakes it into its announce event, its command filters, and its manifest
description. Under pairing the marker **arrives late** (via association). Type-3
devices must therefore accept their marker through an association callback and
defer building/emitting `device_registered` until it resolves — they cannot
self-describe to core at `start()`. (See Gotchas.)

## Gotchas surfaced by a device audit

A pass over all 25 files under `devices/`/`sensors/` (8 are platform-bearing)
found these load-bearing assumptions the pairing lifecycle breaks:

1. **`register()` then immediate `publish()` is a universal two-line idiom**
   (switch, gate, loco, both zones). All existing backings deliver both
   instantly; gating `register` async means the very next `publish` line must not
   fire before the link is open.
2. **Identity is smuggled through a `device_registered` *event*, not
   `register(manifest)`.** Both `inProcessPlatform` and `mqttPlatform` `register`
   ship only `capabilities` + `device_kind` — never a marker. Devices `publish` a
   hand-built `device_registered` carrying `controls_marker_id` /
   `owned_marker_ids` / `zone_marker_id` straight after. For type-3 devices that
   marker is the late-arriving association datum; today it is assumed present at
   `start()`. **This is the central gotcha.**
3. **The marker is baked into command filters and manifests too**, not just the
   announce: `SwitchDevice.handle` rejects commands whose `junction_marker_id`
   mismatches `this.d.junctionMarkerId`; `GateDevice` rejects markers outside
   `this.d.markers`. A late marker leaves these guards nothing to match until
   association completes.
4. **`onCommand` is keyed on a device id known up front**; the MQTT backing
   subscribes to `railway/commands/{deviceId}`. Under ESP-NOW the `device_ref` is
   assigned *by the bridge during discovery*, so command routing waits on
   discovery, not just association.
5. **Continuous heartbeat assumes an always-open link.** `ScheduledTrainDevice`
   publishes `train_status` every tick and ADR-028 dwell-resume depends on it. A
   sleepy/duty-cycled constrained peer would starve it. (Locos are type-1 and
   typically mains-powered; flagged, not solved here.)
6. **Composite peers front several logical sub-devices behind one platform**
   (`YardZoneDevice` interior loco via `ParentPlatform`; `DepotController`'s
   two-level nested turntable). A single physical association must fan out into
   several logical registrations; `ParentPlatform.platformFor` binds `childId` up
   front with no announce.

Type-1 (skip association): `BeaconDevice`, `ScheduledTrainDevice`. Type-3 (need
association): `SwitchDevice`, `GateDevice`, `YardZoneDevice`, `RailyardZoneDevice`,
`DepotController`.

## Phasing

The phases are independently shippable and ordered so the live bug is fixed
first, without waiting on the full onboarding redesign.

- **Phase 1 — junction discovery (unblocks the live bug; no ESP-NOW needed).**
  In-process/MQTT switch devices already register instantly with
  `controls_marker_id`. Add `valid_positions` to `device_registered`; materialise
  the junction in discovery (§3); make `armJunctions` drive by position and tag
  legs on traversal. Land a **junction-setup-and-learn integration test** that
  drives a real broker + server + a switch device through discovery and asserts
  both legs are surveyed and learning completes. These additions are
  forward-compatible with the full model.
- **Phase 2 — the pairing handshake.** `EspNowLink` + `EspNowPlatform` backing +
  the pairing-aware bridge; the `device_discovered` / `device_association` events;
  late-bound identity for the switch as the first type-3 device. Garage modal
  driven by `device_discovered`; the toy-table models pair-mode on device drop.
  This also delivers the registration-UX fix (one scan, no naming).
- **Phase 3+ — migrate the rest.** Gate, zones, composite/parent peers; the
  heartbeat/duty-cycle question (gotcha 5); marker persistence across reboot.

## Protocol changes

A new event *type* bumps both `PROTOCOL_VERSION` and the TCF registry epoch
(ADR-021 §3). Target **0.12.0 → 0.13.0**.

- **New events** `device_discovered { device_ref, device_kind_hint }` and
  `device_association { device_ref, tag_id }`. Both get appended TCF compact-IDs
  (the generic JSON carrier suffices for their size).
- **`device_registered`** gains optional `valid_positions: string[]` (meaningful
  for `core.controls_switch`). `controls_marker_id`, `name`, `livery` already
  exist (0.12.0).
- **Registry** (`tag-registry`) gains the `device` resolution kind (§1).
- `docs/spec/protocol-v0.2.md` and `version.ts` are updated at implementation
  time, not here.

## Consequences

- **Junctions are finally learnable in discovery** — the headline bug closes in
  Phase 1, decoupled from the larger redesign.
- **A real device-onboarding story exists**, completing ADR-007/021/031 instead
  of each deferring it. The simulator stays a true peer: it models the same
  MQTT-level handshake in-process.
- **The capability model is honoured** — a switch declaring its own positions is
  a device declaring its own parameters, not the sim publishing a layout (the
  world/core boundary of ADR-031 holds).
- **A real migration cost.** Every type-3 device moves from
  marker-known-at-construction to marker-via-association, touching its announce,
  command filters, and manifest (gotchas 2–3). Phasing contains this: Phase 1
  needs none of it; the switch leads in Phase 2; the rest follow.
- **Forward-only survey has a real ceiling: trailing junctions.** A junction the
  train meets FACING (entering from the trunk) is fully surveyed — the switch is
  thrown to each position and the loco drives out onto each leg, so the directed
  trunk→leg edges are learned. A junction it only ever meets TRAILING (entering
  from a leg, merging to the trunk) has both leg *tracks* traversed, but its
  directed trunk→leg edges cannot be learned forward-only: that needs a facing
  approach, which is the reverse way round the junction's loop. Phase 1 therefore
  defines "learn the track" as full TRACK coverage of every reachable
  connection + completion, and the live gate asserts exactly that (proven on the
  operator's real layout, whose `junction-3` is facing and `junction-23` is
  trailing). Learning the directed trunk→leg edges of a trailing junction needs a
  reverse-aware pass — deliberately deferred, since "forward-only" is a stated
  design principle (ADR-022 makes reverse special-circumstance). Not silently
  omitted: it is the open follow-up for whether full directed-edge learning is
  worth a bounded reverse step.
- **Deferred:** the heartbeat/duty-cycle reconciliation for sleepy constrained
  locos (gotcha 5), composite-peer fan-out (gotcha 6), and marker persistence
  semantics, all called out for Phase 3+.
- **New cost:** a mock link + a pairing-aware bridge to maintain, and a fourth
  `PlatformProvider` backing — the single place that knows the pairing lifecycle,
  exactly the chokepoint role ADR-021 reserves for the bridge.
