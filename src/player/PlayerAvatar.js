import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';
import {
  HumanoidFactory,
  SLOT,
  THEME_RIM,
  BASE_HEIGHT,
  buildHairGeometry,
  HEADGEAR_STYLES,
  HEADGEAR_LABELS,
} from '../npc/Humanoid.js';
import { NPCAnimator } from '../npc/NPCAnimator.js';
import { AVATAR_FADE_LENGTH } from './CameraRig.js';

/**
 * The player's body.
 *
 * Built from the same `HumanoidFactory` and driven by the same `NPCAnimator` as
 * every NPC, so the character behind the camera is made of exactly the same
 * stuff as the ones in front of it - same skinning, same foot IK, same aim
 * layer. Locomotion is derived from `player.velocity`, `player.grounded` and the
 * stance blend rather than from an animation state machine, because that is what
 * the animator was designed to consume.
 *
 * ## First person: shadow-only rendering
 *
 * The requirement is that the body must not be visible around the camera but
 * must still cast a shadow, and the obvious levers both fail:
 *
 *   - `object.visible = false` removes the object from the shadow map too
 *     (`WebGLShadowMap.renderObject` returns immediately on it).
 *   - Moving the body to a private layer fails for the same reason: the shadow
 *     pass tests `object.layers` against the **view** camera, not the light.
 *
 * What works is to keep the object visible and switch its materials to write
 * nothing: `colorWrite = false` plus `depthWrite = false`. The shadow pass does
 * not use the material's colour state - it swaps in a depth material - so the
 * full-body shadow is unaffected, while the beauty pass renders the mesh and
 * discards every fragment.
 *
 * There is one trap in that, and it is why `allowOverride` is in here too:
 * `GTAOPass` renders a normal/depth prepass through `scene.overrideMaterial`,
 * which would replace our silenced material with its own and paint the inside
 * of the player's own head into the AO buffer - a dark blob over the entire
 * screen. `material.allowOverride = false` exempts the body from that pass.
 *
 * The avatar therefore owns a *private* `HumanoidFactory`, not the NPC one:
 * `CharacterAssets` caches materials by colour and hands the same instance to
 * every NPC that shares a skin tone, so toggling `colorWrite` on a shared
 * material would blank out half the crowd.
 */

/* Scratch. Each function owns its own, per the house rule. */
const _upBody = new THREE.Vector3();
const _clrOrigin = new THREE.Vector3();
const _clrDown = new THREE.Vector3(0, -1, 0);
const _mzOut = new THREE.Vector3();
const _dthDir = new THREE.Vector3();
const _airEuler = new THREE.Euler();
const _airQuat = new THREE.Quaternion();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/**
 * Crouch depth in animator units.
 *
 * The animator's crouch term drops the pelvis 0.24 m per unit before its leg IK
 * and hyperextension compensation claw some of it back - measured, 2.29 units
 * bought 0.376 m of pelvis. The player's capsule loses 0.73 m of eye height on
 * crouch, so a value of 1 leaves the body standing upright inside a crouched
 * collider. 3.0 puts the pelvis at ~0.49 m and the crown near 1.05 m, which is a
 * real squat that still resolves cleanly through the IK.
 */
const CROUCH_DEPTH = 3.0;
/** Extra crouch spike absorbed on landing, scaled by impact speed. */
const LAND_ABSORB = 0.085;

/**
 * Feet-to-floor gap beyond which the body is treated as airborne.
 *
 * `player.grounded` alone is not trustworthy enough to drive a jump pose: it
 * flickers over collider seams, and the unstuck system nudges the capsule
 * upward, which measured as 0.88 airborne while the player was standing
 * perfectly still - legs tucked, arms out, a starfish. Real clearance under the
 * feet cannot lie about that, and it costs one raycast a frame.
 */
const AIR_CLEARANCE = 0.32;
/** How far down the clearance probe looks before declaring open air. */
const AIR_PROBE = 3.0;

/** Turn rates, radians/second. Aiming locks the body to the camera. */
const TURN_AIM = 18;
const TURN_MOVE = 11;
const TURN_IDLE = 4.5;
/** Idle dead zone: the body does not chase small camera turns while standing. */
const TURN_DEADZONE = 0.6;

/** Barrel tip in the weapon prop's local frame (end of the muzzle brake). */
const MUZZLE_Z = -0.79;

/**
 * Seating of the carbine in the right hand.
 *
 * Measured, not guessed. `HostileNPC`'s numbers are authored for a rifle carried
 * at the side and put the barrel through the top of the head once the aim IK
 * raises the arms - the tip sat 2.16 m above the feet on the first run. These
 * were solved in-engine from the hand's world basis while the aim layer was at
 * full weight: align the prop's -Z with the aim direction and roll it so the
 * optic faces world up. The roll is ~166 degrees because the hand bone's rest
 * frame is close to inverted about the grip axis.
 */
const HAND_ROT = [-0.06, 0.03, 2.9];
/** Places the grip, not the model origin, in the palm. */
const HAND_POS = [-0.015, -0.056, -0.046];

/* ================================================================== */
/* Character configuration                                             */
/* ================================================================== */

/**
 * The player is one specific person across every session and every world, so
 * the seed is fixed. Everything a player can change about that person lives in
 * a `CharacterConfig` (see `DEFAULT_CHARACTER`); the seed only decides the
 * things nobody configures - skull jitter, width jitter, hair strand layout.
 */
export const PLAYER_SEED = 0x5ea71;

/**
 * The player's rim light never changes with the outfit.
 *
 * `addRim` folds the rim colour and strength into `customProgramCacheKey`, so a
 * character wearing a medieval-rim material needs its own copy of every
 * character program in the scene. On this driver that is roughly a second of
 * link time per program - the exact failure mode TODO-V4 items 2/4/5 are about.
 * One rim for the player means changing outfit costs texture generation and a
 * geometry loft, never a shader recompile.
 */
const PLAYER_RIM = THEME_RIM.station;

/**
 * Which fabric each theme's garments are woven from. A private mirror of the
 * table in `Humanoid.js`: that module is owned elsewhere and does not export
 * it, and a three-entry lookup is not worth an import contract.
 */
const CLOTH_KIND = { station: 'tech', medieval: 'knit', sports: 'jersey' };

/**
 * Sexual dimorphism, expressed entirely through `makeProportions`.
 *
 * `frame` is the one dial the proportion system gives us for the shoulder/hip
 * relationship - frame 0 is broad-shouldered and narrow-hipped (shoulders
 * x1.14, hips x0.96), frame 1 is the reverse (shoulders x1.00, hips x1.08) and
 * also carries a deeper chest through `chestF`. Pairing that with the shoulder
 * scale and a different height band gives two genuinely different silhouettes
 * out of the existing rig, which is the whole point: this is a menu over the
 * character tech, not a second character tech.
 */
export const SEX_PROFILES = {
  male: { label: 'Male', frame: 0, shoulderScale: 1.06, height: 1.78, build: 1, faceId: 2, hairStyle: 'crop' },
  female: { label: 'Female', frame: 1, shoulderScale: 0.90, height: 1.66, build: 0, faceId: 4, hairStyle: 'ponytail' },
};

/**
 * Wearable outfits, mapped onto the theme/variant pairs `Humanoid.js` already
 * builds.
 *
 * `topSlot` is always `SLOT.PRIMARY` and `legSlot` always `SLOT.SECONDARY`, but
 * what those slots actually *cover* depends on the garment - a flight suit is
 * one piece, so its "legs" colour lands on the collar and shoulder yoke instead
 * of on trousers. The labels below say so in the panel rather than leaving the
 * player to discover it by dragging a swatch.
 */
export const OUTFITS = {
  flightsuit: { label: 'Flight suit', theme: 'station', variant: 'eva', topLabel: 'Suit', legLabel: 'Collar & yoke' },
  jumpsuit: { label: 'Jumpsuit', theme: 'station', variant: 'jumpsuit', topLabel: 'Suit', legLabel: 'Collar & yoke' },
  tracksuit: { label: 'Tracksuit', theme: 'sports', variant: 'track', topLabel: 'Top', legLabel: 'Trousers' },
  sportskit: { label: 'Sports kit', theme: 'sports', variant: 'jersey', topLabel: 'Shirt', legLabel: 'Shorts' },
  tunic: { label: 'Tunic', theme: 'medieval', variant: 'tunic', topLabel: 'Tunic', legLabel: 'Hose' },
  robe: { label: 'Robe', theme: 'medieval', variant: 'robe', topLabel: 'Robe', legLabel: 'Cowl' },
};

export const HAIR_STYLE_IDS = ['short', 'crop', 'buzz', 'ponytail', 'bun', 'long', 'bald'];

/* Re-exported so the character menu has a single import for everything it
 * needs to draw itself. It already takes hair, outfits and the height range
 * from here; reaching past this module into Humanoid.js for the one field
 * would leak the character tech into the UI layer. */
export { HEADGEAR_STYLES, HEADGEAR_LABELS };

/** Height range the capsule can carry without the eye line looking wrong. */
export const HEIGHT_RANGE = { min: 1.52, max: 1.96 };

/**
 * The character every new session starts with: the man who was already here.
 * The three garment colours are station palette 0, which is what
 * `HumanoidFactory.create` used to pick for the player implicitly.
 */
export const DEFAULT_CHARACTER = {
  sex: 'male',
  build: 1,
  height: 1.78,
  faceId: 2,
  skinTone: 0xd9b18e,
  hairStyle: 'crop',
  headgear: 'none',
  hairColor: 0x2e2119,
  eyeColor: 0x4a3a2a,
  outfit: 'flightsuit',
  legs: 'flightsuit',
  topColor: 0x2f2b26,
  legColor: 0xc9c2b4,
  accentColor: 0x2fe0ff,
};

const _clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
};
const _clampNum = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
};
/** Anything a save, a URL or a fat-fingered console call can hand us -> 24-bit hex. */
const _hex = (v, fallback) => {
  if (typeof v === 'string') {
    const parsed = Number.parseInt(v.replace('#', ''), 16);
    return Number.isFinite(parsed) ? parsed & 0xffffff : fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? (n | 0) & 0xffffff : fallback;
};

/**
 * Coerce any object into a complete, valid character config.
 *
 * This is the guard that lets `SaveGame` hand a payload straight in: a save
 * written by an older build, by a different build, or by hand is only ever
 * going to lose the fields it got wrong, never throw.
 *
 * @param {any} cfg
 * @returns {typeof DEFAULT_CHARACTER}
 */
export function normaliseCharacter(cfg) {
  const src = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg : {};
  const sex = src.sex === 'female' ? 'female' : 'male';
  const profile = SEX_PROFILES[sex];
  return {
    sex,
    build: _clampInt(src.build, 0, 2, profile.build),
    height: _clampNum(src.height, HEIGHT_RANGE.min, HEIGHT_RANGE.max, profile.height),
    faceId: _clampInt(src.faceId, 0, 5, profile.faceId),
    skinTone: _hex(src.skinTone, DEFAULT_CHARACTER.skinTone),
    hairStyle: HAIR_STYLE_IDS.includes(src.hairStyle) ? src.hairStyle : profile.hairStyle,
    headgear: HEADGEAR_STYLES.includes(src.headgear) ? src.headgear : DEFAULT_CHARACTER.headgear,
    hairColor: _hex(src.hairColor, DEFAULT_CHARACTER.hairColor),
    eyeColor: _hex(src.eyeColor, DEFAULT_CHARACTER.eyeColor),
    outfit: OUTFITS[src.outfit] ? src.outfit : DEFAULT_CHARACTER.outfit,
    /* The legs, chosen independently of the shirt.
     *
     * Falls back to whatever `outfit` is rather than to a fixed default, so a
     * save written before this existed - and a player who has never touched the
     * control - gets the matching pair they had, not a random combination. */
    legs: OUTFITS[src.legs] ? src.legs : (OUTFITS[src.outfit] ? src.outfit : DEFAULT_CHARACTER.outfit),
    topColor: _hex(src.topColor, DEFAULT_CHARACTER.topColor),
    legColor: _hex(src.legColor, DEFAULT_CHARACTER.legColor),
    accentColor: _hex(src.accentColor, DEFAULT_CHARACTER.accentColor),
  };
}

/** Config -> the parameter object `HumanoidFactory.create` understands. */
export function characterCreateParams(cfg) {
  const c = normaliseCharacter(cfg);
  const outfit = OUTFITS[c.outfit];
  const legs = OUTFITS[c.legs] ?? outfit;
  const profile = SEX_PROFILES[c.sex];
  return {
    seed: PLAYER_SEED,
    theme: outfit.theme,
    variant: outfit.variant,
    legs: { theme: legs.theme, variant: legs.variant },
    // Slot 0 supplies the leather and metal accents; the three colours the
    // player actually controls are overwritten by `applyCharacterColors`.
    palette: 0,
    rim: PLAYER_RIM,
    height: c.height,
    build: c.build,
    frame: profile.frame,
    shoulderScale: profile.shoulderScale,
    hairStyle: c.hairStyle,
    headgear: c.headgear,
    hairColor: c.hairColor,
    skinTone: c.skinTone,
    eyeColor: c.eyeColor,
    faceId: c.faceId,
  };
}

/**
 * Repaint an existing humanoid to a config.
 *
 * `HumanoidFactory.create` only takes a palette *index*, so the three free
 * colours are applied here by swapping the entries of the material array the
 * `SkinnedMesh` is already drawing with. `CharacterAssets` caches by colour and
 * every material produced here has identical shader parameters to the one it
 * replaces, so this costs a uniform upload, not a program link.
 *
 * The eyelids and the hair shell hold their own references to the skin and hair
 * materials rather than reading the array, so they are re-pointed explicitly -
 * miss that and a change of skin tone leaves two pale eyelids on a dark face.
 *
 * @param {any} humanoid
 * @param {any} assets `CharacterAssets` owned by whichever factory built it
 * @param {typeof DEFAULT_CHARACTER} cfg already normalised
 */
export function applyCharacterColors(humanoid, assets, cfg) {
  if (!humanoid || !assets) return;
  const kind = CLOTH_KIND[humanoid.theme] ?? 'tech';
  const mats = humanoid.materials;
  const skin = assets.skin(cfg.skinTone, PLAYER_RIM);
  mats[SLOT.SKIN] = skin;
  mats[SLOT.PRIMARY] = assets.cloth(cfg.topColor, kind, PLAYER_RIM);
  mats[SLOT.SECONDARY] = assets.cloth(cfg.legColor, kind, PLAYER_RIM);
  mats[SLOT.GLOW] = assets.glow(cfg.accentColor, PLAYER_RIM);
  humanoid.mesh.material = mats;
  for (const e of humanoid.eyes ?? []) {
    e.lidUpper.material = skin;
    e.lidLower.material = skin;
    e.iris.material = assets.iris(cfg.eyeColor);
  }
  if (humanoid.hairMesh) humanoid.hairMesh.material = assets.hair(cfg.hairColor, PLAYER_RIM);
}

/**
 * Build a humanoid that *is* the player, using someone else's factory.
 *
 * This exists for the mount rider proxy, which poses its own figure on the
 * saddle and must not be the default man once the player has changed sex or
 * clothes. `MountManager` owns that call site; all it needs from here is one
 * function and the config to feed it (`PlayerAvatar.buildCharacter`).
 *
 * @param {import('../npc/Humanoid.js').HumanoidFactory} factory
 * @param {any} config
 * @returns {any} a `Humanoid`
 */
export function createCharacter(factory, config) {
  const cfg = normaliseCharacter(config);
  const humanoid = factory.create(characterCreateParams(cfg));
  applyCharacterColors(humanoid, factory.assets, cfg);
  return humanoid;
}

/** Rotation of the body while the character panel is open, radians/second. */
const PREVIEW_SPIN = 0.55;

export class PlayerAvatar {
  /**
   * @param {{ scene: THREE.Scene, engine: import('../core/Engine.js').Engine,
   *           materials: any, player: import('./Player.js').Player,
   *           bus: import('../core/EventBus.js').EventBus,
   *           physics?: import('../physics/Physics.js').Physics,
   *           seed?: number }} ctx
   */
  constructor({ scene, engine, materials, player, bus, physics = null, character = null }) {
    this.scene = scene;
    this.engine = engine;
    this.materials = materials;
    this.player = player;
    this.bus = bus;
    this.physics = physics ?? player?.physics ?? null;

    this.factory = new HumanoidFactory({ renderer: engine?.renderer });

    /**
     * The live character configuration. A fixed seed underneath it: the player
     * is one specific person across every session and every world, not a fresh
     * random crowd member on each boot.
     * @type {typeof DEFAULT_CHARACTER}
     */
    this._char = normaliseCharacter(character);
    this.humanoid = createCharacter(this.factory, this._char);

    this._root = this.humanoid.root;
    this._root.name = 'player.avatar';
    this._root.position.copy(player?.position ?? _upBody.set(0, 0, 0));
    scene.add(this._root);

    this.animator = new NPCAnimator({ humanoid: this.humanoid, physics: this.physics, seed: 11 });

    this._weapon = this._buildWeapon();

    /* --- render-state bookkeeping --------------------------------- */
    /** @type {THREE.Material[]} */
    this._materials = [];
    this._depthWrite = [];
    this._collectMaterials();
    this._shadowOnly = false;
    this._visible = true;
    /* ?dev=1 only. The harness detaches the camera (`player._harnessFrozen`) and
     * the rule below then SHOWS the body, so a review shot of the character is
     * not of an invisible one. But a measurement framing moves the player to the
     * camera as well - that is the only way the sun's shadow camera, which is
     * aimed at the player, covers what is on screen - and at that point the body
     * is standing in the lens. Setting this restores the ordinary first-person
     * silencing for the duration. Written only by src/dev/Harness.js; false for
     * every real player, so the rule below is unchanged for them. */
    this.harnessShadowOnly = false;

    /* --- animation state ------------------------------------------ */
    this._bodyYaw = player?.yaw ?? 0;
    this._turnRate = 0;
    this._airWeight = 0;
    this._landAbsorb = 0;
    this._dead = false;
    /** Mounts set this false and drive `root` themselves. */
    this.followPlayer = true;
    this._ridePose = 'none';
    /** Character panel is open: hold the body in view and turn it slowly. */
    this._preview = false;
    /** `_visible` as it was before the preview borrowed it. */
    this._preVisible = undefined;

    this._offs = [];
    if (bus) {
      this._offs.push(
        bus.on('player:landed', ({ speed }) => {
          this._landAbsorb = Math.min(1.15, Math.max(0, (speed ?? 0) - 2.4) * LAND_ABSORB);
        })
      );
      this._offs.push(bus.on('player:respawned', () => this._revive()));
      this._offs.push(bus.on('player:spawned', () => this._snap()));
    }

    if (player) player.avatar = this;
    this._snap();
  }

  /* ================================================================ */
  /* Contract accessors                                                */
  /* ================================================================ */

  /** @returns {THREE.Object3D} */
  get root() {
    return this._root;
  }

  /** Hard show/hide. Independent of the first-person shadow-only state. */
  setVisible(v) {
    this._visible = !!v;
    this._root.visible = this._visible;
  }

  get visible() {
    return this._visible;
  }

  /**
   * World-space barrel tip. This is the origin `CameraRig` fires third-person
   * shots from, so it has to be the real prop, not an estimate.
   * @param {THREE.Vector3} out
   * @returns {THREE.Vector3|null}
   */
  getMuzzleWorld(out) {
    if (!this._weapon) return null;
    this._weapon.updateWorldMatrix(true, false);
    return out.set(0, 0.006, MUZZLE_Z).applyMatrix4(this._weapon.matrixWorld);
  }

  /**
   * Ride pose for the mount system.
   * @param {'none'|'board'|'saddle'} kind
   */
  setRidePose(kind) {
    this._ridePose = kind ?? 'none';
    // Both poses are expressed through the animator's crouch term, which
    // re-solves the leg IK to keep the feet planted rather than fighting it.
    // 'board' is a loose athletic stance; 'saddle' is a deep seat.
    this.animator.setPosture(kind === 'saddle' ? 'squat' : 'none');
  }

  /* ================================================================ */
  /* Character configuration                                           */
  /* ================================================================ */

  /**
   * The player's current appearance, as a plain JSON-safe object.
   *
   * A copy, deliberately: `SaveGame` serialises it and `MountManager` feeds it
   * back into a factory, and neither should be able to mutate the live config
   * by holding onto the reference.
   *
   * @returns {typeof DEFAULT_CHARACTER}
   */
  get characterConfig() {
    return { ...this._char };
  }

  /**
   * Change the character. Applies immediately - there is no commit step.
   *
   * Three tiers of cost, decided here rather than by the caller:
   *
   *  - colour, hair colour, eye colour: a material swap, free.
   *  - hair style: one cached geometry, cheap.
   *  - height: the root scale, free.
   *  - sex, build, outfit: the body loft and the skeleton change, so the whole
   *    humanoid is rebuilt. Geometry is cached per archetype inside the factory,
   *    so the second visit to a combination costs nothing.
   *
   * @param {Partial<typeof DEFAULT_CHARACTER>} partial
   * @param {{silent?:boolean}} [opts] `silent` suppresses `character:changed`
   * @returns {typeof DEFAULT_CHARACTER} the config actually applied
   */
  setCharacterConfig(partial, opts = {}) {
    const prev = this._char;
    const src = partial && typeof partial === 'object' ? partial : {};
    // Switching sex without naming a height should move the height with it, or
    // "Female" produces a 1.78 m woman and the option looks broken.
    const merged = { ...prev, ...src };
    if (src.sex && src.sex !== prev.sex && src.height === undefined) {
      merged.height = SEX_PROFILES[src.sex === 'female' ? 'female' : 'male'].height;
    }
    const next = normaliseCharacter(merged);
    this._char = next;

    /* Headgear joins the rebuild list.
     *
     * Hair can be swapped in place because the avatar keeps a handle on that
     * one mesh, but headgear is attached during `create` and there is no
     * equivalent hook to retarget - and inventing one to save a rebuild the
     * player triggers by hand, once, from a menu would be optimising the wrong
     * thing. */
    const needsRebuild =
      next.sex !== prev.sex || next.build !== prev.build || next.outfit !== prev.outfit
      || next.legs !== prev.legs || next.headgear !== prev.headgear;

    if (needsRebuild) {
      this._rebuildBody();
    } else {
      if (next.hairStyle !== prev.hairStyle) this._setHair(next.hairStyle, next.hairColor);
      if (next.height !== prev.height) this._applyHeight(next.height);
      this._editMaterials(() => applyCharacterColors(this.humanoid, this.factory.assets, next));
    }

    if (!opts.silent) this.bus?.emit('character:changed', { config: this.characterConfig });
    return this.characterConfig;
  }

  /**
   * Build a second copy of the player, using someone else's factory.
   *
   * `MountManager._ensureRider` poses its own figure on the saddle because the
   * avatar's animator drives a walk cycle from player velocity. That figure has
   * to be *this* character or the player turns back into the default man the
   * moment they step onto a hoverboard.
   *
   * @param {import('../npc/Humanoid.js').HumanoidFactory} factory
   * @param {Partial<typeof DEFAULT_CHARACTER>} [overrides]
   * @returns {any} a `Humanoid`, or null if the factory refused
   */
  buildCharacter(factory, overrides = null) {
    if (!factory?.create) return null;
    return createCharacter(factory, overrides ? { ...this._char, ...overrides } : this._char);
  }

  /**
   * Character-panel preview mode.
   *
   * The preview is the real body, not a second render: the panel is a side
   * drawer, the camera goes to third person, and the figure turns slowly on the
   * spot with its arms down and its weapon stowed. That is both the cheapest
   * preview available - no second WebGL context, no duplicate program set - and
   * the most honest one, because what the player is looking at is exactly what
   * they will be playing.
   *
   * @param {boolean} on
   */
  setPreview(on) {
    const next = !!on;
    if (next === this._preview) return;
    this._preview = next;
    if (this._weapon) this._weapon.visible = !next;

    if (next) {
      // `setVisible(false)` short-circuits `update()` entirely, and the boot
      // warmup leaves the body hidden that way. A preview that silently shows
      // nothing is worse than no preview, so the panel takes the flag and hands
      // it back on close. Not while riding: the mount hides the body precisely
      // because it is posing its own rider, and two bodies is not a preview.
      this._preVisible = this._visible;
      if (!this.player?.movementOverride) this.setVisible(true);
      this.animator.setAimTarget(null);
      this._airWeight = 0;
      this._landAbsorb = 0;
      return;
    }
    if (this._preVisible !== undefined) {
      this.setVisible(this._preVisible);
      this._preVisible = undefined;
    }
  }

  get previewing() {
    return this._preview;
  }

  /* ================================================================ */
  /* Build                                                             */
  /* ================================================================ */

  /**
   * Rebuild the humanoid in place.
   *
   * The avatar object identity is preserved because everything else in the game
   * reaches the body through `player.avatar` and reads `.humanoid` fresh every
   * frame (`Swim.applyPose`, `Climb.applyPose`, `CameraRig._shoulderRay`), so
   * swapping the humanoid under a stable avatar is safe. Doing it the other way
   * round - a new `PlayerAvatar` - would leave `MountManager` and `Player`
   * holding a corpse.
   */
  _rebuildBody() {
    const old = this.humanoid;
    const oldWeaponGeo = this._weaponGeo;
    const wasShadowOnly = this._shadowOnly;

    // Restore before the swap: the materials being dropped are cached and
    // shared, and a silenced one resurfacing on a later config would render an
    // invisible character with no way to explain it.
    this._setShadowOnly(false);

    this.humanoid = createCharacter(this.factory, this._char);
    this._root = this.humanoid.root;
    this._root.name = 'player.avatar';
    this._root.visible = this._visible;
    this._root.position.copy(this.player?.position ?? _upBody.set(0, 0, 0));
    this._root.rotation.y = this._bodyYaw;
    this.scene.add(this._root);

    this.animator = new NPCAnimator({ humanoid: this.humanoid, physics: this.physics, seed: 11 });
    this._weapon = this._buildWeapon();
    if (this._weapon) this._weapon.visible = !this._preview;

    this._materials.length = 0;
    this._depthWrite.length = 0;
    this._collectMaterials();
    this._setShadowOnly(wasShadowOnly);

    old.dispose();
    if (oldWeaponGeo && oldWeaponGeo !== this._weaponGeo) oldWeaponGeo.dispose();

    // Re-assert the states the old humanoid was carrying.
    this.setRidePose(this._ridePose);
    if (this._dead) {
      this._dead = false;
      this._enterDeath();
    }
    this._snap();
  }

  /**
   * Swap the hair shell. Geometry is cached in the factory's own cache under
   * the same key `HumanoidFactory.create` uses, so a style the player has
   * already worn is free to return to.
   *
   * This is the one place outside `HumanoidFactory.create` that takes a hold on
   * a cached geometry, so it has to move the hold too: acquire the new shell,
   * then hand back the old one through the humanoid's key list. Doing it in
   * that order means re-selecting the style you are already wearing cannot free
   * the shell on your head, and a style dropped here is disposed as soon as no
   * other character is wearing it rather than living until teardown.
   *
   * @param {string} style
   * @param {number} colorHex
   */
  _setHair(style, colorHex) {
    const h = this.humanoid;
    const A = this.factory.assets;
    const key = `hair|${style}|${h.P.key}`;
    // A style can legitimately have no geometry (bald); nothing is cached or
    // held in that case.
    const geo = A.acquireGeometry(key, () => buildHairGeometry(h.P, style, (h.seed % 9973) + 7));
    h.replaceHeldGeometry(h.hairKey ?? null, geo ? key : null);
    h.hairKey = geo ? key : null;
    if (!geo) {
      if (h.hairMesh) {
        h.hairMesh.removeFromParent();
        h.hairMesh = null;
      }
      return;
    }
    if (!h.hairMesh) {
      h.hairMesh = new THREE.Mesh(geo, A.hair(colorHex, PLAYER_RIM));
      h.hairMesh.castShadow = true;
      h.hairMesh.receiveShadow = true;
      h.headBone.add(h.hairMesh);
    } else {
      h.hairMesh.geometry = geo;
    }
  }

  /** Stature is a uniform scale on the root; no geometry depends on it. */
  _applyHeight(height) {
    const scale = height / BASE_HEIGHT;
    this.humanoid.height = height;
    this.humanoid.heightScale = scale;
    this._root.scale.setScalar(scale);
  }

  /**
   * Run `fn`, which may replace materials anywhere in the subtree, and put the
   * first-person silencing back afterwards. See `_setShadowOnly` for why the
   * state has to be lifted first.
   *
   * @param {() => void} fn
   */
  _editMaterials(fn) {
    const was = this._shadowOnly;
    this._setShadowOnly(false);
    fn();
    this._materials.length = 0;
    this._depthWrite.length = 0;
    this._collectMaterials();
    this._setShadowOnly(was);
  }

  /**
   * Compact carbine matching the VK-7 viewmodel's silhouette, parented to the
   * right hand so the animator's aim IK carries it. Hand-merged for the same
   * reason `HostileNPC` does it - six primitives is not worth an addon import.
   */
  _buildWeapon() {
    const assets = this.factory.assets;
    if (!assets) return null;

    const parts = [];
    const push = (geo, x, y, z, rx = 0) => {
      if (rx) geo.rotateX(rx);
      geo.translate(x, y, z);
      parts.push(geo);
    };
    push(new THREE.BoxGeometry(0.055, 0.082, 0.38), 0, 0, -0.07); // receiver
    push(new THREE.BoxGeometry(0.04, 0.056, 0.32), 0, -0.004, -0.38); // handguard
    push(new THREE.CylinderGeometry(0.013, 0.011, 0.3, 8), 0, 0.008, -0.62, Math.PI / 2); // barrel
    push(new THREE.CylinderGeometry(0.021, 0.018, 0.07, 8), 0, 0.008, -0.755, Math.PI / 2); // brake
    push(new THREE.BoxGeometry(0.046, 0.115, 0.115), 0, -0.082, -0.03); // magazine
    push(new THREE.BoxGeometry(0.05, 0.09, 0.22), 0, -0.014, 0.21); // stock
    push(new THREE.BoxGeometry(0.032, 0.06, 0.14), 0, 0.062, -0.06); // optic rail + sight
    push(new THREE.BoxGeometry(0.03, 0.075, 0.05), 0, -0.07, 0.05); // pistol grip

    let vTotal = 0;
    let iTotal = 0;
    for (const p of parts) {
      vTotal += p.getAttribute('position').count;
      iTotal += p.getIndex().count;
    }
    const pos = new Float32Array(vTotal * 3);
    const nrm = new Float32Array(vTotal * 3);
    const uv = new Float32Array(vTotal * 2);
    const idx = new Uint16Array(iTotal);
    let vo = 0;
    let io = 0;
    for (const p of parts) {
      const pp = p.getAttribute('position');
      pos.set(pp.array, vo * 3);
      nrm.set(p.getAttribute('normal').array, vo * 3);
      uv.set(p.getAttribute('uv').array, vo * 2);
      const pi = p.getIndex();
      for (let i = 0; i < pi.count; i++) idx[io + i] = pi.getX(i) + vo;
      vo += pp.count;
      io += pi.count;
      p.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this._weaponGeo = geo;

    const mesh = new THREE.Mesh(geo, assets.metal(0x33383f, 'panel', 0.38));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(HAND_POS[0], HAND_POS[1], HAND_POS[2]);
    mesh.rotation.set(HAND_ROT[0], HAND_ROT[1], HAND_ROT[2]);
    this.humanoid.weaponMount.add(mesh);
    return mesh;
  }

  /** Every material in the avatar subtree, so render state can be flipped as one. */
  _collectMaterials() {
    const seen = new Set();
    this._root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      const list = Array.isArray(m) ? m : [m];
      for (const mat of list) {
        if (!mat || seen.has(mat)) continue;
        seen.add(mat);
        this._materials.push(mat);
        this._depthWrite.push(mat.depthWrite);
      }
    });
  }

  /**
   * Silence the body in the beauty and AO passes while leaving the shadow pass
   * untouched. See the class comment for why this is the only combination that
   * both hides the mannequin and keeps the shadow.
   */
  _setShadowOnly(on) {
    if (on === this._shadowOnly) return;
    this._shadowOnly = on;
    for (let i = 0; i < this._materials.length; i++) {
      const m = this._materials[i];
      m.colorWrite = !on;
      m.depthWrite = on ? false : this._depthWrite[i];
      m.allowOverride = !on;
    }
  }

  /* ================================================================ */
  /* Frame update                                                      */
  /* ================================================================ */

  /**
   * @param {number} dt
   * @param {number} elapsed
   */
  update(dt, elapsed) {
    const p = this.player;
    if (!p || !this._visible) return;

    const rig = p.cameraRig;
    const third = rig ? rig.isThird : false;
    // A boom crushed against a wall puts the camera inside the body, so the
    // body drops to shadow-only there too - the same mechanism that hides it in
    // first person, reused rather than duplicated.
    const crushed = third && rig.boomLength < AVATAR_FADE_LENGTH;
    // The harness detaches the camera to frame the world, so the body is always
    // shown for a screenshot regardless of mode - otherwise every third-person
    // review shot would be of an invisible player. The character panel needs the
    // same exemption for the same reason: it is a preview of the body.
    this._setShadowOnly(
      this.harnessShadowOnly || ((!third || crushed) && !p._harnessFrozen && !this._preview)
    );

    if (this.followPlayer) {
      this._root.position.copy(p.position);
      this._driveYaw(dt, elapsed);
    }

    if (p.isDead) {
      this._enterDeath();
    } else if (this._dead) {
      this._revive();
    }

    if (!this._dead) this._driveLocomotion(dt, elapsed, third, rig);

    this.animator.update(dt, elapsed, {
      // Foot IK grounds the feet to whatever is under them. In the air that is
      // the floor several metres below, and the animator would drag the pelvis
      // all the way down to it, so IK is off while airborne - and always while
      // riding, because a rider's feet belong to the mount, not the terrain.
      ik: this._airWeight < 0.3 && !p.movementOverride,
      detail: third || this._preview,
    });
    this.humanoid.setDetailVisible(third || this._preview);

    if (!this._dead && !p.movementOverride && this._airWeight > 0.002) this._applyAirPose();
  }

  /**
   * Body facing.
   *
   * Aiming locks the torso to the camera - that is what makes a third-person
   * shooter's crosshair believable. Free movement instead turns the body into
   * the direction of travel, because the animator has one forward-facing gait
   * and no strafe set: a body locked forward while walking sideways slides its
   * feet, which reads worse than a character who simply turns.
   */
  _driveYaw(dt, elapsed) {
    const p = this.player;
    // Preview: a slow turntable, so the panel shows front, profile and back
    // without the player having to fly the camera around their own body.
    if (this._preview) {
      this._bodyYaw = wrapPi(this._bodyYaw + PREVIEW_SPIN * dt);
      // Zero, not the real rate: a turn-in-place shuffle under a turntable
      // reads as the character fidgeting rather than as a display stand.
      this._turnRate = 0;
      this._root.rotation.y = this._bodyYaw;
      return;
    }
    const vx = p.velocity.x;
    const vz = p.velocity.z;
    const speed = Math.hypot(vx, vz);
    const moving = speed > 0.6 && p.grounded;
    const aiming = p.isAiming || elapsed - p.lastFiredAt < 1.1;

    let want;
    let rate;
    if (aiming) {
      want = p.yaw;
      rate = TURN_AIM;
    } else if (moving) {
      want = Math.atan2(-vx, -vz);
      rate = TURN_MOVE;
    } else {
      want = p.yaw;
      rate = TURN_IDLE;
    }

    let delta = wrapPi(want - this._bodyYaw);
    // Standing still, small camera turns are a glance, not a turn-in-place.
    if (!aiming && !moving && Math.abs(delta) < TURN_DEADZONE) delta = 0;

    const maxTurn = rate * dt;
    const applied = clamp(delta, -maxTurn, maxTurn);
    this._bodyYaw = wrapPi(this._bodyYaw + applied);
    this._turnRate = applied / Math.max(dt, 1e-4);
    this._root.rotation.y = this._bodyYaw;
  }

  _driveLocomotion(dt, elapsed, third, rig) {
    const p = this.player;
    const a = this.animator;
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    // A rider is neither grounded nor falling as far as the body is concerned:
    // the mount holds them up. Treating the hoverboard's permanent hover as
    // free-fall spread the arms into a starfish, which is what this guards.
    const ridden = p.movementOverride;
    const grounded = (p.grounded || ridden || !this._hasAirGap()) && !this._dead;

    this._airWeight = approach(this._airWeight, grounded ? 0 : 1, grounded ? 14 : 7, dt);
    this._landAbsorb = approach(this._landAbsorb, 0, 7, dt);

    // Feet must not cycle in mid-air, and a rider's feet are planted on a board.
    a.setLocomotion(
      ridden || this._preview ? 0 : grounded ? speed : speed * (1 - this._airWeight),
      this._turnRate
    );
    const rideCrouch = ridden ? (this._ridePose === 'saddle' ? 2.4 : 0.85) : 0;
    a.crouchTarget = Math.max(p.crouchAmount * CROUCH_DEPTH, rideCrouch) + this._landAbsorb;

    // Aim layer: the arms hold the carbine on the crosshair whenever the weapon
    // is up. Sprinting and free-fall drop it so the arms swing again.
    const lowered = (p.isSprinting && !ridden) || this._airWeight > 0.72 || this._preview;
    const target = rig?.aimPoint ?? null;
    a.setAimTarget(lowered ? null : target);
    // A head tracking the crosshair while the body is on a turntable reads as a
    // stiff neck; the preview wants a neutral, forward-looking head.
    a.setLookTarget(this._preview ? null : target);
    void third;
    void elapsed;
  }

  /**
   * Is there real open air under the feet?
   *
   * The corroborating half of the airborne test - see `AIR_CLEARANCE`. Starts
   * the ray slightly above the feet so a capsule seated a millimetre inside the
   * floor still finds it.
   *
   * @returns {boolean} true when the floor is further away than a step
   */
  _hasAirGap() {
    const phys = this.physics;
    if (!phys) return true;
    const p = this.player.position;
    _clrOrigin.set(p.x, p.y + 0.12, p.z);
    const hit = phys.raycast(_clrOrigin, _clrDown, AIR_PROBE, COLLISION_LAYER.WORLD);
    if (!hit) return true;
    return hit.distance - 0.12 > AIR_CLEARANCE;
  }

  /**
   * Additive airborne pose.
   *
   * Layered on top of the animator's own output rather than fed into it, because
   * `NPCAnimator` has no jump - NPCs never leave the ground. Thigh +X swings the
   * knee forward, calf -X folds the shin back, so the pair reads as a tuck on
   * the way up and a reach on the way down.
   */
  _applyAirPose() {
    const w = this._airWeight;
    const vy = this.player.velocity.y;
    // +1 at the top of a jump, -1 in a fall.
    const rise = clamp(vy / 6, -1, 1);
    const tuck = (0.42 + 0.5 * Math.max(0, rise) - 0.28 * Math.max(0, -rise)) * w;

    const B = this.humanoid.bones;
    const add = (name, x, z = 0) => {
      const bone = B.get(name);
      if (!bone) return;
      _airEuler.set(x, 0, z);
      _airQuat.setFromEuler(_airEuler);
      bone.quaternion.multiply(_airQuat);
    };

    // Asymmetric: a split stance reads as a person, a symmetric one as a doll.
    add('thighR', tuck * 1.05, 0.06 * w);
    add('thighL', tuck * 0.6, -0.06 * w);
    add('calfR', -tuck * 1.25);
    add('calfL', -tuck * 0.7);
    add('footR', tuck * 0.5);
    add('footL', tuck * 0.35);
    // Arms only counter-balance when they are not holding an aim pose.
    const free = 1 - this.animator.aimWeight;
    if (free > 0.01) {
      add('upperArmR', -0.35 * w * free, 0.3 * w * free);
      add('upperArmL', -0.35 * w * free, -0.3 * w * free);
    }
  }

  /* ================================================================ */
  /* Death / respawn                                                   */
  /* ================================================================ */

  _enterDeath() {
    if (this._dead) return;
    this._dead = true;
    const p = this.player;
    _dthDir.set(-Math.sin(p.yaw), 0, -Math.cos(p.yaw));
    this.animator.setAimTarget(null);
    this.animator.setLookTarget(null);
    this.animator.die(_dthDir, false);
  }

  _revive() {
    if (!this._dead && !this.animator.dead) return;
    this._dead = false;
    this.animator.revive();
    this._airWeight = 0;
    this._landAbsorb = 0;
    this._snap();
  }

  /** Park the body on the player without a frame of interpolation. */
  _snap() {
    const p = this.player;
    if (!p) return;
    this._root.position.copy(p.position);
    this._bodyYaw = p.yaw;
    this._turnRate = 0;
    this._root.rotation.y = this._bodyYaw;
    this._root.updateMatrixWorld(true);
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    if (this.player?.avatar === this) this.player.avatar = null;
    this._weapon?.removeFromParent();
    this._weaponGeo?.dispose();
    this.humanoid.dispose();
    // The factory is private to the avatar, so its CharacterAssets go with it.
    this.factory.dispose();
  }
}
