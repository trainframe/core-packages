import { useBroker } from '../broker/broker-context.js';
import { useRegisteredDevices } from '../state/use-registered-devices.js';

/**
 * Garage affordance for ADR-036: lists every registered train whose heading
 * vector has not yet resolved (introduced !== true) and offers a one-click
 * roll-path introduction. Once `introduced` becomes true the row disappears.
 *
 * No-op when all trains are already introduced (or none are registered).
 */
export function GarageIntroduction() {
  const devices = useRegisteredDevices();
  const { client } = useBroker();

  const pending = [...devices.values()].filter(
    (d) => d.capabilities.includes('core.controls_motion') && d.introduced !== true,
  );

  if (pending.length === 0) return null;

  function introduce(trainId: string): void {
    client.publish(
      'railway/operator/introduce_train',
      new TextEncoder().encode(JSON.stringify({ train_id: trainId })),
    );
  }

  return (
    <section aria-label="Trains awaiting introduction" data-testid="garage-introduction">
      <h2>Trains awaiting introduction</h2>
      <p>
        These trains are registered but their heading direction is not yet known. Click Introduce to
        let each train roll forward across two markers so the system can resolve its vector.
      </p>
      <ul>
        {pending.map((device) => (
          <li key={device.device_id} data-testid={`introduce-item-${device.device_id}`}>
            <span>
              <code>{device.device_id}</code>
              {device.name !== undefined && <> ({device.name})</>}
            </span>{' '}
            <button
              type="button"
              onClick={() => introduce(device.device_id)}
              data-testid={`introduce-btn-${device.device_id}`}
            >
              Introduce
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
