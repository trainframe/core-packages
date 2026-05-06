import { useId, useState } from 'react';
import {
  type StoredLayoutSelection,
  parseLayoutJson,
  saveLayoutSelection,
} from '../config/layout-config.js';
import { PRESET_LAYOUTS, PRESET_LAYOUT_IDS, isPresetLayoutId } from '../sim/layouts.js';

interface LayoutConfigProps {
  /** Currently-applied selection (from App-level state). */
  readonly selection: StoredLayoutSelection;
  /** Called after the user saves a new selection. */
  readonly onChange: (next: StoredLayoutSelection) => void;
}

const DROPDOWN_CUSTOM = 'custom';

/**
 * Editor for the running simulation's layout. Pick a preset, or write your
 * own JSON (validated against the protocol Layout schema before saving).
 * Switching the layout rebuilds the SimRunner — running sims are stopped.
 */
export function LayoutConfig({ selection, onChange }: LayoutConfigProps) {
  const dropdownId = useId();
  const textareaId = useId();
  const [draftKind, setDraftKind] = useState<string>(
    selection.kind === 'preset' ? selection.preset_id : DROPDOWN_CUSTOM,
  );
  const [draftJson, setDraftJson] = useState<string>(() =>
    JSON.stringify(currentLayout(selection), null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  function handleDropdownChange(value: string) {
    setDraftKind(value);
    setError(null);
    if (isPresetLayoutId(value)) {
      setDraftJson(JSON.stringify(PRESET_LAYOUTS[value], null, 2));
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPresetLayoutId(draftKind)) {
      const next: StoredLayoutSelection = { kind: 'preset', preset_id: draftKind };
      saveLayoutSelection(next);
      onChange(next);
      setError(null);
      return;
    }
    const result = parseLayoutJson(draftJson);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const next: StoredLayoutSelection = { kind: 'custom', layout: result.layout };
    saveLayoutSelection(next);
    onChange(next);
    setError(null);
  }

  const isCustom = draftKind === DROPDOWN_CUSTOM;

  return (
    <form onSubmit={handleSubmit} aria-label="Layout configuration">
      <h2>Layout</h2>
      <div>
        <label htmlFor={dropdownId}>Source</label>
        <select
          id={dropdownId}
          value={draftKind}
          onChange={(e) => handleDropdownChange(e.target.value)}
        >
          {PRESET_LAYOUT_IDS.map((id) => (
            <option key={id} value={id}>
              Preset · {id}
            </option>
          ))}
          <option value={DROPDOWN_CUSTOM}>Custom JSON</option>
        </select>
      </div>
      {isCustom ? (
        <div>
          <label htmlFor={textareaId}>Layout JSON</label>
          <textarea
            id={textareaId}
            value={draftJson}
            onChange={(e) => setDraftJson(e.target.value)}
            rows={14}
            cols={60}
            spellCheck={false}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-testid="layout-error">
          {error}
        </p>
      ) : null}
      <button type="submit">Apply layout</button>
    </form>
  );
}

function currentLayout(selection: StoredLayoutSelection) {
  if (selection.kind === 'preset') return PRESET_LAYOUTS[selection.preset_id];
  return selection.layout;
}
