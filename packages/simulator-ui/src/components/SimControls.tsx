import type { Layout } from '@trainframe/protocol';
import { useSimRunner } from '../sim/use-sim-runner.js';

const STEP_MS = 1000;

interface SimControlsProps {
  /** Layout the simulation is running against. Switching layouts rebuilds the runner. */
  readonly layout: Layout;
}

/**
 * Operator panel for driving an in-browser simulation. Spawns trains starting
 * on the layout's first edge and routes them along the next three edges,
 * publishing all captured events through the configured MQTT broker.
 */
export function SimControls({ layout }: SimControlsProps) {
  const { snapshot, start, resume, pause, stop, step, spawnTrain, assignRoute } = useSimRunner(
    layout,
    100,
  );

  const isIdle = snapshot.status === 'idle';
  const nextTrainId = `T${snapshot.train_ids.length + 1}`;
  const demoRoute = layout.edges
    .slice(0, 3)
    .map((e) => ({ from_marker_id: e.from_marker_id, to_marker_id: e.to_marker_id }));
  const canSpawn = demoRoute.length > 0;

  function handleSpawnAndAssign() {
    if (!canSpawn) return;
    const firstEdge = demoRoute[0];
    if (!firstEdge) return;
    if (isIdle) start();
    spawnTrain(nextTrainId, firstEdge);
    assignRoute(nextTrainId, demoRoute);
  }

  return (
    <section aria-label="Simulator controls">
      <h2>Simulation</h2>
      <dl>
        <dt>Status</dt>
        <dd data-testid="sim-status">{snapshot.status}</dd>
        <dt>Sim time</dt>
        <dd>{(snapshot.sim_time_ms / 1000).toFixed(1)}s</dd>
        <dt>Events published</dt>
        <dd>{snapshot.events_published}</dd>
        <dt>Trains</dt>
        <dd>{snapshot.train_ids.length === 0 ? 'none' : snapshot.train_ids.join(', ')}</dd>
      </dl>
      <fieldset>
        <legend>Lifecycle</legend>
        <button type="button" onClick={start} disabled={!isIdle}>
          Start
        </button>
        <button type="button" onClick={resume} disabled={snapshot.status !== 'paused'}>
          Resume
        </button>
        <button type="button" onClick={pause} disabled={snapshot.status !== 'running'}>
          Pause
        </button>
        <button type="button" onClick={stop} disabled={isIdle}>
          Stop
        </button>
        <button type="button" onClick={() => step(STEP_MS)} disabled={isIdle}>
          Step 1s
        </button>
      </fieldset>
      <fieldset>
        <legend>Trains</legend>
        <button type="button" onClick={handleSpawnAndAssign}>
          Spawn train + assign demo route
        </button>
      </fieldset>
    </section>
  );
}
