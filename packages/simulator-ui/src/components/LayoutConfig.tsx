import type { Layout, LayoutEdge, LayoutJunction, LayoutMarker } from '@trainframe/protocol';
import { useEffect, useId, useState } from 'react';
import {
  type StoredLayoutSelection,
  checkLayoutReferentialIntegrity,
  parseLayoutJson,
  saveLayoutSelection,
} from '../config/layout-config.js';
import { PRESET_LAYOUTS, PRESET_LAYOUT_IDS, isPresetLayoutId } from '../sim/layouts.js';
import { TrackBuilder } from './TrackBuilder.js';

interface LayoutConfigProps {
  /** Currently-applied selection (from App-level state). */
  readonly selection: StoredLayoutSelection;
  /** Called after the user saves a new selection. */
  readonly onChange: (next: StoredLayoutSelection) => void;
}

const DROPDOWN_CUSTOM = 'custom';
const DROPDOWN_BUILD = 'build';
const DROPDOWN_TRACK_BUILDER = 'track-builder';

const MARKER_KINDS = [
  'block_boundary',
  'station_stop',
  'junction',
  'terminus',
  'yard_entry',
  'unspecified',
] as const;
type MarkerKind = (typeof MARKER_KINDS)[number];

const DEFAULT_JUNCTION_POSITIONS = ['main', 'divert'] as const;

interface BuilderState {
  readonly name: string;
  readonly markers: readonly LayoutMarker[];
  readonly edges: readonly LayoutEdge[];
  readonly junctions: readonly LayoutJunction[];
}

const EMPTY_BUILDER: BuilderState = {
  name: 'my-track',
  markers: [],
  edges: [],
  junctions: [],
};

/**
 * Editor for the running simulation's layout. Pick a preset, paste JSON, or
 * assemble the layout entity-by-entity with the Build form. Switching the
 * layout rebuilds the SimRunner — running sims are stopped.
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
  const [builder, setBuilder] = useState<BuilderState>(() => builderFromSelection(selection));
  const [error, setError] = useState<string | null>(null);

  function handleDropdownChange(value: string) {
    setDraftKind(value);
    setError(null);
    if (isPresetLayoutId(value)) {
      setDraftJson(JSON.stringify(PRESET_LAYOUTS[value], null, 2));
    }
    if (value === DROPDOWN_BUILD) {
      setBuilder(builderFromSelection(selection));
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
    if (draftKind === DROPDOWN_BUILD) {
      const layout: Layout = {
        name: builder.name,
        markers: [...builder.markers],
        edges: [...builder.edges],
        junctions: [...builder.junctions],
      };
      const integrityError = checkLayoutReferentialIntegrity(layout);
      if (integrityError !== null) {
        setError(integrityError);
        return;
      }
      const next: StoredLayoutSelection = { kind: 'custom', layout };
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
  const isBuild = draftKind === DROPDOWN_BUILD;
  const isTrackBuilder = draftKind === DROPDOWN_TRACK_BUILDER;

  function handleTrackBuilderApply(layout: Layout) {
    const next: StoredLayoutSelection = { kind: 'custom', layout };
    saveLayoutSelection(next);
    onChange(next);
    setError(null);
  }

  // When the track-builder mode is active its own Apply button drives the flow,
  // so we suppress the outer form submit to avoid ambiguous double-apply.
  if (isTrackBuilder) {
    return (
      <div aria-label="Layout configuration">
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
            <option value={DROPDOWN_BUILD}>Build (step-by-step)</option>
            <option value={DROPDOWN_TRACK_BUILDER}>Track builder (visual)</option>
          </select>
        </div>
        <TrackBuilder onApply={handleTrackBuilderApply} />
      </div>
    );
  }

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
          <option value={DROPDOWN_BUILD}>Build (step-by-step)</option>
          <option value={DROPDOWN_TRACK_BUILDER}>Track builder (visual)</option>
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
      {isBuild ? <BuildForm state={builder} onChange={setBuilder} /> : null}
      {error ? (
        <p role="alert" data-testid="layout-error">
          {error}
        </p>
      ) : null}
      <button type="submit">Apply layout</button>
    </form>
  );
}

interface BuildFormProps {
  readonly state: BuilderState;
  readonly onChange: (next: BuilderState) => void;
}

function BuildForm({ state, onChange }: BuildFormProps) {
  const nameId = useId();
  return (
    <fieldset aria-label="Track builder">
      <legend>Track builder</legend>
      <div>
        <label htmlFor={nameId}>Layout name</label>
        <input
          id={nameId}
          type="text"
          required
          value={state.name}
          onChange={(e) => onChange({ ...state, name: e.target.value })}
        />
      </div>
      <MarkersSection state={state} onChange={onChange} />
      <EdgesSection state={state} onChange={onChange} />
      <JunctionsSection state={state} onChange={onChange} />
    </fieldset>
  );
}

function MarkersSection({ state, onChange }: BuildFormProps) {
  const idFieldId = useId();
  const kindFieldId = useId();
  const xId = useId();
  const yId = useId();
  const [markerId, setMarkerId] = useState('');
  const [kind, setKind] = useState<MarkerKind>('block_boundary');
  const [xStr, setXStr] = useState('');
  const [yStr, setYStr] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  function addMarker() {
    const built = buildMarker(markerId, kind, xStr, yStr, state.markers);
    if (!built.ok) {
      setLocalError(built.error);
      return;
    }
    onChange({ ...state, markers: [...state.markers, built.marker] });
    setMarkerId('');
    setXStr('');
    setYStr('');
    setLocalError(null);
  }

  function removeMarker(id: string) {
    onChange({ ...state, markers: state.markers.filter((m) => m.id !== id) });
  }

  return (
    <fieldset aria-label="Markers">
      <legend>Markers</legend>
      <div>
        <label htmlFor={idFieldId}>Marker ID</label>
        <input
          id={idFieldId}
          type="text"
          value={markerId}
          onChange={(e) => setMarkerId(e.target.value)}
        />
        <label htmlFor={kindFieldId}>Kind</label>
        <select
          id={kindFieldId}
          value={kind}
          onChange={(e) => setKind(e.target.value as MarkerKind)}
        >
          {MARKER_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label htmlFor={xId}>x_mm</label>
        <input id={xId} type="number" value={xStr} onChange={(e) => setXStr(e.target.value)} />
        <label htmlFor={yId}>y_mm</label>
        <input id={yId} type="number" value={yStr} onChange={(e) => setYStr(e.target.value)} />
        <button type="button" onClick={addMarker}>
          Add marker
        </button>
      </div>
      {localError ? <p role="alert">{localError}</p> : null}
      <ul aria-label="Markers">
        {state.markers.map((m) => (
          <li key={m.id}>
            {m.id} · {m.kind}
            {m.position ? ` · (${m.position.x_mm}, ${m.position.y_mm})` : ''}
            <button type="button" onClick={() => removeMarker(m.id)}>
              Remove marker {m.id}
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function EdgesSection({ state, onChange }: BuildFormProps) {
  const fromId = useId();
  const toId = useId();
  const lengthId = useId();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [lengthStr, setLengthStr] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Keep selects in sync as markers are added/removed.
  useEffect(() => {
    if (from !== '' && !state.markers.some((m) => m.id === from)) setFrom('');
    if (to !== '' && !state.markers.some((m) => m.id === to)) setTo('');
  }, [state.markers, from, to]);

  function addEdge() {
    if (from === '' || to === '') {
      setLocalError('Pick both From and To markers');
      return;
    }
    if (from === to) {
      setLocalError('An edge cannot be a self-loop (from === to)');
      return;
    }
    if (state.edges.some((e) => e.from_marker_id === from && e.to_marker_id === to)) {
      setLocalError(`Duplicate edge: ${from} -> ${to}`);
      return;
    }
    const length = lengthStr === '' ? undefined : Number(lengthStr);
    if (length !== undefined && Number.isNaN(length)) {
      setLocalError('Length must be a number');
      return;
    }
    const edge: LayoutEdge =
      length !== undefined
        ? { from_marker_id: from, to_marker_id: to, estimated_length_mm: length }
        : { from_marker_id: from, to_marker_id: to };
    onChange({ ...state, edges: [...state.edges, edge] });
    setLengthStr('');
    setLocalError(null);
  }

  function removeEdge(index: number) {
    onChange({ ...state, edges: state.edges.filter((_, i) => i !== index) });
  }

  return (
    <fieldset aria-label="Edges">
      <legend>Edges</legend>
      <div>
        <label htmlFor={fromId}>From marker</label>
        <select id={fromId} value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">—</option>
          {state.markers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <label htmlFor={toId}>To marker</label>
        <select id={toId} value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">—</option>
          {state.markers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <label htmlFor={lengthId}>length_mm</label>
        <input
          id={lengthId}
          type="number"
          value={lengthStr}
          onChange={(e) => setLengthStr(e.target.value)}
        />
        <button type="button" onClick={addEdge}>
          Add edge
        </button>
      </div>
      {localError ? <p role="alert">{localError}</p> : null}
      <ul aria-label="Edges">
        {state.edges.map((e, i) => (
          <li key={`${e.from_marker_id}->${e.to_marker_id}`}>
            {e.from_marker_id} → {e.to_marker_id}
            {e.estimated_length_mm !== undefined ? ` · ${e.estimated_length_mm} mm` : ''}
            <button
              type="button"
              onClick={() => removeEdge(i)}
              aria-label={`Remove edge ${e.from_marker_id} to ${e.to_marker_id}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function JunctionsSection({ state, onChange }: BuildFormProps) {
  const markerSelectId = useId();
  const positionsId = useId();
  const initialId = useId();
  const [markerId, setMarkerId] = useState('');
  const [positionsStr, setPositionsStr] = useState('');
  const [initial, setInitial] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const junctionMarkers = state.markers.filter((m) => m.kind === 'junction');
  const availablePositions = parsePositions(positionsStr);

  // Keep the marker select valid if the chosen marker is removed or its kind changes.
  useEffect(() => {
    if (markerId !== '' && !junctionMarkers.some((m) => m.id === markerId)) {
      setMarkerId('');
      setInitial('');
    }
  }, [junctionMarkers, markerId]);

  // Keep the initial-state select valid when positions change.
  useEffect(() => {
    if (initial !== '' && !availablePositions.includes(initial)) {
      setInitial('');
    }
  }, [availablePositions, initial]);

  function addJunction() {
    if (markerId === '') {
      setLocalError('Pick a junction marker first');
      return;
    }
    if (state.junctions.some((j) => j.marker_id === markerId)) {
      setLocalError(`Duplicate junction for marker: ${markerId}`);
      return;
    }
    const positions = parsePositions(positionsStr);
    const usingDefault = positionsStr.trim() === '';
    if (!usingDefault && positions.length < 2) {
      setLocalError('A junction needs at least two valid positions');
      return;
    }
    const junction: LayoutJunction = usingDefault
      ? buildJunction(markerId, undefined, initial === '' ? undefined : initial)
      : buildJunction(markerId, positions, initial === '' ? undefined : initial);
    onChange({ ...state, junctions: [...state.junctions, junction] });
    setMarkerId('');
    setPositionsStr('');
    setInitial('');
    setLocalError(null);
  }

  function removeJunction(id: string) {
    onChange({ ...state, junctions: state.junctions.filter((j) => j.marker_id !== id) });
  }

  return (
    <fieldset aria-label="Junctions">
      <legend>Junctions</legend>
      <div>
        <label htmlFor={markerSelectId}>Junction marker</label>
        <select id={markerSelectId} value={markerId} onChange={(e) => setMarkerId(e.target.value)}>
          <option value="">—</option>
          {junctionMarkers.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <label htmlFor={positionsId}>Valid positions (comma-separated)</label>
        <input
          id={positionsId}
          type="text"
          value={positionsStr}
          placeholder="main, divert"
          onChange={(e) => setPositionsStr(e.target.value)}
        />
        <label htmlFor={initialId}>Initial state</label>
        <select id={initialId} value={initial} onChange={(e) => setInitial(e.target.value)}>
          <option value="">—</option>
          {availablePositions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button type="button" onClick={addJunction}>
          Add junction
        </button>
      </div>
      {localError ? <p role="alert">{localError}</p> : null}
      <ul aria-label="Junctions">
        {state.junctions.map((j) => (
          <li key={j.marker_id}>
            {j.marker_id}
            {j.valid_positions ? ` · [${j.valid_positions.join(', ')}]` : ''}
            {j.initial_state !== undefined ? ` · initial=${j.initial_state}` : ''}
            <button
              type="button"
              onClick={() => removeJunction(j.marker_id)}
              aria-label={`Remove junction ${j.marker_id}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

type BuildMarkerResult =
  | { readonly ok: true; readonly marker: LayoutMarker }
  | { readonly ok: false; readonly error: string };

function buildMarker(
  rawId: string,
  kind: MarkerKind,
  xStr: string,
  yStr: string,
  existing: readonly LayoutMarker[],
): BuildMarkerResult {
  const trimmed = rawId.trim();
  if (trimmed === '') return { ok: false, error: 'Marker ID is required' };
  if (existing.some((m) => m.id === trimmed)) {
    return { ok: false, error: `Duplicate marker ID: ${trimmed}` };
  }
  const x = xStr === '' ? undefined : Number(xStr);
  const y = yStr === '' ? undefined : Number(yStr);
  if ((x !== undefined && Number.isNaN(x)) || (y !== undefined && Number.isNaN(y))) {
    return { ok: false, error: 'Position must be a number' };
  }
  const marker: LayoutMarker =
    x !== undefined && y !== undefined
      ? { id: trimmed, kind, position: { x_mm: x, y_mm: y } }
      : { id: trimmed, kind };
  return { ok: true, marker };
}

function buildJunction(
  markerId: string,
  positions: readonly string[] | undefined,
  initial: string | undefined,
): LayoutJunction {
  const base: LayoutJunction = { marker_id: markerId };
  const withPositions =
    positions === undefined ? base : { ...base, valid_positions: [...positions] };
  return initial === undefined ? withPositions : { ...withPositions, initial_state: initial };
}

function parsePositions(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '') return [...DEFAULT_JUNCTION_POSITIONS];
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function currentLayout(selection: StoredLayoutSelection) {
  if (selection.kind === 'preset') return PRESET_LAYOUTS[selection.preset_id];
  return selection.layout;
}

function builderFromSelection(selection: StoredLayoutSelection): BuilderState {
  if (selection.kind !== 'custom') return EMPTY_BUILDER;
  const { layout } = selection;
  return {
    name: layout.name,
    markers: layout.markers,
    edges: layout.edges,
    junctions: layout.junctions,
  };
}
