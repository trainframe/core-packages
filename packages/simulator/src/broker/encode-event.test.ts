import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { deterministicEnvelopeSource } from '../envelope-source.js';
import { encodeDeviceEvent } from './encode-event.js';

describe('encodeDeviceEvent', () => {
  it('builds a topic + envelope shaped like the BrokerBridge output', () => {
    const { topic, payload } = encodeDeviceEvent(
      'device_registered',
      'T-1',
      { capabilities: ['core.controls_motion'] },
      { newId: () => 'evt-id', now: () => '2026-01-01T00:00:00.000Z' },
    );
    expect(topic).toBe('railway/events/device_registered/T-1');
    const envelope = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      event_id: 'evt-id',
      device_id: 'T-1',
      timestamp_device: '2026-01-01T00:00:00.000Z',
      event_type: 'device_registered',
      protocol_version: PROTOCOL_VERSION,
      payload: { capabilities: ['core.controls_motion'] },
    });
  });

  it('stamps ids and timestamps from the injected source', () => {
    const source = deterministicEnvelopeSource();
    const { payload } = encodeDeviceEvent('tag_observed', 'T-2', { tag_id: 'M1' }, source);
    const envelope = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    expect(envelope.event_id).toBe('id-1');
    expect(envelope.timestamp_device).toBe('1970-01-01T00:00:00.000Z');
  });
});
