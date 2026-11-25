import type { CoreCommand, CoreEvent } from '@trainframe/protocol';
import type {
  CommandHandler,
  CommissionSpec,
  PlatformProvider,
} from '../devices/platform-provider.js';
import { buildCoreCommand } from '../envelope.js';
import type { EspNowLink, PeerId } from './espnow-link.js';

/**
 * The ESP-NOW `PlatformProvider` backing (ADR-035 Phase 2) — the fourth backing
 * of the ADR-031 seam, the one that PAIRS before it can register. A device
 * imports only `PlatformProvider`; all the announce → discover → associate →
 * register handshake hides here, exactly as the MQTT backing hides MQTT.
 *
 * Lifecycle (driven by `commission`, the seam `registerDevice` calls for a
 * pairing backing):
 *   1. broadcast `announce{hwId, deviceKind}` (address-less — the device knows
 *      no one yet);
 *   2. on `discovered{deviceRef, deviceId}` from the bridge — learn the
 *      bridge's address + the bridge-assigned id, so events can flow up and
 *      commands down;
 *   3. on `associate{tagId}` — the device's marker has arrived; build the
 *      `device_registered` event with it (late-bound identity) and send it up;
 *   4. `command` frames are reconstructed into `CoreCommand`s for the handler.
 *
 * In-memory model: frames are JSON (a physical device speaks TCF, ADR-021). The
 * associated `tagId` is used directly as the device's marker, matching the
 * existing "marker ids as tag ids" simplification (CLAUDE.md open question).
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type DownFrame =
  | { readonly kind: 'discovered'; readonly deviceRef: string; readonly deviceId: string }
  | { readonly kind: 'associate'; readonly tagId: string }
  | { readonly kind: 'command'; readonly commandType: string; readonly payload: unknown };

export interface EspNowPlatformOptions {
  /** A marker this device remembered from a previous pairing (ADR-035): on
   *  reboot it re-announces and registers immediately on discovery, skipping the
   *  operator scan. Absent ⇒ a fresh, unpaired device that awaits association. */
  readonly persistedMarker?: string;
  /** Called when association resolves a marker, so the device can persist it for
   *  next boot (ideally non-volatile in real hardware). */
  readonly onPersist?: (markerId: string) => void;
}

export function espNowPlatform(
  link: EspNowLink,
  options: EspNowPlatformOptions = {},
): PlatformProvider {
  let bridgeId: PeerId | undefined; // learned from the discovered frame's sender
  let deviceId: string | undefined; // bridge-assigned id
  let commandHandler: CommandHandler | undefined;
  let buildRegistered: ((markerId: string | undefined) => CoreEvent) | undefined;
  let deviceKind = 'unknown';
  let registered = false; // guard against double-registering (discovered + associate)
  const queued: CoreEvent[] = []; // events published before the bridge ack lands

  const sendUp = (event: CoreEvent): void => {
    if (bridgeId === undefined) {
      queued.push(event);
      return;
    }
    link.sendTo(
      bridgeId,
      encoder.encode(
        JSON.stringify({ kind: 'event', eventType: event.event_type, payload: event.payload }),
      ),
    );
  };

  const onFrame = (from: PeerId, payload: Uint8Array): void => {
    let msg: DownFrame;
    try {
      msg = JSON.parse(decoder.decode(payload)) as DownFrame;
    } catch {
      return;
    }
    if (msg.kind === 'discovered') {
      bridgeId = from;
      deviceId = msg.deviceId;
      for (const e of queued.splice(0)) sendUp(e); // flush anything published pre-ack
      /* Reboot path: a device that already knows its marker registers right away,
         no operator scan needed. */
      if (options.persistedMarker !== undefined) registerWith(options.persistedMarker);
    } else if (msg.kind === 'associate') {
      /* Identity has arrived via the operator's scan — the late binding the
         constrained device couldn't do at construction. Persist it for next boot. */
      options.onPersist?.(msg.tagId);
      registerWith(msg.tagId);
    } else if (msg.kind === 'command' && commandHandler !== undefined) {
      deliverCommand(commandHandler, msg.commandType, msg.payload, deviceId);
    }
  };

  const registerWith = (markerId: string): void => {
    if (registered || buildRegistered === undefined) return; // idempotent
    registered = true;
    sendUp(buildRegistered(markerId));
  };

  const announce = (): void => {
    link.broadcast(encoder.encode(JSON.stringify({ kind: 'announce', hwId: link.id, deviceKind })));
  };

  return {
    register(manifest): void {
      deviceKind = manifest.device_kind;
      announce();
    },
    publish(event): void {
      sendUp(event);
    },
    onCommand(handler): () => void {
      commandHandler = handler;
      return () => {
        if (commandHandler === handler) commandHandler = undefined;
      };
    },
    commission(spec: CommissionSpec): () => void {
      deviceKind = spec.manifest.device_kind;
      buildRegistered = spec.buildRegisteredEvent;
      commandHandler = spec.onCommand;
      const off = link.onReceive((frame) => onFrame(frame.from, frame.payload));
      announce();
      return () => {
        off();
        commandHandler = undefined;
      };
    },
  };
}

/** Hand a relayed command frame to the device, unless it fails validation. */
function deliverCommand(
  handler: CommandHandler,
  commandType: string,
  payload: unknown,
  deviceId: string | undefined,
): void {
  const command = reconstructCommand(commandType, payload, deviceId);
  if (command !== undefined) handler(command);
}

/** Rebuild a `CoreCommand` envelope from a relayed command frame, so the device's
 *  existing `handle(command)` reads `command_type` + `payload` exactly as it would
 *  off the bus. A frame naming an unknown command type or carrying a payload that
 *  fails the protocol schema is dropped. */
function reconstructCommand(
  commandType: string,
  payload: unknown,
  deviceId: string | undefined,
): CoreCommand | undefined {
  return buildCoreCommand({
    command_id: 'espnow',
    device_id: deviceId ?? 'unknown',
    timestamp_server: new Date(0).toISOString(),
    command_type: commandType,
    payload,
  });
}
