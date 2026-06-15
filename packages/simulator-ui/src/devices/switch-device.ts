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
import type { PlatformProvider } from './platform-provider.js';
import type { SwitchActuator } from './switch-actuator.js';

export interface SwitchDeviceDeps {
  /** The device↔core link (mqtt in the gate/script, in-process in unit tests). */
  readonly platform: PlatformProvider;
  /** The world actuator that physically throws these points. */
  readonly actuator: SwitchActuator;
  /** The junction marker this device controls — the scheduler pairs the device to
   *  the junction by this id (`controls_marker_id` on `device_registered`). */
  readonly junctionMarkerId: string;
  /** The valid positions for this junction (e.g. `['thru','branch']`). */
  readonly positions: readonly string[];
  /** Fresh envelope id source. Defaults to `crypto.randomUUID`. The mqtt edge
   *  re-stamps the envelope anyway; injectable for deterministic tests. */
  readonly newId?: () => string;
  /** Current ISO-8601 timestamp source. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

export class SwitchDevice {
  private readonly id: string;
  private readonly d: SwitchDeviceDeps;
  private readonly newId: () => string;
  private readonly now: () => string;
  private unsubscribe: (() => void) | undefined;

  constructor(deviceId: string, deps: SwitchDeviceDeps) {
    this.id = deviceId;
    this.d = deps;
    this.newId = deps.newId ?? defaultNewId;
    this.now = deps.now ?? defaultNow;
  }

  get deviceId(): string {
    return this.id;
  }

  /** Register the manifest, announce the switch↔junction pairing, and listen for
   *  position commands. */
  start(): void {
    this.d.platform.register(this.manifest());
    /* Pairing rides a `device_registered` event carrying `controls_marker_id` —
     *  the scheduler reads the pairing off that field (mirrors how a train's
     *  length reaches the scheduler; `mqttPlatform.register` ships only
     *  capabilities + kind). */
    this.d.platform.publish(this.registeredEvent());
    this.unsubscribe = this.d.platform.onCommand((command) => this.handle(command));
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
    if (junction_marker_id !== this.d.junctionMarkerId) return;
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
      description: `Main-line junction points at ${this.d.junctionMarkerId}.`,
      capabilities: ['core.controls_switch'],
    };
  }

  private registeredEvent(): CoreEvent {
    return this.envelope('device_registered', {
      capabilities: ['core.controls_switch'],
      device_kind_hint: 'mainline-switch',
      controls_marker_id: this.d.junctionMarkerId,
    });
  }

  private confirmEvent(position: string): CoreEvent {
    return this.envelope('switch_state_changed', {
      junction_marker_id: this.d.junctionMarkerId,
      position,
      confirmed: true,
    });
  }

  /**
   * Build a `CoreEvent` envelope. THE single sound coercion point in this file:
   * the `device_registered` payload carries an extra `controls_marker_id` field
   * the protocol schema models loosely (the scheduler reads it off the payload;
   * the TypeBox object is open, so it survives validation on the wire). We type
   * `payload` as the open record it really is and coerce the assembled envelope
   * to the `CoreEvent` union once, here, rather than sprinkling casts. The
   * `event_type` is constrained to the union's literals, so the discriminant is
   * always valid.
   */
  private envelope(
    eventType: CoreEvent['event_type'],
    payload: Readonly<Record<string, unknown>>,
  ): CoreEvent {
    const env = {
      event_id: this.newId(),
      device_id: this.id,
      timestamp_device: this.now(),
      event_type: eventType,
      protocol_version: PROTOCOL_VERSION,
      payload,
    };
    return env as unknown as CoreEvent;
  }
}

function defaultNewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}`;
}

function defaultNow(): string {
  return new Date().toISOString();
}
