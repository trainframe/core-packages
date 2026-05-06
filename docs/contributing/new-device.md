# Building a new device type

This guide walks you through creating a new device for the Smart Railway from scratch. By the end, you'll have a working device that runs against the simulator-hosted server with no changes to the core codebase.

The example device is a **panic button**: a physical button that, when pressed, withholds clearance everywhere on the layout until released. It's the simplest possible new device (one capability, one event) but the workflow is the same for arbitrarily complex ones.

## What you do not need to do

You do not need to fork the server. You do not need to open a PR. You do not need anyone's permission to publish your device.

The Smart Railway protocol is designed so that any device that speaks the protocol works with any compliant server. The capability system means your device's behaviour is described to the server *declaratively*, and the server adapts.

You only need to engage with the core project if (a) you want a new core capability added, or (b) you find a protocol bug. Everything else lives in your own repository.

## What you do need

- An MQTT broker accessible from your device (the dev server runs Mosquitto on `localhost:1883`)
- A way to send and receive MQTT messages (any MQTT client library, in any language)
- A device manifest describing what your device does
- Optionally: a visualiser plugin if you want custom rendering

## Step 1: Write the manifest

Create a file `manifest.json` describing your device. This is the contract between your device and the rest of the system.

```json
{
  "manifest_version": "1.0",
  "vendor": "com.yourname.panicbutton",
  "device_kind": "panic_button",
  "version": "0.1.0",
  "protocol_version": "0.2.0",
  "display_name": "Panic button",
  "description": "A big red button. Press to halt all clearance grants on the layout. Press again to release.",
  "capabilities": ["gates_clearance"],
  "configuration": [
    {
      "key": "gated_marker_ids",
      "type": "string",
      "description": "Comma-separated list of marker IDs to gate. If empty, gates all markers."
    }
  ],
  "display": {
    "icon": "octagon-alert",
    "colour": "#cc0000"
  }
}
```

The vendor field uses reverse-DNS namespacing to avoid collisions with other community devices.

## Step 2: Implement the device

The device's job is simple:

1. On startup, connect to the broker and publish a `device_registered` event including the manifest contents.
2. Subscribe to `railway/commands/{device_id}` for any commands.
3. When the button state changes, publish a `gate_state_changed` event for each marker the device is gating.

Here's a TypeScript implementation that runs on a Raspberry Pi or any Node-capable host:

```typescript
import mqtt from 'mqtt';
import { randomUUID } from 'node:crypto';
import { Gpio } from 'onoff';
import manifest from './manifest.json';

const DEVICE_ID = process.env.DEVICE_ID ?? randomUUID();
const BROKER = process.env.BROKER ?? 'mqtt://localhost:1883';
const GATED_MARKERS = (process.env.GATED_MARKER_IDS ?? '').split(',').filter(Boolean);

const client = mqtt.connect(BROKER, {
  clientId: `panicbutton-${DEVICE_ID}`,
  clean: true,
});

const button = new Gpio(17, 'in', 'both', { debounceTimeout: 50 });
let withholding = false;

function publish(eventType: string, payload: object) {
  const envelope = {
    event_id: randomUUID(),
    device_id: DEVICE_ID,
    timestamp_device: new Date().toISOString(),
    event_type: eventType,
    protocol_version: '0.2.0',
    payload,
  };
  client.publish(`railway/events/${eventType}/${DEVICE_ID}`, JSON.stringify(envelope), {
    qos: 1,
  });
}

function publishGateState(state: 'granting' | 'withholding') {
  for (const markerId of GATED_MARKERS) {
    publish('gate_state_changed', {
      marker_id: markerId,
      state,
      reason: state === 'withholding' ? 'panic button pressed' : 'panic button released',
    });
  }
}

client.on('connect', () => {
  publish('device_registered', {
    capabilities: manifest.capabilities,
    device_kind_hint: manifest.device_kind,
    display_hint: manifest.display,
    metadata: { manifest_version: manifest.version },
  });
  // Default to granting; explicit so the server has a known state.
  publishGateState('granting');

  client.subscribe(`railway/commands/${DEVICE_ID}`);
});

client.on('message', (topic, message) => {
  // No commands handled in v0.1; subscribed for future extension.
});

button.watch((err, value) => {
  if (err) return;
  withholding = value === 1;
  publishGateState(withholding ? 'withholding' : 'granting');
});

process.on('SIGINT', () => {
  button.unexport();
  client.end();
  process.exit(0);
});
```

That's the entire device. ~50 lines, all behaviour explicit, no framework magic.

## Step 3: Test against the simulator

Before connecting your physical button to anything, test against the simulator:

```bash
# In one terminal: start the broker, server, and simulator
pnpm dev

# In another: run your device with no GPIO, simulating button presses via stdin
DEVICE_ID=test-panic-1 BROKER=mqtt://localhost:1883 \
  pnpm tsx packages/devices/panicbutton/src/dev-harness.ts
```

The `dev-harness.ts` you write alongside the production device strips out the GPIO and reads `press`/`release` lines from stdin. Same MQTT logic, fake input. Exactly the pattern that makes the simulator-first approach work.

In the visualiser (open `http://localhost:3000`), you should see your device appear in the device list with the icon and colour from your manifest. Spawn a virtual train, give it a route, press your button: the train should stop at its current clearance limit. Release the button: it should proceed.

If the visualiser shows the device but the train doesn't respond to gate state, double-check: are the marker IDs in `GATED_MARKER_IDS` actually markers on the train's route? The gate only affects clearance at markers it's configured for.

## Step 4: Write integration tests

Your device's tests live in your repository, not the core. Use the same simulator the core project uses (it's published as `@smartrailway/simulator`):

```typescript
import { startTestEnvironment } from '@smartrailway/simulator/testing';

describe('panic button', () => {
  it('halts a moving train when pressed', async () => {
    const env = await startTestEnvironment({ layout: 'fixtures/simple-loop.json' });
    const train = await env.spawnTrain('T1');
    const button = await env.attachDevice('./manifest.json', './src/index.ts', {
      env: { GATED_MARKER_IDS: 'M1,M2,M3,M4' },
    });

    await env.assignRoute(train, env.layout.fullLoopRoute());
    await env.expectTrainMoving(train);

    await button.press();
    await env.expectTrainStopped(train, { withinMs: 2000 });

    await button.release();
    await env.expectTrainMoving(train, { withinMs: 1000 });

    await env.shutdown();
  });
});
```

The test environment runs a real broker (in-process), a real server, the real simulator, and your real device. No mocks. If this passes, your device works.

## Step 5: Publish

Push your repository. Add the manifest URL to the [community device registry](#) (when it exists; for now, just include it in your README). Other people can clone your repo and run your device against their own railways.

If you want to share your device as a turnkey thing (firmware image, precompiled binary), that's up to you. The protocol doesn't care.

## Adding custom events

If your device emits events beyond the core protocol (say, the panic button also reports how many times it's been pressed), declare them in the manifest:

```json
"custom_events": [
  {
    "event_type": "press_counter",
    "description": "Cumulative count of button presses since startup.",
    "schema": {
      "type": "object",
      "properties": {
        "count": { "type": "integer", "minimum": 0 }
      },
      "required": ["count"]
    }
  }
]
```

Publish them on the namespaced topic:

```typescript
client.publish(
  `railway/events/custom/com.yourname.panicbutton/press_counter/${DEVICE_ID}`,
  JSON.stringify(envelope),
  { qos: 1 },
);
```

The core server ignores custom events for scheduling. Other devices and the visualiser can subscribe to them. If another device wants to react to your event, they subscribe to the topic and process it themselves; the protocol never required the core server to be the orchestrator of every interaction.

## Adding custom rendering in the visualiser

The default visualiser renders devices using the icon and colour in the manifest. If you want richer rendering (animated, interactive, contextual), the visualiser supports plugins. See [visualiser-plugins.md](#) (TODO).

For most devices, the manifest's display hints are enough.

## What if I need a new core capability?

If you're building something that doesn't fit the existing capabilities (say, a device that needs to influence route *planning*, not just clearance), that's a core protocol change and does need a PR.

The bar for a new core capability is high: it has to be general (multiple devices want it), it has to fit the existing conceptual model, and someone has to update the scheduler to handle it. Most "I need a new capability" requests turn out to be expressible with `gates_clearance` plus custom events.

If you're sure you need one, open an issue first describing the use case. We'll work through whether it fits.

## Common pitfalls

**Forgetting QoS 1.** Default QoS is 0 (fire-and-forget). Critical events (`gate_state_changed`, `clearance_request`) should be QoS 1 so they're not silently dropped on a flaky link.

**Not handling reconnection.** MQTT clients reconnect automatically, but you need to re-publish your `device_registered` event on reconnect; otherwise the server thinks you've disappeared. The MQTT `clean: true` flag plus republishing on the `connect` event handles this.

**Sending events before registering.** If you publish a `gate_state_changed` before the server has seen your `device_registered`, the server doesn't know what to do with it. Always register first, wait for confirmation (the server publishes `railway/state/devices/{device_id}` as a retained message), then start emitting other events.

**Tagging events with the wrong device_id.** A bridge publishing on behalf of a constrained device must use the *originating* device's ID, not its own. Otherwise the visualiser shows everything as coming from the bridge.
