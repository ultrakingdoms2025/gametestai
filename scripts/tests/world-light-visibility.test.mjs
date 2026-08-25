import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

/**
 * NO WORLD MAY MINT ITS OWN LIGHT.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CLAIM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three pushes `numDirLights`, `numPointLights`, `numSpotLights` and their
 * three shadow siblings into `getProgramCacheKey`, and the GLSL preprocessor
 * UNROLLS the lighting loops against them. So a single frame drawn with a
 * different light count shares no program with the frame before it, and every
 * material on screen is re-linked in one blocking frame. Measured on this
 * project: the arrival frame at sports was linking 90 programs of which 79
 * differed from an existing key only in a scene field, and `getProgramInfoLog`
 * - the driver link wait - was 96% of a 30-second stall.
 *
 * `gfx/LightRig.js` pins those counts: a fixed slot pool added once at boot,
 * every other light demoted to a `visible = false` SOURCE and copied into a
 * slot per frame. But it demotes on its NEXT walk, and the frame between
 * construction and that walk is a frame in which the light counts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A CATEGORICAL GATE AND NOT A NEARBY-LINE ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `citadel-caves.test.mjs` wrote the reason down before this file existed:
 *
 *     "The assertion is on the built lights, not on a regex over the source,
 *      because a light created visible and hidden two lines later would pass
 *      a regex."
 *
 * It is right, and it is why the fix was not sixty hand-edits. Construction
 * moved into `gfx/WorldLight.js`, which hides the light before the caller ever
 * has a reference to it, and the static half of this file forbids `new
 * THREE.<anything>Light(` anywhere under `src/worlds/` at all. There is no
 * "hidden two lines later" to pass, because there is no construction.
 *
 * That still only measures source text, so the second half builds NINE REAL
 * WORLDS with no `LightRig` anywhere in their context - nothing has had a
 * chance to set the flag - adds each one to a scene that holds a rig's slot
 * pool, and asserts the tuple Three would compile against DID NOT MOVE. That
 * is the claim in the renderer's own terms rather than in a flag's, and it is
 * the half that would catch a light arriving from an authored `.glb`, from a
 * `clone()`, or from a helper module outside `src/worlds` - none of which the
 * text scan can see.
 *
 * Both halves ablate. Each has a case that undoes it and checks the measure
 * moves.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS DOES NOT CLAIM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sixty of the sixty-four sites this closed were LATENT, not live: `claim()`
 * on `world:changed` and `warmWorld()` both demote a world's build-time lights
 * before a frame renders, so the window was already shut for them. The maze's
 * streamed district lanterns and the cave torches are the ones where it is
 * genuinely open, and those three were already hidden by hand - which is how
 * the rule was learned in the first place. This gate is worth having because
 * the NEXT world file starts with the window open and nothing else would say
 * so; it is not worth quoting a frame-time improvement over.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORLDS_DIR = path.join(root, 'src/worlds');

/**
 * Sites allowed to construct a `THREE` light directly, with the reason.
 *
 * Empty, and it should stay that way. A world that genuinely needs a light the
 * renderer counts from its first frame does not exist - `RIG_BUDGET` is the
 * whole supply and `gfx/LightRig.js` owns it - so an entry here is a claim
 * that the rig is wrong for this one case, and it has to say why in prose that
 * survives review.
 *
 * @type {Array<{ file: string, why: string }>}
 */
const EXEMPT = [];

/* ------------------------------------------------------------------ */
/* Half one: the source scan                                           */
/* ------------------------------------------------------------------ */

/** Blank out comments, keeping every newline, so line numbers survive. */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (src[i] === '/' && src[i + 1] === '/') {
      let end = src.indexOf('\n', i);
      if (end < 0) end = src.length;
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

function jsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

/** Every direct `new THREE.*Light(` under src/worlds, comments excluded. */
function directConstructions(files) {
  const hits = [];
  for (const f of files) {
    const bare = stripComments(readFileSync(f, 'utf8'));
    const re = /new THREE\.(\w*Light)\(/g;
    let m;
    while ((m = re.exec(bare))) {
      hits.push({
        file: rel(f),
        line: bare.slice(0, m.index).split('\n').length,
        what: m[1],
      });
    }
  }
  return hits;
}

test('no world file constructs a THREE light directly', () => {
  const files = jsFiles(WORLDS_DIR);
  assert.ok(files.length > 40, `only ${files.length} world source files found - the scan is looking in the wrong place`);

  const exempt = new Set(EXEMPT.map((e) => e.file));
  const hits = directConstructions(files).filter((h) => !exempt.has(h.file));

  assert.deepEqual(hits, [],
    `${hits.length} world light(s) are constructed directly instead of through gfx/WorldLight.js:\n  `
    + hits.map((h) => `${h.file}:${h.line}  new THREE.${h.what}(`).join('\n  ')
    + '\n\nA directly constructed light is VISIBLE until LightRig\'s next walk, and one frame '
    + 'with the wrong light count re-links every program on screen. Use `pointLight`, '
    + '`spotLight` or `dirLight` from src/gfx/WorldLight.js - same arguments, same order - '
    + 'or add an entry to EXEMPT in this file saying why the rig is wrong for this case.');
});

test('ABLATION: the scan sees a light put back the old way', () => {
  /* The assertion above is only worth something if the scanner can actually
   * find a construction. Feed it the exact text the codemod removed. */
  const before = stripComments(`
    const l = new THREE.PointLight(0xffcb96, 34, 40, 2.0);
    /* new THREE.SpotLight(...) in prose must NOT count */
    // nor new THREE.DirectionalLight(...) on a line comment
  `);
  const found = [...before.matchAll(/new THREE\.(\w*Light)\(/g)].map((m) => m[1]);
  assert.deepEqual(found, ['PointLight'],
    'the scanner either misses a real construction or counts one written in a comment');
});

test('a world file that reaches for a light imports it from gfx/WorldLight.js', () => {
  /* The complement of the ban: having forbidden the constructor, check the
   * files that make lights actually got the replacement, rather than having
   * quietly lost their lighting to a bad merge. */
  const users = [];
  for (const f of jsFiles(WORLDS_DIR)) {
    const bare = stripComments(readFileSync(f, 'utf8'));
    if (!/\b(pointLight|spotLight|dirLight)\s*\(/.test(bare)) continue;
    users.push(rel(f));
    assert.match(bare, /from\s+'[^']*gfx\/WorldLight\.js'/,
      `${rel(f)} calls a light factory it never imported`);
  }
  /* Eleven files were converted plus the three that already hid their lights
   * by hand. A floor, not an equality: adding a world should not fail this. */
  assert.ok(users.length >= 14,
    `only ${users.length} world files build lights through gfx/WorldLight.js - fourteen did `
    + `when this was written: ${users.join(', ')}`);
});

test('no world file un-hides a light it just made', () => {
  /* The one hole the ban leaves: `const l = pointLight(...); l.visible = true;`
   * would put the light straight back into the count. Cheap to check, because
   * the factories are the only way a name can be bound to a light now. */
  const bad = [];
  for (const f of jsFiles(WORLDS_DIR)) {
    const bare = stripComments(readFileSync(f, 'utf8'));
    const names = new Set();
    for (const m of bare.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:pointLight|spotLight|dirLight)\s*\(/g)) names.add(m[1]);
    for (const m of bare.matchAll(/(this\.[A-Za-z_$][\w$]*)\s*=\s*(?:pointLight|spotLight|dirLight)\s*\(/g)) names.add(m[1]);
    for (const n of names) {
      const re = new RegExp(`${n.replace(/[.$]/g, '\\$&')}\\.visible\\s*=\\s*(?!false)`, 'g');
      for (const m of bare.matchAll(re)) {
        bad.push(`${rel(f)}:${bare.slice(0, m.index).split('\n').length}  ${n}.visible`);
      }
    }
  }
  assert.deepEqual(bad, [],
    'a world light is made visible after construction, which puts it back in the program '
    + `cache key:\n  ${bad.join('\n  ')}\n\nDrive intensity instead - it is the one property `
    + 'WebGLLights.setup never consults when counting.');
});

/* ------------------------------------------------------------------ */
/* Half two: nine real worlds, measured                                */
/* ------------------------------------------------------------------ */

const { domHarness } = await import('./_flightrig.mjs');
domHarness();

const { LightRig, RIG_BUDGET } = await import('../../src/gfx/LightRig.js');
const { lightSignature } = await import('../../src/worlds/citadel/Caves.js');
const { pointLight, spotLight, dirLight } = await import('../../src/gfx/WorldLight.js');
const { WorldManager } = await import('../../src/worlds/WorldManager.js');
const { Physics } = await import('../../src/physics/Physics.js');
const { EventBus } = await import('../../src/core/EventBus.js');

/**
 * Every world that authors a light, plus the two that do not.
 *
 * `volcanic` is the planet chosen deliberately: `PlanetWorld._buildLiquid`
 * only mints its glow light for a descriptor that declares one, and Cinder is
 * one of the six that do. A planet without lava would pass this vacuously.
 */
const WORLD_IDS = ['station', 'medieval', 'sports', 'citadel', 'race', 'maze', 'dock', 'space', 'cinder'];

let _built = null;

/** One `WorldManager`, every world registered, built once for the whole file. */
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

  const renderer = {
    capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
    initTexture() {}, getContext: () => ({}),
    getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
  };
  const bus = new EventBus();
  const ctx = {
    /* A scene the worlds are NOT added to. `WorldManager.build` does not
     * parent a world, and this file wants each group measured on its own. */
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

/** Every non-global light under `root`, whether or not `traverse` would skip it. */
function lightsIn(root) {
  const out = [];
  root.traverse((o) => {
    if (o.isLight && !o.isAmbientLight && !o.isHemisphereLight) out.push(o);
  });
  return out;
}

/**
 * Put a built world into the state the arriving frame sees it in.
 *
 * `WorldManager.build` ends with `world.group.visible = false` and `onActivate`
 * sets it back - and that ordering is load-bearing for this file rather than
 * incidental. `projectObject` skips a light under a hidden ANCESTOR, so a
 * signature taken over an un-activated group is identical whatever the lights
 * inside it are doing: it would be a gate that measures nothing, which is the
 * failure this repository keeps paying for. The measurement below is the frame
 * AFTER activation flips the group and BEFORE `LightRig.claim` runs on
 * `world:changed`, because that is the only frame in which the question is
 * open.
 */
function asArriving(world) {
  assert.equal(world.group.visible, false,
    `world:${world.id ?? world.constructor.id} came out of build() already visible - `
    + 'the signature below would then be measuring the un-activated case for every world');
  world.group.visible = true;
  return world;
}

test('adding a built world to the scene does not move the shader light signature', async () => {
  /* ── How this is measured ──────────────────────────────────────────────
   * `lightSignature` reproduces `WebGLRenderer.projectObject`, which skips an
   * object AND ITS SUBTREE when `visible === false` - which `Object3D.traverse`
   * does not. The tuple it returns is exactly what the GLSL preprocessor
   * unrolls against, so an unchanged tuple is an unchanged cache key is zero
   * new programs.
   *
   * Nothing here has a `LightRig` in its context. The flag being read is the
   * one the world's own constructor wrote, in the state the very first frame
   * after `build()` would have seen it.
   *
   * Floor: nine worlds, >= 200 authored lights between them, signature
   * unmoved. Ceiling by the ablation case below. */
  const built = await worlds();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  new LightRig({ scene, camera });

  const empty = lightSignature(scene);
  assert.equal(empty.point, RIG_BUDGET.point);
  assert.equal(empty.spot, RIG_BUDGET.spot);
  assert.equal(empty.dir, RIG_BUDGET.dirShadow + RIG_BUDGET.dirFill);

  let authored = 0;
  const report = [];
  for (const [id, world] of built) {
    const mine = lightsIn(world.group);
    authored += mine.length;
    scene.add(asArriving(world).group);
    const withIt = lightSignature(scene);
    const live = mine.filter((l) => l.visible);
    assert.deepEqual(live.map((l) => l.name || l.type), [],
      `world:${id} built ${live.length} of its ${mine.length} lights VISIBLE, so the frame `
      + 'between the build finishing and LightRig\'s next walk re-links every program on '
      + 'screen. They come from gfx/WorldLight.js, which hides them.');
    assert.equal(withIt.key, empty.key,
      `world:${id} moved the shader light signature from ${empty.key} to ${withIt.key} - `
      + `every program in the game recompiles on the frame it arrives (${mine.length} lights)`);
    scene.remove(world.group);
    world.group.visible = false; // back to how build() left it, for the next case
    report.push(`${id} ${mine.length}`);
  }
  assert.ok(authored >= 200,
    `only ${authored} authored lights across nine worlds - the sweep is not reaching them`);
  console.log(`   signature ${empty.key} held against ${authored} authored lights: ${report.join(', ')}`);
});

test('ABLATION: one world light made visible moves the signature', async () => {
  /* Without this the equality above could be a statement about
   * `lightSignature` rather than about the worlds. */
  const built = await worlds();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  new LightRig({ scene, camera });
  const empty = lightSignature(scene);

  const station = built.get('station');
  const lights = lightsIn(station.group);
  assert.ok(lights.length > 0, 'the station authors no lights at all');

  scene.add(asArriving(station).group);
  assert.equal(lightSignature(scene).key, empty.key);

  const victim = lights[0];
  victim.visible = true;
  const moved = lightSignature(scene);
  try {
    assert.notEqual(moved.key, empty.key,
      `one visible ${victim.type} did not move ${empty.key} - the probe is not counting it`);
    assert.equal(moved.point + moved.spot + moved.dir, empty.point + empty.spot + empty.dir + 1);
  } finally {
    victim.visible = false;
    scene.remove(station.group);
    station.group.visible = false;
  }
});

test('a hidden source still reaches a rig slot, so hiding it costs nothing', () => {
  /* The reason the fix is one line and not a redesign: `LightRig._walk`
   * deliberately ignores a light's OWN `visible` flag - "the rig is what set
   * it to false" - so a light born hidden is still scanned, still scored and
   * still copied into a slot. If this ever stopped being true, every world in
   * the game would go dark and the case above would still pass. */
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 1000);
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld(true);
  const rig = new LightRig({ scene, camera });

  const l = pointLight(0xff8844, 40, 30, 2);
  l.name = 'test:hidden';
  l.position.set(2, 1, 0);
  scene.add(l);
  scene.updateMatrixWorld(true);

  assert.equal(l.visible, false, 'gfx/WorldLight.js handed back a visible light');
  /* Two updates: the first commits the slot, and `_crossfade` fades in over
   * FADE_IN seconds, so the second is what brings the intensity up. */
  rig.update(1 / 60);
  rig.update(1);

  assert.equal(rig.stats.sources, 1, 'the rig did not see the hidden light as a source');
  const lit = rig.point.filter((s) => s.src === l && s.light.intensity > 0);
  assert.equal(lit.length, 1,
    'a hidden light never reached a slot - hiding at construction would now be a blackout, '
    + 'not a free optimisation');
  assert.equal(lightSignature(scene).point, RIG_BUDGET.point,
    'the source is being counted as well as its slot');
});

test('every factory hands back a real, hidden, otherwise untouched light', () => {
  const p = pointLight(0x123456, 7, 8, 1.5);
  assert.equal(p.isPointLight, true);
  assert.equal(p.visible, false);
  assert.equal(p.color.getHex(), 0x123456);
  assert.equal(p.intensity, 7);
  assert.equal(p.distance, 8);
  assert.equal(p.decay, 1.5);

  const s = spotLight(0x654321, 9, 10, 0.4, 0.6, 1.7);
  assert.equal(s.isSpotLight, true);
  assert.equal(s.visible, false);
  assert.equal(s.angle, 0.4);
  assert.equal(s.penumbra, 0.6);
  assert.equal(s.decay, 1.7);
  assert.ok(s.target, 'the spot lost its target, which is what the rig copies to aim the slot');

  const d = dirLight(0xabcdef, 2.5);
  assert.equal(d.isDirectionalLight, true);
  assert.equal(d.visible, false);
  assert.equal(d.intensity, 2.5);
  assert.equal(d.castShadow, false, 'castShadow feeds numDirLightShadows - it is the caller\'s to set');

  /* Omitted arguments must still land on THREE's own defaults, or a call site
   * that passed three arguments would silently get `distance: undefined`. */
  const bare = pointLight(0xffffff, 1);
  assert.equal(bare.distance, 0);
  assert.equal(bare.decay, 2);
});
