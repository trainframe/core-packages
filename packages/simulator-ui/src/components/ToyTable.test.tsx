import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrokerProvider } from '../broker/broker-context.js';
import { InMemoryBrokerClient } from '../broker/in-memory-client.js';
import { SCANBOX_DATA_MIME } from './ScanBox.js';
import { ToyTable } from './ToyTable.js';

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
      <ToyTable />
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

/** Fire a drag-and-drop drop synthetically — jsdom doesn't simulate the full
 *  HTML5 DnD pipeline so we feed a stub `dataTransfer` directly. */
function dropPieceOnScanBox(scanBox: HTMLElement, pieceId: string): void {
  const dataTransfer = {
    getData: (mime: string) => (mime === SCANBOX_DATA_MIME ? pieceId : ''),
    setData: () => {},
    dropEffect: 'move',
    effectAllowed: 'move',
  };
  fireEvent.drop(scanBox, { dataTransfer });
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

/** Build a stub DragEvent dataTransfer with a given MIME payload.
 *  jsdom does not implement DataTransfer or DragEvent; we stub them. */
function makeDataTransfer(mime: string, value: string): object {
  const store: Record<string, string> = { [mime]: value };
  return {
    types: [mime],
    getData: (m: string) => store[m] ?? '',
    setData: (m: string, v: string) => {
      store[m] = v;
    },
    effectAllowed: 'copy' as string,
    dropEffect: 'copy' as string,
  };
}

/**
 * Dispatch a synthetic dragover + drop on the given element, carrying both
 * clientX/Y coordinates AND a dataTransfer stub.
 *
 * jsdom's `fireEvent.drop` does not propagate `clientX`/`clientY` — it only
 * passes the `dataTransfer` object. We must use `MouseEvent('drop', ...)` +
 * `Object.defineProperty(evt, 'dataTransfer', ...)` to get coordinates through
 * to the handler.
 */
function dispatchDragWithCoords(
  element: Element,
  mime: string,
  value: string,
  clientX: number,
  clientY: number,
): void {
  const dt = makeDataTransfer(mime, value);

  // dragover first — fires setDraggingToyboxType → snap-highlight state update.
  // Wrapped in act() so React state updates (snap highlight) flush before drop.
  act(() => {
    const overEvt = new MouseEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    });
    Object.defineProperty(overEvt, 'dataTransfer', { value: dt });
    element.dispatchEvent(overEvt);
  });

  // drop carries the same coordinates and dataTransfer.
  // act() ensures the piece placement state update flushes synchronously.
  act(() => {
    const dropEvt = new MouseEvent('drop', {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
    });
    Object.defineProperty(dropEvt, 'dataTransfer', { value: dt });
    element.dispatchEvent(dropEvt);
  });
}

/** Dispatch a synthetic toybox drag start on the button so React's
 * `onDragStart` fires and updates `draggingToyboxType` state. */
function dispatchToyboxDragStart(button: HTMLElement, type: string): void {
  const TOYBOX_MIME = 'application/x-trainframe-toybox-type';
  const store: Record<string, string> = {};
  const dt = {
    types: [TOYBOX_MIME],
    getData: (m: string) => store[m] ?? '',
    setData: (m: string, v: string) => {
      store[m] = v;
    },
    effectAllowed: 'copy' as string,
    dropEffect: 'copy' as string,
  };
  // act() ensures the React onDragStart handler's state update (draggingToyboxType)
  // flushes before the subsequent dragover/drop events.
  act(() => {
    fireEvent.dragStart(button, { dataTransfer: dt });
    // The handler calls setData(TOYBOX_MIME, type); our stub captures it.
    // Also ensure the store has the type so subsequent getData calls see it.
    store[TOYBOX_MIME] = type;
  });
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
  });

  it('arms a piece type and places it on the canvas without publishing any device traffic', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();

    await user.click(screen.getByTestId('toybox-straight'));
    const canvas = screen.getByTestId('toy-table-canvas');
    // Click anywhere — geometry conversion is exercised by handleClick.
    await user.click(canvas);

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
});

/** Place an armed piece of the given type and return its piece id. */
async function placeArmedPiece(type: string): Promise<string> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(`toybox-${type}`));
  await user.click(screen.getByTestId('toy-table-canvas'));
  const placed = document.querySelector(`[data-testid^="piece-${type}-"]`) as HTMLElement | null;
  if (!placed) throw new Error(`no ${type} placed`);
  const pieceId = placed.getAttribute('data-piece-id');
  if (!pieceId) throw new Error('placed piece missing data-piece-id');
  return pieceId;
}

describe('ToyTable — scan and power', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('placing a train without scanning emits no broker events for that device', async () => {
    const user = userEvent.setup();
    const { client } = renderToyTable();

    await user.click(screen.getByTestId('toybox-train'));
    await user.click(screen.getByTestId('toy-table-canvas'));

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

    const regs = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_registered/T-'),
    );
    expect(regs.length).toBe(1);
    const reg = regs[0];
    if (!reg) throw new Error('unreachable');
    const envelope = decodeEnvelope(reg.payload);
    expect(envelope.event_type).toBe('device_registered');
    expect(envelope.protocol_version).toBe('0.2.0');
    const payload = envelope.payload as { capabilities: string[] };
    expect(payload.capabilities).toEqual(['core.controls_motion', 'core.accepts_route']);

    // Scanning a train must not trigger the scan-flow's GARAGE announcement
    // (that's only for track pieces). The in-browser sim may have emitted its
    // own GARAGE registration through `seedIdentityTags`, which is unrelated
    // — what we check is that no scan-flow `tag_assignment` (the one with
    // `marker_kind`) ever fired for this train piece.
    expect(filterScanFlowAssignments(client)).toHaveLength(0);
  });

  it('clicking a live train powers it off and publishes device_disconnected', async () => {
    const { client } = renderToyTable();
    const pieceId = await placeArmedPiece('train');

    const placed = document.querySelector(`[data-piece-id="${pieceId}"]`) as HTMLElement | null;
    if (!placed) throw new Error('unreachable');

    dropPieceOnScanBox(screen.getByTestId('scan-box'), pieceId);
    expect(placed.getAttribute('data-live')).toBe('true');

    // Clicking the piece (now live) emits device_disconnected.
    fireEvent.click(placed);

    const disconnects = client.published.filter((m) =>
      m.topic.startsWith('railway/events/device_disconnected/T-'),
    );
    expect(disconnects.length).toBe(1);
    expect(placed.getAttribute('data-live')).toBe('false');
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
});

describe('ToyTable — keyboard and selection', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('R rotates the selected piece by 45 degrees', async () => {
    const user = userEvent.setup();
    renderToyTable();
    await user.click(screen.getByTestId('toybox-straight'));
    await user.click(screen.getByTestId('toy-table-canvas'));

    const placed = document.querySelector('[data-testid^="piece-"]');
    expect(placed?.getAttribute('transform')).toMatch(/rotate\(0\)/);

    await user.keyboard('{r}');
    expect(placed?.getAttribute('transform')).toMatch(/rotate\(45\)/);
  });

  it('Delete removes the selected piece', async () => {
    const user = userEvent.setup();
    renderToyTable();
    await user.click(screen.getByTestId('toybox-straight'));
    await user.click(screen.getByTestId('toy-table-canvas'));

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
      const straight = screen.getByTestId('toybox-straight');

      dispatchToyboxDragStart(straight, 'straight');
      dispatchDragWithCoords(canvas, 'application/x-trainframe-toybox-type', 'straight', 600, 400);

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
      const straight = screen.getByTestId('toybox-straight');

      // Canvas is 1800px wide = 900mm, 1200px high = 600mm (zoom=1, pan=(0,0)).
      // clientX=900 → 450mm, clientY=600 → 300mm.
      dispatchToyboxDragStart(straight, 'straight');
      dispatchDragWithCoords(canvas, 'application/x-trainframe-toybox-type', 'straight', 900, 600);

      const pieceEl = canvas.querySelector('[data-testid^="piece-"]') as SVGGElement | null;
      expect(pieceEl).not.toBeNull();
      // transform should encode the mm position at canvas centre: translate(450, 300).
      const transform = pieceEl?.getAttribute('transform') ?? '';
      expect(transform).toContain('translate(450, 300)');
    } finally {
      restore();
    }
  });

  it('toybox drag does not affect the scan-box (different MIME type)', () => {
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      const straight = screen.getByTestId('toybox-straight');

      // Drop with the scan-box MIME on the canvas — should be ignored.
      dispatchToyboxDragStart(straight, 'straight');
      dispatchDragWithCoords(canvas, 'application/x-trainframe-piece', 'some-piece-id', 900, 600);

      // No piece placed (wrong MIME).
      const placed = canvas.querySelectorAll('[data-testid^="piece-"]');
      expect(placed.length).toBe(0);
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
      const straightButton = screen.getByTestId('toybox-straight');

      // Place first straight at canvas centre (450mm, 300mm).
      // Its east endpoint is at 450+100=550mm, 300mm.
      dispatchToyboxDragStart(straightButton, 'straight');
      dispatchDragWithCoords(canvas, 'application/x-trainframe-toybox-type', 'straight', 900, 600);

      // Drop second straight near the east endpoint so snap triggers.
      // East endpoint of piece 1: x=550mm. For snap: the new piece's west endpoint
      // (piece.x - 100) must be within SNAP_DISTANCE(30mm) of 550mm.
      // Drop at x=660mm: candidate.x=660, candidate.west=560, distance to ep=10mm < 30mm.
      // After snap: offsetX = 550-560 = -10 → finalX = 660+(-10) = 650mm.
      // 660mm → 660/900*1800 = 1320px.
      dispatchToyboxDragStart(straightButton, 'straight');
      dispatchDragWithCoords(canvas, 'application/x-trainframe-toybox-type', 'straight', 1320, 600);

      const pieces = canvas.querySelectorAll('[data-testid^="piece-"]');
      expect(pieces.length).toBe(2);

      // The second piece should have snapped: its translate-x should be 650.
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
      const straightButton = screen.getByTestId('toybox-straight');

      // Place first straight at canvas centre (450mm, 300mm).
      dispatchToyboxDragStart(straightButton, 'straight');
      dispatchDragWithCoords(canvas, 'application/x-trainframe-toybox-type', 'straight', 900, 600);

      // Drop second straight far away at (100mm, 100mm).
      // 100mm → 100/900*1800 = 200px
      dispatchToyboxDragStart(straightButton, 'straight');
      dispatchDragWithCoords(canvas, 'application/x-trainframe-toybox-type', 'straight', 200, 200);

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

  it('left-mouse drag does NOT pan when a piece type is armed', async () => {
    const user = userEvent.setup();
    const restore = mockCanvasRect();
    try {
      renderToyTable();
      await user.click(screen.getByTestId('toybox-straight'));

      const canvas = screen.getByTestId('toy-table-canvas') as unknown as Element;
      const initialX = Number(canvas.getAttribute('data-viewport-x'));
      const initialY = Number(canvas.getAttribute('data-viewport-y'));

      // Attempt to pan — but since a type is armed, left-drag should not pan.
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

      const afterX = Number(canvas.getAttribute('data-viewport-x'));
      const afterY = Number(canvas.getAttribute('data-viewport-y'));

      // Viewport should NOT have changed.
      expect(afterX).toBe(initialX);
      expect(afterY).toBe(initialY);
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
