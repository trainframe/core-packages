/**
 * A junction-switch device (FROZEN SPEC §3). It owns ONE main-line junction's
 * points: it declares `core.controls_switch` paired to the junction's marker, and
 * when the scheduler commands `set_switch_position` it throws the points through a
 * `SwitchActuator` and confirms back with `switch_state_changed{confirmed:true}`.
 *
 * Trains never resolve switches — the scheduler reads `requires_switch_state` on
 * the next route edge and commands the OWNING switch device, withholding the
 * train's clearance across the junction until this confirmation arrives. This
 * device is that owner for an ordinary main-line junction (the yard tap `Jloop`
 * is owned by the `YardZoneDevice` instead).
 *
 * The device↔core link is a `PlatformProvider` (ADR-031); the world link is a
 * `SwitchActuator` (ADR-030). DOM-free, deterministic.
 */
import {
  type CoreCommand,
  type CoreEvent,
  type DeviceManifest,
  PROTOCOL_VERSION,
  type SetSwitchPosition,
} from '@trainframe/protocol';
import { buildCoreEvent } from '../envelope.js';
import type { PlatformProvider } from './platform-provider.js';
import { registerDevice } from './registerable-device.js';
import type { SwitchActuator } from './switch-actuator.js';

export interface SwitchDeviceDeps {
  /** The device↔core link (mqtt in the gate/script, in-process in unit tests). */
  readonly platform: PlatformProvider;
  /** The world actuator that physically throws these points. */
  readonly actuator: SwitchActuator;
  /** The junction marker this device controls — the scheduler pairs the device to
   *  the junction by this id (`controls_marker_id` on `device_registered`).
   *  OPTIONAL: a switch on the constrained (ESP-NOW) path doesn't know its marker
   *  at construction — it arrives via `device_association` and is bound late
   *  (ADR-035). In-process/MQTT switches still pass it at construction. */
  readonly junctionMarkerId?: string;
  /** The valid positions for this junction (e.g. `['thru','branch']`). */
  readonly positions: readonly string[];
  /** Fresh envelope id source. The mqtt edge re-stamps
   *  the envelope anyway. */
  readonly newId: () => string;
  /** Current ISO-8601 timestamp source. */
  readonly now: () => string;
}

export class SwitchDevice {
  private readonly id: string;
  private readonly d: SwitchDeviceDeps;
  private readonly newId: () => string;
  private readonly now: () => string;
  private unsubscribe: (() => void) | undefined;
  /** The junction marker this switch is bound to — known at construction
   *  (in-process) or resolved late via association (ESP-NOW, ADR-035). */
  private resolvedMarker: string | undefined;

  constructor(deviceId: string, deps: SwitchDeviceDeps) {
    this.id = deviceId;
    this.d = deps;
    this.newId = deps.newId;
    this.now = deps.now;
    this.resolvedMarker = deps.junctionMarkerId;
  }

  get deviceId(): string {
    return this.id;
  }

  /** Register the manifest, announce the switch↔junction pairing, and listen for
   *  position commands. */
  start(): void {
    /* Pairing rides a `device_registered` event carrying `controls_marker_id` +
     *  `valid_positions` — the scheduler reads the pairing off those fields
     *  (`mqttPlatform.register` ships only capabilities + kind). */
    this.unsubscribe = registerDevice(this.d.platform, {
      manifest: this.manifest(),
      /* A builder: on the ESP-NOW path the marker arrives via association, so it's
         bound here when the seam supplies it; in-process passes `undefined` and we
         keep the construction-time marker. */
      registeredEvent: (markerId) => {
        if (markerId !== undefined) this.resolvedMarker = markerId;
        return this.registeredEvent();
      },
      onCommand: (command) => this.handle(command),
    });
  }

  /** Stop listening. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * Throw the points when the scheduler commands this junction. The protocol's
   * `CoreCommand` is NOT a TS discriminated union (its `command_type` is typed
   * `string`, not a literal), so the compiler cannot narrow on it directly. When
   * the runtime `command_type` is `set_switch_position` the wire contract
   * guarantees the matching payload shape, so the cast is sound — confined here,
   * named via the local, and commented. (`Value.Check` is unusable: its schema
   * demands UUID-format marker ids, which real layouts like `M-spur` are not.)
   */
  private handle(command: CoreCommand): void {
    if (command.command_type !== 'set_switch_position') return;
    const { junction_marker_id, position } = (command as SetSwitchPosition).payload;
    if (junction_marker_id !== this.resolvedMarker) return;
    if (!this.d.positions.includes(position)) return;
    this.d.actuator.set(position);
    this.d.platform.publish(this.confirmEvent(position));
  }

  private manifest(): DeviceManifest {
    return {
      manifest_version: '1.0',
      vendor: 'trainframe.sim',
      device_kind: 'mainline-switch',
      version: '0.1.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: `Switch ${this.id}`,
      description: `Main-line junction points at ${this.resolvedMarker ?? 'an unpaired junction'}.`,
      capabilities: ['core.controls_switch'],
    };
  }

  private registeredEvent(): CoreEvent {
    return this.envelope('device_registered', {
      capabilities: ['core.controls_switch'],
      device_kind_hint: 'mainline-switch',
      controls_marker_id: this.resolvedMarker,
      valid_positions: [...this.d.positions],
    });
  }

  private confirmEvent(position: string): CoreEvent {
    return this.envelope('switch_state_changed', {
      junction_marker_id: this.resolvedMarker,
      position,
      confirmed: true,
    });
  }

  /** Assemble a schema-validated `CoreEvent` envelope for this device. */
  private envelope(
    eventType: CoreEvent['event_type'],
    payload: Readonly<Record<string, unknown>>,
  ): CoreEvent {
    return buildCoreEvent({
      event_id: this.newId(),
      device_id: this.id,
      timestamp_device: this.now(),
      event_type: eventType,
      payload,
    });
  }
}
