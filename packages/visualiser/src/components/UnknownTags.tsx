import { type FormEvent, useEffect, useState } from 'react';
import { assignTag } from '../api/admin-client.js';
import { useLayoutState } from '../state/use-layout-state.js';
import { useUnknownTags } from '../state/use-unknown-tags.js';

interface UnknownTagsProps {
  /**
   * Base URL of the server's admin HTTP API. The operator points the
   * visualiser at the server they're managing; the Settings UI persists it.
   */
  readonly adminApiUrl: string;
}

/**
 * Operator affordance for ADR-007: when the scheduler reports an unknown
 * tag, surface a row with an "Assign" form so the operator can bind it to
 * an existing marker. The submission posts to `/api/tags`, which the
 * server forwards as a `tag_assignment` event on the wire.
 *
 * No-op when there are no pending unknown tags - keeps the page calm.
 */
export function UnknownTags({ adminApiUrl }: UnknownTagsProps) {
  const tags = useUnknownTags();
  const layout = useLayoutState();
  if (tags.length === 0) return null;

  return (
    <section aria-label="Unknown tags" data-testid="unknown-tags">
      <h2>Unknown tags</h2>
      <p>
        The scheduler saw these tags but doesn't know what they refer to. Bind each one to a marker.
      </p>
      <ul>
        {tags.map((tag) => (
          <li key={tag.tag_id} data-testid={`unknown-tag-${tag.tag_id}`}>
            <AssignRow tagId={tag.tag_id} adminApiUrl={adminApiUrl} layout={layout} />
          </li>
        ))}
      </ul>
    </section>
  );
}

interface AssignRowProps {
  readonly tagId: string;
  readonly adminApiUrl: string;
  readonly layout: ReturnType<typeof useLayoutState>;
}

function AssignRow({ tagId, adminApiUrl, layout }: AssignRowProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string>(layout?.markers[0]?.id ?? '');
  const [kind, setKind] = useState<'marker' | 'vehicle'>('marker');

  // The layout often arrives after the component mounts (retained-state
  // delivery is async). When it does, seed the select with the first marker
  // so the operator doesn't have to scroll-and-pick on every row.
  useEffect(() => {
    if (!targetId && layout?.markers[0]) {
      setTargetId(layout.markers[0].id);
    }
  }, [targetId, layout]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!targetId) {
      setError('Pick a target');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await assignTag(adminApiUrl, { tagId, kind, targetId });
      /* The row will disappear when railway/state/tags/<id> arrives via
         useUnknownTags; nothing else to do here. */
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label={`Assign tag ${tagId}`}>
      <span>
        <strong>{tagId}</strong>
      </span>
      <label>
        Kind
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'marker' | 'vehicle')}
          data-testid={`kind-${tagId}`}
        >
          <option value="marker">marker</option>
          <option value="vehicle">vehicle</option>
        </select>
      </label>
      <label>
        Target
        <select
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          data-testid={`target-${tagId}`}
        >
          {(layout?.markers ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={submitting} data-testid={`assign-${tagId}`}>
        {submitting ? 'Assigning…' : 'Assign'}
      </button>
      {error ? (
        <span role="alert" data-testid={`assign-error-${tagId}`}>
          {error}
        </span>
      ) : null}
    </form>
  );
}
