import type { Layout } from '@trainframe/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useSimRunner } from '../sim/use-sim-runner.js';

const STEP_MS = 1000;

interface SimControlsProps {
  /** Layout the simulation is running against. Switching layouts rebuilds the runner. */
  readonly layout: Layout;
}

/**
 * Operator panel for driving an in-browser simulation. The operator picks an
 * ordered list of *stops* — markers the train will cycle through indefinitely
 * — and spawns the train. The scheduler plans the per-leg transit through
 * the layout graph on the fly. See ADR-010.
 */
export function SimControls({ layout }: SimControlsProps) {
  const { snapshot, start, resume, pause, stop, step, spawnTrain, assignSchedule } = useSimRunner(
    layout,
    100,
  );

  const isIdle = snapshot.status === 'idle';
  const hasAnyMarkers = layout.markers.length > 0;

  const computedNextId = `T${snapshot.train_ids.length + 1}`;
  const [trainId, setTrainId] = useState(computedNextId);
  const [overshootRate, setOvershootRate] = useState('0');
  const [missRate, setMissRate] = useState('0.01');
  const [spawnError, setSpawnError] = useState<string | null>(null);
  /** Stops the train will cycle through. */
  const [stops, setStops] = useState<string[]>([]);
  /** Marker the operator has currently selected in the stop dropdown. */
  const [nextStop, setNextStop] = useState<string>('');

  // Reset stops when the layout changes; old marker IDs may no longer exist.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout identity is the trigger
  useEffect(() => {
    setStops([]);
    setNextStop('');
  }, [layout]);

  // The stop picker offers every marker in the layout — stops are an
  // operator intent, not a per-edge plan, so reachability is the planner's
  // problem to surface (as an anomaly) not the operator's to pre-compute.
  const markerOptions = useMemo<ReadonlyArray<string>>(
    () => layout.markers.map((m) => m.id),
    [layout],
  );

  // Default the dropdown to the first available marker so the operator can
  // keep tapping Add without re-selecting.
  useEffect(() => {
    if (markerOptions.length === 0) {
      setNextStop('');
      return;
    }
    if (!markerOptions.includes(nextStop)) {
      setNextStop(markerOptions[0] ?? '');
    }
  }, [markerOptions, nextStop]);

  // When the train list empties (Stop), reset the form's Train ID so the
  // operator's next spawn doesn't start at the last auto-incremented value
  // and skip over T1.
  useEffect(() => {
    if (snapshot.train_ids.length === 0) setTrainId('T1');
  }, [snapshot.train_ids.length]);

  const canSpawn = stops.length >= 1;

  function handleAddStop() {
    if (nextStop === '') return;
    if (!markerOptions.includes(nextStop)) return;
    setStops([...stops, nextStop]);
  }

  function handleRemoveLast() {
    setStops(stops.slice(0, -1));
  }

  function handleClearStops() {
    setStops([]);
  }

  function handleSpawn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSpawn) return;
    const startMarker = stops[0];
    if (startMarker === undefined) return;

    // Pick any outgoing edge from stops[0] as the physical spawn edge. The
    // scheduler's assign_route command overrides the train's current_edge
    // when the planner-computed transit lands, so this is just a placeholder
    // physical position.
    const startEdge = layout.edges.find((e) => e.from_marker_id === startMarker);
    if (!startEdge) {
      setSpawnError(
        `Marker ${startMarker} has no outgoing edge — the train would have nowhere to go from here.`,
      );
      return;
    }

    if (isIdle) start();
    const spawned = spawnTrain(trainId, startEdge, buildTrainConfig(overshootRate, missRate));
    if (!spawned) {
      setSpawnError(`Train ${trainId} already exists. Choose a different ID.`);
      return;
    }

    setSpawnError(null);
    assignSchedule(trainId, stops);
    // Pressing Spawn from idle implies "begin" — auto-resume so the train
    // moves without a second click. If the operator manually paused, respect
    // that: add the train but leave the sim paused for them to inspect.
    if (isIdle) resume();

    // Advance train_id to the next default after a successful spawn
    setTrainId(`T${snapshot.train_ids.length + 2}`);
  }

  const nextStopLabel = stops.length === 0 ? 'First stop' : 'Next stop';

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
          </label>
          <div>
            <label>
              {nextStopLabel}{' '}
              <select
                value={nextStop}
                onChange={(e) => setNextStop(e.target.value)}
                disabled={markerOptions.length === 0}
              >
                {markerOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>{' '}
            <button
              type="button"
              onClick={handleAddStop}
              disabled={nextStop === '' || markerOptions.length === 0}
            >
              Add stop
            </button>{' '}
            <button type="button" onClick={handleRemoveLast} disabled={stops.length === 0}>
              Remove last
            </button>{' '}
            <button type="button" onClick={handleClearStops} disabled={stops.length === 0}>
              Clear stops
            </button>
          </div>
          {stops.length > 0 && (
            <ol aria-label="Planned stops">
              {stops.map((markerId, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity of a stop in the schedule
                <li key={`${markerId}-${i}`}>{markerId}</li>
              ))}
            </ol>
          )}
          <button type="submit" disabled={!canSpawn}>
            Spawn train
          </button>
        </form>
        {!hasAnyMarkers && (
          <p data-testid="spawn-disabled-hint">
            Add at least one marker to the layout to spawn a train.
          </p>
        )}
        {hasAnyMarkers && !canSpawn && (
          <p data-testid="spawn-stops-hint">Pick at least one stop for the train to visit.</p>
        )}
        {spawnError !== null && (
          <p role="alert" data-testid="spawn-error">
            {spawnError}
          </p>
        )}
      </fieldset>
    </section>
  );
}

function buildTrainConfig(
  overshootRate: string,
  missRate: string,
): { overshoot_rate?: number; miss_rate?: number } {
  const parsedOvershoot = Number.parseFloat(overshootRate);
  const parsedMiss = Number.parseFloat(missRate);
  const config: { overshoot_rate?: number; miss_rate?: number } = {};
  if (!Number.isNaN(parsedOvershoot)) {
    config.overshoot_rate = Math.min(1, Math.max(0, parsedOvershoot));
  }
  if (!Number.isNaN(parsedMiss)) {
    config.miss_rate = Math.min(1, Math.max(0, parsedMiss));
  }
  return config;
}
