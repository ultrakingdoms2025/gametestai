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
const _stowPoint = new THREE.Vector3();
/* Handed to the animator, which keeps the reference and copies it each frame -
 * so this is rewritten before every `animator.update` and never read after. */
const _aimHold = new THREE.Vector3();

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
/**
 * Where an idle turn-in-place lets go again.
 *
 * The dead zone used to be a plain gate - inside it the body was frozen,
 * outside it turned at the full rate - so a single slow look swept the body
 * through start, stop, start, stop. Measured over a twelve-step camera sweep:
 * the turn rate handed to the animator was a square wave, and the animator
 * drives its shuffle-step cadence off exactly that number. Breaking at
 * `TURN_DEADZONE` and not letting go until `TURN_SETTLE` makes one turn out of
 * what was a stutter, which is the same latch a real neck-then-body turn has.
 */
const TURN_SETTLE = 0.06;
/** Hysteresis on "moving", so the yaw target does not chatter at the boundary. */
const MOVE_ENTER = 0.8;
const MOVE_LEAVE = 0.42;
/** Ceiling on the eased idle/aim turn, radians/second. Nothing may teleport. */
const TURN_CEILING = 14;

/**
 * Locomotion lean.
 *
 * `NPCAnimator` has one upright gait and no lean layer, because an NPC walks
 * at one speed on flat ground and never corners hard. A player sprints,
 * stops dead and carves round a corner at 8 m/s, and a torso that stays
 * vertical through all of it is the single loudest thing that reads as
 * mechanical. Additive on the spine, exactly like `_applyAirPose`, so it
 * costs no material, no program and no draw call.
 */
/** Forward fold at full sprint, radians, summed over the three spine joints. */
const LEAN_SPRINT = 0.145;
/** Extra fold per m/s2 of forward acceleration, and its ceiling. */
const LEAN_ACCEL = 0.016;
const LEAN_ACCEL_MAX = 0.11;
/** Bank into a turn, radians per rad/s of body rotation, and its ceiling. */
const LEAN_BANK = 0.052;
const LEAN_BANK_MAX = 0.12;
/** Forward fold contributed by a landing absorb, radians per absorb unit. */
const LEAN_LAND = 0.13;

/**
 * STOWING THE CARBINE FOR A SPRINT, and the singularity it stepped around.
 *
 * A sprint used to take the weapon away from the aim solver, which crossfaded
 * the whole arm from a raised carbine to a running swing. Those two poses are
 * very nearly ANTIPODAL at the elbow once the run cycle is at sprint amplitude
 * - and a slerp between two rotations 180 degrees apart is genuinely ambiguous.
 * Which of the two great circles it takes is decided by the sign of a dot
 * product, so as the blend weight moved that sign flipped and the forearm
 * jumped through the whole arc in one frame. Measured: 122 to 173 degrees, at
 * a blend weight of about 0.37-0.56, in BOTH directions.
 *
 * The crossfade itself has since been made safe for the NPCs, whose weight
 * genuinely has to travel 0 to 1: `NPCAnimator._poseAimArms` now ROUTES the
 * blend (see AIM_RAISE_START there - the layer arms itself against an anchor
 * that IS the FK swing, then sweeps the hand targets onto the weapon on their
 * own clock), pinned by npc-aim-singularity.test.mjs. At weight 1 the routed
 * solve is bit-identical to the old one, so nothing here changed behaviour -
 * the stow below and the respawn park included.
 *
 * The stow stays, because it is not a workaround, it is the better animation:
 * a sprinting player does not let go of their weapon, they drop the muzzle.
 * Keeping the aim layer at full weight and moving its TARGET down to a point
 * on the ground ahead sweeps the whole arm down as one piece - no crossfade,
 * and the gun visibly goes with it because the prop is parented to the hand.
 *
 * Free-fall and the character preview still release the weapon outright: there
 * the arms are wanted free (the air pose counter-balances with them, and the
 * preview wants a neutral stance), and both now ride the routed crossfade.
 */
/** Metres ahead of the feet the stowed muzzle points. */
const STOW_AHEAD = 2.0;
/** And how high, so the line comes out about 33 degrees below the shoulder. */
const STOW_HEIGHT = 0.15;
/** How fast the muzzle drops and comes back up, nepers/second. */
const STOW_RATE = 7;

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
    /** Latched while an idle turn-in-place is running. @see TURN_SETTLE */
    this._turnLatch = false;
    /** Hysteretic "is walking", so the yaw target does not chatter. */
    this._moving = false;
    /**
     * Damped rise/fall term for the air pose.
     *
     * `velocity.y` is a step function at touchdown - it goes from -6 to 0 in a
     * single frame while `_airWeight` still has two thirds of its authority - so
     * reading it raw swung the thighs 13 degrees in that one frame, every
     * landing. The pose wants the SHAPE of the arc, not the instantaneous
     * number, and a shape can be damped.
     */
    this._airRise = 0;
    /** Muzzle-down blend while sprinting, 0 up to 1 stowed. @see STOW_AHEAD */
    this._stow = 0;
    /** Set by `_clearPoseLayers`: park the aim layer rather than ramp into it. */
    this._aimSnap = true;
    /** Damped locomotion-lean terms. @see _applyMoveLean */
    this._leanPitch = 0;
    this._leanRoll = 0;
    this._prevSpeed = 0;
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
      this._clearPoseLayers();
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
      /* Foot IK grounds the feet to whatever is under them. In the air that is
       * the floor several metres below, and the animator would drag the pelvis
       * all the way down to it, so IK is off while airborne - and always while
       * riding, because a rider's feet belong to the mount, not the terrain.
       *
       * ...and during a roll, which is the only full-body pose in the codebase
       * that is GROUNDED and raises no `movementOverride`, so it satisfies
       * neither of the other two terms. `Parkour.applyPose` slerps every leg
       * bone to an absolute tuck at weight ~1, so the whole two-bone solve is
       * computed and thrown away - but `_poseLegs` also writes
       * `pelvis.position.y`, and a POSITION is not overwritten by a pose that
       * only writes quaternions. The pelvis would be dropped to reach ground
       * the body is mid-somersault above, worst exactly on the stepped rooftops
       * the landing roll is authored for. */
      ik: this._airWeight < 0.3 && !p.movementOverride && !p.parkour?.rolling,
      detail: third || this._preview,
    });
    this.humanoid.setDetailVisible(third || this._preview);

    if (!this._dead && !p.movementOverride) {
      if (this._airWeight > 0.002) this._applyAirPose();
      this._applyMoveLean();
    }
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
    /* Hysteresis, not a threshold. The yaw TARGET is a different quantity on
     * either side of this test - the direction of travel one side, the camera
     * the other - so a speed hovering on the boundary swapped between two
     * unrelated angles frame to frame. Coasting to a stop sits on it for about
     * a third of a second. */
    if (this._moving) {
      if (speed < MOVE_LEAVE || !p.grounded) this._moving = false;
    } else if (speed > MOVE_ENTER && p.grounded) {
      this._moving = true;
    }
    const moving = this._moving;
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
    /* Standing still, small camera turns are a glance, not a turn-in-place -
     * but the release has to be a different number from the break, or the body
     * stops the instant it is back inside the zone and the next degree of look
     * starts it again. @see TURN_SETTLE */
    if (!aiming && !moving) {
      const mag = Math.abs(delta);
      if (mag > TURN_DEADZONE) this._turnLatch = true;
      else if (mag < TURN_SETTLE) this._turnLatch = false;
      if (!this._turnLatch) delta = 0;
    } else {
      this._turnLatch = false;
    }

    /* Exponential approach under a hard ceiling, rather than a pure rate limit.
     * A rate limit turns at one constant speed and then stops dead on the frame
     * it arrives; the approach eases out of the last few degrees, which is what
     * the end of a real turn looks like. The ceiling is what stops a 180-degree
     * delta - the one you get by releasing W while running backwards - from
     * being taken in a single frame. */
    const eased = delta * (1 - Math.exp(-rate * dt));
    const maxTurn = TURN_CEILING * dt;
    const applied = clamp(eased, -maxTurn, maxTurn);
    this._bodyYaw = wrapPi(this._bodyYaw + applied);
    /* Damped, because this is what the animator's turn-shuffle cadence is
     * driven from: an undamped value is a square wave the moment the latch
     * above opens or closes, and a shuffle that starts at full amplitude on one
     * frame is the stutter this whole latch exists to remove. */
    const raw = applied / Math.max(dt, 1e-4);
    this._turnRate = approach(this._turnRate, raw, 10, dt);
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

    /* Aim layer, in two halves that used to be one.
     *
     * `stow` keeps hold of the weapon and drops the muzzle - a sprint.
     * `release` lets go of it entirely - free-fall, and the character preview.
     * @see STOW_AHEAD for why a sprint may not do the second one. */
    const stowing = (p.isSprinting || this._airWeight > 0.72) && !ridden && !this._preview;
    const release = this._preview;
    const target = rig?.aimPoint ?? null;
    this._stow = approach(this._stow, stowing && !release ? 1 : 0, STOW_RATE, dt);

    let aimAt = target;
    if (target && this._stow > 0.002) {
      // A point on the ground ahead of the body's own facing, not the camera's:
      // a sprinter's muzzle follows where they are running.
      _stowPoint.set(
        p.position.x - Math.sin(this._bodyYaw) * STOW_AHEAD,
        p.position.y + STOW_HEIGHT,
        p.position.z - Math.cos(this._bodyYaw) * STOW_AHEAD
      );
      aimAt = _aimHold.copy(target).lerp(_stowPoint, this._stow);
    }
    /* Never take the target away.
     *
     * `NPCAnimator._poseAimArms` is gated on `aimWeight > 0.001 && aimTarget`,
     * so `setAimTarget(null)` does not fade the aim pose out - it stops solving
     * it, and the arms leave a raised carbine for the run cycle between two
     * consecutive frames. Measured in a real browser with a per-frame
     * quaternion probe: `upperArmR` moved 150.8 degrees in one 16.7 ms frame on
     * a sprint start, and 161.3 at the top of a jump, against a p50 of 0.7.
     *
     * So the target stays, and only the WANT is lowered - which now happens
     * for the preview alone, because the two cases that used to do it are
     * stowed instead. Where the want does fall, the solver keeps running
     * against a LIVE target while `aimWeight` rings out over its own ramp, so
     * the poses blend and the arms follow the camera down rather than freezing
     * where it was last pointing. */
    a.setAimTarget(aimAt);
    a.setAiming(!!aimAt && !release);
    /* A body that has just been teleported, respawned or spawned should
     * ALREADY be holding its weapon, not spend half a second swinging up into
     * the hold. (Before NPCAnimator's routed crossfade, this ramp also crossed
     * the antipodal band described above - a 52-degree forearm flip at every
     * respawn.) Parked, not ramped - and a direct aimWeight write parks the
     * raise fraction with it; NPCAnimator's setter guarantees that.
     * @see STOW_AHEAD */
    if (this._aimSnap) {
      this._aimSnap = false;
      a.aimWeight = aimAt && !release ? 1 : 0;
    }
    // A head tracking the crosshair while the body is on a turntable reads as a
    // stiff neck; the preview wants a neutral, forward-looking head. And the
    // head follows the CROSSHAIR, never the stow point - a sprinter looks where
    // they are going, not at their own muzzle.
    a.setLookTarget(this._preview ? null : target);

    /* ---- signals the additive layers read, damped here where dt is ---- */
    // @see _applyAirPose
    this._airRise = approach(this._airRise, clamp(p.velocity.y / 6, -1, 1), 11, dt);

    /* Lean. Sprinting folds the chest forward, accelerating folds it further,
     * and turning banks it into the corner - all of it damped, and all of it
     * off while a mount owns the body, because a rider's torso belongs to the
     * saddle pose. @see _applyMoveLean */
    const accel = (speed - this._prevSpeed) / Math.max(dt, 1e-4);
    this._prevSpeed = speed;
    const still = ridden || this._preview || !grounded;
    const drive = still ? 0 : Math.min(1, speed / 7.5);
    const pitchWant = still
      ? 0
      : drive * drive * LEAN_SPRINT
        + clamp(accel * LEAN_ACCEL, -LEAN_ACCEL_MAX, LEAN_ACCEL_MAX)
        + this._landAbsorb * LEAN_LAND;
    const rollWant = still
      ? 0
      : clamp(this._turnRate * LEAN_BANK * drive, -LEAN_BANK_MAX, LEAN_BANK_MAX);
    this._leanPitch = approach(this._leanPitch, pitchWant, 6, dt);
    this._leanRoll = approach(this._leanRoll, rollWant, 5, dt);

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
    /* +1 at the top of a jump, -1 in a fall - damped in `_driveLocomotion`,
     * because the raw term is a step function at touchdown. @see _airRise */
    const rise = this._airRise;
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

  /**
   * Additive locomotion lean.
   *
   * Three things a run cycle alone cannot say: that the character is *going*
   * somewhere (a forward fold that grows with speed), that it just *started*
   * or *stopped* (an acceleration term, which is what makes a stop read as
   * braking rather than as the animation being switched off), and that it is
   * *turning* (a bank into the corner). Landing borrows the same fold, so an
   * impact folds the chest as well as dropping the pelvis.
   *
   * Split unevenly up the spine and paid back at the neck, which is the whole
   * trick: without the pay-back a leaning character stares at the ground, and
   * a player who cannot see their own character's head direction has lost the
   * one cue that says where the body is about to go.
   *
   * Additive on top of the animator's output, the same mechanism and the same
   * ordering as `_applyAirPose` - so `Parkour` and `Swim`, which run later and
   * slerp to absolute poses, still win outright over it.
   */
  _applyMoveLean() {
    const pitch = this._leanPitch;
    const roll = this._leanRoll;
    if (Math.abs(pitch) < 0.0015 && Math.abs(roll) < 0.0015) return;
    /* The aim layer owns the chest while the weapon is up - it is what puts
     * the sights on the crosshair - so the lean stands down in proportion to
     * it rather than fighting it for the same three bones. */
    const free = 1 - this.animator.aimWeight * 0.8;
    const p = pitch * free;
    const r = roll * free;

    const B = this.humanoid.bones;
    const add = (name, x, z) => {
      const bone = B.get(name);
      if (!bone) return;
      _airEuler.set(x, 0, z);
      _airQuat.setFromEuler(_airEuler);
      bone.quaternion.multiply(_airQuat);
    };

    // Hips least, chest most: a fold that starts at the pelvis reads as a bow.
    add('spine01', p * 0.22, r * 0.30);
    add('spine02', p * 0.38, r * 0.36);
    add('spine03', p * 0.40, r * 0.34);
    // Head up out of the fold, and the neck takes the last of the bank.
    add('neck', -p * 0.42, r * 0.22);
    add('head', -p * 0.34, r * 0.18);
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
    this._clearPoseLayers();
    this._snap();
  }

  /**
   * Zero every damped additive term.
   *
   * Called wherever the body is teleported rather than moved - a respawn, a
   * preview, a world crossing. These terms are all rate-damped, so a lean or a
   * fall-tuck carried across a discontinuity would take a third of a second to
   * unwind on a body that has no business leaning at all.
   */
  _clearPoseLayers() {
    this._airRise = 0;
    this._stow = 0;
    this._aimSnap = true;
    this._leanPitch = 0;
    this._leanRoll = 0;
    this._prevSpeed = 0;
    this._turnLatch = false;
    this._moving = false;
  }

  /** Park the body on the player without a frame of interpolation. */
  _snap() {
    const p = this.player;
    if (!p) return;
    this._root.position.copy(p.position);
    this._bodyYaw = p.yaw;
    this._turnRate = 0;
    this._clearPoseLayers();
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
