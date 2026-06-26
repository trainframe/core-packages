import type { CoreEvent, DeviceManifest } from '@trainframe/protocol';
import type { CommandHandler, PlatformProvider } from './platform-provider.js';

/**
 * The single registration-lifecycle seam every platform-bearing device routes
 * through (ADR-035). Today it is the universal idiom found verbatim in every
 * device's `start()`:
 *
 *   1. `register(manifest)`           — announce identity + capabilities to core;
 *   2. `publish(registeredEvent)`     — the `device_registered` event carrying the
 *                                       marker / length / positions `register`
 *                                       itself omits (optional: a device that
 *                                       publishes its identity later omits it);
 *   3. `onCommand(handler)`           — subscribe to this device's commands.
 *
 * Extracting it to one place is what makes the Phase-2 pairing lifecycle
 * (announce → discover → associate → register) a SINGLE change here rather than
 * an edit to all eight devices' `start()` methods. Behaviour is unchanged: the
 * call order (register → publish → onCommand) is exactly what the devices did
 * inline, so their emitted events stay byte-identical.
 *
 * Returns the command-subscription teardown the device stores and calls in
 * `stop()`.
 */
export interface RegisterDeviceSpec {
  readonly manifest: DeviceManifest;
  /**
   * The `device_registered` event — a fixed event when the device knows its
   * identity at construction, OR a BUILDER `(markerId?) => event` when identity
   * is late-bound (a switch whose junction marker arrives via association on the
   * ESP-NOW path; ADR-035). Omit for a device (a beacon) that emits its identity
   * later. The builder is called with the resolved marker on the ESP-NOW path,
   * and with `undefined` on an immediate backing (the device falls back to its
   * construction-time marker).
   */
  readonly registeredEvent?: CoreEvent | ((markerId: string | undefined) => CoreEvent);
  /** Command handler to subscribe. Omit for a device that core never commands
   *  (a zone driven entirely by world sensing) — `registerDevice` then returns a
   *  no-op teardown. */
  readonly onCommand?: CommandHandler;
}

export function registerDevice(platform: PlatformProvider, spec: RegisterDeviceSpec): () => void {
  const ev = spec.registeredEvent;
  const build = ev === undefined ? undefined : typeof ev === 'function' ? ev : () => ev;

  /* A backing that must pair before registering (the ESP-NOW path) runs the full
     onboarding lifecycle — the registered event is built once the marker is known
     via association, not now. */
  if (platform.commission !== undefined) {
    return platform.commission({
      manifest: spec.manifest,
      ...(build === undefined ? {} : { buildRegisteredEvent: build }),
      ...(spec.onCommand === undefined ? {} : { onCommand: spec.onCommand }),
    });
  }

  /* Immediate backing (in-process / MQTT / parent): the device is already
     connected, so register → publish(identity) → subscribe, in order. */
  platform.register(spec.manifest);
  if (build !== undefined) platform.publish(build(undefined));
  return spec.onCommand === undefined ? () => {} : platform.onCommand(spec.onCommand);
}
