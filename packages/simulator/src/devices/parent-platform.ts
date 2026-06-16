import type { CoreCommand, CoreEvent, DeviceManifest } from '@trainframe/protocol';
/**
 * Parent-as-core (ADR-032), device/sim layer.
 *
 * "Opacity is relative to an observer, and a device's 'core' is simply whoever
 * provides its platform link." (ADR-032 §1) Nesting falls straight out of the
 * ADR-031 `PlatformProvider`: a nested zone's platform provider is its PARENT,
 * not the broker. The inner device's controller is IDENTICAL to the standalone
 * one; the only difference is what its platform provider points at.
 *
 * `ParentPlatform` is the parent side of that link. The parent:
 *
 *   - hands a child `platformFor(childId)` — a `PlatformProvider` indistinguishable
 *     from the real core (the child cannot tell it is talking to a depot, not the
 *     broker);
 *   - sees every event the child publishes, via `onChildEvent` (the child reports
 *     upward, never sideways to core — ADR-032 §1);
 *   - sends the child commands via `command` (the parent answers clearance /
 *     occupancy as if it were core — ADR-032 §2).
 *
 * It is the same `InProcessBus` indirection underneath: the parent subscribes to
 * the child's events and publishes to the child's command stream. A child's
 * platform provider routes its `publish` to whoever subscribed (here, the parent)
 * and its `onCommand` to whoever the parent sends to — pure plumbing, DOM-free,
 * deterministic.
 */
import { type CommandHandler, InProcessBus, type PlatformProvider } from './platform-provider.js';

export class ParentPlatform {
  /** Private bus dedicated to this parent↔children link — interior to the parent,
   *  never the broker (ADR-032: report upward, never sideways to core). */
  private readonly bus = new InProcessBus();

  /** The platform provider a child is wired from. To the child this IS core. */
  platformFor(childId: string): PlatformProvider {
    return {
      register: (manifest: DeviceManifest): void => {
        this.bus.registerManifest(childId, manifest);
      },
      publish: (event: CoreEvent): void => {
        this.bus.publishEvent(childId, event);
      },
      onCommand: (handler: CommandHandler): (() => void) => this.bus.onCommand(childId, handler),
    };
  }

  /** Observe a child's events (the parent, being core-shaped, listens here to
   *  roll the child's occupancy into its own single asserted occupancy). */
  onChildEvent(childId: string, handler: (event: CoreEvent) => void): () => void {
    return this.bus.onEvent(childId, handler);
  }

  /** Command a child (clearance / route / etc.) as its core would. */
  command(childId: string, command: CoreCommand): void {
    this.bus.sendCommand(childId, command);
  }

  /** The manifest a child registered, if any. */
  childManifest(childId: string): DeviceManifest | undefined {
    return this.bus.manifestOf(childId);
  }
}
