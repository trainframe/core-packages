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
  /** The `device_registered` event to publish immediately after `register`.
   *  Omit for a device (e.g. a beacon) that registers + subscribes but emits its
   *  identity event later. */
  readonly registeredEvent?: CoreEvent;
  /** Command handler to subscribe. Omit for a device that core never commands
   *  (a zone driven entirely by world sensing) — `registerDevice` then returns a
   *  no-op teardown. */
  readonly onCommand?: CommandHandler;
}

export function registerDevice(platform: PlatformProvider, spec: RegisterDeviceSpec): () => void {
  platform.register(spec.manifest);
  if (spec.registeredEvent !== undefined) {
    platform.publish(spec.registeredEvent);
  }
  return spec.onCommand === undefined ? () => {} : platform.onCommand(spec.onCommand);
}
