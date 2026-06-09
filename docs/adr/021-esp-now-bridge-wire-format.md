# ADR-021: The ESP-NOW ↔ MQTT bridge wire format

## Status

Accepted — implemented (June 2026), framework only. Trainframe Compact Frame
(TCF) codec landed in `packages/protocol/src/tcf/`: epoch-versioned
append-only registry of 1-byte event-type IDs, 13-byte header, ≤250-byte
frames, lossless expansion to the canonical JSON envelope (clock/newId
injected — no wall-clock/RNG), unknown IDs default-safe to `anomaly`.
Implementation deviations flagged for a future pass: the codec lives in
`protocol` (not a firmware-support package) under the no-new-package
constraint and is not yet exported from the package barrel; the per-type byte
codecs (and thus fitting the UUID-heavy payloads) remain the named deferred
follow-up — today's generic-JSON carrier overflows those types, asserted as a
boundary.

Resolves the open design question listed in CLAUDE.md and the protocol spec:
"the MQTT bridge wire format for ESP-NOW devices (compact event-type IDs vs.
full strings)." Builds on [ADR-003](003-mqtt-transport.md) (MQTT as the
application transport; the bridge re-publishes constrained-device messages onto
MQTT) and [ADR-001](001-capability-based-extensibility.md) (devices declare
capabilities; the server reasons in capabilities, never device classes).

## Context

ADR-003 and the protocol spec both name the bridge pattern but leave its
constrained-link encoding open:

> Trackside battery-powered devices may use ESP-NOW with a bridge that
> republishes their messages onto MQTT… The application protocol is the same
> regardless. The bridge pattern: a more capable device maintains the MQTT
> connection on behalf of constrained ones, translating their messages and
> tagging events with the originating device ID.

The unresolved part is *what the constrained device actually puts on the ESP-NOW
link*, because the JSON application envelope does not fit there.

ESP-NOW carries at most **250 bytes** of application payload per frame (the
ESP-IDF `esp_now_send` limit), with no fragmentation and no transport-level
retransmission of an application stream — each frame is independent, and a
constrained sender wants to publish-and-sleep. The current JSON envelope
(`BrokerBridge.publishEvent`, `encode-event.ts`) is:

```json
{
  "event_id": "uuid",
  "device_id": "uuid",
  "timestamp_device": "ISO8601",
  "event_type": "marker_traversed",
  "protocol_version": "0.4.0",
  "payload": { "train_id": "…", "marker_id": "…", "direction": "forward", … }
}
```

The envelope **alone** — two UUIDs (36 bytes each), an ISO-8601 timestamp (~24),
a string `event_type` (up to ~20), a version string, plus JSON punctuation and
keys — is already ~180–220 bytes before any payload. A `marker_traversed`
payload with two more UUID-shaped IDs overflows 250 bytes on its own. So a
naive "send the JSON over ESP-NOW too" approach does not merely waste
battery; for several real event types it does not *fit in a single frame*. A
wire format for the constrained link is therefore forced, not optional.

This appears to collide with the architectural commitment in CLAUDE.md and
ADR-003:

> **JSON over the wire.** CBOR may come later as a wire optimisation transparent
> to the application protocol. Don't reach for binary formats early.

The reconciliation, set out below, is that **"the wire" in that commitment is
the application bus (MQTT)**, not every physical radio hop beneath it. ADR-003
itself draws this line: "The bridge is the only thing that knows about ESP-NOW;
everything above sees a uniform MQTT view." A frame format private to the
ESP-NOW segment, fully expanded back to JSON at the bridge, changes nothing an
application sees — it is exactly the "transparent wire optimisation" the
commitment permits, scoped to the one link that demands it.

## Decision

### 1. A compact frame format lives **only** on the ESP-NOW link; the bridge is the sole translator

Define the **Trainframe Compact Frame (TCF)**: a small binary layout spoken
*between a constrained device and its bridge over ESP-NOW only*. The bridge
expands every inbound TCF frame into the full JSON envelope and publishes it on
MQTT exactly as `BrokerBridge.publishEvent` does today; it compacts every
outbound command (already filtered to the constrained device's `device_id`) from
JSON into TCF before transmitting. Application code, the scheduler, the
visualiser, and the simulator never see TCF — they see the same JSON envelope
they see for a WiFi train or a virtual device. This keeps the simulator a true
peer of hardware: it bridges JSON↔JSON in-process; a physical bridge does
JSON↔TCF; both present an identical MQTT face.

This is deliberately **not** "binarise the protocol." The application protocol
stays JSON (ADR-003 unchanged). TCF is a link-layer encoding, narrow in scope,
and is the one place that knows ESP-NOW — precisely the role ADR-003 reserves
for the bridge.

### 2. Frame layout: compact integer event-type IDs + a registry, not full strings

The decision the question poses — *compact integer event-type IDs vs. full
strings* — is resolved in favour of **integer IDs backed by a registry**, for
two reasons: it is the single largest, cheapest saving (a 1-byte ID replaces a
~12–20-byte string and its JSON key on every frame), and it is the field that
maps most cleanly and losslessly back to a string. Variable free-form payloads
are *not* hand-binarised field-by-field; see §4.

A TCF frame is:

```
byte 0:        version_epoch   (uint8)  registry epoch the sender encodes against (§3)
byte 1:        type_id         (uint8)  compact event-type / command-type ID (§3)
byte 2:        flags           (uint8)  bit0 = is_command; bit1 = payload_is_cbor; …
bytes 3..6:    device_ref      (uint32) bridge-local short handle for the device (§5)
bytes 7..8:    seq             (uint16) per-device monotonic counter (idempotency, §6)
bytes 9..12:   uptime_ms_lo    (uint32) device monotonic time since boot (§7)
bytes 13..N:   payload         compact payload bytes for this type_id (§4)
```

Header is **13 bytes**, leaving ~237 bytes for payload — ample for every current
event/command payload once the UUID/string/timestamp overhead is removed. The
header carries no UUIDs and no ISO-8601 string; the bridge synthesises
`event_id`, the full `device_id`, `timestamp_device`, and `protocol_version`
when it expands the frame (see §5–§7).

### 3. Event-type IDs stay in sync via a versioned registry + handshake negotiation

The protocol already enumerates a fixed, ordered set of core event and command
types (`packages/protocol/src/events.ts`: `device_registered`, `tag_observed`,
`marker_traversed`, … and the command set). We introduce a **compact-ID
registry**: a `protocol`-package table mapping each core `event_type` /
`command_type` string to a stable `uint8` ID, plus an integer **registry
epoch**. Properties:

- **Append-only and stable.** IDs are never reused or renumbered; a new type
  gets the next free ID. The epoch increments whenever an ID is added. The epoch
  is a property of the registry, distinct from `PROTOCOL_VERSION` (a new optional
  payload *field* bumps the protocol version but not the registry; a new
  event *type* bumps both).
- **Generated, not hand-kept.** The registry is derived from the same source of
  truth the JSON event constructors use, so the two cannot drift. A test asserts
  every `eventEnvelope(...)` / command type has exactly one compact ID and vice
  versa (CI fails on an unmapped type — the same "add code, add coverage"
  discipline this repo already enforces).
- **Negotiated on registration.** A constrained device announces the registry
  epoch it was built against inside its `device_registered` payload (carried, on
  first contact, in a TCF frame whose `type_id` for `device_registered` is fixed
  at the lowest ID and therefore stable across all epochs). The bridge/server
  compares epochs:
  - equal → talk freely;
  - device older than server → the server only ever sends that device `type_id`s
    that existed at the device's epoch (append-only guarantees the device
    understands all of them); newer types are simply never addressed to it;
  - device newer than server → the bridge rejects/anomalies the unknown ID
    rather than guessing (default-safe; surfaces as an `anomaly`, consistent with
    the spec's anomaly path).

`version_epoch` in every frame (byte 0) lets a bridge serving a fleet at mixed
firmware levels decode each frame against the right table without per-device
state, and lets a stale device be detected on its first frame.

### 4. Payloads: per-type compact codec, CBOR as the documented escape hatch

For each `type_id`, the registry pins a **payload codec**. Most core payloads
are small and fixed-shape (`marker_traversed` = train ref + marker ref +
direction enum; `clearance_request` = train ref + marker ref + edge ref), so
their codec is a fixed field order using the same short references as the header
(IDs, not UUIDs; enums, not strings). The bridge knows each codec and expands it
to the canonical JSON payload.

For payloads that are genuinely variable or rare (`anomaly` free-form text,
`device_registered` capability lists, future satellite events), the frame sets
`flags.payload_is_cbor` and carries **CBOR** in the payload region. This is
exactly the "CBOR as a transparent wire optimisation" ADR-003 anticipated — now
scoped to where it earns its keep (the constrained link) instead of being
imposed on the whole bus. The bridge runs `cbor → JSON object` and inserts it as
the envelope `payload`. CBOR is the *fallback*, not the default: fixed codecs win
on the hot, high-frequency events; CBOR covers the long tail without a
bespoke binary layout per rare type.

A frame that still cannot fit a single 250-byte transmission (a pathological
`device_registered` with a huge capability set) is the bridge's problem to solve
at registration time over a slower path, not the constrained link's — see
deferred follow-ups.

### 5. Device identity: short handles on the link, full `device_id` at the bridge

The constrained device is addressed on the ESP-NOW link by its 6-byte MAC and
referenced in-frame by a `uint32` bridge-local handle (`device_ref`), assigned
at pairing. The handle is carried in-frame (rather than relying on the delivered
sender MAC alone) so that one physical peer fronting several logical sub-devices
can disambiguate which one a frame is for, and so the bridge has a compact stable
key independent of MAC churn. The bridge holds the `device_ref` → canonical `device_id` (UUID)
mapping and **tags every expanded event with the originating device's full
`device_id`**, never the bridge's own — the spec's explicit requirement
(`new-device.md`: "A bridge publishing on behalf of a constrained device must use
the *originating* device's ID"). Commands inbound from MQTT are already topic-
addressed by `device_id`; the bridge maps that back to the `device_ref`/MAC.

### 6. `event_id` / idempotency: bridge-synthesised UUID from a per-device `seq`

Constrained devices do not generate UUIDs. Each frame carries a `uint16` `seq`
(per-device monotonic, wrapping). The bridge synthesises the envelope `event_id`
UUID and uses `(device_ref, seq)` to deduplicate ESP-NOW frame repeats before it
ever publishes — preserving the protocol's QoS-1 idempotency contract
(`event_id`/`command_id` dedupe) at the MQTT layer while sparing the device any
UUID machinery.

For the command direction, the bridge maps an inbound command's JSON
`command_id` to the outbound frame's `seq`; the constrained device echoes that
`seq` in its acknowledgement frame (`flags.is_command` clear, the ack event's
`type_id`), and the bridge correlates it back to the original `command_id` when
it expands the ack to JSON. This honours the spec's "the device echoes the
`command_id` in its acknowledgement event" contract without the device ever
handling a UUID — the round-trip stays lossless across the JSON↔TCF boundary in
both directions.

### 7. Timestamps: device monotonic uptime in-frame; wall-clock at the bridge

The frame carries the device's monotonic uptime (no RTC required on a sleepy
sensor). The bridge stamps `timestamp_device` as ISO-8601 wall-clock at receipt,
optionally corrected by the uptime delta for ordering within a burst. The
scheduler still sets `timestamp_server` on consumption, exactly as ADR-003
specifies. No constrained device needs a synchronised clock.

## Consequences

- **The architectural commitment holds.** JSON remains the application protocol;
  nothing above the bridge changes. TCF is a link-private encoding on the one
  segment whose physics forbid the JSON envelope, expanded losslessly at the
  bridge — the transparent optimisation ADR-003 permits, not a premature
  binarisation of the bus.
- **Frames fit.** A 13-byte header plus a fixed-codec payload puts every current
  event/command well inside 250 bytes, with battery-friendly publish-and-sleep
  and no fragmentation. The previously-overflowing `marker_traversed` and
  `device_registered` cases fit.
- **One generated registry is the new sync surface.** A CI test ties compact IDs
  to the JSON event/command set so they cannot drift; the epoch + per-frame
  `version_epoch` + registration handshake let mixed-firmware fleets coexist and
  make a stale device detectable on its first frame. Append-only IDs mean an old
  device never receives a type it can't decode.
- **Default-safe on the unknown.** An unrecognised `type_id` (device newer than
  server) becomes an `anomaly`, not a guess — consistent with the spec's
  "unknown is treated as unsafe" stance.
- **The simulator stays a true peer.** It continues to bridge JSON↔JSON in-
  process; only physical bridges run the TCF codec. Application tests are
  unaffected and need not know TCF exists.
- **New cost: the bridge gains a codec to maintain.** It is the single chokepoint
  that knows both encodings — acceptable, and exactly the role ADR-003 assigns
  the bridge. The codec belongs in a new satellite/firmware-support package, not
  in `core` (which stays I/O-free and link-agnostic) and not in `protocol`
  beyond the pure ID-registry table.

## Deferred follow-ups

- **Concrete per-type payload codecs.** This ADR fixes the *framework* (header,
  ID registry, codec-or-CBOR rule); the byte-level layout of each event's
  payload is mechanical follow-up, to land with the firmware-support package.
- **Oversized registration.** A `device_registered` with a capability list too
  large for one frame needs a slower multi-frame or out-of-band pairing path;
  out of scope here (rare, one-time, not on the hot path).
- **Satellite-defined event types over ESP-NOW.** Core types get fixed IDs;
  third-party (`railway/events/custom/{vendor}/…`) types need a vendor-scoped
  ID-allocation scheme or CBOR-by-default. Deferred until a satellite actually
  wants to run on a constrained link.
- **Thread / 6LoWPAN bridges.** Thread's larger MTU may not need TCF at all
  (CBOR or even JSON may fit). This ADR scopes to ESP-NOW; a Thread bridge is a
  separate decision that can reuse the ID registry if useful.
- **The TCF version_epoch vs. PROTOCOL_VERSION relationship** should be recorded
  in `version.ts` when the registry package lands, so the two bumps are
  documented together.
