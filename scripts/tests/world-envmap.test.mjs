import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

/* Before any game module is imported, exactly as `world-light-visibility`
 * does it: `WorldManager` and the worlds under it read browser globals at
 * import time, so an ordinary static import throws
 * `requestAnimationFrame is not defined` before a single test runs. */
const { domHarness } = await import('./_flightrig.mjs');
domHarness();

const { EventBus } = await import('../../src/core/EventBus.js');
const { Physics } = await import('../../src/physics/Physics.js');
const { WorldManager } = await import('../../src/worlds/WorldManager.js');

/**
 * NO WORLD INHERITS THE LAST WORLD'S REFLECTION PROBE.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `main.js applyEnvironment` used to write the probe PARTIALLY:
 *
 *     if (env.envMap !== undefined) scene.environment = env.envMap;
 *
 * Twelve of the eighteen worlds published no `envMap` at all, so for those
 * twelve "publishes no map" meant "keep whatever the last world left on the
 * scene". That is not a state anybody authored, and it made a world's
 * lighting depend on the ROUTE the player took to reach it: booting straight
 * into the maze gave its metals and glass no probe at all, and walking into
 * the same maze from the station gave them the station's baked cyan-and-amber
 * one. A red planet could reflect a blue sky because the player came from a
 * blue-sky world.
 *
 * It was also a two-scene disagreement across a program cache key.
 * `Portals._configurePreview` has ALWAYS written `env.envMap ?? null` -
 * total - so the world seen through a gateway arch was lit with no probe
 * while the same world walked into wore the departure's. Three folds
 * `envMapMode` and `envMapCubeUVHeight` into `getProgramCacheKey`, so the
 * preview warm compiled the mapless build and the arrival then asked for the
 * inherited-map build: two key sets for one world, and the second one linked
 * on the arrival frame.
 *
 * Nothing measured any of this. That is the reason this file exists at all,
 * and it is the shape this repository keeps paying for - the bug lived
 * because no gate asked the question.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS ASSERTED, AND IN WHICH TERMS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Two halves, and they fail for different reasons on purpose.
 *
 * 1. THE WORLDS. Every world is BUILT and asked what probe it publishes. The
 *    answer must not be `undefined`. `null` is a real answer and passes - it
 *    means "this world wants no probe", which the applier honours by clearing
 *    the scene. `undefined` is the defect: it is the only value a partial
 *    applier reads as "leave the last world's map alone", and it is what all
 *    twelve of those worlds returned.
 *
 *    This half is on the built objects rather than on source text, for the
 *    reason `citadel-caves` wrote down and `world-light-visibility` repeats:
 *    a field assigned and deleted two lines later would pass a regex.
 *
 * 2. THE APPLIER. `applyEnvironment`, `withArrivalKey` and `arrivalKeyOf`
 *    live in `src/main.js`, which is the application entry point - importing
 *    it boots the game, mounts the DOM and opens sockets, so there is no way
 *    to call them from here. This half therefore scans the source, and says
 *    so plainly rather than pretending otherwise: it asserts the partial
 *    idiom appears nowhere, and that each assignment site is total.
 *
 *    A source scan is the weaker instrument and it is second for that reason.
 *    It is worth having anyway because it is the half that catches the
 *    regression at its actual cause - somebody restoring the `!== undefined`
 *    guard - whereas half 1 would only catch it once a world ALSO stopped
 *    declaring a probe. The two together close the loop: half 1 makes the
 *    inherit unreachable from the world side, half 2 from the applier side.
 *
 * BOTH HALVES ABLATE, and were checked that way rather than assumed. Putting
 * `?? undefined` back on `RaceWorld`'s one line fails half 1 with `['race']`;
 * restoring `if (env.envMap !== undefined)` on `applyEnvironment` fails half 2
 * naming the file and line. A gate nobody has seen fail is a gate nobody knows
 * is wired up.
 *
 * ── What this does NOT claim ──────────────────────────────────────────────
 * Nothing here says a world's probe is the RIGHT probe. The stub materials
 * below hand back `null` for every library mood and there is no GL context,
 * so `PlanetWorld._bakeEnvMap` correctly declines to bake and every world
 * answers `null` in this rig. That is fine: the question asked here is
 * "declared or absent", and `null` and a real texture are the same answer to
 * it. Whether the maze should take 'daylight' rather than 'space' is a
 * judgement, and it is documented at each call site.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(HERE, '../..');

/* Every world the game can put a player in. The ten planets are included
 * rather than sampled: they were one of the three families that inherited,
 * and `PlanetWorld` is the one that could not be fixed with a shared mood -
 * four of them declare `kind: 'daylight'` over sulphur, sea, amber and ember
 * skies, so each bakes its own dome. A per-world bug is exactly what a
 * sampled list would miss. */
const PLANETS = ['cinder', 'tessera', 'sirocco', 'shoal', 'vitrine',
  'verdigris', 'lathe', 'carnelian', 'sallow', 'cathedra'];
const WORLD_IDS = ['station', 'medieval', 'sports', 'citadel', 'race', 'maze',
  'dock', 'space', ...PLANETS];

let _built = null;

async function worlds() {
  if (_built) return _built;
  const [
    { StationWorld }, { MedievalWorld }, { SportsWorld }, { CitadelWorld },
    { RaceWorld }, { MazeWorld }, { DockWorld }, { SpaceWorld }, { worldClasses },
  ] = await Promise.all([
    import('../../src/worlds/StationWorld.js'),
    import('../../src/worlds/MedievalWorld.js'),
    import('../../src/worlds/SportsWorld.js'),
    import('../../src/worlds/CitadelWorld.js'),
    import('../../src/worlds/RaceWorld.js'),
    import('../../src/worlds/MazeWorld.js'),
    import('../../src/worlds/DockWorld.js'),
    import('../../src/worlds/SpaceWorld.js'),
    import('../../src/worlds/planets/index.js'),
  ]);

  /* No `isWebGLRenderer` on purpose. `PMREMGenerator.fromScene` touches
   * `renderer.xr` first, so `PlanetWorld._bakeEnvMap` guards on the real flag
   * rather than on truthiness - and this rig is the case that guard is for. */
  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const bus = new EventBus();
  const ctx = {
    scene: new THREE.Scene(),
    engine: {
      renderer,
      camera: new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 2000),
      running: false, elapsed: 0,
      onFrameUpdate: () => () => {}, onResize: () => () => {},
    },
    physics: new Physics(bus),
    bus,
    materials: { get: () => new THREE.MeshStandardMaterial(), getEnvMap: () => null, dispose() {} },
  };

  const wm = new WorldManager(ctx);
  for (const C of [StationWorld, MedievalWorld, SportsWorld, CitadelWorld,
    RaceWorld, MazeWorld, DockWorld, SpaceWorld]) wm.register(C);
  for (const C of worldClasses()) wm.register(C);

  const out = new Map();
  for (const id of WORLD_IDS) out.set(id, await wm.build(id));
  _built = out;
  return _built;
}

test('every world declares a probe, so none can inherit the last one', async () => {
  const built = await worlds();
  assert.equal(built.size, WORLD_IDS.length, 'a world failed to build');

  const undeclared = [];
  for (const [id, w] of built) {
    const env = w.environment;
    assert.ok(env && typeof env === 'object', `world:${id} published no environment at all`);
    if (!('envMap' in env) || env.envMap === undefined) undeclared.push(id);
  }

  assert.deepEqual(undeclared, [],
    `${undeclared.length} world(s) publish no envMap. Under a partial applier that means `
    + '"keep the map the previous world left on the scene", so this world\'s metals and '
    + 'glass would be lit by whichever world the player walked in from. Declare '
    + '`envMap: null` if the world genuinely wants no probe - null is an answer, undefined is not.');
});

test('the applier is total everywhere, and the partial idiom is gone', () => {
  /* The four sites, by file and by the expression each must carry. Listed
   * rather than counted so that deleting one is a failure and not a pass:
   * `main.js` needs all three moving together, because making the applier
   * total while `arrivalKeyOf` still guessed from the live scene would warm a
   * key the arrival never asks for - the exact stall those functions exist to
   * prevent. */
  const SITES = [
    ['src/main.js', 'scene.environment = env.envMap ?? null;', 2],
    ['src/main.js', 'const map = env.envMap ?? null;', 1],
    ['src/systems/Portals.js', 'this._previewScene.environment = env.envMap ?? null;', 1],
    ['scripts/frame-gaps.mjs', 'sc.environment = env.envMap ?? null;', 1],
  ];
  for (const [rel, expr, n] of SITES) {
    const src = readFileSync(path.join(root, rel), 'utf8');
    const hits = src.split(expr).length - 1;
    assert.equal(hits, n,
      `${rel} should carry ${n} copy/copies of \`${expr}\`, found ${hits}. `
      + 'All four assignment sites have to agree: the scene, the arrival warm, the arrival '
      + 'key and the gateway preview. Two of them disagreeing is how this bug shipped.');
  }

  /* The partial form itself, in CODE only.
   *
   * Every one of these three files explains the fix in prose that quotes the
   * broken line verbatim - `main.js:3349` opens with "TOTAL, and it used to be
   * `if (env.envMap !== undefined)`" - so a scan of the raw text matches the
   * documentation and fails on correct code. That is the "gate that measures
   * something the game does not do" this repository keeps paying for, and it
   * fired here on the first run. Comments are stripped first, so what is left
   * is the code. */
  const stripComments = (src) => src
    /* Blanked rather than removed, so a reported line number still points at
     * the line the guard is actually on. */
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*/g, '$1');
  for (const rel of ['src/main.js', 'src/systems/Portals.js', 'scripts/frame-gaps.mjs']) {
    const src = stripComments(readFileSync(path.join(root, rel), 'utf8'));
    const guard = /if\s*\(\s*[A-Za-z_$][\w$]*\.envMap\s*!==\s*undefined\s*\)/.exec(src);
    const line = guard ? src.slice(0, guard.index).split('\n').length : 0;
    /* The match ARRAY carries the whole file on `.input`, so a bare
     * `assert.equal(guard, null)` prints all of `src/main.js` into the test
     * log on failure. Compare the matched text instead. */
    assert.equal(guard ? guard[0] : null, null,
      `${rel}:${line} restored the partial guard \`${guard && guard[0]}\`. That is the defect: `
      + 'it makes "no probe" mean "keep the previous world\'s probe", and which look a world '
      + 'gets then depends on the route in.');
  }
});
