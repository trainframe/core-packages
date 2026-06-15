import { it } from 'vitest';
import { type Cursor, PieceNetworkBuilder } from './piece-network.js';
import { addSatelliteLoop } from './satellite-loop.js';
it('dbg', () => {
  const b = new PieceNetworkBuilder();
  const start: Cursor = { x: 0, y: 0, dir: 180, layer: 0 }; // west
  const ap = b.run('approach', start, [{ type: 'straight' }, { type: 'straight' }]);
  console.log('entry', ap.x.toFixed(0), ap.y.toFixed(0), 'dir', ap.dir);
  const sat = addSatelliteLoop(b, ap, { prefix: 'S', flipped: true });
  b.link('approach', sat.inbound);
  console.log('exit', sat.exit.x.toFixed(0), sat.exit.y.toFixed(0), 'dir', sat.exit.dir.toFixed(0));
});
