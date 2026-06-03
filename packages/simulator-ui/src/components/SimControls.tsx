import type { Layout } from '@trainframe/protocol';
import { Drawer } from '@trainframe/ui-kit';
import { useEffect, useMemo, useState } from 'react';
import { useSimRunner } from '../sim/use-sim-runner.js';

const STEP_MS = 1000;

interface SimControlsProps {
  /** Layout the simulation is running against. Switching layouts rebuilds the runner. */
  readonly layout: Layout;
}

/**
 * Operator panel for placing a train on the simulated track. Per ADR-013
 * the simulator-ui is the *physical-twin* surface: the operator picks
 * **where on the track** to put the train (a starting position), and
 * that's it. Schedules are operator intents against the Trainframe
 * *system* — they live on the visualiser and are pushed across the bus
 * via `railway/operator/assign_schedule`. Until a schedule arrives, the
 * spawned train sits where it was placed, which is exactly how a real
 * wooden train behaves when set down on a track.
 *
 * Fault-injection knobs (overshoot/miss rates, train length) are
 * developer affordances — they would be physical wear-and-tear properties
 * IRL — and live behind a collapsed "Developer" drawer.
 */
export function SimControls({ layout }: SimControlsProps) {
  const { snapshot, start, resume, pause, stop, step, spawnTrain } = useSimRunner(layout, 100);

  const isIdle = snapshot.status === 'idle';
  const hasAnyMarkers = layout.markers.length > 0;

  const computedNextId = `T${snapshot.train_ids.length + 1}`;
  const [trainId, setTrainId] = useState(computedNextId);
  const [overshootRate, setOvershootRate] = useState('0');
  const [missRate, setMissRate] = useState('0.01');
  const [lengthMm, setLengthMm] = useState('0');
  const [spawnError, setSpawnError] = useState<string | null>(null);
  /** Marker where the train should be physically placed. */
  const [startMarker, setStartMarker] = useState<string>('');

  // Reset the starting position when the layout changes; the old marker
  // ID may not exist on the new layout.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout identity is the trigger
  useEffect(() => {
    setStartMarker('');
  }, [layout]);

  // Markers that have at least one outgoing edge — these are valid spawn
  // positions because the train needs an edge to sit on.
  const placementMarkers = useMemo<ReadonlyArray<string>>(
    () =>
      layout.markers
        .filter((m) => layout.edges.some((e) => e.from_marker_id === m.id))
        .map((m) => m.id),
    [layout],
  );

  useEffect(() => {
    if (placementMarkers.length === 0) {
      setStartMarker('');
      return;
    }
    if (!placementMarkers.includes(startMarker)) {
      setStartMarker(placementMarkers[0] ?? '');
    }
  }, [placementMarkers, startMarker]);

  // When the train list empties (Stop), reset the form's Train ID so the
  // operator's next spawn doesn't skip over T1.
  useEffect(() => {
    if (snapshot.train_ids.length === 0) setTrainId('T1');
  }, [snapshot.train_ids.length]);

  const canSpawn = startMarker !== '';

  function handleSpawn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSpawn) return;

    const startEdge = layout.edges.find((edge) => edge.from_marker_id === startMarker);
    if (!startEdge) {
      setSpawnError(
        `Marker ${startMarker} has no outgoing edge — the train would have nowhere to go from here.`,
      );
      return;
    }

    if (isIdle) start();
    const spawned = spawnTrain(
      trainId,
      startEdge,
      buildTrainConfig(overshootRate, missRate, lengthMm),
    );
    if (!spawned) {
      setSpawnError(`Train ${trainId} already exists. Choose a different ID.`);
      return;
    }

    setSpawnError(null);
    // Pressing Spawn from idle implies "begin" — auto-resume so the sim
    // is alive even though the train won't move yet. The visualiser
    // operator assigns the schedule that actually gets the train moving.
    if (isIdle) resume();

    // Advance the default Train ID after a successful spawn.
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
            Starting position{' '}
            <select
              value={startMarker}
              onChange={(e) => setStartMarker(e.target.value)}
              disabled={placementMarkers.length === 0}
              data-testid="spawn-position"
            >
              {placementMarkers.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>{' '}
          <button type="submit" disabled={!canSpawn}>
            Spawn train
          </button>
        </form>
        {!hasAnyMarkers && (
          <p data-testid="spawn-disabled-hint">
            Add at least one marker to the layout to spawn a train.
          </p>
        )}
        {hasAnyMarkers && placementMarkers.length === 0 && (
          <p data-testid="spawn-stops-hint">
            None of the markers have an outgoing edge — connect them first.
          </p>
        )}
        {spawnError !== null && (
          <p role="alert" data-testid="spawn-error">
            {spawnError}
          </p>
        )}
      </fieldset>
      <Drawer label="Developer" defaultOpen={false}>
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
          <legend>Fault rates</legend>
          <p style={{ fontSize: '0.85em', color: 'var(--tf-color-fg-muted)' }}>
            Applied to the next spawn. These would be physical wear-and-tear properties IRL.
          </p>
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
          <label>
            Train length (mm){' '}
            <input
              type="number"
              value={lengthMm}
              onChange={(e) => setLengthMm(e.target.value)}
              min="0"
              step="1"
            />
          </label>
        </fieldset>
      </Drawer>
    </section>
  );
}

function buildTrainConfig(
  overshootRate: string,
  missRate: string,
  lengthMm: string,
): { overshoot_rate?: number; miss_rate?: number; length_mm?: number } {
  const parsedOvershoot = Number.parseFloat(overshootRate);
  const parsedMiss = Number.parseFloat(missRate);
  const parsedLength = Number.parseFloat(lengthMm);
  const config: { overshoot_rate?: number; miss_rate?: number; length_mm?: number } = {};
  if (!Number.isNaN(parsedOvershoot)) {
    config.overshoot_rate = Math.min(1, Math.max(0, parsedOvershoot));
  }
  if (!Number.isNaN(parsedMiss)) {
    config.miss_rate = Math.min(1, Math.max(0, parsedMiss));
  }
  if (!Number.isNaN(parsedLength)) {
    config.length_mm = Math.max(0, parsedLength);
  }
  return config;
}
