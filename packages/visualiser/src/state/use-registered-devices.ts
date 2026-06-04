// TODO: extract — see src/view/index.ts for the extraction pattern.
// This hook has already been extracted to RegisteredDevicesView; the hook
// is now a thin React bridge.
import { useMemo, useSyncExternalStore } from 'react';
import { useBroker } from '../broker/broker-context.js';
import { type RegisteredDevices, RegisteredDevicesView } from '../view/registered-devices-view.js';

// Re-export types so existing importers (DevicesPanel, use-registered-trains,
// etc.) continue to resolve them from this module without changes.
export type { RegisteredDevice, RegisteredDevices } from '../view/registered-devices-view.js';

/**
 * Subscribe to every retained device snapshot and surface them as a map
 * keyed by `device_id`. See `RegisteredDevicesView` for the framework-
 * independent implementation.
 */
export function useRegisteredDevices(): RegisteredDevices {
  const { client } = useBroker();

  // One view instance per client identity. The view owns the broker
  // subscription and tears it down when the last React subscriber unmounts.
  const view = useMemo(() => new RegisteredDevicesView(client), [client]);

  return useSyncExternalStore(view.subscribe, view.getState);
}
