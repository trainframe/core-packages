// @ts-check
/**
 * Railyard-demo DEMO RUNNER.
 *
 * Boots a real `@trainframe/server` (the production scheduler) against the LOCAL
 * broker the toy-table is connected to (tcp 1883 / ws 9001), loads the railyard
 * spectacle layout (one oval with the pass-through yard on its bottom run),
 * waits for all the trains AND the yard's zone device to appear on the wire,
 * then assigns each train a CYCLIC schedule that calls at the yard throat.
 *
 * The scheduler then runs autonomously: each train circulates, pulls into the
 * yard as its route terminus, is suspended (ADR-027), swapped by the yard, and
 * released to resume its loop (ADR-028) — no per-lap reassignment. Coloured
 * carriages migrate train→train over the laps. Concurrent trains queue through
 * the single-marker zone without deadlock (proven in
 * packages/integration/railyard-swap-concurrent.test.ts).
 *
 * This is the server half. The other half is the in-browser toy-table: seed it
 * with `window.__tfLoadRailyardDemo()` (DEV build) so it spawns the virtual
 * trains, carriages, and the yard zone device on the same broker.
 *
 *   RUN (after the broker is up and the toy-table page has loaded the demo):
 *     pnpm --filter @trainframe/ui-tests exec tsx scripts/railyard-demo-server.mjs
 *
 *   Connects to mqtt://localhost:1883 by default. Override with --broker or
 *   TRAINFRAME_BROKER (e.g. ws://localhost:9001).
 */

import process from 'node:process';
import { MqttBrokerClient, Server } from '@trainframe/server';
import { buildRailyardDemo } from '@trainframe/simulator/demo/railyard-demo.js';
import { compileLayout } from '../../simulator-ui/src/track/layout-from-pieces.ts';

function parseBroker() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--broker');
  if (i !== -1 && argv[i + 1]) return argv[i + 1];
  return process.env.TRAINFRAME_BROKER ?? 'mqtt://localhost:1883';
}

/** @param {string} msg */
function log(msg) {
  process.stdout.write(`[railyard-demo] ${msg}\n`);
}

async function main() {
  const brokerUrl = parseBroker();
  const demo = buildRailyardDemo();
  const layout = compileLayout(demo.pieces, 'railyard-demo');

  // Wait for every train, the yard zone device, AND the junction switch devices
  // before scheduling — the scheduler can only throw J1 to divert once its
  // SWITCH-J1 motor has registered (otherwise a yard-bound train stalls at the
  // junction waiting for a switch nobody can actuate).
  const required = new Set([
    demo.yardDeviceId,
    ...demo.switchDeviceIds,
    ...demo.trains.map((t) => t.deviceId),
  ]);

  log(`layout '${layout.name}': ${layout.markers.length} markers, ${layout.edges.length} edges`);
  log(
    `yard zone: ${demo.yardDeviceId} (throat ${demo.yardMarker}); switches: ${demo.switchDeviceIds.join(', ')}`,
  );
  for (const t of demo.trains) log(`train ${t.deviceId}: stops [${t.stops.join(', ')}]`);

  const serverClient = new MqttBrokerClient();
  await serverClient.connect(brokerUrl);
  const server = new Server({ layout, client: serverClient });
  server.start();
  log(`server connected to ${brokerUrl} and publishing retained layout`);

  const watchClient = new MqttBrokerClient();
  await watchClient.connect(brokerUrl);

  const seen = new Set();
  const trainIds = new Set(demo.trains.map((t) => t.deviceId));
  // Trains that have reported a HEADING (a `train_status` carrying `current_edge`).
  // We only plan once every train has declared which way it faces — otherwise the
  // scheduler would plan from a standstill with no heading and pick a shortest
  // path that may point the train the wrong way round the loop. Waiting for the
  // device's own report (not a timer) makes the one-way circulation reliable.
  const facing = new Set();
  let scheduled = false;

  function assignSchedules() {
    if (scheduled) return;
    if (seen.size !== required.size) return;
    if (![...trainIds].every((id) => facing.has(id))) return;
    scheduled = true;
    for (const t of demo.trains) {
      log(`assigning ${t.deviceId}: [${t.stops.join(', ')}]`);
      server.assignSchedule(t.deviceId, `${t.deviceId}-loop`, t.stops);
    }
    log('schedules assigned — trains circulate and call at the yard each lap.');
  }

  const unsubReg = watchClient.subscribe('railway/events/device_registered/+', (msg) => {
    const deviceId = msg.topic.split('/').pop();
    if (deviceId === undefined || deviceId === 'server') return;
    if (!required.has(deviceId) || seen.has(deviceId)) return;
    seen.add(deviceId);
    log(`device registered: ${deviceId} (${seen.size}/${required.size} required)`);
    assignSchedules();
  });

  const unsubStatus = watchClient.subscribe('railway/events/train_status/+', (msg) => {
    const deviceId = msg.topic.split('/').pop();
    if (deviceId === undefined || !trainIds.has(deviceId) || facing.has(deviceId)) return;
    // The wire body is the JSON event envelope; the heading lives at
    // `payload.current_edge`. Tolerate any decode/parse hiccup silently.
    let edge;
    try {
      edge = JSON.parse(new TextDecoder().decode(msg.payload))?.payload?.current_edge;
    } catch {
      return;
    }
    if (edge === undefined) return;
    facing.add(deviceId);
    log(
      `heading reported: ${deviceId} on ${edge.from_marker_id}->${edge.to_marker_id} (${facing.size}/${trainIds.size} trains)`,
    );
    assignSchedules();
  });

  log('waiting for the trains + yard zone device to register AND declare a heading...');
  log('(seed the toy-table with window.__tfLoadRailyardDemo() if you have not yet)');

  const shutdown = async () => {
    unsubReg();
    unsubStatus();
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
    `[railyard-demo] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
