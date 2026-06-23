# Garage Device Commissioning & Profiles — Design

**Date:** 2026-06-23
**Status:** draft for review
**Informed by:** the `garage-setup-ui-requirements` audit (2026-06-23) of the scan→bind flow, the visualiser, the protocol/manifest, the assumed data, and what core actually consumes.

## Problem

When a device is scanned today, commissioning happens entirely in the **toybox**: a read-only "Bind as `<id>`?" prompt, and `ToyTable.scanPiece` **fabricates the whole bus handshake** a real device would originate — a counter-derived `device_id`, a hardcoded capability list per piece *type*, a flat `train_length_mm = 60`, a livery from toybox UI state, a `marker_kind` inferred from the piece type, and a `tag_assignment` where `tag_id === target_id === "M-{piece.id}"`. Every datum is assumed; the operator's only choice is which piece to drag and Bind-vs-Cancel.

A real physical device supplies far less and a human supplies the rest. Three things are knowable **only by the operator at commission time**: (1) a friendly **name** for this instance, (2) **this loco's measured length** (the as-built consist, not a class default), and (3) **what a scanned tag is** (a Track, a Train, a Device — and, for a track, *which* marker it is, resolved later). The commissioning experience belongs in the **visualiser**, which owns content — and on the long-term hardware the visualiser *is* the garage's (kid-facing, e-paper) display.

## Locked decisions (from the requirements dialogue)

1. **Production-first.** The real scan→commission flow is the default. The toybox's fabrication path and the demo loaders stay behind the existing `import.meta.env.DEV` gate; dev tools are re-introduced as needed.
2. **Identity is the opaque tag id.** A real RFID/BLE/QR tag carries its own stable unique id; that is the device/marker identity. No more counter-minted ids that churn on reload.
3. **Operator classifies + names at commission; location is discovered later.** After a scan the operator picks a **category — Track / Train / Device** (Train is a special-cased Device, surfaced first for accessibility) and gives a friendly name. *Where* a track's marker sits in the layout is **not** set here — it is discovered later by driving (the existing learn-track / discovery flow).
4. **Core is driven by capabilities + topology ONLY.** `marker_kind`, category, and names are **presentation annotations** — the scheduler must never branch on them. "Dead end" comes from a marker having no outgoing edge; "junction" from a switch device controlling it. This line is what makes a swappable frontend safe: a mislabel can never endanger the railway.
5. **Carriages: length only.** A future capability may require tracking a carriage as *X* mm behind a lead, but not yet — the loco's operator-entered measured length is the source of truth.
6. **Logic separated from UI (MVVM).** The visualiser's commissioning logic is a **framework-agnostic ViewModel/API layer** with no React/DOM dependency; the React web UI is a thin View bound to it, and a future e-paper kid-facing View binds to the *same* layer. The logic is headless-testable and frontend-swappable.

## Architecture

### Layers (MVVM)

- **Model** — the wire/protocol types and the retained railway state (`railway/state/*`). Unchanged in shape except the protocol additions below.
- **ViewModel** — a new **framework-agnostic** commissioning domain module in the visualiser (e.g. `packages/visualiser/src/domain/commissioning/`), plain TypeScript, no React/DOM imports. It owns:
  - a **pending-commission queue**: items that have appeared (a real device that registered with capabilities, or a passive track tag observed) but have no operator profile yet;
  - **commands**: `classify(tagId, category)`, `setName`, `setTrainLength`, `bindTagToMarker` (deferred-capable), `confirm`, `dismiss`;
  - **persistence**: it emits the correctness facts through existing channels and the operator profile through the new retained channel (below);
  - **observable state** the View renders (the queue, commissioned profiles, per-device summary).
  It subscribes to the broker via an injected port (so it is testable with an in-memory client) and never touches the DOM.
- **View** — React components (`DevicesPanel`, a new commissioning surface) that bind to the ViewModel via thin hooks. The e-paper frontend is a *different* View over the same ViewModel; this spec does not design the e-paper rendering (different tech + kid-UX), only guarantees the seam.

### Why a ViewModel and not "just hooks"

The hard requirement is that the logic survives a frontend swap. Putting commission state + transitions + persistence in React hooks welds them to React. A plain module with an injected broker port can be driven entirely in a unit test (no `@testing-library/react`), and the e-paper frontend imports it directly. React hooks become a ~thin adapter that mirrors ViewModel state into component state.

## Protocol changes (version bump FIRST — per the working contract)

Bump `PROTOCOL_VERSION` 0.11.0 → **0.12.0**. Spec (`docs/spec/`) and schemas (`packages/protocol/`) land before any consumer code.

1. **Marker identity + name.** A marker gains a stable **technical id** (the tag id is the natural key) and an **optional operator `name`** (and optional `category`). The `tag_assignment` event currently has no label; add the name there (or in the marker record it creates) so naming a marker at bind time is expressible.
2. **Device name + livery, and a fattened retained snapshot.** Add first-class `name` and `livery` to device registration, and **widen `DeviceRetainedState`** (today only `capabilities` + `train_length_mm?`) so a late-subscribing display sees the operator-authored name/livery/length. Operator-authored profile must live in a **durable, retained** home — today it would be lost to a late joiner.
3. **`controls_marker_id` becomes first-class.** Core already consumes it (`scheduler.ts` switch↔junction pairing) but it is **absent from the schema** and read via an untyped cast; only the simulator's switch-device emits it. Add it to the device-registration payload so a spec-conformant third-party switch can actuate. (Decide: device-declared, operator-confirmed, or both — default both.)
4. **Tighten `assign_tag`.** The `assign_tag` *command* takes a free-string `marker_kind` while the `tag_assignment` *event* uses a closed enum — junk can enter the command and fail to round-trip. Tighten the command to the same enum.

No field added here is read by the scheduler for behaviour (decision 4). `name`, `livery`, `category`, `marker_kind` are presentation; `controls_marker_id`, `capabilities`, lengths remain the correctness inputs.

## Commissioning flow

1. **A thing appears.** A real device registers with its self-declared capabilities, or a passive track tag is observed. The ViewModel adds it to the pending-commission queue.
2. **Operator opens commissioning** for the item. The form is prefilled from the manifest/registration — capabilities (shown read-only, for the first time), declared defaults.
3. **Classify.** Operator picks **Track / Train / Device** (Train pre-suggested when the registration declares `core.controls_motion`; Device for other capability devices; Track for a passive tag).
4. **Name + per-class fields.** Friendly name (all); for a **Train**, the **measured length** (device default prefilled; note shown when a rake is attached); livery optional.
5. **Persist.** Correctness facts via existing paths — tag binding via the `assign_tag` admin/command path, length via a `core.reports_length` authority (`train_length_changed`). Operator profile (name/livery/category) via the new retained device/marker fields.
6. **Location is deferred.** For a Track, the tag now *exists and is named*; its position/topology in the layout is learned later by driving (learn-track). Commissioning never asks "where is it."

The tag-assigning authority on the target hardware is the visualiser/garage itself (it *is* the display); for now it signs tag bindings as the operator authority (today's fabricated `GARAGE`/`ADMIN-API` is the placeholder).

## Toybox vs visualiser boundary

- **Toybox** (production): emits only the bare device-appearance — a stable id (the tag) + the device's self-declared capabilities/defaults. It **stops fabricating** names, true lengths, and marker meaning. Its fabrication path and `__tfLoad*` demo loaders stay behind `import.meta.env.DEV`.
- **Visualiser**: all commissioning + content authoring, via the ViewModel.

## Testing strategy

- **ViewModel unit tests (headless, no DOM):** queue admits a newly-registered/scanned item; `classify`/`setName`/`setTrainLength`/`bindTagToMarker`/`confirm` transition it; `confirm` emits the right events / retained state; deterministic (injected clock/id, no `Date.now`/`Math.random`). This *is* the proof the logic is UI-independent.
- **Protocol schema tests:** new fields validate; the fattened retained snapshot round-trips; `assign_tag` rejects a non-enum `marker_kind`; `controls_marker_id` is first-class (a switch with it pairs + actuates; without it is the documented no-actuation case, no silent cast).
- **Core-untouched invariant:** a scheduler test proves identical routing/clearance with and without names/category/`marker_kind` — behaviour from capabilities + topology only.
- **Retained-profile durability:** over the real broker, a late-subscribing client sees an operator-named device (name/livery in the retained snapshot).
- **UI binding (thin):** a component test drives the real visualiser — a scan appears in the commission queue → pick Train → name + length → confirm → the device row shows the name/length.
- **Adversarial + recording:** an agent on the running UI tries to break commissioning (a scan that never queues; a confirm that drops name/length; a category leaking into core; a late client missing the profile) → CANNOT-REFUTE; a recording (scan → commission → named device persisting across a reload) reviewed frame-by-frame by a second adversary.

## Deferred / out of scope

- The **e-paper kid-facing frontend** itself (different tech + UX) — this spec only guarantees the ViewModel seam it will bind to.
- **Marker location/topology** — already handled by learn-track/discovery; commissioning only establishes identity + name + category.
- **Carriage wire identity** — length stays the loco's operator-entered value.
- **`marker_kind` gaining scheduler behaviour** — explicitly NOT done; it stays annotation.

## Open questions

- `controls_marker_id` — device-declared, operator-confirmed, or both? (Default: both — manifest hints, operator confirms.)
- Does the ViewModel module stay in `packages/visualiser/src/domain/` or graduate to its own package once a second frontend is real? (YAGNI: keep in visualiser, structured for extraction.)
- Tag→marker binding affordance: generalise the existing `UnknownTags` panel (which can only bind to an *existing* marker) to create + name a marker, folding it into the commission flow.
