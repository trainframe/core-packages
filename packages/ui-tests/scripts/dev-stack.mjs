// @ts-check
/**
 * Dev stack — broker + a REAL `@trainframe/server` + both UIs, in one command.
 *
 * The toy table publishes `device_registered` EVENTS; the visualiser reads the
 * retained `railway/state/devices/*` STATE. Only a real server bridges the two.
 * The old "simulator-ui + visualiser, no server" setup left a scan vanishing into
 * a silent void — this boots the server in the loop, so a loco scanned on the
 * table appears in the visualiser's Commission panel within ~a second.
 *
 *   pnpm dev:stack
 *
 * Brings up:
 *   - an in-process MQTT-over-WebSocket broker on ws://127.0.0.1:9001 (the UIs'
 *     default — no Mosquitto/container needed)
 *   - @trainframe/server in discovery mode + its admin HTTP API on :3000
 *   - the simulator-ui (toy table) on :5274 and the visualiser on :5273
 *
 * Ctrl-C tears the whole stack down.
 */
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { AdminHttpServer, MqttBrokerClient, Server } from '@trainframe/server';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';

const WS_PORT = 9001;
const ADMIN_PORT = 3000;
const SIM_PORT = 5274;
const VIS_PORT = 5273;
const BROKER_WS = `ws://127.0.0.1:${WS_PORT}`;

const log = (msg) => process.stdout.write(`[dev-stack] ${msg}\n`);

// 1. In-process MQTT-over-WebSocket broker (mirrors the ui-tests harness).
const broker = await Aedes.createBroker();
const httpServer = createHttpServer();
const wss = new WebSocketServer({
  server: httpServer,
  handleProtocols: (protocols) => {
    for (const p of protocols) if (p === 'mqtt' || p === 'mqttv3.1') return p;
    return false;
  },
});
wss.on('connection', (ws) => broker.handle(createWebSocketStream(ws, { allowHalfOpen: false })));
await new Promise((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(WS_PORT, '127.0.0.1', resolve);
});
log(`broker (MQTT/WS) up on ${BROKER_WS}`);

// 2. The REAL server (discovery mode) + admin HTTP — the event→state bridge.
const client = new MqttBrokerClient();
await client.connect(BROKER_WS);
const server = new Server({
  layout: { name: 'discovery', markers: [], edges: [], junctions: [] },
  client,
});
server.start();
// Admin HTTP is best-effort: device commissioning works purely over the broker
// (re-announce), so a busy :3000 must not sink the stack — only tag/route/gate
// admin calls need it.
let admin = null;
try {
  admin = new AdminHttpServer({ server });
  const adminPort = await admin.listen(ADMIN_PORT);
  log(`@trainframe/server (discovery) up; admin HTTP on http://127.0.0.1:${adminPort}`);
} catch (err) {
  admin = null;
  log(
    `@trainframe/server (discovery) up; admin HTTP unavailable (${String(err)}) — commissioning still works`,
  );
}

// 3. The two UIs (vite dev servers).
const vite = (filter, port) =>
  spawn('pnpm', ['--filter', filter, 'dev', '--port', String(port), '--strictPort'], {
    stdio: 'inherit',
  });
const children = [
  vite('@trainframe/simulator-ui', SIM_PORT),
  vite('@trainframe/visualiser', VIS_PORT),
];
log(`simulator-ui → http://localhost:${SIM_PORT}   visualiser → http://localhost:${VIS_PORT}`);
log(
  'Scan a loco on the toy table → it appears in the visualiser Commission panel. Ctrl-C to stop.',
);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log('shutting down…');
  for (const c of children) c.kill('SIGINT');
  admin?.close().catch(() => {});
  client.disconnect();
  httpServer.close();
  broker.close(() => process.exit(0));
  // Hard backstop if the broker won't close.
  setTimeout(() => process.exit(0), 2000);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
