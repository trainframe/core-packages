#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import type { Layout } from '@trainframe/protocol';
import { AdminHttpServer } from './admin-http.js';
import { MqttBrokerClient } from './broker/mqtt-client.js';
import { Server } from './server.js';

/**
 * Minimal CLI: load a layout JSON file, connect to a broker URL, run.
 *   tf-server --layout path/to/layout.json --broker mqtt://localhost:1883
 *
 * This is the production entry point. Operators wrap it in their own process
 * supervision (systemd, Docker, pm2, …). HTTP / admin API for assignSchedule and
 * other operator actions is a follow-up.
 */
async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.layout && !args.discovery) {
    stderr.write('Missing --layout <path> (or pass --discovery to start with an empty layout)\n');
    printUsage();
    exit(1);
  }
  const broker = args.broker ?? env.TRAINFRAME_BROKER ?? 'mqtt://localhost:1883';
  const layout: Layout = args.layout
    ? (JSON.parse(readFileSync(resolve(args.layout), 'utf8')) as Layout)
    : { name: args.discoveryName, markers: [], edges: [], junctions: [] };

  const client = new MqttBrokerClient();
  await client.connect(broker);
  const server = new Server({ layout, client });
  server.start();

  stdout.write(`tf-server: connected to ${broker}, layout '${layout.name}'\n`);

  let admin: AdminHttpServer | null = null;
  if (args.httpPort !== 0) {
    admin = new AdminHttpServer({ server });
    const port = await admin.listen(args.httpPort);
    stdout.write(`tf-server: admin HTTP API on http://127.0.0.1:${port}\n`);
  }

  const shutdown = async () => {
    await admin?.close();
    server.stop();
    await client.disconnect();
    exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

interface CliArgs {
  layout: string | undefined;
  discovery: boolean;
  discoveryName: string;
  broker: string | undefined;
  httpPort: number;
  help: boolean;
}

const FLAG_HANDLERS: Record<string, (args: CliArgs, take: () => string | undefined) => void> = {
  '--help': (args) => {
    args.help = true;
  },
  '-h': (args) => {
    args.help = true;
  },
  '--layout': (args, take) => {
    args.layout = take();
  },
  '--discovery': (args) => {
    args.discovery = true;
  },
  '--discovery-name': (args, take) => {
    const next = take();
    if (next !== undefined) args.discoveryName = next;
  },
  '--broker': (args, take) => {
    args.broker = take();
  },
  '--http-port': (args, take) => {
    const next = take();
    if (next !== undefined) args.httpPort = Number.parseInt(next, 10);
  },
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    layout: undefined,
    discovery: false,
    discoveryName: 'discovery',
    broker: undefined,
    httpPort: 3000,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === undefined) continue;
    const handler = FLAG_HANDLERS[flag];
    if (handler === undefined) continue;
    handler(args, () => argv[++i]);
  }
  return args;
}

function printUsage(): void {
  stdout.write(
    'Usage: tf-server [--layout <path-to-layout.json> | --discovery] [--broker mqtt://host:1883] [--http-port 3000]\n' +
      '  --discovery starts with an empty layout; markers and edges are inferred from incoming wire events.\n' +
      '  --discovery-name names the empty layout (default "discovery").\n' +
      '  --broker can also be set via TRAINFRAME_BROKER env var.\n' +
      '  --http-port 0 disables the admin HTTP API (default 3000).\n',
  );
}

main().catch((error: unknown) => {
  stderr.write(`tf-server: ${(error as Error).message}\n`);
  exit(1);
});
