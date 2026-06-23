import { useMemo, useSyncExternalStore } from 'react';
import { useBroker } from '../broker/broker-context.js';
import { CommissioningView } from '../view/commissioning-view.js';
import type { CommissionCategory, CommissionItem } from '../view/commissioning-view.js';

export type { CommissionCategory, CommissionItem } from '../view/commissioning-view.js';

/** The pending commission queue plus the operator commands that resolve it.
 *  A thin React bridge over the framework-independent `CommissioningView`. */
export interface Commissioning {
  readonly pending: ReadonlyArray<CommissionItem>;
  readonly classify: (id: string, category: CommissionCategory) => void;
  readonly setName: (id: string, name: string) => void;
  readonly setTrainLength: (id: string, mm: number) => void;
  readonly bindTagToMarker: (id: string, markerId: string) => void;
  readonly confirm: (id: string) => void;
  readonly dismiss: (id: string) => void;
}

export function useCommissioning(): Commissioning {
  const { client } = useBroker();

  // One view per client identity; it owns its broker subscriptions. Production
  // id/clock — randomised + wall-clock, fine for a UI (determinism is only
  // required for the headless unit tests, which inject their own ports).
  const view = useMemo(
    () =>
      new CommissioningView({
        client,
        newId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
      }),
    [client],
  );

  const pending = useSyncExternalStore(view.subscribe, view.getState).pending;

  return useMemo(
    () => ({
      pending,
      classify: (id, category) => view.classify(id, category),
      setName: (id, name) => view.setName(id, name),
      setTrainLength: (id, mm) => view.setTrainLength(id, mm),
      bindTagToMarker: (id, markerId) => view.bindTagToMarker(id, markerId),
      confirm: (id) => view.confirm(id),
      dismiss: (id) => view.dismiss(id),
    }),
    [pending, view],
  );
}
