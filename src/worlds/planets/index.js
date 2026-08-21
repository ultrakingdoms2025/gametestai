/**
 * THE PLANET REGISTRY.
 *
 * Every planet the game knows, keyed by id, plus the `World` subclass for each
 * one. Registering a new planet is two lines here and one descriptor file - no
 * world class, no height function, no renderer change. Ten planets, ten
 * descriptors, and this file is the whole of the wiring.
 *
 * `worldClasses()` is what `main.js` iterates to hand `WorldManager` its
 * registrations. It is a function rather than a constant so the subclasses are
 * stamped once, on demand, rather than at module-eval time in the boot path.
 *
 * ==========================================================================
 *  THE SHAPE OF THE OBJECT BELOW IS LOAD-BEARING. DO NOT "TIDY" IT.
 * ==========================================================================
 *
 * `scripts/quest-vocab.mjs` SCRAPES this file textually to build
 * `VOCAB.worlds` - it cannot import it, because the descriptors reach code that
 * touches a renderer. That scrape matches only two things:
 *
 *   1. COMPUTED keys of the form  [Binding.id]: Binding
 *   2. RELATIVE SINGLE-SEGMENT imports of the form  from './Name.js'
 *
 * Write `{ glass: ICE }` with a literal key, or move a descriptor into a
 * subfolder, and that planet DISAPPEARS from the vocabulary. Nothing throws. What
 * actually happens is that the planet stops being covered by
 * `dock-registration.test.mjs`'s "no registered world boots into silence" case
 * and by every quest-step world validation - so the first symptom is a world with
 * no music and an unvalidated quest, one browser boot later.
 *
 * That is the same class of failure as every other silent per-world table in this
 * project, and it is the reason this file is generated from a list rather than
 * hand-edited.
 *
 * ==========================================================================
 *  THE ID IS THE WORLD ID, WITH NO PREFIX
 * ==========================================================================
 *
 * `PlanetWorld.of(descriptor)` stamps `static id = descriptor.id`, so a planet
 * registers as `'cinder'` and NOT as `'planet:cinder'`. The `planet:` form
 * exists in exactly one place - `surfaceWorld` on a body in
 * `src/worlds/space/Bodies.js` - and is stripped by
 * `Piloting._resolveSurfaceWorld`. `piloting-loop.test.mjs` actively FORBIDS
 * the two agreeing: if a world called `planet:cinder` is ever registered, that
 * test fails and tells you to delete one of them.
 *
 * A body's `id` must equal its descriptor's `id` as well, because
 * `SpaceObjectives` resolves a world to a body through `BODY_BY_ID[worldId]`.
 * A planet whose two ids differ silently loses the space-objectives HUD.
 */

import { PlanetWorld } from '../PlanetWorld.js';
import { VOLCANIC } from './Volcanic.js';
import { TESSERA } from './Tessera.js';
import { SIROCCO } from './Sirocco.js';
import { SHOAL } from './Shoal.js';
import { VITRINE } from './Vitrine.js';
import { VERDIGRIS } from './Verdigris.js';
import { LATHE } from './Lathe.js';
import { CARNELIAN } from './Carnelian.js';
import { SALLOW } from './Sallow.js';
import { CATHEDRA } from './Cathedra.js';

/** @type {Record<string, Readonly<object>>} */
export const PLANETS = Object.freeze({
  [VOLCANIC.id]: VOLCANIC,
  [TESSERA.id]: TESSERA,
  [SIROCCO.id]: SIROCCO,
  [SHOAL.id]: SHOAL,
  [VITRINE.id]: VITRINE,
  [VERDIGRIS.id]: VERDIGRIS,
  [LATHE.id]: LATHE,
  [CARNELIAN.id]: CARNELIAN,
  [SALLOW.id]: SALLOW,
  [CATHEDRA.id]: CATHEDRA,
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

export { VOLCANIC, TESSERA, SIROCCO, SHOAL, VITRINE, VERDIGRIS, LATHE, CARNELIAN, SALLOW, CATHEDRA };
