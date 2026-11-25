import type { ClearanceConsultation, SchedulerIntent } from '../capability.js';
import type { CapabilityRegistry } from '../registry.js';
import { type SchedulerEffect, effects } from './effects.js';
import type { TrainState } from './train-state.js';

/**
 * Information about a connected device, tracked by the scheduler.
 */
export interface DeviceRecord {
  device_id: string;
  capabilities: ReadonlyArray<string>;
  /** Per-capability state: capability_id -> opaque state value. */
  capability_state: Map<string, unknown>;
  /** Operator-authored presentation fields from registration (0.12.0). */
  name?: string | undefined;
  livery?: string | undefined;
}

/**
 * The `device_registered` fields the scheduler consumes. The server validates
 * the envelope against the protocol schema before dispatch, so reading them
 * through this one typed view at the registration boundary is sound: a single
 * coercion point rather than ad-hoc casts along the registration path.
 */
export interface DeviceRegistrationView {
  readonly capabilities: string[];
  readonly train_length_mm?: number;
  readonly priority?: number;
  /** The junction marker a `core.controls_switch` device actuates (0.12.0). */
  readonly controls_marker_id?: string;
  /** The selectable switch positions a `core.controls_switch` device declares
   *  (0.13.0, ADR-035). Discovery materialises a junction with these legs. */
  readonly valid_positions?: string[];
  /** The interior markers a `core.gates_zone` device owns (ADR-034). */
  readonly owned_marker_ids?: unknown;
  /** Operator-authored presentation fields (0.12.0); echoed into retained state. */
  readonly name?: string;
  readonly livery?: string;
}

export function readRegistration(payload: unknown): DeviceRegistrationView {
  return (payload ?? {}) as DeviceRegistrationView;
}

/**
 * The connected devices, their declared capabilities and each capability's
 * opaque state. Capability hooks run only through here, so this is the one
 * place capability state changes.
 */
export class DeviceTable {
  private readonly devices = new Map<string, DeviceRecord>();

  constructor(private readonly registry: CapabilityRegistry) {}

  get(deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  /** True if the device is connected and declared `capabilityId`. */
  declares(deviceId: string, capabilityId: string): boolean {
    return this.devices.get(deviceId)?.capabilities.includes(capabilityId) ?? false;
  }

  capabilityState(deviceId: string, capabilityId: string): unknown {
    return this.devices.get(deviceId)?.capability_state.get(capabilityId);
  }

  /**
   * Record a registering device and initialise each capability's state.
   * Returns an anomaly instead, recording nothing, when the device declared a
   * capability the registry does not know.
   */
  register(deviceId: string, reg: DeviceRegistrationView): SchedulerEffect | undefined {
    const { capabilities } = reg;
    const unknownCaps = this.registry.validateDeviceCapabilities(capabilities);
    if (unknownCaps.length > 0) {
      return effects.publishEvent('anomaly', {
        severity: 'warning',
        description: `Device ${deviceId} declared unknown capabilities: ${unknownCaps.join(', ')}`,
      });
    }

    const capabilityState = new Map<string, unknown>();
    for (const capId of capabilities) {
      const cap = this.registry.get(capId);
      if (cap) {
        capabilityState.set(capId, cap.initialiseStateFor(deviceId));
      }
    }

    const deviceRecord: DeviceRecord = {
      device_id: deviceId,
      capabilities,
      capability_state: capabilityState,
    };
    if (reg.name !== undefined) deviceRecord.name = reg.name;
    if (reg.livery !== undefined) deviceRecord.livery = reg.livery;
    this.devices.set(deviceId, deviceRecord);
    return undefined;
  }

  /** Run each capability's disconnect hook for `device` and translate the intents. */
  runDisconnectHooks(device: DeviceRecord): SchedulerEffect[] {
    const out: SchedulerEffect[] = [];
    for (const capId of device.capabilities) {
      const cap = this.registry.get(capId);
      if (!cap) continue;
      const oldState = device.capability_state.get(capId);
      const result = cap.invokeOnDeviceDisconnect(oldState);
      device.capability_state.set(capId, result.newState);
      out.push(...translateIntents(result.intents, device.device_id));
    }
    return out;
  }

  /**
   * Hand an event the scheduler does not handle itself to each capability the
   * sending device declared. This is how `gate_state_changed` reaches the
   * gates_clearance capability without the scheduler knowing what gates are.
   */
  dispatchEvent(
    device: DeviceRecord,
    event: { event_type: string; device_id: string; payload: unknown },
  ): SchedulerEffect[] {
    const out: SchedulerEffect[] = [];
    for (const capId of device.capabilities) {
      const cap = this.registry.get(capId);
      if (!cap) continue;

      const oldState = device.capability_state.get(capId);
      const result = cap.invokeOnEvent(oldState, {
        device_id: event.device_id,
        event_type: event.event_type,
        payload: event.payload,
        device_capabilities: device.capabilities,
      });

      device.capability_state.set(capId, result.newState);
      out.push(...translateIntents(result.intents, event.device_id));
    }
    return out;
  }

  /** True if any capability of any device votes to deny `request` (ADR-018 veto). */
  anyCapabilityDenies(request: ClearanceConsultation): boolean {
    for (const device of this.devices.values()) {
      for (const capId of device.capabilities) {
        const cap = this.registry.get(capId);
        if (!cap) continue;
        const state = device.capability_state.get(capId);
        const vote = cap.invokeOnClearanceConsultation(state, request);
        if (vote && vote.vote === 'deny') return true;
      }
    }
    return false;
  }

  /**
   * The retained device state for `deviceId`: its capabilities, the presentation
   * fields from its registration, and for a train its positive length and
   * `introduced: true` once its vector has resolved.
   */
  stateEffect(deviceId: string, train: TrainState | undefined): SchedulerEffect {
    const device = this.devices.get(deviceId);
    const capabilities = (device?.capabilities ?? []) as string[];
    const state: {
      capabilities: string[];
      train_length_mm?: number;
      name?: string;
      livery?: string;
      introduced?: boolean;
    } = { capabilities };

    if (train?.length_mm !== undefined && train.length_mm > 0) {
      state.train_length_mm = train.length_mm;
    }
    if (device?.name !== undefined) state.name = device.name;
    if (device?.livery !== undefined) state.livery = device.livery;
    if (train?.introduced) {
      state.introduced = true;
    }

    return effects.updateState('devices', deviceId, state);
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  clear(): void {
    this.devices.clear();
  }
}

function translateIntents(
  intents: ReadonlyArray<SchedulerIntent>,
  sourceDeviceId: string,
): SchedulerEffect[] {
  const out: SchedulerEffect[] = [];
  for (const intent of intents) {
    switch (intent.kind) {
      case 'send_command':
        out.push(effects.sendCommand(intent.device_id, intent.command_type, intent.payload));
        break;
      case 'emit_anomaly':
        out.push(
          effects.publishEvent('anomaly', {
            severity: intent.severity,
            description: intent.description,
            context: { source_device_id: sourceDeviceId },
          }),
        );
        break;
      // withhold/release intents are state-only; the scheduler reads the
      // capability state directly during clearance consultation.
      case 'withhold_clearance_at_marker':
      case 'release_clearance_at_marker':
        break;
    }
  }
  return out;
}
