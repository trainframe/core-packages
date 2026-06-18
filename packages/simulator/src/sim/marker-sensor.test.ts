/**
 * The grade-separation guard on the physics marker sensor: at a self-crossing
 * (a deck carried OVER a ground line on a higher height layer) the two tracks
 * share world x,y but sit on different layers. A ground train must NOT trip a
 * marker on the deck overhead. The guard is opt-in: a marker with a `layer`,
 * read by a body whose segment layer is known, only fires on a layer match;
 * absent either layer it falls back to pure 2D proximity (single-layer scenes).
 *
 * Drives a real `PhysicsWorld` body against a real `physicsMarkerSensor` — no
 * mocks (the sim-wiring seam is the unit under test).
 */
import { describe, expect, it } from 'vitest';
import { straightLoop } from '../physics-env.js';
import { PhysicsWorld } from '../physics/world.js';
import { physicsMarkerSensor } from './marker-sensor.js';

describe('physicsMarkerSensor — grade-separation (layer) guard', () => {
  it('suppresses a different-layer marker, fires same-layer + unlayered ones', () => {
    const scene = straightLoop([{ id: 'M1', kind: 'block_boundary' }], { spacingMm: 500 });
    const world = new PhysicsWorld(scene.net);
    /* Body on the ground rail ('main' = layer 0), sitting at world (100, 0). */
    world.addBody({ id: 'T', kind: 'loco', segment: 'main', railPos: 100, facing: 1 });
    const segmentLayer = new Map<string, number>([['main', 0]]);
    /* All three markers coincide with the body in 2D; only the layer differs. */
    const markers = [
      { id: 'GROUND', x: 100, y: 0, layer: 0 },
      { id: 'DECK', x: 100, y: 0, layer: 1 },
      { id: 'UNLAYERED', x: 100, y: 0 },
    ];
    const fired: string[] = [];
    const sensor = physicsMarkerSensor(world, 'T', markers, undefined, segmentLayer);
    sensor.onMarker((id) => fired.push(id));
    sensor.sample();

    expect(fired).toContain('GROUND');
    expect(fired).toContain('UNLAYERED');
    expect(fired).not.toContain('DECK');
  });

  it('without a segment→layer map, fires a layered marker by pure 2D proximity', () => {
    const scene = straightLoop([{ id: 'M1', kind: 'block_boundary' }], { spacingMm: 500 });
    const world = new PhysicsWorld(scene.net);
    world.addBody({ id: 'T', kind: 'loco', segment: 'main', railPos: 100, facing: 1 });
    const fired: string[] = [];
    /* No segmentLayer → the body's layer is unknown → the guard yields to 2D. */
    const sensor = physicsMarkerSensor(world, 'T', [{ id: 'DECK', x: 100, y: 0, layer: 1 }]);
    sensor.onMarker((id) => fired.push(id));
    sensor.sample();

    expect(fired).toContain('DECK');
  });
});
