import * as THREE from 'three';
import { CONFIG } from '../core/Config.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { CharacterAssets, HumanoidFactory } from './Humanoid.js';
import { FriendlyNPC } from './FriendlyNPC.js';
import { HostileNPC } from './HostileNPC.js';

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
const _capA = new THREE.Vector3();
const _capB = new THREE.Vector3();
// raySegment owns these exclusively - callers must not pass them in.
const _seg = new THREE.Vector3();
const _rsA = new THREE.Vector3();
const _rsB = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _projScreen = new THREE.Matrix4();

const THEME_BY_WORLD = { station: 'station', medieval: 'medieval', sports: 'sports' };

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

    /** Hard ceiling regardless of what a world asks for. */
    this.maxNPCs = 26;
    this.maxHostiles = CONFIG.npc.hostileCount;
    // Worlds only author a handful of named civilians. A plaza needs a crowd,
    // so the manager tops the friendly population up itself (see _populateHubs)
    // and this is the ceiling for the result.
    this.maxFriendlies = Math.max(CONFIG.npc.friendlyCount, 14);

    this._chatNPC = null;
    this._coverToken = 0;
    this._lodCursor = 0;
    this._seedCounter = 1;

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
      });
      npc.spawnSpec = spec;
      if (hostile) hostileCount++;
      else {
        friendlyCount++;
        anchors.push(pos);
      }
    }

    this._populateHubs(anchors, this.maxFriendlies - friendlyCount);
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
    };
    const npc = o.hostile ? new HostileNPC(ctx) : new FriendlyNPC(ctx);
    if (o.posture) npc.fixedPosture = true;
    this._npcs.push(npc);
    if (o.hostile) this._hostiles.push(npc);
    else this._friendlies.push(npc);
    this.bus?.emit('npc:spawned', { npc });
    return npc;
  }

  /**
   * Fill the social hubs with standing groups.
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
        this._createNPC({
          hostile: false,
          name: names[nameIdx % names.length],
          persona: personas[nameIdx % personas.length],
          position: spot,
          yaw,
          anchored: true,
          groupFocus: centre,
          posture: GROUP_POSTURES[(next() * GROUP_POSTURES.length) | 0],
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
    const g = this.physics.groundHeight(probe.x, probe.z, probe.y + 1.5, 6);
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
    const local = this.physics.groundHeight(p.x, p.z, p.y + 2, 8);
    const y = local !== null ? local : this.physics.groundHeightOrFallback(p.x, p.z, p.y);
    return v.set(p.x, y, p.z);
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
    this._respawnQueue.length = 0;
    if (this._chatNPC) {
      this._chatNPC = null;
      this.bus?.emit('chat:available', { npc: null });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Frame loops                                                       */
  /* ---------------------------------------------------------------- */

  fixedUpdate(dt, elapsed) {
    this._coverToken = 0;
    for (const npc of this._npcs) npc.fixedUpdate(dt, elapsed);
    this._updateRespawns(dt);
    this._updateChatProximity();
  }

  update(dt, elapsed) {
    this._updateLOD();
    for (const npc of this._npcs) npc.update(dt, elapsed);
    this._updateContactShadows();
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
        _sphere.radius = npc.height * 0.75;
        lod.visible = _frustum.intersectsSphere(_sphere);
      } else {
        lod.visible = true;
      }
      // A bigger crowd has to pay for itself, but 9 m was far too aggressive:
      // an NPC filling a third of the frame at 12 m had its eyes and lids culled
      // outright and presented a blank mannequin head. Eyes are six small meshes
      // on a bone - they stay on out to 25 m, which is well past the range where
      // a face is still resolvable. Foot IK stops at 22 m, and anything past
      // 130 m is not drawn at all rather than merely animated slowly.
      lod.detail = lod.visible && d < 25;
      lod.ik = d < 22;
      lod.rate = !lod.visible ? 0.12 : d < 16 ? 1 : d < 34 ? 0.5 : d < 65 ? 0.25 : 0.1;
      const render = d < 130;
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
      if (npc.isDead) continue;
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
  npcFire(npc, origin, direction, damage) {
    const payload = { npc, origin, direction, damage, spread: 1 - npc.accuracy };
    const handlers = this.bus?._handlers?.get('npc:fire');
    this.bus?.emit('npc:fire', payload);
    this._onGunfire(origin, 0.8);
    if (handlers && handlers.size > 0) return;
    if (!this._selfResolveFire) return;

    // Fallback resolution: nearest of world geometry and the player.
    const player = this.player;
    if (!player || player.isDead) return;
    const range = CONFIG.npc.attackRange + 12;
    const wall = this.physics.raycast(origin, direction, range, COLLISION_LAYER.WORLD);
    const pp = player.position;
    _capA.set(pp.x, pp.y + CONFIG.player.radius, pp.z);
    _capB.set(pp.x, pp.y + CONFIG.player.height - CONFIG.player.radius, pp.z);
    const hit = raySegment(origin, direction, _capA, _capB, CONFIG.player.radius, range);
    if (hit < 0) return;
    if (wall && wall.distance < hit) return;
    player.applyDamage?.(damage, origin, npc.id);
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
