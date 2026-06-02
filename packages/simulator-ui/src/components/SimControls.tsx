import type { Layout } from '@trainframe/protocol';
import { useEffect, useState } from 'react';
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
  const demoRoute = layout.edges
    .slice(0, 3)
    .map((e) => ({ from_marker_id: e.from_marker_id, to_marker_id: e.to_marker_id }));
  const canSpawn = demoRoute.length > 0;

  const computedNextId = `T${snapshot.train_ids.length + 1}`;
  const [trainId, setTrainId] = useState(computedNextId);
  const [overshootRate, setOvershootRate] = useState('0');
  const [missRate, setMissRate] = useState('0.01');

  // When the train list empties (Stop), reset the form's Train ID so the
  // operator's next spawn doesn't start at the last auto-incremented value
  // and skip over T1.
  useEffect(() => {
    if (snapshot.train_ids.length === 0) setTrainId('T1');
  }, [snapshot.train_ids.length]);

  function handleSpawn(e: React.FormEvent) {
    e.preventDefault();
    if (!canSpawn) return;
    const firstEdge = demoRoute[0];
    if (!firstEdge) return;

    const parsedOvershoot = Number.parseFloat(overshootRate);
    const parsedMiss = Number.parseFloat(missRate);
    const config: { overshoot_rate?: number; miss_rate?: number } = {};
    if (!Number.isNaN(parsedOvershoot))
      config.overshoot_rate = Math.min(1, Math.max(0, parsedOvershoot));
    if (!Number.isNaN(parsedMiss)) config.miss_rate = Math.min(1, Math.max(0, parsedMiss));

    if (isIdle) start();
    spawnTrain(trainId, firstEdge, config);
    assignRoute(trainId, demoRoute);
    // Pressing Spawn implies "begin" from the operator's POV — auto-resume so
    // a spawned train actually moves. resume() is a no-op when already running.
    resume();

    // Advance train_id to the next default after spawn
    setTrainId(`T${snapshot.train_ids.length + 2}`);
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
        <form onSubmit={handleSpawn}>
          <label>
            Train ID{' '}
            <input
              type="text"
              value={trainId}
              onChange={(e) => setTrainId(e.target.value)}
              required
            />
          </label>{' '}
          <label>
            Overshoot rate{' '}
            <input
              type="number"
              value={overshootRate}
              onChange={(e) => setOvershootRate(e.target.value)}
              min="0"
              max="1"
              step="0.01"
            />
          </label>{' '}
          <label>
            Miss rate{' '}
            <input
              type="number"
              value={missRate}
              onChange={(e) => setMissRate(e.target.value)}
              min="0"
              max="1"
              step="0.01"
            />
          </label>{' '}
          <button type="submit" disabled={!canSpawn}>
            Spawn train
          </button>
        </form>
      </fieldset>
    </section>
  );
}
