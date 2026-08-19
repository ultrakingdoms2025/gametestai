import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { Viewpoints, normaliseViewpoint, SYNC_PAD, SYNC_BAND, REVEAL_R } from '../../src/systems/Viewpoints.js';

/**
 * THE REAL CITADEL, THROUGH THE REAL CONSUMER.
 *
 * Every other file in this drop drives the systems against doubles, which is
 * how a behaviour is pinned. This one asks the question no double can answer:
 * **does the world the player actually loads satisfy the contract?**
 *
 * That is not a rhetorical question here. `world.viewpoints` had zero consumers
 * for its whole life, so nothing had ever checked that its entries were
 * complete. Three of the four fields this drop depends on - `launch`, the
 * resolved `hay`, and the platform `r` - were written for a reader that did not
 * exist. The medieval lesson restated in the design's §6 is precisely this:
 * every existing world test asks whether a thing was BUILT, and none asks
 * whether the thing a player meets is usable.
 *
 * One headless build, shared by every test below.
 */

/* ------------------------------------------------------------------ */
/* A world, without a browser. Template: citadel-reach.test.mjs:157    */
/* ------------------------------------------------------------------ */

function harness() {
  if (globalThis.__discoveryHarness) return;
  globalThis.__discoveryHarness = true;
  class Img {
    constructor(a, b, c) {
      if (typeof a === 'number') {
        this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4);
      } else { this.data = a; this.width = b; this.height = c ?? 1; }
    }
  }
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      createConicGradient: () => gradient,
      createPattern: () => null,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 0);
  globalThis.document = {
    createElement(tag) {
      const c = { width: 1, height: 1, style: {}, tagName: tag };
      c.getContext = () => context2d(c);
      return c;
    },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
  globalThis.window = globalThis;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return context2d(this); }
  };
  const dead = () => ({ texture: null, dispose() {} });
  THREE.PMREMGenerator.prototype.fromEquirectangular = dead;
  THREE.PMREMGenerator.prototype.fromScene = dead;
  THREE.PMREMGenerator.prototype.compileEquirectangularShader = () => {};
}

harness();
const { Physics } = await import('../../src/physics/Physics.js');
const { CitadelWorld } = await import('../../src/worlds/CitadelWorld.js');
const relicsModule = await import('../../src/systems/Relics.js');

const physics = new Physics();
const world = new CitadelWorld({
  physics,
  scene: new THREE.Scene(),
  bus: { on: () => () => {}, emit() {} },
  engine: {
    renderer: {
      capabilities: { getMaxAnisotropy: () => 4, isWebGL2: true },
      initTexture() {}, getContext: () => ({}),
      getRenderTarget: () => null, setRenderTarget() {}, render() {}, clear() {},
    },
    onFrameUpdate: () => () => {},
    onResize: () => () => {},
  },
  materials: { get: () => new THREE.MeshStandardMaterial(), dispose() {} },
});
world.physics = physics;
await world.build(() => {});

/* ====================================================================== */

test('every published viewpoint survives normalisation', () => {
  /* A dropped entry is invisible: the list is simply shorter and the player is
   * never told a vantage point exists. TEN are authored - the great tower and
   * four minarets on the mesa, and one apiece on five of the six outer-ring
   * regions. The aqueduct has none, deliberately: it is a route rather than a
   * place, and its whole length is overlooked by the Eyrie at one end and the
   * mesa at the other. */
  assert.ok(Array.isArray(world.viewpoints), 'the citadel stopped publishing viewpoints');
  assert.equal(world.viewpoints.length, 10, `the citadel publishes ${world.viewpoints.length}, not 10`);

  const kept = world.viewpoints.map((v, i) => normaliseViewpoint(v, i)).filter(Boolean);
  assert.equal(kept.length, 10, 'the consumer drops citadel viewpoints on the floor');
  assert.equal(new Set(kept.map((v) => v.id)).size, 10, 'two viewpoints share an id');
  for (const v of kept) {
    assert.ok(v.name && v.name !== `Viewpoint ${kept.indexOf(v) + 1}`,
      `"${v.id}" fell back to a generated name - the world stopped naming it`);
    assert.ok(v.r >= 2 && v.r < 20, `"${v.id}" has an implausible platform radius ${v.r}`);
    assert.ok(v.y > 30, `"${v.id}" is only ${v.y.toFixed(1)} m up - that is not a vantage point`);
  }
});

test('the great tower offers a leap, and its haystack is a real surface', () => {
  /* The design's §4.1 defect, seen from the consumer's end: the hay used to be
   * placed by `_groundAt`, which is blind to every structure, so all five
   * viewpoint haystacks were buried inside the inner-ward slab. A hay that did
   * not resolve to a real y is exactly what `normaliseViewpoint` refuses to
   * turn into a prompt - so if the placement regresses, the leap silently
   * disappears rather than silently killing people. This asserts it is there. */
  const great = world.viewpoints.find((v) => v.id === 'great-tower');
  assert.ok(great, 'the great tower is no longer a published viewpoint');

  const vp = normaliseViewpoint(great, 0);
  assert.ok(vp.launch, 'the great tower publishes no launch point');
  assert.ok(vp.hay, 'the great tower leap has no resolved haystack under it');

  // The drop is what the prompt states, and it must be a real fall.
  const drop = vp.launch.y - vp.hay.y;
  assert.ok(drop > 20, `the leap of faith is only ${drop.toFixed(1)} m - that is a step`);

  /* The hay must be DOWNRANGE of the beam, not behind the tower. This is the
   * §4.1 "launch beam points away from its own haystack" defect: the beam fires
   * at +Z and the old radial rule put the hay at -Z, 12.5 m behind the jump. */
  const away = { x: vp.hay.x - vp.launch.x, z: vp.hay.z - vp.launch.z };
  const heading = { x: Math.cos(great.bearing ?? 0), z: Math.sin(great.bearing ?? 0) };
  const along = away.x * heading.x + away.z * heading.z;
  assert.ok(along > 0,
    `the haystack is ${(-along).toFixed(1)} m BEHIND the launch bearing, not in front of it`);
});

test('a player standing on each viewpoint synchronises it', () => {
  /* The one thing no unit test can check: that the citadel's own radii and
   * heights put a standing body inside the band this module tests against. A
   * platform published 4 m wide with the walkable deck 6 m below it would pass
   * every other test in this drop and never fire once in the game. */
  const bus = {
    handlers: new Map(),
    on(t, fn) { (this.handlers.get(t) ?? this.handlers.set(t, new Set()).get(t)).add(fn); return () => {}; },
    emit(t, p) { for (const fn of this.handlers.get(t) ?? []) fn(p); },
  };
  const player = { position: { x: 0, y: 0, z: 0 }, teleport() {} };
  const vps = new Viewpoints({ bus, player });
  bus.emit('world:changed', { id: 'citadel', world });
  assert.equal(vps.total, 10);

  for (const v of vps.list) {
    // Feet exactly on the published platform top, dead centre.
    player.position.x = v.x;
    player.position.y = v.y;
    player.position.z = v.z;
    vps.update(1 / 60);
    assert.ok(v.synced, `standing on "${v.name}" did not synchronise it`);
  }
  assert.equal(vps.syncedCount, 10);
  assert.equal(vps.anchors.length, 10, 'the fast-travel list did not fill');
});

test('standing on the real launch beam raises the real prompt', () => {
  /* The last gap a double cannot close: the beam tip is a published point on a
   * 1.1 x 0.5 m plank 67.6 m up, and `LEAP_R` is 3 m. If the two ever disagree
   * the player walks to the end of the diving board and is told nothing. */
  const seen = [];
  const bus = {
    handlers: new Map(),
    on(t, fn) { (this.handlers.get(t) ?? this.handlers.set(t, new Set()).get(t)).add(fn); return () => {}; },
    emit(t, p) { if (t === 'viewpoint:prompt') seen.push(p); for (const fn of this.handlers.get(t) ?? []) fn(p); },
  };
  const player = { position: { x: 0, y: 0, z: 0 } };
  const vps = new Viewpoints({ bus, player });
  bus.emit('world:changed', { id: 'citadel', world });

  const great = vps.list.find((v) => v.id === 'great-tower');
  const raw = world.viewpoints.find((v) => v.id === 'great-tower');
  const head = { x: Math.cos(raw.bearing), z: Math.sin(raw.bearing) };

  /* NOT dead on the published point. Nobody stops with their feet on a
   * coordinate: a player walks out along the beam and halts short of the drop,
   * so the prompt has to be up across the last stride of it. Sampled every
   * 30 cm back from the tip, which is the band a body can actually occupy. */
  for (let back = 0; back <= 1.5; back += 0.3) {
    player.position.x = great.launch.x - head.x * back;
    player.position.y = great.launch.y;
    player.position.z = great.launch.z - head.z * back;
    /* Force a fresh emit each step. The prompt only writes when it changes, and
     * seeding `null` would make a *disappearing* prompt a silent no-op - the
     * sample would then read the previous step's line and pass on stale data. */
    vps._promptId = '__force__';
    vps.update(1 / 60);
    const p = seen.at(-1);
    assert.ok(p?.text, `no leap offered ${back.toFixed(1)} m back along the beam`);
    assert.equal(p.viewpointId, 'great-tower');
    assert.ok(p.drop > 20, `the prompt claims a ${p.drop.toFixed(1)} m drop`);
  }
});

/**
 * The REAL relic placement, from the real placer.
 *
 * Not modelled and not `_roofs` used as a stand-in: `Relics._onWorld` shuffles
 * the authored anchors with its own seeded PRNG, drops anything inside
 * `MIN_APART`, and adds the towers - so the thirty sites the map gates on are
 * a subset of the roofs in an order nothing else can reproduce.
 */
function relicSites() {
  const { Relics } = relicsModule;
  const r = new Relics({
    scene: new THREE.Scene(), physics, player: null,
    bus: { on: () => () => {}, emit() {} },
  });
  r._onWorld('citadel', world);
  return r.sites.map((s) => ({ x: s.pos.x, z: s.pos.z }));
}

test('one climb does not reveal the whole citadel, and ten do', () => {
  const bus = {
    handlers: new Map(),
    on(t, fn) { (this.handlers.get(t) ?? this.handlers.set(t, new Set()).get(t)).add(fn); return () => {}; },
    emit(t, p) { for (const fn of this.handlers.get(t) ?? []) fn(p); },
  };
  const player = { position: { x: 0, y: 0, z: 0 } };
  const vps = new Viewpoints({ bus, player });
  bus.emit('world:changed', { id: 'citadel', world });

  const rel = world._roofs.map((r) => [r.x, r.z]);
  assert.ok(rel.length > 20, 'the citadel stopped publishing roofs to hide relics on');

  const revealed = () => rel.filter(([x, z]) => vps.reveals(x, z)).length;
  assert.equal(revealed(), 0, 'the citadel roofs were revealed before anything was climbed');

  const first = vps.list[0];
  player.position.x = first.x; player.position.y = first.y; player.position.z = first.z;
  vps.update(1 / 60);
  /* Floor / achieved / ceiling, all three measured against this build. The
   * ceiling is the ablation: `REVEAL_R = 120`, the value this shipped with in
   * its first draft, reveals 186 of 192 roofs on ONE climb and all 192 on five
   * - which is why the floors below are two-sided. A reveal that opens
   * everything is a reveal that has deleted the hiding. */
  const afterOne = revealed();
  assert.ok(afterOne >= 40, `one climb revealed ${afterOne}/${rel.length} roofs - floor 40 (62 today)`);
  assert.ok(afterOne <= rel.length * 0.45,
    `one climb revealed ${afterOne}/${rel.length} roofs - that is most of the world for one tower`);

  for (const v of vps.list) {
    player.position.x = v.x; player.position.y = v.y; player.position.z = v.z;
    vps.update(1 / 60);
  }
  /* The mesa's five stand inside r = 21 of the centre and their discs overlap
   * heavily; the ring's five stand 280-420 m out, one per region, and each
   * opens its own neighbourhood and nothing else. So the set opens the citadel
   * core and six islands, while the outer souk rings, the curtain wall and
   * every stretch of flat between the regions stay something you find by
   * looking. Measured today: 182 of 369, against 104 of 192 before the ring
   * was authored - the SHARE barely moved (49.3% against 54.2%), which is the
   * property this floor is really about. */
  const afterAll = revealed();
  assert.ok(afterAll > afterOne, 'climbing the other nine revealed nothing more');
  assert.ok(afterAll >= 90, `the whole set revealed only ${afterAll}/${rel.length} roofs - floor 90`);
  assert.ok(afterAll <= rel.length * 0.75,
    `synchronising all ten revealed ${afterAll}/${rel.length} roofs - the hunt is over on arrival`);

  /* ---- and the population that actually matters --------------------- */
  /* Roofs are the SUBSTRATE. The thing `Minimap` gates on `reveals` is a relic
   * spark, and the number on the HUD is "Relics n/30", so a radius chosen and
   * floored against roof counts alone was floored against the wrong curve -
   * `REVEAL_R`'s own table used to carry only the roof columns. `Relics` puts
   * its thirty on a shuffled subset of these roofs PLUS the thirteen towers,
   * so the two curves separate: at 70 m the roofs read 33% / 54% and the
   * relics read 30% / 47%.
   *
   * Two-sided, and the ceiling is the ablation for the same reason as above:
   * at REVEAL_R = 120 one climb marks 27 of 30 and the set marks all 30, which
   * is the map handing over the collection. Measured today at 9 and 14. */
  const sites = relicSites();
  /* 109, not 30, and the number is the ring's doing rather than a tuning
   * change: `Relics._onWorld` budgets by the AREA of `contentBounds`, which was
   * the protected core alone while the ring was empty and is now the union of
   * the core and six authored regions. `MAX_PER_WORLD` 110 is the ceiling and
   * this world is one relic under it. */
  assert.equal(sites.length, 109, `the citadel hides ${sites.length}, not 109`);
  const markedAll = sites.filter((s) => vps.reveals(s.x, s.z)).length;
  /* Held as a SHARE rather than a count, because the count now moves with the
   * content box and the property being defended never did: climbing every
   * tower has to be worth a map, and must not hand over the collection.
   * Measured today 55/109 = 50.5%; before the ring, 14/30 = 46.7%. */
  assert.ok(markedAll >= sites.length * 0.30,
    `the whole set marks only ${markedAll}/${sites.length} relics - climbing every tower has to be worth a map`);
  assert.ok(markedAll <= sites.length * 0.70,
    `the whole set marks ${markedAll}/${sites.length} relics - past two thirds the sparks ARE the collection`);
  console.log(`    relics marked: ${markedAll}/${sites.length} with all ten synchronised (roofs ${afterAll}/${rel.length})`);
});

test('the citadel bands are not so tight that a body misses them', () => {
  /* Quoted floor / achieved: the sync test above stands dead centre, which is
   * the easy case. This measures the margin a real approach actually has. */
  for (const raw of world.viewpoints) {
    const v = normaliseViewpoint(raw, 0);
    const reach = v.r + SYNC_PAD;
    assert.ok(reach >= 4.5,
      `"${v.name}" is only ${reach.toFixed(2)} m across - a running body would step over it`);
  }
  assert.ok(SYNC_BAND >= 2, `the vertical band is ${SYNC_BAND} m`);
  assert.ok(REVEAL_R >= 60, `the reveal radius is ${REVEAL_R} m`);
});
