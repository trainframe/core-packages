/**
 * The PLATFORM provider family (ADR-031 §1) — the device↔core seam, the dual of
 * the ADR-030 WORLD providers (`CameraProvider` to sense, `MotorActuator` /
 * `SwitchActuator` to act on the track).
 *
 * A device perceives and acts on the *world* through world providers; its link
 * to *core* — publishing events, receiving commands / clearance, registering its
 * capabilities — is the one remaining seam ADR-030 left implicit. ADR-031 names
 * it: a single injected `PlatformProvider`. A device is handed one exactly as it
 * is handed a camera; it NEVER constructs its own transport.
 *
 * THE LOAD-BEARING RULE: a device imports ONLY this interface. It must not import
 * the broker client, an MQTT adapter, the string 'mqtt', or any concrete backing.
 * WHICH backing is wired in is the composition root's choice, not the device's:
 *
 *   - in tests / the toy table → an in-process bus (`inProcessPlatform`, below);
 *   - in a nested zone (ADR-032) → the PARENT controller (`platformFor`, below) —
 *     the parent IS the child's core;
 *   - in production → the MQTT adapter (`broker/mqtt-platform.ts`) — but that
 *     adapter lives at the IO/composition EDGE, next to `MqttBrokerClient`, and
 *     NOTHING under `devices/` may import it.
 *
 * The provider deals in the protocol's REAL wire shapes — `CoreEvent` (device →
 * core) and `CoreCommand` (core → device) discriminated unions from
 * `@trainframe/protocol`. No invented message shapes; no `any`. The unions are
 * concrete (not generic), so there is no variance to fight here.
 */
import type { CoreCommand, CoreEvent, DeviceManifest } from '@trainframe/protocol';

/** A handler for commands a device's core sends down to it. */
export type CommandHandler = (command: CoreCommand) => void;

/**
 * The device↔core link. A device is fully described by the world providers it
 * senses/acts through plus this one platform provider; nothing else crosses its
 * boundary (ADR-031 §1).
 */
export interface PlatformProvider {
  /** Announce the device's identity + capabilities to core (the registration
   *  handshake). */
  register(manifest: DeviceManifest): void;
  /** Emit a core event upward (a `tag_observed`, `zone_state_changed`, …). */
  publish(event: CoreEvent): void;
  /** Subscribe to commands core sends to this device (clearance, routes, …).
   *  Returns an unsubscribe function. */
  onCommand(handler: CommandHandler): () => void;
}

/**
 * A tiny, typed, DOM-free pub/sub the in-process backings ride on. It carries
 * the protocol's real shapes per device id, in both directions:
 *
 *   - `publishEvent(deviceId, event)` → delivered to every event subscriber for
 *     that device id (core / a parent observing its child);
 *   - `sendCommand(deviceId, command)` → delivered to every command subscriber
 *     for that device id (the device's `onCommand` handler).
 *
 * Deterministic: synchronous fan-out, insertion-ordered, no timers, no clock.
 * This is the simulator/toy-table transport and the test transport — exactly
 * what lets a controller run headlessly with no broker.
 */
export class InProcessBus {
  private readonly eventSubs = new Map<string, Set<(event: CoreEvent) => void>>();
  private readonly commandSubs = new Map<string, Set<CommandHandler>>();
  private readonly manifests = new Map<string, DeviceManifest>();

  /** Record a device's manifest (what `register` lands as on the bus). The most
   *  recent manifest per device id is observable for tests / a parent rollup. */
  registerManifest(deviceId: string, manifest: DeviceManifest): void {
    this.manifests.set(deviceId, manifest);
  }

  /** The manifest a device registered, if any (test / parent observation). */
  manifestOf(deviceId: string): DeviceManifest | undefined {
    return this.manifests.get(deviceId);
  }

  /** Publish a device's event to everyone listening for that device id. */
  publishEvent(deviceId: string, event: CoreEvent): void {
    const bucket = this.eventSubs.get(deviceId);
    if (bucket === undefined) return;
    for (const handler of [...bucket]) handler(event);
  }

  /** Subscribe to a device's events (what core / a parent does). */
  onEvent(deviceId: string, handler: (event: CoreEvent) => void): () => void {
    return this.add(this.eventSubs, deviceId, handler);
  }

  /** Send a command down to a device. */
  sendCommand(deviceId: string, command: CoreCommand): void {
    const bucket = this.commandSubs.get(deviceId);
    if (bucket === undefined) return;
    for (const handler of [...bucket]) handler(command);
  }

  /** Subscribe to a device's commands (what the device's platform provider does). */
  onCommand(deviceId: string, handler: CommandHandler): () => void {
    return this.add(this.commandSubs, deviceId, handler);
  }

  private add<T>(map: Map<string, Set<T>>, deviceId: string, handler: T): () => void {
    let bucket = map.get(deviceId);
    if (bucket === undefined) {
      bucket = new Set<T>();
      map.set(deviceId, bucket);
    }
    bucket.add(handler);
    return () => {
      const b = map.get(deviceId);
      if (b === undefined) return;
      b.delete(handler);
      if (b.size === 0) map.delete(deviceId);
    };
  }
}

/**
 * The in-process platform backing (device/sim layer). A device wired with this
 * publishes events onto the bus under its own id, registers its manifest there,
 * and receives commands addressed to its id. DOM-free and deterministic — the
 * simulator and the tests use this.
 */
export function inProcessPlatform(bus: InProcessBus, deviceId: string): PlatformProvider {
  return {
    register(manifest: DeviceManifest): void {
      bus.registerManifest(deviceId, manifest);
    },
    publish(event: CoreEvent): void {
      bus.publishEvent(deviceId, event);
    },
    onCommand(handler: CommandHandler): () => void {
      return bus.onCommand(deviceId, handler);
    },
  };
}
