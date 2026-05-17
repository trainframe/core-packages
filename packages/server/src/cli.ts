#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';
import type { Layout } from '@trainframe/protocol';
import { MqttBrokerClient } from './broker/mqtt-client.js';
import { Server } from './server.js';

/**
 * Minimal CLI: load a layout JSON file, connect to a broker URL, run.
 *   tf-server --layout path/to/layout.json --broker mqtt://localhost:1883
 *
 * This is the production entry point. Operators wrap it in their own process
 * supervision (systemd, Docker, pm2, …). HTTP / admin API for assignRoute and
 * other operator actions is a follow-up.
 */
async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }
  if (!args.layout) {
    stderr.write('Missing --layout <path>\n');
    printUsage();
    exit(1);
  }
  const broker = args.broker ?? env.TRAINFRAME_BROKER ?? 'mqtt://localhost:1883';
  const layoutPath = resolve(args.layout);
  const layout = JSON.parse(readFileSync(layoutPath, 'utf8')) as Layout;

  const client = new MqttBrokerClient();
  await client.connect(broker);
  const server = new Server({ layout, client });
  server.start();

  stdout.write(`tf-server: connected to ${broker}, layout '${layout.name}'\n`);

  const shutdown = async () => {
    server.stop();
    await client.disconnect();
    exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

interface CliArgs {
  layout: string | undefined;
  broker: string | undefined;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, layout: undefined, broker: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--layout') args.layout = argv[++i];
    else if (a === '--broker') args.broker = argv[++i];
  }
  return args;
}

function printUsage(): void {
  stdout.write(
    'Usage: tf-server --layout <path-to-layout.json> [--broker mqtt://host:1883]\n' +
      '  --broker can also be set via TRAINFRAME_BROKER env var.\n',
  );
}

main().catch((error: unknown) => {
  stderr.write(`tf-server: ${(error as Error).message}\n`);
  exit(1);
});
