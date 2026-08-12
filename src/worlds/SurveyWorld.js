import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';

/**
 * SURVEY SITE 06 - the sixth gateway's destination.
 *
 * ── What this is, and what it is deliberately not ────────────────────────
 * The station's plaza now carries six evenly-spaced gateways because the brief
 * asked for "an equal space to hold all 6 portal gateways", and the sixth was
 * to be FULLY LIVE rather than sealed or deferred. A live gateway needs
 * somewhere to arrive. This is that somewhere, and it is written to be replaced.
 *
 * The honest failure mode for a placeholder is not "too small", it is "not
 * actually a world": no floor under your feet, no way back, a spawn inside
 * geometry, a bottomless edge. So this is small on purpose and complete on
 * purpose. A survey pad with a collided deck, a barrier you cannot walk off, a
 * datum, a return gateway, and enough signage that a player who arrives knows
 * within one second that they have found a site under survey rather than a
 * broken level.
 *
 * That last part is the design. Everything here reads as *instrumentation* -
 * setting-out grid, numbered stakes, a levelling staff, hoardings - because a
 * surveyed but uncommissioned site is a thing that genuinely looks like this,
 * and a placeholder that is diegetically a placeholder does not need an
 * apology in a loading screen. When the real world lands, the pad and its
 * hoardings are what gets deleted, not worked around.
 *
 * ── Why the capability rules are mostly off ──────────────────────────────
 * `WorldRules` defaults everything to permitted, which is right for a world
 * that was authored before rules existed and wrong for one authored after. A
 * site that has not been commissioned has no economy, no garrison, no
 * standing contracts and nothing worth collecting; leaving those on would fill
 * a 72 m square with traders and relic spawns and make it read as a real world
 * that had been done badly, which is the one impression it must not give.
 * `makeRules` throws on an unknown key, so the list below is checked rather
 * than hoped for.
 */

/** Half-width of the pad. Square, not hexagonal, so the drawn deck and the box
 *  collider are the same shape - there is no corner of walkable void outside
 *  the geometry and no invisible floor beyond it. */
const PAD = 36;
/** Top of the deck. Everything stands on this. */
const DECK_Y = 0;
const DECK_T = 1.2;
/** Setting-out grid pitch. Also the stake spacing. */
const GRID = 6;
/** Where the gateway home stands. */
const PORTAL_Z = 28;

export class SurveyWorld extends World {
  static id = 'survey';
  static displayName = 'Survey Site 06';

  constructor(ctx) {
    super(ctx);

    this.rules = makeRules({
      // Nothing to buy, no one to buy it from, nothing to be sent to do.
      merchants: false,
      quests: false,
      contracts: false,
      // Nothing has been placed here to be found. An empty cache is worse than
      // no cache: it teaches the player that searching this world is pointless
      // rather than that there is nothing here yet.
      caches: false,
      relics: false,
      loot: false,
      // No circuit has been surveyed, let alone built.
      races: false,
      // The hoardings and the instrument hut are solid props, not interiors.
      interiors: false,
      // An uncommissioned site has no garrison and nothing worth defending.
      hostiles: false,
      /* No crowd filling. The manager tops a world's population up to a target
       * and adds a lorekeeper per portal on its own initiative; a survey site
       * with a plaza's worth of civilians milling on it would read as a
       * populated world with no buildings. The one surveyor below is the whole
       * cast, and she is authored, so `spawnForWorld` still places her. */
      crowd: false,
    });

    /* Mounts, climbing, parkour, jumping and weapons are left permitted. Each
     * of those is a property of the PLAYER rather than of the world, and
     * switching them off here would mean a player's own movement worked
     * differently in one world for no reason they could see. The barrier is
     * what keeps them on the pad, not a revoked capability. */

    this.bounds = new THREE.Box3(
      new THREE.Vector3(-PAD - 24, -20, -PAD - 24),
      new THREE.Vector3(PAD + 24, 90, PAD + 24)
    );

    this.environment = {
      ...this.environment,
      // Survey lighting: a cold, flat, overcast field. Nothing here has been
      // art-directed yet and pretending otherwise with a hero sunset would
      // make the pad look finished.
      background: new THREE.Color(0x0b1016),
      fogColor: new THREE.Color(0x0e1520),
      fogNear: 60,
      fogFar: 260,
      exposure: 1.0,
      ambientColor: new THREE.Color(0x53637a),
      ambientIntensity: 0.85,
      sunColor: new THREE.Color(0xdfe9f5),
      sunIntensity: 1.5,
      sunDirection: new THREE.Vector3(-0.35, 0.86, 0.36).normalize(),
      envMapIntensity: 0.8,
      bloom: null,
    };

    this._mats = [];
  }

  /** Track a material so `dispose()` on the base class is not the only thing
   *  holding them - the base traverses geometry and mesh materials, and the
   *  canvas textures below are owned by materials that are shared between
   *  merged meshes. */
  _mat(m) {
    this._mats.push(m);
    return m;
  }

  async build(onProgress) {
    onProgress?.(0.05, 'Setting out the survey grid');

    const M = {
      deck: this._mat(new THREE.MeshStandardMaterial({ color: 0x39424c, roughness: 0.95, metalness: 0.05 })),
      kerb: this._mat(new THREE.MeshStandardMaterial({ color: 0x5a636d, roughness: 0.85, metalness: 0.1 })),
      steel: this._mat(new THREE.MeshStandardMaterial({ color: 0x8d98a4, roughness: 0.5, metalness: 0.8 })),
      hazard: this._mat(new THREE.MeshStandardMaterial({ color: 0xd8a33a, roughness: 0.7, metalness: 0.15 })),
      timber: this._mat(new THREE.MeshStandardMaterial({ color: 0x9a7b4f, roughness: 0.9, metalness: 0 })),
      grid: this._mat(new THREE.MeshStandardMaterial({
        color: 0x0a0e12,
        emissive: new THREE.Color(0x6fd6ff),
        emissiveIntensity: 0.9,
        roughness: 0.6,
      })),
      /* The gateway hue from the station's table, so the door you came through
       * and the door you go back through are the same colour on both sides. */
      accent: this._mat(new THREE.MeshStandardMaterial({
        color: 0x0a0e12,
        emissive: new THREE.Color(0x9fb8c8),
        emissiveIntensity: 2.2,
        roughness: 0.4,
      })),
    };

    this._buildDeck(M);
    onProgress?.(0.4, 'Driving the marker stakes');
    this._buildInstruments(M);
    onProgress?.(0.75, 'Raising the site hoardings');
    this._buildSignage(M);
    this._fillSpawns();
    onProgress?.(1, 'Survey site ready');
  }

  /* ---------------------------------------------------------------- */
  /* The pad                                                           */
  /* ---------------------------------------------------------------- */

  _buildDeck(M) {
    const g = new THREE.Group();
    g.name = 'survey:pad';
    this.group.add(g);

    // Deck slab. Drawn and collided as the same box, so its edge is exactly
    // where it looks.
    const slab = new THREE.Mesh(new THREE.BoxGeometry(PAD * 2, DECK_T, PAD * 2), M.deck);
    slab.position.set(0, DECK_Y - DECK_T / 2, 0);
    slab.receiveShadow = true;
    slab.castShadow = false;
    g.add(slab);
    this.track(this.physics.addBox(0, DECK_Y - DECK_T / 2, 0, PAD, DECK_T / 2, PAD));

    /* Setting-out grid. Chainage lines every 6 m in both directions, which is
     * what a site looks like before anything is built on it and also, usefully,
     * a legible scale reference - a player can count squares and know how big
     * the pad is. Merged into one mesh: 24 lines is 24 draw calls otherwise. */
    const lines = [];
    for (let i = -PAD / GRID; i <= PAD / GRID; i++) {
      const p = i * GRID;
      const major = i % 3 === 0;
      const w = major ? 0.22 : 0.1;
      for (const axis of [0, 1]) {
        const geo = new THREE.BoxGeometry(
          axis ? PAD * 2 : w, 0.03, axis ? w : PAD * 2
        );
        geo.translate(axis ? 0 : p, DECK_Y + 0.015, axis ? p : 0);
        lines.push(geo);
      }
    }
    const grid = new THREE.Mesh(mergeGeometries(lines, false), M.grid);
    for (const l of lines) l.dispose();
    grid.castShadow = false;
    grid.receiveShadow = false;
    g.add(grid);

    /* Edge barrier. This is the whole reason the pad is not "a floating slab
     * you fall off": four solid runs and four corner posts, drawn and collided,
     * 1.3 m high. A player who walks to the edge is stopped by the thing they
     * can see stopping them. */
    const rails = [];
    const posts = [];
    for (const s of [-1, 1]) {
      for (const axis of [0, 1]) {
        const cx = axis ? 0 : s * PAD;
        const cz = axis ? s * PAD : 0;
        const hx = axis ? PAD : 0.16;
        const hz = axis ? 0.16 : PAD;
        const geo = new THREE.BoxGeometry(hx * 2, 1.3, hz * 2);
        geo.translate(cx, DECK_Y + 0.65, cz);
        rails.push(geo);
        this.track(this.physics.addBox(cx, DECK_Y + 0.65, cz, hx, 0.65, hz));
        // Hazard band along the top of the run.
        const band = new THREE.BoxGeometry(
          axis ? PAD * 2 : 0.36, 0.14, axis ? 0.36 : PAD * 2
        );
        band.translate(cx, DECK_Y + 1.34, cz);
        posts.push(band);
      }
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const geo = new THREE.BoxGeometry(0.5, 1.7, 0.5);
        geo.translate(sx * PAD, DECK_Y + 0.85, sz * PAD);
        rails.push(geo);
        this.track(this.physics.addBox(sx * PAD, DECK_Y + 0.85, sz * PAD, 0.25, 0.85, 0.25));
      }
    }
    const rail = new THREE.Mesh(mergeGeometries(rails, false), M.kerb);
    rail.castShadow = true;
    rail.receiveShadow = true;
    g.add(rail);
    for (const r of rails) r.dispose();
    const bands = new THREE.Mesh(mergeGeometries(posts, false), M.hazard);
    bands.castShadow = false;
    bands.receiveShadow = true;
    g.add(bands);
    for (const p of posts) p.dispose();
  }

  /* ---------------------------------------------------------------- */
  /* Instruments and stakes                                            */
  /* ---------------------------------------------------------------- */

  _buildInstruments(M) {
    const g = new THREE.Group();
    g.name = 'survey:instruments';
    this.group.add(g);

    /* The datum. A survey pillar with a brass benchmark on top: the point every
     * other measurement on a site is referred to, and the one piece of this
     * world that would survive into the real one. It stands at the origin
     * because that is what a datum is. */
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 1.25, 12), M.kerb);
    pillar.position.set(0, DECK_Y + 0.625, 0);
    pillar.castShadow = pillar.receiveShadow = true;
    g.add(pillar);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.09, 12), M.hazard);
    plate.position.set(0, DECK_Y + 1.29, 0);
    plate.castShadow = true;
    g.add(plate);
    this.track(this.physics.addBox(0, DECK_Y + 0.65, 0, 0.75, 0.65, 0.75));

    /* Marker stakes on the grid intersections, skipping the middle of the pad
     * so there is somewhere to walk and somewhere to stand at the datum.
     * Instanced - there are eighty of them and they are one box each. */
    const stakeEntries = [];
    const flagEntries = [];
    for (let i = -PAD / GRID; i <= PAD / GRID; i++) {
      for (let j = -PAD / GRID; j <= PAD / GRID; j++) {
        const x = i * GRID, z = j * GRID;
        const r = Math.hypot(x, z);
        if (r < GRID * 1.5 || r > PAD - 1) continue;
        // Keep the gateway's standing room and the hoarding's footprint clear.
        if (Math.hypot(x, z - PORTAL_Z) < 7) continue;
        if (Math.abs(x) < 8 && Math.abs(z - (PORTAL_Z - 15)) < 2.5) continue;
        stakeEntries.push([x, z]);
        flagEntries.push([x, z]);
      }
    }
    const stakeGeo = new THREE.BoxGeometry(0.09, 1.1, 0.09);
    const stakes = new THREE.InstancedMesh(stakeGeo, M.timber, stakeEntries.length);
    const flagGeo = new THREE.BoxGeometry(0.3, 0.22, 0.03);
    const flags = new THREE.InstancedMesh(flagGeo, M.hazard, flagEntries.length);
    const dummy = new THREE.Object3D();
    for (let k = 0; k < stakeEntries.length; k++) {
      const [x, z] = stakeEntries[k];
      dummy.position.set(x, DECK_Y + 0.55, z);
      dummy.rotation.set(0, (k % 7) * 0.31, 0);
      dummy.updateMatrix();
      stakes.setMatrixAt(k, dummy.matrix);
      dummy.position.set(x + 0.16, DECK_Y + 1.0, z);
      dummy.updateMatrix();
      flags.setMatrixAt(k, dummy.matrix);
    }
    stakes.castShadow = true;
    stakes.receiveShadow = false;
    flags.castShadow = false;
    g.add(stakes, flags);
    /* Stakes are deliberately NOT collided. They are 9 cm of timber standing
     * 55 cm proud, i.e. exactly the sort of thing the station's own
     * `_solidifyProps` skips on purpose, and eighty colliders to stub a toe on
     * would make the pad annoying to cross for no gain. */

    // Two levelling instruments on tripods, sighted at the datum.
    for (const [tx, tz] of [[-16, 12], [19, -14]]) {
      const legs = [];
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2 + Math.atan2(-tz, -tx);
        const leg = new THREE.BoxGeometry(0.07, 1.55, 0.07);
        leg.translate(Math.cos(a) * 0.34, DECK_Y + 0.77, Math.sin(a) * 0.34);
        legs.push(leg);
      }
      const tripod = new THREE.Mesh(mergeGeometries(legs, false), M.steel);
      tripod.position.set(tx, 0, tz);
      tripod.castShadow = true;
      g.add(tripod);
      for (const l of legs) l.dispose();
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.3, 0.62), M.steel);
      head.position.set(tx, DECK_Y + 1.66, tz);
      head.rotation.y = Math.atan2(-tx, -tz);
      head.castShadow = true;
      g.add(head);
      const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 8), M.accent);
      eye.position.set(tx, DECK_Y + 1.72, tz);
      eye.rotation.set(Math.PI / 2, 0, 0);
      g.add(eye);
      this.track(this.physics.addBox(tx, DECK_Y + 0.85, tz, 0.42, 0.85, 0.42));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Signage - the part that says "placeholder" out loud               */
  /* ---------------------------------------------------------------- */

  /**
   * Paint one board. A canvas rather than a shared atlas: this world owns four
   * signs and will be deleted, and standing up an atlas for it would be
   * infrastructure built for something with a known expiry date.
   */
  _board(lines, w, h, accent) {
    const cw = 1024, ch = Math.round((1024 * h) / w);
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const a = c.getContext('2d');
    a.fillStyle = '#0d1319';
    a.fillRect(0, 0, cw, ch);
    a.strokeStyle = accent;
    a.lineWidth = Math.round(ch * 0.035);
    a.strokeRect(a.lineWidth, a.lineWidth, cw - a.lineWidth * 2, ch - a.lineWidth * 2);
    a.textAlign = 'center';
    a.textBaseline = 'middle';
    const n = lines.length;
    for (let i = 0; i < n; i++) {
      const [text, scale, colour] = lines[i];
      a.fillStyle = colour;
      a.font = `700 ${Math.round(ch * scale)}px system-ui, sans-serif`;
      a.fillText(text, cw / 2, (ch * (i + 0.5)) / n);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = this._mat(new THREE.MeshStandardMaterial({
      map: tex, roughness: 0.8, metalness: 0.05,
      emissive: new THREE.Color(0xffffff), emissiveMap: tex, emissiveIntensity: 0.35,
    }));
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.castShadow = false;
    return mesh;
  }

  _buildSignage(M) {
    const g = new THREE.Group();
    g.name = 'survey:signage';
    this.group.add(g);

    /* The main hoarding, facing the arrival point. This is the first thing a
     * player sees on stepping through Gateway 06, and it is the sentence that
     * turns an unfinished world into a legible one: the site has been surveyed
     * and has not been commissioned. Nobody has to be told out-of-character. */
    const hoarding = this._board([
      ['SURVEY SITE 06', 0.30, '#e8f2ff'],
      ['NOT COMMISSIONED FOR SETTLEMENT', 0.15, '#9fb8c8'],
      ['SETTING-OUT COMPLETE // AWAITING WORKS', 0.12, '#d8a33a'],
    ], 14, 4.2, '#9fb8c8');
    /* A PlaneGeometry faces +Z, and the arriving player is at +Z looking down
     * the pad, so the board is left unrotated and its structure goes BEHIND it
     * at -Z. Rotating it to face away and then hanging the backer in front is
     * the mirrored-signage failure the station's `_signBoard` exists to avoid. */
    const HOARD_Z = PORTAL_Z - 15;
    hoarding.position.set(0, DECK_Y + 4.4, HOARD_Z);
    g.add(hoarding);
    // Hoarding legs and a solid backer, so it is a structure and not a decal.
    for (const sx of [-6.4, 6.4]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.5, 6.5, 0.5), M.kerb);
      leg.position.set(sx, DECK_Y + 3.25, HOARD_Z - 0.35);
      leg.castShadow = leg.receiveShadow = true;
      g.add(leg);
      this.track(this.physics.addBox(sx, DECK_Y + 3.25, HOARD_Z - 0.35, 0.25, 3.25, 0.25));
    }
    const backer = new THREE.Mesh(new THREE.BoxGeometry(14.6, 4.8, 0.3), M.kerb);
    backer.position.set(0, DECK_Y + 4.4, HOARD_Z - 0.28);
    backer.castShadow = backer.receiveShadow = true;
    g.add(backer);

    /* A datum plate, read from above at the pillar. Amber on the board's own
     * dark ground rather than dark-on-brass: the board paints its background
     * itself, so tinting the material would have multiplied the map and left
     * dark text on a dark field. */
    const datum = this._board([
      ['DATUM 06/00', 0.34, '#d8a33a'],
      ['0.000 m', 0.26, '#e8f2ff'],
    ], 1.1, 1.1, '#d8a33a');
    datum.rotation.x = -Math.PI / 2;
    datum.position.set(0, DECK_Y + 1.35, 0);
    g.add(datum);

    /* Two corner notices, so the message survives being approached from any
     * bearing rather than only from the gateway. */
    for (const [nx, nz, ny] of [[-PAD + 7, -PAD + 7, Math.PI * 0.25], [PAD - 7, -PAD + 7, -Math.PI * 0.25]]) {
      const notice = this._board([
        ['SITE UNDER SURVEY', 0.26, '#d8a33a'],
        ['NO WORKS AUTHORISED', 0.18, '#e8f2ff'],
      ], 4.4, 2.0, '#d8a33a');
      notice.position.set(nx, DECK_Y + 2.2, nz);
      notice.rotation.y = ny;
      g.add(notice);
      // The post goes behind the face, along the board's own backward normal,
      // so it never stands between the notice and the reader.
      const px = nx - Math.sin(ny) * 0.25;
      const pz = nz - Math.cos(ny) * 0.25;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.28, 3.2, 0.28), M.timber);
      post.position.set(px, DECK_Y + 1.6, pz);
      post.castShadow = true;
      g.add(post);
      this.track(this.physics.addBox(px, DECK_Y + 1.6, pz, 0.14, 1.6, 0.14));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Spawn, gateway home, minimap                                      */
  /* ---------------------------------------------------------------- */

  _fillSpawns() {
    /* Cold spawn. Only reachable by starting the game here with ?world=survey;
     * the normal way in is the gateway, and `WorldManager.arrivalFor` puts a
     * player arriving from the station in front of the return portal instead.
     * Both land on the pad, well inside the barrier. */
    this.playerSpawn.set(0, DECK_Y + 0.3, 16);
    this.playerSpawnYaw = 0;   // characters look down -Z at yaw 0: across the pad

    /* The way back. `PortalSystem` builds the arch, the disc and the plinth
     * from this, so all this world owes it is somewhere to stand and a heading.
     *
     * rotationY PI, not 0. `arrivalFor` puts an arriving player 2.6 m along the
     * portal's own normal `(sin rotY, cos rotY)` and turns them to face further
     * along it - out of the doorway, not back into it. At rotationY 0 the
     * normal is +Z, which would have stood the player at z = 30.6 looking at
     * the barrier 5 m in front of them with the entire site behind their back.
     * PI aims the normal at -Z: they arrive at z = 25.4 facing down the pad,
     * with the hoarding, the datum and the grid laid out ahead of them. */
    this.portalSpecs.push({
      position: new THREE.Vector3(0, DECK_Y + 0.3, PORTAL_Z),
      rotationY: Math.PI,
      target: 'station',
      label: 'Aether Nexus Station',
      accent: 0x9fb8c8,
    });

    /* One surveyor. `crowd: false` means the manager adds nobody - no filler,
     * and no generic portal lorekeeper - so this list is the entire population
     * and it has to carry the world's voice on its own. */
    this.npcSpawns.push({
      position: new THREE.Vector3(-7, DECK_Y + 0.2, 4),
      type: 'friendly',
      name: 'Oksana Reyes',
      persona:
        'The site surveyor for Gateway 06, alone on a pad she has set out four times because the brief keeps changing. Dry, unhurried, and genuinely fond of the work; she talks in chainage and levels, refers to the whole world as "the site", and will tell you frankly that nothing has been commissioned here yet and she has no idea what it is going to be. She is not embarrassed about it - a datum and a clean grid are a real achievement and she would like you to notice the grid.',
      patrol: [
        new THREE.Vector3(-7, DECK_Y + 0.2, 4),
        new THREE.Vector3(-16, DECK_Y + 0.2, 12),
        new THREE.Vector3(6, DECK_Y + 0.2, -10),
        new THREE.Vector3(19, DECK_Y + 0.2, -14),
      ],
    });

    // Minimap: the pad, its grid extent, the datum and the way home.
    this.minimapShapes.push(
      { kind: 'rect', x: 0, z: 0, w: PAD * 2, d: PAD * 2, rotation: 0, fill: 'rgba(40,54,68,0.85)', stroke: 'rgba(159,184,200,0.9)' },
      { kind: 'circle', x: 0, z: 0, r: 1.6, fill: 'rgba(216,163,58,0.9)', stroke: '#d8a33a' },
      { kind: 'circle', x: 0, z: PORTAL_Z, r: 4, fill: 'rgba(159,184,200,0.25)', stroke: '#9fb8c8' }
    );
  }

  /* No `update`. The base class's is a no-op and this world has nothing that
   * moves - which is the correct per-frame cost for a placeholder, and is
   * stated here so nobody adds an idle animation to make it feel finished. */

  dispose() {
    for (const m of this._mats) {
      m.map?.dispose?.();
      m.emissiveMap?.dispose?.();
      m.dispose?.();
    }
    this._mats.length = 0;
    super.dispose();
  }
}
