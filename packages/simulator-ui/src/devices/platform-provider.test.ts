import {
  type CoreCommand,
  type CoreEvent,
  type DeviceManifest,
  PROTOCOL_VERSION,
} from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { ParentPlatform } from './parent-platform.js';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';

const VERSION = PROTOCOL_VERSION;

function tagObserved(deviceId: string, tagId: string): CoreEvent {
  return {
    event_id: '11111111-1111-4111-8111-111111111111',
    device_id: deviceId,
    timestamp_device: '1970-01-01T00:00:00.000Z',
    event_type: 'tag_observed',
    protocol_version: VERSION,
    payload: { tag_id: tagId },
  };
}

function grantClearance(deviceId: string, marker: string): CoreCommand {
  return {
    command_id: '22222222-2222-4222-8222-222222222222',
    device_id: deviceId,
    timestamp_server: '1970-01-01T00:00:00.000Z',
    command_type: 'grant_clearance',
    protocol_version: VERSION,
    payload: { limit_marker_id: marker },
  };
}

const MANIFEST: DeviceManifest = {
  manifest_version: '1.0',
  vendor: 'trainframe',
  device_kind: 'example.beacon',
  version: '1.0.0',
  protocol_version: VERSION,
  display_name: 'Beacon',
  description: 'A test beacon device.',
  capabilities: ['core.reports_marker_traversal'],
};

describe('InProcessBus + inProcessPlatform', () => {
  it('delivers a published event to every subscriber for that device id', () => {
    const bus = new InProcessBus();
    const platform = inProcessPlatform(bus, 'D1');
    const seenA: CoreEvent[] = [];
    const seenB: CoreEvent[] = [];
    bus.onEvent('D1', (e) => seenA.push(e));
    bus.onEvent('D1', (e) => seenB.push(e));
    /* An event for a DIFFERENT device must not leak across. */
    const otherSeen: CoreEvent[] = [];
    bus.onEvent('D2', (e) => otherSeen.push(e));

    platform.publish(tagObserved('D1', 'M3'));

    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);
    expect(seenA[0]?.event_type).toBe('tag_observed');
    expect(otherSeen).toHaveLength(0);
  });

  it('delivers a command to the device that subscribed via onCommand', () => {
    const bus = new InProcessBus();
    const platform = inProcessPlatform(bus, 'D1');
    const got: CoreCommand[] = [];
    platform.onCommand((c) => got.push(c));

    bus.sendCommand('D1', grantClearance('D1', 'M5'));

    expect(got).toHaveLength(1);
    expect(got[0]?.command_type).toBe('grant_clearance');
  });

  it('stops delivering once unsubscribed', () => {
    const bus = new InProcessBus();
    const platform = inProcessPlatform(bus, 'D1');
    const got: CoreCommand[] = [];
    const off = platform.onCommand((c) => got.push(c));

    bus.sendCommand('D1', grantClearance('D1', 'M1'));
    off();
    bus.sendCommand('D1', grantClearance('D1', 'M2'));

    expect(got).toHaveLength(1);

    const seen: CoreEvent[] = [];
    const offE = bus.onEvent('D1', (e) => seen.push(e));
    platform.publish(tagObserved('D1', 'A'));
    offE();
    platform.publish(tagObserved('D1', 'B'));
    expect(seen).toHaveLength(1);
  });

  it('records a registered manifest, observable on the bus', () => {
    const bus = new InProcessBus();
    inProcessPlatform(bus, 'D1').register(MANIFEST);
    expect(bus.manifestOf('D1')?.device_kind).toBe('example.beacon');
    expect(bus.manifestOf('absent')).toBeUndefined();
  });

  it('publishing with no subscribers is a no-op (no throw)', () => {
    const bus = new InProcessBus();
    expect(() => inProcessPlatform(bus, 'D1').publish(tagObserved('D1', 'X'))).not.toThrow();
    expect(() => bus.sendCommand('D1', grantClearance('D1', 'Y'))).not.toThrow();
  });
});

describe('ParentPlatform (parent-as-core, ADR-032)', () => {
  it('routes a child publish UP to the parent, and a parent command DOWN to the child', () => {
    const parent = new ParentPlatform();
    /* The child is wired from the parent's platform provider — to the child this
     *  IS core. It cannot tell it is talking to a parent, not the broker. */
    const childProvider = parent.platformFor('TT1');

    const parentSaw: CoreEvent[] = [];
    parent.onChildEvent('TT1', (e) => parentSaw.push(e));

    const childGot: CoreCommand[] = [];
    childProvider.onCommand((c) => childGot.push(c));

    /* Child reports occupancy upward (report upward, never sideways to core). */
    childProvider.publish(tagObserved('TT1', 'deck'));
    /* Parent answers clearance downward, as core would. */
    parent.command('TT1', grantClearance('TT1', 'deck'));

    expect(parentSaw.map((e) => e.event_type)).toEqual(['tag_observed']);
    expect(childGot.map((c) => c.command_type)).toEqual(['grant_clearance']);
  });

  it('keeps two children isolated on the same parent', () => {
    const parent = new ParentPlatform();
    const a = parent.platformFor('A');
    const b = parent.platformFor('B');
    const aGot: CoreCommand[] = [];
    const bGot: CoreCommand[] = [];
    a.onCommand((c) => aGot.push(c));
    b.onCommand((c) => bGot.push(c));

    parent.command('A', grantClearance('A', 'M'));

    expect(aGot).toHaveLength(1);
    expect(bGot).toHaveLength(0);
  });

  it('records a child manifest registered through the seam', () => {
    const parent = new ParentPlatform();
    parent.platformFor('TT1').register(MANIFEST);
    expect(parent.childManifest('TT1')?.device_kind).toBe('example.beacon');
  });
});
