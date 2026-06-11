/*
 * @vitest-environment node
 *
 * This file talks to a REAL aedes broker over TCP via the `mqtt` client, which
 * needs the node (not jsdom) transport — jsdom would force the browser WebSocket
 * build and never reach a `mqtt://` TCP broker.
 */
/**
 * The MQTT platform adapter round-trips a real event + command over a REAL
 * in-process aedes broker — and the PORTABILITY PROOF: the SAME `BeaconDevice`
 * instance-shape runs unchanged over both the in-process bus AND the edge MQTT
 * adapter, with identical observable behaviour. The proof is that `BeaconDevice`
 * imports NEITHER backing — these tests, the composition root, wire them.
 *
 * aedes runs over plain TCP here (mirroring `@trainframe/integration`'s harness);
 * the simulator-ui's `MqttBrokerClient` connects via `mqtt://`. No mocking of the
 * provider — a real broker, a real client, real topics.
 */
import { type AddressInfo, type Server as TcpServer, createServer } from 'node:net';
import { type CoreEvent, type TagObserved, topics } from '@trainframe/protocol';
import { Aedes } from 'aedes';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BeaconDevice } from '../devices/beacon-device.js';
import { InProcessBus, inProcessPlatform } from '../devices/platform-provider.js';
import { MqttBrokerClient } from './mqtt-client.js';
import { mqttPlatform } from './mqtt-platform.js';

type AedesBroker = Awaited<ReturnType<typeof Aedes.createBroker>>;

const DEVICE = '33333333-3333-4333-8333-333333333333';

/** Sound discriminant on the event_type literal. */
function isTagObserved(e: CoreEvent): e is TagObserved {
  return e.event_type === 'tag_observed';
}

const decode = (bytes: Uint8Array): { event_type: string; payload: { tag_id?: string } } =>
  JSON.parse(new TextDecoder().decode(bytes));

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listenOnRandomPort(server: TcpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function connected(client: MqttBrokerClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = client.onStatusChange((status, error) => {
      if (status === 'connected') {
        off();
        resolve();
      } else if (status === 'error') {
        off();
        reject(error ?? new Error('broker connection failed'));
      }
    });
  });
}

describe('mqttPlatform — over a real aedes broker', () => {
  let broker: AedesBroker;
  let tcp: TcpServer;
  let url: string;
  let client: MqttBrokerClient;

  beforeEach(async () => {
    broker = await Aedes.createBroker();
    tcp = createServer((stream) => broker.handle(stream));
    const port = await listenOnRandomPort(tcp);
    url = `mqtt://127.0.0.1:${port}`;
    client = new MqttBrokerClient();
    client.connect(url);
    await connected(client);
  });

  afterEach(async () => {
    client.disconnect();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
    await new Promise<void>((resolve) => broker.close(() => resolve()));
  });

  it('publishes a device event onto the real broker topic', async () => {
    const platform = mqttPlatform(client, DEVICE);
    const seen: string[] = [];
    /* A second client subscribes to the device's event topic, as the server would. */
    const sub = new MqttBrokerClient();
    sub.connect(url);
    await connected(sub);
    sub.subscribe(topics.event('tag_observed', DEVICE), (m) => {
      seen.push(decode(m.payload).payload.tag_id ?? '');
    });
    await delay(80);

    new BeaconDevice(DEVICE, platform).sight('M7');
    await delay(120);

    expect(seen).toEqual(['M7']);
    sub.disconnect();
  });

  it('decodes a real command off the broker and hands it to onCommand', async () => {
    const platform = mqttPlatform(client, DEVICE);
    const beacon = new BeaconDevice(DEVICE, platform);
    beacon.start();
    await delay(80);

    /* A server publishes a grant_clearance command to the device's command topic. */
    const publisher = new MqttBrokerClient();
    publisher.connect(url);
    await connected(publisher);
    publisher.publish(
      topics.command(DEVICE),
      encode({
        command_id: '44444444-4444-4444-8444-444444444444',
        device_id: DEVICE,
        timestamp_server: '1970-01-01T00:00:00.000Z',
        command_type: 'grant_clearance',
        protocol_version: '0.10.0',
        payload: { limit_marker_id: '55555555-5555-4555-8555-555555555555' },
      }),
    );
    await delay(120);

    expect(beacon.received).toEqual(['grant_clearance']);
    /* A malformed command is dropped at the edge — never handed to the device. */
    publisher.publish(topics.command(DEVICE), encode({ not: 'a command' }));
    await delay(80);
    expect(beacon.received).toEqual(['grant_clearance']);
    publisher.disconnect();
    beacon.stop();
  });

  it('PORTABILITY: the same device behaves identically over the in-process bus and over MQTT', async () => {
    /* --- in-process backing --- */
    const bus = new InProcessBus();
    const busBeacon = new BeaconDevice(DEVICE, inProcessPlatform(bus, DEVICE));
    const busEvents: string[] = [];
    bus.onEvent(DEVICE, (e) => {
      if (isTagObserved(e)) busEvents.push(e.payload.tag_id);
    });
    busBeacon.start();
    busBeacon.sight('M9');
    bus.sendCommand(DEVICE, {
      command_id: '66666666-6666-4666-8666-666666666666',
      device_id: DEVICE,
      timestamp_server: '1970-01-01T00:00:00.000Z',
      command_type: 'emergency_stop',
      protocol_version: '0.10.0',
      payload: {},
    });

    /* --- MQTT edge backing, SAME device shape, SAME script --- */
    const mqttBeacon = new BeaconDevice(DEVICE, mqttPlatform(client, DEVICE));
    const mqttEvents: string[] = [];
    const sub = new MqttBrokerClient();
    sub.connect(url);
    await connected(sub);
    sub.subscribe(topics.event('tag_observed', DEVICE), (m) => {
      mqttEvents.push(decode(m.payload).payload.tag_id ?? '');
    });
    await delay(80);
    mqttBeacon.start();
    await delay(40);
    mqttBeacon.sight('M9');
    const publisher = new MqttBrokerClient();
    publisher.connect(url);
    await connected(publisher);
    await delay(40);
    publisher.publish(
      topics.command(DEVICE),
      encode({
        command_id: '77777777-7777-4777-8777-777777777777',
        device_id: DEVICE,
        timestamp_server: '1970-01-01T00:00:00.000Z',
        command_type: 'emergency_stop',
        protocol_version: '0.10.0',
        payload: {},
      }),
    );
    await delay(150);

    /* Identical observable behaviour: same event out, same command in. */
    expect(busEvents).toEqual(['M9']);
    expect(mqttEvents).toEqual(['M9']);
    expect(busBeacon.received).toEqual(['emergency_stop']);
    expect(mqttBeacon.received).toEqual(['emergency_stop']);

    sub.disconnect();
    publisher.disconnect();
    busBeacon.stop();
    mqttBeacon.stop();
  });
});
