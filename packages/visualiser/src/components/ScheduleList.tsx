import { useScheduleState } from '../state/use-schedule-state.js';
import { trainColor } from '../train-color.js';

/**
 * Renders the active train schedules. Each row shows a train ID in its
 * hue followed by the list of stops it cycles through; the current target
 * stop (where the train is heading next) is bolded so the operator can
 * see at a glance what each train is doing.
 *
 * Hidden when no trains have a schedule.
 */
export function ScheduleList() {
  const schedules = useScheduleState();
  if (schedules.size === 0) return null;

  // Stable order by train ID so the list doesn't shuffle between renders.
  const rows = [...schedules.values()].sort((a, b) => a.train_id.localeCompare(b.train_id));

  return (
    <section aria-label="Train schedules" data-testid="schedule-list">
      <h2>Schedules</h2>
      <ul className="tf-vis-schedule-list">
        {rows.map((row) => (
          <li
            key={row.train_id}
            data-schedule-train-id={row.train_id}
            className="tf-vis-schedule-list__row"
          >
            <span style={{ color: trainColor(row.train_id), fontWeight: 'bold' }}>
              {row.train_id}
            </span>
            <span>
              {row.stops.map((stop, i) => (
                <span key={`${row.train_id}-${i}-${stop}`}>
                  {i > 0 ? ' → ' : ''}
                  <span
                    data-target={i === row.current_stop_index ? 'true' : undefined}
                    style={{
                      fontWeight: i === row.current_stop_index ? 'bold' : 'normal',
                      textDecoration: i === row.current_stop_index ? 'underline' : 'none',
                    }}
                  >
                    {stop}
                  </span>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
