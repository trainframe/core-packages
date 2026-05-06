import { SIMPLE_LOOP } from '../sim/layouts.js';
import { useSimRunner } from '../sim/use-sim-runner.js';

const STEP_MS = 1000;

const DEMO_ROUTE = [
  { from_marker_id: 'M1', to_marker_id: 'M2' },
  { from_marker_id: 'M2', to_marker_id: 'M3' },
  { from_marker_id: 'M3', to_marker_id: 'M4' },
];

/**
 * Operator panel for driving an in-browser simulation. Spawns trains on the
 * default loop, runs them along a fixed demo route, and publishes events
 * through the configured MQTT broker. The first iteration uses a single
 * preset layout; track configuration UI comes next.
 */
export function SimControls() {
  const { snapshot, start, resume, pause, stop, step, spawnTrain, assignRoute } = useSimRunner(
    SIMPLE_LOOP,
    100,
  );

  const isIdle = snapshot.status === 'idle';
  const nextTrainId = `T${snapshot.train_ids.length + 1}`;

  function handleSpawnAndAssign() {
    if (isIdle) start();
    spawnTrain(nextTrainId, DEMO_ROUTE[0] as { from_marker_id: string; to_marker_id: string });
    assignRoute(nextTrainId, DEMO_ROUTE);
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
