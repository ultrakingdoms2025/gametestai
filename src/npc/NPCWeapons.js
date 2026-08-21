import * as THREE from 'three';

/**
 * Hostile weapon table and the procedural models that go with it.
 *
 * Every hostile used to carry the same rifle and deal the same flat
 * `CONFIG.npc.attackDamage`, so a firefight had exactly one texture to it: a
 * steady drizzle of identical chip damage from identical silhouettes. Giving
 * each encounter a weapon with its own reach, cadence, telegraph and damage
 * band turns the same ten enemies into a readable mix - the sidearm plinks at
 * you up close, the rifle suppresses from mid range, the bow and the staff hit
 * hard but announce themselves first.
 *
 * Readability is the constraint that shapes the numbers. Anything that hits
 * hard has a long telegraph and a slow cycle, so there is always a beat between
 * "that thing is winding up" and "I have taken 30 damage". Damage carries only
 * a modest random spread: enough that fights are not metronomic, not so much
 * that the player cannot predict how many hits they can afford.
 *
 * Ids match the labels the HUD already knows: sidearm / rifle / bow / staff.
 */

/**
 * @typedef {object} NPCWeaponDef
 * @property {string} id
 * @property {string} name          shown by the HUD
 * @property {number} damage        base damage per round
 * @property {number} spread        fractional damage jitter, +/- of `damage`
 * @property {number} range         maximum engagement distance, metres
 * @property {number} preferredMin  low edge of the band the AI holds
 * @property {number} preferredMax  high edge of the band the AI holds
 * @property {number} telegraph     seconds of wind-up before the first round
 * @property {[number,number]} burst rounds per burst (inclusive range)
 * @property {number} burstDelay    seconds between rounds inside a burst
 * @property {[number,number]} cooldown seconds between bursts
 * @property {number} magazine      rounds before a reload
 * @property {number} reload        seconds
 * @property {number} accuracy      0..1, fed to the combat solver
 * @property {number} aimDrift      extra aim cone, radians
 * @property {string} model         key into `buildWeaponModel`
 */

/** @type {Record<string, NPCWeaponDef>} */
export const NPC_WEAPONS = {
  sidearm: {
    id: 'sidearm',
    name: 'sidearm',
    damage: 7,
    spread: 0.2,
    range: 20,
    preferredMin: 5,
    preferredMax: 11,
    telegraph: 0.2,
    burst: [1, 2],
    burstDelay: 0.19,
    cooldown: [0.5, 1.0],
    magazine: 12,
    reload: 1.5,
    accuracy: 0.55,
    aimDrift: 0.02,
    model: 'pistol',
  },
  rifle: {
    id: 'rifle',
    name: 'rifle',
    damage: 10,
    spread: 0.18,
    range: 34,
    preferredMin: 9,
    preferredMax: 20,
    telegraph: 0.36,
    burst: [3, 5],
    burstDelay: 0.11,
    cooldown: [1.1, 2.3],
    magazine: 30,
    reload: 2.1,
    accuracy: 0.64,
    aimDrift: 0.012,
    model: 'rifle',
  },
  bow: {
    id: 'bow',
    name: 'bow',
    damage: 26,
    spread: 0.24,
    range: 32,
    preferredMin: 12,
    preferredMax: 24,
    // A single arrow for 26 is only fair if you can see it coming: nearly a
    // second of draw, and the aim layer holds dead still through all of it.
    telegraph: 0.95,
    burst: [1, 1],
    burstDelay: 0.2,
    cooldown: [1.5, 2.4],
    magazine: 1,
    reload: 0.75,
    accuracy: 0.7,
    aimDrift: 0.008,
    model: 'bow',
  },
  /* --- melee ---------------------------------------------------------
   *
   * Every hostile in the build was a shooter, so every fight was the same
   * fight: back away, trade at range, win. A brawler changes the question the
   * player has to answer - you cannot kite something that is already inside
   * your minimum range, so it forces movement instead of rewarding it.
   *
   * Mechanically these are ordinary weapons with a 2.5 m reach. `_fire` is a
   * hitscan, so a swing that only carries two and a half metres *is* a melee
   * hit, and the whole targeting, telegraph and cover stack works unchanged.
   * The long telegraph is the fairness knob it always was: 30 damage is only
   * fair if you get three quarters of a second to move out of the arc. */
  blade: {
    id: 'blade',
    name: 'blade',
    damage: 30,
    spread: 0.3,
    range: 2.8,
    preferredMin: 0,
    preferredMax: 1.9,
    telegraph: 0.72,
    burst: [1, 1],
    burstDelay: 0.2,
    cooldown: [0.7, 1.2],
    magazine: 999,
    reload: 0.2,
    accuracy: 0.8,
    aimDrift: 0.004,
    model: 'staff',
  },
  baton: {
    id: 'baton',
    name: 'shock baton',
    damage: 24,
    spread: 0.3,
    range: 2.6,
    preferredMin: 0,
    preferredMax: 1.8,
    telegraph: 0.55,
    burst: [1, 2],
    burstDelay: 0.28,
    cooldown: [0.6, 1.1],
    magazine: 999,
    reload: 0.2,
    accuracy: 0.78,
    aimDrift: 0.005,
    model: 'staff',
  },

  staff: {
    id: 'staff',
    name: 'staff',
    damage: 21,
    spread: 0.26,
    range: 26,
    preferredMin: 8,
    preferredMax: 18,
    telegraph: 0.8,
    burst: [1, 1],
    burstDelay: 0.2,
    cooldown: [1.3, 2.1],
    magazine: 4,
    reload: 1.8,
    accuracy: 0.68,
    aimDrift: 0.01,
    model: 'staff',
  },
};

/**
 * Which weapons a world's hostiles draw from, and how often.
 *
 * Weighted per theme so the mix reads as belonging to the place: the station
 * security units are all firearms, the keep is bows and staves with the odd
 * crossbow-ish sidearm, the sports world sits in between.
 */
export const WEAPON_TABLES = {
  station: [
    ['rifle', 5],
    ['sidearm', 3],
    ['staff', 2],
    ['baton', 3],
  ],
  medieval: [
    ['bow', 4],
    ['staff', 3],
    ['blade', 4],
    ['sidearm', 2],
    ['rifle', 1],
  ],
  sports: [
    ['rifle', 4],
    ['sidearm', 4],
    ['bow', 2],
    ['baton', 2],
  ],
  /* Lodestar Yard. `rules.hostiles` is FALSE there, so nothing in this row is
   * drawn today - and it is here anyway for the reason `DROP_TABLES.dock`
   * exists: the rule can flip, the fallback at the lookup is silent, and the
   * failure mode is a civilian shipyard whose security detail turns up armed
   * out of the Aether Nexus armoury. A yard's own violence is tools: the baton
   * is a spanner, the blade is a cutting torch, and the two firearms are what
   * a site security officer would actually be issued. */
  dock: [
    ['baton', 4],
    ['blade', 3],
    ['sidearm', 3],
    ['rifle', 1],
  ],
};

/** Ids that close to contact range rather than trading fire. */
const MELEE_IDS = new Set(['blade', 'baton']);

/** @param {string} id @returns {boolean} */
export function isMelee(id) {
  return MELEE_IDS.has(id);
}

/**
 * Draw a weapon id for one encounter.
 * @param {string} theme
 * @param {() => number} rnd 0..1 generator
 * @returns {string}
 */
export function pickWeaponId(theme, rnd) {
  const table = WEAPON_TABLES[theme] ?? WEAPON_TABLES.station;
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rnd() * total;
  for (const [id, w] of table) {
    roll -= w;
    if (roll <= 0) return id;
  }
  return table[0][0];
}

/**
 * Damage for one round: base plus a symmetric spread, never below 1.
 * @param {NPCWeaponDef} def
 * @param {() => number} rnd
 */
export function rollDamage(def, rnd) {
  const jitter = 1 + (rnd() * 2 - 1) * def.spread;
  return Math.max(1, Math.round(def.damage * jitter * 10) / 10);
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

/**
 * Merge a list of indexed box/cylinder geometries by hand.
 *
 * BufferGeometryUtils is an addon and this is nine primitives; doing it inline
 * keeps the weapon models free of an import the rest of `src/npc` does not
 * need. Every source geometry here is indexed with position/normal/uv, which is
 * true of every Three primitive used below.
 *
 * @param {THREE.BufferGeometry[]} parts consumed and disposed
 * @returns {THREE.BufferGeometry}
 */
function mergeSimple(parts) {
  let vTotal = 0;
  let iTotal = 0;
  for (const p of parts) {
    const count = p.getAttribute('position').count;
    vTotal += count;
    // NOT every three primitive is indexed: everything derived from
    // PolyhedronGeometry - Octahedron, Icosahedron, Tetrahedron, Dodecahedron -
    // emits raw triangle soup, so getIndex() is null. The staff's crystal is an
    // octahedron, and assuming an index here threw during hostile NPC
    // construction and took every hostile in the world down with it. Treat a
    // missing index as the implicit sequential one.
    const index = p.getIndex();
    iTotal += index ? index.count : count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.getAttribute('position');
    const pn = p.getAttribute('normal');
    const pu = p.getAttribute('uv');
    const pi = p.getIndex();
    pos.set(pp.array, vo * 3);
    nrm.set(pn.array, vo * 3);
    uv.set(pu.array, vo * 2);
    const iCount = pi ? pi.count : pp.count;
    for (let i = 0; i < iCount; i++) idx[io + i] = (pi ? pi.getX(i) : i) + vo;
    vo += pp.count;
    io += iCount;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

const _wq = new THREE.Quaternion();
const _we = new THREE.Euler();
const _wm = new THREE.Matrix4();
const _wv = new THREE.Vector3();
const _wsOne = new THREE.Vector3(1, 1, 1);

/** Place one primitive into a part list. Rotations are XYZ eulers, radians. */
function place(parts, geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  _we.set(rx, ry, rz);
  _wq.setFromEuler(_we);
  _wm.compose(_wv.set(x, y, z), _wq, _wsOne);
  geo.applyMatrix4(_wm);
  parts.push(geo);
  return geo;
}

/* Each builder authors the weapon along -Z (the direction a character faces at
 * yaw 0) with the grip at the origin, so a single mount transform serves all of
 * them and the muzzle offsets below are directly comparable. */

function pistolGeo() {
  const p = [];
  place(p, new THREE.BoxGeometry(0.036, 0.062, 0.17), 0, 0.01, -0.05);          // slide
  place(p, new THREE.BoxGeometry(0.03, 0.052, 0.12), 0, -0.005, -0.075);        // frame
  place(p, new THREE.BoxGeometry(0.032, 0.105, 0.045), 0, -0.078, 0.012, 0.22); // grip
  place(p, new THREE.BoxGeometry(0.022, 0.028, 0.03), 0, -0.03, -0.005);        // trigger guard
  place(p, new THREE.CylinderGeometry(0.008, 0.008, 0.05, 8), 0, 0.012, -0.15, Math.PI / 2);
  place(p, new THREE.BoxGeometry(0.012, 0.012, 0.016), 0, 0.045, -0.11);        // front sight
  return mergeSimple(p);
}

function rifleGeo() {
  const p = [];
  place(p, new THREE.BoxGeometry(0.05, 0.075, 0.36), 0, 0, -0.06);
  place(p, new THREE.BoxGeometry(0.036, 0.05, 0.3), 0, -0.005, -0.35);
  place(p, new THREE.CylinderGeometry(0.011, 0.011, 0.26, 8), 0, 0.006, -0.58, Math.PI / 2);
  place(p, new THREE.BoxGeometry(0.042, 0.1, 0.11), 0, -0.075, -0.02);
  place(p, new THREE.BoxGeometry(0.046, 0.085, 0.2), 0, -0.012, 0.2);
  place(p, new THREE.BoxGeometry(0.03, 0.055, 0.045), 0, 0.055, -0.02);
  return mergeSimple(p);
}

/**
 * Recurve bow: a riser at the grip and two limbs swept forward, drawn as a
 * chain of short segments so the curve reads in silhouette. The string is a
 * separate thin run down the back so it can take its own pale material.
 */
function bowGeo(withString) {
  const p = [];
  if (!withString) {
    place(p, new THREE.BoxGeometry(0.038, 0.2, 0.05), 0, 0, 0);                 // riser
    place(p, new THREE.BoxGeometry(0.03, 0.05, 0.06), 0, 0.02, -0.035);         // arrow shelf
    const SEG = 5;
    for (const s of [1, -1]) {
      for (let i = 0; i < SEG; i++) {
        const t = (i + 0.5) / SEG;
        // Limb curves forward (-Z) as it runs away from the grip.
        const y = s * (0.1 + t * 0.42);
        const z = -0.02 - t * t * 0.13;
        const tilt = s * (0.18 + t * 0.5);
        place(p, new THREE.BoxGeometry(0.022 - t * 0.008, 0.11, 0.026 - t * 0.008), 0, y, z, tilt);
      }
    }
    return mergeSimple(p);
  }
  // String: grip to each limb tip, plus the nocked arrow lying on the shelf.
  place(p, new THREE.CylinderGeometry(0.0035, 0.0035, 0.56, 4), 0, 0.28, 0.02, 0.16);
  place(p, new THREE.CylinderGeometry(0.0035, 0.0035, 0.56, 4), 0, -0.28, 0.02, -0.16);
  place(p, new THREE.CylinderGeometry(0.005, 0.005, 0.62, 5), 0, 0.02, -0.28, Math.PI / 2);
  place(p, new THREE.BoxGeometry(0.002, 0.03, 0.05), 0, 0.035, 0.0);
  return mergeSimple(p);
}

/**
 * Focus staff: a shaft with a bound grip and a caged crystal head. The head is
 * the emissive part, which is what makes an incoming staff shot legible - the
 * telegraph is a light source at the top of a two-metre silhouette.
 */
function staffGeo(head) {
  const p = [];
  if (!head) {
    place(p, new THREE.CylinderGeometry(0.019, 0.023, 1.5, 8), 0, 0.02, -0.42, Math.PI / 2);
    place(p, new THREE.CylinderGeometry(0.028, 0.028, 0.13, 8), 0, 0.02, -0.05, Math.PI / 2);
    place(p, new THREE.CylinderGeometry(0.028, 0.028, 0.1, 8), 0, 0.02, -0.72, Math.PI / 2);
    // Three prongs cradling the crystal.
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      place(
        p,
        new THREE.BoxGeometry(0.014, 0.13, 0.014),
        Math.cos(a) * 0.035,
        0.02 + Math.sin(a) * 0.035,
        -1.09,
        0,
        0,
        0
      );
    }
    return mergeSimple(p);
  }
  place(p, new THREE.OctahedronGeometry(0.056, 0), 0, 0.02, -1.12);
  return mergeSimple(p);
}

/**
 * Build (or fetch from the shared cache) the meshes for one weapon.
 *
 * Geometry is cached on `assets.geoCache` and materials come from the shared
 * `CharacterAssets` pools, so ten hostiles carrying four different weapons cost
 * four geometries and a handful of materials, not forty of each.
 *
 * @param {string} weaponId
 * @param {any} assets CharacterAssets
 * @param {string} theme
 * @returns {{group:THREE.Group, muzzle:[number,number,number], mount:{pos:[number,number,number], rot:[number,number,number]}, glow:THREE.Mesh|null}}
 */
export function buildWeaponModel(weaponId, assets, theme) {
  const def = NPC_WEAPONS[weaponId] ?? NPC_WEAPONS.rifle;
  const group = new THREE.Group();
  group.name = `npc.weapon.${def.id}`;
  let glow = null;

  const cached = (key, make) => {
    let g = assets.geoCache.get(key);
    if (!g) {
      g = make();
      assets.geoCache.set(key, g);
    }
    return g;
  };
  const add = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = false;
    group.add(m);
    return m;
  };

  const gun = assets.metal(theme === 'medieval' ? 0x3a352c : 0x2a2e34, 'panel', 0.44);

  switch (def.model) {
    case 'pistol':
      add(cached('npc.wpn.pistol', pistolGeo), gun);
      break;
    case 'bow': {
      add(cached('npc.wpn.bow', () => bowGeo(false)), assets.leather(0x6b4a2c));
      add(cached('npc.wpn.bowstring', () => bowGeo(true)), assets.cloth(0xd8d2c2, 'canvas'));
      break;
    }
    case 'staff': {
      add(cached('npc.wpn.staff', () => staffGeo(false)), assets.leather(0x4a3b2a));
      // A real self-lit material, not the hi-vis `glow` trim: the crystal is the
      // telegraph, and it has to be visible as a bright point at 25 m.
      glow = add(
        cached('npc.wpn.staffhead', () => staffGeo(true)),
        assets.emissive(theme === 'medieval' ? 0x7fd8ff : 0x9affd0)
      );
      break;
    }
    default:
      add(cached('npc.wpn.rifle', rifleGeo), gun);
      break;
  }

  // Mount transforms are per model: a pistol sits in the fist, a bow hangs from
  // it side-on, a staff is gripped a third of the way up the shaft.
  const MOUNTS = {
    pistol: { pos: [0.01, -0.04, -0.03], rot: [-1.35, 0.06, 0], muzzle: [0, 0.012, -0.19] },
    rifle: { pos: [0.01, -0.05, -0.05], rot: [-1.35, 0.06, 0], muzzle: [0, 0.006, -0.71] },
    bow: { pos: [0.02, -0.05, -0.06], rot: [-1.5, 0.0, 1.45], muzzle: [0, 0.02, -0.34] },
    staff: { pos: [0.02, -0.06, -0.04], rot: [-1.42, 0.05, 0.1], muzzle: [0, 0.02, -1.12] },
  };
  const mount = MOUNTS[def.model] ?? MOUNTS.rifle;
  group.position.set(mount.pos[0], mount.pos[1], mount.pos[2]);
  group.rotation.set(mount.rot[0], mount.rot[1], mount.rot[2]);
  return { group, muzzle: mount.muzzle, mount, glow };
}
