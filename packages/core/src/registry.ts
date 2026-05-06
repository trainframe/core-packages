import type { Capability, RegisteredCapability } from './capability.js';
import { wrap } from './capability.js';

/**
 * Runtime container for capabilities. Built-ins and satellite capabilities
 * are added the same way. The server, simulator, and any test environment
 * own a Registry; capabilities are added during startup, before any devices
 * connect.
 *
 * Once devices are connected, the registry is frozen — capabilities cannot
 * be added at runtime, because devices may already have registered with
 * dependencies on the current set.
 */
export class CapabilityRegistry {
  private readonly capabilities = new Map<string, RegisteredCapability>();
  private frozen = false;

  /**
   * Add a typed capability. The capability is wrapped into the existential
   * form internally; only the wrapped form is stored, and the wrapping is
   * the one place state-type variance is hidden.
   */
  register<State>(capability: Capability<State>): void {
    if (this.frozen) {
      throw new Error(
        `Cannot register capability '${capability.id}': registry is frozen. Capabilities must be registered during startup, before devices connect.`,
      );
    }
    if (this.capabilities.has(capability.id)) {
      throw new Error(`Capability '${capability.id}' is already registered.`);
    }
    this.capabilities.set(capability.id, wrap(capability));
  }

  /**
   * Convenience: register many capabilities at once. The element type is
   * `Capability<unknown>` purely for the array signature; each element is
   * wrapped individually so its real State type is preserved internally.
   */
  registerAll(capabilities: ReadonlyArray<Capability<unknown>>): void {
    for (const cap of capabilities) {
      this.register(cap);
    }
  }

  /**
   * Freeze the registry. After this, no further registrations are allowed.
   * The platform calls this once startup is complete and before accepting
   * device connections.
   */
  freeze(): void {
    this.frozen = true;
  }

  get(id: string): RegisteredCapability | undefined {
    return this.capabilities.get(id);
  }

  has(id: string): boolean {
    return this.capabilities.has(id);
  }

  ids(): ReadonlyArray<string> {
    return [...this.capabilities.keys()];
  }

  all(): ReadonlyArray<RegisteredCapability> {
    return [...this.capabilities.values()];
  }

  /**
   * Return capability ids declared by a device that the registry doesn't
   * know about. Empty array if all are known.
   */
  validateDeviceCapabilities(declared: ReadonlyArray<string>): ReadonlyArray<string> {
    return declared.filter((id) => !this.capabilities.has(id));
  }
}
