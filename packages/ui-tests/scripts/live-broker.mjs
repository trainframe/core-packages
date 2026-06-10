import { createServer as createHttpServer } from 'node:http';
// @ts-check
/**
 * Standalone MQTT broker for live driving: aedes over TCP (1883, for the
 * @trainframe/server) AND over WebSockets (9001, for the browser UIs). Mirrors
 * the test harness's broker so the live stack matches what the specs exercise,
 * without needing Mosquitto/podman.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/live-broker.mjs
 */
import { createServer as createTcpServer } from 'node:net';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

const broker = await Aedes.createBroker();

const tcp = createTcpServer((stream) => broker.handle(stream));
tcp.listen(1883, '127.0.0.1', () => console.log('broker TCP on 1883'));

const http = createHttpServer();
const wss = new WebSocketServer({
  server: http,
  handleProtocols: (protocols) => {
    for (const p of protocols) if (p === 'mqtt' || p === 'mqttv3.1') return p;
    return false;
  },
});
wss.on('connection', (ws) => broker.handle(createWebSocketStream(ws, { allowHalfOpen: false })));
http.listen(9001, '127.0.0.1', () => console.log('broker WS on 9001'));

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
