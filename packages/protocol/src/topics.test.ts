import { describe, expect, it } from 'vitest';
import { parseEventTopic, subscriptions, topics } from './topics.js';

describe('topics', () => {
  it('builds a core event topic', () => {
    expect(topics.event('marker_traversed', 'T1')).toBe('railway/events/marker_traversed/T1');
  });

  it('builds a custom event topic with vendor namespace', () => {
    expect(topics.customEvent('com.alice', 'turntable_aligned', 'TT-1')).toBe(
      'railway/events/custom/com.alice/turntable_aligned/TT-1',
    );
  });

  it('builds a command topic', () => {
    expect(topics.command('T1')).toBe('railway/commands/T1');
  });

  it('builds a state topic', () => {
    expect(topics.state('train', 'T1')).toBe('railway/state/train/T1');
  });

  it('exposes the registration topic as a constant', () => {
    expect(topics.registration).toBe('railway/discovery/register');
  });
});

describe('subscriptions', () => {
  it('exposes the all-events subscription', () => {
    expect(subscriptions.allEvents).toBe('railway/events/#');
  });

  it('exposes a core-events subscription that excludes custom events', () => {
    expect(subscriptions.coreEvents).toBe('railway/events/+/+');
  });

  it('builds a vendor-scoped custom event subscription', () => {
    expect(subscriptions.customEventsForVendor('com.alice')).toBe(
      'railway/events/custom/com.alice/#',
    );
  });

  it('builds a per-event-type subscription', () => {
    expect(subscriptions.eventsOfType('clearance_granted')).toBe(
      'railway/events/clearance_granted/+',
    );
  });

  it('builds a per-device commands subscription', () => {
    expect(subscriptions.commandsForDevice('T1')).toBe('railway/commands/T1');
  });

  it('exposes all-commands and all-state subscriptions', () => {
    expect(subscriptions.allCommands).toBe('railway/commands/#');
    expect(subscriptions.allState).toBe('railway/state/#');
  });
});

describe('parseEventTopic', () => {
  it('parses a core event topic', () => {
    expect(parseEventTopic('railway/events/marker_traversed/T1')).toEqual({
      kind: 'core',
      event_type: 'marker_traversed',
      device_id: 'T1',
    });
  });

  it('parses a custom event topic', () => {
    expect(parseEventTopic('railway/events/custom/com.alice/turntable_aligned/TT-1')).toEqual({
      kind: 'custom',
      vendor: 'com.alice',
      event_type: 'turntable_aligned',
      device_id: 'TT-1',
    });
  });

  it('returns null for non-railway topics', () => {
    expect(parseEventTopic('other/events/x/T1')).toBeNull();
  });

  it('returns null when the second segment is not "events"', () => {
    expect(parseEventTopic('railway/commands/T1')).toBeNull();
  });

  it('returns null for malformed core event topics (wrong segment count)', () => {
    expect(parseEventTopic('railway/events/marker_traversed')).toBeNull();
    expect(parseEventTopic('railway/events/marker_traversed/T1/extra')).toBeNull();
  });

  it('returns null for malformed custom event topics', () => {
    expect(parseEventTopic('railway/events/custom/com.alice/event')).toBeNull();
    expect(parseEventTopic('railway/events/custom//event/T1')).toBeNull();
  });

  it('round-trips with topics.event', () => {
    const topic = topics.event('clearance_granted', 'T1');
    expect(parseEventTopic(topic)).toEqual({
      kind: 'core',
      event_type: 'clearance_granted',
      device_id: 'T1',
    });
  });

  it('round-trips with topics.customEvent', () => {
    const topic = topics.customEvent('com.alice', 'turntable_aligned', 'TT-1');
    expect(parseEventTopic(topic)).toEqual({
      kind: 'custom',
      vendor: 'com.alice',
      event_type: 'turntable_aligned',
      device_id: 'TT-1',
    });
  });
});
