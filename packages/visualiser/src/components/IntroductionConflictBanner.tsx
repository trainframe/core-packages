import { useIntroductionConflict } from '../state/use-introduction-conflict.js';
import { trainColor } from '../train-color.js';

/**
 * Banner shown when a train-introduction attempt fails because the contested
 * block is already occupied (ADR-036 §5). Guides the operator to move the
 * blocking train so the introduction can proceed.
 *
 * Renders nothing when no conflict has been seen.
 */
export function IntroductionConflictBanner() {
  const conflict = useIntroductionConflict();
  if (conflict === null) return null;

  return (
    <div
      role="alert"
      data-testid="introduction-conflict-banner"
      className="tf-vis-intro-conflict-banner"
    >
      <div>
        <span className="tf-vis-intro-conflict-banner__heading">⚠ Introduction conflict:</span>{' '}
        <span
          data-train-id={conflict.train_id}
          style={{ color: trainColor(conflict.train_id), padding: '0 0.25rem' }}
        >
          {conflict.train_id}
        </span>
        {' cannot introduce — block '}
        <code>
          {conflict.block_edge.from_marker_id} → {conflict.block_edge.to_marker_id}
        </code>
        {' is held by '}
        <span
          data-train-id={conflict.conflicting_train_id}
          style={{ color: trainColor(conflict.conflicting_train_id), padding: '0 0.25rem' }}
        >
          {conflict.conflicting_train_id}
        </span>
        {'.'}
      </div>
      <div className="tf-vis-intro-conflict-banner__desc">
        Move{' '}
        <span style={{ color: trainColor(conflict.conflicting_train_id) }}>
          {conflict.conflicting_train_id}
        </span>{' '}
        off the contested block, then introduce{' '}
        <span style={{ color: trainColor(conflict.train_id) }}>{conflict.train_id}</span> again.
      </div>
    </div>
  );
}
