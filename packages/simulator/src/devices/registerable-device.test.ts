import type { CoreCommand, CoreEvent, DeviceManifest } from '@trainframe/protocol';
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { InProcessBus, inProcessPlatform } from './platform-provider.js';
import { registerDevice } from './registerable-device.js';

const MANIFEST: DeviceManifest = {
  manifest_version: '1.0',
  vendor: 'trainframe.test',
  device_kind: 'test-device',
  version: '0.1.0',
  protocol_version: PROTOCOL_VERSION,
  display_name: 'Test',
  description: 'A device under test',
  capabilities: ['core.controls_switch'],
};

const registeredEvent = (): CoreEvent =>
  ({
    event_id: 'evt-1',
    device_id: 'DEV-1',
    timestamp_device: new Date(0).toISOString(),
    event_type: 'device_registered',
    protocol_version: PROTOCOL_VERSION,
    payload: { capabilities: ['core.controls_switch'], device_kind_hint: 'test-device' },
  }) as unknown as CoreEvent;

const aCommand = (): CoreCommand =>
  ({
    command_id: 'cmd-1',
    device_id: 'DEV-1',
    timestamp_server: new Date(0).toISOString(),
    command_type: 'set_switch_position',
    protocol_version: PROTOCOL_VERSION,
    payload: { junction_marker_id: 'M-1', position: 'main' },
  }) as unknown as CoreCommand;

describe('registerDevice — the shared registration lifecycle seam (ADR-035)', () => {
  it('registers the manifest, publishes the registered event, then subscribes to commands', () => {
    const bus = new InProcessBus();
    const events: CoreEvent[] = [];
    bus.onEvent('DEV-1', (e) => events.push(e));
    const commands: CoreCommand[] = [];

    const off = registerDevice(inProcessPlatform(bus, 'DEV-1'), {
      manifest: MANIFEST,
      registeredEvent: registeredEvent(),
      onCommand: (c) => commands.push(c),
    });

    /* The manifest registered (the first lifecycle step), and the
       device_registered event went out exactly once. */
    expect(bus.manifestOf('DEV-1')).toEqual(MANIFEST);
    expect(events.filter((e) => e.event_type === 'device_registered')).toHaveLength(1);
    /* Commands are delivered to the handler. */
    bus.sendCommand('DEV-1', aCommand());
    expect(commands).toHaveLength(1);
    /* The returned teardown unsubscribes. */
    off();
    bus.sendCommand('DEV-1', aCommand());
    expect(commands).toHaveLength(1);
  });

  it('omitting registeredEvent registers + subscribes without publishing (a beacon-style device)', () => {
    const bus = new InProcessBus();
    const events: CoreEvent[] = [];
    bus.onEvent('DEV-1', (e) => events.push(e));
    const commands: CoreCommand[] = [];

    registerDevice(inProcessPlatform(bus, 'DEV-1'), {
      manifest: MANIFEST,
      onCommand: (c) => commands.push(c),
    });

    expect(events).toHaveLength(0); // nothing published yet
    bus.sendCommand('DEV-1', aCommand());
    expect(commands).toHaveLength(1); // still subscribed
  });

  it('omitting onCommand registers + publishes but subscribes to nothing (a zone)', () => {
    const bus = new InProcessBus();
    const events: CoreEvent[] = [];
    bus.onEvent('DEV-1', (e) => events.push(e));

    const off = registerDevice(inProcessPlatform(bus, 'DEV-1'), {
      manifest: MANIFEST,
      registeredEvent: registeredEvent(),
    });

    expect(events.filter((e) => e.event_type === 'device_registered')).toHaveLength(1);
    /* A command for this device reaches no handler, and the teardown is a safe no-op. */
    expect(() => bus.sendCommand('DEV-1', aCommand())).not.toThrow();
    expect(() => off()).not.toThrow();
  });
});
