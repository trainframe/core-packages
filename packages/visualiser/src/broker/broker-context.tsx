import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import type { BrokerStatus, BrokerSubscriber } from './client.js';

interface BrokerContextValue {
  client: BrokerSubscriber;
  status: BrokerStatus;
  error: Error | null;
}

const BrokerContext = createContext<BrokerContextValue | null>(null);

interface BrokerProviderProps {
  client: BrokerSubscriber;
  children: ReactNode;
}

export function BrokerProvider({ client, children }: BrokerProviderProps) {
  const [status, setStatus] = useState<BrokerStatus>(client.status);
  const [error, setError] = useState<Error | null>(null);

  useEffect(
    () =>
      client.onStatusChange((next, err) => {
        setStatus(next);
        setError(err ?? null);
      }),
    [client],
  );

  return (
    <BrokerContext.Provider value={{ client, status, error }}>{children}</BrokerContext.Provider>
  );
}

export function useBroker(): BrokerContextValue {
  const ctx = useContext(BrokerContext);
  if (!ctx) throw new Error('useBroker must be used inside <BrokerProvider>');
  return ctx;
}
