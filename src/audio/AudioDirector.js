import { AudioEngine } from './AudioEngine.js';
import { Sfx } from './Sfx.js';
import { Music } from './Music.js';

/**
 * The only thing in the game that knows both what happened and what it sounds
 * like.
 *
 * Nothing else in the codebase imports the audio layer. Weapons, mounts and
 * the player already announce everything they do on the bus - `weapon:fired`,
 * `player:footstep`, `mount:mounted`, `projectile:hit` - so the sound design
 * can hang entirely off events that already existed. That keeps audio a leaf:
 * it can be deleted, muted or rewritten without touching a single system that
 * makes a noise.
 *
 * ── Autoplay ──────────────────────────────────────────────────────────────
 * The context cannot exist before a gesture, and the boot sequence has exactly
 * one: the click on the title card, which raises `game:started`. Everything
 * before that point is silently dropped, and a pointer-lock change is treated
 * as a second chance in case the first was missed.
 *
 * ── Mount voices ──────────────────────────────────────────────────────────
 * Weapons fire and forget; a mount is a held voice that has to track speed for
 * as long as the player is riding. So mounts get a handle from `Sfx` that is
 * updated every frame from the mount's own state and explicitly stopped on
 * dismount - the one place here that is not purely event-driven.
 */

/** Footstep material names from Player -> the palette in Sfx. */
const SURFACE_ALIASES = {
  default: 'concrete',
  deck: 'metal',
  hull: 'metal',
  grate: 'metal',
  plate: 'metal',
  cobble: 'stone',
  flagstone: 'stone',
  ashlar: 'stone',
  thatch: 'soft',
  plank: 'wood',
  beam: 'wood',
  grass: 'grass',
  terrain: 'dirt',
  earth: 'dirt',
  piste: 'snow',
  asphalt: 'concrete',
  rubber: 'soft',
};

function surfaceOf(raw) {
  if (!raw) return 'concrete';
  const s = String(raw).toLowerCase();
  if (SURFACE_ALIASES[s]) return SURFACE_ALIASES[s];
  for (const key of ['metal', 'stone', 'concrete', 'wood', 'glass', 'dirt', 'snow', 'water', 'grass', 'flesh']) {
    if (s.includes(key)) return key;
  }
  return 'concrete';
}

export class AudioDirector {
  /**
   * @param {{bus:any, camera:any, player:any, worldManager:any, input:any}} ctx
   */
  constructor({ bus, camera, player, worldManager, input } = {}) {
    this.bus = bus ?? null;
    this.camera = camera ?? null;
    this.player = player ?? null;
    this.worldManager = worldManager ?? null;
    this.input = input ?? null;

    this.engine = new AudioEngine();
    this.sfx = new Sfx(this.engine);
    this.music = new Music(this.engine);

    /** @type {{handle:any, id:string}|null} */
    this._mount = null;
    this._swimTimer = null;
    this._pendingWorld = null;

    /** Scratch for the listener frame - this runs every frame. */
    this._pos = { x: 0, y: 0, z: 0 };
    this._right = { x: 1, y: 0, z: 0 };
    this._fwd = { x: 0, y: 0, z: -1 };

    /** @type {Array<() => void>} */
    this._offs = [];
    this._bind();
  }

  get settings() {
    return this.engine.settings;
  }

  /* ------------------------------------------------------------------ */
  /* Wiring                                                              */
  /* ------------------------------------------------------------------ */

  _bind() {
    const bus = this.bus;
    if (!bus) return;
    const on = (type, fn) => this._offs.push(bus.on(type, fn));

    /* --- unlock ---------------------------------------------------- */
    on('game:started', () => this._unlock());
    on('input:lockchange', ({ locked }) => { if (locked) this._unlock(); });

    /* --- world / music --------------------------------------------- */
    on('world:changed', ({ id }) => {
      this._pendingWorld = id;
      if (this.engine.ready) this.music.setWorld(id);
      this.sfx.portal(null);
    });

    /* --- weapons ---------------------------------------------------- */
    on('weapon:fired', (e) => {
      const at = e?.muzzle ?? e?.origin ?? null;
      const id = e?.id ?? e?.weapon ?? null;
      // Sword and bow raise `weapon:fired` too, so the shot recipe is chosen
      // by what fired rather than assuming a rifle.
      if (id === 'sword') this.sfx.swordSwing(at);
      else if (id === 'bow') this.sfx.bowRelease(at);
      else if (id === 'fireball') this.sfx.fireballCast(at);
      else this.sfx.gunshot(at);
    });
    on('weapon:swing', (e) => this.sfx.swordSwing(e?.position ?? e?.origin ?? null));
    on('weapon:charging', (e) => {
      if (e?.id === 'bow') this.sfx.bowDraw(e?.position ?? null);
      else this.sfx.fireballCharge(e?.position ?? null);
    });
    on('weapon:dry', () => this.sfx.dryFire(null));
    on('weapon:noammo', () => this.sfx.dryFire(null));
    on('weapon:reload-start', () => this.sfx.reload(null));
    on('weapon:switched', () => this.sfx.ui('click'));
    on('weapon:hit', (e) => {
      const at = e?.point ?? null;
      if (e?.isNPC) this.sfx.impact(at, 'flesh');
      else this.sfx.impact(at, surfaceOf(e?.surface ?? e?.material));
    });
    on('projectile:hit', (e) => {
      if (e?.kind === 'fireball') this.sfx.explosion(e?.point ?? null, { size: 1 });
      else this.sfx.impact(e?.point ?? null, surfaceOf(e?.surface));
    });

    /* --- player ------------------------------------------------------ */
    on('player:footstep', (e) => {
      this.sfx.footstep(e?.position ?? null, surfaceOf(e?.material), { running: !!e?.sprinting });
    });
    on('player:landed', (e) => {
      this.sfx.footstep(e?.position ?? null, surfaceOf(e?.material), { running: true });
    });
    on('player:damaged', () => this.sfx.playerHurt());
    /* Swimming is a state, not an event: splash on the way in, then strokes
     * on a timer for as long as the state holds. (Swim.js emits `swimming`;
     * `entered` is kept for any older emitter still using it.) */
    on('player:swim', (e) => {
      if (e?.swimming || e?.entered) {
        if (!this._swimTimer) this.sfx.splash(e?.position ?? null, { big: true });
        this._startSwim();
      } else {
        this._stopSwim();
      }
    });
    on('player:climb', (e) => {
      // FreeClimb reports per-move states; ledge Climb reports the mantle.
      if (e?.state === 'grab' || e?.state === 'kick' || e?.climbing === true) {
        this.sfx.climbScrape(e?.position ?? null);
      }
    });
    on('player:crouch', () => this.sfx.crouchRustle(null));
    on('player:died', () => {
      this._stopMount();
      this._stopSwim();
      this.sfx.explosion(null, { size: 0.6 });
    });

    /* --- world objects ----------------------------------------------- */
    on('loot:collected', (e) => {
      this.sfx.pickup(null, { rare: !!e?.fromCache });
    });
    on('portal:entering', () => this.sfx.portal(null));
    on('npc:killed', (e) => this.sfx.impact(e?.npc?.position ?? null, 'flesh'));

    /* --- mounts ------------------------------------------------------ */
    on('mount:summoned', (e) => {
      this.sfx.mountSummon(e?.position ?? null, { up: true });
      // A summoned animal answers. The board and the car do not.
      if (e?.id === 'horse') this.sfx.whinny(e?.position ?? null);
      else if (e?.id === 'eagle') this.sfx.eagleScreech(e?.position ?? null);
    });
    on('mount:mounted', (e) => this._startMount(e?.id, e?.mount ?? null));
    on('mount:dismounted', () => this._stopMount());
    on('mount:boost', (e) => {
      if (this._mount?.id === 'dragon') this.sfx.dragonRoar(e?.position ?? null);
      else if (this._mount?.id === 'eagle' && e?.active) this.sfx.eagleScreech(e?.position ?? null);
    });
    /* Per-footfall and per-wingbeat, emitted by the mounts from the same phase
     * that placed the limb. Rate limiting lives in `Sfx`; a gallop legitimately
     * fires four of these a second and must not be thinned, or the gait stops
     * being audible as a gait. */
    on('mount:footfall', (e) => this.sfx.hoof(e?.position ?? null, { hard: e?.hard ?? 0.5 }));
    on('mount:wingbeat', (e) => this.sfx.wingBeat(e?.position ?? null, { power: e?.power ?? 1 }));
    on('mount:jump', (e) => {
      if (e?.id === 'horse') this.sfx.whinny(this.player?.position ?? null);
    });

    /* --- UI ---------------------------------------------------------- */
    for (const t of ['inventory:open', 'market:open', 'character:open']) on(t, () => this.sfx.ui('open'));
    for (const t of ['inventory:close', 'market:close', 'character:close']) on(t, () => this.sfx.ui('close'));
    on('market:trade', () => this.sfx.pickup(null, { rare: false }));
    on('cheat:used', () => this.sfx.pickup(null, { rare: true }));
    /* Track drops. Unpositioned, like the other reward cues: the car is moving
     * at 30 m/s and a panned 3D blip from a point it has already passed reads
     * as coming from behind, which is the opposite of the "you got it" the cue
     * exists to give. Two at once earn the brighter variant. */
    on('race:pickup', (e) => this.sfx.pickup(null, { rare: (e?.count ?? 1) > 1 }));
    /* Start procedure. One tone per column and a higher, longer one at the off,
     * which is the pattern the real thing uses - and the reason it works is
     * that the pitch does not change as the columns build, so the ear cannot
     * predict the release any better than the eye can. */
    on('race:lights', (e) => {
      if (e?.go) this.sfx.ui('open');
      else if ((e?.lit ?? 0) > 0) this.sfx.ui('click');
    });
    /* Car-to-car contact. Positioned, unlike the pickup cue: a shunt has a
     * direction and hearing which side it came from is information. Metal, and
     * scaled by severity so a rub and a shunt are not the same noise. */
    on('race:contact', (e) => {
      const at = e && Number.isFinite(e.x) ? { x: e.x, y: e.y, z: e.z } : null;
      this.sfx.impact(at, 'metal');
      if ((e?.severity ?? 0) > 0.45) this.sfx.explosion(at, { size: 0.35 });
    });
  }

  _unlock() {
    const wasReady = this.engine.ready;
    if (!this.engine.unlock()) return;
    if (!wasReady) {
      // The world arrived before the context existed, which is the normal case:
      // boot activates a world long before the player clicks the title card.
      const id = this._pendingWorld ?? this.worldManager?.active?.id ?? null;
      if (id) this.music.setWorld(id);
      this.bus?.emit('audio:ready', { settings: this.engine.settings });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Mount voices                                                        */
  /* ------------------------------------------------------------------ */

  _startMount(id, mount = null) {
    this._stopMount();
    if (!id) return;
    /* Explicit, not a fallback chain ending in 'hoverboard'.
     *
     * The old form mapped anything it did not recognise onto the anti-grav hum,
     * so the horse and the eagle both rode around humming like a hoverboard.
     * A mount with no voice of its own should be silent, which is at least
     * honest, rather than borrowing another animal's. */
    const VOICE = { car: 'car', dragon: 'dragon', horse: 'horse', eagle: 'eagle', hoverboard: 'hoverboard', bicycle: 'bicycle' };
    const kind = VOICE[id] ?? null;
    if (!kind) return;
    const handle = this.sfx.startMount(kind);
    if (handle) this._mount = { handle, id, mount };
    if (id === 'dragon') this.sfx.dragonRoar(this.player?.position ?? null);
  }

  _stopMount() {
    if (!this._mount) return;
    try { this._mount.handle.stop(); } catch { /* already stopped */ }
    this._mount = null;
  }

  /* ------------------------------------------------------------------ */
  /* Swim strokes                                                        */
  /* ------------------------------------------------------------------ */

  /** Strokes repeat while swimming; ~780 ms is a relaxed crawl cadence. */
  _startSwim() {
    if (this._swimTimer) return;
    this._swimTimer = setInterval(() => {
      this.sfx.swimStroke(this.player?.position ?? null);
    }, 780);
  }

  _stopSwim() {
    if (!this._swimTimer) return;
    clearInterval(this._swimTimer);
    this._swimTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* Frame                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Keep the listener and any held mount voice current.
   * @param {number} dt
   */
  update(dt) {
    const eng = this.engine;
    if (!eng.ready) return;

    const cam = this.camera;
    if (cam) {
      const m = cam.matrixWorld.elements;
      // Basis vectors straight out of the world matrix - cheaper and
      // allocation-free compared with getWorldDirection + a cross product.
      this._pos.x = m[12]; this._pos.y = m[13]; this._pos.z = m[14];
      this._right.x = m[0]; this._right.y = m[1]; this._right.z = m[2];
      this._fwd.x = -m[8]; this._fwd.y = -m[9]; this._fwd.z = -m[10];
      eng.setListener(this._pos, this._right, this._fwd);
    }

    if (this._mount) {
      const p = this.player;
      const vel = p?.velocity;
      /* Prefer the mount's own speed over the rider's ground velocity.
       *
       * They are the same number for a horse and very much not for a bird: an
       * eagle's wind noise is airspeed, which includes the vertical, so a stoop
       * straight down measured on the horizontal reads as silence at exactly
       * the moment it should be loudest.
       *
       * `voiceSpeed`, where a mount offers it, is that same speed saturated at
       * whatever ceiling the mount's VISUALS saturate at. A purchased Power
       * tier lifts the real speed past that ceiling, and a held voice driven
       * off the raw number then runs its wingbeat faster than the wings - see
       * Dragon.voiceSpeed for the measured drift. */
      const m = this._mount.mount;
      const speed = typeof m?.voiceSpeed === 'number'
        ? m.voiceSpeed
        : typeof m?.speed === 'number'
          ? Math.abs(m.speed)
          : (vel ? Math.hypot(vel.x, vel.z) : 0);
      this._mount.handle.set({
        speed,
        throttle: Math.min(1, speed / 18),
        boost: p?.isBoosting ? 1 : 0,
      });
    }
    void dt;
  }

  /* ------------------------------------------------------------------ */
  /* Settings surface, used by the options UI                            */
  /* ------------------------------------------------------------------ */

  toggleSfx(on) {
    const v = this.engine.toggleSfx(on);
    // Confirm audibly when turning *on*; there is nothing to hear otherwise.
    if (v) this.sfx.ui('click');
    this.bus?.emit('audio:changed', { settings: this.engine.settings });
    return v;
  }

  toggleMusic(on) {
    const v = this.engine.toggleMusic(on);
    if (v && this.engine.ready && !this.music.playing) {
      this.music.setWorld(this.worldManager?.active?.id ?? this._pendingWorld);
    }
    this.bus?.emit('audio:changed', { settings: this.engine.settings });
    return v;
  }

  setMusicVolume(v) {
    this.engine.setMusicVolume(v);
    this.bus?.emit('audio:changed', { settings: this.engine.settings });
  }

  setSfxVolume(v) {
    this.engine.setSfxVolume(v);
    this.bus?.emit('audio:changed', { settings: this.engine.settings });
  }

  setMasterVolume(v) {
    this.engine.setMaster(v);
    this.bus?.emit('audio:changed', { settings: this.engine.settings });
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._stopMount();
    this._stopSwim();
    this.music.dispose();
    this.engine.dispose();
  }
}

export default AudioDirector;
