import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient, Server as TrainframeServer } from '@trainframe/server';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

type AedesBroker = Awaited<ReturnType<typeof Aedes.createBroker>>;

export interface UiHarness {
  readonly brokerWsUrl: string;
  readonly server: TrainframeServer;
  shutdown(): Promise<void>;
}

export interface UiHarnessOptions {
  readonly layout: Layout;
  /** WebSocket port for the broker. Defaults to 9001 (matches the UI's default). */
  readonly wsPort?: number;
}

/**
 * Boots an aedes broker over WebSockets and runs a real @trainframe/server
 * against it. Used by Playwright tests so the in-browser simulator UI can
 * connect to a live broker without external infrastructure.
 */
export async function startUiHarness(opts: UiHarnessOptions): Promise<UiHarness> {
  const broker = await Aedes.createBroker();
  const { httpServer, wsPort } = await listenWebSocketBroker(broker, opts.wsPort ?? 9001);

  const serverClient = new MqttBrokerClient();
  await serverClient.connect(`ws://127.0.0.1:${wsPort}`);
  const server = new TrainframeServer({ layout: opts.layout, client: serverClient });
  server.start();

  return {
    brokerWsUrl: `ws://127.0.0.1:${wsPort}`,
    server,
    async shutdown() {
      server.stop();
      await serverClient.disconnect();
      await closeBroker(broker);
      await closeHttpServer(httpServer);
    },
  };
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
