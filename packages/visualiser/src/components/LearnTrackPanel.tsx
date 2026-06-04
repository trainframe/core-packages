import { Button, Panel } from '@trainframe/ui-kit';
import { useBroker } from '../broker/broker-context.js';
import {
  type TrackLearningState,
  useTrackLearningState,
} from '../state/use-track-learning-state.js';

/**
 * Operator-facing track-learn control. Renders a single button (Learn track /
 * Stop learning) and a status pill describing the current learn-mode state.
 *
 * Lives on the visualiser per ADR-013: bootstrapping the edge graph is an
 * operator intent against the *system*, not a physical action on the table.
 * The simulator-ui never carries a button like this.
 */
export function LearnTrackPanel() {
  const { client } = useBroker();
  const state = useTrackLearningState();

  const isActive = state.state !== 'idle';
  const buttonLabel = isActive ? 'Stop learning' : 'Learn track';

  function handleClick() {
    const topic = isActive
      ? 'railway/operator/learn_track_stop'
      : 'railway/operator/learn_track_start';
    client.publish(topic, new TextEncoder().encode(JSON.stringify({})));
  }

  return (
    <Panel label="Track learning" data-testid="learn-track-panel">
      <div className="tf-vis-learn-track__row">
        <Button
          type="button"
          variant={isActive ? 'secondary' : 'primary'}
          onClick={handleClick}
          data-testid="learn-track-button"
        >
          {buttonLabel}
        </Button>
        <span
          data-testid="learn-track-status"
          data-state={state.state}
          className="tf-vis-learn-track__status"
        >
          {describe(state)}
        </span>
      </div>
    </Panel>
  );
}

function describe(state: TrackLearningState): string {
  switch (state.state) {
    case 'idle':
      return 'Idle. Click Learn track to bootstrap the layout.';
    case 'waiting_for_train':
      return 'Place a single train on the track and scan it.';
    case 'driving':
      return describeDriving(state);
    case 'paused_terminus':
      return describePausedTerminus(state);
    case 'complete':
      return describeComplete(state);
  }
}

function describeDriving(state: TrackLearningState): string {
  const who = state.train_id ?? 'train';
  const count = state.markers_visited ?? 0;
  return `Learning… ${who} has visited ${count} marker${count === 1 ? '' : 's'}.`;
}

function describePausedTerminus(state: TrackLearningState): string {
  const who = state.train_id ?? 'train';
  return `${who} hit a dead end. Pick it up and place it on a new section of track, then scan it again.`;
}

function describeComplete(state: TrackLearningState): string {
  const markers = state.markers_visited ?? 0;
  const edges = state.edges_learned ?? 0;
  return `Done! Your track has ${markers} marker${markers === 1 ? '' : 's'} and ${edges} edge${edges === 1 ? '' : 's'}. You can now assign schedules.`;
}
