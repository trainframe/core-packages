# Experimental device 001: Vision length station

**Status:** speculative viability test. NOT normative; not expected in a typical
setup.

**Proves:** that a train's length can be *reported and changed at runtime by a
device that is not the train* — the seam [ADR-023](../adr/023-coupling-and-decoupling.md)
opened (`train_length_changed` event + `core.reports_length` capability). If this
device works end-to-end, the length-reporting model is viable and the
"detection lives outside the core" gap ADR-023 names has at least one real
answer. The average user never needs it.

## What it is

An otherwise-ordinary trackside station — a marker trains route to and dwell at —
with one extra trick: a camera (or depth sensor) and a small vision model that
**estimates the physical length of a train** as it passes through or sits at the
station. Everything else about it is a normal station: trains are scheduled to
it, dwell, and depart per the existing model. The vision element is purely
additive — strip it out and you still have a working station.

## Capabilities it declares

- `core.reports_length` (ADR-023) — the authority to assert a `train_length_mm`.
- Whatever a normal station/marker already needs for its stop role (it is a real
  marker on the layout).
- A way to know *which* train it is looking at — see **Identity** below. In
  practice it is co-located with (or itself performs) tag reading, so the train
  at the station resolves to a known `train_id` through the
  [ADR-007](../adr/007-tag-resolution-registry.md) tag registry.

## How it measures length (the allowed hand-wave)

The honest, load-bearing part is the *protocol interaction*; the computer vision
is allowed to be hypothetical. A plausible mechanism: as the train moves through
the camera's field at a calibrated marker, the station either measures the
train's image extent against a known background scale, or integrates
(observed speed × time-in-frame) from first nose-detection to last
tail-detection. Either yields a nose-to-tail estimate in millimetres.
Calibration, lighting, occlusion, curve foreshortening, and absolute accuracy are
explicitly **out of scope** — this is a viability test, not a product.

## What it emits

1. Resolve the train at the station to a `train_id` (tag observation → ADR-007
   registry).
2. Estimate the train's current length.
3. If the estimate differs from the train's last known `train_length_mm` beyond a
   hysteresis band (to avoid jitter), emit
   `train_length_changed { train_id, train_length_mm }`.
4. The scheduler, trusting the `core.reports_length` capability (ADR-023 — no
   value validation, the producer is trusted exactly as a tag-assigner is),
   updates the length and re-derives occupancy with its existing tail-release
   machinery.

This closes ADR-023's open loop: a child swaps carriages by hand; the next time
the train visits the station, its new length is measured and reported; its
tail-clearance occupancy self-corrects. No train-side sensing, no manual config.

## Why it's experimental, not the norm

- Most layouts have fixed-length trains or a length configured once; they never
  need runtime measurement.
- A camera plus a vision model at a station is far more hardware than the average
  Brio-on-the-floor setup wants.
- Its real value is as **proof**: a third-party device, built on nothing but
  public capabilities, changes a train's most safety-relevant physical fact
  through the same seam a built-in would use. That is the
  [ADR-001](../adr/001-capability-based-extensibility.md) extensibility promise,
  exercised end-to-end.

## Open questions (for the someday-session that builds it)

- **Identity under crowding.** If more than one train is near the station, whose
  length is this? Likely gated on the station's own tag read of the *dwelling*
  train — only assert a length for a train it is currently observing at it (the
  context-authority refinement ADR-023 flags, a natural fit: the camera only
  sees what is in front of it).
- **Hysteresis / debounce** so a noisy estimate does not emit a stream of
  `train_length_changed` events.
- **Where it lives.** A satellite repo (e.g. `trainframe/vision-station`), per
  CLAUDE.md's satellite naming — it consumes only public seams, so it never
  touches core.
