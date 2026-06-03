import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
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
