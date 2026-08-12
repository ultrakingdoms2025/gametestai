import * as THREE from 'three';
import { ITEMS, itemDef, KIND_ACCENT } from './ItemDefs.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * NPC loot drops and the world pickups they spawn.
 *
 * The pickups are a fixed pool built once at construction and parked hidden in
 * the scene. Nothing here allocates after that: no geometry, no material and no
 * vector is created while the game is running, and a drop is a matter of moving
 * an existing group and turning it on.
 *
 * That was long claimed to make every pickup material present for the boot
 * warmup, and it does not - see `warmAccents`. Building a material is not the
 * same as putting it on a mesh, and only the `ammo` set is ever worn by default,
 * so the first rare drop of a session linked five programs and froze the game
 * for 1.65 s. `warmAccents` is what actually makes the claim true.
 *
 * Deliberately **no lights**. A point light per pickup would look lovely and
 * would also change the scene light count at runtime, which invalidates Three's
 * whole program cache - the exact failure that cost this project a 63 s freeze
 * on first bow draw. The glow is an additive sprite and an emissive core.
 *
 * Overflow rules, per contract: bag first, store as overflow, and if neither
 * can take an item it stays on the ground as a smaller pile.
 */

/* ------------------------------------------------------------------ */
/* Scratch. Each function owns its own - two aliasing bugs from shared  */
/* scratch vectors cost this project days (see Physics.js _rc/_ct).     */
/* ------------------------------------------------------------------ */
const _sp = new THREE.Vector3(); // _spawnAt
const _ck = new THREE.Vector3(); // _collectCheck
const _dl = new THREE.Vector3(); // _dropFor

/* Pool size, and why it went up.
 *
 * 20 slots with 18 concurrent was sized for one 200 m deck where the only
 * persistent pickups were three caches. The station is now five decks and
 * carries well over a hundred authored interior collectibles between the hab
 * stacks, the zones and the crew rooms.
 *
 * The number matters more than it looks, because persistent pickups are exempt
 * from recycling: `_recycleOldest` only ever evicts a non-persistent one, so
 * once the active list is full of caches and interior spots it returns null and
 * *every corpse drop in the game silently stops spawning*. Interiors now streams
 * its spots by proximity (see Interiors.update) so the concurrent count stays
 * low whatever the map size, and this raise is the headroom on top of that: a
 * player standing in a hab stack with eight floors of spots in range, fighting,
 * with two caches nearby, must still have slots left for the drop.
 *
 * A pickup is a handful of instanced quads and a light-less root, so the cost of
 * the extra twelve is trivial next to that failure mode.
 */
const POOL_SIZE = 34;
/** Concurrent pickups. Beyond this the oldest non-persistent one is recycled. */
const MAX_ACTIVE = 30;
/** Seconds a pickup waits to be collected before it fades away. */
const LIFETIME = 150;
/** Walk-over radius, metres. Generous because the player is a fast mover. */
const AUTO_RANGE = 1.7;
/** `E` range, metres. */
const PROMPT_RANGE = 3.2;

/** Credits are always part of a drop; ammo depends on the world. */
const DROP_TABLES = {
  station: [
    { id: 'bullet', chance: 0.72, min: 20, max: 60 },
    { id: 'fireball_charge', chance: 0.2, min: 1, max: 3 },
    { id: 'arrow', chance: 0.14, min: 5, max: 12 },
    { id: 'alloy_scrap', chance: 0.3, min: 1, max: 3 },
    { id: 'medkit', chance: 0.13, min: 1, max: 1 },
    { id: 'nexus_shard', chance: 0.06, min: 1, max: 1 },
  ],
  medieval: [
    { id: 'arrow', chance: 0.7, min: 8, max: 24 },
    { id: 'bullet', chance: 0.24, min: 15, max: 40 },
    { id: 'relic_coin', chance: 0.32, min: 1, max: 4 },
    { id: 'fireball_charge', chance: 0.14, min: 1, max: 2 },
    { id: 'medkit', chance: 0.12, min: 1, max: 1 },
    { id: 'nexus_shard', chance: 0.05, min: 1, max: 1 },
  ],
  sports: [
    { id: 'bullet', chance: 0.5, min: 20, max: 50 },
    { id: 'arrow', chance: 0.4, min: 6, max: 18 },
    { id: 'fireball_charge', chance: 0.18, min: 1, max: 2 },
    { id: 'medkit', chance: 0.2, min: 1, max: 2 },
    { id: 'alloy_scrap', chance: 0.2, min: 1, max: 2 },
    { id: 'nexus_shard', chance: 0.05, min: 1, max: 1 },
  ],
};

/** Ordered so the pickup takes its colour from the rarest thing in it. */
const ACCENT_PRIORITY = ['trinket', 'consumable', 'ammo', 'currency'];

/* ------------------------------------------------------------------ */
/* Procedural textures (built once, shared by every pickup)            */
/* ------------------------------------------------------------------ */

function makeHaloTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.52, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Vertical fade for the marker beam - bright at the base, gone at the top. */
function makeBeamTexture() {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.3)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Loot {
  /**
   * @param {{ scene:THREE.Scene, engine?:any, physics?:any, bus?:any, materials?:any,
   *           input?:any, player?:any, inventory?:any, economy?:any, npcManager?:any }} ctx
   */
  constructor({ scene, engine, physics, bus, materials, input, player, inventory, economy, npcManager } = {}) {
    this.scene = scene;
    this.engine = engine ?? null;
    this.physics = physics ?? null;
    this.bus = bus ?? null;
    this.materials = materials ?? null;
    this.input = input ?? null;
    this.player = player ?? null;
    this.inventory = inventory ?? null;
    this.economy = economy ?? null;
    this.npcManager = npcManager ?? null;

    this.group = new THREE.Group();
    this.group.name = 'loot';
    this.scene?.add(this.group);

    this._pool = [];
    this._active = [];
    this._fullNotifyT = 0;
    this._eLatch = false;
    this._worldId = 'station';
    /** Active world, tracked for capability rules. @see ../worlds/WorldRules.js */
    this._world = null;
    this._magnetUntil = 0;
    this._magnetRange = AUTO_RANGE;

    this._buildPool();

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('npc:killed', (e) => this._onNPCKilled(e)));
      this._offs.push(
        bus.on('world:changed', (e) => {
          this._worldId = e?.id ?? this._worldId;
          this._world = e?.world ?? null;
          this.clear();
        })
      );
    }
  }

  /** Live pickups. @returns {Array<object>} */
  get pickups() {
    return this._active;
  }

  /* ====================================================================== */
  /* Pool                                                                   */
  /* ====================================================================== */

  _buildPool() {
    // One geometry set and one material per accent, shared by the whole pool.
    this._coreGeo = new THREE.OctahedronGeometry(0.17, 0);
    this._ringGeo = new THREE.TorusGeometry(0.3, 0.018, 6, 24);
    this._beamGeo = new THREE.CylinderGeometry(0.11, 0.16, 1.5, 10, 1, true);
    this._haloTex = makeHaloTexture();
    this._beamTex = makeBeamTexture();

    /** @type {Record<string, {core:THREE.Material, ring:THREE.Material, halo:THREE.SpriteMaterial, beam:THREE.Material}>} */
    this._mats = {};
    for (const kind of ACCENT_PRIORITY) {
      const col = new THREE.Color(KIND_ACCENT[kind] ?? '#52e9ff');
      const core = new THREE.MeshStandardMaterial({
        color: col.clone().multiplyScalar(0.35),
        emissive: col,
        emissiveIntensity: 2.6,
        metalness: 0.4,
        roughness: 0.3,
        flatShading: true,
      });
      core.name = `loot.core.${kind}`;
      const ring = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      ring.name = `loot.ring.${kind}`;
      const halo = new THREE.SpriteMaterial({
        map: this._haloTex,
        color: col,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        fog: false,
      });
      halo.name = `loot.halo.${kind}`;
      const beam = new THREE.MeshBasicMaterial({
        map: this._beamTex,
        color: col,
        transparent: true,
        opacity: 0.35,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      beam.name = `loot.beam.${kind}`;
      this._mats[kind] = { core, ring, halo, beam };
    }
    this.materials?.register?.('loot.core.ammo', this._mats.ammo.core);

    for (let i = 0; i < POOL_SIZE; i++) this._pool.push(this._makePickup(i));
  }

  _makePickup(index) {
    const root = new THREE.Group();
    root.name = `loot.pickup.${index}`;
    root.visible = false;
    root.matrixAutoUpdate = true;

    const core = new THREE.Mesh(this._coreGeo, this._mats.ammo.core);
    core.castShadow = false;
    core.receiveShadow = false;
    core.position.y = 0.55;

    const ring = new THREE.Mesh(this._ringGeo, this._mats.ammo.ring);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.55;
    ring.renderOrder = 3;

    const halo = new THREE.Sprite(this._mats.ammo.halo);
    halo.scale.setScalar(0.95);
    halo.position.y = 0.55;
    halo.renderOrder = 4;

    const beam = new THREE.Mesh(this._beamGeo, this._mats.ammo.beam);
    beam.position.y = 0.75;
    beam.renderOrder = 2;

    root.add(beam, ring, core, halo);
    this.group.add(root);

    return {
      index,
      root,
      core,
      ring,
      halo,
      beam,
      /** @type {Array<{itemId:string, qty:number}>} */
      contents: [],
      active: false,
      baseY: 0,
      phase: 0,
      age: 0,
      born: 0,
      dying: 0,
      accent: 'ammo',
      label: '',
    };
  }

  /* ====================================================================== */
  /* Drops                                                                  */
  /* ====================================================================== */

  _onNPCKilled(event) {
    if (!event || event.byPlayer !== true || !event.npc) return;
    this._dropFor(event.npc);
  }

  /** Roll the table for this world and spawn the pickup at the body. */
  _dropFor(npc) {
    // The maze wants no pickups.
    if (!allows(this._world, 'loot')) return;
    const table = DROP_TABLES[this._worldId] ?? DROP_TABLES.station;
    const contents = [];

    // Credits are guaranteed; they are the reason a pickup is always worth
    // walking to even when the ammo roll comes up empty.
    contents.push({ itemId: 'credits', qty: 4 + Math.floor(Math.random() * 11) });

    let rolls = 0;
    for (const entry of table) {
      if (Math.random() > entry.chance) continue;
      const qty = entry.min + Math.floor(Math.random() * (entry.max - entry.min + 1));
      if (qty <= 0) continue;
      contents.push({ itemId: entry.id, qty });
      if (++rolls >= 3) break; // three item types is plenty to read at a glance
    }

    _dl.copy(npc.position ?? _dl.set(0, 0, 0));
    // Nudge the pile off the corpse so it is not buried in the collapse pose.
    const a = Math.random() * Math.PI * 2;
    _dl.x += Math.cos(a) * 0.45;
    _dl.z += Math.sin(a) * 0.45;
    this.spawn(_dl, contents);
  }

  /**
   * Spawn a pickup. Public so a world event or a debug command can drop one.
   *
   * @param {THREE.Vector3} position roughly where it should land (feet height)
   * @param {Array<{itemId:string, qty:number}>} contents
   * @param {{persistent?:boolean, snap?:boolean, tag?:string}} [opts]
   *   `persistent` exempts the pickup from the fade timer and from recycling -
   *   world caches are a feature of the map, not litter from a firefight, and
   *   must still be there when the player comes back for them. `snap:false`
   *   keeps an authored height exactly as given, which is what a cache on a
   *   riverbed or a rooftop ledge needs.
   * @returns {object|null} the pooled pickup, or null if the pool is exhausted
   */
  spawn(position, contents, opts = {}) {
    if (!contents?.length) return null;
    const p =
      this._active.length >= MAX_ACTIVE
        ? this._recycleOldest()
        : this._pool.find((x) => !x.active) ?? this._recycleOldest();
    if (!p) return null;

    _sp.copy(position);
    let y = _sp.y;
    if (opts.snap !== false) {
      // Snap to the surface so a pickup never floats or sinks into a ramp.
      const g = this.physics?.groundHeight?.(_sp.x, _sp.z, _sp.y + 1.6, 6);
      if (g !== null && g !== undefined) y = g;
    }
    p.persistent = !!opts.persistent;
    p.tag = opts.tag ?? null;
    // Seconds after spawn before auto-collect is allowed. Used for player-dropped
    // items so they are not immediately re-picked up while the player stands on them.
    p.collectDelay = opts.collectDelay ?? 0;

    p.contents = contents.map((c) => ({ itemId: c.itemId, qty: c.qty }));
    p.active = true;
    p.age = 0;
    p.dying = 0;
    p.born = 0.001;
    p.phase = Math.random() * Math.PI * 2;
    p.baseY = y;
    p.accent = this._accentFor(p.contents);
    p.label = this._labelFor(p.contents);
    this._applyAccent(p);

    p.root.position.set(_sp.x, y, _sp.z);
    p.root.scale.setScalar(0.01);
    p.root.visible = true;
    this._active.push(p);

    this.bus?.emit('loot:dropped', { position: p.root.position, contents: p.contents });
    return p;
  }

  /** Free the longest-standing pickup so a fresh drop always gets a slot. */
  _recycleOldest() {
    // Never evict a cache to make room for a corpse drop: the caches are the
    // only pickups the player may have travelled a long way to reach.
    const evictable = this._active.filter((p) => !p.persistent);
    if (evictable.length === 0) return null;
    let oldest = evictable[0];
    for (const p of evictable) if (p.age > oldest.age) oldest = p;
    this._release(oldest);
    const i = this._active.indexOf(oldest);
    if (i >= 0) this._active.splice(i, 1);
    return oldest;
  }

  _accentFor(contents) {
    for (const kind of ACCENT_PRIORITY) {
      for (const c of contents) {
        if (ITEMS[c.itemId]?.kind === kind) return kind;
      }
    }
    return 'currency';
  }

  _labelFor(contents) {
    const parts = [];
    for (const c of contents) {
      const def = itemDef(c.itemId);
      parts.push(`${c.qty} ${def?.short ?? c.itemId}`);
    }
    return parts.join(' · ');
  }

  _applyAccent(p) {
    const m = this._mats[p.accent] ?? this._mats.ammo;
    p.core.material = m.core;
    p.ring.material = m.ring;
    p.halo.material = m.halo;
    p.beam.material = m.beam;
  }

  /**
   * Show one idle pickup of every accent, for the boot-time shader warm.
   *
   * ── Why this exists, and why "build the materials" was not enough ────────
   * The pool builds one material set per accent up front, but every pickup in
   * the pool is *made* wearing the `ammo` set - `_applyAccent` only swaps the
   * others in when a drop of that kind actually spawns. `renderer.compile()`
   * collects materials by walking `object.material`, so it has never once seen
   * `loot.beam.trinket`; the first rare drop the player ever walks past linked
   * it on the spot. Measured cold: 5 programs, 1.65 s, in one frame.
   *
   * Five, not four, for four meshes. `loot.beam.*` is transparent *and*
   * `DoubleSide`, and three renders that combination in two passes - once with
   * `side = BackSide`, once with `FrontSide` - which are two different program
   * cache keys off one material. Nothing about the material graph reveals that;
   * only drawing it does. `renderer.compile()` reproduces the same two-pass
   * split (`prepareMaterial`), so a compile with the accents *attached* is
   * enough to issue both links - but the driver defers the link check to first
   * use, so they must also be drawn. Hence: attach, show, and let the caller
   * render frames.
   *
   * Nothing here touches `_active`, emits `loot:dropped`, or gives the player
   * anything. These are pool entries posed for the camera and then put back.
   *
   * @param {THREE.Vector3} position Centre to lay them out around.
   * @returns {() => void} Restore. Always call it.
   */
  warmAccents(position) {
    const kinds = Object.keys(this._mats);
    /** @type {Array<{p:object, accent:string, visible:boolean, scale:number, x:number, y:number, z:number}>} */
    const touched = [];
    kinds.forEach((kind, i) => {
      // Never borrow a pickup that is actually in the world: a cache or a
      // player-dropped item must not blink into a different colour and back.
      const p = this._pool[i];
      if (!p || p.active) return;
      touched.push({
        p,
        accent: p.accent,
        visible: p.root.visible,
        scale: p.root.scale.x,
        x: p.root.position.x, y: p.root.position.y, z: p.root.position.z,
      });
      p.accent = kind;
      this._applyAccent(p);
      // Spread them so none is hidden inside another, and stand them next to
      // the player so the shadow and post chains reach them too.
      p.root.position.set(position.x + 1.1 * (i - kinds.length / 2), position.y, position.z + 2.5);
      p.root.scale.setScalar(1);
      p.root.visible = true;
    });
    return () => {
      for (const t of touched) {
        t.p.accent = t.accent;
        this._applyAccent(t.p);
        t.p.root.visible = t.visible;
        t.p.root.scale.setScalar(t.scale);
        t.p.root.position.set(t.x, t.y, t.z);
      }
    };
  }

  /* ====================================================================== */
  /* Frame                                                                  */
  /* ====================================================================== */

  /**
   * Animation and collection. Driven from the fixed step (main.js runs loot
   * between projectiles and unstuck); everything is a function of `elapsed`
   * rather than an integration, so being called from the frame loop as well
   * is harmless.
   *
   * @param {number} dt
   * @param {number} elapsed
   */
  fixedUpdate(dt, elapsed) {
    if (this._fullNotifyT > 0) this._fullNotifyT -= dt;
    if (elapsed >= this._magnetUntil) this._magnetRange = AUTO_RANGE;

    const player = this.player;
    const pressedE = this._consumeInteract();

    for (let i = this._active.length - 1; i >= 0; i--) {
      const p = this._active[i];
      p.age += dt;

      // Spawn pop, then the resting bob.
      if (p.born > 0) {
        p.born = Math.min(1, p.born + dt * 3.4);
        const s = 1 - (1 - p.born) * (1 - p.born);
        p.root.scale.setScalar(0.35 + s * 0.65);
        if (p.born >= 1) p.born = 0;
      }
      if (p.dying > 0) {
        p.dying -= dt * 3.2;
        const k = Math.max(0, p.dying);
        // Collect flourish: flare outward while shrinking to nothing. Scale
        // only - the materials are shared by the whole pool, so fading one
        // material's opacity would fade every other pickup with it.
        p.root.scale.setScalar(k * (1 + (1 - k) * 1.1));
        if (p.dying <= 0) {
          this._release(p);
          this._active.splice(i, 1);
        }
        continue;
      }

      const bob = Math.sin(elapsed * 1.9 + p.phase) * 0.075;
      p.root.position.y = p.baseY + bob;
      p.core.rotation.y = elapsed * 1.15 + p.phase;
      p.core.rotation.x = Math.sin(elapsed * 0.7 + p.phase) * 0.25;
      p.ring.rotation.z = -elapsed * 0.8 + p.phase;
      const pulse = 0.92 + Math.sin(elapsed * 3.1 + p.phase) * 0.1;
      p.halo.scale.setScalar(pulse);

      // World caches are part of the map, not battlefield litter: they wait.
      if (!p.persistent && p.age > LIFETIME) {
        p.dying = 1;
        continue;
      }

      if (!player) continue;
      // Honour a per-pickup grace period so player-dropped items are not
      // immediately re-collected while the player stands on them.
      if (p.age < (p.collectDelay ?? 0)) continue;
      _ck.copy(p.root.position);
      _ck.y = p.baseY;
      const d2 = _ck.distanceToSquared(player.position);
      const autoRange = this._magnetRange;
      if (d2 <= autoRange * autoRange || (pressedE && d2 <= PROMPT_RANGE * PROMPT_RANGE)) {
        this._collect(p);
      }
    }
  }

  /**
   * `E` is shared with talking and portals, so it is read once per frame and
   * latched: a fixed step can run several times per rendered frame, and without
   * the latch one keypress would try to collect several times.
   */
  _consumeInteract() {
    const down = this.input?.pressed?.('KeyE') ?? false;
    if (down && !this._eLatch) {
      this._eLatch = true;
      return true;
    }
    if (!down) this._eLatch = false;
    return false;
  }

  /** Optional frame tick; the animation is time-absolute so this is a no-op. */
  update() {}

  setMagnet(duration, range = 5.5) {
    if (!(duration > 0)) return false;
    this._magnetRange = Math.max(this._magnetRange, range);
    this._magnetUntil = Math.max(this._magnetUntil, (this.engine?.elapsed ?? 0) + duration);
    return true;
  }

  /* ====================================================================== */
  /* Collection                                                             */
  /* ====================================================================== */

  _collect(p) {
    const left = [];
    let took = 0;
    // Survey contracts key off this: recovering a world cache is a different
    // event from stripping a corpse, even though both arrive as pickups.
    const fromCache = typeof p.tag === 'string' && p.tag.startsWith('cache:');

    for (const entry of p.contents) {
      if (entry.itemId === 'credits') {
        this.economy?.add(entry.qty, 'loot');
        this.bus?.emit('loot:collected', { itemId: 'credits', qty: entry.qty, fromCache, pickup: p });
        this.bus?.emit('quest:activity', { type: 'collect', target: entry.itemId, id: entry.itemId, itemId: entry.itemId, pickup: p });
        took++;
        continue;
      }
      const res = this.inventory?.acquire(entry.itemId, entry.qty) ?? { taken: 0, dropped: entry.qty };
      if (res.taken > 0) {
        took++;
        this.bus?.emit('loot:collected', { itemId: entry.itemId, qty: res.taken, fromCache, pickup: p });
        this.bus?.emit('quest:activity', { type: 'collect', target: entry.itemId, id: entry.itemId, itemId: entry.itemId, pickup: p });
        this.bus?.emit('hud:notify', {
          text: `+${res.taken} ${itemDef(entry.itemId)?.name ?? entry.itemId}${res.toStore > 0 ? ' (store)' : ''}`,
          tone: 'info',
        });
      }
      if (res.dropped > 0) left.push({ itemId: entry.itemId, qty: res.dropped });
    }

    if (left.length === 0) {
      p.dying = 1;
      return;
    }

    // Something did not fit. Keep the remainder on the ground rather than
    // deleting it, and say so - once every few seconds, not once per frame.
    p.contents = left;
    p.accent = this._accentFor(left);
    p.label = this._labelFor(left);
    this._applyAccent(p);
    if (took === 0 && this._fullNotifyT <= 0) {
      this._fullNotifyT = 3;
      this.bus?.emit('hud:notify', { text: 'Inventory full — pickup left on the ground', tone: 'warn' });
    }
  }

  /**
   * Take a pickup off the map without collecting it.
   *
   * For streamed spawners - `Interiors` puts an authored collectible in the
   * world when the player is near enough to see it and takes it away again
   * when they leave, so a map with two hundred authored spots still only ever
   * holds a handful of live pickups. Deliberately silent: no `loot:collected`,
   * so nothing downstream thinks the player picked it up.
   */
  despawn(p) {
    if (!p?.active) return false;
    const i = this._active.indexOf(p);
    if (i >= 0) this._active.splice(i, 1);
    this._release(p);
    return true;
  }

  _release(p) {
    p.active = false;
    p.contents.length = 0;
    p.root.visible = false;
    p.dying = 0;
    p.born = 0;
    p.root.scale.setScalar(1);
  }

  /** Remove every live pickup, e.g. on a world change. */
  clear() {
    for (const p of this._active) this._release(p);
    this._active.length = 0;
  }

  dispose() {
    this.clear();
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* a bus that already cleared its handlers is not an error */
      }
    }
    this._offs.length = 0;
    this.group.removeFromParent();
    this._coreGeo.dispose();
    this._ringGeo.dispose();
    this._beamGeo.dispose();
    this._haloTex.dispose();
    this._beamTex.dispose();
    for (const kind in this._mats) {
      const m = this._mats[kind];
      m.core.dispose();
      m.ring.dispose();
      m.halo.dispose();
      m.beam.dispose();
    }
  }
}
