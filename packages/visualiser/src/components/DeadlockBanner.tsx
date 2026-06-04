import { Button } from '@trainframe/ui-kit';
import { useBroker } from '../broker/broker-context.js';
import { useDeadlockState } from '../state/use-deadlock-state.js';
import { trainColor } from '../train-color.js';

/**
 * Surface the scheduler's waits-for cycle detection as an operator-visible
 * banner. Renders nothing when there's no active deadlock; renders a
 * coloured warning strip listing the involved trains otherwise. Each
 * train id is shown in its own hue so the operator can immediately see
 * which trains are mutually blocking.
 *
 * The scheduler can't *resolve* the deadlock — it's a topology problem in
 * the general case — but the operator can usually break the cycle by
 * revoking one train's clearance. The "Break here" button per train
 * publishes `railway/operator/revoke_clearance` for that train; the
 * scheduler then drops its cleared edges and retries the other trains in
 * the cycle.
 */
export function DeadlockBanner() {
  const trains = useDeadlockState();
  const { client } = useBroker();
  if (trains.length === 0) return null;

  const revoke = (trainId: string) => {
    client.publish(
      'railway/operator/revoke_clearance',
      new TextEncoder().encode(JSON.stringify({ train_id: trainId })),
    );
  };

  return (
    <div role="alert" data-testid="deadlock-banner" className="tf-vis-deadlock-banner">
      <div>
        <span className="tf-vis-deadlock-banner__heading">⚠ Deadlock detected:</span>{' '}
        {trains.map((trainId, i) => (
          <span key={trainId}>
            <span
              data-train-id={trainId}
              style={{ color: trainColor(trainId), padding: '0 0.25rem' }}
            >
              {trainId}
            </span>
            {i < trains.length - 1 ? ' ↔ ' : ''}
          </span>
        ))}{' '}
        <span className="tf-vis-deadlock-banner__desc">
          — both trains are waiting on a section the other holds.
        </span>
      </div>
      <div className="tf-vis-deadlock-banner__actions">
        {trains.map((trainId) => (
          <Button
            key={trainId}
            variant="danger"
            onClick={() => revoke(trainId)}
            data-testid={`deadlock-break-${trainId}`}
          >
            Revoke {trainId}
          </Button>
        ))}
      </div>
    </div>
  );
}
