import { Button, Panel } from '@trainframe/ui-kit';
import type { CommissionCategory, CommissionItem } from '../state/use-commissioning.js';
import { useCommissioning } from '../state/use-commissioning.js';

/**
 * Operator-facing device COMMISSIONING (garage setup). When a real device or a
 * track tag appears on the bus it carries only its self-declared facts; here the
 * operator classifies it (Track / Train / Device) and — for a train — enters its
 * measured length, then confirms. NO naming (ADR-035): a device self-declares
 * its kind and track is just track, so naming every piece is needless friction.
 * The logic lives in the headless `CommissioningView` (so the e-paper frontend
 * binds the same thing); this is the React View. WHERE a track's marker sits is
 * discovered later by driving.
 */
export function CommissioningPanel() {
  const c = useCommissioning();
  return (
    <Panel label="Commission devices" data-testid="commissioning-panel">
      {c.pending.length === 0 ? (
        <p className="tf-vis-commissioning__empty" data-testid="commissioning-empty">
          Nothing to set up. Scan a device or track piece to commission it.
        </p>
      ) : (
        <ul className="tf-vis-commissioning__list">
          {c.pending.map((item) => (
            <CommissionRow key={item.id} item={item} c={c} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

const CATEGORIES: ReadonlyArray<CommissionCategory> = ['train', 'track', 'device'];

function CommissionRow({
  item,
  c,
}: {
  item: CommissionItem;
  c: ReturnType<typeof useCommissioning>;
}) {
  return (
    <li className="tf-vis-commissioning__item" data-testid={`commission-item-${item.id}`}>
      <span className="tf-vis-commissioning__id">{item.id}</span>
      <select
        aria-label="Category"
        data-testid={`commission-category-${item.id}`}
        value={item.category}
        onChange={(e) => c.classify(item.id, e.target.value as CommissionCategory)}
      >
        {CATEGORIES.map((cat) => (
          <option key={cat} value={cat}>
            {cat}
          </option>
        ))}
      </select>
      {/* No operator NAME prompt (ADR-035): naming every piece is friction a
          child shouldn't face — a device self-declares its kind, and track is
          just track. The operator only classifies + (for a train) measures. */}
      {item.category === 'train' && (
        <input
          type="number"
          min={0}
          placeholder="Length (mm)"
          aria-label="Measured length in millimetres"
          data-testid={`commission-length-${item.id}`}
          value={item.trainLengthMm ?? ''}
          onChange={(e) => c.setTrainLength(item.id, Number(e.target.value))}
        />
      )}
      {item.category === 'track' && (
        <input
          type="text"
          placeholder="Marker id"
          aria-label="Marker this tag binds"
          data-testid={`commission-marker-${item.id}`}
          value={item.markerId ?? ''}
          onChange={(e) => c.bindTagToMarker(item.id, e.target.value)}
        />
      )}
      <Button
        type="button"
        variant="primary"
        data-testid={`commission-confirm-${item.id}`}
        disabled={
          item.category === 'train' && !(item.trainLengthMm !== undefined && item.trainLengthMm > 0)
        }
        onClick={() => c.confirm(item.id)}
      >
        Confirm
      </Button>
      <Button
        type="button"
        variant="secondary"
        data-testid={`commission-dismiss-${item.id}`}
        onClick={() => c.dismiss(item.id)}
      >
        Dismiss
      </Button>
    </li>
  );
}
