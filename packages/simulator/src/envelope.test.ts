import { describe, expect, it } from 'vitest';
import { buildCoreCommand, buildCoreEvent, parseCoreCommand, parseCoreEvent } from './envelope.js';

const EVENT = {
  event_id: 'e1',
  device_id: 'GATE-1',
  timestamp_device: '1970-01-01T00:00:00.000Z',
  event_type: 'gate_state_changed',
  payload: { marker_id: 'M3', state: 'withholding' },
} as const;

const COMMAND = {
  command_id: 'c1',
  device_id: 'GATE-1',
  timestamp_server: '1970-01-01T00:00:00.000Z',
  command_type: 'hold_gate',
  payload: { marker_id: 'M3' },
} as const;

describe('event envelopes', () => {
  it('builds an event whose payload satisfies its schema', () => {
    const event = buildCoreEvent(EVENT);
    expect(event.event_type).toBe('gate_state_changed');
    expect(event.payload).toEqual(EVENT.payload);
  });

  it('throws for a payload that violates the schema', () => {
    expect(() => buildCoreEvent({ ...EVENT, payload: { marker_id: 7 } })).toThrow(
      /gate_state_changed/,
    );
  });

  it('rejects unknown event types, non-objects and inherited names', () => {
    expect(parseCoreEvent({ ...EVENT, event_type: 'nope' })).toBeUndefined();
    expect(parseCoreEvent({ ...EVENT, event_type: 'toString' })).toBeUndefined();
    expect(parseCoreEvent('x')).toBeUndefined();
    expect(parseCoreEvent(null)).toBeUndefined();
    expect(parseCoreEvent({})).toBeUndefined();
  });
});

describe('command envelopes', () => {
  it('builds a command whose payload satisfies its schema', () => {
    expect(buildCoreCommand(COMMAND)?.command_type).toBe('hold_gate');
  });

  it('rejects a malformed payload', () => {
    expect(buildCoreCommand({ ...COMMAND, payload: { marker_id: 7 } })).toBeUndefined();
  });

  it('rejects unknown command types and non-objects', () => {
    expect(buildCoreCommand({ ...COMMAND, command_type: 'detonate' })).toBeUndefined();
    expect(parseCoreCommand({ ...COMMAND, command_type: 'toString' })).toBeUndefined();
    expect(parseCoreCommand(3)).toBeUndefined();
    expect(parseCoreCommand({})).toBeUndefined();
  });
});
