import type { BrokerStatus } from '@trainframe/simulator/broker/client.js';
import { useBroker } from '../broker/broker-context.js';

const LABELS: Record<BrokerStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  connected: 'Connected',
  error: 'Connection error',
};

export function ConnectionStatus() {
  const { status, error } = useBroker();
  return (
    <output data-status={status}>
      <span>{LABELS[status]}</span>
      {error ? <span> — {error.message}</span> : null}
    </output>
  );
}
