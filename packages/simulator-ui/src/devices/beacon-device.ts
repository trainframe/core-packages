/**
 * A tiny, transport-agnostic example controller — the portability proof's device
 * under test (ADR-031). It does the three things every device does over its
 * platform link and NOTHING transport-specific:
 *
 *   - on `start()` it `register`s its manifest and subscribes to commands;
 *   - it `publish`es a `tag_observed` event when it "sees" a tag (`sight`);
 *   - it records the `command_type`s its core sends it.
 *
 * It imports ONLY the `PlatformProvider` interface — never a broker, never an
 * MQTT adapter, never the string 'mqtt'. WHICH backing it runs over is the
 * composition root's choice. That is the entire point: the SAME instance runs
 * unchanged over the in-process bus and over the edge MQTT adapter, and the
 * portability test proves identical observable behaviour by wiring each in turn.
 */
import type { DeviceManifest } from '@trainframe/protocol';
import { PROTOCOL_VERSION } from '@trainframe/protocol';
import type { CommandHandler, PlatformProvider } from './platform-provider.js';

export class BeaconDevice {
  private readonly deviceId: string;
  private readonly platform: PlatformProvider;
  private unsubscribe: (() => void) | null = null;
  /** The command types this device's core has sent it, in order. */
  readonly received: string[] = [];

  constructor(deviceId: string, platform: PlatformProvider) {
    this.deviceId = deviceId;
    this.platform = platform;
  }

  private manifest(): DeviceManifest {
    return {
      manifest_version: '1.0',
      vendor: 'trainframe',
      device_kind: 'example.beacon',
      version: '1.0.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: 'Beacon',
      description: 'A transport-agnostic example device for the portability proof.',
      capabilities: ['core.reports_marker_traversal'],
    };
  }

  /** Announce to core and start listening for commands. */
  start(): void {
    this.platform.register(this.manifest());
    const onCommand: CommandHandler = (command) => {
      this.received.push(command.command_type);
    };
    this.unsubscribe = this.platform.onCommand(onCommand);
  }

  /** Report seeing a tag — a `tag_observed` event upward to core. */
  sight(tagId: string): void {
    this.platform.publish({
      event_id: '00000000-0000-4000-8000-000000000001',
      device_id: this.deviceId,
      timestamp_device: '1970-01-01T00:00:00.000Z',
      event_type: 'tag_observed',
      protocol_version: PROTOCOL_VERSION,
      payload: { tag_id: tagId },
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
