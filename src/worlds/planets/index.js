/**
 * THE PLANET REGISTRY.
 *
 * Every planet the game knows, keyed by id, plus the `World` subclass for each
 * one. Registering a new planet is two lines here and one descriptor file - no
 * world class, no height function, no renderer change.
 *
 *   import { ICE } from './Ice.js';
 *   export const PLANETS = { cinder: VOLCANIC, glass: ICE };
 *
 * `worldClasses()` is what `main.js` iterates to hand `WorldManager` its
 * registrations. It is a function rather than a constant so the subclasses are
 * stamped once, on demand, rather than at module-eval time in the boot path.
 */

import { PlanetWorld } from '../PlanetWorld.js';
import { VOLCANIC } from './Volcanic.js';

/** @type {Record<string, Readonly<object>>} */
export const PLANETS = Object.freeze({
  [VOLCANIC.id]: VOLCANIC,
});

/** @param {string} id @returns {Readonly<object>} */
export function getPlanet(id) {
  const p = PLANETS[id];
  if (!p) throw new Error(`[planets] unknown planet "${id}" - known: ${Object.keys(PLANETS).join(', ')}`);
  return p;
}

let _classes = null;

/**
 * One registerable `World` subclass per planet, stamped once and cached.
 * @returns {Array<typeof PlanetWorld>}
 */
export function worldClasses() {
  if (!_classes) _classes = Object.values(PLANETS).map((p) => PlanetWorld.of(p));
  return _classes;
}

/** The subclass for one planet id. */
export function worldClassFor(id) {
  return worldClasses().find((C) => C.id === id) ?? null;
}

export { VOLCANIC };
