import { Button, Panel } from '@trainframe/ui-kit';
import { useEffect, useId, useMemo, useState } from 'react';
import { useBroker } from '../broker/broker-context.js';
import { useLayoutState } from '../state/use-layout-state.js';
import { useRegisteredTrains } from '../state/use-registered-trains.js';
import { useScheduleState } from '../state/use-schedule-state.js';

/**
 * Operator-side schedule editor. Lives on the visualiser per ADR-013 —
 * schedule assignment is operator intent against the *system*, not a
 * physical action on the track. Publishes the chosen stops on
 * `railway/operator/assign_schedule`, where both the in-browser SimRunner
 * (embedded mode) and `@trainframe/server` (production) subscribe.
 *
 * Hidden when there are no trains and no layout — nothing useful to do.
 */
export function ScheduleAssigner() {
  const layout = useLayoutState();
  const trains = useRegisteredTrains();
  const schedules = useScheduleState();
  const { client } = useBroker();
  const trainSelectId = useId();
  const stopSelectId = useId();

  const [trainId, setTrainId] = useState('');
  const [stops, setStops] = useState<string[]>([]);
  const [nextStop, setNextStop] = useState('');
  const [sent, setSent] = useState<{ trainId: string; stops: ReadonlyArray<string> } | null>(null);

  const markerOptions = useMemo<ReadonlyArray<string>>(
    () => (layout ? layout.markers.map((m) => m.id) : []),
    [layout],
  );

  // Keep the train selection valid as the train list changes.
  useEffect(() => {
    if (trains.length === 0) {
      if (trainId !== '') setTrainId('');
      return;
    }
    if (!trains.includes(trainId)) setTrainId(trains[0] ?? '');
  }, [trains, trainId]);

  // Default the marker dropdown to the first marker so the operator can
  // tap Add repeatedly.
  useEffect(() => {
    if (markerOptions.length === 0) {
      if (nextStop !== '') setNextStop('');
      return;
    }
    if (!markerOptions.includes(nextStop)) setNextStop(markerOptions[0] ?? '');
  }, [markerOptions, nextStop]);

  if (!layout || trains.length === 0) return null;

  const canSubmit = trainId !== '' && stops.length >= 1;

  function handleAddStop() {
    if (nextStop === '') return;
    setStops([...stops, nextStop]);
  }

  function handleRemoveLast() {
    setStops(stops.slice(0, -1));
  }

  function handleClear() {
    setStops([]);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    const payload = {
      train_id: trainId,
      route_id: `op-${Date.now().toString(36)}`,
      stops,
    };
    client.publish(
      'railway/operator/assign_schedule',
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    setSent({ trainId, stops: [...stops] });
    setStops([]);
  }

  const currentSchedule = schedules.get(trainId);

  return (
    <Panel label="Assign schedule" data-testid="schedule-assigner">
      <form onSubmit={handleSubmit}>
        <div className="tf-vis-schedule-assigner__row">
          <label htmlFor={trainSelectId}>Train</label>
          <select id={trainSelectId} value={trainId} onChange={(e) => setTrainId(e.target.value)}>
            {trains.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {currentSchedule ? (
            <span className="tf-vis-schedule-assigner__hint">
              currently: {currentSchedule.stops.join(' → ')}
            </span>
          ) : (
            <span className="tf-vis-schedule-assigner__hint">no schedule yet</span>
          )}
        </div>
        <div className="tf-vis-schedule-assigner__stops-row">
          <label htmlFor={stopSelectId}>{stops.length === 0 ? 'First stop' : 'Next stop'}</label>{' '}
          <select
            id={stopSelectId}
            value={nextStop}
            onChange={(e) => setNextStop(e.target.value)}
            disabled={markerOptions.length === 0}
          >
            {markerOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>{' '}
          <Button
            type="button"
            variant="secondary"
            onClick={handleAddStop}
            disabled={nextStop === ''}
          >
            Add stop
          </Button>{' '}
          <Button
            type="button"
            variant="secondary"
            onClick={handleRemoveLast}
            disabled={stops.length === 0}
          >
            Remove last
          </Button>{' '}
          <Button
            type="button"
            variant="secondary"
            onClick={handleClear}
            disabled={stops.length === 0}
          >
            Clear
          </Button>
        </div>
        {stops.length > 0 && (
          <ol aria-label="Pending stops" className="tf-vis-schedule-assigner__stops-row">
            {stops.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity of a stop in the list
              <li key={`${s}-${i}`}>{s}</li>
            ))}
          </ol>
        )}
        <div className="tf-vis-schedule-assigner__submit-row">
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            Assign
          </Button>
          {sent !== null && (
            <span className="tf-vis-schedule-assigner__sent" data-testid="schedule-assigner-sent">
              Sent {sent.stops.join(' → ')} to {sent.trainId}
            </span>
          )}
        </div>
      </form>
    </Panel>
  );
}
