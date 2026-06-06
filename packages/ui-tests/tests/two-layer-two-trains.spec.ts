import { expect, test } from '@playwright/test';
import type { Layout } from '@trainframe/protocol';
import { type UiHarness, startUiHarness } from '../src/test-harness.js';

/**
 * Two-train bridge demo — proven at the harness level with a hand-authored
 * two-layer Layout.
 *
 * The point under test is purely *routing* connectivity, not the editor's
 * height rendering: a layout in which one station (US, the "upper" station) is
 * reachable ONLY across a ramp edge that the junction must be diverted onto,
 * plus a second junction leg that lets ground traffic continue without ever
 * needing the upper deck. Layer/height never crosses the wire — the layout the
 * scheduler reasons over is an ordinary 2D marker/edge graph. The "bridge" is
 * realised exactly as ADR-011's crossover note prescribes: two markers sharing
 * a footprint with no shared marker between the decks, joined only by ramp
 * markers (RU/RD).
 *
 * Train A's schedule visits the upper station US; train B's schedule stays on
 * the ground stations. We assert via `tag_observed` (the device-side marker
 * reads the bridged Simulation emits) that:
 *   - A's observed-marker set INCLUDES US and the ramp markers (it climbed);
 *   - B's observed-marker set is a STRICT SUBSET of ground markers and NEVER
 *     contains US/RU/RD (it never entered the upper deck);
 *   - both trains' stop sequences repeat (they loop).
 *
 * Switch contention is the one real constraint (the scheduler never emits
 * `set_switch_position`; only LearnMode does). We pin J to 'divert' ONCE up
 * front so A's ramp-up edge (requires_switch_state: 'divert') is grantable, and
 * we author J with NO 'main'-constrained outbound edge at all, so no
 * satisfiable route can ever be silently denied for wanting 'main'. The
 * unconstrained ground-continue edge (J→G2) carries no switch state, so it is
 * grantable regardless of the pinned position.
 *
 * HONESTY NOTE (sim-as-peer-of-hardware contract): authoring J with only an
 * unconstrained ground-continue leg and a divert ramp leg — and treating the
 * ground-continue as switch-unconstrained — is more permissive than a physical
 * Y-switch, which would force one of the two legs to be 'main'-constrained.
 * That is acceptable for a toy-table/sim demo: the layout is hand-authored, the
 * faithful alternative (a scheduler that emits set_switch_position and grants on
 * confirmation) is a contingent future flag only needed when a topology forces a
 * train to leave the junction via a constrained leg opposite the ramp.
 */

// Ground loop (directed, clockwise): G1 → J → G2 → C1 → G1.
// J diverges up the ramp to the upper deck: J → RU → US → RD → C1.
// RU/US/RD are the upper-deck markers (RU = ramp-up top, US = upper station,
// RD = ramp-down top). RD rejoins the ground at C1.
//
// J's ONLY outbound edges are:
//   J → G2  (no requires_switch_state — the unconstrained ground-continue leg)
//   J → RU  (requires_switch_state: 'divert' — the ramp-up leg)
// so no route can ever need 'main' while J is pinned 'divert'.
const TWO_LAYER: Layout = {
  name: 'two-layer-two-trains',
  markers: [
    { id: 'G1', kind: 'station_stop' },
    { id: 'J', kind: 'junction' },
    { id: 'G2', kind: 'station_stop' },
    { id: 'C1', kind: 'block_boundary' },
    { id: 'RU', kind: 'block_boundary' },
    { id: 'US', kind: 'station_stop' },
    { id: 'RD', kind: 'block_boundary' },
  ],
  edges: [
    // Ground loop.
    { from_marker_id: 'G1', to_marker_id: 'J', estimated_length_mm: 200 },
    { from_marker_id: 'J', to_marker_id: 'G2', estimated_length_mm: 200 },
    { from_marker_id: 'G2', to_marker_id: 'C1', estimated_length_mm: 200 },
    { from_marker_id: 'C1', to_marker_id: 'G1', estimated_length_mm: 200 },
    // Ramp up onto the upper deck — the only way to reach US. Requires divert.
    {
      from_marker_id: 'J',
      to_marker_id: 'RU',
      estimated_length_mm: 200,
      requires_switch_state: 'divert',
    },
    // Upper deck, then ramp down rejoining the ground at C1.
    { from_marker_id: 'RU', to_marker_id: 'US', estimated_length_mm: 200 },
    { from_marker_id: 'US', to_marker_id: 'RD', estimated_length_mm: 200 },
    { from_marker_id: 'RD', to_marker_id: 'C1', estimated_length_mm: 200 },
  ],
  junctions: [{ marker_id: 'J', valid_positions: ['main', 'divert'] }],
};

const GROUND_MARKERS = new Set(['G1', 'J', 'G2', 'C1']);
const UPPER_MARKERS = new Set(['RU', 'US', 'RD']);

/** Yield to the event loop so broker round-trips (device events, switch
 * confirmations) are delivered to the server before the next synchronous step. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** Observed marker ids (tag_observed → payload.tag_id) for a given train. In
 * this harness identity tags are seeded so tag_id === marker_id. */
function observedMarkers(harness: UiHarness, deviceId: string): string[] {
  const out: string[] = [];
  for (const e of harness.simulation.getEventsOfType('tag_observed')) {
    if (e.device_id !== deviceId) continue;
    const tagId = (e.payload as { tag_id?: unknown }).tag_id;
    if (typeof tagId === 'string') out.push(tagId);
  }
  return out;
}

/** How many times `marker` appears in `observed` — used to prove looping
 * (the scheduler advances the stop index modulo the stop count, so a station
 * is re-observed on each lap). */
function countOf(observed: ReadonlyArray<string>, marker: string): number {
  return observed.filter((m) => m === marker).length;
}

test.describe
  .serial('Two trains run a two-layer bridge layout (A visits the upper deck, B stays ground)', () => {
    let harness: UiHarness;

    test.beforeAll(async () => {
      // Port 0 → the OS picks a free port; the harness reports the actual one.
      // Keeps this harness-only spec off the 9001 the browser specs share.
      harness = await startUiHarness({ layout: TWO_LAYER, wsPort: 0, seed: 1 });
    });

    test.afterAll(async () => {
      await harness.shutdown();
    });

    test('A reaches US + ramp markers and loops; B stays ground-only and loops', async () => {
      // Spawn the switch motor for J and pin it to 'divert' ONCE, before any
      // schedule, so the ramp-up edge is grantable when A first needs it. The
      // VirtualSwitch echoes switch_state_changed{confirmed:true}, which the
      // bridge forwards to the server's scheduler → LayoutState.setSwitchPosition.
      harness.simulation.spawnSwitch('SWITCH-J', 'J');
      harness.simulation.handleCommand('SWITCH-J', 'set_switch_position', { position: 'divert' });
      // Yield to the event loop so the device_registered + switch_state_changed
      // round-trip through the broker and reach the server's scheduler before we
      // assign schedules. `advance()` only steps the sim clock; it does not flush
      // the WebSocket, so a real microtask/timer yield is what delivers events.
      await tick();

      // Spawn both trains on distinct ground edges so they start spaced apart
      // and time-share the junction via section exclusivity (ADR-010/011). The
      // 4× toy speed keeps the test brisk: each train completes several laps
      // inside the poll budget so the looping assertions resolve quickly.
      harness.simulation.spawnTrain('A', {
        startEdge: { from_marker_id: 'C1', to_marker_id: 'G1' },
        config: { max_velocity_mm_s: 400 },
      });
      harness.simulation.spawnTrain('B', {
        startEdge: { from_marker_id: 'G2', to_marker_id: 'C1' },
        config: { max_velocity_mm_s: 400 },
      });
      // Let the trains' device_registered + first tag_observed reach the server
      // so the scheduler knows both trains and their positions before planning.
      await tick();

      // Operator intent: A cycles US → G2 (so the upper station recurs every
      // other stop and the loop is provable inside the budget); B cycles
      // G1 → G2. The planner routes each leg on demand. A's *→US leg is forced
      // across J→RU (divert); B has no stop on the upper deck so its transit
      // never leaves the ground loop.
      harness.server.assignSchedule('A', 'rA', ['US', 'G2']);
      harness.server.assignSchedule('B', 'rB', ['G1', 'G2']);

      // Pump the sim in a fixed deterministic loop until A has looped at least
      // twice (US observed ≥ 2) or we exhaust the iteration budget. A manual
      // loop (rather than expect.poll, whose back-off intervals would blow the
      // wall-clock budget over hundreds of short steps) keeps the run brisk and
      // deterministic. Each step advances the sim 200 ms and yields so the
      // bridged events and the server's resulting clearance grants round-trip.
      const MAX_STEPS = 400;
      for (let step = 0; step < MAX_STEPS; step++) {
        harness.advance(200);
        await tick();
        if (countOf(observedMarkers(harness, 'A'), 'US') >= 2) break;
      }

      const aObserved = observedMarkers(harness, 'A');
      const bObserved = observedMarkers(harness, 'B');

      // POSITIVE discriminator: A climbed the ramp and reached the upper deck.
      expect(aObserved).toContain('RU');
      expect(aObserved).toContain('US');
      expect(aObserved).toContain('RD');
      // A also services the ground stations on the way round.
      expect(aObserved).toContain('G2');

      // A loops: US (one of A's stops) is re-observed across laps. The pump
      // loop breaks the instant US hits 2, so we don't over-assert on the other
      // ground markers A happens to pass — US recurring is the looping proof.
      expect(countOf(aObserved, 'US')).toBeGreaterThanOrEqual(2);

      // NEGATIVE discriminator: B NEVER entered the upper deck.
      for (const m of UPPER_MARKERS) {
        expect(bObserved).not.toContain(m);
      }
      // B's observed set is a strict subset of the ground markers.
      for (const m of bObserved) {
        expect(GROUND_MARKERS.has(m)).toBe(true);
      }

      // B loops too: it re-visits both its stops across laps.
      expect(countOf(bObserved, 'G1')).toBeGreaterThanOrEqual(2);
      expect(countOf(bObserved, 'G2')).toBeGreaterThanOrEqual(2);
    });
  });
