/**
 * Livery maths shared by every mount.
 *
 * A livery is `{ [slotId]: { color?: number, finish?: 'matt'|'gloss' } }`.
 * Each mount declares its slots (`static CUSTOM_SLOTS`) and, once built, a
 * `_slotMats` map from slot id to the *cloned* materials that slot tints. This
 * module writes colour + finish onto those materials and can put them back to
 * factory, which it remembers on the material itself (`userData.factory`) the
 * first time it touches one - so "Reset to factory" needs no per-mount code.
 *
 * Finish is roughness / metalness / envMapIntensity only. No clearcoat, no
 * define changes: those relink the shader program mid-frame, and a program
 * link during play is exactly the stall the station work spent weeks removing.
 *
 * Deliberately imports nothing from three so the site-side catalog test can
 * import `MOUNT_STATS` without a renderer.
 */

/**
 * Uniform-only material presets for the two plain finishes.
 *
 * On the library's ORM-baked materials `roughness`/`metalness` are *multipliers*
 * over the baked maps (factory 1.0 / 1.0), so Matt keeps roughness at 1.0 -
 * never glossier than factory - and strips the metallic bake; Gloss scales the
 * bake down hard. On scalar `_mat` clones (Eagle tack 0.6, Bicycle frame 0.32)
 * the same numbers read as plain matt / gloss.
 */
export const FINISH_PROPS = {
  matt: { roughness: 1.0, metalness: 0.05, envMapIntensity: 0.6 },
  gloss: { roughness: 0.22, metalness: 0.35, envMapIntensity: 1.0 },
};
export const FINISHES = Object.keys(FINISH_PROPS);

/**
 * The stat ladder each mount sells. Kept here (pure data) rather than only on
 * the classes so the marketplace catalog test can check every
 * `grant_mount_power` row without instantiating a mount.
 */
export const MOUNT_STATS = {
  car: ['power', 'strength', 'shield'],
  dragon: ['power', 'strength', 'shield', 'fire'],
  eagle: ['power', 'strength', 'shield'],
  horse: ['power', 'strength', 'shield'],
  hoverboard: ['power', 'strength', 'shield'],
  bicycle: ['power', 'strength', 'shield'],
};

/** Per-tier effect, matching Car/Dragon.applyPowers. `unit` is UI copy. */
export const STAT_META = {
  power: { label: 'Speed', perTier: 12, unit: 'top speed' },
  strength: { label: 'Acceleration', perTier: 10, unit: 'acceleration' },
  shield: { label: 'Armour', perTier: 10, unit: 'less damage while riding' },
  fire: { label: 'Fire', perTier: 15, unit: 'fireball damage while riding' },
};

/**
 * 0xRRGGBB from a number or a '#rrggbb' / 'rrggbb' string; null if unusable.
 * @param {number|string|null|undefined} c
 * @returns {number|null}
 */
export function normColor(c) {
  if (typeof c === 'number') return Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : null;
  if (typeof c === 'string') {
    const s = c.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return parseInt(s, 16);
  }
  return null;
}

/** Remember a material's factory look once, so it can be restored later. */
function factoryOf(m) {
  if (!m.userData) m.userData = {};
  if (!m.userData.factory) {
    m.userData.factory = {
      color: m.color ? m.color.getHex() : null,
      emissive: m.emissive ? m.emissive.getHex() : null,
      roughness: m.roughness,
      metalness: m.metalness,
      envMapIntensity: m.envMapIntensity,
    };
  }
  return m.userData.factory;
}

let _scratch = null; // module-level Color reused by the mix path below

/**
 * Write a livery onto a mount's cloned materials.
 * @param {Object<string,{color?:number,finish?:string}>|null|undefined} livery
 * @param {Array<{id:string,finish:boolean}>} slots
 * Entries are a material, or `{ mat, mix?, emissive?, finish? }`: `mix` lerps
 * from factory toward the chosen colour (0..1), `emissive:true` also writes
 * `.emissive`, `finish:false` opts a material out of the slot's finish (e.g. a
 * wing membrane that takes 30% of the hide colour but must stay matt).
 * @param {Object<string, Array<any|{mat:any,mix?:number,emissive?:boolean,finish?:boolean}>>} slotMats
 */
export function applyLivery(livery, slots, slotMats) {
  const l = livery || {};
  for (const slot of slots || []) {
    const entries = slotMats?.[slot.id];
    if (!entries) continue;
    const want = l[slot.id] || {};
    const color = normColor(want.color);
    const finish = slot.finish && FINISH_PROPS[want.finish] ? FINISH_PROPS[want.finish] : null;
    for (const entry of entries) {
      const m = entry?.mat ?? entry;
      if (!m) continue;
      const mix = typeof entry?.mix === 'number' ? entry.mix : 1;
      const emissive = entry?.emissive === true;
      const takesFinish = slot.finish && entry?.finish !== false;
      const fac = factoryOf(m);
      if (m.color) {
        if (color == null || fac.color == null) { if (fac.color != null) m.color.setHex(fac.color); }
        else if (mix >= 1) m.color.setHex(color);
        else {
          m.color.setHex(fac.color);
          _scratch ??= m.color.clone();
          m.color.lerp(_scratch.setHex(color), mix);
        }
      }
      if (emissive && m.emissive) {
        m.emissive.setHex(color == null ? (fac.emissive ?? 0) : color);
      }
      if (takesFinish && 'roughness' in m) {
        const p = finish || fac;
        if (p.roughness != null) m.roughness = p.roughness;
        if (p.metalness != null) m.metalness = p.metalness;
        if (p.envMapIntensity != null) m.envMapIntensity = p.envMapIntensity;
      }
      m.needsUpdate = false; // uniforms only - never force a recompile
    }
  }
}

/**
 * True when `livery` shows `skinLivery`: every skin slot's colour matches, and
 * its finish matches where the skin specifies one.
 */
export function liveryMatches(livery, skinLivery) {
  if (!skinLivery) return false;
  const l = livery || {};
  for (const slot in skinLivery) {
    const want = skinLivery[slot];
    const have = l[slot];
    if (!have || normColor(have.color) !== normColor(want.color)) return false;
    if (want.finish && have.finish !== want.finish) return false;
  }
  return true;
}

/** Deep copy of a livery, keeping only well-formed slot entries. */
export function cloneLivery(livery) {
  const out = {};
  if (!livery || typeof livery !== 'object') return out;
  for (const slot in livery) {
    const v = livery[slot];
    if (!v || typeof v !== 'object') continue;
    const e = {};
    const c = normColor(v.color);
    if (c != null) e.color = c;
    if (FINISH_PROPS[v.finish]) e.finish = v.finish;
    if (Object.keys(e).length) out[slot] = e;
  }
  return out;
}
