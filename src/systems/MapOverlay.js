import * as THREE from 'three';
import { ITEMS } from './ItemDefs.js';
import { consumableItemFor, mountPowerGrantFor } from './Marketplace.js';
import { COLLISION_LAYER } from '../physics/Physics.js';
import { planGrid, createJob, MAX_LAYERS, LAYOUT_SCHEMA } from './GroundSampler.js';
import { versionOf } from './overlayVersion.js';
import { isNotEditable } from './mapEditable.js';

/**
 * The admin map editor's placement overlay, applied to a world the game built.
 *
 * ── Why an overlay rather than an editor that writes world source ──────────
 *
 * Worlds here are procedural code and one of them (`MedievalWorld.js`) is
 * 12,945 lines. An editor that rewrote world source would collide head-on with
 * the art passes editing those same files. So the editor writes a SEPARATE,
 * versioned document — a set of moved, removed and placed instances — and this applies it
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
 * "Where the object goes" is where its ANCHOR goes: the world-space
 * bottom-centre of its bounds (`_anchor`), the same point the catalogue
 * reports for it. Not its `Object3D.position` - for station's baked Groups
 * that is the origin whatever the geometry says. The applier measures the
 * anchor at apply time and translates by the difference, which is still
 * absolute: the anchor lands at `position` however many times it runs.
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
 * The deployed bundle's own stamp, written beside it by
 * `site/scripts/bundle-game.mjs`.
 *
 * ── Why the editor needs this (spec D5) ────────────────────────────────────
 *
 * A layout report - the minimap shapes and the sampled ground grid the editor
 * snaps against - describes the world AS BUILT WHEN AN ADMIN LAST WALKED IT.
 * A redeploy that re-authors a district leaves that grid describing geometry
 * that no longer exists, and until now nothing compared the two: the editor
 * went on snapping props onto surfaces from the previous build, silently, and
 * the save route judged those positions against the same stale grid, so it
 * agreed. Phase 7 re-authors a district per release, which is exactly the
 * schedule that turns this from a hazard into a certainty.
 *
 * `commit` is the identity rather than a hash of the geometry. It is
 * conservative in the safe direction - two commits with identical station
 * geometry read as different, and the cost of that false alarm is an admin
 * walking back into the world for a few seconds - and it is EXACT, because
 * both sides read this same file. A geometry hash would need the game and the
 * site to agree on what to hash, which is a second thing to keep in step.
 */
const BUILD_STAMP = '/game/build.json';

/** The document shape this build reads (site/lib/mapOverlaySchema.ts MAP_OVERLAY_SCHEMA); pinned across the boundary by map-overlay.test.mjs. */
const OVERLAY_SCHEMA = 2;

/**
 * How long a `lookup`'s fetch may stay open before it is abandoned.
 *
 * `WorldManager._overlayVersion` races a lookup against a fuse and walks away
 * when the fuse wins; without this the fetch it walked away from stays open
 * on a dead connection until the tab closes, one per world, and its
 * `_inflight` entry with it. LONGER than the manager's longest fuse
 * (`OVERLAY_GATE_MS`, 8 s): the manager decides how long a BUILD waits, and
 * this only guarantees that a lost race closes its socket - an abort inside
 * the gate fuse would turn a slow answer the gate was still willing to take
 * into a failure. Pinned against the gate constant by map-overlay.test.mjs.
 * Reaching it is said by `lookup`, once per world: behind the loading gate
 * a prefetch can reach it BEFORE the build's own fuse (a warm longer than
 * ~2 s), and the null it then answers the manager with is an answer - the
 * manager says nothing.
 */
const LOOKUP_ABORT_MS = 10000;

/**
 * How many named objects the catalogue report carries.
 *
 * A world group holds tens of thousands of nodes. The catalogue exists to fill
 * the editor's object picker, so it takes named objects only, nearest the root
 * first, and stops. The server caps it again.
 */
const MAX_CATALOGUE = 2000;

/* The editor's picker opt-out. A leaf module for the reason `overlayVersion.js`
 * gives about itself: worlds need this and nothing else of the applier, and
 * importing it from here would drag this file's whole graph into StationKit and
 * its forty-odd importers. Re-exported so this file's own readers are unchanged. */
export { NOT_EDITABLE, isNotEditable } from './mapEditable.js';

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
/** `_translateWorld`'s two: a world delta and the origin, each through the parent's frame. */
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _box = new THREE.Box3();
const _shift = new THREE.Matrix4();
const _padded = new THREE.Box3();
const _aabb = new THREE.Box3();

/**
 * How far past a removed object's box a collider may reach and still be its
 * own (spec §6.3 said 5 cm). Authored boxes overhang on purpose - medieval
 * shells by +0.08 m on X and Z - so 5 cm finds nothing on the worlds most
 * likely to be edited, hides the mesh, and leaves exactly the wall the
 * remove was meant to take. Owner decision B: 0.10 m per axis.
 */
const REMOVE_TOLERANCE = 0.10;
/**
 * More colliders than this inside one named object's box is a district, not a
 * prop: `Box3.setFromObject` on a station district Group or a planet's
 * `planet:prop:*` InstancedMesh is the union of everything in it. Refused with
 * reason `span` and nothing hidden (decision B), rather than taking the deck
 * and the floor with it until the next save.
 */
const MAX_REMOVE_COLLIDERS = 200;

/**
 * The move side's mirror of `MAX_REMOVE_COLLIDERS`, for the same reason and
 * with the same number.
 *
 * This sweep had no cap at all. A remove refused a box holding more than 200
 * collider centres as "a district, not a prop"; a move took them all and said
 * nothing. Measured on the station before ownership existed: 236 of 744 named
 * objects were over that line on a move, 6 of them over ten thousand, and
 * `space` - a row near the TOP of the admin's picker, because the catalogue is
 * breadth-first - would have dragged all 26,352 colliders in the world on one
 * drag, reporting ok: true.
 *
 * Only the GUESS is capped. A move whose target owns its colliders is exempt,
 * because then the count is the answer rather than a symptom of a box being
 * too big to reason about.
 */
const MAX_MOVE_COLLIDERS = 200;

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
 * Resolve a marketplace item to what a placed pickup holds: the inventory
 * stack it grants, or - for a mount upgrade - the GRANT itself.
 *
 * The precedence follows `Marketplace._purchaseGrant`, which is what a PURCHASE
 * of the same row grants — a placed item and a bought item must be the same
 * thing, or the editor is quietly authoring a second economy.
 *
 * A mount upgrade is not stock: it raises a power tier on the rider's mount.
 * Nine of them - Bicycle Speed I-III, Bicycle Acceleration I-III, Hoverboard
 * Speed I-III - were placed on station and refused, with nothing to say why
 * beyond `item`. They resolve here to `{ grant }`, through the SAME parser a
 * purchase uses (`mountPowerGrantFor`), carrying the catalogue's name so the
 * pickup is labelled as the shop labels it; `_applyPlace` and `Loot` do the
 * rest.
 *
 * @param {{source_key?:string, name?:string, config?:Record<string,any>}} item
 * @returns {{itemId:string, qty:number}|{grant:{effect:'grant_mount_power', mount:string, power:string, tier:number, name:string}}|null}
 */
export function grantForPlacement(item) {
  const config = item?.config ?? {};
  const key = String(item?.source_key ?? '');

  const power = mountPowerGrantFor(config);
  if (power) {
    const name = typeof item?.name === 'string' ? item.name : '';
    return { grant: { effect: 'grant_mount_power', ...power, name } };
  }
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

/**
 * The build-time id a move or a remove targets, or null. An `{id}` names a
 * prop the BUILD placed (stage 3's registry); nothing here resolves one, so
 * the applier reports it and never applies it. An entry carrying both a
 * name and an id is an id entry - the site's normaliser writes neither.
 */
function targetId(entry) {
  const id = entry?.target?.id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * The key the last-wins pre-pass runs on (decision F): the name a move or a
 * remove acts on, or - in a key space of its own - the build-time id it
 * names, so two actions on one id supersede each other exactly as two on
 * one name do, and an id can never collide with a name that spells the
 * same string. A place has no target and is never keyed; neither is an
 * entry whose target names nothing.
 */
function actionKey(entry) {
  if (entry?.kind !== 'move' && entry?.kind !== 'remove') return null;
  const id = targetId(entry);
  if (id !== null) return `id:${id}`;
  const name = entry.target?.name;
  return typeof name === 'string' && name ? `name:${name}` : null;
}

export class MapOverlay {
  /**
   * @param {{ bus: import('../core/EventBus.js').EventBus, physics?: import('../physics/Physics.js').Physics,
   *   loot?: import('./Loot.js').LootSystem, engine?: { onFrameUpdate(fn: (dt:number) => void): () => void },
   *   mounts?: { sellsPower(mount:string, power:string): boolean, getPowers(mount:string): Record<string, number> },
   *   forceLayout?: boolean, fetch?: typeof fetch, now?: () => number, endpoint?: string, reportEndpoint?: string,
   *   buildStamp?: string }} ctx
   *   `engine` ticks the ground sampler; `mounts` is read - never written - so
   *   a placed mount upgrade can be refused for a power the mount does not
   *   sell and withheld from a rider who already owns it; `forceLayout` (the
   *   `?layout=sample` dev switch) samples without an admin session and never
   *   posts; `now` is the sampler's clock, injectable so a test can own the
   *   frame.
   */
  constructor({ bus, physics, loot, engine, mounts, forceLayout, fetch: fetchImpl, now, endpoint, reportEndpoint, buildStamp } = {}) {
    this.bus = bus ?? null;
    this.physics = physics ?? null;
    this.loot = loot ?? null;
    this.mounts = mounts ?? null;
    this.forceLayout = forceLayout === true;
    this.endpoint = endpoint ?? READ_ENDPOINT;
    this.reportEndpoint = reportEndpoint ?? REPORT_ENDPOINT;
    this.buildStamp = buildStamp ?? BUILD_STAMP;
    /** The deployed bundle's commit, read once and remembered; null until read, and null forever if it cannot be. */
    this._buildId = null;
    this._buildIdRead = null;
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
    this._schemaWarned = false;

    /** Last report: what was applied, what could not be, what exists. */
    this.report = { world: null, version: 0, builtVersion: 0, applied: [], unresolved: [], objects: [] };

    /** The world currently carrying overlay changes. */
    this._world = null;
    /**
     * The visit currently being applied. Bumped by every `_restore`, so an
     * `await` that outlives its visit can tell: compare the number it captured
     * with this one. The WORLD cannot be the token - WorldManager hands out the
     * same cached object on every visit to a non-volatile world, so after
     * A -> B -> A the object is the same and only the visit differs.
     */
    this._visit = 0;
    /** Undo records for `_world`. @type {Array<() => void>} */
    this._undo = [];
    /** Pickups this system spawned into `_world`. */
    this._placed = [];

    /**
     * Per-world documents for the BUILD (spec §4.1): filled by `lookup`,
     * refreshed by every post-build read. Per session and per world - it
     * cannot be keyed on a version the client has not fetched yet.
     * @type {Map<string, object>}
     */
    this._cache = new Map();
    /**
     * Lookups in flight - the shared promise and its abort - so two callers
     * for one world share one GET, and `dispose` can close one still open.
     * @type {Map<string, { promise: Promise<object|null>, abort: AbortController }>}
     */
    this._inflight = new Map();
    /** The abort ceiling, on the instance so a test can shorten it. */
    this.lookupAbortMs = LOOKUP_ABORT_MS;
    /**
     * Worlds whose lookup reached the ceiling and was said so - once per
     * world, not per attempt. A document admitted for the world forgets it,
     * so the next outage is news again.
     * @type {Set<string>}
     */
    this._lookupAbandoned = new Set();
    /**
     * Worlds whose read the server refused (a 5xx) and was said so - the same
     * discipline as `_lookupAbandoned`: once per world, forgotten when a
     * document for the world is admitted, so the next refusal is news again.
     * @type {Set<string>}
     */
    this._readRefused = new Set();
    /**
     * The abort of the read the CURRENT visit started, pulled by `_restore`
     * the moment the player leaves. Its answer would be dropped by visit
     * number anyway; this closes the socket it would have waited on.
     * @type {AbortController|null}
     */
    this._visitAbort = null;

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(
        bus.on('world:changed', ({ id, world }) => {
          this.applying = this._onWorldChanged(id, world);
        })
      );
      /* The ENTRY world's overlay is applied before the account's ledger
       * exists: boot activates the start world (main.js `activate(startWorld)`
       * → `world:changed` → `_applyPlace` reads `mounts.getPowers`) BEFORE
       * `hydrateAccountSession` restores the remote mounts and before the
       * local save's `_restoreMounts` on CONTINUE, and the already-active
       * world gets no second `world:changed`. So on every fresh boot the
       * apply-time owned check reads an empty ledger and spawns upgrades the
       * rider already holds - harmless in state (`grantPower` is a max) and
       * false as a promise. `game:started` fires after both restores; the
       * sweep there is what makes "once per account" true on the world the
       * player boots into. */
      this._offs.push(bus.on('game:started', () => this._sweepOwned()));
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
    const visit = this._visit;
    const abort = new AbortController();
    this._visitAbort = abort;

    /* ONE rule for every await in this visit: a portal can land while the read
     * is in flight, and again while the admin report-back is. If it did,
     * `_restore` has bumped `_visit` - undone this world, handed physics to the
     * world the player is in now - and this continuation belongs to a visit
     * that is over. It is dropped whole: not applied, not published, not
     * sampled. The test is the visit number, never the world object: a return
     * visit (A -> B -> A) is the SAME object, and a first-visit document that
     * lands during it would otherwise apply on top of the return visit's -
     * a pickup placed twice, an older version republished over a newer one. */
    const document = await this._read(id, abort.signal);
    if (visit !== this._visit) return;
    const admin = document?.admin === true;
    const report = document
      ? await this._applyDocument(id, world, document, admin)
      : this._publish({ world: id, version: 0, builtVersion: this._builtVersion(world), applied: [], unresolved: [], objects: [] });

    /* The ground is sampled AFTER the overlay is applied, so a moved building's
     * colliders are where the editor will draw them. Admin, or the dev switch;
     * and only for the visit that asked - the rule above. The job carries
     * THIS report. */
    if ((admin || this.forceLayout) && visit === this._visit) this._startSampling(id, world, admin, report);
  }

  /** Apply the entries, publish, and report; returns the report. */
  async _applyDocument(id, world, document, admin) {
    const entries = Array.isArray(document.entries) ? document.entries : [];
    const applied = [];
    const unresolved = [];
    const winner = this._lastActions(entries);
    // One clamp (`versionOf`) on both sides of the {id} gate below, so a
    // fractional or negative version cannot read one way here and another
    // on `world.builtVersion` and disagree about which is newer.
    const version = versionOf(document);
    const builtVersion = this._builtVersion(world);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') continue;
      // Owner decision F: the LAST action on a name - or on a build-time id -
      // in document order wins. Running the document in order is not enough
      // on its own - a remove drops the colliders, so a move after it would
      // find nothing to take along and leave the object hidden AND moved
      // with its colliders gone. An action a later one supersedes is skipped
      // whole and said so; the editor already warns both entries as
      // `duplicate-target`.
      const key = actionKey(entry);
      if (key !== null && winner.get(key) !== i) {
        unresolved.push({ id: String(entry.id ?? ''), reason: 'superseded' });
        continue;
      }
      try {
        // An {id} target is a build-time prop. Nothing resolves one until stage
        // 3's registry, so it is reported and never applied: pending-rebuild
        // when the document is newer than the build (a reload could consume
        // it), else id - the honest word, not a label that promises a reload
        // will fix it (owner decision D).
        if ((entry.kind === 'move' || entry.kind === 'remove') && targetId(entry) !== null) {
          unresolved.push({ id: String(entry.id ?? ''), reason: version > builtVersion ? 'pending-rebuild' : 'id' });
          continue;
        }
        // `hidden: true` is v1's spelling of a remove. The site's normaliser
        // migrates it to a `remove` on read (site/lib/mapOverlaySchema.ts,
        // schema 2), so a document served by this site never carries it; but
        // this bundle can meet a raw v1 document under a site ROLLBACK - the
        // previous site answering a browser that cached this bundle - and
        // must not let hidden objects reappear. (The other direction, a page
        // still on the previous bundle reading a v2 document, runs the OLD
        // applier, which no arm here can help: it skips every remove
        // unapplied and unreported until the page reloads.) Read as a remove
        // for one release - remove in the release after 4ace9a8, with its
        // two tests in scripts/tests/map-overlay.test.mjs. The remove route
        // DISCARDS the v1 move's `position` and `rotationY` (decision A), so
        // a hidden object is never also moved.
        if (entry.kind === 'remove' || (entry.kind === 'move' && entry.hidden === true)) {
          this._applyRemove(world, entry, applied, unresolved);
        } else if (entry.kind === 'move') this._applyMove(world, entry, applied, unresolved);
        else if (entry.kind === 'place') this._applyPlace(world, entry, applied, unresolved);
      } catch (err) {
        // One bad entry must never cost the player the world they are standing
        // in. It is reported, and the next entry is tried.
        console.warn('[map-overlay] entry failed:', entry?.id, err?.message ?? err);
        unresolved.push({ id: String(entry?.id ?? ''), reason: 'error' });
      }
    }

    const objects = admin ? this._catalogue(world) : [];
    // A new object every time: the document is frozen, and the editor reads
    // `version` (what this visit applied) beside `builtVersion` (what the
    // build consumed) to tell "enter the world" from "reload it".
    const report = { world: id, version, builtVersion, applied, unresolved, objects };
    this._publish(report);

    if (admin) await this._reportBack(report, world);
    return report;
  }

  /**
   * For every name - and, in a key space of its own, every build-time id -
   * the document acts on, the index of the LAST move or remove of it: the
   * one that wins (decision F). Places have no target and are not keyed.
   */
  _lastActions(entries) {
    const last = new Map();
    entries.forEach((entry, i) => {
      const key = actionKey(entry);
      if (key !== null) last.set(key, i);
    });
    return last;
  }

  /** Undo everything applied to the world this system last touched, and end its visit. */
  _restore() {
    this._visit++;
    // The read this visit started is unwanted from here. During an outage a
    // GET that nothing aborts stays open until the tab closes - one per
    // crossing, against a browser's six connections per host.
    this._visitAbort?.abort();
    this._visitAbort = null;
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
    this.sampling = Promise.resolve(null);
    this._world = null;
  }

  /**
   * One GET for the world's document. `signal` is the abort its caller owns:
   * a `lookup`'s ceiling, or the visit's, which `_restore` pulls when the
   * player leaves. An abort is that caller's own decision and is not said
   * here: the visit's is the player leaving, nothing to say; the ceiling's
   * is said by `lookup`, once per world, because behind the loading gate a
   * prefetch can reach it before the build's own fuse, and the null it then
   * answers is an ANSWER to the manager, which says nothing. A background
   * build that lost its fuse first is said twice, in different words - the
   * second says the lookup was abandoned at its ceiling. A read the server
   * REFUSED is said here, once per world, by the rule at the check below.
   * @param {string} worldId
   * @param {AbortSignal} [signal]
   */
  async _read(worldId, signal) {
    if (!this._fetch) return null;
    try {
      const init = { cache: 'no-store' };
      if (signal) init.signal = signal;
      const res = await this._fetch(`${this.endpoint}?world=${encodeURIComponent(worldId)}`, init);
      if (!res?.ok) {
        // A 4xx is this client's own standing, not an outage. This read is
        // issued for EVERY player on every world change (`_onWorldChanged`
        // does not consult the session; only the build's provider in main.js
        // is gated on it), and the route answers 401 to anyone signed out -
        // so a 401 said here would be one line per world for every anonymous
        // player, the harness's boot included. An admin whose session lapsed
        // gets the same 401 and the same silence; the editor shows it, as a
        // report that stops refreshing and version lines that read behind
        // after the next save. A 404 is a host without the route (the
        // frame-gaps static server). A 5xx is the server failing - the
        // route's own 503, a platform 502 - and is said once per world, news
        // again after a document for the world is admitted (`_admit`). A 429
        // is deliberately silent: nothing on the overlay path emits one (only
        // the chat and telemetry routes rate-limit), and under one a
        // signed-in admin's world would build at 0 unsaid - revisit the rule
        // if a 429 ever appears here.
        if (res?.status >= 500 && !this._readRefused.has(worldId)) {
          this._readRefused.add(worldId);
          console.warn(`[map-overlay] overlay unavailable for "${worldId}": HTTP ${res.status}`);
        }
        return null;
      }
      return this._admit(worldId, await res.json());
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      // Offline, signed out, or the endpoint is down. A world with no overlay is
      // exactly the world every player had before this phase existed.
      console.warn('[map-overlay] overlay unavailable:', err?.message ?? err);
      return null;
    }
  }

  /**
   * The one place a fetched document is judged and remembered, whichever
   * path fetched it - `lookup` for a build, `_read` on an entry - so a world
   * prefetched before the player ever enters it is held to the same rules,
   * and a newer schema is said once a session whichever path saw it first.
   *
   * Admitted means the route's shape - `world` is the world asked for and
   * `entries` is an array - and nothing else: a 200 carrying `{error}` is
   * not a document, and caching one would hand it to every build of the
   * world. What is admitted is FROZEN, the document and its entries array:
   * the build, the applier and every later lookup read one object, and
   * nobody edits it under the others - "the admin saved" is a new document.
   * The freeze is shallow: an entry's own object is not frozen, and nothing
   * on the apply path writes into one today - every report is built from
   * new objects - so a write there would be a new kind of bug, not a
   * guarded one.
   * @param {string} worldId
   * @param {unknown} data
   * @returns {object|null}
   */
  _admit(worldId, data) {
    if (!data || typeof data !== 'object') return null;
    // The server answers the world it was asked about; a document about a
    // different world is a stale reply that arrived after a portal.
    if (data.world !== worldId || !Array.isArray(data.entries)) return null;
    Object.freeze(data.entries);
    Object.freeze(data);
    // Newer than this build reads. Every kind it knows still applies and the
    // rest is skipped (spec §5, the v1-client rule); said once a session.
    if (Number(data.schema) > OVERLAY_SCHEMA && !this._schemaWarned) {
      this._schemaWarned = true;
      console.warn(`[map-overlay] document schema ${data.schema} is newer than ${OVERLAY_SCHEMA}; unknown entries are skipped`);
    }
    // The document a later build of this world should consult (a volatile
    // rebuild after an in-session save). Version-monotonic: this runs on
    // the same late continuation `_onWorldChanged` drops by visit number,
    // and a slow first read can answer an OLDER version after a return
    // visit cached a newer one. Versions are append-only on the site (a
    // revert writes a new, higher one), so higher is always newer.
    const have = this._cache.get(worldId);
    if (!(versionOf(have) > versionOf(data))) this._cache.set(worldId, data);
    // The outage is over: the next lookup of this world to reach the ceiling,
    // or the next read of it the server refuses, is news again.
    this._lookupAbandoned.delete(worldId);
    this._readRefused.delete(worldId);
    return data;
  }

  _publish(report) {
    this.report = report;
    this.bus?.emit?.('map-overlay:applied', report);
    return report;
  }

  /**
   * The deployed bundle's commit, read once per session.
   *
   * READ ONCE AND CACHED, including the failure: a build with no stamp beside
   * it - a source checkout served by vite, a bundle built before this existed -
   * must not re-fetch a 404 on every report. The promise is the cache, so two
   * reports racing on the same visit make one request.
   *
   * A missing or unreadable stamp yields null and the report simply omits the
   * field, which the site reads as "this build cannot say". That is the right
   * failure: the editor then has no identity to compare and says so, rather
   * than comparing against an empty string and calling everything stale.
   */
  async _buildIdOf() {
    if (this._buildId !== null) return this._buildId;
    this._buildIdRead ??= (async () => {
      if (!this._fetch) return null;
      try {
        const res = await this._fetch(this.buildStamp, { cache: 'no-store' });
        if (!res?.ok) return null;
        const stamp = typeof res.json === 'function' ? await res.json() : null;
        const commit = stamp && typeof stamp === 'object' ? stamp.commit : null;
        // 'unknown' is what the bundler writes for a checkout with no git
        // history. It is not an identity - every such build would claim to be
        // the same one - so it is refused here rather than compared later.
        return typeof commit === 'string' && commit && commit !== 'unknown' ? commit.slice(0, 64) : null;
      } catch {
        return null;
      }
    })();
    this._buildId = await this._buildIdRead;
    return this._buildId;
  }

  async _reportBack(report, world, ground = null) {
    if (!this._fetch) return;
    try {
      const buildId = await this._buildIdOf();
      const body = {
        world: report.world,
        appliedVersion: report.version,
        // What the world's BUILD consumed, beside what this visit applied: a
        // cached world was built against whatever existed at build time, and
        // the two together are how the editor tells "enter" from "reload".
        // On BOTH reports of a visit - the layout report carries the same
        // object. There is no `schema` field: the layout axis is
        // `layoutSchema`, and a bump there erases every stored grid.
        builtVersion: report.builtVersion ?? 0,
        objects: report.objects,
        applied: report.applied,
        unresolved: report.unresolved,
        // Which BUILD of the game walked this world, so the editor can tell
        // whether the grid it is snapping against describes the geometry that
        // is deployed now. Omitted, not nulled, when this build cannot say:
        // the site distinguishes "a different build" from "no idea".
        ...(buildId ? { buildId } : {}),
        // The layout fields every report carries, and - on the second
        // report of a visit only - the sampled ground.
        ...this._layoutFields(world),
        ...(ground ? { ground } : {}),
      };
      const res = await this._fetch(this.reportEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      // A 413 over the site's layout cap, or a 400, is a refusal, not a throw:
      // said once (spec §10), never retried - the next visit reports afresh.
      if (!res?.ok) {
        console.warn('[map-overlay] the editor refused the report:', res?.status);
        return;
      }
      // A 200 stores the catalogue whatever became of the layout; the site
      // answers `layout: 'stored' | 'kept-prior' | 'none'` with its reasons,
      // and a map that did not land is said here, once per report, because
      // this console is the one an admin is looking at. An older site with no
      // `layout` field, or a body that does not parse, says nothing:
      // compatibility, not a fault.
      if (!('layoutSchema' in body)) return;
      let answer = null;
      try {
        answer = typeof res.json === 'function' ? await res.json() : null;
      } catch {
        return;
      }
      if (answer && typeof answer === 'object' && 'layout' in answer && answer.layout !== 'stored') {
        const reasons = Array.isArray(answer.warnings) ? answer.warnings : [];
        console.warn('[map-overlay] layout ' + answer.layout + ': ' + reasons.join('; '));
      }
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

  /**
   * What the world's BUILD consumed (`WorldManager._runBuild`); 0 for a
   * world built with no provider, or a rig world that declares no such
   * field. Through `versionOf` rather than a copy of its arithmetic, so the
   * two sides of the {id} gate cannot drift apart.
   */
  _builtVersion(world) {
    return versionOf({ version: world?.builtVersion });
  }

  /* ------------------------------------------------------------------ */
  /* The ground grid                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Start a job for `world`; `post`: to the editor (admin) or only the bus
   * (dev switch); `report`: what the layout report will carry alongside the
   * grid - the one published for THIS world, whatever is published meanwhile.
   */
  _startSampling(id, world, post, report) {
    this._cancelSampling();
    // The same bounds the report carries, so a world whose bounds the report
    // omits (a NaN height, an empty Box3) samples nothing: every cell would be
    // NO_SAMPLE, and posting that would replace the last good grid.
    const { bounds } = this._layoutFields(world);
    const plan = this.physics && bounds ? planGrid(bounds) : null;
    if (!plan) {
      console.warn(`[map-overlay] ground not sampled for ${id}: ${this.physics ? 'bounds are not usable' : 'no physics'}`);
      return;
    }
    const job = createJob(plan, (x, yTop, z, maxDrop) => this._castDown(x, yTop, z, maxDrop), {
      layers: MAX_LAYERS,
      // The dome and a 260 m planet are both above groundHeight's 200 m default.
      topY: bounds.max.y + 10,
      floorY: bounds.min.y - 20,
    });
    job.world = id;
    job.target = world;
    job.report = report;
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
    const posted = job.post ? this._reportBack(job.report, job.target, ground) : Promise.resolve();
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
  /* The document a build consults                                       */
  /* ------------------------------------------------------------------ */

  /**
   * The world's document for `WorldManager._runBuild` (`ctx.overlayProvider`,
   * wired in main.js): the cached one, or one fetch shared by everyone asking.
   * The cached one is the LAST document an entry of this world fetched (or
   * this lookup's own, before any entry) - not whatever the site holds now:
   * a volatile rebuild after an in-session save builds against the version
   * the player's last entry read, and the entry after it refreshes this.
   * A failure answers null and caches nothing, so the next build asks again.
   * One fetch per build plus one per entry (`_read`, which refreshes this) -
   * spec §6.4's "one cached fetch per world per session" as built.
   *
   * Each fetch owns an abort with a ceiling past the manager's longest fuse
   * (`LOOKUP_ABORT_MS`), so a race the manager lost still closes its
   * connection and clears its in-flight entry. A document that lands
   * between the manager's fuse and the ceiling IS cached - and closes the
   * breaker; only what it would have answered past the ceiling is never
   * cached. Reaching the ceiling is said once per world, not per attempt -
   * the manager cannot say it, the null it is answered with is an answer -
   * and is news again after a document for that world is admitted.
   * @param {string} worldId
   * @returns {Promise<object|null>}
   */
  lookup(worldId) {
    const cached = this._cache.get(worldId);
    if (cached) return Promise.resolve(cached);
    let inflight = this._inflight.get(worldId);
    if (!inflight) {
      const abort = new AbortController();
      const ceiling = setTimeout(() => {
        abort.abort();
        if (this._lookupAbandoned.has(worldId)) return;
        this._lookupAbandoned.add(worldId);
        console.warn(`[map-overlay] lookup for "${worldId}" abandoned after ${this.lookupAbortMs / 1000} s`);
      }, this.lookupAbortMs);
      const promise = this._read(worldId, abort.signal).finally(() => {
        clearTimeout(ceiling);
        this._inflight.delete(worldId);
      });
      inflight = { promise, abort };
      this._inflight.set(worldId, inflight);
    }
    return inflight.promise;
  }

  /** Start a lookup so the entry world's fetch overlaps the loading gate (main.js, before the entry build). */
  prefetch(worldId) {
    void this.lookup(worldId).catch(() => null);
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
    this._undo.push(() => {
      target.position.copy(originalPosition);
      target.rotation.y = originalRotationY;
      target.updateMatrixWorld(true);
    });

    const to = entry.position;
    let colliders = 0;
    if (to && Number.isFinite(to.x) && Number.isFinite(to.y) && Number.isFinite(to.z)) {
      // The world AABB is taken BEFORE the move: it decides which colliders
      // belong to this object, and its bottom-centre is the anchor the move
      // lands at `position`. `_anchor` leaves the box in `_box`.
      this._anchor(target, _before);
      _delta.set(to.x, to.y, to.z).sub(_before);

      // Sweep FIRST, on the untouched box: the second `_anchor` below
      // overwrites `_box`. The sweep reads collider centres only, never the
      // object, so it does not care that the object has not moved yet.
      colliders = this._moveColliders(_box, _delta, name);
      if (colliders < 0) {
        /* The guess was too wide to trust - more than `MAX_MOVE_COLLIDERS`
         * centres inside the box, and nothing owns the name. Refused with the
         * SAME reason a remove uses for the same judgement (`span`), and
         * nothing is moved: a mesh translated away from the collision it
         * stands for is the invisible wall this whole file exists to prevent,
         * and a partial move would be worse than either. The undo entry
         * pushed above is a no-op restore, which is correct - nothing moved. */
        unresolved.push({ id: String(entry.id ?? ''), reason: 'span' });
        return;
      }
      this._translateWorld(target, _delta);

      if (Number.isFinite(entry.rotationY)) {
        target.rotation.y = entry.rotationY;
        // Yaw turns the object about its own origin, which for a baked Group
        // is the world axis, not its anchor: a 10 degree turn at a radius of
        // 100 m would carry it 17 m. Measure where the anchor went and put it
        // back at `to`. Colliders translate but never rotate, for any target.
        this._anchor(target, _after);
        this._translateWorld(target, _delta.set(to.x, to.y, to.z).sub(_after));
      }
    } else if (Number.isFinite(entry.rotationY)) {
      // Rotation only: the anchor stays where it was.
      this._anchor(target, _before);
      target.rotation.y = entry.rotationY;
      this._anchor(target, _after);
      this._translateWorld(target, _before.sub(_after));
    }

    applied.push({ id: String(entry.id ?? ''), ok: true, colliders });
  }

  /**
   * Translate `target` by a WORLD-space vector, whatever its parent's frame.
   * `target.position` is in its parent's space, so the delta is carried
   * through the parent's inverse linear part - a moved, turned or unevenly
   * scaled ancestor cannot bend it.
   */
  _translateWorld(target, delta) {
    const parent = target.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      // worldToLocal(delta) - worldToLocal(0) is the parent's inverse linear
      // part applied to delta: the translation cancels.
      parent.worldToLocal(_p0.copy(delta));
      parent.worldToLocal(_p1.set(0, 0, 0));
      target.position.add(_p0.sub(_p1));
    } else {
      target.position.add(delta);
    }
    target.updateMatrixWorld(true);
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
  /**
   * The colliders a named object OWNS, or null when nothing claims that name.
   *
   * ── Why this exists beside two geometric guesses ─────────────────────────
   * `Physics` stores baked world-space geometry with no back-reference to the
   * `Object3D` it came from, so "which colliders are this object's?" could
   * only ever be answered by geometry - and the two answers disagree. A remove
   * takes what is FULLY INSIDE the object's box, missing overhangs and
   * refusing past `MAX_REMOVE_COLLIDERS`; a move takes what has its CENTRE in
   * the box, uncapped. Measured on the station, that let 236 of 744 named
   * objects drag more colliders on a move than a remove is allowed even to
   * consider, and `space` drag all 26,352 in the world, on a green row.
   *
   * `Collider.ownerId` ends the guessing where the world knows the answer:
   * `StationWorld` chunks its geometry-derived collision per owner and tags
   * each prop's box with the mesh that drew it. Not everything carries one -
   * hand-authored structure mostly does not - and null here means exactly
   * that: fall back to the geometric test, do not claim ownership.
   *
   * Returns null (not an empty array) when NO collider carries the name, so a
   * caller can tell "this object owns nothing" from "nobody has claimed this
   * name" and pick the fallback deliberately.
   */
  _collidersOwnedBy(name) {
    const physics = this.physics;
    if (!physics || !name) return null;
    const owned = [];
    for (const collider of physics.colliders) {
      if (collider?.ownerId === name) owned.push(collider);
    }
    return owned.length ? owned : null;
  }

  _moveColliders(box, delta, name = null) {
    const physics = this.physics;
    if (!physics || delta.lengthSq() === 0) return 0;

    /* Ownership first. When the world tagged these colliders, this is not a
     * guess and there is nothing to cap: the object owns what it owns, and a
     * move that carried fewer would leave a wall behind - the exact defect the
     * applier was written to prevent. */
    let moving = this._collidersOwnedBy(name);

    if (!moving) {
      /* Nobody claimed the name, so fall back to the geometric guess - and cap
       * it, which this sweep never did. `MAX_MOVE_COLLIDERS` mirrors the
       * remove side's refusal for the same reason: a box that contains
       * thousands of collider centres is a district, not a prop, and dragging
       * a district's collision on one click is worse than not dragging at all.
       * Refusing is reported as 0 moved, which the editor already surfaces. */
      moving = [];
      for (const collider of physics.colliders) {
        if (!collider || collider.type === 'heightfield') continue;
        if (!box.containsPoint(collider.center)) continue;
        moving.push(collider);
        if (moving.length > MAX_MOVE_COLLIDERS) return -1;
      }
    }
    if (moving.length === 0) return 0;

    const dx = delta.x;
    const dy = delta.y;
    const dz = delta.z;

    for (const collider of moving) {
      const reattach = this._detach(collider);

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

      if (reattach) physics.add(collider);
      const undoDelta = delta.clone();
      this._undo.push(() => this._shiftCollider(collider, undoDelta.clone().negate()));
    }
    return moving.length;
  }

  /**
   * Take a collider out of the broadphase before mutating it in place, and say
   * whether to put it back afterwards.
   *
   * ── The rule: re-add only what `_activate` did not already re-add ──────
   *
   * `_restore` runs from `world:changed`, and by then `WorldManager._activate`
   * has cleared physics and re-added the ENTERED world's own colliders. So a
   * collider this system moved is in one of two states when its undo runs:
   *
   *  - registered: a same-world re-entry. `_activate` re-added it from
   *    `world.colliders` (at the moved position, since it is the same object).
   *    Our `remove` takes it out; shift it back; re-add it. Once.
   *
   *  - not registered: the player went elsewhere. Shift it back so the world
   *    object is right for its next visit, but do NOT add it - this physics
   *    now belongs to another world, and the re-add would be an invisible
   *    wall in it at the old world's authored position. Before this rule,
   *    that is exactly what shipped.
   *
   * `Physics.remove` returns false when the collider is not registered here,
   * which is the whole test. Stated once: the remove undo faces the same two
   * cases and answers both by adding nothing.
   *
   * @returns {boolean} whether the caller should `physics.add` it back
   */
  _detach(collider) {
    return this.physics.remove(collider) === true;
  }

  /** The single-collider half of `_moveColliders`, used to undo one. */
  _shiftCollider(collider, delta) {
    const physics = this.physics;
    if (!physics || !collider) return;
    const reattach = this._detach(collider);
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
    if (reattach) physics.add(collider);
  }

  /* ------------------------------------------------------------------ */
  /* Removing                                                            */
  /* ------------------------------------------------------------------ */

  _applyRemove(world, entry, applied, unresolved) {
    const name = entry?.target?.name;
    const target = typeof name === 'string' && name ? world.group.getObjectByName(name) : null;
    if (!target) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'name' });
      return;
    }

    // The box is taken from the object as the world built it, before anything
    // changes: it is what decides which colliders are this object's.
    target.updateWorldMatrix(true, false);
    _box.setFromObject(target);
    const dropping = this._collidersInside(_box, name);
    if (dropping === null) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'span' });
      return;
    }

    const originalVisible = target.visible;
    target.visible = false;
    for (const collider of dropping) this.physics.remove(collider);

    /* The undo puts the mesh back and puts NOTHING into physics. Registration
     * is WorldManager._activate's: it rebuilds the collision world from
     * `world.colliders` - on which the dropped colliders still sit - before
     * `world:changed` fires. So when this undo runs the collider is either
     * already back (a same-world re-entry) or in a physics that now belongs
     * to another world (a portal): the two cases `_detach` names for a move,
     * and in neither is an `add` from here right. The first would register
     * it twice; the second is the leak the hotfix removed. Known limit: a
     * `dispose()` on a LIVE world runs this undo on the same physics, so the
     * mesh comes back and its collider does not. Nothing calls `dispose()`
     * at runtime (main.js never does; it is teardown), so it is stated here
     * rather than handled. */
    this._undo.push(() => {
      target.visible = originalVisible;
    });
    applied.push({ id: String(entry.id ?? ''), ok: true, colliders: dropping.length });
  }

  /**
   * Every collider whose OWN world AABB lies inside `box` grown by
   * REMOVE_TOLERANCE, or null when there are more than MAX_REMOVE_COLLIDERS.
   *
   * Containment, never centre-in-box: the move heuristic's failure mode is
   * under-moving, which is safe; inverted for a remove it would be
   * over-removing - a fence post whose centre sits inside a house-sized box
   * vanishes with the house (spec §6.3). A trimesh chunk that straddles the
   * box stays (station's chunks are spatial cells, not objects).
   *
   * Excluded by TYPE: heightfields, the ground. Excluded by TAG: any collider
   * with a non-null `userData` - portal plinths, landed ship hulls, a planet's
   * floor, liquid barriers and edge walls - volumes other systems own and
   * rebuild before this applies. `layer` and `solid` are not consulted: a
   * trigger inside a removed prop belongs to the prop, exactly as
   * `_moveColliders` takes it along with the prop.
   */
  _collidersInside(box, name = null) {
    const physics = this.physics;
    if (!physics) return [];
    /* Ownership first, and EXEMPT from `MAX_REMOVE_COLLIDERS`.
     *
     * The cap exists because containment is a guess: a district Group's box is
     * the union of everything in it, so "200 colliders inside" means "this box
     * is too big to reason about", not "this object is large". When the world
     * has tagged the colliders, the count is not a guess - it is the answer -
     * and refusing it would hide a mesh while leaving the wall it stands for,
     * which is precisely what `span` exists to avoid. The editor still warns
     * above `WIDE_REMOVE_COLLIDERS`, which is the right place for "are you
     * sure": a number the admin can see, not a refusal they cannot override. */
    const owned = this._collidersOwnedBy(name);
    if (owned) return owned;

    _padded.copy(box).expandByScalar(REMOVE_TOLERANCE);
    const inside = [];
    for (const collider of physics.colliders) {
      if (!collider || collider.type === 'heightfield' || collider.userData != null) continue;
      const aabb = physics.colliderAabb(collider, _aabb);
      // An empty box (a type colliderAabb does not know) is contained by
      // EVERY box in three's `containsBox`; it must never read as "inside".
      if (aabb.isEmpty() || !_padded.containsBox(aabb)) continue;
      inside.push(collider);
      if (inside.length > MAX_REMOVE_COLLIDERS) return null;
    }
    return inside;
  }

  /* ------------------------------------------------------------------ */
  /* Placing                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * True when the rider already holds `grant`'s tier, or a higher one, on
   * that mount: `grantPower` is max(existing, tier), so collecting it would
   * change nothing. Read at apply time (the fast path) and again at
   * `game:started`, once the account's ledger is actually there.
   */
  _ownsGrant(grant) {
    const owned = Number(this.mounts?.getPowers?.(grant.mount)?.[grant.power] ?? 0);
    return owned >= grant.tier;
  }

  /**
   * Take away every placed upgrade the restored ledger says the rider owns.
   * Silent - `despawn`, never a collect - so no `loot:collected` and no
   * `mount:power:buy` for a tier that was already theirs. Item pickups have
   * no tier and are left alone. See the `game:started` subscription.
   */
  _sweepOwned() {
    if (!this._placed.length) return;
    const keep = [];
    for (const pickup of this._placed) {
      const grant = pickup?.contents?.[0]?.grant;
      if (grant && this._ownsGrant(grant)) {
        try {
          this.loot?.despawn?.(pickup);
        } catch {
          /* a pickup the loot pool already recycled is not an error */
        }
        continue;
      }
      keep.push(pickup);
    }
    this._placed.length = 0;
    this._placed.push(...keep);
  }

  _applyPlace(world, entry, applied, unresolved) {
    const grant = grantForPlacement(entry.item);
    const power = grant?.grant ?? null;
    if (!grant) {
      unresolved.push({ id: String(entry.id ?? ''), reason: 'item' });
      return;
    }
    /* A mount upgrade is refused with the SAME reason as an unknown item when
     * the mount does not sell the power (Fire on a horse): `MountManager.
     * grantPower` would drop the grant silently, and a pickup that grants
     * nothing is a lie on the ground. No `mounts` to ask is the same refusal -
     * a game that cannot vouch for the grant does not spawn it. The reason
     * set is pinned by site/lib/mapReasonsContract.test.ts; `item` is what
     * these nine rows were always refused with, and the editor's row now
     * says so beside the name. An item is refused when it is `credits` (a
     * balance, not a pickup) or one `ITEMS` does not define. */
    const refused = power ? !this.mounts?.sellsPower?.(power.mount, power.power) : NEVER_PLACEABLE.has(grant.itemId) || !ITEMS[grant.itemId];
    if (refused) {
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

    /* ONCE PER ACCOUNT (owner decision). A rider who already holds the tier,
     * or a higher one, finds no pickup: a pickup that changes nothing is one
     * the player walks to for nothing. The entry is reported APPLIED, not
     * unresolved - the grant's whole effect is already in force on this
     * account, which is what "applied" means for it; there is nothing for
     * the admin to fix, and no new field goes on the wire. The pickup dies
     * on collection (`Loot._collect`), so the next visit lands here rather
     * than spawning it again. This is the fast path; on the entry world the
     * ledger is not yet restored when this runs, and `_sweepOwned` at
     * `game:started` finishes the job. */
    if (power && this._ownsGrant(power)) {
      applied.push({ id: String(entry.id ?? ''), ok: true, colliders: 0 });
      return;
    }

    /* A tier is not a stack: `quantity` multiplies an item's count and is
     * ignored for a grant, which holds exactly one. */
    const count = Math.max(1, Math.floor(Number(entry.quantity) || 1));
    const contents = power ? [{ grant: power, qty: 1 }] : [{ itemId: grant.itemId, qty: grant.qty * count }];

    /* `persistent` exempts it from the fade timer and from pool recycling — a
     * placed item is a feature of the map, not litter from a firefight, and must
     * still be there when the player comes back, exactly as `Interiors` places
     * authored world caches.
     *
     * ── `snap`, and why it is the document's decision ────────────────────────
     * A placement is unreachable if it hangs above the floor: auto-collect has a
     * 1.7 m range and an admin dragging on a 2D map cannot see height. So the
     * DEFAULT is to snap - `Loot.spawn` casts `groundHeight(x, z, y + 1.6, 6)`
     * and takes the surface it finds.
     *
     * But snapping unconditionally is also wrong, and was briefly shipped that
     * way: a crate authored onto a rooftop ledge, a gantry or a mezzanine falls
     * to the deck, and nothing anywhere says it moved. That version read
     * `snap: contents.length > 0` against a `contents` built one line above as a
     * ternary between two SINGLE-ELEMENT array literals - always true, so the
     * "visual-only items keep their height" case its own comment described could
     * never run.
     *
     * So it is a field the document carries. Absent means snap, which is what
     * every placement saved before the field existed wants and needs no
     * migration; only an explicit `false` opts out, and only an admin who has
     * decided the height is deliberate writes one.
     *
     * Note what the probe can still do even when snapping is wanted: the window
     * is 7.6 m tall, so a surface up to 1.6 m ABOVE the authored point wins, and
     * a placement over a void finds nothing and stays where it was authored. */
    const pickup = this.loot.spawn(new THREE.Vector3(p.x, p.y, p.z), contents, {
      persistent: true,
      snap: entry.snap !== false,
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
   * Where a node STANDS: the world-space bottom-centre of its bounds, into
   * `out`. Its world position when it has nothing to draw (a light's parent,
   * an empty layer) - the box of such a node is empty, and its origin is the
   * only place it has.
   *
   * Not `getWorldPosition`. Station's named objects are Groups whose geometry
   * is baked in world space and whose own position is the origin, so their
   * world position IS the origin: in production, 755 of the station's 756
   * catalogue entries reported (0, 0, 0), every mark on the editor's map sat
   * on one pixel, and nothing could be selected. The bottom-centre is also
   * what the editor's ground check wants - an object standing on the ground
   * has its anchor's Y at the ground.
   *
   * Leaves `_box` holding the node's world AABB, which `_applyMove` reuses
   * for its collider sweep: the anchor and the sweep read one measurement.
   * Every later call overwrites `_box`, which is why `_applyMove` sweeps
   * BEFORE it measures the anchor a second time after a yaw.
   */
  _anchor(node, out) {
    node.updateWorldMatrix(true, false);
    _box.setFromObject(node);
    if (_box.isEmpty()) return node.getWorldPosition(out);
    return out.set((_box.min.x + _box.max.x) / 2, _box.min.y, (_box.min.z + _box.max.z) / 2);
  }

  /**
   * Every named object in the world, nearest the root first, each with the
   * anchor it stands on (`_anchor`).
   *
   * This is the only way the editor can offer real object names: nothing on the
   * server knows what a 12,945-line procedural world built. Breadth-first so
   * that when the cap bites it keeps the large, obviously-editable things —
   * buildings and props — rather than a thousand door handles from one corner
   * of the map.
   *
   * Cost: one `Box3.setFromObject` per named node, which walks that node's
   * subtree - so a district Group pays for every mesh under it, and a named
   * node under a named node is walked twice. Admin-only, once per visit.
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
      /* Skipped, not renamed: see `NOT_EDITABLE`. The subtree is still walked -
       * a node the editor should not offer can still contain one it should. */
      const offerable = !isNotEditable(node);
      /* A withheld name is RESERVED, not merely skipped: `seen` takes it either
       * way, so a second node carrying the same string cannot be offered under
       * it. Without that, one `ramp-proxy` could be withheld and a different
       * one offered, and the row would resolve to neither reliably. */
      if (name && node !== world.group && !seen.has(name)) {
        seen.add(name);
        if (!offerable) { if (node.children) for (const child of node.children) queue.push(child); continue; }
        this._anchor(node, at);
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
    this._cache.clear();
    for (const { abort } of this._inflight.values()) abort.abort();
    this._inflight.clear();
    this._lookupAbandoned.clear();
    this._readRefused.clear();
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }
}
