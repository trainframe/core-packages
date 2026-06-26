import { topics } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { InMemoryEspNow } from './espnow-link.js';
import { InMemoryBrokerClient } from './in-memory-client.js';
import { PairingBridge } from './pairing-bridge.js';

const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const dec = (u: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(u));

/** Stand up a bridge with a fake device peer on the link and an in-memory bus. */
function harness() {
  const air = new InMemoryEspNow();
  const device = air.peer('SW-hw1'); // the constrained device
  const bus = new InMemoryBrokerClient();
  bus.connect('ws://test');
  let seq = 0;
  const newId = (): string => {
    seq += 1;
    return `evt-${seq}`;
  };
  const bridge = new PairingBridge({
    link: air.peer('BRIDGE'),
    bus,
    newId,
    now: () => new Date(0).toISOString(),
  });
  bridge.start();

  const fromBridge: Array<Record<string, unknown>> = [];
  device.onReceive((f) => fromBridge.push(dec(f.payload) as Record<string, unknown>));
  const busEvents: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  bus.subscribe('railway/events/#', (m) =>
    busEvents.push({ topic: m.topic, payload: dec(m.payload) as Record<string, unknown> }),
  );
  return { air, device, bus, bridge, fromBridge, busEvents };
}

describe('PairingBridge — relays the onboarding handshake link↔bus (ADR-035)', () => {
  it('announce → device_discovered on the bus + a discovered ack down the link', () => {
    const h = harness();
    h.device.broadcast(enc({ kind: 'announce', hwId: 'SW-hw1', deviceKind: 'mainline-switch' }));

    const discovered = h.busEvents.find((e) => e.topic.includes('/device_discovered/'));
    expect(discovered, 'device_discovered published to the bus').toBeDefined();
    expect((discovered?.payload.payload as { device_ref?: string })?.device_ref).toBe('SW-hw1');
    const ack = h.fromBridge.find((f) => f.kind === 'discovered');
    expect(ack, 'discovered ack sent to the device').toBeDefined();
    expect(ack?.deviceId).toBe('DEV-SW-hw1');
  });

  it('device_association on the bus → an associate frame relayed down the link', () => {
    const h = harness();
    h.device.broadcast(enc({ kind: 'announce', hwId: 'SW-hw1', deviceKind: 'mainline-switch' }));

    h.bus.publish(
      topics.event('device_association', 'GARAGE'),
      enc({
        event_type: 'device_association',
        payload: { device_ref: 'SW-hw1', tag_id: 'RFID-7' },
      }),
    );

    const assoc = h.fromBridge.find((f) => f.kind === 'associate');
    expect(assoc?.tagId).toBe('RFID-7');
  });

  it('a device event is republished on the bus under the device_id; a command is relayed down', () => {
    const h = harness();
    h.device.broadcast(enc({ kind: 'announce', hwId: 'SW-hw1', deviceKind: 'mainline-switch' }));

    // Device → bridge → bus
    h.device.sendTo(
      'BRIDGE',
      enc({ kind: 'event', eventType: 'device_registered', payload: { capabilities: [] } }),
    );
    const reg = h.busEvents.find(
      (e) => e.topic === topics.event('device_registered', 'DEV-SW-hw1'),
    );
    expect(reg, 'device_registered republished under the bridge-assigned id').toBeDefined();

    // Bus command → bridge → device
    h.bus.publish(
      topics.command('DEV-SW-hw1'),
      enc({ command_type: 'set_switch_position', payload: { position: 'divert' } }),
    );
    const cmd = h.fromBridge.find((f) => f.kind === 'command');
    expect(cmd?.commandType).toBe('set_switch_position');
  });

  it('association for an unknown device_ref is ignored (no relay)', () => {
    const h = harness();
    h.bus.publish(
      topics.event('device_association', 'GARAGE'),
      enc({ event_type: 'device_association', payload: { device_ref: 'GHOST', tag_id: 'x' } }),
    );
    expect(h.fromBridge.filter((f) => f.kind === 'associate')).toHaveLength(0);
  });
});
