import { PROTOCOL_VERSION, topics } from '@trainframe/protocol';
import type { BrokerClient } from './client.js';
import type { EspNowLink, PeerId } from './espnow-link.js';

/**
 * The pairing bridge (ADR-035 Phase 2). It is the ONLY component that knows the
 * constrained link: it relays between the ESP-NOW segment and the MQTT bus,
 * exactly the role ADR-003/021 reserve for the bridge. A device never talks to
 * the garage — it shouts onto the link and the bridge relays onto MQTT.
 *
 *   device → link → bridge → MQTT:
 *     - `announce`  → assign a `device_ref` + a stable `device_id`, publish
 *                     `device_discovered`, and unicast the ack back down;
 *     - `event`     → republish on `railway/events/{type}/{device_id}` tagged
 *                     with the device's bridge-assigned id (the spec's rule: a
 *                     bridge publishes on behalf of the ORIGINATING device).
 *   MQTT → bridge → link → device:
 *     - `device_association{device_ref, tag_id}` → relay the tag down so the
 *       device learns its marker and re-registers quoting it;
 *     - `railway/commands/{device_id}`           → relay the command down.
 *
 * In-memory model note: link frames are JSON here; a physical bridge speaks TCF
 * (ADR-021) and expands to the same JSON. The `device_ref` is modelled as the
 * device's hardware id; a real bridge assigns a uint32 handle (ADR-021 §5).
 */

type UpFrame =
  | { readonly kind: 'announce'; readonly hwId: string; readonly deviceKind: string }
  | { readonly kind: 'event'; readonly eventType: string; readonly payload: unknown };

type DownFrame =
  | { readonly kind: 'discovered'; readonly deviceRef: string; readonly deviceId: string }
  | { readonly kind: 'associate'; readonly tagId: string }
  | { readonly kind: 'command'; readonly commandType: string; readonly payload: unknown };

export interface PairingBridgeDeps {
  /** The bridge's own peer on the link. */
  readonly link: EspNowLink;
  /** The MQTT bus side. */
  readonly bus: BrokerClient;
  readonly newId: () => string;
  readonly now: () => string;
}

interface Paired {
  readonly hwId: PeerId;
  readonly deviceId: string;
  readonly offCommand: () => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class PairingBridge {
  private readonly byRef = new Map<string, Paired>();
  private readonly refByHw = new Map<PeerId, string>();
  private offLink: (() => void) | undefined;
  private offAssoc: (() => void) | undefined;

  constructor(private readonly d: PairingBridgeDeps) {}

  start(): void {
    this.offLink = this.d.link.onReceive((frame) => this.onFrame(frame.from, frame.payload));
    /* device_association is published per-device, so subscribe to the wildcard. */
    this.offAssoc = this.d.bus.subscribe(topics.event('device_association', '+'), (m) =>
      this.onAssociation(m.payload),
    );
  }

  stop(): void {
    this.offLink?.();
    this.offAssoc?.();
    for (const p of this.byRef.values()) p.offCommand();
    this.byRef.clear();
    this.refByHw.clear();
  }

  private send(hwId: PeerId, frame: DownFrame): void {
    this.d.link.sendTo(hwId, encoder.encode(JSON.stringify(frame)));
  }

  private publishEvent(eventType: string, deviceId: string, payload: unknown): void {
    this.d.bus.publish(
      topics.event(eventType, deviceId),
      encoder.encode(
        JSON.stringify({
          event_id: this.d.newId(),
          device_id: deviceId,
          timestamp_device: this.d.now(),
          event_type: eventType,
          protocol_version: PROTOCOL_VERSION,
          payload,
        }),
      ),
    );
  }

  private onFrame(from: PeerId, payload: Uint8Array): void {
    let msg: UpFrame;
    try {
      msg = JSON.parse(decoder.decode(payload)) as UpFrame;
    } catch {
      return; // garbled frame — drop
    }
    if (msg.kind === 'announce') this.onAnnounce(from, msg.deviceKind);
    else if (msg.kind === 'event')
      this.publishEvent(msg.eventType, this.deviceIdFor(from), msg.payload);
  }

  /** The bridge-assigned id for a paired hwId (falls back to a derived id if a
   *  device sends an event before its announce was seen — defensive). */
  private deviceIdFor(hwId: PeerId): string {
    return this.refByHw.get(hwId) !== undefined
      ? (this.byRef.get(this.refByHw.get(hwId) ?? '')?.deviceId ?? `DEV-${hwId}`)
      : `DEV-${hwId}`;
  }

  private onAnnounce(hwId: PeerId, deviceKind: string): void {
    let ref = this.refByHw.get(hwId);
    if (ref === undefined) {
      ref = hwId; // model: device_ref = the hardware id (a real bridge mints a uint32 handle)
      const deviceId = `DEV-${hwId}`;
      const offCommand = this.d.bus.subscribe(topics.command(deviceId), (m) =>
        this.relayCommand(hwId, m.payload),
      );
      this.byRef.set(ref, { hwId, deviceId, offCommand });
      this.refByHw.set(hwId, ref);
    }
    const paired = this.byRef.get(ref);
    if (paired === undefined) return;
    /* Relay the unpaired-device announce onto MQTT for the garage, and ack the
       device with its assigned ref + id so it can publish events + receive
       commands. (Re-announce of an already-known device is idempotent — same ref,
       fresh discovered/ack.) */
    this.publishEvent('device_discovered', paired.deviceId, {
      device_ref: ref,
      device_kind_hint: deviceKind,
    });
    this.send(hwId, { kind: 'discovered', deviceRef: ref, deviceId: paired.deviceId });
  }

  private onAssociation(payload: Uint8Array): void {
    let env: { payload?: { device_ref?: unknown; tag_id?: unknown } };
    try {
      env = JSON.parse(decoder.decode(payload)) as typeof env;
    } catch {
      return;
    }
    const ref = env.payload?.device_ref;
    const tagId = env.payload?.tag_id;
    if (typeof ref !== 'string' || typeof tagId !== 'string') return;
    const paired = this.byRef.get(ref);
    if (paired === undefined) return; // association for an unknown device — ignore
    this.send(paired.hwId, { kind: 'associate', tagId });
  }

  private relayCommand(hwId: PeerId, payload: Uint8Array): void {
    let env: { command_type?: unknown; payload?: unknown };
    try {
      env = JSON.parse(decoder.decode(payload)) as typeof env;
    } catch {
      return;
    }
    if (typeof env.command_type !== 'string') return;
    this.send(hwId, { kind: 'command', commandType: env.command_type, payload: env.payload });
  }
}
