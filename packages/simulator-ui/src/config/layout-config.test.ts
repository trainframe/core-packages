import { describe, expect, it } from 'vitest';
import {
  clearLayoutSelection,
  loadLayoutSelection,
  parseLayoutJson,
  resolveLayout,
  saveLayoutSelection,
} from './layout-config.js';

const VALID_LAYOUT_JSON = JSON.stringify({
  name: 'one-edge',
  markers: [
    { id: 'A', kind: 'block_boundary' },
    { id: 'B', kind: 'block_boundary' },
  ],
  edges: [{ from_marker_id: 'A', to_marker_id: 'B' }],
  junctions: [],
});

describe('layout-config persistence', () => {
  it('returns the default selection when nothing is stored', () => {
    expect(loadLayoutSelection()).toEqual({ kind: 'preset', preset_id: 'simple-loop' });
  });

  it('round-trips a preset selection', () => {
    saveLayoutSelection({ kind: 'preset', preset_id: 'long-loop' });
    expect(loadLayoutSelection()).toEqual({ kind: 'preset', preset_id: 'long-loop' });
  });

  it('round-trips a custom layout selection', () => {
    const result = parseLayoutJson(VALID_LAYOUT_JSON);
    if (!result.ok) throw new Error('expected valid');
    saveLayoutSelection({ kind: 'custom', layout: result.layout });
    expect(loadLayoutSelection()).toEqual({ kind: 'custom', layout: result.layout });
  });

  it('falls back to the default when stored preset_id is unknown', () => {
    localStorage.setItem(
      'trainframe.simulator-ui.layout',
      JSON.stringify({ kind: 'preset', preset_id: 'nope' }),
    );
    expect(loadLayoutSelection()).toEqual({ kind: 'preset', preset_id: 'simple-loop' });
  });

  it('falls back to the default when stored custom layout fails schema', () => {
    localStorage.setItem(
      'trainframe.simulator-ui.layout',
      JSON.stringify({ kind: 'custom', layout: { name: 'broken' } }),
    );
    expect(loadLayoutSelection()).toEqual({ kind: 'preset', preset_id: 'simple-loop' });
  });

  it('clears storage', () => {
    saveLayoutSelection({ kind: 'preset', preset_id: 'long-loop' });
    clearLayoutSelection();
    expect(loadLayoutSelection()).toEqual({ kind: 'preset', preset_id: 'simple-loop' });
  });
});

describe('resolveLayout', () => {
  it('returns the preset by id', () => {
    expect(resolveLayout({ kind: 'preset', preset_id: 'simple-loop' }).name).toBe('simple-loop');
    expect(resolveLayout({ kind: 'preset', preset_id: 'long-loop' }).name).toBe('long-loop');
  });

  it('returns the embedded custom layout', () => {
    const result = parseLayoutJson(VALID_LAYOUT_JSON);
    if (!result.ok) throw new Error('expected valid');
    expect(resolveLayout({ kind: 'custom', layout: result.layout })).toBe(result.layout);
  });
});

describe('parseLayoutJson', () => {
  it('accepts a well-formed layout', () => {
    const result = parseLayoutJson(VALID_LAYOUT_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.layout.name).toBe('one-edge');
    }
  });

  it('rejects malformed JSON with an error mentioning the parse failure', () => {
    const result = parseLayoutJson('not json');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/invalid json/i);
    }
  });

  it('rejects a structurally invalid layout', () => {
    const result = parseLayoutJson(JSON.stringify({ name: 'no-markers' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});
