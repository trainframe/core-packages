import type { Layout } from '@trainframe/protocol';
import { useEffect, useMemo, useState } from 'react';
import { useSimRunner } from '../sim/use-sim-runner.js';

const STEP_MS = 1000;

interface SimControlsProps {
  /** Layout the simulation is running against. Switching layouts rebuilds the runner. */
  readonly layout: Layout;
}

/**
 * Operator panel for driving an in-browser simulation. The operator builds
 * a route marker by marker — starting with any layout marker, then only
 * markers reachable along an outgoing edge from the route's tail — and
 * spawns trains onto that route. All captured events are published through
 * the configured MQTT broker.
 */
export function SimControls({ layout }: SimControlsProps) {
  const { snapshot, start, resume, pause, stop, step, spawnTrain, assignRoute } = useSimRunner(
    layout,
    100,
  );

  const isIdle = snapshot.status === 'idle';
  const hasAnyEdges = layout.edges.length > 0;

  const computedNextId = `T${snapshot.train_ids.length + 1}`;
  const [trainId, setTrainId] = useState(computedNextId);
  const [overshootRate, setOvershootRate] = useState('0');
  const [missRate, setMissRate] = useState('0.01');
  const [spawnError, setSpawnError] = useState<string | null>(null);
  /** Markers in order the operator has chosen them. Length >= 2 = valid route. */
  const [routeMarkers, setRouteMarkers] = useState<string[]>([]);
  /** The marker the operator has currently selected in the dropdown. */
  const [nextMarker, setNextMarker] = useState<string>('');

  // Reset the route builder when the layout changes; old marker IDs may not
  // exist on the new layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout identity is the trigger
  useEffect(() => {
    setRouteMarkers([]);
    setNextMarker('');
  }, [layout]);

  // Compute the options the dropdown should show. If the route is empty,
  // any marker is a valid starting point. Otherwise only markers reachable
  // along an outgoing edge from the last marker in the route are valid.
  const dropdownOptions = useMemo<ReadonlyArray<string>>(() => {
    if (routeMarkers.length === 0) {
      return layout.markers.map((m) => m.id);
    }
    const tail = routeMarkers[routeMarkers.length - 1];
    if (tail === undefined) return [];
    return layout.edges.filter((e) => e.from_marker_id === tail).map((e) => e.to_marker_id);
  }, [layout, routeMarkers]);

  // Keep `nextMarker` consistent with the options list — when options change
  // (route grew/shrunk or layout swapped), default to the first option so
  // the operator can keep clicking Add without re-selecting.
  useEffect(() => {
    if (dropdownOptions.length === 0) {
      setNextMarker('');
      return;
    }
    if (!dropdownOptions.includes(nextMarker)) {
      setNextMarker(dropdownOptions[0] ?? '');
    }
  }, [dropdownOptions, nextMarker]);

  const routeEdges = useMemo<ReadonlyArray<{ from_marker_id: string; to_marker_id: string }>>(
    () =>
      routeMarkers
        .slice(0, -1)
        .map((from, i) => ({ from_marker_id: from, to_marker_id: routeMarkers[i + 1] ?? '' })),
    [routeMarkers],
  );

  // When the train list empties (Stop), reset the form's Train ID so the
  // operator's next spawn doesn't start at the last auto-incremented value
  // and skip over T1.
  useEffect(() => {
    if (snapshot.train_ids.length === 0) setTrainId('T1');
  }, [snapshot.train_ids.length]);

  const canSpawn = routeEdges.length >= 1;

  function handleAddMarker() {
    if (nextMarker === '') return;
    if (!dropdownOptions.includes(nextMarker)) return;
    setRouteMarkers([...routeMarkers, nextMarker]);
  }

  function handleRemoveLast() {
    setRouteMarkers(routeMarkers.slice(0, -1));
  }

  function handleClearRoute() {
    setRouteMarkers([]);
  }

  function handleSpawn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSpawn) return;
    const firstEdge = routeEdges[0];
    if (!firstEdge) return;

    const parsedOvershoot = Number.parseFloat(overshootRate);
    const parsedMiss = Number.parseFloat(missRate);
    const config: { overshoot_rate?: number; miss_rate?: number } = {};
    if (!Number.isNaN(parsedOvershoot))
      config.overshoot_rate = Math.min(1, Math.max(0, parsedOvershoot));
    if (!Number.isNaN(parsedMiss)) config.miss_rate = Math.min(1, Math.max(0, parsedMiss));

    if (isIdle) start();
    const spawned = spawnTrain(trainId, firstEdge, config);

    if (!spawned) {
      setSpawnError(`Train ${trainId} already exists. Choose a different ID.`);
      return;
    }

    setSpawnError(null);
    assignRoute(trainId, routeEdges);
    // Pressing Spawn from idle implies "begin" — auto-resume so the train
    // moves without a second click. If the operator manually paused, respect
    // that: add the train but leave the sim paused for them to inspect.
    if (isIdle) resume();

    // Advance train_id to the next default after a successful spawn
    setTrainId(`T${snapshot.train_ids.length + 2}`);
  }

  const firstMarkerLabel = routeMarkers.length === 0 ? 'First marker' : 'Next marker';

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
              {firstMarkerLabel}{' '}
              <select
                value={nextMarker}
                onChange={(e) => setNextMarker(e.target.value)}
                disabled={dropdownOptions.length === 0}
              >
                {dropdownOptions.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>{' '}
            <button
              type="button"
              onClick={handleAddMarker}
              disabled={nextMarker === '' || dropdownOptions.length === 0}
            >
              Add to route
            </button>{' '}
            <button type="button" onClick={handleRemoveLast} disabled={routeMarkers.length === 0}>
              Remove last
            </button>{' '}
            <button type="button" onClick={handleClearRoute} disabled={routeMarkers.length === 0}>
              Clear route
            </button>
          </div>
          {routeMarkers.length > 0 && (
            <ol aria-label="Planned route">
              {routeMarkers.map((markerId, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity of a route step
                <li key={`${markerId}-${i}`}>{markerId}</li>
              ))}
            </ol>
          )}
          <button type="submit" disabled={!canSpawn}>
            Spawn train
          </button>
        </form>
        {!hasAnyEdges && (
          <p data-testid="spawn-disabled-hint">
            Add at least one edge to the layout to spawn a train.
          </p>
        )}
        {hasAnyEdges && !canSpawn && (
          <p data-testid="spawn-route-hint">
            Pick a first marker and at least one onward marker to build a route.
          </p>
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
