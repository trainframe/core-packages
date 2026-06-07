// @ts-check
/**
 * Bridge-demo DEMO RUNNER.
 *
 * Boots a real `@trainframe/server` (the production scheduler) against the LOCAL
 * broker the toy-table is already connected to (mosquitto: tcp 1883 / ws 9001),
 * loads the UNIFIED FLYOVER layout, waits for both trains and the diverge
 * junction's switch device to appear on the wire, then assigns each train a
 * schedule. The scheduler then AUTONOMOUSLY throws J1 to 'divert' for train A
 * (over the bridge to the upper station) and 'main' for train B (along the
 * ground), and DWELLS at each scheduled stop.
 *
 * This is the server half of the live demo. The other half is the in-browser
 * toy-table: seed it with `window.__tfLoadBridgeDemo()` (DEV build) so it spawns
 * the LENGTH-AWARE virtual trains and the switch motor on the same broker. The
 * server here supplies scheduling; the toy-table supplies device physics —
 * exactly the production split (ADR-013).
 *
 *   RUN (after the broker is up and the toy-table page has loaded the demo).
 *   Use the repo-root `tsx` (a dev-dependency) so the simulator-ui TypeScript
 *   sources — buildBridgeDemo / compileLayout — import directly, and run it from
 *   the ui-tests package so `@trainframe/server` resolves:
 *
 *     pnpm --filter @trainframe/ui-tests exec tsx scripts/bridge-demo-server.mjs
 *
 *   It connects to mqtt://localhost:1883 by default. Override with:
 *     pnpm --filter @trainframe/ui-tests exec tsx scripts/bridge-demo-server.mjs --broker ws://localhost:9001
 *     TRAINFRAME_BROKER=ws://localhost:9001 pnpm --filter @trainframe/ui-tests exec tsx scripts/bridge-demo-server.mjs
 */

import process from 'node:process';
import { MqttBrokerClient, Server } from '@trainframe/server';
import { buildBridgeDemo } from '../../simulator-ui/src/demo/bridge-demo.ts';
import { compileLayout } from '../../simulator-ui/src/track/layout-from-pieces.ts';

function parseBroker() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--broker');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.env.TRAINFRAME_BROKER ?? 'mqtt://localhost:1883';
}

/** @param {string} msg */
function log(msg) {
  process.stdout.write(`[bridge-demo] ${msg}\n`);
}

async function main() {
  const brokerUrl = parseBroker();
  const demo = buildBridgeDemo();
  const layout = compileLayout(demo.pieces, 'bridge-demo');

  // Device ids we wait for before scheduling. The junction's switch motor is
  // spawned by the toy-table's ToyHardware as `SWITCH-{junctionPieceId}`; the
  // diverge junction marker id is `M-{pieceId}`, so strip the `M-` prefix.
  const junctionPieceId = demo.junctionId.replace(/^M-/, '');
  const switchDeviceId = `SWITCH-${junctionPieceId}`;
  const required = new Set([demo.trainAId, demo.trainBId, switchDeviceId]);

  const [groundA, groundB] = demo.groundStations;
  if (groundA === undefined || groundB === undefined) {
    throw new Error('bridge-demo: expected two ground stations');
  }

  log(
    `layout '${layout.name}': ${layout.markers.length} markers, ${layout.edges.length} edges, ${layout.junctions.length} junction(s)`,
  );
  log(`ground stations: ${groundA}, ${groundB}; upper station: ${demo.upperStation}`);
  log(`diverge junction: ${demo.junctionId} (switch device ${switchDeviceId})`);

  const serverClient = new MqttBrokerClient();
  await serverClient.connect(brokerUrl);
  const server = new Server({ layout, client: serverClient });
  server.start();
  log(`server connected to ${brokerUrl} and publishing retained layout`);

  // A SEPARATE observer client watches device registrations so we only assign
  // schedules once the trains and switch are actually on the bus. (The Server
  // owns its own subscription; we don't reach into it.)
  const watchClient = new MqttBrokerClient();
  await watchClient.connect(brokerUrl);

  const seen = new Set();
  let scheduled = false;

  function assignSchedules() {
    if (scheduled) return;
    scheduled = true;
    // Train A: ground A -> UPPER station (forces J1 to 'divert', up the bridge)
    // -> ground B. stops[0] must equal the marker the train physically sits on
    // (the scheduler treats the first stop as the spawn marker before the train
    // has moved). The scheduler throws J1 autonomously when A reaches it.
    log(
      `assigning schedule rA to ${demo.trainAId}: [${groundA}, ${demo.upperStation}, ${groundB}]`,
    );
    server.assignSchedule(demo.trainAId, 'rA', [groundA, demo.upperStation, groundB]);
    // Train B: stays on the ground loop. The `rt-u0` waypoint forces B around the
    // return chain in the SAME rotational direction as A (out via the J2 side),
    // rather than the shortest head-on path that would meet A nose-to-nose on the
    // single-track return chain and deadlock under block exclusivity. Continuous
    // collision-free two-train circulation on a single-track shared section still
    // needs same-direction tuning / live spacing — see the report caveat; this
    // schedule lets A throw the switch and climb the bridge while B circulates.
    const bWaypoint = 'M-rt-u0';
    log(`assigning schedule rB to ${demo.trainBId}: [${groundB}, ${bWaypoint}, ${groundA}]`);
    server.assignSchedule(demo.trainBId, 'rB', [groundB, bWaypoint, groundA]);
    log(
      'schedules assigned — A throws J1 to divert and climbs the bridge; B circulates the ground loop.',
    );
  }

  const unsub = watchClient.subscribe('railway/events/device_registered/+', (msg) => {
    const deviceId = msg.topic.split('/').pop();
    if (deviceId === undefined || deviceId === 'server') return;
    if (!required.has(deviceId) || seen.has(deviceId)) return;
    seen.add(deviceId);
    log(`device registered: ${deviceId} (${seen.size}/${required.size} required)`);
    if (seen.size === required.size) {
      // Tiny delay so the device's initial tag_observed (placing it at its start
      // marker) is processed by the server's scheduler before we plan.
      setTimeout(assignSchedules, 250);
    }
  });

  log('waiting for both trains + the switch device to register...');
  log('(seed the toy-table with window.__tfLoadBridgeDemo() if you have not yet)');

  const shutdown = async () => {
    unsub();
    server.stop();
    await watchClient.disconnect();
    await serverClient.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(
    `[bridge-demo] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
