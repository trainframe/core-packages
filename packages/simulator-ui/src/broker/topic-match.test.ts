import { describe, expect, it } from 'vitest';
import { matchesTopic } from './topic-match.js';

describe('matchesTopic', () => {
  it('matches identical concrete topics', () => {
    expect(matchesTopic('railway/commands/T1', 'railway/commands/T1')).toBe(true);
  });

  it('does not match different concrete topics', () => {
    expect(matchesTopic('railway/commands/T1', 'railway/commands/T2')).toBe(false);
  });

  it('matches a trailing # against any deeper topic', () => {
    // The regression that froze the train: the bridge subscribes to
    // `railway/commands/#`; a concrete command topic must match it.
    expect(matchesTopic('railway/commands/#', 'railway/commands/T-train-9')).toBe(true);
    expect(matchesTopic('railway/commands/#', 'railway/commands/GATE-1/extra')).toBe(true);
  });

  it('matches # at the root', () => {
    expect(matchesTopic('#', 'railway/events/train_status/T1')).toBe(true);
  });

  it('matches a single-level + wildcard', () => {
    expect(matchesTopic('railway/+/T1', 'railway/commands/T1')).toBe(true);
    expect(matchesTopic('railway/+/T1', 'railway/events/T1')).toBe(true);
  });

  it('does not let + span multiple levels', () => {
    expect(matchesTopic('railway/+/T1', 'railway/commands/sub/T1')).toBe(false);
  });

  it('does not match when the concrete topic is shorter than the filter', () => {
    expect(matchesTopic('railway/commands/T1', 'railway/commands')).toBe(false);
    expect(matchesTopic('railway/commands/+', 'railway/commands')).toBe(false);
  });

  it('a # filter still requires the prefix levels to match', () => {
    expect(matchesTopic('railway/commands/#', 'railway/events/T1')).toBe(false);
  });
});
