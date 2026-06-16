/**
 * A generic operator clearance-gate device (`core.gates_clearance`). It owns no
 * track and senses nothing: a gate is a purely LOGICAL actor that withholds or
 * grants clearance across one or more markers. Holding marker M makes the
 * scheduler's `core.gates_clearance` capability vote `deny` on any clearance
 * whose proposed limit is M, so a train is held at the marker before it; releasing
 * lets the scheduler advance it.
 *
 * Because it touches neither the world nor a sensor/actuator, it is world-agnostic
 * for free (ADR-030/031): its only link is the `PlatformProvider` to core. Two
 * ways drive it, mirroring the old `VirtualGate`:
 *   - the physical operator pressing hold/release — the `hold()` / `release()`
 *     methods (what a test, or a wired button, calls);
 *   - the server overriding via `hold_gate` / `release_gate` commands.
 * Both funnel through the same withhold set, so a marker is held while EITHER
 * source holds it and the device emits one `gate_state_changed` per real change.
 *
 * Several gates may gate the SAME marker: each is its own device with its own
 * `core.gates_clearance` instance, so the scheduler ANDs their votes (ADR-018) and
 * a single device disconnecting drops only its own veto. DOM-free, deterministic.
 */
import {
  type CoreCommand,
  type CoreEvent,
  type DeviceManifest,
  type HoldGate,
  PROTOCOL_VERSION,
  type ReleaseGate,
} from '@trainframe/protocol';
import type { PlatformProvider } from './platform-provider.js';

export interface GateDeviceDeps {
  /** The device↔core link (mqtt in the gate/script, in-process in unit tests). */
  readonly platform: PlatformProvider;
  /** The markers this gate is allowed to gate. A `hold`/`hold_gate` for any other
   *  marker is ignored — a gate cannot withhold clearance it does not own. */
  readonly markers: readonly string[];
  /** Markers withheld from the moment it registers (a gate that starts CLOSED).
   *  Each emits an initial `gate_state_changed{withholding}` on `start()`. */
  readonly initialWithheld?: readonly string[];
  /** Fresh envelope id source. Defaults to `crypto.randomUUID`. The mqtt edge
   *  re-stamps the envelope anyway; injectable for deterministic tests. */
  readonly newId?: () => string;
  /** Current ISO-8601 timestamp source. Defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
}

export class GateDevice {
  private readonly id: string;
  private readonly d: GateDeviceDeps;
  private readonly newId: () => string;
  private readonly now: () => string;
  private readonly withheld = new Map<string, string>();
  private unsubscribe: (() => void) | undefined;

  constructor(deviceId: string, deps: GateDeviceDeps) {
    this.id = deviceId;
    this.d = deps;
    this.newId = deps.newId ?? defaultNewId;
    this.now = deps.now ?? defaultNow;
  }

  get deviceId(): string {
    return this.id;
  }

  /** Register the `core.gates_clearance` manifest, announce it, withhold any
   *  initially-closed markers, and listen for operator override commands. */
  start(): void {
    this.d.platform.register(this.manifest());
    this.d.platform.publish(this.registeredEvent());
    this.unsubscribe = this.d.platform.onCommand((command) => this.handle(command));
    for (const marker of this.d.initialWithheld ?? []) this.hold(marker, 'closed');
  }

  /** Stop listening. Core's `gates_clearance` releases this device's withholds on
   *  disconnect (the fail-safe), so a stopped gate never strands a train. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Hold (withhold clearance across) a marker. No-op for a marker this gate does
   *  not own or already holds. Emits `gate_state_changed{withholding}` on a real
   *  change. */
  hold(markerId: string, reason = 'gate'): void {
    if (!this.d.markers.includes(markerId) || this.withheld.has(markerId)) return;
    this.withheld.set(markerId, reason);
    this.d.platform.publish(this.gateEvent(markerId, 'withholding', reason));
  }

  /** Release a held marker. No-op if not held. Emits `gate_state_changed{granting}`. */
  release(markerId: string): void {
    if (!this.withheld.delete(markerId)) return;
    this.d.platform.publish(this.gateEvent(markerId, 'granting'));
  }

  /**
   * The server's operator override. `CoreCommand` is not a TS discriminated union
   * (its `command_type` is `string`), so the compiler cannot narrow on it; when
   * the runtime type matches, the wire contract guarantees the payload shape, so
   * the cast is sound — confined here and named via the local.
   */
  private handle(command: CoreCommand): void {
    if (command.command_type === 'hold_gate') {
      const { marker_id, reason } = (command as HoldGate).payload;
      this.hold(marker_id, reason ?? 'server override');
    } else if (command.command_type === 'release_gate') {
      const { marker_id } = (command as ReleaseGate).payload;
      this.release(marker_id);
    }
  }

  private manifest(): DeviceManifest {
    return {
      manifest_version: '1.0',
      vendor: 'trainframe.sim',
      device_kind: 'clearance-gate',
      version: '0.1.0',
      protocol_version: PROTOCOL_VERSION,
      display_name: `Gate ${this.id}`,
      description: `Operator clearance gate over ${this.d.markers.join(', ')}.`,
      capabilities: ['core.gates_clearance'],
    };
  }

  private registeredEvent(): CoreEvent {
    return this.envelope('device_registered', {
      capabilities: ['core.gates_clearance'],
      device_kind_hint: 'clearance-gate',
    });
  }

  private gateEvent(
    markerId: string,
    state: 'withholding' | 'granting',
    reason?: string,
  ): CoreEvent {
    return this.envelope('gate_state_changed', {
      marker_id: markerId,
      state,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  /**
   * Build a `CoreEvent` envelope. The single sound coercion point in this file:
   * the protocol's `CoreEvent` union models payloads per `event_type`; we assemble
   * the open record the wire actually carries and coerce once, here, rather than
   * sprinkling casts. The `event_type` is constrained to the union's literals, so
   * the discriminant is always valid.
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
