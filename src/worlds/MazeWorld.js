import * as THREE from 'three';
import { World } from './World.js';
import { makeRules } from './WorldRules.js';
import {
  MAZE, DIR, generateTopology, cellCoords, carveEntranceCorridor, hash32, mulberry32,
} from './maze/MazeTopology.js';
import {
  cellToWorld, forecourtColliders, FORECOURT_PORTAL_Z,
} from './maze/MazeColliders.js';
import { pickDeadEndTokens, pickWandererSites, walkPatrol } from './maze/MazePopulate.js';
import { MazeChunks } from './maze/MazeChunks.js';

/**
 * Yaw that faces down each passage direction, matching `Player.fixedUpdate`'s
 * convention (`fwdX = -sin(yaw), fwdZ = -cos(yaw)`; yaw 0 is -Z, yaw PI is +Z).
 */
const DIR_YAW = Object.freeze({
  [DIR.N]: 0,
  [DIR.S]: Math.PI,
  [DIR.E]: -Math.PI / 2,
  [DIR.W]: Math.PI / 2,
});

/** The keeper explains the maze, the map and the abandon control - chat-only. */
const KEEPER_PERSONA = 'Keeper of the Verdant Coil, posted at the forecourt arch since '
  + 'before anyone currently lost inside can remember. She never enters the maze herself - '
  + 'her post is the threshold, not the corridors - and she explains the same three things to '
  + 'every arrival without ever tiring of it: the hedges never repeat, the M key draws the '
  + 'level you are standing in but never marks where you are on it, and holding L for two '
  + 'seconds walks you home from anywhere, no matter how deep. She says all of this gently, '
  + 'like someone who has watched a great many confident people walk in and a great many '
  + 'humbled ones walk back out.';

/**
 * The eight lost wanderers. Capped at eight per the design doc (section 9) -
 * `WANDERER_CAST.length` is what `_populate` asks `pickWandererSites` for, so
 * adding or removing a character here is the only thing that needs to change
 * to change the count.
 */
const WANDERER_CAST = Object.freeze([
  {
    name: 'Corvin Ashe',
    persona: 'A retired cartographer who wandered in to map "just the entrance districts" '
      + 'and lost count of the days somewhere past the ninth journal. He is certain the maze '
      + 'has a pattern - he has three competing theories and will contradict all of them '
      + 'before a conversation is over - and he begs anyone he meets to describe the '
      + 'junctions they passed, which he copies onto scraps of hedge-bark with a stub of '
      + 'charcoal. He is delighted rather than afraid; to him this is the great puzzle of his '
      + 'career, and he is simply not yet willing to admit he might die inside it.',
  },
  {
    name: 'Marta Wren',
    persona: 'The gardener who shaped these hedges by hand, decades before the maze grew '
      + 'past anyone\'s ability to tend it and swallowed her along with the rest. She speaks '
      + 'of individual hedges the way other people speak of old friends, apologises under her '
      + 'breath to the ones she has to push past, and still carries a pair of shears she has '
      + 'long since stopped using - there is nothing left here for one woman to prune. She is '
      + 'not lost, not really; she just cannot bring herself to leave something she grew.',
  },
  {
    name: 'Ossian Drell',
    persona: 'A duelist who took a bet he could reach the centre in a day and has spent what '
      + 'he insists is "more like a season, give or take" proving himself wrong. He has gone '
      + 'half-feral - patched clothes, a forager\'s eye for the maze\'s few edible things, a '
      + 'laugh that comes too easily - but keeps the old-fashioned courtesy of a duelist when '
      + 'he talks, addressing strangers with a formality that sits strangely on someone who '
      + 'has clearly not washed in some time. He will not say who he made the bet with.',
  },
  {
    name: 'Pip',
    persona: 'A child who chased an older brother in through the entrance on a dare and has '
      + 'not stopped looking for him since, though the fear wore down long ago into a '
      + 'stubborn, practical routine - check every junction twice, mark the ones already '
      + 'checked, never cry anywhere it might carry. Pip is fiercely proud of a system of '
      + 'hedge-scratches that makes sense to no one else, insists on being called "nearly '
      + 'eleven," and asks everyone the same question first: "Have you seen a boy, taller '
      + 'than you, loud?"',
  },
  {
    name: 'Rue Calder',
    persona: 'A professional finder of things who took the maze on as a job - someone was '
      + 'paying for whatever sits at the centre - and has been unable to collect a fee from '
      + 'an employer she is no longer sure still exists. Years of a hunt with no one left to '
      + 'answer to have flattened her into something careful and unsentimental; she counts '
      + 'her supplies out loud, trusts nothing that looks too easy, and still appraises '
      + 'everyone she meets, out of sheer habit, for what they might be worth to a job that '
      + 'ended a long time ago.',
  },
  {
    name: 'Isolde Farr',
    persona: 'A painter who came in chasing the exact quality of light the hedges let '
      + 'through at certain hours and simply never left - there was always one more corridor '
      + 'with the light falling a particular way. Her satchel is stuffed with sketches of '
      + 'walls that look identical to anyone else and utterly distinct to her; she can tell '
      + 'you which district you are standing in by the colour of the moss alone. She does not '
      + 'think of herself as lost. She thinks of herself as still working.',
  },
  {
    name: 'Bram Otts',
    persona: 'A courier whose last delivery route somehow led here, and who has kept '
      + 'walking on the theory that a route, once started, is meant to be finished. He still '
      + 'carries the satchel, empty now but for one undeliverable letter he will not open and '
      + 'will not explain, and greets everyone with the same professional cheer he used on '
      + 'his old route, address book long since memorised and now entirely useless. He '
      + 'insists, with total sincerity, that he is not lost - merely between deliveries.',
  },
  {
    name: 'Ansel the Still',
    persona: 'A pilgrim who entered believing the maze was a trial meant to be walked rather '
      + 'than solved, and has kept walking the same loop of corridors for longer than he '
      + 'counts, treating every repeated turn as part of the practice rather than a failure '
      + 'to progress. He speaks slowly, answers questions with questions, and has made a kind '
      + 'of peace with the hedges that unsettles people more than any of the others do - he '
      + 'does not want to be found, only accompanied for a while.',
  },
]);

/** Pickup radius for a dead-end token - generous, so you don't have to stand exactly on it. */
const TOKEN_PICKUP_R = 1.6;
const TOKEN_PICKUP_R2 = TOKEN_PICKUP_R * TOKEN_PICKUP_R;
/**
 * Credits per token. Single-digit on purpose - the centre stack is worth 100
 * and is the one reward this world should not let anything else overshadow.
 */
const MAZE_TOKEN_VALUE = 6;
/** How many extra cells a wanderer's patrol reaches beyond its starting cell. */
const PATROL_STEPS = 4;
/** Districts either side of the player. 2 gives the 5x5 block the spec calls for. */
const RESIDENCY_RADIUS = 2;

// Scratch objects for the per-frame token instance-matrix update, reused
// every call rather than allocated - see the note on MazeWorld.update.
const _tokPos = new THREE.Vector3();
const _tokQuat = new THREE.Quaternion();
const _tokScale = new THREE.Vector3(1, 1, 1);
const _tokZeroScale = new THREE.Vector3(0, 0, 0);
const _tokMat = new THREE.Matrix4();
const _tokUp = new THREE.Vector3(0, 1, 0);

/**
 * The Verdant Coil - a hedge maze that re-rolls its layout on every entry.
 *
 * Phase 1 scope, deliberately: one level, every district built up front, and
 * box geometry rather than foliage. Streaming, the other three levels, the art
 * pass, the puzzles and the map are Phases 2-5. Building the whole level
 * up front is knowingly wrong for the finished world and knowingly right for
 * now - it takes streaming out of the equation while the topology, the rules
 * and the containment work are being proven.
 *
 * @see docs/superpowers/specs/2026-08-07-maze-world-design.md
 */
export class MazeWorld extends World {
  static id = 'maze';
  static displayName = 'The Verdant Coil';

  /**
   * Re-generate on every activation rather than serving a cached build.
   * Read by WorldManager. The maze that cannot be learned is the entire point.
   */
  static volatile = true;

  constructor(ctx) {
    super(ctx);

    this.rules = makeRules({
      weapons: false, mounts: false, climb: false, parkour: false,
      merchants: false, quests: false, contracts: false, caches: false,
      relics: false, loot: false, races: false, interiors: false,
      hostiles: false, swim: false,
      // The keeper and the eight wanderers are the whole cast - see
      // WANDERER_CAST above. The maze's atmosphere is being alone; a
      // manager-added crowd would drown that out.
      crowd: false,
      // jump stays permitted: the geometry makes the hop useless, not the input.
    });

    /** Current run's seed. Re-rolled on every build. */
    this.seed = 0;
    /** @type {Uint8Array|null} */
    this.cells = null;
    this.entranceCell = 0;
    this.centreCell = 0;

    /* Materials are created once and reused across every re-roll. Allocating
     * fresh ones per entry would re-trigger the shader compilation that already
     * dominates cold boot in this project - see the prewarm notes in main.js. */
    this._materials = null;

    /** @type {Array<{position: THREE.Vector3, taken: boolean, phase: number}>} */
    this._tokens = [];
    /** @type {THREE.InstancedMesh|null} */
    this._tokenMesh = null;
    this._tokenTime = 0;

    const span = MAZE.CELLS * MAZE.CELL;
    this.bounds = new THREE.Box3(
      new THREE.Vector3(-MAZE.CELL, -10, -MAZE.CELL),
      new THREE.Vector3(span, MAZE.LEVEL_HEIGHT * MAZE.LEVELS + 20, span),
    );

    this.environment.background = new THREE.Color(0x9fb8c8);
    this.environment.fogColor = new THREE.Color(0xa8c0ce);
    this.environment.fogNear = 20;
    this.environment.fogFar = 160;
    this.environment.ambientColor = new THREE.Color(0x6f7f68);
    this.environment.ambientIntensity = 0.7;
    this.environment.sunColor = new THREE.Color(0xfff2d8);
    this.environment.sunIntensity = 2.2;
    this.environment.sunDirection = new THREE.Vector3(-0.3, 0.9, -0.25).normalize();
  }

  /** Reusable material set, built on first use and kept for the session. */
  _ensureMaterials() {
    if (this._materials) return this._materials;
    this._materials = {
      hedge: new THREE.MeshStandardMaterial({ color: 0x2f4a2a, roughness: 0.95, metalness: 0 }),
      floor: new THREE.MeshStandardMaterial({ color: 0x6b6357, roughness: 1.0, metalness: 0 }),
      credits: new THREE.MeshStandardMaterial({
        color: 0xffd479, roughness: 0.35, metalness: 0.8,
        emissive: 0x6a4a10, emissiveIntensity: 0.6,
      }),
      /* Dead-end tokens. One more cached material, built once here and reused
       * across every re-roll for the same reason the other two are - see the
       * class docstring above. A cool glow reads clearly in a dim dead end
       * without being mistaken for the centre stack's gold. */
      token: new THREE.MeshStandardMaterial({
        color: 0x8fe0c9, roughness: 0.3, metalness: 0.25,
        emissive: 0x2fae86, emissiveIntensity: 1.15,
      }),
    };
    return this._materials;
  }

  async build(onProgress) {
    /* A fresh seed per build. `build()` runs on every activation because this
     * world is volatile, so this is what makes the maze unlearnable. */
    this.seed = (Math.random() * 0xffffffff) >>> 0;

    await onProgress?.(0.05, 'Growing the hedges');

    const topo = generateTopology(this.seed, { levels: 1 });
    this.cells = topo.cells;
    this.entranceCell = topo.entranceCell;
    this.centreCell = topo.centreCell;

    /* `buildDistrictGraph` fixes the entrance at the *centre* of district
     * (10,0) - ten cells inside the grid's own edge, not on it - so nothing
     * connects it to the outside on its own. Carve a straight corridor from
     * the grid's north boundary out to the entrance and breach that boundary
     * wall. This can only open passage bits, never close any, so it cannot
     * disconnect anything that was already reachable - see
     * MazeTopology.carveEntranceCorridor. */
    const e = cellCoords(this.entranceCell);
    carveEntranceCorridor(this.cells, e);

    await onProgress?.(0.25, 'Laying the paths');

    const mats = this._ensureMaterials();
    const ew = cellToWorld(e.x, e.z, e.level);

    /* Districts stream (see this.chunks below). The forecourt does not: it is
     * hand-authored, sits outside the cell grid in negative z, and is the floor
     * the player arrives on. It needs meshes as well as colliders. */
    const descs = [];
    for (const d of forecourtColliders(ew.x, e.level)) descs.push(d);

    const hedges = descs.filter((d) => d.kind === 'hedge');
    const floors = descs.filter((d) => d.kind === 'floor');
    this._addInstanced(hedges, mats.hedge, 'maze:forecourt-hedges');
    this._addInstanced(floors, mats.floor, 'maze:forecourt-floor');

    for (const d of descs) {
      this.track(this.physics.addBox(d.cx, d.cy, d.cz, d.hx, d.hy, d.hz));
    }

    /* Spawn the player standing in the entrance cell, facing down whichever
     * passage is actually open. `carveEntranceCorridor` only guarantees DIR.N
     * (back out to the forecourt) - the maze proper, at DIR.S/E/W, is
     * whatever the backtracker happened to open, which is not necessarily
     * south. A hardcoded yaw can and did put a hedge 2.4 m in front of a cold
     * spawn with the one open passage behind the player instead. This is the
     * cold-spawn yaw only; portal arrival is computed separately below from
     * `portalSpecs`/`rotationY` and does not read this field. */
    this.playerSpawn.set(ew.x, ew.y + 0.05, ew.z);
    const openHere = this.cells[this.entranceCell];
    const intoMaze = [DIR.S, DIR.E, DIR.W].find((d) => (openHere & d) !== 0);
    this.playerSpawnYaw = DIR_YAW[intoMaze ?? DIR.N];

    /* Districts stream; everything else in this world does not. The forecourt,
     * the centre stack, the tokens and the NPC spawns are authored per build and
     * stay for the whole visit - the forecourt especially, since it is the floor
     * the player arrives on and lives outside the district grid entirely. */
    this.chunks = new MazeChunks({
      world: this,          // NOT this.physics — see the note in MazeChunks
      cells: this.cells,
      group: this.group,
      materials: mats,
    });

    const spawn = this.playerSpawn;
    this.chunks.updateResidency(spawn.x, spawn.z, 0, RESIDENCY_RADIUS);

    /* The return arch stands in the middle of the forecourt rather than one
     * cell north of the entrance - that position sat inside the hedge the
     * entrance cell's own (closed, before carveEntranceCorridor) north face
     * put there, and the plinth is far too wide to fit in a maze corridor
     * regardless. `rotationY: 0` keeps `WorldManager.arrivalFor`'s arithmetic
     * (arrival = position + 2.6m along (sin(rotY), cos(rotY)), yaw = rotY +
     * PI) landing the player just south of the portal, facing +z into the
     * corridor - confirmed against `Player.forward`, where yaw=PI is +Z. */
    this.portalSpecs = [{
      position: new THREE.Vector3(ew.x, ew.y, FORECOURT_PORTAL_Z),
      rotationY: 0,
      target: 'station',
      label: 'Aether Station',
      accent: 0x8fd67a,
    }];

    this._buildCentreStack(mats.credits);

    await onProgress?.(0.95, 'Waking the hedges');

    /* The keeper, the eight wanderers, and the dead-end tokens - all derived
     * from `this.cells`, never from a fixed coordinate, because the layout
     * above this line is different on literally every call to build(). */
    this._populate(ew, e, mats);

    await onProgress?.(1, 'The Verdant Coil is ready');
  }

  /**
   * Place the keeper, the eight lost wanderers, and the dead-end tokens.
   *
   * @param {{x:number, y:number, z:number}} ew world-space entrance column
   * @param {{x:number, z:number, level:number}} e entrance cell coords
   * @param {{hedge:THREE.Material, floor:THREE.Material,
   *          credits:THREE.Material, token:THREE.Material}} mats
   */
  _populate(ew, e, mats) {
    this.npcSpawns = [];

    /* The Keeper. Hand-placed like the return arch itself rather than derived
     * from topology - the forecourt is authored geometry (see
     * MazeColliders.forecourtColliders), not carved maze, so there is no
     * hedge for a fixed offset to land inside here the way there would be
     * further in. 6m east of the portal, level with it: clear of the ~4.6m
     * widest reach of the plinth and its approach steps, and well inside the
     * forecourt's 9m half-width to that side. */
    this.npcSpawns.push({
      position: new THREE.Vector3(ew.x + 6, ew.y + 0.1, FORECOURT_PORTAL_Z),
      type: 'friendly',
      name: 'The Keeper of the Coil',
      role: 'lorekeeper',
      persona: KEEPER_PERSONA,
    });

    const level = e.level;
    /* Neither the entrance nor the centre cell should ever be handed back as
     * a wanderer site or a token - the entrance sits right by the keeper and
     * the centre already holds the credit stack. */
    const exclude = new Set([this.entranceCell, this.centreCell]);

    const wandererCells = pickWandererSites(this.cells, level, this.seed, WANDERER_CAST.length, exclude);
    for (let i = 0; i < wandererCells.length; i++) {
      const routeCells = walkPatrol(this.cells, level, wandererCells[i], PATROL_STEPS, hash32(this.seed, 0xbeef, i));
      const patrol = routeCells.map((idx) => {
        const c = cellCoords(idx);
        const w = cellToWorld(c.x, c.z, level);
        return new THREE.Vector3(w.x, w.y + 0.05, w.z);
      });
      const cast = WANDERER_CAST[i % WANDERER_CAST.length];
      this.npcSpawns.push({
        position: patrol[0].clone(),
        type: 'friendly',
        name: cast.name,
        persona: cast.persona,
        patrol,
      });
    }

    const tokenCells = pickDeadEndTokens(this.cells, level, this.seed, 40, exclude);
    this._buildTokens(tokenCells, level, mats.token);
  }

  /**
   * The ~40 dead-end tokens. Deliberately NOT collidable, with no exception -
   * see the same note on `_buildCentreStack`. A dead end puts a hedge corner
   * within 2m on at least two sides by definition, which is exactly the
   * geometry §2 of the design doc calls a ladder if anything standable sits
   * in the 0.45-5.0m band there. These never reach `this.physics.addBox` at
   * all, which is the only way to be sure of that rather than merely careful
   * about it.
   */
  _buildTokens(cellIndices, level, material) {
    this._tokens = [];
    this._tokenMesh = null;
    if (cellIndices.length === 0) return;

    const geo = new THREE.OctahedronGeometry(0.3, 0);
    const mesh = new THREE.InstancedMesh(geo, material, cellIndices.length);
    mesh.name = 'maze:tokens';
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    /* Seeded off the maze's own seed so token placement is visually varied
     * (bob/spin phase) but exactly reproducible for a given re-roll, same as
     * everything else in this world. */
    const rng = mulberry32(hash32(this.seed, 0x704e));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);

    for (let i = 0; i < cellIndices.length; i++) {
      const c = cellCoords(cellIndices[i]);
      const w = cellToWorld(c.x, c.z, level);
      const position = new THREE.Vector3(w.x, w.y + 0.6, w.z);
      this._tokens.push({ position, taken: false, phase: rng() * Math.PI * 2 });
      m.compose(position, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this._tokenMesh = mesh;
  }

  /**
   * Bob/spin the still-uncollected tokens and check the player's distance to
   * each. Cheap by construction: there are ~40 of these regardless of maze
   * size, so this never scales with the grid the way anything keyed off
   * `this.cells` would.
   */
  update(dt) {
    const player = this.ctx.player?.position;
    if (player && this.chunks) {
      this.chunks.updateResidency(player.x, player.z, 0, RESIDENCY_RADIUS);
    }

    if (!this._tokenMesh || this._tokens.length === 0) return;
    this._tokenTime += dt;
    const t = this._tokenTime;
    const p = this.ctx.player?.position;

    let dirty = false;
    for (let i = 0; i < this._tokens.length; i++) {
      const tok = this._tokens[i];
      if (tok.taken) continue;

      if (p) {
        const dx = p.x - tok.position.x;
        const dy = (p.y + 1.0) - tok.position.y;
        const dz = p.z - tok.position.z;
        if (dx * dx + dy * dy + dz * dz < TOKEN_PICKUP_R2) {
          tok.taken = true;
          // Hide by zero-scaling: an InstancedMesh has no per-instance
          // visibility flag, only a matrix, and shrinking the instance to
          // nothing is cheaper than rebuilding the whole buffer one entry
          // shorter every time a token is found.
          _tokMat.compose(tok.position, _tokQuat, _tokZeroScale);
          this._tokenMesh.setMatrixAt(i, _tokMat);
          dirty = true;
          /* MazeWorld never touches Economy or HUD directly - main.js is the
           * single integration point (see its header comment) and owns the
           * award and the notification. This only announces the fact. */
          this.bus?.emit('maze:token-found', { amount: MAZE_TOKEN_VALUE });
          continue;
        }
      }

      const bob = Math.sin(t * 1.6 + tok.phase) * 0.12;
      _tokPos.set(tok.position.x, tok.position.y + bob, tok.position.z);
      _tokQuat.setFromAxisAngle(_tokUp, t * 1.1 + tok.phase);
      _tokMat.compose(_tokPos, _tokQuat, _tokScale);
      this._tokenMesh.setMatrixAt(i, _tokMat);
      dirty = true;
    }
    if (dirty) this._tokenMesh.instanceMatrix.needsUpdate = true;
  }

  /** Build one InstancedMesh from a list of box descriptors. */
  _addInstanced(descs, material, name) {
    if (descs.length === 0) return;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mesh = new THREE.InstancedMesh(geo, material, descs.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (let i = 0; i < descs.length; i++) {
      const d = descs[i];
      pos.set(d.cx, d.cy, d.cz);
      scale.set(d.hx * 2, d.hy * 2, d.hz * 2);
      m.compose(pos, q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /** The prize: a stack of credits at the centre, worth 100. */
  _buildCentreStack(material) {
    const c = cellCoords(this.centreCell);
    const w = cellToWorld(c.x, c.z, c.level);
    const stack = new THREE.Group();
    stack.name = 'maze:centre-stack';
    for (let i = 0; i < 7; i++) {
      const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20), material);
      coin.position.set(
        (i % 2) * 0.04 - 0.02,
        0.06 + i * 0.09,
        Math.floor(i / 2) * 0.03 - 0.03,
      );
      coin.castShadow = true;
      stack.add(coin);
    }
    stack.position.set(w.x, w.y, w.z);
    this.group.add(stack);

    /* Deliberately NOT collidable. A 0.7m stack sits squarely in the 0.45-5.0m
     * hop band, and the centre cell has hedges on at least three sides - a
     * solid stack there would be a step onto the hedge tops. */
    this.centrePosition = new THREE.Vector3(w.x, w.y, w.z);
  }

  /** Re-generation needs a clean group and collider list each time. */
  dispose() {
    this.chunks?.disposeAll();
    this.chunks = null;

    this.group.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      /* InstancedMesh owns an `instanceMatrix` GPU buffer that geometry
       * disposal does not touch - it is released only through the mesh's own
       * dispose event. At ~175,600 hedge instances that is 175,600 * 16 * 4 =
       * ~11.2 MB stranded on every re-roll if this is skipped, and repeated
       * re-rolling is this world's entire premise. */
      if (obj.isInstancedMesh) obj.dispose();
    });
    this.group.clear();
    this.colliders.length = 0;
    this._built = false;
    /* Materials survive on purpose - see _ensureMaterials. */

    /* The token InstancedMesh and its geometry are freed by the traversal
     * above (it lives in `this.group` like everything else); this just drops
     * the bookkeeping so a stale `_tokenMesh` from the previous roll can
     * never be written to by a straggling update() call between dispose()
     * and the next build(). `npcSpawns` is reset at the top of `_populate`
     * rather than here, matching `portalSpecs`, which build() also
     * reassigns outright instead of clearing in dispose(). */
    this._tokens = [];
    this._tokenMesh = null;
  }
}
