import { type FormEvent, useState } from 'react';
import { type DiscoveredDevice, useDiscoveredDevices } from '../state/use-discovered-devices.js';

/**
 * Garage affordance for ADR-035 Phase 2: when the bridge announces an unpaired
 * device (`device_discovered`), surface a row inviting the operator to scan the
 * tag at the device's location. One scan → `device_association`, and the device
 * self-declares its kind/capabilities on re-register — NO naming is asked of the
 * operator. The row disappears the moment the device registers.
 *
 * No-op when nothing is pending — keeps the page calm.
 */
export function GarageDiscovery() {
  const { pending, associate } = useDiscoveredDevices();
  if (pending.length === 0) return null;

  return (
    <section aria-label="New devices" data-testid="garage-discovery">
      <h2>New devices</h2>
      <p>A device announced itself. Scan the tag where it sits to add it — no naming needed.</p>
      <ul>
        {pending.map((device) => (
          <li key={device.device_ref} data-testid={`discovered-${device.device_ref}`}>
            <AssociateRow device={device} associate={associate} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface AssociateRowProps {
  readonly device: DiscoveredDevice;
  readonly associate: (deviceRef: string, tagId: string) => void;
}

function AssociateRow({ device, associate }: AssociateRowProps) {
  const [tagId, setTagId] = useState('');

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const trimmed = tagId.trim();
    if (trimmed === '') return;
    associate(device.device_ref, trimmed);
    /* The row drops when railway/state/devices/<id> arrives via the hook —
       nothing else to do. */
  };

  return (
    <form onSubmit={handleSubmit} aria-label={`Add device ${device.device_ref}`}>
      <span>
        <strong>{device.device_kind_hint}</strong> <code>{device.device_ref}</code>
      </span>
      <label>
        Scanned tag
        <input
          type="text"
          value={tagId}
          onChange={(e) => setTagId(e.target.value)}
          placeholder="tag at the device"
          data-testid={`tag-${device.device_ref}`}
        />
      </label>
      <button
        type="submit"
        disabled={tagId.trim() === ''}
        data-testid={`associate-${device.device_ref}`}
      >
        Add
      </button>
    </form>
  );
}
