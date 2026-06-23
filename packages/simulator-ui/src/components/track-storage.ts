/**
 * Toy-table track persistence (localStorage). Two concerns:
 *
 *  - NAMED SLOTS: the operator saves/loads tracks under chosen names. All slots
 *    live under one `SLOTS_KEY` entry (a name→pieces map), so a save is a single
 *    localStorage write and listing is a key scan of that map.
 *  - AUTOSAVE: the working track AND its undo stack, under `AUTOSAVE_KEY`, so a
 *    page reload restores both the layout and the ability to keep undoing.
 *
 * Pure data only (plain JSON — no functions/DOM). Deterministic: no `Date.now`,
 * no `Math.random`. Every read tolerates a missing or corrupt entry by falling
 * back to empty, so a mangled localStorage can never wedge the editor.
 */
import type { TrackPiece } from '@trainframe/simulator/track/pieces.js';

export const SLOTS_KEY = 'trainframe.toytable.slots';
export const AUTOSAVE_KEY = 'trainframe.toytable.autosave';

type SlotMap = Record<string, TrackPiece[]>;

/** The autosaved working state: the committed pieces + the undo stack (each entry
 *  a prior committed piece set, oldest-first). */
export interface AutosaveState {
  readonly pieces: TrackPiece[];
  readonly undo: TrackPiece[][];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function readSlots(): SlotMap {
  const v = readJson<unknown>(SLOTS_KEY, {});
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as SlotMap) : {};
}

function writeSlots(slots: SlotMap): void {
  localStorage.setItem(SLOTS_KEY, JSON.stringify(slots));
}

/** Save the pieces under `name`, overwriting any existing slot of that name. */
export function saveSlot(name: string, pieces: ReadonlyArray<TrackPiece>): void {
  writeSlots({ ...readSlots(), [name]: [...pieces] });
}

/** The pieces stored under `name`, or null if no such slot. */
export function loadSlot(name: string): TrackPiece[] | null {
  const slots = readSlots();
  return Object.prototype.hasOwnProperty.call(slots, name) ? (slots[name] ?? null) : null;
}

/** The slot names, sorted. */
export function listSlots(): string[] {
  return Object.keys(readSlots()).sort();
}

/** Remove the slot `name` (a no-op if absent). Rebuilds the map without the key
 *  rather than `delete`, per the project's no-`delete` rule. */
export function deleteSlot(name: string): void {
  const slots = readSlots();
  if (!Object.prototype.hasOwnProperty.call(slots, name)) return;
  const next: SlotMap = {};
  for (const key of Object.keys(slots)) {
    if (key !== name) next[key] = slots[key] ?? [];
  }
  writeSlots(next);
}

/** Persist the working track + undo stack, bounding the stack to `limit` (newest
 *  kept). Stores a deep copy of plain data only. */
export function saveAutosave(
  pieces: ReadonlyArray<TrackPiece>,
  undo: ReadonlyArray<ReadonlyArray<TrackPiece>>,
  limit: number,
): void {
  const bounded = undo.length > limit ? undo.slice(undo.length - limit) : undo;
  const state: AutosaveState = {
    pieces: [...pieces],
    undo: bounded.map((s) => [...s]),
  };
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state));
}

/** The autosaved state, or null when absent or malformed. */
export function loadAutosave(): AutosaveState | null {
  const raw = readJson<unknown>(AUTOSAVE_KEY, null);
  if (raw === null || typeof raw !== 'object') return null;
  const obj = raw as { pieces?: unknown; undo?: unknown };
  if (!Array.isArray(obj.pieces) || !Array.isArray(obj.undo)) return null;
  return { pieces: obj.pieces as TrackPiece[], undo: obj.undo as TrackPiece[][] };
}

/** Forget the autosave (used by a blank-slate reset). */
export function clearAutosave(): void {
  localStorage.removeItem(AUTOSAVE_KEY);
}
