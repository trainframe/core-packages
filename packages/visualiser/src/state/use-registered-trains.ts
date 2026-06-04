// TODO: extract — see src/view/index.ts for the extraction pattern (RegisteredTrainsView, derives from RegisteredDevicesView).
import { useMemo } from 'react';
import { useRegisteredDevices } from './use-registered-devices.js';

/**
 * The set of currently-registered trains. A train is any device that
 * declared the `core.controls_motion` capability at registration. Thin
 * filter over `useRegisteredDevices`; preserved as a separate hook because
 * `ScheduleAssigner` and friends only ever cared about trains.
 */
export type RegisteredTrains = ReadonlyArray<string>;

export function useRegisteredTrains(): RegisteredTrains {
  const devices = useRegisteredDevices();
  return useMemo(() => {
    const ids: string[] = [];
    for (const device of devices.values()) {
      if (device.capabilities.includes('core.controls_motion')) {
        ids.push(device.device_id);
      }
    }
    return ids.sort();
  }, [devices]);
}
