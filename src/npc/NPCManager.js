import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { CharacterAssets, HumanoidFactory } from './Humanoid.js';
import { FriendlyNPC } from './FriendlyNPC.js';
import { HostileNPC } from './HostileNPC.js';
import { resolveSpot, resolveSurfaceY, seatSurfaceAt, isDeepWater, nearestDrySpot } from './Grounding.js';
import { ROLE, ROLE_ROTATION, castFor, roleDef } from './NPCRoles.js';
import { WEAPON_TABLES } from './NPCWeapons.js';
import { DEFAULT_LORE, buildLorePersona, loreEntryForScope } from '../content/Lore.js';

/**
 * Owns every NPC in the active world: spawning, budget, level of detail,
 * hit queries, chat proximity and hostile respawn.
 *
 * Skinned meshes are the most expensive thing in the scene, so the manager is
 * also the throttle: a hard cap on live characters, animation update rates that
 * fall off with distance, foot IK disabled beyond 25 m and a cheap sphere
 * frustum test that stops off-screen characters posing at all.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
/** _snapToGround() and the water watchdog own this exclusively. */
const _dryScratch = new THREE.Vector3();
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
// raySegment owns these exclusively - callers must not pass them in.
const _seg = new THREE.Vector3();
const _rsA = new THREE.Vector3();
const _rsB = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();

/**
 * Minimum XZ gap between two live characters' roots.
 *
 * Steering separation is a *force*, and a force loses: an agent whose seek term
 * is larger than its separation term walks straight into a neighbour and stays
 * there, and two idle characters have no seek term at all so they never
 * separate in the first place - `Navigation.update` returns before the
 * separation block when there is no target. Three characters placed on the same
 * spot measured a gap of exactly 0.000 m indefinitely, and identical skinned
 * geometry at an identical transform z-fights, which is the flicker the player
 * reported.
 *
 * So overlap is resolved as a *constraint* instead. A constraint converges in a
 * few steps and has no feedback path into the steering, so unlike a force it
 * cannot oscillate. 0.62 m keeps two 0.33 m bodies brushing shoulders without
 * ever sharing a triangle, which is well inside the 0.85 m minimum the group
 * spawner already enforces - so standing formations are untouched.
 */
const PERSONAL_SPACE = 0.62;
const PERSONAL_SPACE_SQ = PERSONAL_SPACE * PERSONAL_SPACE;
/** Fraction of the overlap resolved per step. Under 1 so simultaneous contacts settle. */
const SEPARATION_RELAX = 0.5;
/**
 * Hard cap on how far one step may move a character. Keeps the correction
 * sub-step-sized so `resolveCapsule` on the next tick can always absorb a push
 * that happened to be into a wall, and stops it ever reading as a teleport.
 */
const SEPARATION_MAX_STEP = 0.06;
/** Above this height difference the two are on different decks, not overlapping. */
const SEPARATION_MAX_RISE = 1.2;

/**
 * LOD switch hysteresis.
 *
 * Every one of these used to be a single boundary, so a character sitting on
 * the threshold toggled its eye meshes - or, at the far switch, its whole body -
 * on and off from frame to frame. Separate in/out distances turn each switch
 * into a band that has to be crossed properly before anything changes.
 */
const DETAIL_IN = 23;
const DETAIL_OUT = 27;
const IK_IN = 21;
const IK_OUT = 24;
const RENDER_IN = 125;
const RENDER_OUT = 135;

const THEME_BY_WORLD = { station: 'station', medieval: 'medieval', sports: 'sports' };
const MERCHANT_SIGN_WORLD = {
  station: 'AETHER NEXUS',
  medieval: 'ALDERMOOR VALE',
  sports: 'MERIDIAN ARENA',
  citadel: 'SUNSPIRE CITADEL',
  race: 'VELLUM CIRCUIT',
};

/** Fallback names so a world that forgets to name its friendlies still reads. */
const FALLBACK_NAMES = {
  station: ['Vex Orrin', 'Dr. Hala Mensu', 'Rig-Chief Danno', 'Sable Ito', 'Quartermaster Rhee', 'Pilot Ashe'],
  medieval: ['Alwin the Cooper', 'Mistress Bryda', 'Father Osric', 'Tam the Fletcher', 'Goodwife Elgiva', 'Sergeant Cuthred'],
  sports: ['Coach Marra', 'Deuce Kowalski', 'Nia Sandoval', 'Ollie Trent', 'Ref Bastian', 'Skye Larsen'],
};

/**
 * Extra civilians used to fill out the social hubs. Worlds only author a
 * handful of named characters, which leaves plazas and market squares reading
 * as evacuated, so the manager tops the population up itself.
 */
const CROWD_NAMES = {
  station: [
    'Deck Tech Ruiz', 'Nav Cadet Bell', 'Hauler Kito', 'Medtech Vos', 'Fitter Okonjo',
    'Comms Officer Idi', 'Longshore Yusuf', 'Rations Clerk Pia', 'Welder Strand', 'Inspector Tamm',
    'Cargo Marshal Rho', 'Hydroponics Lem',
  ],
  medieval: [
    'Wat the Tanner', 'Goody Hulda', 'Edric Millson', 'Rilda the Baker', 'Hob the Drover',
    'Sister Aveline', 'Grim the Smith', 'Little Maude', 'Ceorl the Reeve', 'Tibb Wainwright',
    'Old Widow Særa', 'Piers the Carter',
  ],
  sports: [
    'Tess Halvorsen', 'Marco Diaz', 'Junie Park', 'Rowan Blake', 'Ash Delacroix',
    'Kenji Ito', 'Bex Ferrara', 'Dev Chaudhary', 'Lena Wojcik', 'Toby Nkemelu',
    'Nadia Reyes', 'Grant Okafor',
  ],
};

/** One-line briefs so a filler civilian still has something to say. */
const CROWD_PERSONAS = {
  station: [
    'A shift worker on Ring 7 who talks about hull maintenance backlogs and bad recycled coffee.',
    'A dock hand waiting on a delayed freighter, cheerful but tired of the paperwork.',
    'A junior technician who is very proud of a repair nobody has noticed yet.',
    'A trader between contracts, always angling for gossip about the portals.',
  ],
  medieval: [
    'A villager in for market day, full of complaints about the toll on the bridge.',
    'A craftsman taking a break, quietly proud of the work and suspicious of strangers.',
    'A farmhand up from the river fields who has heard three different rumours about the keep.',
    'A pilgrim resting in the square, convinced the shimmering gate is an omen.',
  ],
  sports: [
    'A regular at the park who will happily explain why your stance is wrong.',
    'A club coach between sessions, upbeat and relentlessly encouraging.',
    'A weekend skier waiting for the lift queue to clear, hyped about the fresh piste.',
    'A spectator killing time before the next match, keen to talk scores.',
  ],
};

/** Postures that read well in a standing group, weighted toward folded arms. */
const GROUP_POSTURES = ['crossed', 'hips', 'pocket', 'crossed', 'lean', 'none'];

/** Ray vs. capsule segment. Returns the hit distance or -1. */
function raySegment(origin, dir, a, b, radius, maxDist) {
  _seg.subVectors(b, a);
  const baba = _seg.dot(_seg);
  if (baba < 1e-9) return -1;
  const bard = _seg.dot(dir);
  _rsA.subVectors(origin, a);
  const baoa = _seg.dot(_rsA);
  const rdoa = dir.dot(_rsA);
  const oaoa = _rsA.dot(_rsA);
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - radius * radius * baba;
  let y = baoa;
  if (Math.abs(A) > 1e-9) {
    const h = B * B - A * C;
    if (h >= 0) {
      const t = (-B - Math.sqrt(h)) / A;
      y = baoa + t * bard;
      if (t > 0 && t < maxDist && y > 0 && y < baba) return t;
    }
  }
  // Spherical caps at whichever end the ray passes.
  _rsB.copy(y <= 0 ? a : b);
  _rsA.subVectors(origin, _rsB);
  const bq = dir.dot(_rsA);
  const cq = _rsA.dot(_rsA) - radius * radius;
  const hq = bq * bq - cq;
  if (hq > 0) {
    const tc = -bq - Math.sqrt(hq);
    if (tc > 0 && tc < maxDist) return tc;
  }
  return -1;
}

function raySphere(origin, dir, center, radius, maxDist) {
  _rsA.subVectors(origin, center);
  const b = _rsA.dot(dir);
  const c = _rsA.dot(_rsA) - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 0 && t < maxDist ? t : -1;
}

export class NPCManager {
  /** @param {{scene:THREE.Scene, engine:any, physics:any, bus:any, materials:any, player:any}} ctx */
  constructor({ scene, engine, physics, bus, materials, player }) {
    this.scene = scene;
    this.engine = engine;
    this.physics = physics;
    this.bus = bus;
    this.materials = materials;
    this.player = player;

    this.assets = new CharacterAssets(engine?.renderer);
    this.factory = new HumanoidFactory({ assets: this.assets });

    /** @type {import('./NPC.js').NPC[]} */
    this._npcs = [];
    this._hostiles = [];
    this._friendlies = [];
    this._respawnQueue = [];
    this.theme = 'station';
    this.worldId = null;
    this._loreData = DEFAULT_LORE;

    /** Hard ceiling regardless of what a world asks for. */
    this.maxNPCs = 26;
    this.maxHostiles = CONFIG.npc.hostileCount;
    // Worlds only author a handful of named civilians. A plaza needs a crowd,
    // so the manager tops the friendly population up itself (see _populateHubs)
    // and this is the ceiling for the result.
    this.maxFriendlies = Math.max(CONFIG.npc.friendlyCount, 14);

    /**
     * Swimmable water for the active world.
     *
     * Characters have no swimming animation and no buoyancy - only the player
     * does - so water is a hazard they have to be taught about, and until they
     * were, three of the medieval crowd spent their lives walking along the
     * riverbed. `WaterVolumes` derives the volumes from world geometry and
     * announces them; every character's steering, destination picking and
     * grounding consults them through here.
     * @type {import('../systems/WaterVolumes.js').WaterVolumes|null}
     */
    this.water = null;
    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('water:volumes', ({ water }) => this.setWater(water)));
      // WaterVolumes may already have scanned this world before we subscribed;
      // asking makes the wiring order between the two irrelevant.
      this.bus.emit('water:request');
    }

    this._chatNPC = null;
    this._coverToken = 0;
    this._lodCursor = 0;
    this._seedCounter = 1;

    /** Friendlies flagged as traders. The Marketplace keys on these. */
    this._vendors = [];
    /**
     * Grounding watchdog cursor. One character re-audited per fixed step is
     * about 0.4 s to sweep a full world at 60 Hz, which is fast enough to catch
     * anything that slips through geometry and far too cheap to notice.
     */
    this._groundCursor = 0;
    this._groundFixes = 0;
    this._pauseUntil = 0;

    // Shared contact-shadow layer. One InstancedMesh for the whole crowd - a
    // per-character decal would have cost 26 extra draw calls, and this world
    // has no headroom for that. See `_updateContactShadows`.
    this._contact = new THREE.InstancedMesh(
      this.assets.contactDiscGeometry(),
      this.assets.contactShadow(),
      this.maxNPCs
    );
    this._contact.name = 'npc.contactShadows';
    this._contact.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._contact.frustumCulled = false;
    this._contact.castShadow = false;
    this._contact.receiveShadow = false;
    this._contact.renderOrder = 2;
    this._contact.count = 0;
    this.scene.add(this._contact);
    this._contactMat = new THREE.Matrix4();
    this._contactPos = new THREE.Vector3();
    this._contactQuat = new THREE.Quaternion();
    this._contactScale = new THREE.Vector3();

    // If nothing else resolves NPC gunfire we do it ourselves, so hostiles are
    // always a real threat even before CombatSystem is wired up.
    this._selfResolveFire = true;
    this.bus?.on('weapon:fired', ({ origin }) => this._onGunfire(origin ?? this.player?.position, 1));
  }

  get npcs() {
    return this._npcs;
  }
  get hostiles() {
    return this._hostiles;
  }
  get friendlies() {
    return this._friendlies;
  }
  /** Friendlies that trade. Marketplace opens next to one of these. */
  get vendors() {
    return this._vendors;
  }

  /**
   * Nearest trader within `maxRange`, for the Marketplace proximity check.
   * @returns {import('./NPC.js').NPC|null}
   */
  nearestVendor(position, maxRange = 4.5) {
    let best = null;
    let bestSq = maxRange * maxRange;
    for (const npc of this._vendors) {
      if (npc.isDead) continue;
      const d = npc.position.distanceToSquared(position);
      if (d < bestSq) {
        bestSq = d;
        best = npc;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* Spawning                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Build every NPC described by `world.npcSpawns`. Positions are snapped to
   * the floor with `physics.groundHeight` so nothing ever spawns embedded in
   * geometry or hovering above it.
   */
  spawnForWorld(world) {
    this.clear();
    if (!world) return;
    this.worldId = world.id;
    this.theme = THEME_BY_WORLD[world.id] ?? 'station';
    const spawns = world.npcSpawns ?? [];

    let friendlyCount = 0;
    let hostileCount = 0;
    let nameIndex = 0;
    const names = FALLBACK_NAMES[this.theme];
    // Deal the hostile weapons out up front so every id in the theme's table is
    // represented and every model is built during world activation. A re-roll
    // later then only ever picks a weapon whose material is already compiled.
    const weaponDeal = this._dealWeapons(this.maxHostiles);
    const weaponPool = (WEAPON_TABLES[this.theme] ?? WEAPON_TABLES.station).map(([id]) => id);
    // Reserve part of the civilian budget for standing groups. Worlds author
    // their named characters spread out along walking routes, which is right
    // for them but leaves nobody actually stood in the square talking.
    const authoredCap = Math.max(4, Math.round(this.maxFriendlies * 0.6));

    const anchors = [];
    for (const spec of spawns) {
      if (this._npcs.length >= this.maxNPCs) break;
      const hostile = spec.type === 'hostile';
      if (hostile && hostileCount >= this.maxHostiles) continue;
      if (!hostile && friendlyCount >= authoredCap) continue;

      const pos = this._snapToGround(spec.position);
      if (!pos) continue;

      const name = spec.name ?? (hostile ? `Sentinel ${hostileCount + 1}` : names[nameIndex++ % names.length]);
      const npc = this._createNPC({
        hostile,
        name,
        persona: spec.persona,
        position: pos,
        patrol: (spec.patrol ?? []).map((p) => this._snapToGround(p)),
        yaw: spec.yaw ?? 0,
        posture: spec.posture,
        role: spec.role ?? (hostile ? undefined : ROLE.WANDERER),
        weaponId: hostile ? weaponDeal[hostileCount] : undefined,
        weaponPool: hostile ? weaponPool : undefined,
      });
      npc.spawnSpec = spec;
      if (hostile) hostileCount++;
      else {
        friendlyCount++;
        anchors.push(pos);
      }
    }

    friendlyCount += this._spawnLorekeepers(world);
    this._spawnQuestManagers(world);
    this._populateHubs(anchors, this.maxFriendlies - friendlyCount);
    for (const npc of this._hostiles) npc.prebuildWeapons?.();
    this._seatCivilians();
    this.validateGrounding();
  }

  setLoreData(entries) {
    this._loreData = entries ?? DEFAULT_LORE;
    const lorekeepers = this._friendlies.filter((npc) => npc.isLorekeeper);
    for (const npc of lorekeepers) {
      const scope = npc.loreScope ?? this.worldId ?? 'overall';
      const entry = this._loreData?.[scope] ?? loreEntryForScope(scope);
      npc.persona    = buildLorePersona(scope, this._loreData);
      npc.loreTitle  = String(entry.title ?? 'World Lore');
      npc.loreBody   = String(entry.body ?? '');
      npc.setSignLines?.([
        String(entry.sign_label ?? 'Lorekeeper').toUpperCase(),
        String(entry.title ?? scope).toUpperCase(),
      ]);
    }
  }

  /**
   * Deal one weapon id per hostile.
   *
   * Every id the theme uses appears at least once before any repeats, so a
   * player always meets the full mix, and the shuffle keeps it from being the
   * same character carrying the same thing every time.
   *
   * @param {number} count
   * @returns {string[]}
   */
  _dealWeapons(count) {
    const table = WEAPON_TABLES[this.theme] ?? WEAPON_TABLES.station;
    const ids = table.map(([id]) => id);
    const weights = table.map(([, w]) => w);
    const out = [];
    for (let i = 0; i < count; i++) {
      if (i < ids.length) {
        out.push(ids[i]);
        continue;
      }
      let total = 0;
      for (const w of weights) total += w;
      let roll = Math.random() * total;
      let picked = ids[0];
      for (let k = 0; k < ids.length; k++) {
        roll -= weights[k];
        if (roll <= 0) {
          picked = ids[k];
          break;
        }
      }
      out.push(picked);
    }
    // Fisher-Yates, so "the first hostile always has the sidearm" is not a rule
    // the player can learn.
    for (let i = out.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = out[i];
      out[i] = out[j];
      out[j] = t;
    }
    return out;
  }

  /**
   * Sit a couple of civilians down on whatever the world already has to sit on.
   *
   * There is no authored seat data in any of these worlds, so seats are found
   * rather than placed: `seatSurfaceAt` looks for a narrow surface a bench's
   * height above the floor near each standing civilian. Benches, planter rims,
   * bleacher treads and low walls all match; buildings and crates do not.
   *
   * Capped low on purpose - a plaza with two or three people sat down reads as
   * a plaza, one with a dozen reads as a waiting room.
   */
  _seatCivilians() {
    let seated = 0;
    const cap = 4;
    for (const npc of this._friendlies) {
      if (seated >= cap) break;
      if (!npc.roleDef?.seatable || npc.seated) continue;
      const floor = npc.position.y;
      let found = null;
      // Search a short ring around the character rather than only under their
      // feet: they were placed on open ground on purpose, and the bench is the
      // thing they were placed *next to*.
      for (const r of [0.9, 1.5, 2.2]) {
        for (let i = 0; i < 6 && !found; i++) {
          const a = (i / 6) * Math.PI * 2 + r;
          const x = npc.position.x + Math.cos(a) * r;
          const z = npc.position.z + Math.sin(a) * r;
          const y = seatSurfaceAt(this.physics, x, z, floor);
          if (y !== null) found = { x, y, z };
        }
        if (found) break;
      }
      if (!found) continue;
      npc.position.set(found.x, found.y, found.z);
      npc.spawnPoint.copy(npc.position);
      npc.setSeated(true, found.y - floor);
      seated++;
    }
    this._seatedCount = seated;
  }

  /**
   * Post-spawn grounding sweep.
   *
   * Every character is re-audited against the full surface stack at its column
   * the moment the world finishes spawning, and anything that resolved onto a
   * roof, into a basement or inside a mesh is corrected before the first frame
   * is drawn. `NPC.auditGrounding` is the same check the runtime watchdog runs.
   *
   * @returns {number} how many characters had to be corrected
   */
  validateGrounding() {
    let fixed = 0;
    for (const npc of this._npcs) {
      if (npc.auditGrounding(true)) fixed++;
    }
    this._groundFixes += fixed;
    return fixed;
  }

  /**
   * Adopt the active world's water volumes and push them down to every agent.
   *
   * Called from the `water:volumes` announcement, which fires on every world
   * change - so this is also what *clears* the medieval river when the player
   * portals to a world that has no water at all.
   *
   * @param {import('../systems/WaterVolumes.js').WaterVolumes|null} water
   */
  setWater(water) {
    this.water = water || null;
    for (const npc of this._npcs) npc.setWater(this.water);
  }

  /**
   * Pull one character out of deep water, on the same round-robin as the
   * grounding watchdog.
   *
   * Steering keeps characters from walking in, but it cannot help anyone who is
   * already there - dropped in by a respawn, shoved off a bank by the crowd
   * separation pass, or knocked in by an explosion. Without this they would
   * simply live in the river.
   *
   * @param {import('./NPC.js').NPC} npc
   * @returns {boolean} true if the character had to be moved
   */
  _auditWater(npc) {
    if (!this.water || !npc || npc.isDead) return false;
    const p = npc.position;
    if (!isDeepWater(this.physics, this.water, p.x, p.z)) return false;
    const dry = nearestDrySpot(this.physics, this.water, p, _dryScratch);
    if (!dry) return false;
    npc.position.copy(dry);
    npc.velocity.set(0, 0, 0);
    // Re-home them too: a character whose spawn point is in the river would
    // walk straight back in the moment it next decided to go home.
    if (isDeepWater(this.physics, this.water, npc.spawnPoint.x, npc.spawnPoint.z)) {
      npc.spawnPoint.copy(dry);
    }
    npc.nav?.clear?.();
    npc.auditGrounding(true);
    return true;
  }

  /**
   * Build one character and file it. Everything a world can author and
   * everything the crowd filler needs goes through here.
   *
   * @param {{hostile:boolean, name:string, persona?:string, position:THREE.Vector3,
   *          patrol?:THREE.Vector3[], yaw?:number, anchored?:boolean,
   *          groupFocus?:THREE.Vector3, posture?:string}} o
   */
  _createNPC(o) {
    const seed = (this._hashSeed(this.worldId ?? '') ^ (this._seedCounter++ * 2654435761)) >>> 0;
    const humanoid = this.factory.create({
      seed,
      theme: this.theme,
      // Hostiles read as a unit: heavier builds and the armoured variant.
      variant: o.hostile ? this._hostileVariant() : undefined,
      build: o.hostile ? (seed % 3 === 0 ? 2 : 1) : undefined,
    });

    const ctx = {
      name: o.name,
      persona: o.persona,
      position: o.position,
      patrol: o.patrol ?? [],
      theme: this.theme,
      scene: this.scene,
      physics: this.physics,
      bus: this.bus,
      manager: this,
      humanoid,
      seed,
      yaw: o.yaw ?? 0,
      anchored: o.anchored,
      groupFocus: o.groupFocus,
      posture: o.posture,
      role: o.role,
      weaponId: o.weaponId,
      weaponPool: o.weaponPool,
    };
    const npc = o.hostile ? new HostileNPC(ctx) : new FriendlyNPC(ctx);
    // A world-authored posture is a costume note, not a life sentence: the idle
    // loop still runs, it just starts from the pose the world asked for.
    if (o.posture) npc.fixedPosture = true;
    npc.isLorekeeper   = o.role === ROLE.LOREKEEPER;
    npc.isQuestManager = o.isQuestManager ?? false;
    npc.loreScope = o.loreScope ?? null;
    if (o.signLines) npc.setSignLines?.(o.signLines);
    if (npc.isVendor && !o.signLines) {
      npc.setSignLines?.([
        'MERCHANT',
        MERCHANT_SIGN_WORLD[this.worldId] ?? String(this.worldId ?? 'NEXUS').toUpperCase(),
      ]);
    }
    // Before the first step it takes: a character created after the world's
    // water was announced would otherwise steer blind until the next swap.
    npc.setWater(this.water);
    this._npcs.push(npc);
    if (o.hostile) {
      this._hostiles.push(npc);
    } else {
      this._friendlies.push(npc);
      if (npc.isVendor) this._vendors.push(npc);
    }
    this.bus?.emit('npc:spawned', { npc });
    return npc;
  }

  _spawnLorekeepers(world) {
    const specs = world?.portalSpecs ?? [];
    let made = 0;
    for (let i = 0; i < specs.length && this._npcs.length < this.maxNPCs; i++) {
      const spec = specs[i];
      const rotY = spec.rotationY ?? 0;
      const right = new THREE.Vector3(Math.cos(rotY), 0, -Math.sin(rotY));
      const normal = new THREE.Vector3(Math.sin(rotY), 0, Math.cos(rotY));
      const base = spec.position.clone()
        .addScaledVector(normal, 2.6)
        .addScaledVector(right, i % 2 === 0 ? 2.1 : -2.1);
      const spot = this._snapToGround(base);
      if (!spot) continue;
      const entry = this._loreData?.[world.id] ?? loreEntryForScope(world.id);
      const label = String(entry.sign_label ?? 'Lorekeeper').toUpperCase();
      const persona = buildLorePersona(world.id, this._loreData);
      const npc = this._createNPC({
        hostile: false,
        name: label,
        persona,
        position: spot,
        yaw: rotY + Math.PI,
        anchored: true,
        role: ROLE.LOREKEEPER,
        posture: 'crossed',
        signLines: [label, String(world.displayName ?? world.id).toUpperCase()],
        loreScope: world.id,
      });
      npc.isLorekeeper = true;
      npc.loreTitle = String(entry.title ?? 'World Lore');
      npc.loreBody  = String(entry.body ?? '');
      npc.portalTarget = spec.target;
      made++;
    }
    return made;
  }

  /**
   * Spawn one Quest Manager NPC per world, anchored in a fixed position near
   * the player spawn so they are always easy to find. Each world has a named
   * character with appropriate persona.
   *
   * @param {import('../worlds/World.js').World} world
   */
  _spawnQuestManagers(world) {
    if (!world) return;

    /**
     * World-specific Quest Manager cast.
     * position: [x, y, z] in world-space (snapped to ground)
     * yaw: facing direction (radians)
     */
    const CAST = {
      station: {
        name: 'Zara Vex',
        persona: 'The Quest Manager for Aether Nexus Station: a sharp, efficient coordinator who has dispatched hundreds of agents through both portals. She speaks in mission briefings, rates everything by risk-versus-reward, and keeps a running tally of completed objectives on a holo-pad she never puts down.',
        position: [-22, 0.2, 12],
        yaw: -Math.PI / 2,
        sign: ['QUEST MANAGER', 'AETHER NEXUS'],
      },
      medieval: {
        name: 'Edmund Marsh',
        persona: 'Quest Manager for Aldermoor Vale: a former knight who now coordinates missions from a market stall covered in parchment scrolls. He is methodical, formal, and expects every job to be done properly. He uses old-world titles and is quietly proud of his record.',
        position: [10, 0.2, -9],
        yaw: 2.5,
        sign: ['QUEST MANAGER', 'ALDERMOOR VALE'],
      },
      sports: {
        name: 'Petra Vance',
        persona: 'Quest Manager for the Meridian Athletic Grounds: a former champion athlete turned talent coordinator. She is direct, competitive, and constantly evaluating performance. She quotes personal bests, issues challenges, and believes any task worth doing is worth optimising.',
        position: [-8, 0.9, 128],
        yaw: Math.PI,
        sign: ['QUEST MANAGER', 'MERIDIAN ARENA'],
      },
      citadel: {
        name: 'Aldric Storne',
        persona: 'Quest Manager for Sunspire Citadel: a senior officer of the Citadel garrison who assigns official missions. He is grave, measured, and speaks with the authority of the walls behind him. Every mission he issues is considered; none are trivial.',
        position: [8, 14.3, 88],
        yaw: 0,
        sign: ['QUEST MANAGER', 'SUNSPIRE CITADEL'],
      },
      race: {
        name: 'Kai Torres',
        persona: 'Quest Manager for the Vellum Ridge Circuit: a former race strategist who now runs the mission board in the paddock. Kai is fast-talking, data-driven, and has an opinion on every racing line on the circuit. They make every briefing feel like a pre-race countdown.',
        position: [30, 0.2, 20],
        yaw: -Math.PI / 4,
        sign: ['QUEST MANAGER', 'VELLUM CIRCUIT'],
      },
    };

    const spec = CAST[world.id];
    if (!spec) return;
    if (this._npcs.length >= this.maxNPCs) return;

    const raw = new THREE.Vector3(spec.position[0], spec.position[1], spec.position[2]);
    const pos = this._snapToGround(raw);
    if (!pos) return;

    const npc = this._createNPC({
      hostile: false,
      name: spec.name,
      persona: spec.persona,
      position: pos,
      yaw: spec.yaw,
      anchored: true,
      role: ROLE.QUEST_MANAGER,
      posture: 'crossed',
      signLines: spec.sign,
      isQuestManager: true,
    });
    npc.isQuestManager = true;
  }

  /**
   *
   * Hubs are derived from where the world already put its named civilians, so
   * the extra population lands in the plaza or the market square rather than in
   * a random field. Each group is a small ring facing a common centre - the
   * single cheapest thing that makes a space read as inhabited.
   *
   * @param {THREE.Vector3[]} anchors authored friendly positions
   * @param {number} budget how many more civilians we are allowed to add
   */
  _populateHubs(anchors, budget) {
    if (budget <= 0 || anchors.length === 0) return;
    const hubs = this._clusterHubs(anchors, 22);
    const names = CROWD_NAMES[this.theme] ?? CROWD_NAMES.station;
    const personas = CROWD_PERSONAS[this.theme] ?? CROWD_PERSONAS.station;
    let rnd = this._hashSeed(`${this.worldId}:crowd`) >>> 0;
    const next = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);

    let made = 0;
    let nameIdx = 0;
    let guard = 0;
    /** How many of each role have been handed out, so names do not repeat. */
    const roleCounts = new Map();
    // Round-robin over the hubs so no single plaza gets the whole crowd.
    while (made < budget && this._npcs.length < this.maxNPCs && guard++ < 60) {
      const hub = hubs[guard % hubs.length];
      const size = Math.min(budget - made, 2 + ((next() * 2) | 0));
      const angle = next() * Math.PI * 2;
      const radius = 3.5 + next() * 7;
      _v1.set(hub.x + Math.cos(angle) * radius, hub.y, hub.z + Math.sin(angle) * radius);
      const centre = this._snapToGround(_v1, new THREE.Vector3());
      if (Math.abs(centre.y - hub.y) > 4) continue;

      const ring = 0.85 + next() * 0.4;
      let placed = 0;
      for (let i = 0; i < size; i++) {
        const a = angle + (i / size) * Math.PI * 2 + next() * 0.4;
        _v2.set(centre.x + Math.cos(a) * ring, centre.y + 1.2, centre.z + Math.sin(a) * ring);
        const spot = this._findStandingSpot(_v2, centre.y);
        if (!spot) continue;
        // Face the middle of the group. Characters face -Z at yaw 0.
        _v3.subVectors(centre, spot);
        const yaw = Math.atan2(-_v3.x, -_v3.z);
        // Every filled slot gets a job. The rotation guarantees a vendor early
        // (the Marketplace needs one to open next to) and then spreads guards,
        // spectators and loiterers across the hubs.
        const role = ROLE_ROTATION[nameIdx % ROLE_ROTATION.length];
        const def = roleDef(role);
        const roleIdx = roleCounts.get(role) ?? 0;
        roleCounts.set(role, roleIdx + 1);
        const cast = castFor(this.theme, role, roleIdx);
        this._createNPC({
          hostile: false,
          name: cast?.name ?? names[nameIdx % names.length],
          persona: cast?.persona ?? personas[nameIdx % personas.length],
          position: spot,
          yaw,
          anchored: true,
          groupFocus: centre,
          role,
          posture: def.postures[(next() * def.postures.length) | 0],
        });
        nameIdx++;
        placed++;
        made++;
        if (made >= budget || this._npcs.length >= this.maxNPCs) break;
      }
      // A group of one is just a lonely person; give the hub another try.
      if (placed === 0) continue;
    }
  }

  /** Greedy spatial clustering of authored spawns into hub centres. */
  _clusterHubs(points, radius) {
    const hubs = [];
    const r2 = radius * radius;
    for (const p of points) {
      let hub = null;
      for (const h of hubs) {
        if (h.distanceToSquared(p) < r2) {
          hub = h;
          break;
        }
      }
      if (hub) hub.lerp(p, 0.5);
      else hubs.push(p.clone());
    }
    return hubs;
  }

  /**
   * Validate a spot for a standing civilian: real ground at roughly the right
   * height, no wall in their face, and nobody already standing there.
   *
   * @returns {THREE.Vector3|null}
   */
  _findStandingSpot(probe, expectedY) {
    // Resolve against the whole surface stack rather than "first thing below
    // the probe": that is what stops a civilian being filed onto the roof of
    // the building they were meant to be standing beside.
    const g = resolveSurfaceY(this.physics, probe.x, probe.z, expectedY);
    if (g === null || Math.abs(g - expectedY) > 1.2) return null;
    const spot = new THREE.Vector3(probe.x, g, probe.z);
    for (const npc of this._npcs) {
      if (npc.position.distanceToSquared(spot) < 0.85 * 0.85) return null;
    }
    // Four cardinal probes at chest height: a spot boxed in by geometry is a
    // spot the character would immediately shove itself out of.
    _capA.set(spot.x, spot.y + 1.1, spot.z);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      _capB.set(Math.cos(a), 0, Math.sin(a));
      const hit = this.physics.raycast(_capA, _capB, 0.62, COLLISION_LAYER.WORLD);
      if (hit) return null;
    }
    return spot;
  }

  _hostileVariant() {
    if (this.theme === 'medieval') return 'mail';
    if (this.theme === 'sports') return 'track';
    return 'eva';
  }

  _hashSeed(str) {
    let h = 2166136261;
    for (let i = 0; i < (str?.length ?? 0); i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  /**
   * Resolve an authored spawn onto the real surface.
   *
   * Two passes, and the order matters. A short probe starting just above the
   * authored height wins first so a character authored under a bridge, a
   * rampart or a gantry stays on the deck the author meant. Only when that
   * finds nothing does the guaranteed top-down search run - that one always
   * returns a number, so a spawn can never be left hanging in the air.
   *
   * @param {THREE.Vector3} p authored spawn point
   * @param {THREE.Vector3} [out]
   */
  _snapToGround(p, out) {
    if (!p) return null;
    const v = out ?? new THREE.Vector3();
    const spot = resolveSpot(this.physics, p, v);
    if (spot) {
      // A spawn resolved into the river is a character that starts its life
      // underwater and has no way out - steering can only stop them walking
      // *in*. Walk them to the nearest bank before anyone sees them.
      if (this.water && isDeepWater(this.physics, this.water, spot.x, spot.z)) {
        const dry = nearestDrySpot(this.physics, this.water, spot, _dryScratch);
        if (dry) return v.copy(dry);
      }
      return spot;
    }
    // Nothing standable anywhere near: keep the authored height rather than
    // returning null, so a world that authors a spawn over a gap still gets a
    // character (the runtime watchdog will pull them onto a surface).
    return v.set(p.x, p.y, p.z);
  }

  clear() {
    for (const npc of this._npcs) {
      this.bus?.emit('npc:despawned', { npc });
      npc.root.removeFromParent();
      npc.dispose();
    }
    if (this._contact) this._contact.count = 0;
    this._npcs.length = 0;
    this._hostiles.length = 0;
    this._friendlies.length = 0;
    this._vendors.length = 0;
    this._respawnQueue.length = 0;
    this._groundCursor = 0;
    if (this._chatNPC) {
      this._chatNPC = null;
      this.bus?.emit('chat:available', { npc: null });
    }
  }

  get chatNpc() {
    return this._chatNPC;
  }

  /* ---------------------------------------------------------------- */
  /* Frame loops                                                       */
  /* ---------------------------------------------------------------- */

  fixedUpdate(dt, elapsed) {
    if (elapsed < this._pauseUntil) return;
    this._coverToken = 0;
    for (const npc of this._npcs) npc.fixedUpdate(dt, elapsed);
    this._separateBodies();
    this._updateRespawns(dt);
    this._updateChatProximity();
    this._updateGroundingWatchdog();
  }

  /**
   * Pull interpenetrating characters apart.
   *
   * This is a positional constraint, not a steering force, and that distinction
   * is the whole point: it writes `position` and never touches `velocity`, so
   * nothing it does can feed back into `Navigation` and start a ping-pong. It
   * converges in a handful of steps and then stops applying at all.
   *
   * It is also the thing that stops overlapping characters z-fighting. Two
   * NPCs built from the same archetype share their geometry, so at the same
   * transform their triangles are exactly coincident and the depth test picks a
   * winner per-pixel per-frame - which is precisely the "NPCs flicker when they
   * walk together" the player reported.
   *
   * Twenty-six characters is 325 pairs of two multiplies and a compare; it does
   * not register against the fixed step.
   *
   * Skipped for the dead (a corpse is scenery and pushing it looks like it is
   * being dragged) and for the seated (they are pinned to furniture by
   * `_integrateSeated`, and shoving one sideways would slide it off its bench).
   */
  _separateBodies() {
    const list = this._npcs;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (a.isDead || a.seat) continue;
      const ap = a.position;
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (b.isDead || b.seat) continue;
        const bp = b.position;
        if (Math.abs(bp.y - ap.y) > SEPARATION_MAX_RISE) continue;
        let dx = bp.x - ap.x;
        let dz = bp.z - ap.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= PERSONAL_SPACE_SQ) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-4) {
          // Exactly coincident, so there is no direction to separate along.
          // Derive one from the pair's indices: it has to be deterministic
          // (random would make the pair jitter) and it has to differ per pair,
          // or a stack of three would push every pair the same way and stay a
          // stack.
          const a2 = (((i * 73856093) ^ (j * 19349663)) >>> 0) % 6283;
          dx = Math.cos(a2 * 0.001);
          dz = Math.sin(a2 * 0.001);
          d = 0;
        } else {
          dx /= d;
          dz /= d;
        }
        let push = (PERSONAL_SPACE - d) * 0.5 * SEPARATION_RELAX;
        if (push > SEPARATION_MAX_STEP) push = SEPARATION_MAX_STEP;
        ap.x -= dx * push;
        ap.z -= dz * push;
        bp.x += dx * push;
        bp.z += dz * push;
      }
    }
  }

  /**
   * Re-audit one character's footing per fixed step.
   *
   * The per-character ground probe is a short ray under the feet and cannot see
   * its way out of a mesh a character has somehow ended up inside. This is the
   * backstop: it walks the full surface stack at the character's column and
   * lifts anyone who has sunk. One NPC per step sweeps the whole world in under
   * half a second and costs a handful of rays.
   */
  _updateGroundingWatchdog() {
    const n = this._npcs.length;
    if (n === 0) return;
    this._groundCursor = (this._groundCursor + 1) % n;
    const npc = this._npcs[this._groundCursor];
    if (!npc) return;
    // Water first: pulling someone out of the river moves them, and the
    // grounding audit should then run against where they ended up rather than
    // against the riverbed they just left.
    if (this._auditWater(npc)) {
      this._groundFixes++;
      return;
    }
    if (npc.auditGrounding()) this._groundFixes++;
  }

  update(dt, elapsed) {
    if (elapsed < this._pauseUntil) return;
    this._updateLOD();
    for (const npc of this._npcs) npc.update(dt, elapsed);
    this._updateContactShadows();
  }

  pauseFor(seconds) {
    if (!(seconds > 0)) return false;
    const elapsed = this.engine?.elapsed ?? 0;
    this._pauseUntil = Math.max(this._pauseUntil, elapsed + seconds);
    return true;
  }

  /**
   * Place one AO decal per visible character on the surface it is standing on.
   *
   * The directional shadow cascade covers 120 m on a 2048 map, which is roughly
   * 6 cm per texel at character scale - it cannot resolve where a boot meets a
   * deck, so without this every NPC reads as pasted on top of the floor rather
   * than standing in it. The decal is snapped to the *sampled ground height*,
   * not the root, so it stays put on stairs and ramps instead of floating
   * whenever a character is mid-step.
   */
  _updateContactShadows() {
    const inst = this._contact;
    const pos = this._contactPos;
    let n = 0;
    for (const npc of this._npcs) {
      if (n >= this.maxNPCs) break;
      if (!npc.root.visible || npc.lod.distance > 70) continue;
      // Corpses have collapsed away from their root; anchor to the pelvis.
      const y = npc.groundY ?? npc.position.y;
      if (Math.abs(npc.position.y - y) > 0.9) continue; // airborne: no contact
      pos.set(npc.position.x, y + 0.012, npc.position.z);
      // Fades out as a character leaves the ground, so a jump lifts its shadow.
      const lift = 1 - Math.min(1, Math.max(0, npc.position.y - y) / 0.6);
      // 0.5 x height put a 0.66 m disc under a 1.75 m figure, and with the old
      // alpha ramp on a bright deck that was below the threshold where the eye
      // registers ground contact at all - every review read the characters as
      // floating. A standing adult occludes roughly a metre of floor.
      const s = npc.height * 0.62 * (0.78 + 0.22 * lift);
      this._contactScale.set(s, 1, s);
      this._contactMat.compose(pos, this._contactQuat, this._contactScale);
      inst.setMatrixAt(n++, this._contactMat);
    }
    inst.count = n;
    if (n > 0) inst.instanceMatrix.needsUpdate = true;
  }

  /**
   * Distance and frustum driven animation budget. Characters far away animate
   * at a fraction of the frame rate, lose foot IK, and lose eye detail; ones
   * off screen coast on their state machine alone.
   */
  _updateLOD() {
    const cam = this.engine?.camera;
    if (cam) {
      cam.updateMatrixWorld();
      _projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_projScreen);
    }
    const eye = cam ? _v3.setFromMatrixPosition(cam.matrixWorld) : this.player?.position ?? _v3.set(0, 0, 0);

    for (const npc of this._npcs) {
      const lod = npc.lod;
      const d = npc.position.distanceTo(eye);
      lod.distance = d;
      if (cam) {
        _sphere.center.copy(npc.position);
        _sphere.center.y += npc.height * 0.5;
        // Spatial hysteresis: a character that is already on screen is tested
        // against a fatter sphere than one that is not, so a body grazing the
        // frame edge has to properly leave before it is culled. Without the
        // margin `visible` chatters, and since `detail` is gated on it, the eye
        // meshes chattered with it.
        _sphere.radius = npc.height * (lod.visible ? 0.95 : 0.75);
        lod.visible = _frustum.intersectsSphere(_sphere);
      } else {
        lod.visible = true;
      }
      // A bigger crowd has to pay for itself, but 9 m was far too aggressive:
      // an NPC filling a third of the frame at 12 m had its eyes and lids culled
      // outright and presented a blank mannequin head. Eyes are six small meshes
      // on a bone - they stay on out to ~25 m, which is well past the range
      // where a face is still resolvable. Foot IK stops around 22 m, and
      // anything past ~130 m is not drawn at all rather than merely animated
      // slowly.
      //
      // Every one of those switches is now a band rather than a line. A single
      // boundary turns any distance jitter - a neighbour nudging the character,
      // a stride's worth of pelvis travel - into a per-frame on/off toggle,
      // which is visible as flicker precisely when characters are crowded
      // together and jostling.
      lod.detail = lod.visible && (lod.detail ? d < DETAIL_OUT : d < DETAIL_IN);
      lod.ik = lod.ik ? d < IK_OUT : d < IK_IN;
      lod.rate = !lod.visible ? 0.12 : d < 16 ? 1 : d < 34 ? 0.5 : d < 65 ? 0.25 : 0.1;
      const render = npc.root.visible ? d < RENDER_OUT : d < RENDER_IN;
      if (npc.root.visible !== render && !npc.animator.sunk) npc.root.visible = render;
    }
  }

  _updateRespawns(dt) {
    for (const npc of this._hostiles) {
      if (!npc.isDead) continue;
      if (npc._respawnAt == null) {
        npc._respawnAt = CONFIG.npc.respawnDelay;
        // Sink starts late so the corpse is readable for a while first.
        npc._sinkAt = Math.max(4, CONFIG.npc.respawnDelay - 4);
      }
      npc._respawnAt -= dt;
      npc._sinkAt -= dt;
      if (npc._sinkAt <= 0) npc.animator.beginSink();
      if (npc._respawnAt <= 0 && npc.animator.sunk) {
        const spot = this._pickRespawnPoint(npc);
        npc.respawn(spot);
        npc._respawnAt = null;
        this.bus?.emit('npc:spawned', { npc });
      }
    }
  }

  /** Prefer the NPC's own spawn, but never in the player's face. */
  _pickRespawnPoint(npc) {
    const player = this.player;
    const candidates = [npc.spawnPoint, ...npc.patrol];
    let best = npc.spawnPoint;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const d = player ? c.distanceTo(player.position) : 100;
      const score = d > 30 ? d : d - 200;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const snapped = this._snapToGround(best);
    return snapped ?? best;
  }

  _updateChatProximity() {
    const player = this.player;
    if (!player) return;
    const npc = this.nearestFriendly(player.position, CONFIG.npc.chatRange);
    if (npc === this._chatNPC) return;
    this._chatNPC = npc;
    this.bus?.emit('chat:available', { npc: npc ?? null });
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /** @returns {import('./NPC.js').NPC|null} */
  nearestFriendly(position, maxRange = 6) {
    let best = null;
    let bestSq = maxRange * maxRange;
    for (const npc of this._friendlies) {
      // Every friendly is a chat target - stationary, seated, vendor or
      // wanderer alike. The flag exists so a hostile can never become one.
      if (npc.isDead || npc.conversational === false) continue;
      const d = npc.position.distanceToSquared(position);
      if (d < bestSq) {
        bestSq = d;
        best = npc;
      }
    }
    return best;
  }

  /**
   * Hit query for the combat system. Each NPC is a vertical capsule with a
   * separate head sphere; the nearest of the two decides whether the hit is a
   * headshot, and the nearest NPC overall wins.
   *
   * @returns {{npc:any, point:THREE.Vector3, distance:number, isHeadshot:boolean}|null}
   */
  raycastNPCs(origin, direction, maxDistance = 300) {
    let best = null;
    let bestDist = maxDistance;
    for (const npc of this._npcs) {
      if (npc.isDead) continue;
      // Cheap reject: bounding sphere around the whole character.
      _v3.copy(npc.position);
      _v3.y += npc.height * 0.5;
      const toC = _v3.sub(origin);
      const along = toC.dot(direction);
      if (along < -npc.height || along > bestDist + npc.height) continue;
      if (toC.lengthSq() - along * along > (npc.height * 0.75) ** 2) continue;

      const feet = npc.position;
      const r = npc.radius * 0.86;
      _capA.set(feet.x, feet.y + r, feet.z);
      _capB.set(feet.x, feet.y + npc.height * 0.86 - r, feet.z);
      const body = raySegment(origin, direction, _capA, _capB, r, bestDist);

      const head = npc.headPosition;
      const headR = 0.135 * npc.humanoid.heightScale;
      const headHit = raySphere(origin, direction, head, headR, bestDist);

      let t = -1;
      let isHead = false;
      if (headHit >= 0 && (body < 0 || headHit <= body)) {
        t = headHit;
        isHead = true;
      } else if (body >= 0) {
        t = body;
      }
      if (t < 0 || t >= bestDist) continue;
      bestDist = t;
      best = best ?? { npc: null, point: new THREE.Vector3(), distance: 0, isHeadshot: false };
      best.npc = npc;
      best.distance = t;
      best.isHeadshot = isHead;
      best.point.copy(origin).addScaledVector(direction, t);
    }
    return best;
  }

  /** Nearest hostile with line of sight, for HUD threat markers and AI. */
  nearestHostile(position, maxRange = 60) {
    let best = null;
    let bestSq = maxRange * maxRange;
    for (const npc of this._hostiles) {
      if (npc.isDead) continue;
      const d = npc.position.distanceToSquared(position);
      if (d < bestSq) {
        bestSq = d;
        best = npc;
      }
    }
    return best;
  }

  /* ---------------------------------------------------------------- */
  /* Coordination                                                      */
  /* ---------------------------------------------------------------- */

  /** Tell nearby hostiles where the player is. */
  propagateAlert(source, radius = 24) {
    const at = source.hasLastKnown ? source.lastKnownTarget : this.player?.position;
    if (!at) return;
    const r2 = radius * radius;
    for (const npc of this._hostiles) {
      if (npc === source || npc.isDead) continue;
      if (npc.position.distanceToSquared(source.position) > r2) continue;
      npc.alert(at, false);
    }
  }

  /** Rate-limit the cover search to one NPC per fixed step. */
  requestCoverSlot() {
    if (this._coverToken > 0) return false;
    this._coverToken++;
    return true;
  }

  /** Pair up idle friendlies that are standing near each other. */
  findSocialPartner(npc, radius) {
    const r2 = radius * radius;
    let best = null;
    let bestSq = r2;
    for (const other of this._friendlies) {
      if (other === npc || other.isDead) continue;
      // Group members hold their formation; they do not walk off to chat.
      if (other.anchored) continue;
      if (other.socialPartner && other.socialPartner !== npc) continue;
      if (other.state === 'FLEE' || other.state === 'GREET') continue;
      const d = other.position.distanceToSquared(npc.position);
      if (d < bestSq && d > 1.2) {
        bestSq = d;
        best = other;
      }
    }
    if (best) best.socialPartner = npc;
    return best;
  }

  /**
   * A hostile pulled the trigger. Emits `npc:fire` for the combat system to
   * turn into tracers and damage. If nothing is listening we resolve the shot
   * here so the AI is never toothless.
   */
  npcFire(npc, origin, direction, damage, weaponId) {
    const player = this.player;
    const id = weaponId ?? npc?.weaponId ?? 'rifle';
    // Health before and after: `bus.emit` is synchronous, so whatever resolves
    // the shot - CombatSystem, or the fallback below - has finished by the time
    // we read it again. That is how `npc:attack` reports what actually landed
    // rather than what was merely fired, which is what the HUD needs to answer
    // "what just hit me".
    const before = Number.isFinite(player?.health) ? player.health : null;

    const payload = { npc, origin, direction, damage, weaponId: id, spread: 1 - npc.accuracy };
    const handlers = this.bus?._handlers?.get('npc:fire');
    this.bus?.emit('npc:fire', payload);
    this._onGunfire(origin, 0.8);

    const resolvedElsewhere = handlers && handlers.size > 0;
    if (!resolvedElsewhere && this._selfResolveFire && player && !player.isDead) {
      // Fallback resolution: nearest of world geometry and the player.
      const range = (npc?.weaponDef?.range ?? CONFIG.npc.attackRange) + 12;
      const wall = this.physics.raycast(origin, direction, range, COLLISION_LAYER.WORLD);
      const pp = player.position;
      _capA.set(pp.x, pp.y + CONFIG.player.radius, pp.z);
      _capB.set(pp.x, pp.y + CONFIG.player.height - CONFIG.player.radius, pp.z);
      const hit = raySegment(origin, direction, _capA, _capB, CONFIG.player.radius, range);
      if (hit >= 0 && !(wall && wall.distance < hit)) {
        player.applyDamage?.(damage, origin, npc.id);
      }
    }

    const after = Number.isFinite(player?.health) ? player.health : null;
    if (before !== null && after !== null && after < before - 1e-4) {
      this.bus?.emit('npc:attack', { npc, weaponId: id, damage: before - after });
    }
  }

  /** Friendlies scatter from gunfire wherever it comes from. */
  _onGunfire(origin, intensity) {
    for (const npc of this._friendlies) npc.onGunfire?.(origin, intensity);
    for (const npc of this._hostiles) {
      if (!npc.isDead && origin && npc.position.distanceToSquared(origin) < 40 * 40) {
        npc.alert(origin, false);
      }
    }
  }

  dispose() {
    this.clear();
    this._contact.removeFromParent();
    this._contact.dispose();
    this.factory.dispose();
    this.assets.dispose();
  }
}
