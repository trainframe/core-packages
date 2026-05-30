import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Layout as LayoutSchema } from '@trainframe/protocol';
import type { Layout } from '@trainframe/protocol';
import {
  PRESET_LAYOUTS,
  type PresetLayoutId,
  SIMPLE_LOOP,
  isPresetLayoutId,
} from '../sim/layouts.js';

/**
 * Layout selection persistence. The simulator UI either runs against one of
 * the preset layouts or a user-supplied JSON layout.
 *
 * The protocol schemas declare `format: 'uuid'` for marker IDs. That's the
 * broker-boundary contract — what real devices send over the wire. Inside
 * the simulator UI we use short readable IDs (`M1`, `M2`) so the operator
 * isn't writing UUIDs in the editor. Register permissive `uuid` and
 * `date-time` validators that accept any non-empty string; the broker is
 * still free to enforce the strict contract.
 */
registerPermissiveFormat('uuid');
registerPermissiveFormat('date-time');
registerPermissiveFormat('uri');

function registerPermissiveFormat(name: string): void {
  if (FormatRegistry.Has(name)) return;
  FormatRegistry.Set(name, (value) => typeof value === 'string' && value.length > 0);
}

const STORAGE_KEY = 'trainframe.simulator-ui.layout';

export type StoredLayoutSelection =
  | { readonly kind: 'preset'; readonly preset_id: PresetLayoutId }
  | { readonly kind: 'custom'; readonly layout: Layout };

const DEFAULT_SELECTION: StoredLayoutSelection = { kind: 'preset', preset_id: 'simple-loop' };

interface RawSelection {
  kind?: unknown;
  preset_id?: unknown;
  layout?: unknown;
}

export function loadLayoutSelection(): StoredLayoutSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SELECTION;
    const parsed = JSON.parse(raw) as RawSelection;
    if (parsed.kind === 'preset' && typeof parsed.preset_id === 'string') {
      if (isPresetLayoutId(parsed.preset_id)) {
        return { kind: 'preset', preset_id: parsed.preset_id };
      }
    }
    if (parsed.kind === 'custom' && Value.Check(LayoutSchema, parsed.layout)) {
      // Rehydration is a silent recovery path — there's no UI surface to
      // report an error to — so a referentially-invalid stored layout falls
      // through to DEFAULT_SELECTION rather than crashing later in LayoutState.
      if (checkReferentialIntegrity(parsed.layout) === null) {
        return { kind: 'custom', layout: parsed.layout };
      }
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_SELECTION;
}

export function saveLayoutSelection(selection: StoredLayoutSelection): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
}

export function clearLayoutSelection(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** Resolve a stored selection to a concrete Layout the simulator can use. */
export function resolveLayout(selection: StoredLayoutSelection): Layout {
  if (selection.kind === 'preset') return PRESET_LAYOUTS[selection.preset_id];
  return selection.layout;
}

export type LayoutValidationResult =
  | { readonly ok: true; readonly layout: Layout }
  | { readonly ok: false; readonly error: string };

/**
 * Validate a JSON string as a Trainframe Layout. Returns either the parsed
 * layout or a human-readable error. Used by the layout editor before saving.
 */
export function parseLayoutJson(text: string): LayoutValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (!Value.Check(LayoutSchema, parsed)) {
    const errors = [...Value.Errors(LayoutSchema, parsed)].slice(0, 3);
    const summary = errors.map((err) => `${err.path || '/'}: ${err.message}`).join('; ');
    return { ok: false, error: summary || 'Layout did not match schema' };
  }
  const integrityError = checkReferentialIntegrity(parsed);
  if (integrityError !== null) return { ok: false, error: integrityError };
  return { ok: true, layout: parsed };
}

// Schema validates shape only; without this check the sim crashes inside LayoutState on start, not in the form.
function checkReferentialIntegrity(layout: Layout): string | null {
  const markerIds = new Set(layout.markers.map((m) => m.id));
  for (const edge of layout.edges) {
    if (!markerIds.has(edge.from_marker_id) || !markerIds.has(edge.to_marker_id)) {
      return `Edge references unknown marker: ${edge.from_marker_id} -> ${edge.to_marker_id}`;
    }
  }
  for (const junction of layout.junctions) {
    if (!markerIds.has(junction.marker_id)) {
      return `Junction references unknown marker: ${junction.marker_id}`;
    }
  }
  return null;
}

/** Convenience: the default layout the app starts with. */
export const DEFAULT_LAYOUT = SIMPLE_LOOP;
