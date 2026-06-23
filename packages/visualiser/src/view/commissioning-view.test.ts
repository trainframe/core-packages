import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
/**
 * Headless CommissioningView (goal criterion 3) — NO React, NO DOM. Proves the
 * commissioning logic is UI-independent: a newly-registered/scanned item enters a
 * pending queue; classify/setName/setTrainLength/bindTagToMarker transition it;
 * confirm emits the correctness facts (device re-announce / tag_assignment) AND
 * the operator profile (name, measured length, marker name). Deterministic —
 * injected newId/now, no Date.now/Math.random.
 */
import { InMemoryBrokerSubscriber } from '../broker/in-memory-client.js';
import { CommissioningView } from './commissioning-view.js';

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

interface Published {
  topic: string;
  device_id: string;
  event_type: string;
  protocol_version: string;
  payload: Record<string, unknown>;
}

function setup(): {
  client: InMemoryBrokerSubscriber;
  view: CommissioningView;
  published: () => Published[];
} {
  const client = new InMemoryBrokerSubscriber();
  client.connect('inmem://');
  let seq = 0;
  const newId = (): string => {
    seq += 1;
    return `id-${seq}`;
  };
  const view = new CommissioningView({
    client,
    newId,
    now: () => '2026-06-23T00:00:00.000Z',
    authorityId: 'GARAGE',
  });
  view.subscribe(() => {}); // wire the broker subscriptions
  const published = (): Published[] =>
    client.published.map((m) => {
      const env = JSON.parse(new TextDecoder().decode(m.payload)) as Omit<Published, 'topic'>;
      return { topic: m.topic, ...env };
    });
  return { client, view, published };
}

/** Make a device appear via a retained snapshot (as the server would publish). */
function announceDevice(
  client: InMemoryBrokerSubscriber,
  id: string,
  snapshot: Record<string, unknown>,
): void {
  client.deliver({ topic: `railway/state/devices/${id}`, payload: encode(snapshot) });
}

/** Make a tag appear via a tag_observed event. */
function observeTag(client: InMemoryBrokerSubscriber, deviceId: string, tagId: string): void {
  client.deliver({
    topic: `railway/events/tag_observed/${deviceId}`,
    payload: encode({
      event_type: 'tag_observed',
      device_id: deviceId,
      payload: { tag_id: tagId },
    }),
  });
}

describe('CommissioningView — pending queue (criterion 3)', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it('a registered, un-named device enters the queue suggested as a TRAIN when it drives motion', () => {
    announceDevice(h.client, 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    const pending = h.view.getState().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('T1');
    expect(pending[0]?.suggestedCategory).toBe('train');
    expect(pending[0]?.category).toBe('train'); // default = suggested
  });

  it('a non-motion device is suggested as a DEVICE', () => {
    announceDevice(h.client, 'GATE-1', { capabilities: ['core.gates_clearance'] });
    expect(h.view.getState().pending[0]?.suggestedCategory).toBe('device');
  });

  it('a device whose snapshot already carries an operator name is NOT pending (commissioned)', () => {
    announceDevice(h.client, 'T1', {
      capabilities: ['core.controls_motion'],
      name: 'Flying Scotsman',
    });
    expect(h.view.getState().pending).toHaveLength(0);
  });

  it('an unknown observed tag enters the queue suggested as TRACK', () => {
    observeTag(h.client, 'READER-1', 'TAG-04A39F2C');
    const pending = h.view.getState().pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe('TAG-04A39F2C');
    expect(pending[0]?.suggestedCategory).toBe('track');
  });
});

describe('CommissioningView — commands + confirm emit correctness facts + profile (criterion 3)', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it('classify/setName/setTrainLength transition the draft in getState()', () => {
    announceDevice(h.client, 'T1', { capabilities: ['core.controls_motion'] });
    h.view.setName('T1', 'Rocket');
    h.view.setTrainLength('T1', 180);
    const item = h.view.getState().pending[0];
    expect(item?.name).toBe('Rocket');
    expect(item?.trainLengthMm).toBe(180);
  });

  it('confirming a TRAIN re-announces device_registered with name + measured length, and drops it from the queue', () => {
    announceDevice(h.client, 'T1', {
      capabilities: ['core.controls_motion', 'core.accepts_route'],
    });
    h.view.setName('T1', 'Rocket');
    h.view.setTrainLength('T1', 180);
    h.view.confirm('T1');

    expect(h.view.getState().pending).toHaveLength(0); // optimistically resolved

    const reg = h.published().find((p) => p.topic === 'railway/events/device_registered/T1');
    expect(reg).toBeDefined();
    expect(reg?.protocol_version).toBe(PROTOCOL_VERSION);
    expect(reg?.payload).toMatchObject({
      capabilities: ['core.controls_motion', 'core.accepts_route'],
      name: 'Rocket',
      train_length_mm: 180,
    });
  });

  it('confirming a non-train DEVICE re-announces name but NOT a train length', () => {
    announceDevice(h.client, 'GATE-1', { capabilities: ['core.gates_clearance'] });
    h.view.setName('GATE-1', 'East Signal');
    h.view.setTrainLength('GATE-1', 999); // should be ignored for a non-train
    h.view.confirm('GATE-1');

    const reg = h.published().find((p) => p.topic === 'railway/events/device_registered/GATE-1');
    expect(reg?.payload).toMatchObject({ name: 'East Signal' });
    expect(reg?.payload.train_length_mm).toBeUndefined();
  });

  it('confirming a TRACK tag registers the garage authority once and binds the tag to a named marker', () => {
    observeTag(h.client, 'READER-1', 'TAG-1');
    h.view.classify('TAG-1', 'track');
    h.view.bindTagToMarker('TAG-1', 'M-platform');
    h.view.setName('TAG-1', 'Platform 1');
    h.view.confirm('TAG-1');

    const pub = h.published();
    // The garage authority announced itself with assigns_tags (once).
    const garage = pub.filter((p) => p.topic === 'railway/events/device_registered/GARAGE');
    expect(garage).toHaveLength(1);
    expect(garage[0]?.payload.capabilities).toEqual(['core.assigns_tags']);
    // The tag binding carries the target marker + operator name.
    const tag = pub.find((p) => p.topic === 'railway/events/tag_assignment/GARAGE');
    expect(tag?.payload).toMatchObject({
      tag_id: 'TAG-1',
      assigned_kind: 'marker',
      target_id: 'M-platform',
      marker_name: 'Platform 1',
    });
    expect(h.view.getState().pending).toHaveLength(0);
  });

  it('dismiss drops an item without publishing anything', () => {
    announceDevice(h.client, 'T1', { capabilities: ['core.controls_motion'] });
    h.view.dismiss('T1');
    expect(h.view.getState().pending).toHaveLength(0);
    expect(h.published()).toHaveLength(0);
  });
});
