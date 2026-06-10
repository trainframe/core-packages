/*
 * One-off generator: emit the piece poses for a plain rectangular oval, using
 * the same turtle maths as the bridge demo, so the by-hand Playwright journey
 * can place a guaranteed-closing loop through the real UI (place → rotate →
 * snap). Run: pnpm --filter @trainframe/simulator-ui exec tsx scripts/gen-oval.ts
 */
import {
  type RotationDeg,
  type TrackPiece,
  type TrackPieceType,
  getEndpoints,
} from '../src/track/pieces.js';

interface Cursor {
  x: number;
  y: number;
  dir: number;
  layer: number;
}

function toRotationDeg(deg: number): RotationDeg {
  return ((((Math.round(deg / 45) * 45) % 360) + 360) % 360) as RotationDeg;
}

function place(
  pieces: TrackPiece[],
  cursor: Cursor,
  type: TrackPieceType,
  id: string,
  flipped: boolean,
): Cursor {
  const probe0: TrackPiece = {
    id: '__probe__',
    type,
    position: { x: 0, y: 0 },
    rotationDeg: 0,
    tagged: false,
    ...(flipped ? { flipped: true } : {}),
  };
  const localEps = getEndpoints(probe0);
  const connectLocal = localEps[0];
  if (connectLocal === undefined) throw new Error(`no endpoint 0 for ${type}`);
  const rotationDeg = toRotationDeg(cursor.dir + 180 - connectLocal.outgoingAngleDeg);
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rotatedX = connectLocal.x * cos - connectLocal.y * sin;
  const rotatedY = connectLocal.x * sin + connectLocal.y * cos;
  const real: TrackPiece = {
    id,
    type,
    position: { x: cursor.x - rotatedX, y: cursor.y - rotatedY },
    rotationDeg,
    tagged: false,
    ...(flipped ? { flipped: true } : {}),
  };
  pieces.push(real);
  const exit = getEndpoints(real)[1];
  if (exit === undefined) throw new Error('no exit');
  return { x: exit.x, y: exit.y, dir: exit.outgoingAngleDeg, layer: exit.layer };
}

const pieces: TrackPiece[] = [];
// Click TARGET per piece = the cursor (joint) BEFORE placing it, so the
// toy-table's snap captures the previous open end and orients the piece itself.
const clicks: Array<{ type: TrackPieceType; xMm: number; yMm: number; flip: boolean }> = [];

// The FIRST piece has no anchor: the UI lands its CENTRE at the click. Model
// that, then start the turtle from its real exit endpoint so every later joint
// matches what the UI will actually snap to.
const startX = 300;
const startY = 130;
const first: TrackPiece = {
  id: 'top1',
  type: 'straight',
  position: { x: startX, y: startY },
  rotationDeg: 0,
  tagged: false,
};
pieces.push(first);
clicks.push({ type: 'straight', xMm: startX, yMm: startY, flip: false });
const firstExit = getEndpoints(first)[1];
if (firstExit === undefined) throw new Error('no first exit');
let c: Cursor = { x: firstExit.x, y: firstExit.y, dir: firstExit.outgoingAngleDeg, layer: 0 };

function placeRec(type: TrackPieceType, id: string, flipped: boolean): void {
  clicks.push({ type, xMm: Math.round(c.x), yMm: Math.round(c.y), flip: flipped });
  c = place(pieces, c, type, id, flipped);
}

// First corner finishes the top side, then 3 more sides of (straight + corner).
placeRec('curve-tight', 'top-ca', false);
placeRec('curve-tight', 'top-cb', false);
for (const side of ['right', 'bottom', 'left']) {
  placeRec('straight', `${side}1`, false);
  placeRec('curve-tight', `${side}-ca`, false);
  placeRec('curve-tight', `${side}-cb`, false);
}

console.log(JSON.stringify(clicks, null, 0));
console.error('count', pieces.length, 'final', { x: Math.round(c.x), y: Math.round(c.y) });
