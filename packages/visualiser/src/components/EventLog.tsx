import { useEventLog } from '../events/use-event-log.js';

/**
 * Live event log. Subscribes to all railway events on the broker and renders
 * the most recent entries. Newest first.
 */
export function EventLog() {
  const entries = useEventLog();
  const sorted = [...entries].reverse();

  return (
    <section aria-label="Event log">
      <h2>Live events</h2>
      {sorted.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ol>
          {sorted.map((entry) => (
            <li key={entry.id}>
              <time dateTime={entry.received_at.toISOString()}>
                {entry.received_at.toLocaleTimeString()}
              </time>{' '}
              <strong>{entry.event_type || '(unknown)'}</strong>
              {entry.device_id ? ` · ${entry.device_id}` : null}
              {entry.kind === 'custom' && entry.vendor ? ` · vendor=${entry.vendor}` : null}
              <pre>{formatPayload(entry.payload)}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatPayload(payload: unknown): string {
  if (payload === null) return '';
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}
