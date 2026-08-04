/**
 * Registry of every world's ground function, keyed by name.
 *
 * The generation worker cannot be handed a closure - functions do not survive
 * `postMessage` - so a world asks for terrain by *naming* its height field and
 * passing plain parameters. Both sides import this file, so the worker resolves
 * the name to the very same function the world uses on the main thread. That
 * shared resolution is the point: a second copy of a height function in the
 * worker would be a second thing to keep in step with the mesh, the collision
 * and every prop placed on it.
 *
 * Each entry is a factory rather than the height function itself, so a field
 * that has setup to do (building a spline from control points, say) does it once
 * per job instead of once per sample.
 *
 * Nothing reachable from here may import `three` or touch the DOM - it runs
 * where neither exists.
 *
 * Adding a world: lift its height function into a `*Height.js` module beside
 * this one, have the world import it back rather than keeping its own copy, and
 * add a line below. Sports and the race circuit are not here yet because their
 * terrain sampling measures 45-65 ms against Medieval's 667 ms; the cost that
 * justified this machinery is not in them until worlds get much bigger.
 *
 * @type {Record<string, (params: object) => (x: number, z: number) => number>}
 */
import { medievalHeight } from './MedievalHeight.js';
import { citadelHeight } from './CitadelHeight.js';

export const HEIGHT_FIELDS = {
  medieval: () => medievalHeight,
  citadel: () => citadelHeight,
};
