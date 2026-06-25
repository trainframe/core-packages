# Device Onboarding — Phase 1 (+ placement fix + registration abstraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Make the operator's real layout learnable live — junctions materialise in discovery so `LearnMode.armJunctions` surveys both legs and learning completes — plus the independent toy-table device-placement fix and the shared device-registration abstraction that Phase 2 will hang the pairing lifecycle on. Full contract: `.goal.md`.

**Architecture:** A `core.controls_switch` device already knows its `controls_marker_id` and `positions`; it simply never puts the positions on the wire and discovery never materialises a junction from the pairing. Phase 1 closes exactly that, end-to-end, proven against `test-track-layout.json` on a real broker + server in discovery mode.

**Tech Stack:** TypeScript (strict, no `any`), TypeBox schemas in `protocol`, Vitest, the `packages/integration` real-broker harness, Playwright for the placement journey.

## Global Constraints

- Zero `any` (existential-wrapper pattern where variance fights). Biome clean, no new `biome-ignore`.
- No `Math.random`/`Date.now` in core/sim; capability hooks pure. `noUncheckedIndexedAccess`/`exactOptionalPropertyTypes` honoured.
- Failing test first for every behaviour change. Integration tests over mocking — drive real broker/server/devices, observe events.
- Coverage floors held, never lowered. `pnpm typecheck && lint && test` green before a task is done.
- Each task its own commit; push only on explicit request. `docs/status.md` kept current.
- Per-fix adversarial review (REFUTE → CANNOT-REFUTE) before a task is called done.

---

### Task 1: Toy-table device-placement fix (independent — goal item 1)

**Files:**
- Modify: `packages/simulator-ui/src/components/ToyTable.tsx` (the `movePiece`/`placeFromCursor` path, ~1757-1789 / ~1231)
- Test: `packages/simulator-ui/src/components/ToyTable.device-placement.test.tsx` (new) and a `packages/ui-tests/tests/device-placement-snap.spec.ts` journey

**Root cause (already evidenced):** device pieces (train/carriage/gate) run through `placeFromCursor` → `computeMovePlacement`, the track endpoint-pairing snapper, which lands them at a meaningless paired endpoint; orientation only resolves via `spawnOrientationDeg` once near track.

- [ ] **Step 1 — failing unit test.** A train moved to a point near an edge snaps its CENTRE onto the nearest rail and adopts the rail heading (assert resulting `position` is the projection onto the nearest edge, `rotationDeg` equals the edge heading). Assert a track piece is unaffected.
- [ ] **Step 2 — run, confirm fail** (current code lands it at the endpoint-paired pose).
- [ ] **Step 3 — implement.** In `movePiece`, branch on `isDevicePiece(moving.type)`: device pieces use a new `placeDeviceOnNearestRail(centre, others)` (project centre onto nearest edge centreline, return projected point + edge heading) instead of `placeFromCursor`. Keep `spawnOrientationDeg` as the heading source if it already encodes the rail heading; otherwise fold heading into the projection. Track pieces keep `placeFromCursor` unchanged.
- [ ] **Step 4 — run unit + the existing ToyTable suites green.**
- [ ] **Step 5 — ui-tests journey:** drag the train across the table; assert it lands on the nearest edge, correctly oriented, in one gesture (no random offset, no late re-orient). Frame-reviewed recording.
- [ ] **Step 6 — adversarial review (REFUTE) on the placement maths; commit** `fix(toybox): device pieces snap onto the nearest rail, not the track endpoint snapper`.

---

### Task 2: Shared device-registration abstraction (goal item 2 — lands before Phase-1 wire change)

**Files:**
- Create: `packages/simulator/src/devices/registerable-device.ts` (the shared lifecycle seam)
- Modify: each platform-bearing device to route registration through it (`switch-device.ts`, `gate-device.ts`, `scheduled-train-device.ts`, `beacon-device.ts`, `yard-zone-device.ts`, `railyard-zone-device.ts`)
- Test: `packages/simulator/src/devices/registerable-device.test.ts`

**Interfaces — Produces:** a small helper/base the device calls in `start()`:
```
registerDevice(platform, { manifest, registeredEvent, onCommand }): () => void  // returns unsubscribe
```
It performs the universal idiom — `platform.register(manifest)` then `platform.publish(registeredEvent)` then `platform.onCommand(handler)` — in ONE place, so Phase 2 swaps the lifecycle (announce→associate→register) here once. Devices keep declaring their own `manifest`/`registeredEvent`/handler.

- [ ] **Step 1 — failing test:** a device routed through `registerDevice` emits a byte-identical `device_registered` event and subscribes to commands (drive an in-process platform, assert the published event equals the pre-refactor event; assert command delivery).
- [ ] **Step 2 — run, confirm fail** (function absent).
- [ ] **Step 3 — implement** `registerDevice`; pure orchestration over `PlatformProvider`, no transport knowledge.
- [ ] **Step 4 — migrate the 6 devices' `start()` to call it.** Their emitted events MUST stay byte-identical — existing device + integration tests are the guard.
- [ ] **Step 5 — full sim + integration suites green** (proves no behaviour change).
- [ ] **Step 6 — adversarial review (REFUTE the "byte-identical / no behaviour change" claim); commit** `refactor(sim): route device registration through one shared lifecycle seam`.

---

### Task 3: `valid_positions` on the wire (goal item 3a)

**Files:**
- Modify: `packages/protocol/src/events.ts` (`DeviceRegisteredPayload` — add optional `valid_positions`)
- Modify: `packages/simulator/src/devices/switch-device.ts` (`registeredEvent` includes `valid_positions: this.d.positions`)
- Test: `packages/protocol/src/events.test.ts` (schema accepts/round-trips), `switch-device` test (event carries positions)

- [ ] **Step 1 — failing schema test:** a `device_registered` with `valid_positions: ['main','divert']` validates and round-trips; absent stays valid (additive).
- [ ] **Step 2 — run, confirm fail.**
- [ ] **Step 3 — implement:** add `valid_positions: Type.Optional(Type.Array(Type.String()))` to `DeviceRegisteredPayload` with a doc comment (meaningful for `core.controls_switch`); switch device publishes it.
- [ ] **Step 4 — run protocol + sim tests green.**
- [ ] **Step 5 — adversarial review; commit** `feat(protocol): device_registered declares a switch's valid_positions`.

---

### Task 4: Discovery materialises a junction from the switch registration (goal item 3b)

**Files:**
- Modify: `packages/core/src/scheduler/layout-state.ts` (new `recordJunction(markerId, validPositions)` populating `junctionsByMarkerId`; upsert the marker if needed)
- Modify: `packages/core/src/scheduler/scheduler.ts` (`maybeRecordSwitchPairing` / device-registered handling: when `core.controls_switch` + `controls_marker_id` + `valid_positions`, call `recordJunction`)
- Test: `packages/core/src/scheduler/scheduler.test.ts`, `layout-state.test.ts`

- [ ] **Step 1 — failing test:** in discovery mode, a `device_registered` for a `core.controls_switch` device with `controls_marker_id: M` + `valid_positions` makes `layout.junctionMarkerIds()` include `M`. Currently returns `[]`.
- [ ] **Step 2 — run, confirm fail.**
- [ ] **Step 3 — implement** `recordJunction`; call it from the switch-pairing path. Idempotent; refuses a zone-owned marker (mirror existing pairing guard).
- [ ] **Step 4 — run core tests green.**
- [ ] **Step 5 — adversarial review; commit** `feat(core): discovery materialises a junction from a switch's registration`.

---

### Task 5: `armJunctions` drives by position; traversals tag legs (goal item 3c)

**Files:**
- Modify: `packages/core/src/scheduler/layout-state.ts` (`recordTraversal`: when `from` is a junction, stamp the new inferred edge's `requires_switch_state` with the currently-requested switch position)
- Modify: `packages/server/src/learn-mode.ts` (`armJunctions`/`firstUntraversedLeg`: choose the first `valid_position` not yet confirmed-traversed, throw it; track per-junction surveyed positions)
- Test: `packages/server/src/learn-mode.test.ts` (extend), `layout-state.test.ts`

- [ ] **Step 1 — failing test:** with a discovered junction (positions present, legs not yet tagged), `armJunctions` throws the switch to the first not-yet-surveyed position; after a traversal at that position, the leg carries `requires_switch_state` and the next untried position is chosen. Survey is monotone and terminates.
- [ ] **Step 2 — run, confirm fail.**
- [ ] **Step 3 — implement** position-driven survey + leg tagging on traversal.
- [ ] **Step 4 — run core + server tests green.**
- [ ] **Step 5 — adversarial review; commit** `feat(learn): survey junctions by position; tag inferred legs with the commanded state`.

---

### Task 6: THE LIVE GATE — learn `test-track-layout.json` (goal item 4)

**Files:**
- Create: `packages/integration/src/__fixtures__/test-track-layout.json` (move the 29-piece fixture from repo root into the suite)
- Create: `packages/integration/src/junction-learn-live.test.ts`
- Reuse: `packages/integration/src/harness.ts`, `physics-env.ts` `spawnSwitch`, the discovery-mode server wiring

- [ ] **Step 1 — write the failing live test.** Boot the real broker + server in discovery mode; build the world from the fixture (compile to markers/edges, spawn a `ScheduledTrainDevice` + a `SwitchDevice` per junction with its `positions`); register tags; emit `learn_track_start`; advance. Assert: each junction receives `set_switch_position` for BOTH legs; every edge of both legs of both junctions is in the learned layout; `railway/state/track_learning/active.state` reaches `complete`. Assert it is NOT stuck `driving` looping one branch.
- [ ] **Step 2 — run, confirm it fails** for the right reason (no switch thrown / junction not materialised) BEFORE Tasks 3-5 land; after them, it must pass.
- [ ] **Step 3 — make it pass** (Tasks 3-5 are the implementation; iterate here only on test wiring, not by weakening assertions).
- [ ] **Step 4 — manual chrome-devtools confirmation** on the live `pnpm dev:stack` mirroring the test (load fixture, scan train, Learn track, observe both legs surveyed + completion). Frame-reviewed.
- [ ] **Step 5 — final Phase-1 broad review (adversarial, whole-diff); update `docs/status.md`; commit** `test(integration): junctions learned live on the operator's real layout`.

---

## Self-review notes
- Spec coverage: items 1-4 of `.goal.md` map to Tasks 1,2,(3+4+5),6. Items 5-9 are Phase 2/3 + cross-cutting (separate plans / ongoing).
- Type consistency: `valid_positions` (Task 3) is the same field name read in Task 4's `recordJunction` and Task 5's `armJunctions`. `recordJunction(markerId, validPositions)` signature stable across Tasks 4-5.
- The live test (Task 6) is written failing-first but depends on Tasks 3-5 to pass — execute 1,2,3,4,5 then 6, or write 6 first and let it stay red until 5 lands.
