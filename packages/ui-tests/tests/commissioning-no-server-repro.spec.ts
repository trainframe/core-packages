import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { MqttBrokerClient } from '@trainframe/simulator';
import { Aedes } from 'aedes';
import { WebSocketServer, createWebSocketStream } from 'ws';
import {
  openSimulatorUi,
  openVisualiser,
  placePieceOnToyTable,
  scanPiece,
  waitForVisualiserConnected,
} from '../src/playwright-helpers.js';

/**
 * REPRODUCTION of the silent void (goal criteria 1 & 6, failing half).
 *
 * With a broker but NO `@trainframe/server`, a loco scanned on the toy table
 * publishes its `device_registered` EVENT onto the bus — but nothing turns that
 * event into the retained `railway/state/devices/*` STATE the visualiser reads,
 * so it never surfaces in the Commission panel. This is exactly the experience
 * the old server-less dev setup gave. The companion `commissioning-toybox-live`
 * spec proves that adding a real server (as `pnpm dev:stack` does) fixes it.
 */

const WS_PORT = 9117;
const BROKER_WS = `ws://127.0.0.1:${WS_PORT}`;

let broker: Awaited<ReturnType<typeof Aedes.createBroker>>;
let httpServer: HttpServer;

test.describe
  .serial('NO server: a toybox scan vanishes into a silent void', () => {
    test.beforeAll(async () => {
      broker = await Aedes.createBroker();
      httpServer = createHttpServer();
      const wss = new WebSocketServer({
        server: httpServer,
        handleProtocols: (protocols) => {
          for (const p of protocols) if (p === 'mqtt' || p === 'mqttv3.1') return p;
          return false;
        },
      });
      wss.on('connection', (ws) =>
        broker.handle(createWebSocketStream(ws, { allowHalfOpen: false })),
      );
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(WS_PORT, '127.0.0.1', () => resolve());
      });
    });

    test.afterAll(async () => {
      // Force-close any lingering WS connections so close() doesn't hang.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    });

    test('the device_registered event reaches the broker, but the visualiser never shows it', async ({
      browser,
    }) => {
      test.setTimeout(120_000);

      // A bus listener proves the scan really happened (the event flew).
      const seenEvents: string[] = [];
      const bus = new MqttBrokerClient();
      bus.connect(BROKER_WS);
      bus.subscribe('railway/events/device_registered/+', (m) => {
        seenEvents.push(m.topic);
      });

      const sim = await openSimulatorUi(browser, { brokerUrl: BROKER_WS });
      await waitForVisualiserConnected(sim);
      const vis = await openVisualiser(browser, { brokerUrl: BROKER_WS });
      await waitForVisualiserConnected(vis);

      await placePieceOnToyTable(sim, { type: 'straight', xMm: 200, yMm: 200 });
      const trainPiece = await placePieceOnToyTable(sim, { type: 'train', xMm: 200, yMm: 200 });
      await scanPiece(sim, trainPiece);
      const deviceId = `T-${trainPiece}`;

      // The EVENT reached the bus — the scan genuinely happened.
      await expect
        .poll(() => seenEvents.some((t) => t.endsWith(deviceId)), { timeout: 10_000 })
        .toBe(true);

      // …but with no server to bridge event→state, it NEVER surfaces in the
      // visualiser Commission panel (give it a generous window to be sure).
      await vis.waitForTimeout(4000);
      await expect(vis.getByTestId(`commission-item-${deviceId}`)).toHaveCount(0);
      await expect(vis.getByTestId('commissioning-empty')).toBeVisible();

      bus.disconnect();
      // Close the manually-created contexts so their broker WS connections release
      // (else the broker teardown hangs on open sockets).
      await sim.context().close();
      await vis.context().close();
    });
  });
