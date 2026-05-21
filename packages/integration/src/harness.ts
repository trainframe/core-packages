import { type AddressInfo, type Server as TcpServer, createServer } from 'node:net';
import { type Layout, PROTOCOL_VERSION } from '@trainframe/protocol';
import {
  MqttBrokerClient,
  type ServerOptions,
  Server as TrainframeServer,
} from '@trainframe/server';
import { Aedes } from 'aedes';
import mqtt, { type MqttClient } from 'mqtt';

type AedesBroker = Awaited<ReturnType<typeof Aedes.createBroker>>;

/**
 * Cross-package wire-level test harness.
 *
 * Browser-driven UI tests (clicking the visualiser, asserting on the rendered
 * SVG) are NOT in this package — those are Playwright territory and will live
 * separately when added. This package tests the wire contract: device events
 * publish in, scheduler decisions come out as commands and retained state.
 *
 * Each test gets a fresh broker on a random port, a fresh server, and a
 * MQTT-as-test-client subscriber. `shutdown()` tears everything down so
 * Vitest doesn't hang.
 */
export interface HarnessOptions {
  readonly layout: Layout;
}

export interface Harness {
  readonly brokerUrl: string;
  readonly server: TrainframeServer;
  readonly testClient: TestClient;
  shutdown(): Promise<void>;
}

export async function startHarness(opts: HarnessOptions): Promise<Harness> {
  const broker = await Aedes.createBroker();
  const tcpServer = createServer((stream) => {
    broker.handle(stream);
  });
  const port = await listenOnRandomPort(tcpServer);
  const brokerUrl = `mqtt://127.0.0.1:${port}`;

  const serverClient = new MqttBrokerClient();
  await serverClient.connect(brokerUrl);
  const server = new TrainframeServer({ layout: opts.layout, client: serverClient });
  server.start();

  const testClient = await TestClient.connect(brokerUrl);
  // Give MQTT subscribes (server-side and test-client-side) time to propagate
  // through the broker and retained messages time to deliver to the test
  // client. Without this, tests race: a publish from the test client can
  // reach the broker before the server's subscription is acked.
  await delay(150);

  return {
    brokerUrl,
    server,
    testClient,
    async shutdown() {
      server.stop();
      await testClient.disconnect();
      await serverClient.disconnect();
      await closeBroker(broker);
      await closeTcpServer(tcpServer);
    },
  };
}

interface ServerEnvelope {
  readonly event_id: string;
  readonly device_id: string;
  readonly timestamp_device: string;
  readonly event_type: string;
  readonly protocol_version: string;
  readonly payload: unknown;
}

interface CommandEnvelope {
  readonly command_id: string;
  readonly device_id: string;
  readonly timestamp_server: string;
  readonly command_type: string;
  readonly protocol_version: string;
  readonly payload: unknown;
}

/**
 * Helper that pretends to be a device + an operator. Publishes events as a
 * device would, observes commands as a device would, observes events as the
 * visualiser would.
 */
export class TestClient {
  private readonly observedCommands = new Map<string, CommandEnvelope[]>();
  private readonly observedEvents: ServerEnvelope[] = [];
  private readonly retainedState = new Map<string, unknown>();

  private constructor(private readonly client: MqttClient) {}

  static async connect(brokerUrl: string): Promise<TestClient> {
    const client = mqtt.connect(brokerUrl, { protocolVersion: 4, reconnectPeriod: 0 });
    await waitForConnect(client);

    const tc = new TestClient(client);
    client.on('message', (topic, payload) => {
      const text = payload.toString('utf8');
      if (topic.startsWith('railway/commands/')) {
        const trainId = topic.slice('railway/commands/'.length);
        const env = JSON.parse(text) as CommandEnvelope;
        let bucket = tc.observedCommands.get(trainId);
        if (!bucket) {
          bucket = [];
          tc.observedCommands.set(trainId, bucket);
        }
        bucket.push(env);
      } else if (topic.startsWith('railway/events/')) {
        const env = JSON.parse(text) as ServerEnvelope;
        tc.observedEvents.push(env);
      } else if (topic.startsWith('railway/state/')) {
        // Capture both retained-replay deliveries (packet.retain true) and
        // new publishes (packet.retain false on already-subscribed clients).
        // Tests that need to distinguish them can inspect ordering.
        tc.retainedState.set(topic, JSON.parse(text));
      }
    });

    await subscribe(client, 'railway/commands/#');
    await subscribe(client, 'railway/events/#');
    await subscribe(client, 'railway/state/#');
    return tc;
  }

  /**
   * Register a synthetic garage and publish identity tag_assignment events
   * for the given markers. Waits for the garage's retained device state so
   * subsequent tag_observed events resolve cleanly. Tests that exercise
   * tag_observed should call this once in setup.
   */
  async seedIdentityTags(markerIds: ReadonlyArray<string>): Promise<void> {
    await this.publishEvent('device_registered', 'GARAGE', {
      capabilities: ['core.assigns_tags'],
    });
    await this.waitForState('railway/state/devices/GARAGE');
    for (const id of markerIds) {
      await this.publishEvent('tag_assignment', 'GARAGE', {
        tag_id: id,
        assigned_kind: 'marker',
        target_id: id,
      });
    }
    // Wait for the last assignment to land as retained state.
    if (markerIds.length > 0) {
      const last = markerIds[markerIds.length - 1];
      await this.waitForState(`railway/state/tags/${last}`);
    }
  }

  /** Publish an event the way a device would. */
  async publishEvent(event_type: string, device_id: string, payload: unknown): Promise<void> {
    const envelope: ServerEnvelope = {
      event_id: `evt-${this.observedEvents.length}-${device_id}`,
      device_id,
      timestamp_device: new Date().toISOString(),
      event_type,
      protocol_version: PROTOCOL_VERSION,
      payload,
    };
    await new Promise<void>((resolve, reject) => {
      this.client.publish(
        `railway/events/${event_type}/${device_id}`,
        JSON.stringify(envelope),
        { qos: 1 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  /**
   * Wait until a retained state message has landed on the given topic. Useful
   * after publishing a `device_registered` event to confirm the server has
   * processed it before issuing follow-up actions like `assignRoute`.
   */
  async waitForState(topic: string, timeout_ms = 2000): Promise<unknown> {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
      const value = this.retainedState.get(topic);
      if (value !== undefined) return value;
      await delay(20);
    }
    throw new Error(`Timed out waiting for retained state on ${topic}`);
  }

  /** Wait until a command of the given type lands for the given train. */
  async waitForCommand(
    train_id: string,
    command_type: string,
    timeout_ms = 2000,
  ): Promise<CommandEnvelope> {
    const start = Date.now();
    while (Date.now() - start < timeout_ms) {
      const bucket = this.observedCommands.get(train_id) ?? [];
      const found = bucket.find((c) => c.command_type === command_type);
      if (found) return found;
      await delay(20);
    }
    throw new Error(
      `Timed out waiting for command ${command_type} on train ${train_id}. ` +
        `Observed: ${JSON.stringify(this.observedCommands.get(train_id) ?? [])}`,
    );
  }

  commandsFor(train_id: string): ReadonlyArray<CommandEnvelope> {
    return this.observedCommands.get(train_id) ?? [];
  }

  retained(): ReadonlyMap<string, unknown> {
    return this.retainedState;
  }

  events(): ReadonlyArray<ServerEnvelope> {
    return this.observedEvents;
  }

  async disconnect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.client.end(false, {}, () => resolve());
    });
  }
}

function waitForConnect(client: MqttClient): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', (err) => reject(err));
  });
}

function subscribe(client: MqttClient, topic: string): Promise<void> {
  return new Promise((resolve, reject) => {
    client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
  });
}

function listenOnRandomPort(server: TcpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}

function closeBroker(broker: AedesBroker): Promise<void> {
  return new Promise((resolve) => {
    broker.close(() => resolve());
  });
}

function closeTcpServer(server: TcpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export for tests that want to construct a Server with custom options.
export type { ServerOptions };
