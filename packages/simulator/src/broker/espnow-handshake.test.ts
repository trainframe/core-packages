import { topics } from '@trainframe/protocol';
import { describe, expect, it } from 'vitest';
import { SwitchDevice } from '../devices/switch-device.js';
import { InMemoryEspNow } from './espnow-link.js';
import { espNowPlatform } from './espnow-platform.js';
import { InMemoryBrokerClient } from './in-memory-client.js';
import { PairingBridge } from './pairing-bridge.js';

/**
 * The full ESP-NOW onboarding handshake, end-to-end through real seams (ADR-035
 * Phase 2): a REAL `SwitchDevice` on the `espNowPlatform` backing, a REAL
 * `PairingBridge`, a REAL in-memory bus — NOTHING mocked but the radio. The
 * switch is constructed with NO junction marker (it doesn't know it yet); the
 * marker is bound LATE, via the operator's scan relayed as `device_association`.
 */

const enc = (o: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(o));
const dec = (u: Uint8Array): Record<string, unknown> =>
  JSON.parse(new TextDecoder().decode(u)) as Record<string, unknown>;

interface BusEvent {
  readonly topic: string;
  readonly payload: { event_type?: string; payload?: Record<string, unknown> };
}

function harness() {
  const air = new InMemoryEspNow();
  const bus = new InMemoryBrokerClient();
  bus.connect('ws://test');
  let seq = 0;
  const newId = (): string => {
    seq += 1;
    return `evt-${seq}`;
  };
  const now = (): string => new Date(0).toISOString();
  const bridge = new PairingBridge({ link: air.peer('BRIDGE'), bus, newId, now });
  bridge.start();

  const events: BusEvent[] = [];
  bus.subscribe('railway/events/#', (m) =>
    events.push({ topic: m.topic, payload: dec(m.payload) as BusEvent['payload'] }),
  );
  const onBus = (eventType: string): BusEvent | undefined =>
    events.find((e) => e.payload.event_type === eventType);

  return { air, bus, newId, now, events, onBus };
}

const MARKER = 'M-junction-9';

describe('ESP-NOW onboarding handshake — late-bound switch end-to-end (ADR-035)', () => {
  it('announces, is discovered, registers ONLY after association binds its marker, then obeys commands', () => {
    const h = harness();
    const thrown: string[] = [];
    const sw = new SwitchDevice('SW-1', {
      platform: espNowPlatform(h.air.peer('SW-mac1')),
      actuator: { set: (p) => thrown.push(p) },
      positions: ['main', 'divert'],
      newId: h.newId,
      now: h.now,
    });

    sw.start(); // → announce → bridge discovers
    expect(h.onBus('device_discovered'), 'discovered relayed to the bus').toBeDefined();
    expect(
      h.onBus('device_registered'),
      'NOT registered before association (late-bound)',
    ).toBeUndefined();

    // The operator scans a tag for the discovered device.
    h.bus.publish(
      topics.event('device_association', 'GARAGE'),
      enc({ event_type: 'device_association', payload: { device_ref: 'SW-mac1', tag_id: MARKER } }),
    );

    const reg = h.onBus('device_registered');
    expect(reg, 'registers once associated').toBeDefined();
    expect(reg?.payload.payload?.controls_marker_id).toBe(MARKER);
    expect(reg?.payload.payload?.valid_positions).toEqual(['main', 'divert']);
    expect(reg?.topic).toBe(topics.event('device_registered', 'DEV-SW-mac1'));

    // A command for the bound marker throws the points; a wrong-marker one is ignored.
    h.bus.publish(
      topics.command('DEV-SW-mac1'),
      enc({
        command_type: 'set_switch_position',
        payload: { junction_marker_id: MARKER, position: 'divert' },
      }),
    );
    h.bus.publish(
      topics.command('DEV-SW-mac1'),
      enc({
        command_type: 'set_switch_position',
        payload: { junction_marker_id: 'WRONG', position: 'main' },
      }),
    );
    expect(thrown).toEqual(['divert']);
  });

  it('reboot-with-persisted-marker: re-registers on discovery, no scan needed', () => {
    const h = harness();
    const sw = new SwitchDevice('SW-1', {
      platform: espNowPlatform(h.air.peer('SW-mac1'), { persistedMarker: MARKER }),
      actuator: { set: () => {} },
      positions: ['main', 'divert'],
      newId: h.newId,
      now: h.now,
    });

    sw.start(); // → announce → discovered → register immediately (persisted)

    const reg = h.onBus('device_registered');
    expect(reg, 'a rebooted, already-paired device registers without a scan').toBeDefined();
    expect(reg?.payload.payload?.controls_marker_id).toBe(MARKER);
  });

  it('persists the associated marker so the next boot can reuse it', () => {
    const h = harness();
    let persisted: string | undefined;
    const sw = new SwitchDevice('SW-1', {
      platform: espNowPlatform(h.air.peer('SW-mac1'), {
        onPersist: (m) => {
          persisted = m;
        },
      }),
      actuator: { set: () => {} },
      positions: ['main', 'divert'],
      newId: h.newId,
      now: h.now,
    });
    sw.start();
    h.bus.publish(
      topics.event('device_association', 'GARAGE'),
      enc({ event_type: 'device_association', payload: { device_ref: 'SW-mac1', tag_id: MARKER } }),
    );
    expect(persisted).toBe(MARKER);
  });
});
