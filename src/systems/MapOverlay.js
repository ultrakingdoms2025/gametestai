import * as THREE from 'three';
import { ITEMS } from './ItemDefs.js';
import { consumableItemFor } from './Marketplace.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { planGrid, createJob, MAX_LAYERS, LAYOUT_SCHEMA } from './GroundSampler.js';

/**
 * The admin map editor's placement overlay, applied to a world the game built.
 *
 * ── Why an overlay rather than an editor that writes world source ──────────
 *
 * Worlds here are procedural code and one of them (`MedievalWorld.js`) is
 * 12,945 lines. An editor that rewrote world source would collide head-on with
 * the art passes editing those same files. So the editor writes a SEPARATE,
 * versioned document — a set of moved and placed instances — and this applies it
 * after `world:changed`. Nothing in `src/worlds/` knows this file exists, and
 * every change is revertible because nothing was overwritten.
 *
 * ── The thing that would otherwise ship broken ─────────────────────────────
 *
 * A world's visuals and its collision are SEPARATE STRUCTURES. `Physics` stores
 * baked world-space geometry — a matrix for a box, a world-space vertex array
 * for a mesh — with no back-reference to the `Object3D` it was built from. Move
 * the mesh and nothing else and there is an invisible wall where the building
 * used to be: a change that looks right in every screenshot and is wrong to walk
 * into. So a move takes its colliders with it, and reports how many came, so an
 * admin can see when the answer was none.
 *
 * ── Absolute positions, and why that is not a detail ───────────────────────
 *
 * An entry names WHERE the object goes, never how far to shift it. This is
 * applied once per world load, and `WorldManager` caches worlds — the same
 * `Object3D` is re-shown on every visit — so a delta would compound and the
 * crate would walk a little further off each time the player came back. An
 * absolute position is idempotent, and there is a test that enters twice.
 *
 * ── Restore, then apply ────────────────────────────────────────────────────
 *
 * Every object this touches has its original transform recorded before the
 * first change. Leaving the world, or re-entering it after the admin saved a
 * new version, restores those originals first and applies the current document
 * on top. That is what makes an entry the admin DELETED actually go away,
 * rather than staying put because nothing ever moved it back.
 */

/** Where the game asks for a world's overlay. */
const READ_ENDPOINT = '/api/game/map-overlay';

/** Where an admin's own client reports what it found and did. */
const REPORT_ENDPOINT = '/api/admin/map/report';

/**
 * How many named objects the catalogue report carries.
 *
 * A world group holds tens of thousands of nodes. The catalogue exists to fill
 * the editor's object picker, so it takes named objects only, nearest the root
 * first, and stops. The server caps it again.
 */
const MAX_CATALOGUE = 2000;

/**
 * Never placeable, whatever a catalogue row says.
 *
 * `credits` is a VIRTUAL item — `Inventory._addCredits` turns it straight into
 * balance rather than into a slot. A placed crate full of credits would be a
 * printing press an admin could put on a hillside, and `marketplaceDb.ts`
 * already refuses to SELL this id for exactly the same reason.
 */
const NEVER_PLACEABLE = new Set(['credits']);

/** Scratch. Each function owns its own — see the note in physics/Physics.js. */
const _before = new THREE.Vector3();
const _after = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _box = new THREE.Box3();
const _shift = new THREE.Matrix4();

/** The sampler's ray. Two scratch vectors, reused for every cast of every cell. */
const _rayOrigin = new THREE.Vector3();
const _rayDown = new THREE.Vector3();

/**
 * How much of a frame the ground sampler may take (spec §7). A clock, not a
 * ray count: a cell in a dense district costs more than one over open floor,
 * and the frame does not care which it was.
 */
const SAMPLE_BUDGET_MS = 2;

/**
 * Resolve a marketplace item to the inventory stack a placed pickup holds.
 *
 * The precedence follows `Marketplace._purchaseGrant`, which is what a PURCHASE
 * of the same row grants — a placed item and a bought item must be the same
 * thing, or the editor is quietly authoring a second economy.
 *
 * @param {{source_key?:string, config?:Record<string,any>}} item
 * @returns {{itemId:string, qty:number}|null}
 */
export function grantForPlacement(item) {
  const config = item?.config ?? {};
  const key = String(item?.source_key ?? '');

  if (config.effect === 'grant_ammo' && typeof config.ammo_item === 'string') {
    return { itemId: config.ammo_item, qty: Math.max(1, Math.floor(Number(config.amount) || 1)) };
  }
  if (config.effect === 'grant_item' && typeof config.item_id === 'string') {
    return { itemId: config.item_id, qty: Math.max(1, Math.floor(Number(config.amount) || 1)) };
  }

  const consumable = consumableItemFor(key);
  if (consumable) return { itemId: consumable, qty: 1 };

  // Last resort: the key IS an item id, possibly with the world stamped on it
  // (`buildMarketplaceSeedItems` seeds one row per world and appends `:<world>`).
  const has = (k) => Object.prototype.hasOwnProperty.call(ITEMS, k);
  if (has(key)) return { itemId: key, qty: 1 };
  const cut = key.lastIndexOf(':');
  if (cut > 0 && has(key.slice(0, cut))) return { itemId: key.slice(0, cut), qty: 1 };

  return null;
}

export class MapOverlay {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus, physics?: import('../physics/Physics.js').Physics,
   *   loot?: import('./Loot.js').LootSystem, engine?: { onFrameUpdate(fn: (dt:number) => void): () => void },
   *   forceLayout?: boolean, fetch?: typeof fetch, now?: () => number, endpoint?: string, reportEndpoint?: string }} ctx
   *   `engine` ticks the ground sampler; `forceLayout` (the `?layout=sample`
   *   dev switch) samples without an admin session and never posts; `now` is
   *   the sampler's clock, injectable so a test can own the frame.
   */
  constructor({ bus, physics, loot, engine, forceLayout, fetch: fetchImpl, now, endpoint, reportEndpoint } = {}) {
    this.bus = bus ?? null;
    this.physics = physics ?? null;
    this.loot = loot ?? null;
    this.forceLayout = forceLayout === true;
    this.endpoint = endpoint ?? READ_ENDPOINT;
    this.reportEndpoint = reportEndpoint ?? REPORT_ENDPOINT;
    this._fetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._now = typeof now === 'function' ? now : () => performance.now();

    /** True once the CURRENT world's ground grid has been sampled; reset on `world:changed`. */
    this.layoutSampled = false;
    /** Resolves with the `map-overlay:layout` payload, or null if the world was left first. */
    this.sampling = Promise.resolve(null);
    /** The in-flight sampling job, or null. @see update */
    this._job = null;

    /**
     * The promise for the world change currently being applied, or null.
     * Nothing in the game awaits it — a world is playable with or without its
     * overlay — but the tests do, and so does anything that wants to know the
     * map has settled.
     * @type {Promise<void>|null}
     */
    this.applying = null;

    /** Last report: what was applied, what could not be, what exists. */
    this.report = { world: null, version: 0, applied: [], unresolved: [], objects: [] };

    /** The world currently carrying overlay changes. */
    this._world = null;
    /** Undo records for `_world`. @type {Array<() => void>} */
    this._undo = [];
    /** Pickups this system spawned into `_world`. */
    this._placed = [];

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(
        bus.on('world:changed', ({ id, world }) => {
          this.applying = this._onWorldChanged(id, world);
        })
      );
    }
    /* Once, for the life of the system - not per world. Idle when there is
     * no job; frame-gaps attributes it as `u:mapOverlay` because it is named
     * `update`. Not called while the engine is paused. */
    if (engine?.onFrameUpdate) this._offs.push(engine.onFrameUpdate((dt) => this.update(dt)));
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async _onWorldChanged(id, world) {
    // Whatever this system did to the previous world is undone first — the
    // previous world may be THIS world (a re-entry after a save), in which case
    // undoing is what lets a deleted entry actually take effect.
    this._restore();

    if (!world?.group || !id) return;
    this._world = world;

    const document = await this._read(id);
    const admin = document?.admin === true;
    if (!document) {
      this._publish({ world: id, version: 0, applied: [], unresolved: [], objects: [] });
    } else {
      await this._applyDocument(id, world, document, admin);
    }

    /* The ground is sampled AFTER the overlay is applied, so a moved building's
     * colliders are where the editor will draw them. Admin, or the dev switch;
     * and only if this is still the world we are in - both awaits above are
     * places a portal can land. */
    if ((admin || this.forceLayout) && this._world === world) this._startSampling(id, world, admin);
  }

  /** Apply the entries, publish, and report. Unchanged from before the sampler. */
  async _applyDocument(id, world, document, admin) {
    const entries = Array.isArray(document.entries) ? document.entries : [];
    const applied = [];
    const unresolved = [];

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      try {
        if (entry.kind === 'move') this._applyMove(world, entry, applied, unresolved);
        else if (entry.kind === 'place') this._applyPlace(world, entry, applied, unresolved);
      } catch (err) {
        // One bad entry must never cost the player the world they are standing
        // in. It is reported, and the next entry is tried.
        console.warn('[map-overlay] entry failed:', entry?.id, err?.message ?? err);
        unresolved.push({ id: String(entry?.id ?? ''), reason: 'error' });
      }
    }

    const objects = admin ? this._catalogue(world) : [];
    const report = { world: id, version: Number(document.version) || 0, applied, unresolved, objects };
    this._publish(report);

    if (admin) await this._reportBack(report, world);
  }

  /** Undo everything applied to the world this system last touched. */
  _restore() {
    for (let i = this._undo.length - 1; i >= 0; i--) {
      try {
        this._undo[i]();
      } catch (err) {
        console.warn('[map-overlay] could not restore:', err?.message ?? err);
      }
    }
    this._undo.length = 0;

    for (const pickup of this._placed) {
      try {
        this.loot?.despawn?.(pickup);
      } catch {
        /* a pickup the loot pool already recycled is not an error */
      }
    }
    this._placed.length = 0;
    this._cancelSampling();
    this.layoutSampled = false;
    this._world = null;
  }

  async _read(worldId) {
    if (!this._fetch) return null;
    try {
      const res = await this._fetch(`${this.endpoint}?world=${encodeURIComponent(worldId)}`, {
        cache: 'no-store',
      });
      if (!res?.ok) return null;
      const data = await res.json();
      // A document about a different world is not this world's document. The
      // server answers the world it was asked about; anything else is a stale
      // reply that arrived after a portal.
      if (data?.world && data.world !== worldId) return null;
      return data && typeof data === 'object' ? data : null;
    } catch (err) {
      // Offline, signed out, or the endpoint is down. A world with no overlay is
      // exactly the world every player had before this phase existed.
      console.warn('[map-overlay] overlay unavailable:', err?.message ?? err);
      return null;
    }
  }

  _publish(report) {
    this.report = report;
    this.bus?.emit?.('map-overlay:applied', report);
  }

  async _reportBack(report, world, ground = null) {
    if (!this._fetch) return;
    try {
      await this._fetch(this.reportEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          world: report.world,
          appliedVersion: report.version,
          objects: report.objects,
          applied: report.applied,
          unresolved: report.unresolved,
          // The layout fields every report carries, and - on the second
          // report of a visit only - the sampled ground.
          ...this._layoutFields(world),
          ...(ground ? { ground } : {}),
        }),
      });
    } catch (err) {
      // The editor loses one refresh of its object picker. Nothing in the game
      // depends on this landing.
      console.warn('[map-overlay] could not report to the editor:', err?.message ?? err);
    }
  }

  /** `world.bounds` as plain JSON and `world.minimapShapes` as Minimap.js draws them. */
  _layoutFields(world) {
    const b = world?.bounds;
    const six = b?.min && b?.max ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z] : null;
    // An empty Box3 is ±Infinity, which JSON writes as null - and to the server
    // a present `bounds` means "replace". So it is omitted unless all six are numbers.
    const bounds = six?.every(Number.isFinite)
      ? { min: { x: six[0], y: six[1], z: six[2] }, max: { x: six[3], y: six[4], z: six[5] } }
      : null;
    return {
      layoutSchema: LAYOUT_SCHEMA,
      ...(bounds ? { bounds } : {}),
      shapes: Array.isArray(world?.minimapShapes) ? world.minimapShapes : [],
    };
  }

  /* ------------------------------------------------------------------ */
  /* The ground grid                                                     */
  /* ------------------------------------------------------------------ */

  /** Start a job for `world`; `post`: to the editor (admin) or only the bus (dev switch). */
  _startSampling(id, world, post) {
    this._cancelSampling();
    const plan = this.physics ? planGrid(world.bounds) : null;
    if (!plan) return;
    const job = createJob(plan, (x, yTop, z, maxDrop) => this._castDown(x, yTop, z, maxDrop), {
      layers: MAX_LAYERS,
      // The dome and a 260 m planet are both above groundHeight's 200 m default.
      topY: world.bounds.max.y + 10,
      floorY: world.bounds.min.y - 20,
    });
    job.world = id;
    job.post = post;
    job.startedAt = this._now();
    this.sampling = new Promise((resolve) => { job.resolve = resolve; });
    this._job = job;
  }

  /** The one line that touches Physics: the first WORLD surface below (x, yTop, z). */
  _castDown(x, yTop, z, maxDrop) {
    const hit = this.physics.raycast(
      _rayOrigin.set(x, yTop, z), _rayDown.set(0, -1, 0), maxDrop, COLLISION_LAYER.WORLD
    );
    return hit ? hit.point.y : null;
  }

  /**
   * Per rendered frame. Idle unless a job is in flight; then 2 ms of it - or,
   * on the frame AFTER the last cell, the finish. `result()` is a ~4 ms one-off
   * at station size and the POST's stringify another few, so they take a frame
   * of their own rather than landing on top of the sampling that completed.
   */
  update() {
    const job = this._job;
    if (!job) return;
    try {
      if (job.done) this._finishSampling(job);
      else if (job.run(SAMPLE_BUDGET_MS, this._now)) job.finishedAt = this._now();
    } catch (err) {
      // A cast that throws leaves the job resumable, so without this it would
      // throw again next frame, and every frame, one cell at a time, for ever.
      // Dropped instead; the exception never reaches the engine's frame loop.
      this._job = null;
      console.warn('[map-overlay] ground sampling abandoned:', err?.message ?? err);
      job.resolve?.(null);
    }
  }

  _finishSampling(job) {
    const ground = job.result();
    this._job = null;
    const summary = {
      world: job.world, cells: job.cells, layers: job.layers, sampledMs: job.finishedAt - job.startedAt,
    };
    this.layoutSampled = true;
    this.bus?.emit?.('map-overlay:layout', summary);
    const posted = job.post ? this._reportBack(this.report, this._world, ground) : Promise.resolve();
    posted.then(() => job.resolve?.(summary));
  }

  /** Drop the in-flight job, if any. Its promise resolves null; nothing is posted. */
  _cancelSampling() {
    const job = this._job;
    if (!job) return;
    this._job = null;
    job.resolve?.(null);
  }

  /* ------------------------------------------------------------------ */
  /* Moving                                                              */
  /* ------------------------------------------------------------------ */

  _applyMove(world, entry, applied, unresolved) {
    const name = entry?.target?.name;
    const target = typeof name === 'string' && name ? world.group.getObjectByName(name) : null;
    if (!target) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'name' });
      return;
    }

    const originalPosition = target.position.clone();
    const originalRotationY = target.rotation.y;
    const originalVisible = target.visible;
    this._undo.push(() => {
      target.position.copy(originalPosition);
      target.rotation.y = originalRotationY;
      target.visible = originalVisible;
      target.updateMatrixWorld(true);
    });

    if (entry.hidden) target.visible = false;

    const to = entry.position;
    let colliders = 0;
    if (to && Number.isFinite(to.x) && Number.isFinite(to.y) && Number.isFinite(to.z)) {
      // The world AABB has to be taken BEFORE the move, because it is what
      // decides which colliders belong to this object.
      target.updateWorldMatrix(true, false);
      _box.setFromObject(target);
      target.getWorldPosition(_before);

      target.position.set(to.x, to.y, to.z);
      if (Number.isFinite(entry.rotationY)) target.rotation.y = entry.rotationY;
      target.updateMatrixWorld(true);
      target.getWorldPosition(_after);

      _delta.copy(_after).sub(_before);
      colliders = this._moveColliders(_box, _delta);
    } else if (Number.isFinite(entry.rotationY)) {
      target.rotation.y = entry.rotationY;
      target.updateMatrixWorld(true);
    }

    applied.push({ id: String(entry.id ?? ''), ok: true, colliders });
  }

  /**
   * Shift every collider that belonged to the object by the same delta.
   *
   * ── Which colliders "belong" to it ─────────────────────────────────────
   *
   * Those whose centre lies inside the object's world AABB, taken before the
   * move. This is a heuristic and is named as one. It is right for the props
   * and buildings an admin will move, and its failure mode is UNDER-moving —
   * an invisible wall stays behind, which is visible and fixable — never
   * dragging half the world along.
   *
   * ── Two things that are not heuristics ─────────────────────────────────
   *
   * Heightfields never move. Terrain is the ground; translating it is never
   * what an admin meant by "move that crate", and it would take the world's
   * floor with it.
   *
   * The collider is REMOVED, mutated, and re-ADDED rather than replaced with a
   * new one. `Physics.remove` and `add` share `_gridRange`, so the broadphase
   * stays consistent; and mutating in place keeps `layer`, `solid` and
   * `userData` exactly as the world authored them, which constructing a
   * replacement would silently drop.
   */
  _moveColliders(box, delta) {
    const physics = this.physics;
    if (!physics || delta.lengthSq() === 0) return 0;

    const moving = [];
    for (const collider of physics.colliders) {
      if (!collider || collider.type === 'heightfield') continue;
      if (box.containsPoint(collider.center)) moving.push(collider);
    }
    if (moving.length === 0) return 0;

    const dx = delta.x;
    const dy = delta.y;
    const dz = delta.z;

    for (const collider of moving) {
      physics.remove(collider);

      if (collider.type === 'box') {
        _shift.makeTranslation(dx, dy, dz);
        collider.matrix.premultiply(_shift);
        collider.inverse.copy(collider.matrix).invert();
        collider.center.setFromMatrixPosition(collider.matrix);
      } else if (collider.type === 'sphere') {
        collider.center.add(delta);
      } else if (collider.type === 'mesh') {
        const p = collider.positions;
        for (let i = 0; i < p.length; i += 3) {
          p[i] += dx;
          p[i + 1] += dy;
          p[i + 2] += dz;
        }
        collider.bounds.min.add(delta);
        collider.bounds.max.add(delta);
        collider.bounds.getCenter(collider.center);
      }

      physics.add(collider);
      const undoDelta = delta.clone();
      this._undo.push(() => this._shiftCollider(collider, undoDelta.clone().negate()));
    }
    return moving.length;
  }

  /** The single-collider half of `_moveColliders`, used to undo one. */
  _shiftCollider(collider, delta) {
    const physics = this.physics;
    if (!physics || !collider) return;
    physics.remove(collider);
    if (collider.type === 'box') {
      _shift.makeTranslation(delta.x, delta.y, delta.z);
      collider.matrix.premultiply(_shift);
      collider.inverse.copy(collider.matrix).invert();
      collider.center.setFromMatrixPosition(collider.matrix);
    } else if (collider.type === 'sphere') {
      collider.center.add(delta);
    } else if (collider.type === 'mesh') {
      const p = collider.positions;
      for (let i = 0; i < p.length; i += 3) {
        p[i] += delta.x;
        p[i + 1] += delta.y;
        p[i + 2] += delta.z;
      }
      collider.bounds.min.add(delta);
      collider.bounds.max.add(delta);
      collider.bounds.getCenter(collider.center);
    }
    physics.add(collider);
  }

  /* ------------------------------------------------------------------ */
  /* Placing                                                             */
  /* ------------------------------------------------------------------ */

  _applyPlace(world, entry, applied, unresolved) {
    const grant = grantForPlacement(entry.item);
    if (!grant || NEVER_PLACEABLE.has(grant.itemId) || !ITEMS[grant.itemId]) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'item' });
      return;
    }
    if (!this.loot?.spawn) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'no-loot' });
      return;
    }

    const p = entry.position;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'position' });
      return;
    }

    const count = Math.max(1, Math.floor(Number(entry.quantity) || 1));
    const contents = [{ itemId: grant.itemId, qty: grant.qty * count }];

    /* `persistent` exempts it from the fade timer and from pool recycling — a
     * placed item is a feature of the map, not litter from a firefight, and must
     * still be there when the player comes back. `snap:false` honours the height
     * the admin authored, which is what a crate on a rooftop ledge needs. Both
     * are exactly how `Interiors` places authored world caches. */
    const pickup = this.loot.spawn(new THREE.Vector3(p.x, p.y, p.z), contents, {
      persistent: true,
      snap: false,
      tag: `overlay:${entry.id}`,
    });

    if (!pickup) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'pool' });
      return;
    }
    this._placed.push(pickup);
    applied.push({ id: String(entry.id ?? ''), ok: true, colliders: 0 });
  }

  /* ------------------------------------------------------------------ */
  /* The catalogue an admin's client reports back                        */
  /* ------------------------------------------------------------------ */

  /**
   * Every named object in the world, nearest the root first.
   *
   * This is the only way the editor can offer real object names: nothing on the
   * server knows what a 12,945-line procedural world built. Breadth-first so
   * that when the cap bites it keeps the large, obviously-editable things —
   * buildings and props — rather than a thousand door handles from one corner
   * of the map.
   */
  _catalogue(world) {
    const out = [];
    const seen = new Set();
    const queue = [world.group];
    const at = new THREE.Vector3();

    while (queue.length && out.length < MAX_CATALOGUE) {
      const node = queue.shift();
      if (!node) continue;
      const name = typeof node.name === 'string' ? node.name.trim() : '';
      if (name && node !== world.group && !seen.has(name)) {
        seen.add(name);
        node.getWorldPosition(at);
        out.push({
          name,
          position: {
            x: Math.round(at.x * 1000) / 1000,
            y: Math.round(at.y * 1000) / 1000,
            z: Math.round(at.z * 1000) / 1000,
          },
        });
      }
      if (node.children) for (const child of node.children) queue.push(child);
    }
    return out;
  }

  dispose() {
    this._restore();
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}
