import { describe, expect, it } from 'vitest';
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
      protocol_version: '0.2.0',
      payload: { capabilities: ['core.controls_motion'] },
    });
  });

  it('falls back to default newId / now when options are omitted', () => {
    const { payload } = encodeDeviceEvent('tag_observed', 'T-2', { tag_id: 'M1' });
    const envelope = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
    expect(typeof envelope.event_id).toBe('string');
    expect((envelope.event_id as string).length).toBeGreaterThan(0);
    expect(typeof envelope.timestamp_device).toBe('string');
  });
});
