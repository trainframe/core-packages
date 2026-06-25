import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { InMemoryBrokerClient } from '@trainframe/simulator/broker/in-memory-client.js';
import { CARRIAGE_SPACING_MM } from '@trainframe/simulator/track/coupling.js';
import { FLEX_BUDGET_DEG } from '@trainframe/simulator/track/flex.js';
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { SCANBOX_DATA_MIME } from './ScanBox.js';
import { ToyTable, type TrainLayerSource, effectiveLayer } from './ToyTable.js';

interface RenderResult {
  readonly client: InMemoryBrokerClient;
}

function renderToyTable(): RenderResult {
  const client = new InMemoryBrokerClient();
  // The toy table doesn't publish a retained layout — layout is system-
  // inferred — but a connected broker is still wanted so any device events
  // the table emits look identical to those from real hardware.
  client.connect('ws://test');
  render(
    <BrokerProvider client={client}>
      <ToyTable initialUrl="ws://test" />
    </BrokerProvider>,
  );
  return { client };
}

/** Decode a published envelope payload from raw bytes. */
function decodeEnvelope(payload: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder().decode(payload);
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Envelope is not a plain object');
  }
  return parsed as Record<string, unknown>;
}

/** Scan-flow `tag_assignment` payload — the one ToyTable.scanPiece emits. The
 *  in-browser ToyHardware also publishes `tag_assignment` (via
 *  `simulation.seedIdentityTags`) but those don't carry `marker_kind`. */
interface ScanFlowAssignmentPayload {
  readonly tag_id: string;
  readonly assigned_kind: string;
  readonly target_id: string;
  readonly marker_kind: string;
}

interface ScanFlowAssignment {
  readonly device_id: string;
  readonly payload: ScanFlowAssignmentPayload;
}

/** Pull out only the scan-flow `tag_assignment` events — the ones whose
 *  payload includes `marker_kind`. */
function filterScanFlowAssignments(client: InMemoryBrokerClient): ScanFlowAssignment[] {
  const result: ScanFlowAssignment[] = [];
  for (const m of client.published) {
    if (!m.topic.startsWith('railway/events/tag_assignment/')) continue;
    const env = decodeEnvelope(m.payload);
    const payload = env.payload;
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !('marker_kind' in payload)
    ) {
      continue;
    }
    const p = payload as Record<string, unknown>;
    const tag_id = p.tag_id;
    const assigned_kind = p.assigned_kind;
    const target_id = p.target_id;
    const marker_kind = p.marker_kind;
    const device_id = env.device_id;
    if (
      typeof tag_id !== 'string' ||
      typeof assigned_kind !== 'string' ||
      typeof target_id !== 'string' ||
      typeof marker_kind !== 'string' ||
      typeof device_id !== 'string'
    ) {
      continue;
    }
    result.push({
      device_id,
      payload: { tag_id, assigned_kind, target_id, marker_kind },
    });
  }
  return result;
}

/**
 * Drop a piece onto the scan box without clicking Bind — the confirmation
 * panel appears but no bus events are fired yet. Use this when a test needs
 * to assert on the confirmation-panel UI rather than the wire shape.
 */
function dropOnScanBoxOnly(scanBox: HTMLElement, pieceId: string): void {
  const dataTransfer = {
    getData: (mime: string) => (mime === SCANBOX_DATA_MIME ? pieceId : ''),
    setData: () => {},
    dropEffect: 'move',
    effectAllowed: 'move',
  };
  fireEvent.drop(scanBox, { dataTransfer });
}

/**
 * Drop a piece onto the scan box AND click Bind to complete the two-step
 * commissioning flow. After this call the bus events have been emitted,
 * mirroring the pre-confirmation-step behaviour. Updated to include the
 * Bind click so tests focused on wire shape don't need to know about the
 * intermediate confirmation panel.
 *
 * See the e2e `scanPiece` helper for the parallel change in
 * `playwright-helpers.ts`.
 */
function dropPieceOnScanBox(scanBox: HTMLElement, pieceId: string): void {
  dropOnScanBoxOnly(scanBox, pieceId);
  const bindBtn = screen.getByTestId('scan-box-bind');
  fireEvent.click(bindBtn);
}

// Canvas dimensions (must match the ToyTable constants).
const CANVAS_W_MM = 900;
const CANVAS_H_MM = 600;
const SCALE = 2;
const CANVAS_W_PX = CANVAS_W_MM * SCALE;
const CANVAS_H_PX = CANVAS_H_MM * SCALE;

/**
 * Mock getBoundingClientRect on Element.prototype so that coordinate-to-mm
 * conversions return deterministic values in jsdom. Returns a restore fn.
 *
 * All elements return the same mock rect so tests should call this ONLY for
 * the portions of the test that need the mock active, and restore right after.
 */
function mockCanvasRect(): () => void {
  const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: CANVAS_W_PX,
    bottom: CANVAS_H_PX,
    width: CANVAS_W_PX,
    height: CANVAS_H_PX,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  return () => spy.mockRestore();
}

describe('ToyTable — palette and placement', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the toybox with all track and device piece types', () => {
    renderToyTable();
    for (const type of ['straight', 'curve', 'junction', 'station', 'terminus', 'crossing']) {
      expect(screen.getByTestId(`toybox-${type}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('toybox-train')).toBeInTheDocument();
    expect(screen.getByTestId('toybox-gate')).toBeInTheDocument();
    expect(screen.getByTestId('toybox-railyard')).toBeInTheDocument();
  });

  it('places a railyard as wooden track straddled by a steel gantry', async () => {
    renderToyTable();

    placeByDrag('railyard');

    const placed = document.querySelector('[data-testid^="piece-railyard-"]');
    if (placed === null) throw new Error('no railyard placed');
    // The yard is real track now: its body fills with the beech-wood gradient,
    // not a flat device colour.
    const pathFills = Array.from(placed.querySelectorAll('path')).map((p) =>
      p.getAttribute('fill'),
    );
    expect(pathFills).toContain('url(#tf-wood)');
    // …and the XY gantry straddles it: steel foundations rendered as <rect>s.
    const rectFills = Array.from(placed.querySelectorAll('rect')).map((r) =>
      r.getAttribute('fill'),
    );
    expect(rectFills).toContain('#7c8a94');
    // An empty yard's crane is PARKED: with no train in the yard there is no
    // train to service, so the gantry runs none of its SMIL choreography —
    // "the crane only moves to act on trains".
    expect(placed.querySelectorAll('animateTransform')).toHaveLength(0);
  });

  it('drags a piece type onto the canvas without publishing any device traffic', async () => {
    const { client } = renderToyTable();

    placeByDrag('straight');
    const canvas = screen.getByTestId('toy-table-canvas');

    // A piece-* node now exists on the table.
    const placed = canvas.querySelectorAll('[data-testid^="piece-"]');
    expect(placed.length).toBe(1);

    // The in-browser sim seeds identity tags through its private bridge as soon
    // as the topology changes (so its later `tag_observed` events line up with
    // the scan flow's tag bindings). The garage registration + tag_assignment
    // for that piece are therefore expected; what should NOT appear is any
    // device-specific traffic — no train, no gate, no bare scan-flow
    // tag_assignment (those are gated on the operator using the scan-box).
    const trainOrGate = client.published.filter(
      (m) =>
        m.topic.startsWith('railway/events/device_registered/T-') ||
        m.topic.startsWith('railway/events/device_registered/GATE-'),
    );
    expect(trainOrGate).toHaveLength(0);
    // The scan-flow's tag_assignment carries `marker_kind`; the sim's seeded
    // one does not. No scan-flow assignment should have been emitted yet —
    // the operator hasn't used the scan-box.
    expect(filterScanFlowAssignments(client)).toHaveLength(0);
  });

  it('shows a marker indicator only once a track piece is SCANNED, including junctions', async () => {
    renderToyTable();
    const straightId = await placeArmedPiece('straight');
    const junctionId = await placeArmedPiece('junction');

    // No marker until scanned — a piece has no marker the core can see (nor a
    // dot) until the operator scans it onto the bus. The rails exist regardless.
    expect(screen.queryByTestId(`marker-${straightId}`)).toBeNull();
    expect(screen.queryByTestId(`marker-${junctionId}`)).toBeNull();

    const scanBox = screen.getByTestId('scan-box');
    dropPieceOnScanBox(scanBox, straightId);
    dropPieceOnScanBox(scanBox, junctionId);

    // A marker dot exists for the straight AND the junction once scanned.
    expect(screen.getByTestId(`marker-${straightId}`)).toBeTruthy();
    expect(screen.getByTestId(`marker-${junctionId}`)).toBeTruthy();

    // The dot is non-interactive (drawn under devices, never intercepts clicks).
    const dot = screen.getByTestId(`marker-${junctionId}`);
    expect(dot.style.pointerEvents).toBe('none');
  });

  it('orders marker indicators BEFORE device/train elements so a train is not pierced by a dot', async () => {
    renderToyTable();
    const straightId = await placeArmedPiece('straight');
    const trainId = await placeArmedPiece('train');
    // The marker dot appears only once the track piece is scanned.
    dropPieceOnScanBox(screen.getByTestId('scan-box'), straightId);

    // Within the rendered SVG, the marker dot for a track piece must appear
    // earlier in document order than the train piece, so the train (later =
    // painted on top) is never pierced by the marker dot beneath it.
    const all = Array.from(
      document.querySelectorAll('[data-testid^="marker-"], [data-testid^="piece-"]'),
    );
    const markerIdx = all.findIndex(
      (el) => el.getAttribute('data-testid') === `marker-${straightId}`,
    );
    const trainIdx = all.findIndex((el) => el.getAttribute('data-testid') === `piece-${trainId}`);
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(trainIdx).toBeGreaterThanOrEqual(0);
    expect(markerIdx).toBeLessThan(trainIdx);
  });

  it('fans out the livery options when the carriage tool is armed', async () => {
    const user = userEvent.setup();
    renderToyTable();

    // No carriage armed → no fan.
    expect(screen.queryByTestId('toybox-carriage-color-purple')).toBeNull();

    await user.click(screen.getByTestId('toybox-carriage'));
    expect(screen.getByTestId('toybox-carriage-color-red')).toBeInTheDocument();
    expect(screen.getByTestId('toybox-carriage-color-purple')).toBeInTheDocument();
  });

  it('places a carriage in the picked livery (drag with the chosen variant)', () => {
    renderToyTable();
    placeByDrag('carriage', { colorId: 'purple' });

    const placed = document.querySelector('[data-testid^="piece-carriage-"]') as HTMLElement | null;
    if (!placed) throw new Error('no carriage placed');
    // The carriage body path is filled with the purple livery, not the default
    // blue — the wagon carries its colour intrinsically so it stays trackable.
    const fills = Array.from(placed.querySelectorAll('path')).map((p) => p.getAttribute('fill'));
    expect(fills).toContain('#8c5bb0');
    expect(fills).not.toContain('#3f6fa6'); // not the default blue
  });

  it('fans out the length options when the straight tool is armed', async () => {
    const user = userEvent.setup();
    renderToyTable();

    // No straight armed → no fan.
    expect(screen.queryByTestId('toybox-straight-length-60')).toBeNull();

    await user.click(screen.getByTestId('toybox-straight'));
    // The LILLABO family — the short members are the loop-closers.
    expect(screen.getByTestId('toybox-straight-length-30')).toBeInTheDocument();
    expect(screen.getByTestId('toybox-straight-length-60')).toBeInTheDocument();
    expect(screen.getByTestId('toybox-straight-length-200')).toBeInTheDocument();
  });

  it('picking a length collapses the fan + disarms; pressing again re-arms to it', async () => {
    const user = userEvent.setup();
    renderToyTable();

    const straight = screen.getByTestId('toybox-straight');
    await user.click(straight); // arm + fan out
    expect(straight).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByTestId('toybox-straight-length-60')); // pick
    // "resets arm": the fan collapsed AND the tile disarmed.
    expect(screen.queryByTestId('toybox-straight-length-60')).toBeNull();
    expect(straight).toHaveAttribute('aria-pressed', 'false');

    // Pressing again re-arms (and re-opens the fan) — now to the chosen 60 mm.
    await user.click(straight);
    expect(straight).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('toybox-straight-length-60')).toHaveAttribute('aria-pressed', 'true');
  });

  it('places a straight at the picked length (drag with the chosen variant)', () => {
    renderToyTable();
    placeByDrag('straight', { lengthMm: 60 });

    const placed = document.querySelector('[data-testid^="piece-straight-"]') as HTMLElement | null;
    if (!placed) throw new Error('no straight placed');
    expect(placed.getAttribute('data-length-mm')).toBe('60');
  });

  it('stamps no length override on a straight dragged at the default 200 mm', () => {
    renderToyTable();
    // Drag the straight without configuring a length → keeps the default (200 mm).
    placeByDrag('straight');

    const placed = document.querySelector('[data-testid^="piece-straight-"]') as HTMLElement | null;
    if (!placed) throw new Error('no straight placed');
    expect(placed.getAttribute('data-length-mm')).toBeNull();
  });

  it('collapses the variant fan when a different piece is armed', async () => {
    const user = userEvent.setup();
    renderToyTable();

    await user.click(screen.getByTestId('toybox-straight'));
    expect(screen.getByTestId('toybox-straight-length-60')).toBeInTheDocument();

    // Arming another piece collapses the open fan.
    await user.click(screen.getByTestId('toybox-curve'));
    expect(screen.queryByTestId('toybox-straight-length-60')).toBeNull();
  });

  it('fans out the livery options when the train tool is armed', async () => {
    const user = userEvent.setup();
    renderToyTable();

    expect(screen.queryByTestId('toybox-train-color-green')).toBeNull();

    await user.click(screen.getByTestId('toybox-train'));
    expect(screen.getByTestId('toybox-train-color-green')).toBeInTheDocument();
    // The loco defaults to red — its option is the current one.
    expect(screen.getByTestId('toybox-train-color-red')).toHaveAttribute('aria-pressed', 'true');
  });

  it('places a train in the picked livery (drag with the chosen variant)', () => {
    renderToyTable();
    placeByDrag('train', { colorId: 'green' });

    const placed = document.querySelector('[data-testid^="piece-train-"]') as HTMLElement | null;
    if (!placed) throw new Error('no train placed');
    // The loco body carries the green livery, not the default red.
    const fills = Array.from(placed.querySelectorAll('path')).map((p) => p.getAttribute('fill'));
    expect(fills).toContain('#3f8f54'); // green livery
    expect(fills).not.toContain('#cf4436'); // not the default red loco
  });

  it('leaves a default (red) train its standard colour with no livery override', () => {
    renderToyTable();
    // Drag the train without picking a livery — the loco keeps DEVICE_FILL.
    placeByDrag('train');

    const placed = document.querySelector('[data-testid^="piece-train-"]') as HTMLElement | null;
    if (!placed) throw new Error('no train placed');
    const fills = Array.from(placed.querySelectorAll('path')).map((p) => p.getAttribute('fill'));
    expect(fills).toContain('#cf4436'); // the standard red loco
  });
});

function rawPtr(type: string, xPx: number, yPx: number): Event {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: xPx,
    clientY: yPx,
  });
}

/**
 * Place a piece by DRAGGING it from the parts tray (the sole placement path now
 * arming is gone): optionally configure a variant first (tap the tile to open
 * the fan + pick a length/livery), then press the tile and drag onto the canvas
 * at (xMm,yMm), releasing to commit. Returns the new piece's id.
 */
function placeByDrag(
  type: string,
  opts: { xMm?: number; yMm?: number; lengthMm?: number; colorId?: string } = {},
): string {
  const restore = mockCanvasRect();
  try {
    const tile = screen.getByTestId(`toybox-${type}`);
    if (opts.lengthMm !== undefined) {
      act(() => void fireEvent.click(tile)); // open the fan
      act(() => void fireEvent.click(screen.getByTestId(`toybox-${type}-length-${opts.lengthMm}`)));
    }
    if (opts.colorId !== undefined) {
      act(() => void fireEvent.click(tile));
      act(() => void fireEvent.click(screen.getByTestId(`toybox-${type}-color-${opts.colorId}`)));
    }
    const xMm = opts.xMm ?? CANVAS_W_MM / 2;
    const yMm = opts.yMm ?? CANVAS_H_MM / 2;
    act(() => void tile.dispatchEvent(rawPtr('pointerdown', 5, 5)));
    act(() => void window.dispatchEvent(rawPtr('pointermove', xMm * SCALE, yMm * SCALE)));
    act(() => void window.dispatchEvent(rawPtr('pointerup', xMm * SCALE, yMm * SCALE)));
  } finally {
    restore();
  }
  const placed = document.querySelector(`[data-testid^="piece-${type}-"]`) as HTMLElement | null;
  if (!placed) throw new Error(`no ${type} placed`);
  const pieceId = placed.getAttribute('data-piece-id');
  if (!pieceId) throw new Error('placed piece missing data-piece-id');
  return pieceId;
}

/** Place a piece of the given type via the drag path and return its piece id. */
async function placeArmedPiece(type: string): Promise<string> {
  return placeByDrag(type);
}

describe('ToyTable — scan and power', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('placing a train without scanning emits no broker events for that device', async () => {
    const { client } = renderToyTable();

    await placeArmedPiece('train');

    // No `railway/events/*/T-…` topic should have been published for the new
    // train — train pieces don't contribute to topology so neither the scan
    // flow nor the in-browser sim should announce them until the operator
    // scans the piece. (Track pieces would publish their seeded tag here.)
    const trainEvents = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_registered/T-'),
    );
    expect(trainEvents).toHaveLength(0);
  });

  it('scanning a placed track piece announces GARAGE and binds the marker tag', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('station');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    // GARAGE announces itself with the assigns_tags capability. The in-browser
    // ToyHardware also announces a GARAGE through its private bridge when it
    // seeds identity tags after a topology change — that's a deliberate
    // duplicate (idempotent server-side) so we assert at least one rather
    // than exactly one here.
    const garageRegs = client.published.filter(
      (m) => m.topic === 'railway/events/device_registered/GARAGE',
    );
    expect(garageRegs.length).toBeGreaterThanOrEqual(1);
    const garageReg = garageRegs[0];
    if (!garageReg) throw new Error('unreachable');
    const garageEnvelope = decodeEnvelope(garageReg.payload);
    expect(garageEnvelope.device_id).toBe('GARAGE');
    const garagePayload = garageEnvelope.payload as { capabilities: string[] };
    expect(garagePayload.capabilities).toEqual(['core.assigns_tags']);

    // The scan-flow's tag_assignment carries `marker_kind` — that's what
    // separates it from the in-browser sim's identity-tag seeding (which
    // emits `tag_assignment` without `marker_kind`, since `seedIdentityTags`
    // doesn't know it). Filter on `marker_kind` presence to isolate the
    // scan-flow event.
    const scanAssigns = filterScanFlowAssignments(client);
    expect(scanAssigns.length).toBe(1);
    const scanAssign = scanAssigns[0];
    if (!scanAssign) throw new Error('unreachable');
    expect(scanAssign.payload.tag_id).toBe(`M-${pieceId}`);
    expect(scanAssign.payload.assigned_kind).toBe('marker');
    expect(scanAssign.payload.target_id).toBe(`M-${pieceId}`);
    expect(scanAssign.payload.marker_kind).toBe('station_stop');
    expect(scanAssign.device_id).toBe('GARAGE');
  });

  it('emits block_boundary marker_kind for plain track pieces', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('straight');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    const scanAssigns = filterScanFlowAssignments(client);
    expect(scanAssigns.length).toBe(1);
    expect(scanAssigns[0]?.payload.target_id).toBe(`M-${pieceId}`);
    expect(scanAssigns[0]?.payload.marker_kind).toBe('block_boundary');
  });

  it('emits junction and terminus marker_kinds for junction and terminus pieces', async () => {
    const { client } = renderToyTable();
    const junctionId = await placeArmedPiece('junction');
    const terminusId = await placeArmedPiece('terminus');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), junctionId);
    dropPieceOnScanBox(screen.getByTestId('scan-box'), terminusId);

    const scanAssigns = filterScanFlowAssignments(client);
    expect(scanAssigns.length).toBe(2);
    const kinds = scanAssigns.map(({ payload }) => ({
      target_id: payload.target_id,
      marker_kind: payload.marker_kind,
    }));
    expect(kinds).toEqual([
      { target_id: `M-${junctionId}`, marker_kind: 'junction' },
      { target_id: `M-${terminusId}`, marker_kind: 'terminus' },
    ]);
  });

  it('GARAGE only announces itself once across multiple track scans', async () => {
    const { client } = renderToyTable();
    const pieceA = await placeArmedPiece('straight');
    const pieceB = await placeArmedPiece('curve');

    // Both the scan-flow (in `ToyTable.scanPiece`) AND the in-browser
    // ToyHardware (via `seedIdentityTags`) publish `device_registered/GARAGE`
    // — we can't distinguish on capability alone, since both use
    // `core.assigns_tags`. But scanning doesn't trigger `syncLayout` (it
    // only flips `liveIds`), so the seeded GARAGE regs are all captured
    // BEFORE the drops. Snapshotting the count before/after isolates the
    // scan-flow's contribution, and lets us verify the once-only flag:
    // dropping two pieces in succession should only add ONE GARAGE reg.
    const topic = 'railway/events/device_registered/GARAGE';
    const before = client.published.filter((m) => m.topic === topic).length;
    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceA);
    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceB);
    const after = client.published.filter((m) => m.topic === topic).length;
    expect(after - before).toBe(1);

    // Every scan still produces its own scan-flow tag_assignment (the one
    // carrying `marker_kind`).
    const scanAssigns = filterScanFlowAssignments(client);
    expect(scanAssigns.length).toBe(2);
  });

  it('dropping a placed train onto the scan box publishes device_registered with the train capabilities', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('train');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    // The scan-flow `scanPiece` announces the train with the route-capable
    // manifest (length-aware payload). On the physics architecture the spawned
    // `ScheduledTrainDevice` ALSO self-announces a `device_registered` when it
    // starts (ADR-013 — the device speaks for itself), with its own (narrower)
    // capability manifest. Both legitimately fire on the `T-` topic, so we pick
    // out the scan-flow registration — the one declaring `core.accepts_route`.
    const regEnvelopes = client.published
      .filter((m) => m.topic.startsWith('railway/events/device_registered/T-'))
      .map((m) => decodeEnvelope(m.payload));
    expect(regEnvelopes.length).toBeGreaterThanOrEqual(1);
    const scanReg = regEnvelopes.find((env) =>
      ((env.payload as { capabilities: string[] }).capabilities ?? []).includes(
        'core.accepts_route',
      ),
    );
    if (scanReg === undefined) throw new Error('no scan-flow train registration found');
    expect(scanReg.event_type).toBe('device_registered');
    expect(scanReg.protocol_version).toBe(PROTOCOL_VERSION);
    const payload = scanReg.payload as { capabilities: string[] };
    // Toy-table trains declare can_reverse so they can be admitted to a railyard
    // zone (ADR-027 — its interior is worked by shunting).
    expect(payload.capabilities).toEqual([
      'core.controls_motion',
      'core.accepts_route',
      'core.can_reverse',
    ]);

    // Scanning a train must not trigger the scan-flow's GARAGE announcement
    // (that's only for track pieces). The in-browser sim may have emitted its
    // own GARAGE registration through `seedIdentityTags`, which is unrelated
    // — what we check is that no scan-flow `tag_assignment` (the one with
    // `marker_kind`) ever fired for this train piece.
    expect(filterScanFlowAssignments(client)).toHaveLength(0);
  });

  it('dropping a placed railyard onto the scan box announces a gates_zone device', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('railyard');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    const regs = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_registered/YARD-'),
    );
    // At least one gates_zone registration for the yard. (The scan flow announces
    // it; once the yard is also live its in-browser virtual device re-announces
    // the same id — both are idempotent and carry identical capabilities, since
    // the railyard now owns a track marker so the sim device always spawns.)
    expect(regs.length).toBeGreaterThanOrEqual(1);
    for (const reg of regs) {
      const payload = decodeEnvelope(reg.payload).payload as { capabilities: string[] };
      expect(payload.capabilities).toEqual(['core.gates_zone', 'core.reports_length']);
    }
  });

  it('clicking a live train SELECTS it — it stays live and is NOT powered off', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('train');

    const placed = document.querySelector(`[data-piece-id="${pieceId}"]`) as HTMLElement | null;
    if (!placed) throw new Error('unreachable');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    expect(placed.getAttribute('data-live')).toBe('true');

    // After placeArmedPiece the operator is still "holding" a train type
    // (so they could drop more without re-arming). Clicks on existing pieces
    // are place actions while armed — disarm first by clicking the toybox
    // button again so subsequent clicks reach the piece's own handler.
    await user.click(screen.getByTestId('toybox-train'));
    fireEvent.click(placed);

    // Clicking the body of a LIVE train selects it. It must NOT power off:
    // no device_disconnected, and it stays live (so it keeps rendering at its
    // simulated position rather than teleporting back to the placement marker).
    const disconnects = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_disconnected/T-'),
    );
    expect(disconnects.length).toBe(0);
    expect(placed.getAttribute('data-live')).toBe('true');
    // The action bar offers an explicit Power off affordance for the now-selected
    // live train.
    expect(screen.getByTestId('action-power-off')).toBeTruthy();
  });

  it('clicking a live train`s power dot powers it OFF IN PLACE — inert, no device_disconnected, stays on the bus', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('train');

    const placed = document.querySelector(`[data-piece-id="${pieceId}"]`) as HTMLElement | null;
    if (!placed) throw new Error('unreachable');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    expect(placed.getAttribute('data-live')).toBe('true');
    expect(placed.getAttribute('data-powered')).toBe('true');

    await user.click(screen.getByTestId('toybox-train')); // disarm
    fireEvent.click(screen.getByTestId(`power-${pieceId}`));

    // Power-off is NOT a disconnect: a dead train doesn't announce its
    // departure, it just stops talking. The server keeps its block reserved.
    const disconnects = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_disconnected/T-'),
    );
    expect(disconnects.length).toBe(0);
    // It stays on the bus (live), but is now inert (not powered) — rendered
    // dark at its frozen sim position rather than despawned/teleported.
    expect(placed.getAttribute('data-live')).toBe('true');
    expect(placed.getAttribute('data-powered')).toBe('false');
    // The piece is still in the sim (not despawned).
    expect(screen.getByTestId(`piece-${pieceId}`)).toBeTruthy();

    // Power it back ON via the dot — it returns to driven.
    fireEvent.click(screen.getByTestId(`power-${pieceId}`));
    expect(placed.getAttribute('data-powered')).toBe('true');
    expect(
      client.published.filter((m) => m.topic.startsWith('railway/events/device_disconnected/T-'))
        .length,
    ).toBe(0);
  });

  it('the ActionBar Power off/on button toggles a selected live train in place (no disconnect)', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('train');

    const placed = document.querySelector(`[data-piece-id="${pieceId}"]`) as HTMLElement | null;
    if (!placed) throw new Error('unreachable');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    await user.click(screen.getByTestId('toybox-train')); // disarm
    fireEvent.click(placed); // select the live train

    // A powered train shows "Power off".
    fireEvent.click(screen.getByTestId('action-power-off'));
    expect(placed.getAttribute('data-live')).toBe('true');
    expect(placed.getAttribute('data-powered')).toBe('false');
    expect(
      client.published.filter((m) => m.topic.startsWith('railway/events/device_disconnected/T-'))
        .length,
    ).toBe(0);

    // Now the button reads "Power on" and resumes the train.
    fireEvent.click(screen.getByTestId('action-power-on'));
    expect(placed.getAttribute('data-powered')).toBe('true');
  });

  it('deleting a selected live train publishes exactly one device_disconnected', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('train');

    const placed = document.querySelector(`[data-piece-id="${pieceId}"]`) as HTMLElement | null;
    if (!placed) throw new Error('unreachable');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    expect(placed.getAttribute('data-live')).toBe('true');

    await user.click(screen.getByTestId('toybox-train')); // disarm
    fireEvent.click(placed); // select the live train

    /* Delete is a genuine despawn: the device announced itself at scan time,
     * so its departure must be wire-visible — even though the piece and its
     * live id leave in the same render, and a train with no track never
     * spawned in the in-browser sim. */
    await user.keyboard('{Delete}');

    const disconnects = client.published.filter(
      (m) => m.topic === `railway/events/device_disconnected/T-${pieceId}`,
    );
    expect(disconnects).toHaveLength(1);
  });

  it('dropping a gate publishes device_registered with the gating capability', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('gate');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    // Two publishes are expected: the scan-time announcement from ToyTable
    // and the spawn-time announcement from ToyHardware's virtual gate via the
    // broker bridge. Both carry the same device_id and capability payload,
    // and the server's device_registered handler upserts by device_id so the
    // duplicate is harmless. We pin the capability shape on the first
    // publish, which is the operator-visible behaviour the test cares about.
    const regs = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_registered/GATE-'),
    );
    expect(regs.length).toBeGreaterThanOrEqual(1);
    const reg = regs[0];
    if (!reg) throw new Error('unreachable');
    const envelope = decodeEnvelope(reg.payload);
    const payload = envelope.payload as { capabilities: string[] };
    expect(payload.capabilities).toEqual(['core.gates_clearance']);
  });

  it('a live gate`s power dot is a status-only cue — not an interactive button', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('gate');

    const placed = document.querySelector(`[data-piece-id="${pieceId}"]`) as HTMLElement | null;
    if (!placed) throw new Error('unreachable');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    expect(placed.getAttribute('data-live')).toBe('true');

    // Power-in-place is a TRAIN concept; a gate has no inert state. Its dot
    // shows live/inert colour but must NOT pose as a button (which would be a
    // dead affordance: clicking it does nothing). Clicking it is a harmless
    // no-op — no despawn, no device_disconnected.
    await user.click(screen.getByTestId('toybox-gate')); // disarm
    const dot = screen.getByTestId(`power-${pieceId}`);
    expect(dot.getAttribute('role')).toBeNull();
    fireEvent.click(dot);
    const disconnects = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_disconnected/GATE-'),
    );
    expect(disconnects.length).toBe(0);
    expect(placed.getAttribute('data-live')).toBe('true');
  });
});

describe('ToyTable — scan confirmation two-step flow', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('dropping a piece onto the scan-box shows the confirmation panel without firing bus events', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('straight');
    const before = client.published.length;

    dropOnScanBoxOnly(screen.getByTestId('scan-box'), pieceId);

    // Confirmation panel must be visible.
    expect(screen.getByTestId('scan-box-bind')).toBeInTheDocument();
    expect(screen.getByTestId('scan-box-cancel')).toBeInTheDocument();

    // No new bus events until Bind is clicked.
    const scanAssigns = filterScanFlowAssignments(client);
    expect(scanAssigns).toHaveLength(0);
    // No extra traffic of any kind from the scan drop itself.
    expect(client.published.length).toBe(before);
  });

  it('clicking Bind after a drop fires the bus events and makes the piece live', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('straight');

    dropOnScanBoxOnly(screen.getByTestId('scan-box'), pieceId);
    fireEvent.click(screen.getByTestId('scan-box-bind'));

    const scanAssigns = filterScanFlowAssignments(client);
    expect(scanAssigns.length).toBe(1);
    expect(scanAssigns[0]?.payload.target_id).toBe(`M-${pieceId}`);

    // The piece is now live.
    const pieceEl = document.querySelector(`[data-piece-id="${pieceId}"]`);
    expect(pieceEl?.getAttribute('data-live')).toBe('true');
  });

  it('clicking Cancel after a drop fires no bus events and the piece stays inert', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('straight');
    const before = client.published.length;

    dropOnScanBoxOnly(screen.getByTestId('scan-box'), pieceId);
    fireEvent.click(screen.getByTestId('scan-box-cancel'));

    // No new bus events.
    expect(filterScanFlowAssignments(client)).toHaveLength(0);
    expect(client.published.length).toBe(before);

    // Piece stays inert.
    const pieceEl = document.querySelector(`[data-piece-id="${pieceId}"]`);
    expect(pieceEl?.getAttribute('data-live')).toBe('false');

    // Scan box returns to idle.
    expect(screen.queryByTestId('scan-box-bind')).toBeNull();
  });

  it('confirmation panel shows the correct type label and binding id', async () => {
    renderToyTable();
    const trainId = await placeArmedPiece('train');
    dropOnScanBoxOnly(screen.getByTestId('scan-box'), trainId);
    const box = screen.getByTestId('scan-box');
    expect(box).toHaveTextContent(/Train/);
    expect(box).toHaveTextContent(`T-${trainId}`);
  });
});

describe('ToyTable — junction switch device', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('scanning a junction emits device_registered for SWITCH-{pieceId} with controls_marker_id', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('junction');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    const switchDeviceId = `SWITCH-${pieceId}`;
    const markerId = `M-${pieceId}`;
    const switchRegs = client.published.filter(
      (m) => m.topic === `railway/events/device_registered/${switchDeviceId}`,
    );
    expect(switchRegs.length).toBeGreaterThanOrEqual(1);
    const reg = switchRegs[0];
    if (!reg) throw new Error('unreachable');
    const envelope = decodeEnvelope(reg.payload);
    const payload = envelope.payload as { capabilities: string[]; controls_marker_id: string };
    expect(payload.capabilities).toEqual(['core.controls_switch']);
    expect(payload.controls_marker_id).toBe(markerId);
    // The switch device registers under SWITCH-{pieceId}, not M-{pieceId}.
    const wrongTarget = client.published.filter(
      (m) => m.topic === `railway/events/device_registered/${markerId}`,
    );
    expect(wrongTarget).toHaveLength(0);
  });

  it('scanning a non-junction track piece does NOT emit a switch device_registered', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('straight');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    const markerId = `M-${pieceId}`;
    // The device_registered for M-straight-* should not appear at all from
    // the scan flow (only GARAGE and any sim-bridge events, never a switch reg).
    const switchRegs = client.published.filter(
      (m) => m.topic === `railway/events/device_registered/${markerId}`,
    );
    expect(switchRegs).toHaveLength(0);
  });

  it('scanning a junction also emits the tag_assignment as usual', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('junction');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    const scanAssigns = filterScanFlowAssignments(client);
    expect(scanAssigns.length).toBeGreaterThanOrEqual(1);
    const junctionAssign = scanAssigns.find((a) => a.payload.target_id === `M-${pieceId}`);
    expect(junctionAssign?.payload.marker_kind).toBe('junction');
  });
});

describe('ToyTable — keyboard and selection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('R rotates the selected piece by 45 degrees', async () => {
    const user = userEvent.setup();
    renderToyTable();
    placeByDrag('straight'); // a dragged piece is left selected

    const placed = document.querySelector('[data-testid^="piece-"]');
    expect(placed?.getAttribute('transform')).toMatch(/rotate\(0\)/);

    await user.keyboard('{r}');
    expect(placed?.getAttribute('transform')).toMatch(/rotate\(45\)/);
  });

  it('Delete removes the selected piece', async () => {
    const user = userEvent.setup();
    renderToyTable();
    placeByDrag('straight'); // a dragged piece is left selected

    expect(document.querySelectorAll('[data-testid^="piece-"]').length).toBe(1);
    await user.keyboard('{Delete}');
    expect(document.querySelectorAll('[data-testid^="piece-"]').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// New tests: drag-from-toybox, snap, pan, zoom
// ---------------------------------------------------------------------------

describe('ToyTable — drag-from-toybox', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('dragging a toybox entry onto the canvas places a piece', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      dragPlaceAtPx('straight', 600, 400);

      const placed = canvas.querySelectorAll('[data-testid^="piece-"]');
      expect(placed.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('dragging a toybox entry places the piece at the drop mm coordinates', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Canvas is 1800px wide = 900mm, 1200px high = 600mm (zoom=1, pan=(0,0)).
      // clientX=900 → 450mm, clientY=600 → 300mm.
      dragPlaceAtPx('straight', 900, 600);

      const pieceEl = canvas.querySelector('[data-testid^="piece-"]') as SVGGElement | null;
      expect(pieceEl).not.toBeNull();
      // transform should encode the mm position at canvas centre: translate(450, 300).
      const transform = pieceEl?.getAttribute('transform') ?? '';
      expect(transform).toContain('translate(450, 300)');
    } finally {
      restore();
    }
  });
});

describe('ToyTable — snap-to-connect', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('dropping near an existing endpoint snaps the new piece to coincide', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Place first straight at canvas centre (450mm, 300mm).
      // Its east endpoint is at 450+100=550mm, 300mm.
      dragPlaceAtPx('straight', 900, 600);

      // Drop the second straight within the connect radius of the east endpoint
      // (550mm). Dropping the *click point* within CONNECT_CAPTURE_MM (60mm) of
      // an open endpoint snaps + orients the new piece onto it. Drop at 580mm
      // (30mm away) → 580/900*1800 = 1160px.
      dragPlaceAtPx('straight', 1160, 600);

      const pieces = canvas.querySelectorAll('[data-testid^="piece-"]');
      expect(pieces.length).toBe(2);

      // The new straight's west end snaps onto 550 ⇒ its centre lands at 650mm.
      const piece2 = pieces[1] as SVGGElement | undefined;
      const transform2 = piece2?.getAttribute('transform') ?? '';
      expect(transform2).toContain('translate(650,');
    } finally {
      restore();
    }
  });

  it('dropping far from any endpoint does not snap the piece', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Place first straight at canvas centre (450mm, 300mm).
      dragPlaceAtPx('straight', 900, 600);

      // Drop second straight far away at (100mm, 100mm).
      // 100mm → 100/900*1800 = 200px
      dragPlaceAtPx('straight', 200, 200);

      const pieces = canvas.querySelectorAll('[data-testid^="piece-"]');
      expect(pieces.length).toBe(2);

      // Second piece should land near (100mm, 100mm), not snapped to 650.
      const piece2 = pieces[1] as SVGGElement | undefined;
      const transform2 = piece2?.getAttribute('transform') ?? '';
      expect(transform2).toContain('translate(100,');
    } finally {
      restore();
    }
  });
});

/** Drag a toybox tile of `type` onto the canvas, dropping at the given CLIENT px
 *  coordinates (the sole placement path). The caller must have a canvas rect mock
 *  active. Mirrors the Feature-B gesture: press the tile, move onto the table,
 *  release to snap + commit. */
function dragPlaceAtPx(type: string, clientX: number, clientY: number): void {
  act(() => void screen.getByTestId(`toybox-${type}`).dispatchEvent(rawPtr('pointerdown', 5, 5)));
  act(() => void window.dispatchEvent(rawPtr('pointermove', clientX, clientY)));
  act(() => void window.dispatchEvent(rawPtr('pointerup', clientX, clientY)));
}

/** Place a straight via the drag gesture at the given client px, returning the
 *  id of the piece that appeared (by set difference — robust when several
 *  straights are placed in sequence). */
function placeStraightAt(canvas: Element, clientX: number, clientY: number): string {
  const before = new Set(
    [...canvas.querySelectorAll('[data-piece-id]')].map((e) => e.getAttribute('data-piece-id')),
  );
  dragPlaceAtPx('straight', clientX, clientY);
  const fresh = [...canvas.querySelectorAll('[data-piece-id]')]
    .map((e) => e.getAttribute('data-piece-id') ?? '')
    .find((id) => !before.has(id));
  if (fresh === undefined) throw new Error('placeStraightAt: no piece placed');
  return fresh;
}

/** Pointer-drag a placed piece element from its current spot to a client point.
 *  Dispatches MouseEvents typed as pointer events so jsdom carries clientX/Y
 *  through to React's handlers (fireEvent.pointer* drops the coordinates).
 *
 *  All events are dispatched inside a single act() so React flushes once. jsdom
 *  does not advance performance.now() between synchronous event dispatches, so
 *  consecutive events share the same timeStamp — the velocity gate treats that
 *  as speed=0 (safe/slow) and does not trigger a detach. */
function pointerDragPiece(piece: Element, from: [number, number], to: [number, number]): void {
  const ev = (type: string, x: number, y: number, button = 0) =>
    new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: x, clientY: y });
  act(() => {
    piece.dispatchEvent(ev('pointerdown', from[0], from[1]));
    piece.dispatchEvent(ev('pointermove', to[0], to[1]));
    piece.dispatchEvent(ev('pointerup', to[0], to[1]));
  });
}

describe('ToyTable — moving a placed piece (pointer drag)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('drags an already-placed piece across the canvas to a new position', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Place a straight at the canvas centre (450mm, 300mm) → client (900, 600).
      const pieceId = placeStraightAt(canvas, 900, 600);
      const piece = canvas.querySelector(`[data-piece-id="${pieceId}"]`) as SVGGElement;
      expect(piece.getAttribute('transform')).toContain('translate(450, 300)');

      // Pointer-drag it to (200mm, 200mm) → client (400, 400). Only piece, so
      // it lands free at the drop point.
      pointerDragPiece(piece, [900, 600], [400, 400]);

      expect(piece.getAttribute('transform')).toContain('translate(200, 200)');
    } finally {
      restore();
    }
  });

  it('snaps + orients a placed piece onto a neighbour when released next to its open end', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Anchor straight at centre — east end at 550mm. A second straight far away.
      placeStraightAt(canvas, 900, 600);
      const moverId = placeStraightAt(canvas, 200, 200);
      expect(canvas.querySelectorAll('[data-piece-id]').length).toBe(2);
      const mover = canvas.querySelector(`[data-piece-id="${moverId}"]`) as SVGGElement;

      // Drag so the mover's CENTRE lands at 650mm (client 1300, 600) — which
      // puts its west END right on the anchor's east endpoint (550mm). The
      // centre is 100mm from the joint, well beyond the capture radius, so this
      // only snaps because matching is end-based, not centre-based.
      pointerDragPiece(mover, [200, 200], [1300, 600]);

      // West end snaps onto 550 ⇒ centre stays at 650mm, oriented to continue.
      expect(mover.getAttribute('transform')).toContain('translate(650, 300)');
    } finally {
      restore();
    }
  });

  it('scans a placed piece when it is pointer-dragged onto the scan box', () => {
    const restore = mockCanvasRect();
    // jsdom has no layout, so stub the hit-test to report the scan box.
    const originalFromPoint = document.elementFromPoint;
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      const pieceId = placeStraightAt(canvas, 900, 600);
      const piece = canvas.querySelector(`[data-piece-id="${pieceId}"]`) as SVGGElement;
      const scanBox = screen.getByTestId('scan-box');
      document.elementFromPoint = () => scanBox;

      // Releasing over the scan box triggers the scan-confirm flow — Bind appears.
      pointerDragPiece(piece, [900, 600], [50, 50]);

      expect(screen.getByTestId('scan-box-bind')).toBeInTheDocument();
    } finally {
      document.elementFromPoint = originalFromPoint;
      restore();
    }
  });
});

describe('ToyTable — flip (mirror)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('mirrors the selected piece via the Flip button and the F key', async () => {
    renderToyTable();
    const pieceId = await placeArmedPiece('curve'); // placed at centre, selected
    const piece = document.querySelector(`[data-piece-id="${pieceId}"]`) as SVGGElement | null;
    if (piece === null) throw new Error('no curve placed');
    expect(piece.getAttribute('transform')).toContain('scale(1, 1)');

    fireEvent.click(screen.getByRole('button', { name: /flip/i }));
    expect(piece.getAttribute('transform')).toContain('scale(1, -1)');

    // F toggles it back.
    fireEvent.keyDown(window, { key: 'f' });
    expect(piece.getAttribute('transform')).toContain('scale(1, 1)');
  });

  it('reverses a ramp via Flip — a 180° rotation in place, not a mirror', async () => {
    // A ramp is symmetric across its length, so a mirror-flip is a no-op. Its
    // meaningful "flip" is reversing the incline: a 180° rotation (the endpoints
    // swap world positions, so a connected ramp stays joined). Flip must NOT just
    // toggle the scale-mirror, which would leave the ramp looking unchanged.
    renderToyTable();
    const pieceId = await placeArmedPiece('ramp');
    const piece = document.querySelector(`[data-piece-id="${pieceId}"]`) as SVGGElement | null;
    if (piece === null) throw new Error('no ramp placed');
    expect(piece.getAttribute('transform')).toMatch(/rotate\(0\)/);
    expect(piece.getAttribute('transform')).toContain('scale(1, 1)');

    fireEvent.click(screen.getByRole('button', { name: /flip/i }));
    expect(piece.getAttribute('transform')).toMatch(/rotate\(180\)/);
    // Still un-mirrored — the reversal is the rotation, not a scale flip.
    expect(piece.getAttribute('transform')).toContain('scale(1, 1)');

    // F flips it back to the original incline.
    fireEvent.keyDown(window, { key: 'f' });
    expect(piece.getAttribute('transform')).toMatch(/rotate\(0\)/);
  });
});

/* ---------------------------------------------------------------------------
 * Velocity gate: live flex on slow drag; detach on fast yank
 *
 * Timestamps are fed explicitly into MouseEvent via Object.defineProperty so
 * the speed calculation in handlePointerMove is deterministic and test-local.
 * The velocity gate threshold is DRAG_FLEX_MAX_SPEED = 1.5 px/ms (not
 * exported, but the tests drive speed directly through explicit timestamps).
 * --------------------------------------------------------------------------- */

/** Create a pointer event with an explicit timeStamp override. */
function timedPointerEvent(
  type: string,
  clientX: number,
  clientY: number,
  timeStampMs: number,
  button = 0,
): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX, clientY });
  Object.defineProperty(e, 'timeStamp', {
    value: timeStampMs,
    writable: false,
    configurable: true,
  });
  return e;
}

describe('ToyTable — drag gestures (move / flex)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('slow (hold) flex drag bends the chain live and STAYS POSED on release (no loop closed)', () => {
    /*
     * Two straights snapped end-to-end:
     *   A at (450, 300) — placed at client (900, 600), rotation 0°
     *   B at (650, 300) — placed at client (1300, 600), snaps onto A's east end
     *
     * A slow drag of B upward (speed = 0 because jsdom shares timestamps) calls
     * solveFollow, which distributes angular flex across the A–B joint. The
     * anchor A keeps its rest rotation; B acquires a non-zero effective rotation
     * that Table reports through the rendered transform.
     */
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      /* Stage two collinear straights end-to-end via the exact-placement setup
         hook: A at (450,300) (east end 550), B flush at (650,300) (west end 550),
         both rotation 0. A gesture drop snaps B onto A but orients it anti-parallel
         (rotate 180) — wrong for a joint we want to bend from a shared heading. */
      let bId = '';
      act(() => {
        window.__tfPlacePiece?.('straight', 450, 300);
        bId = window.__tfPlacePiece?.('straight', 650, 300) ?? '';
      });
      const bEl = canvas.querySelector(`[data-piece-id="${bId}"]`) as SVGGElement;

      /* Confirm B starts at rotation 0. */
      expect(bEl.getAttribute('transform')).toMatch(/rotate\(0\)/);

      /* Slow drag: drag B's element upward. jsdom does not advance
         performance.now() between synchronous dispatches, so all events share
         the same timeStamp — the velocity gate reads speed = 0, which is below
         the threshold (1.5 px/ms), so solveFollow is called and flex is applied. */
      /* B is at (650mm, 300mm) → client (1300px, 600px). Drag it upward.
         The first pointermove initialises the velocity baseline (speed=0).
         Both events are in one act() so their timeStamps are equal in jsdom
         (performance.now() doesn't advance between synchronous dispatches). */
      /* HOLD to enter FLEX mode (fake timers fire the ~250ms dwell), then drag B
         upward to bend the A–B joint. */
      vi.useFakeTimers();
      act(() => {
        bEl.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            clientX: 1300,
            clientY: 600,
          }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(300);
      });
      act(() => {
        /* In flex mode the move bends the A–B joint, giving B a non-zero rotation. */
        bEl.dispatchEvent(
          new MouseEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 1300,
            clientY: 540,
          }),
        );
      });

      /* After a slow drag, flex is applied: B's effective rotation is non-zero.
         The transform shows the flexed rotation (a small angle, within ±FLEX_BUDGET_DEG). */
      const transformDuringDrag = bEl.getAttribute('transform') ?? '';
      const rotMatchDuring = /rotate\(([-\d.]+)\)/.exec(transformDuringDrag);
      const rotDegDuring =
        rotMatchDuring !== null && rotMatchDuring[1] !== undefined
          ? Number.parseFloat(rotMatchDuring[1])
          : 0;
      expect(Math.abs(rotDegDuring)).toBeGreaterThan(0);
      expect(Math.abs(rotDegDuring)).toBeLessThanOrEqual(
        FLEX_BUDGET_DEG + 1e-3,
      ); /* within ±FLEX_BUDGET_DEG */

      /* Release the pointer WITHOUT a loop closure. The bend is BAKED into B's
         stored pose so a flexed length is POSABLE (stays where it was bent, attached
         or not). This is safe from cross-drag compounding because the solver's
         budget clamp is sign-correct — every joint stays within ±FLEX_BUDGET_DEG of
         the grid no matter how many flex/bake stints. */
      act(() => {
        bEl.dispatchEvent(
          new MouseEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 1300,
            clientY: 540,
          }),
        );
      });
      vi.useRealTimers();

      const transformAfterRelease = bEl.getAttribute('transform') ?? '';
      const rotMatchAfter = /rotate\(([-\d.]+)\)/.exec(transformAfterRelease);
      const rotDegAfter =
        rotMatchAfter !== null && rotMatchAfter[1] !== undefined
          ? Number.parseFloat(rotMatchAfter[1])
          : 0;
      /* Stayed POSED — the bend persisted (baked), at essentially the angle the
         live drag showed, and within the flex budget. */
      expect(Math.abs(rotDegAfter)).toBeGreaterThan(0.5);
      expect(Math.abs(rotDegAfter)).toBeCloseTo(Math.abs(rotDegDuring), 1);
      expect(Math.abs(rotDegAfter)).toBeLessThanOrEqual(FLEX_BUDGET_DEG + 0.5);
    } finally {
      restore();
    }
  });

  it('an immediate drag (no hold) is MOVE MODE — the piece detaches and repositions', () => {
    /*
     * Two snapped straights. An immediate click+drag (cursor leaves the deadzone
     * before the flex dwell, no hold) is MOVE mode: B is picked up and follows the
     * cursor, and on release it is repositioned where it was dropped (detached from
     * A) — not flexed and not sprung back. (Flex requires a press-and-hold; covered
     * in ToyTable.gesture-modes.test.tsx.)
     */
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      /* A at centre; B snapped onto A's east end (click near 550mm → 1100px). */
      placeStraightAt(canvas, 900, 600);
      const bId = placeStraightAt(canvas, 1100, 600);
      const bEl = canvas.querySelector(`[data-piece-id="${bId}"]`) as SVGGElement;
      expect(canvas.querySelectorAll('[data-piece-id]').length).toBe(2);

      /* Immediate drag of B far into empty space → move mode → reposition there.
         Client (1500px, 200px) → mm (750, 100) at the 2px/mm mock scale. */
      act(() => {
        bEl.dispatchEvent(timedPointerEvent('pointerdown', 1300, 600, 0));
        bEl.dispatchEvent(timedPointerEvent('pointermove', 1500, 200, 100));
      });
      act(() => {
        bEl.dispatchEvent(timedPointerEvent('pointerup', 1500, 200, 110));
      });

      /* Both pieces still present, and B was repositioned to the drop point (far
         from its (650,300) rest) — it detached and moved, did not spring back. */
      expect(canvas.querySelectorAll('[data-piece-id]').length).toBe(2);
      const t = canvas.querySelector(`[data-piece-id="${bId}"]`)?.getAttribute('transform') ?? '';
      const m = /translate\(([-\d.]+),?\s*([-\d.]+)\)/.exec(t);
      const bx = m ? Number.parseFloat(m[1] ?? '0') : 0;
      const by = m ? Number.parseFloat(m[2] ?? '0') : 0;
      expect(Math.hypot(bx - 750, by - 100)).toBeLessThan(80);
    } finally {
      restore();
    }
  });
});

describe('ToyTable — run-flow guidance', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('prompts to scan an unscanned train so it does not look inert', async () => {
    const user = userEvent.setup();
    renderToyTable();
    await placeArmedPiece('train'); // placed + selected, but armed
    await user.click(screen.getByTestId('toybox-train')); // disarm → selection guidance shows
    expect(screen.getByText(/drag it onto the scan box/i)).toBeInTheDocument();
  });
});

describe('ToyTable — pan', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('left-mouse drag on empty canvas (nothing armed) translates the viewport', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      const initialX = Number(canvas.getAttribute('data-viewport-x'));
      const initialY = Number(canvas.getAttribute('data-viewport-y'));

      // Use native MouseEvent so clientX/Y are actually passed through.
      // Drag 200px right, 100px down → pans the viewport left/up (negative world coords).
      // At zoom=1 and canvas 1800x1200px: 200px = 100mm, 100px = 50mm.
      // act() ensures React state updates from the pan flush before asserting.
      act(() => {
        canvas.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 500,
            clientY: 300,
          }),
        );
        canvas.dispatchEvent(
          new MouseEvent('pointermove', {
            bubbles: true,
            cancelable: true,
            clientX: 700,
            clientY: 400,
          }),
        );
        canvas.dispatchEvent(
          new MouseEvent('pointerup', {
            bubbles: true,
            cancelable: true,
            button: 0,
            clientX: 700,
            clientY: 400,
          }),
        );
      });

      const afterX = Number(canvas.getAttribute('data-viewport-x'));
      const afterY = Number(canvas.getAttribute('data-viewport-y'));

      // Viewport pan: dragging right means world origin moves left (negative x).
      expect(afterX).not.toBe(initialX);
      expect(afterY).not.toBe(initialY);
    } finally {
      restore();
    }
  });

  it('left-mouse drag on the empty background PANS the canvas (no arming to block it)', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();

      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      const initialX = Number(canvas.getAttribute('data-viewport-x'));

      // Arming is gone — a left-drag starting on the empty background now pans.
      act(() => {
        canvas.dispatchEvent(
          new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 500, clientY: 300 }),
        );
        canvas.dispatchEvent(
          new MouseEvent('pointermove', { bubbles: true, clientX: 700, clientY: 400 }),
        );
        canvas.dispatchEvent(
          new MouseEvent('pointerup', { bubbles: true, button: 0, clientX: 700, clientY: 400 }),
        );
      });

      // The viewport moved (a pan happened).
      expect(Number(canvas.getAttribute('data-viewport-x'))).not.toBe(initialX);
    } finally {
      restore();
    }
  });
});

describe('ToyTable — zoom', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('wheel event on the canvas changes the viewBox dimensions (zoom in)', () => {
    renderToyTable();
    const canvas = screen.getByTestId('toy-table-canvas');

    const initialZoom = Number(canvas.getAttribute('data-viewport-zoom'));
    expect(initialZoom).toBe(1);

    // Scroll up (zoom in): deltaY < 0.
    fireEvent.wheel(canvas, { deltaY: -100, clientX: 900, clientY: 600 });

    const afterZoom = Number(canvas.getAttribute('data-viewport-zoom'));
    expect(afterZoom).toBeGreaterThan(initialZoom);

    // The viewBox width should be smaller (zoomed in).
    const viewBox = canvas.getAttribute('viewBox') ?? '';
    const parts = viewBox.split(' ').map(Number);
    const viewBoxWidth = parts[2];
    expect(viewBoxWidth).toBeDefined();
    expect(viewBoxWidth).toBeLessThan(900); // < CANVAS_W_MM at zoom > 1
  });

  it('wheel event zooming out increases the viewBox dimensions', () => {
    renderToyTable();
    const canvas = screen.getByTestId('toy-table-canvas');

    // Scroll down (zoom out): deltaY > 0.
    fireEvent.wheel(canvas, { deltaY: 100, clientX: 900, clientY: 600 });

    const afterZoom = Number(canvas.getAttribute('data-viewport-zoom'));
    expect(afterZoom).toBeLessThan(1);

    const viewBox = canvas.getAttribute('viewBox') ?? '';
    const parts = viewBox.split(' ').map(Number);
    const viewBoxWidth = parts[2];
    expect(viewBoxWidth).toBeDefined();
    expect(viewBoxWidth).toBeGreaterThan(900); // > CANVAS_W_MM at zoom < 1
  });

  it('zoom clamps at MIN_ZOOM = 0.1', () => {
    renderToyTable();
    const canvas = screen.getByTestId('toy-table-canvas');

    // Zoom out many times to hit the floor.
    for (let i = 0; i < 50; i++) {
      fireEvent.wheel(canvas, { deltaY: 500, clientX: 900, clientY: 600 });
    }

    const minZoom = Number(canvas.getAttribute('data-viewport-zoom'));
    expect(minZoom).toBeCloseTo(0.1, 5);

    // viewBox width should be capped at CANVAS_W_MM / 0.1 = 9000.
    const viewBox = canvas.getAttribute('viewBox') ?? '';
    const parts = viewBox.split(' ').map(Number);
    const viewBoxWidth = parts[2];
    expect(viewBoxWidth).toBeDefined();
    expect(viewBoxWidth).toBeLessThanOrEqual(9000 + 0.01); // CANVAS_W_MM / MIN_ZOOM
  });
});

// ---------------------------------------------------------------------------
// Carriage piece tests
// ---------------------------------------------------------------------------

describe('ToyTable — carriage placement and wire silence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('carriage appears in the toybox under Devices', () => {
    renderToyTable();
    expect(screen.getByTestId('toybox-carriage')).toBeInTheDocument();
  });

  it('placing a carriage without scanning emits no broker events', () => {
    const { client } = renderToyTable();

    placeByDrag('carriage');

    const placed = document.querySelectorAll('[data-testid^="piece-carriage-"]');
    expect(placed.length).toBe(1);

    // No wire events for carriages — they are wire-invisible.
    const carriageEvents = client.published.filter((m) => m.topic.includes('carriage'));
    expect(carriageEvents).toHaveLength(0);
  });

  it('scanning a carriage emits no broker events (wire-invisible)', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('carriage');

    const countBefore = client.published.length;
    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    const countAfter = client.published.length;

    // Scanning a carriage must not publish anything — no tag_assignment,
    // no device_registered, no GARAGE announcement from the scan flow.
    expect(countAfter).toBe(countBefore);
  });

  it('a scanned carriage becomes live but emits no tag_assignment', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('carriage');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    // The piece should be marked live (data-live="true").
    const placed = document.querySelector(`[data-piece-id="${pieceId}"]`);
    expect(placed?.getAttribute('data-live')).toBe('true');

    // No scan-flow tag_assignment should have been emitted for the carriage.
    expect(filterScanFlowAssignments(client)).toHaveLength(0);
  });

  it('carriage has no power dot (wire-invisible devices have no broker identity)', async () => {
    renderToyTable();
    const pieceId = await placeArmedPiece('carriage');

    // Power dot is rendered only for wire devices (train/gate).
    const powerDot = document.querySelector(`[data-testid="power-${pieceId}"]`);
    expect(powerDot).toBeNull();
  });
});

describe('ToyTable — carriage coupling', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('a carriage placed near a live train gets data-coupled-to set to the train piece id', async () => {
    const restore = mockCanvasRect();
    try {
      const { client } = renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Place and scan a train near canvas centre (450, 300).
      // 900px wide = 900mm. Drop at 900, 600 px → 450mm, 300mm.
      dragPlaceAtPx('train', 900, 600);

      const trainPieceEl = canvas.querySelector(
        '[data-testid^="piece-train-"]',
      ) as HTMLElement | null;
      if (!trainPieceEl) throw new Error('no train placed');
      const trainPieceId = trainPieceEl.getAttribute('data-piece-id');
      if (!trainPieceId) throw new Error('train missing data-piece-id');

      // Scan the train so it's live.
      dropPieceOnScanBox(screen.getByTestId('scan-box'), trainPieceId);
      expect(trainPieceEl.getAttribute('data-live')).toBe('true');

      // Place a carriage 80mm east of the train (well within coupling distance of 100mm).
      // 450mm + 80mm = 530mm. 530/900 * 1800px = 1060px.
      dragPlaceAtPx('carriage', 1060, 600);

      const carriagePieceEl = canvas.querySelector(
        '[data-testid^="piece-carriage-"]',
      ) as HTMLElement | null;
      if (!carriagePieceEl) throw new Error('no carriage placed');

      // Carriage should be coupled to the train.
      expect(carriagePieceEl.getAttribute('data-coupled-to')).toBe(trainPieceId);

      // Confirm the client variable is used (avoids unused variable lint error).
      expect(client).toBeDefined();
    } finally {
      restore();
    }
  });

  it('a carriage placed far from any live train has no data-coupled-to', async () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Place and scan a train at canvas centre.
      dragPlaceAtPx('train', 900, 600);

      const trainPieceEl = canvas.querySelector(
        '[data-testid^="piece-train-"]',
      ) as HTMLElement | null;
      if (!trainPieceEl) throw new Error('no train placed');
      const trainPieceId = trainPieceEl.getAttribute('data-piece-id');
      if (!trainPieceId) throw new Error('train missing data-piece-id');
      dropPieceOnScanBox(screen.getByTestId('scan-box'), trainPieceId);

      // Place a carriage far away: 300mm east = 750mm, i.e. 750/900 * 1800 = 1500px.
      dragPlaceAtPx('carriage', 1500, 600);

      const carriagePieceEl = canvas.querySelector(
        '[data-testid^="piece-carriage-"]',
      ) as HTMLElement | null;
      if (!carriagePieceEl) throw new Error('no carriage placed');

      // 750mm from 450mm = 300mm > 100mm coupling threshold: not coupled.
      expect(carriagePieceEl.getAttribute('data-coupled-to')).toBeNull();
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Carriage physics: coupled carriages render at simulated world position
// ---------------------------------------------------------------------------

/**
 * Build the two-straight + train setup needed by the carriage physics tests.
 *
 * Places straight-A at (450, 300), straight-B flush at (650, 300), a train on
 * top of straight-A, scans all three, and returns the train piece id. Uses the
 * exact-placement setup hook so the geometry is precise — the bounds-and-snap
 * pointer gesture would re-snap a piece dropped on top of another. The canvas
 * mock rect MUST be active when called.
 */
function setupTwoStraightsThenTrain(_canvas: Element): string {
  // Straight-A at canvas centre (endpoints 350 / 550); straight-B flush east of
  // it (endpoints 550 / 750) so A.east coincides with B.west.
  let straightAId = '';
  let straightBId = '';
  let trainPieceId = '';
  act(() => {
    straightAId = window.__tfPlacePiece?.('straight', 450, 300) ?? '';
    straightBId = window.__tfPlacePiece?.('straight', 650, 300) ?? '';
  });

  // Scan both straights to bind their markers.
  dropPieceOnScanBox(screen.getByTestId('scan-box'), straightAId);
  dropPieceOnScanBox(screen.getByTestId('scan-box'), straightBId);

  // Place and scan a train on straight-A (450, 300mm).
  act(() => {
    trainPieceId = window.__tfPlacePiece?.('train', 450, 300) ?? '';
  });
  dropPieceOnScanBox(screen.getByTestId('scan-box'), trainPieceId);

  return trainPieceId;
}

describe('ToyTable — carriage render positions follow sim physics', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('coupled carriage renders at its sim position trailing the loco, not its drop position', () => {
    // Two straights + train setup so the train spawns in-sim on edge
    // M-straight-A(450,300) → M-straight-B(650,300). The loco seats at the train
    // piece (450,300) — the edge start, distance_into_edge 0. A coupled carriage
    // renders at its SIM BODY pose: one carriage-spacing back along the rail
    // (450 − CARRIAGE_SPACING_MM), NOT at where it was dropped (370,300).
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      const trainPieceId = setupTwoStraightsThenTrain(canvas);

      // Place a carriage 80mm west of the train at exactly (370, 300) (within the
      // 100mm coupling range). Exact-placement setup hook — a gesture drop would
      // re-snap it onto straight-A's open end and shift the coupling geometry.
      act(() => {
        window.__tfPlacePiece?.('carriage', 370, 300);
      });
      // Re-render to read the seeded carriage body: the loco's rake is seeded in
      // the post-render sync effect, which a live browser reflects on the next RAF
      // tick. jsdom has no RAF, so step(0) bumps the render WITHOUT stepping the
      // world (a non-zero step would let the physics settle the rake spacing).
      act(() => {
        window.trainframeSim?.step(0);
      });

      const carriageEl = canvas.querySelector(
        '[data-testid^="piece-carriage-"]',
      ) as HTMLElement | null;
      if (!carriageEl) throw new Error('carriage not placed');

      // Coupling: data-coupled-to must reference the train.
      expect(carriageEl.getAttribute('data-coupled-to')).toBe(trainPieceId);

      // Physics: the carriage renders at its sim body pose — one spacing back from
      // the loco's edge-start (450,300) along the rail — NOT at its drop (370,300).
      const transform = carriageEl.getAttribute('transform') ?? '';
      expect(transform).toContain(`translate(${450 - CARRIAGE_SPACING_MM}, 300)`);
      expect(transform).not.toContain('translate(370, 300)');
    } finally {
      restore();
    }
  });

  it('uncoupled carriage (no track) renders at its drop position, not a sim position', () => {
    // A carriage placed with no live train nearby must stay at piece.position.
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;

      // Place carriage at canvas centre (450mm, 300mm). clientX=900.
      dragPlaceAtPx('carriage', 900, 600);

      const carriageEl = canvas.querySelector(
        '[data-testid^="piece-carriage-"]',
      ) as HTMLElement | null;
      if (!carriageEl) throw new Error('carriage not placed');

      // No coupled train → data-coupled-to is absent.
      expect(carriageEl.getAttribute('data-coupled-to')).toBeNull();

      // Rendered at placement position (450, 300).
      const transform = carriageEl.getAttribute('transform') ?? '';
      expect(transform).toContain('translate(450, 300)');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// effectiveLayer — the render-layer of a live train as it crosses a bridge.
// This is the headline behaviour: a train must draw on the HIGHER of its
// current edge's two layers so it appears ON TOP of the ground loop it crosses,
// not under it. Driven through the helper's real structural seam (no mocking of
// the scheduler/registry — `TrainLayerSource` is exactly what the renderer reads
// from the live sim).
// ---------------------------------------------------------------------------

describe('effectiveLayer — live-train draw layer across a bridge', () => {
  const groundPiece: TrackPiece = {
    id: 'ramp1',
    type: 'ramp',
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
  };
  const upperPiece: TrackPiece = {
    id: 'up1',
    type: 'straight',
    position: { x: 200, y: 0 },
    rotationDeg: 0,
    tagged: false,
    layer: 1,
  };
  const trainPiece: TrackPiece = {
    id: 'loco',
    type: 'train',
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
  };
  const carriagePiece: TrackPiece = {
    id: 'wagon',
    type: 'carriage',
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
  };

  const piecesById = new Map<string, TrackPiece>([
    [groundPiece.id, groundPiece],
    [upperPiece.id, upperPiece],
    [trainPiece.id, trainPiece],
    [carriagePiece.id, carriagePiece],
  ]);

  /** A structural sim stub: the loco T-loco is on the ramp→upper edge. */
  function simOnRampToUpper(): TrainLayerSource {
    return {
      getTrain(id) {
        if (id !== 'T-loco') return undefined;
        return {
          getCurrentEdge: () => ({ from_marker_id: 'M-ramp1', to_marker_id: 'M-up1' }),
        };
      },
    };
  }

  it('draws a live train on the HIGHER of its edge layers (ramp 0 → upper 1 ⇒ 1)', () => {
    const layer = effectiveLayer(trainPiece, simOnRampToUpper(), new Map(), piecesById);
    expect(layer).toBe(1);
  });

  it('falls back to the train piece static layer when the sim has no such train', () => {
    const emptySim: TrainLayerSource = { getTrain: () => undefined };
    // Train piece is ground (layer 0).
    expect(effectiveLayer(trainPiece, emptySim, new Map(), piecesById)).toBe(0);
  });

  it('a coupled carriage inherits its train’s effective (crossing) layer', () => {
    const coupled = new Map<string, string>([[carriagePiece.id, trainPiece.id]]);
    const layer = effectiveLayer(carriagePiece, simOnRampToUpper(), coupled, piecesById);
    expect(layer).toBe(1);
  });

  it('an uncoupled carriage falls back to its own static layer', () => {
    const layer = effectiveLayer(carriagePiece, simOnRampToUpper(), new Map(), piecesById);
    expect(layer).toBe(0);
  });

  it('a static track piece draws on its own layer', () => {
    expect(effectiveLayer(upperPiece, simOnRampToUpper(), new Map(), piecesById)).toBe(1);
    expect(effectiveLayer(groundPiece, simOnRampToUpper(), new Map(), piecesById)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Experiments tray (docs/experimental 001–005)
// ---------------------------------------------------------------------------

describe('ToyTable — Experiments tray', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** device_registered envelopes published for `deviceId`, scan flow and sim
   * bridge alike, decoded. */
  function registrationsFor(
    client: InMemoryBrokerClient,
    deviceId: string,
  ): Array<{ capabilities?: string[]; controls_marker_id?: string }> {
    return client.published
      .filter((m) => m.topic === `railway/events/device_registered/${deviceId}`)
      .map((m) => decodeEnvelope(m.payload).payload as { capabilities?: string[] });
  }

  it('shows the Experiments box as a third tray group with the viability-test pieces', () => {
    renderToyTable();
    const tray = screen.getByLabelText('Experiments');
    for (const type of ['vision-station', 'turntable', 'crane-station', 'lift-bridge']) {
      const button = screen.getByTestId(`toybox-${type}`);
      expect(button).toBeInTheDocument();
      expect(tray.contains(button)).toBe(true);
    }
    // 004 (wedge decoupler) has no tray piece — superseded by the railyard.
    expect(screen.queryByTestId('toybox-decoupler')).toBeNull();
  });

  it('scanning a vision station binds a station_stop marker and registers VLS- with core.reports_length', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('vision-station');
    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    const assign = filterScanFlowAssignments(client).find(
      (a) => a.payload.target_id === `M-${pieceId}`,
    );
    expect(assign?.payload.marker_kind).toBe('station_stop');

    const regs = registrationsFor(client, `VLS-${pieceId}`);
    expect(regs.length).toBeGreaterThanOrEqual(1);
    expect(regs[0]?.capabilities).toEqual(['core.reports_length']);
  });

  it('scanning crane and lift bridge registers their clearance-gating identities', async () => {
    const { client } = renderToyTable();
    for (const [type, prefix] of [
      ['crane-station', 'CRANE-'],
      ['lift-bridge', 'BRIDGE-'],
    ] as const) {
      const pieceId = await placeArmedPiece(type);
      dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
      const regs = registrationsFor(client, `${prefix}${pieceId}`);
      expect(regs.length).toBeGreaterThanOrEqual(1);
      expect(regs.some((r) => r.capabilities?.includes('core.gates_clearance'))).toBe(true);
    }
  });

  /* TODO(B): turntables are not yet supported by the ADR-030 free-placed network
   *  compiler (`compileNetwork` throws "use PieceNetworkBuilder for turntable
   *  scenes" on any turntable piece), so a live turntable currently crashes the
   *  toy-table world build. Re-enable these two once `network-from-pieces`
   *  compiles a turntable as an N-way rotating junction. The renderer + the spin
   *  handler are already on the new `switchPosition`/`setSwitch` hardware API. */
  it.skip('scanning a turntable binds a junction marker and registers a SWITCH- motor for it', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('turntable');
    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);

    const assign = filterScanFlowAssignments(client).find(
      (a) => a.payload.target_id === `M-${pieceId}`,
    );
    expect(assign?.payload.marker_kind).toBe('junction');

    const regs = registrationsFor(client, `SWITCH-${pieceId}`);
    expect(regs.length).toBeGreaterThanOrEqual(1);
    expect(regs[0]?.capabilities).toEqual(['core.controls_switch']);
    expect(
      (regs[0] as { controls_marker_id?: string }).controls_marker_id ??
        (regs.find((r) => 'controls_marker_id' in r) as { controls_marker_id?: string })
          ?.controls_marker_id,
    ).toBe(`M-${pieceId}`);
  });

  it('Raise span withholds the bridge marker and tilts the deck; Lower seats and grants', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('lift-bridge');

    // A freshly placed bridge is seated: span down, no gap.
    const span = screen.getByTestId(`bridge-span-${pieceId}`);
    expect(span.getAttribute('data-raised')).toBe('false');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    await user.click(screen.getByTestId('toybox-lift-bridge')); // disarm
    fireEvent.click(screen.getByTestId(`piece-${pieceId}`)); // select

    await user.click(screen.getByTestId('action-raise-span'));
    expect(span.getAttribute('data-raised')).toBe('true');
    // The raise is a real clearance withhold across the bridge's own marker —
    // "the track is physically not there right now" (experimental 005).
    const gateTopic = `railway/events/gate_state_changed/BRIDGE-${pieceId}`;
    const states = client.published
      .filter((m) => m.topic === gateTopic)
      .map((m) => decodeEnvelope(m.payload).payload as { marker_id: string; state: string });
    expect(states).toEqual([
      { marker_id: `M-${pieceId}`, state: 'withholding', reason: 'span raised' },
    ]);

    await user.click(screen.getByTestId('action-lower-span'));
    expect(span.getAttribute('data-raised')).toBe('false');
    const after = client.published.filter((m) => m.topic === gateTopic);
    expect(after).toHaveLength(2);
    expect(
      (decodeEnvelope(after[1]?.payload ?? new Uint8Array()).payload as { state: string }).state,
    ).toBe('granting');
  });

  // TODO(B): blocked on turntable support in `network-from-pieces` (see above).
  it.skip('Spin deck swings the turntable bridge to the next stub and confirms it on the bus', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('turntable');

    // Resting deck: east alignment (stub-a, 0°).
    const deck = screen.getByTestId(`turntable-deck-${pieceId}`);
    expect(deck.getAttribute('data-angle')).toBe('0');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    await user.click(screen.getByTestId('toybox-turntable')); // disarm
    fireEvent.click(screen.getByTestId(`piece-${pieceId}`)); // select

    await user.click(screen.getByTestId('action-spin-deck'));
    expect(deck.getAttribute('data-angle')).toBe('45'); // stub-b
    const changed = client.published
      .filter((m) => m.topic === `railway/events/switch_state_changed/SWITCH-${pieceId}`)
      .map((m) => decodeEnvelope(m.payload).payload as { position: string; confirmed: boolean });
    expect(changed).toEqual([
      { junction_marker_id: `M-${pieceId}`, position: 'stub-b', confirmed: true },
    ]);

    await user.click(screen.getByTestId('action-spin-deck'));
    expect(deck.getAttribute('data-angle')).toBe('-45'); // stub-c
  });

  it('the crane works crates between its stack and the wagon under the hook', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();
    const craneId = await placeArmedPiece('crane-station');
    // A crane with nothing to work parks its trolley arm over the stack.
    expect(screen.getByTestId(`crane-trolley-${craneId}`).getAttribute('data-over-rail')).toBe(
      'false',
    );
    /* The wagon parks under the hook: the gantry sits 45 mm east of the crane
     * origin and both pieces drop at the canvas centre — within reach. */
    const wagonId = await placeArmedPiece('carriage');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), craneId);
    await user.click(screen.getByTestId('toybox-carriage')); // disarm
    fireEvent.click(screen.getByTestId(`piece-${craneId}`)); // select the crane

    // Live crane + wagon in reach: the arm slides out over the rail — the
    // trolley-along-the-beam motion the design doc describes.
    expect(screen.getByTestId(`crane-trolley-${craneId}`).getAttribute('data-over-rail')).toBe(
      'true',
    );

    // A fresh crane: full stack, empty wagon — Place enabled, Lift not.
    expect(screen.getByTestId(`crane-stack-${craneId}`).getAttribute('data-crates')).toBe('3');
    expect(screen.queryByTestId(`cargo-${wagonId}`)).toBeNull();
    expect(screen.getByTestId('action-lift-crate')).toBeDisabled();

    // Place: a crate moves from the stack onto the wagon's back.
    await user.click(screen.getByTestId('action-place-crate'));
    expect(screen.getByTestId(`cargo-${wagonId}`)).toBeTruthy();
    expect(screen.getByTestId(`crane-stack-${craneId}`).getAttribute('data-crates')).toBe('2');

    /* The transfer pinned the train via a withhold/grant pulse on the crane's
     * own marker — and NOTHING cargo-specific crossed the wire: no crate
     * event, no manifest, no carriage id. The negative-space proof of 003. */
    const gateTopic = `railway/events/gate_state_changed/CRANE-${craneId}`;
    const states = client.published
      .filter((m) => m.topic === gateTopic)
      .map((m) => (decodeEnvelope(m.payload).payload as { state: string }).state);
    expect(states).toEqual(['withholding', 'granting']);
    const cargoish = client.published.filter((m) => /crate|cargo|manifest/i.test(m.topic));
    expect(cargoish).toHaveLength(0);

    // Lift: the crate comes back off the wagon onto the stack.
    await user.click(screen.getByTestId('action-lift-crate'));
    expect(screen.queryByTestId(`cargo-${wagonId}`)).toBeNull();
    expect(screen.getByTestId(`crane-stack-${craneId}`).getAttribute('data-crates')).toBe('3');
  });

  it('the vision station LED lights while a live train sits under the sensor', async () => {
    renderToyTable();
    const stationId = await placeArmedPiece('vision-station');

    // Dark while nothing is being measured.
    const led = screen.getByTestId(`vision-led-${stationId}`);
    expect(led.getAttribute('data-lit')).toBe('false');

    // A live train parked on the station (same canvas-centre drop point) is
    // within sensor range — the LED lights. Stillness otherwise: no sweep, no
    // moving parts (experimental 001).
    const trainId = await placeArmedPiece('train');
    dropPieceOnScanBox(screen.getByTestId('scan-box'), trainId);
    expect(screen.getByTestId(`vision-led-${stationId}`).getAttribute('data-lit')).toBe('true');
  });
});
