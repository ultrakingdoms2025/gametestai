/**
 * The placement overlay document: what an admin may say about a world.
 *
 * ── Why an overlay at all ──────────────────────────────────────────────────
 *
 * Worlds in this game are procedural code, and one of them (`MedievalWorld.js`)
 * is 12,945 lines. An editor that rewrote world source would collide head-on
 * with the art passes that are editing those same files right now. So the
 * editor writes a SEPARATE document — a set of moved, removed and placed instances — and
 * the game applies it after the world has finished building. The two surfaces
 * never touch, and every change is revertible because nothing was overwritten.
 *
 * ── Why this module imports nothing ────────────────────────────────────────
 *
 * Same reason `adminAllowlist.ts` imports nothing: the decision has to be
 * testable without loading `pg` or next-auth. Everything here is a pure
 * function over plain data, so the cases below are cheap to enumerate and there
 * is no way to be "mostly right" about them in a mock.
 *
 * ── The two rules worth stating out loud ───────────────────────────────────
 *
 * 1. **A move carries an ABSOLUTE position, never a delta.** The overlay is
 *    applied once per world load. A delta compounds: the crate walks a little
 *    further off every time the player comes back, and nothing in the document
 *    would look wrong. An absolute point is idempotent by construction, which
 *    is the only property that makes "apply on every load" safe.
 *
 * 2. **Every coordinate is finite and bounded.** Three will happily accept NaN
 *    or 1e30, the object's matrix goes non-finite, and it — plus whatever else
 *    shares a bounding computation with it — vanishes with no error anywhere.
 *    A rejected entry is visible in the editor; a NaN is not visible at all.
 */

/** Bumped when the shape below changes in a way a reader must notice. 2: `remove` is a kind, a target may be an `{id}`, and `hidden` is read as a remove. */
export const MAP_OVERLAY_SCHEMA = 2;

/**
 * How many entries one world's overlay may hold.
 *
 * Not a storage limit — JSONB would take far more. It is the point past which a
 * document has stopped being "an admin adjusted the map" and started being
 * something that will cost frame time on every world load.
 */
export const MAX_OVERLAY_ENTRIES = 500;

/**
 * Coordinate bound, metres from origin.
 *
 * The physics broadphase packs cell coordinates assuming worlds stay inside
 * ±2048 m (`Physics._cellKey`). This is deliberately looser than that: the job
 * here is to refuse `NaN`, `Infinity` and `1e30`, not to second-guess where a
 * world put its geometry. Anything beyond this is a typo or an attack.
 */
export const WORLD_COORD_LIMIT = 20_000;

/**
 * Every world the game can enter.
 *
 * Mirrors `static id` on each `World` subclass plus the ten planet descriptors.
 * `scripts/tests/map-overlay.test.mjs` scrapes both sides and fails if they
 * drift, because an overlay saved against a world id the game does not have is
 * a document that can never be applied and will never say why.
 */
export const OVERLAY_WORLDS = [
  'station',
  'medieval',
  'sports',
  'citadel',
  'race',
  'dock',
  'maze',
  'space',
  'carnelian',
  'cathedra',
  'lathe',
  'sallow',
  'shoal',
  'sirocco',
  'tessera',
  'verdigris',
  'vitrine',
  'cinder',
] as const;

export type OverlayWorld = (typeof OVERLAY_WORLDS)[number];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * What an entry acts on: a named Object3D the applier resolves live, or a
 * registry id the BUILD resolves (stage 3; this stage accepts the shape so no
 * further bump is needed). Ids are `family@x,z[#n]` - the authored position at
 * 0.1 m, `#n` only when two props of one family share a spot - and the family
 * may carry a namespace, as medieval's `medieval:${key}` batch keys do.
 */
export type Target = { name: string } | { id: string };

export interface MoveEntry {
  kind: 'move';
  id: string;
  target: Target;
  /** Absolute world position. A move always says where; taking an object out of the world is a `remove`. */
  position: Vec3;
  rotationY?: number;
}

export interface RemoveEntry {
  kind: 'remove';
  id: string;
  target: Target;
}

/** A registry id may be this long (spec §5). A truncated id would be a DIFFERENT id, so an over-long one is refused, not cut. */
export const TARGET_ID_MAX = 128;
const TARGET_ID_RE = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*@-?\d+(?:\.\d)?,-?\d+(?:\.\d)?(?:#\d+)?$/;

export function targetName(t: Target): string | null {
  return 'name' in t ? t.name : null;
}

export function targetLabel(t: Target): string {
  return 'name' in t ? t.name : t.id;
}

/** Scalar-only, one level deep. See `readConfig`. */
export type GrantConfig = Record<string, string | number | boolean>;

export interface PlaceEntry {
  kind: 'place';
  id: string;
  /**
   * `config` is a COPY of the catalogue row's `action_config` at the moment the
   * admin placed it. Copied rather than referenced on purpose: a placement is a
   * decision taken at a moment in time, and re-describing the catalogue row
   * afterwards should not silently change what a crate on a hillside contains.
   */
  item: { source_key: string; name: string; config: GrantConfig };
  position: Vec3;
  rotationY?: number;
  quantity: number;
}

export type OverlayEntry = MoveEntry | RemoveEntry | PlaceEntry;

export type RejectReason =
  | 'kind'
  | 'target'
  | 'item'
  | 'position'
  | 'duplicate'
  | 'overflow';

export interface RejectedEntry {
  index: number;
  id: string | null;
  reason: RejectReason;
}

export interface NormalisedOverlay {
  entries: OverlayEntry[];
  rejected: RejectedEntry[];
}

const TWO_PI = Math.PI * 2;

/**
 * Rounding slack, in radians, used when deciding whether an angle is outside a
 * single turn.
 *
 * Without it this function is not idempotent, and the failure is subtle enough
 * to be worth writing down. Angles are rounded to six decimals for storage, so
 * π becomes 3.141593 — which is *greater* than π. A strict `w > Math.PI` test
 * then wraps it to −3.141592 on the next pass, and back again on the pass after
 * that: the same document normalises to two different values, forever. Treating
 * anything within the rounding step of the boundary as already inside the turn
 * makes the function a fixed point.
 */
const ANGLE_EPS = 1e-6;

/** How many keys a grant config may carry. The real ones use three. */
const MAX_CONFIG_KEYS = 20;

/** Names that are dangerous as object keys anywhere downstream. */
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

// `round`, `finiteCoord`, `readVec3` and `readAngle` are exported for `mapLayout.ts`: a layout's coordinates
// and angles follow this file's rule, and the rounding places must not drift between the two.
export function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

export function finiteCoord(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) > WORLD_COORD_LIMIT) return null;
  return round(value, 3);
}

export function readVec3(raw: unknown): Vec3 | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const x = finiteCoord(r.x);
  const y = finiteCoord(r.y);
  const z = finiteCoord(r.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

export function readAngle(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  let w = raw % TWO_PI;
  if (w > Math.PI + ANGLE_EPS) w -= TWO_PI;
  else if (w < -Math.PI - ANGLE_EPS) w += TWO_PI;
  return round(w, 6);
}

/**
 * The first `max` CODE POINTS of `s`. Every string this site cuts before it
 * becomes JSON in Postgres goes through here — a target name, a copied config
 * string, an author, a note, the report reader's names, ids and reasons —
 * because `String.prototype.slice` counts UTF-16 units, and a cut through an
 * astral character leaves a lone surrogate, which `JSON.stringify` writes as
 * `\ud83d` and Postgres refuses: the save, or the game's own report, 500s.
 *
 * The pre-cut to `max * 2` units is an optimisation the result cannot see: a
 * code point is one or two units, so the first `max` code points end within
 * the first `max * 2` units; the pre-cut keeps them all whole, and the only
 * thing it can split is a pair at unit `max * 2`, which is at code-point
 * index ≥ `max` and is sliced off. So it is provably the same first `max`
 * code points as `Array.from(s).slice(0, max)`, without spreading the whole
 * string into an array of one-character strings first.
 *
 * A ZWJ sequence (a family emoji) cut between its code points stays valid
 * UTF-16 and Postgres-safe — only the glyph changes, from one family to two
 * people. The rule is about surrogates, not graphemes.
 *
 * The result is also `toWellFormed()` (Node ≥ 20.9, the `engines` floor):
 * the cut cannot make a lone surrogate, but a JSON body can spell one
 * (`"\ud83d"` is valid JSON text), and an admin string that arrived already
 * malformed used to reach `::jsonb` and 500 the save or the report. It
 * becomes U+FFFD instead — what the TEXT columns already make of it — in
 * place, so it still counts as the one code point it was under the cut.
 *
 * `max` is a non-negative integer at every call site; negative is not
 * handled.
 */
export function cutCodePoints(s: string, max: number): string {
  return Array.from(s.slice(0, max * 2)).slice(0, max).join('').toWellFormed();
}

/**
 * A trimmed name of at most `max` CODE POINTS, and a fixed point: the cut
 * comes first and the trim second, so a name cut at a space does not shrink
 * again on the next read; and the cut is `cutCodePoints`, so an emoji at the
 * boundary is kept whole or dropped whole.
 */
function readName(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = cutCodePoints(raw.trim(), max).trim();
  if (!trimmed) return null;
  if (FORBIDDEN_NAMES.has(trimmed)) return null;
  return trimmed;
}

/** A `{name}` (trimmed, ≤ 200) or an `{id}` (exact, ≤ 128, in registry form); never both, never neither. */
function readTarget(raw: unknown): Target | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const hasName = r.name !== undefined;
  const hasId = r.id !== undefined;
  if (hasName === hasId) return null;
  if (hasName) {
    const name = readName(r.name, 200);
    return name ? { name } : null;
  }
  if (typeof r.id !== 'string') return null;
  const id = r.id.trim();
  if (!id || id.length > TARGET_ID_MAX || !TARGET_ID_RE.test(id)) return null;
  return { id };
}

/**
 * A placement's grant descriptor, flattened to scalars.
 *
 * This is `action_config` off a marketplace row, and the game reads it to decide
 * which inventory item a placed crate actually contains. Everything the real
 * rows use is one level deep and scalar (`{ effect, ammo_item, amount }`), so
 * anything else is either a mistake or someone probing — and a nested object
 * arriving here would be handed to `Object.assign`-shaped code in the client.
 * `Object.create(null)` plus an own-property walk means a `__proto__` key in the
 * JSON is copied as data or dropped, never applied.
 */
function readConfig(raw: unknown): GrantConfig {
  const out: GrantConfig = Object.create(null) as GrantConfig;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...out };
  let kept = 0;
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (kept >= MAX_CONFIG_KEYS) break;
    if (FORBIDDEN_NAMES.has(key) || key.length > 64) continue;
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string') out[key] = cutCodePoints(value, 200);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
    else continue;
    kept++;
  }
  // Back onto a normal prototype so JSON.stringify and deep-equality behave.
  return { ...out };
}

let minted = 0;

/** A short id for an entry that arrived without one. Never reuses an id. */
function mintId(): string {
  minted += 1;
  return `e${minted.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Turn whatever arrived into a document the game can be handed.
 *
 * Nothing throws. An entry that cannot be understood is *rejected and reported*
 * rather than dropped silently, because the admin who wrote it is the only
 * person who can fix it and the editor shows them this list.
 */
export function normaliseOverlayEntries(raw: unknown): NormalisedOverlay {
  const entries: OverlayEntry[] = [];
  const rejected: RejectedEntry[] = [];
  if (!Array.isArray(raw)) return { entries, rejected };

  const seen = new Set<string>();

  for (let index = 0; index < raw.length; index++) {
    const item = raw[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected.push({ index, id: null, reason: 'kind' });
      continue;
    }
    const r = item as Record<string, unknown>;
    const id = readName(r.id, 64) ?? mintId();

    if (entries.length >= MAX_OVERLAY_ENTRIES) {
      rejected.push({ index, id, reason: 'overflow' });
      continue;
    }
    if (seen.has(id)) {
      rejected.push({ index, id, reason: 'duplicate' });
      continue;
    }

    const rotationY = readAngle(r.rotationY);

    if (r.kind === 'move') {
      const target = readTarget(r.target);
      if (!target) {
        rejected.push({ index, id, reason: 'target' });
        continue;
      }
      // v1 spelled "take this object out of the world" as a move with `hidden`.
      // That is a remove now, and it is migrated HERE, on read, so every stored
      // version, every revert and the game GET load it without a rewrite. Its
      // position - where v1 parked the object's colliders - is discarded: a
      // hidden object's position was never observable, and the colliders it
      // governed are now dropped by containment at the authored box (owner
      // decision A). One raw entry becomes one entry, so the save route's
      // `rejected[].index` walk stays a raw index.
      if (r.hidden !== undefined && Boolean(r.hidden)) {
        entries.push({ kind: 'remove', id, target });
        seen.add(id);
        continue;
      }
      const position = readVec3(r.position);
      if (position === null) {
        rejected.push({ index, id, reason: 'position' });
        continue;
      }
      const entry: MoveEntry = { kind: 'move', id, target, position };
      if (rotationY !== undefined) entry.rotationY = rotationY;
      entries.push(entry);
      seen.add(id);
      continue;
    }

    if (r.kind === 'remove') {
      const target = readTarget(r.target);
      if (!target) {
        rejected.push({ index, id, reason: 'target' });
        continue;
      }
      entries.push({ kind: 'remove', id, target });
      seen.add(id);
      continue;
    }

    if (r.kind === 'place') {
      const itemRaw = r.item as Record<string, unknown> | undefined;
      const sourceKey = readName(itemRaw?.source_key, 200);
      if (!sourceKey) {
        rejected.push({ index, id, reason: 'item' });
        continue;
      }
      const position = readVec3(r.position);
      if (position === null) {
        rejected.push({ index, id, reason: 'position' });
        continue;
      }
      const qtyRaw = Number(r.quantity);
      const quantity = Number.isFinite(qtyRaw)
        ? Math.max(1, Math.min(99, Math.floor(qtyRaw)))
        : 1;
      const entry: PlaceEntry = {
        kind: 'place',
        id,
        item: {
          source_key: sourceKey,
          name: readName(itemRaw?.name, 120) ?? sourceKey,
          config: readConfig(itemRaw?.config),
        },
        position,
        quantity,
      };
      if (rotationY !== undefined) entry.rotationY = rotationY;
      entries.push(entry);
      seen.add(id);
      continue;
    }

    rejected.push({ index, id, reason: 'kind' });
  }

  return { entries, rejected };
}

/** True only for a world the game can actually enter. */
export function isKnownOverlayWorld(world: unknown): world is OverlayWorld {
  if (typeof world !== 'string') return false;
  return (OVERLAY_WORLDS as readonly string[]).includes(world);
}
