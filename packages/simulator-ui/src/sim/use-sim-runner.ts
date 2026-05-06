import type { Layout } from '@trainframe/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import { SimRunner, type SimRunnerSnapshot } from './sim-runner.js';

export interface SimRunnerControls {
  readonly snapshot: SimRunnerSnapshot;
  readonly start: () => void;
  readonly resume: () => void;
  readonly pause: () => void;
  readonly stop: () => void;
  readonly step: (ms: number) => void;
  readonly spawnTrain: (
    train_id: string,
    edge: { from_marker_id: string; to_marker_id: string },
  ) => void;
  readonly assignRoute: (
    train_id: string,
    edges: ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>,
  ) => void;
}

/**
 * Construct a `SimRunner` bound to the current broker and surface its snapshot
 * as React state. Deps are primitives so memoization is stable — passing a
 * fresh options object would re-create the runner on every render.
 */
export function useSimRunner(layout: Layout, tick_ms: number): SimRunnerControls {
  const { client } = useBroker();
  const runner = useMemo(
    () => new SimRunner(client, { layout, tick_ms }),
    [client, layout, tick_ms],
  );
  const [snapshot, setSnapshot] = useState<SimRunnerSnapshot>(() => runner.snapshot());

  useEffect(() => runner.onSnapshotChange(setSnapshot), [runner]);
  useEffect(() => () => runner.stop(), [runner]);

  return {
    snapshot,
    start: () => runner.start(),
    resume: () => runner.resume(),
    pause: () => runner.pause(),
    stop: () => runner.stop(),
    step: (ms) => runner.step(ms),
    spawnTrain: (id, edge) => runner.spawnTrain(id, edge),
    assignRoute: (id, edges) => runner.assignRoute(id, edges),
  };
}
