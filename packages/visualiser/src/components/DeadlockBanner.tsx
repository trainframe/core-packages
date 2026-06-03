import { useDeadlockState } from '../state/use-deadlock-state.js';
import { trainColor } from '../train-color.js';

/**
 * Surface the scheduler's waits-for cycle detection as an operator-visible
 * banner. Renders nothing when there's no active deadlock; renders a
 * coloured warning strip listing the involved trains otherwise. Each train
 * id is shown in its own hue so the operator can immediately see which two
 * (or more) trains are mutually blocking.
 *
 * The scheduler can't *resolve* the deadlock — it's a topology problem,
 * fixed by adding markers or sidings. The banner makes it obvious enough
 * that the operator can decide what to do.
 */
export function DeadlockBanner() {
  const trains = useDeadlockState();
  if (trains.length === 0) return null;

  return (
    <div
      role="alert"
      data-testid="deadlock-banner"
      style={{
        backgroundColor: '#fff4e0',
        border: '2px solid #b04500',
        padding: '0.75rem 1rem',
        margin: '0.5rem 0',
        borderRadius: '4px',
        fontWeight: 'bold',
      }}
    >
      <span style={{ color: '#b04500' }}>⚠ Deadlock detected:</span>{' '}
      {trains.map((trainId, i) => (
        <span key={trainId}>
          <span
            data-train-id={trainId}
            style={{
              color: trainColor(trainId),
              padding: '0 0.25rem',
            }}
          >
            {trainId}
          </span>
          {i < trains.length - 1 ? ' ↔ ' : ''}
        </span>
      ))}{' '}
      <span style={{ fontWeight: 'normal', color: '#555' }}>
        — both trains are waiting on a section the other holds. Revoke one train's clearance from
        the admin API to break the cycle, or add intermediate markers / a passing siding to the
        layout.
      </span>
    </div>
  );
}
