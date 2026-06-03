import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient, Server as TrainframeServer } from '@trainframe/server';
import { BrokerBridge, Simulation } from '@trainframe/simulator';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

type AedesBroker = Awaited<ReturnType<typeof Aedes.createBroker>>;

export interface UiHarness {
  readonly brokerWsUrl: string;
  readonly server: TrainframeServer;
  /**
   * A device-only `Simulation` wired to the broker via `BrokerBridge`. The
   * harness server's scheduler is the only scheduler in play — the sim
   * supplies device physics (trains, gates, marker reads). Tests that need
   * real device feedback (route reassignment driving an edge crossing, gate
   * holds keeping a train stopped, etc.) drive this and observe through the
   * visualiser.
   *
   * Tests that don't need it can ignore it. The sim doesn't tick on its own;
   * call `advance(ms)` to step it.
   */
  readonly simulation: Simulation;
  /**
   * Advance the simulation by `ms` virtual milliseconds. Events captured by
   * trains/gates are bridged onto the broker synchronously; the visualiser
   * sees them on the next WebSocket flush.
   */
  advance(ms: number): void;
  shutdown(): Promise<void>;
}

export interface UiHarnessOptions {
  readonly layout: Layout;
  /** WebSocket port for the broker. Defaults to 9001 (matches the UI's default). */
  readonly wsPort?: number;
  /** Seed for the bridged simulation. Defaults to `1`. */
  readonly seed?: number;
}

/**
 * Boots an aedes broker over WebSockets, runs a real @trainframe/server
 * against it, and spins up a device-only `Simulation` wired to the same
 * broker via `BrokerBridge`. The harness gives tests:
 *
 *   - a working broker the simulator-ui and visualiser can connect to
 *   - a real server with the admin HTTP routes (tag assignment, route
 *     assignment, gate hold/release)
 *   - a manually-advanced sim that supplies the device-side responses the
 *     server's scheduler expects (marker reads, gate state changes, etc.)
 *
 * The sim doesn't auto-tick — tests call `harness.advance(ms)` to drive it.
 */
export async function startUiHarness(opts: UiHarnessOptions): Promise<UiHarness> {
  const broker = await Aedes.createBroker();
  const { httpServer, wsPort } = await listenWebSocketBroker(broker, opts.wsPort ?? 9001);
  const brokerWsUrl = `ws://127.0.0.1:${wsPort}`;

  const serverClient = new MqttBrokerClient();
  await serverClient.connect(brokerWsUrl);
  const server = new TrainframeServer({ layout: opts.layout, client: serverClient });
  server.start();

  const simClient = new MqttBrokerClient();
  await simClient.connect(brokerWsUrl);
  const simulation = new Simulation({
    layout: opts.layout,
    seed: opts.seed ?? 1,
  });
  const bridge = new BrokerBridge(simulation, simClient, { newId: defaultNewId });
  bridge.start();
  // Seed identity tags AFTER the bridge has subscribed so the synthetic-
  // garage events flow sim → bridge → broker → server. Seeding before
  // `bridge.start()` would silently lose them because they're appended to
  // `sim.events` but no subscriber is attached.
  simulation.seedIdentityTags(opts.layout);

  return {
    brokerWsUrl,
    server,
    simulation,
    advance(ms: number) {
      simulation.advance(ms);
    },
    async shutdown() {
      bridge.stop();
      server.stop();
      await simClient.disconnect();
      await serverClient.disconnect();
      await closeBroker(broker);
      await closeHttpServer(httpServer);
    },
  };
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

async function listenWebSocketBroker(
  broker: AedesBroker,
  port: number,
): Promise<{ httpServer: HttpServer; wsPort: number }> {
  const httpServer = createHttpServer();
  // The MQTT-over-WS spec requires the WebSocket subprotocol "mqtt"
  // (or legacy "mqttv3.1"); browsers send it in the handshake. Without
  // acknowledging it some clients refuse the connection, so we explicitly
  // select whichever the client offered.
  const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: (protocols) => {
      for (const p of protocols) if (p === 'mqtt' || p === 'mqttv3.1') return p;
      return false;
    },
  });
  wss.on('connection', (ws) => {
    const stream = createWebSocketStream(ws, { allowHalfOpen: false });
    broker.handle(stream);
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return { httpServer, wsPort: actualPort };
}

function closeBroker(broker: AedesBroker): Promise<void> {
  return new Promise((resolve) => {
    broker.close(() => resolve());
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
