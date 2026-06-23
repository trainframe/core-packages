import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTOSAVE_KEY,
  SLOTS_KEY,
  clearAutosave,
  deleteSlot,
  listSlots,
  loadAutosave,
  loadSlot,
  saveAutosave,
  saveSlot,
} from './track-storage.js';

/**
 * Track persistence (goal criterion B/2). Pure localStorage, deterministic — no
 * Date.now/Math.random. Named slots round-trip exact pieces; autosave persists the
 * working track AND a bounded undo stack.
 */

const A: TrackPiece = {
  id: 'A',
  type: 'straight',
  position: { x: 10, y: 20 },
  rotationDeg: 0,
  tagged: false,
};
const B: TrackPiece = {
  id: 'B',
  type: 'curve',
  position: { x: 30, y: 40 },
  rotationDeg: 45,
  tagged: false,
  flipped: true,
};
const C: TrackPiece = {
  id: 'C',
  type: 'straight',
  position: { x: 50, y: 60 },
  rotationDeg: 90,
  tagged: false,
};

describe('track-storage — named slots', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('save→load round-trips the exact pieces (deep-equal)', () => {
    saveSlot('oval', [A, B]);
    expect(loadSlot('oval')).toEqual([A, B]);
  });

  it('saving writes exactly one localStorage entry (the slots key)', () => {
    saveSlot('oval', [A]);
    expect(localStorage.length).toBe(1);
    expect(localStorage.getItem(SLOTS_KEY)).not.toBeNull();
  });

  it('two differently-named slots are independent', () => {
    saveSlot('oval', [A]);
    saveSlot('figure8', [B, C]);
    expect(loadSlot('oval')).toEqual([A]);
    expect(loadSlot('figure8')).toEqual([B, C]);
  });

  it('saving to an existing name overwrites it (no duplicate)', () => {
    saveSlot('oval', [A]);
    saveSlot('oval', [B, C]);
    expect(loadSlot('oval')).toEqual([B, C]);
    expect(listSlots()).toEqual(['oval']);
  });

  it('deleting a slot removes it', () => {
    saveSlot('oval', [A]);
    saveSlot('figure8', [B]);
    deleteSlot('oval');
    expect(loadSlot('oval')).toBeNull();
    expect(listSlots()).toEqual(['figure8']);
  });

  it('listing returns the live set of slot names (sorted)', () => {
    saveSlot('zeta', [A]);
    saveSlot('alpha', [B]);
    expect(listSlots()).toEqual(['alpha', 'zeta']);
  });

  it('loading a non-existent slot is a safe no-op (null)', () => {
    expect(loadSlot('nope')).toBeNull();
    deleteSlot('nope'); // also a no-op, no throw
    expect(listSlots()).toEqual([]);
  });

  it('survives corrupt JSON in the slots key (treats as empty)', () => {
    localStorage.setItem(SLOTS_KEY, '{not json');
    expect(listSlots()).toEqual([]);
    expect(loadSlot('oval')).toBeNull();
    saveSlot('oval', [A]); // recovers
    expect(loadSlot('oval')).toEqual([A]);
  });
});

describe('track-storage — autosave + undo history', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('round-trips the working track and the undo stack', () => {
    const undo = [[A], [A, B]];
    saveAutosave([A, B, C], undo, 100);
    expect(loadAutosave()).toEqual({ pieces: [A, B, C], undo });
    expect(localStorage.getItem(AUTOSAVE_KEY)).not.toBeNull();
  });

  it('bounds the persisted undo stack to the limit (drops oldest)', () => {
    const undo = [[A], [B], [C], [A, B]];
    saveAutosave([A], undo, 2);
    expect(loadAutosave()?.undo).toEqual([[C], [A, B]]); // last 2 kept
  });

  it('returns null when no autosave exists, and clearAutosave removes it', () => {
    expect(loadAutosave()).toBeNull();
    saveAutosave([A], [], 100);
    expect(loadAutosave()).not.toBeNull();
    clearAutosave();
    expect(loadAutosave()).toBeNull();
  });

  it('returns null on corrupt/!shaped autosave (does not throw)', () => {
    localStorage.setItem(AUTOSAVE_KEY, '{bad');
    expect(loadAutosave()).toBeNull();
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ pieces: 'x' }));
    expect(loadAutosave()).toBeNull();
  });
});
