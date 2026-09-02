import * as THREE from 'three';

/**
 * The delivery run: brief 5.3's courier round, on foot.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS NOT ANOTHER ROOFTOP TRIAL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Brief 5.3 names eight contests and the framework already covers two of them:
 * `rooftop` is "parkour route" and `test_fire` is "target range". A delivery
 * run that was a chain of checkpoints under one clock would be `RooftopTrial`
 * with different signage, and that is the shape this repo has already paid for
 * twice - a thing that was BUILT rather than a thing that is PLAYED.
 *
 * Two decisions make it a different game:
 *
 *  1. **One parcel at a time.** The round is `depot -> drop -> depot -> drop`,
 *     so the route is a STAR and half of every run is a return leg. A trial is
 *     a line you run down once and never retrace. The consequence for the
 *     player is that the depot becomes a place with a meaning, which is exactly
 *     what a hub deck or a yard needs and a rooftop chain cannot give it.
 *  2. **Every leg carries its own deadline**, derived from that leg's own
 *     straight-line length at a published pace, plus a fixed grace. A trial has
 *     one clock and three medal times; this has a SCHEDULE. Falling behind on
 *     the second leg ends the run on the second leg, and the readout that
 *     matters is "0:11 left on THIS leg" rather than "1:48 elapsed".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PACE IS PUBLISHED BY THE WORLD, AND THAT IS DELIBERATE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `pace` is seconds allowed per metre, and the world that owns the ground is
 * the only thing that can know it: a flat hub deck and a yard full of gantries
 * are not the same walk, and a leg that crosses a stair is not the same leg as
 * one that does not. Deriving it here from a walk speed would be the fourth
 * number in this project computed instead of driven - see `CitadelWorld
 * ._publishVenues` for the previous three - so it is authored beside the route
 * and this file only ever multiplies.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  ARRIVAL IS A DISC AND A BAND, AND THE BAND IS THE INTERESTING HALF
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A planar radius alone books a delivery in for anybody standing on the
 * walkway above the bay - the station's promenade deck is 10 m over its floor,
 * and a courier who never came down would complete the round from up there. So
 * every arrival is tested against a vertical band as well, published per venue
 * next to the route that needs it. `minigame-delivery.test.mjs` states the band
 * as a number rather than trusting the description.
 */

/**
 * The id the finish event carries as `target`/`id`.
 *
 * `scripts/quest-vocab.mjs` scrapes this constant by name - the regex is
 * `export const (\w*GAME_ID) = '([a-z0-9_]+)'` - follows `main.js`'s
 * `registerGame` call to find which kind runs this module, and only then will
 * it offer `delivery_run_won` / `delivery_run_lost` as legal `minigame`
 * targets. Rename it and the vocabulary moves with it.
 */
export const DELIVERY_GAME_ID = 'delivery_run';

/** Seconds of "on your marks". Short - you are standing at the depot. */
const COUNTDOWN_S = 3.0;

/** Fallbacks for a venue that publishes an incomplete config. */
const DEFAULT_DROP_R = 3.2;
const DEFAULT_BAND = 3.0;
/** Seconds per metre. 0.42 is a comfortable jog with a corner in it. */
const DEFAULT_PACE = 0.42;
/** Seconds added to every leg regardless of length: the turn at each end. */
const DEFAULT_GRACE = 8;
const DEFAULT_SECONDS = 240;

/**
 * How far from the depot a run may be started.
 *
 * EXPORTED because the world has to publish the same number as the venue's
 * OFFER gate. `MinigameManager` used to offer "Start the Concourse Round"
 * anywhere inside the containment disc - which has to hold the whole route or
 * `LEAVE_GRACE_S` abandons every run - so the prompt appeared 50 m from the
 * kiosk, took the E key off every NPC on the deck, and then `createDeliveryRun`
 * refused with "loads at the depot, 47 m away". The words and the key can only
 * agree if the venue's gate IS this one, so `StationWorld` reads it from here
 * rather than copying the figure.
 */
export const DEPOT_R = 6.0;
/** Vertical band on that gate. */
export const DEPOT_BAND = 3.0;

/** mm:ss.t */
function clockText(t) {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
}

/** A finite {x,y,z} out of anything, or null. */
function point(raw) {
  const x = Number(raw?.x);
  const y = Number(raw?.y);
  const z = Number(raw?.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { x, y, z };
}

/**
 * Read the venue's round into the shape this module runs.
 *
 * Returns null rather than throwing for a venue that publishes nothing usable,
 * because `MinigameManager` treats a null factory result as "not available" and
 * a thrown one as an error it logs - and a world shipping a malformed
 * descriptor is the first case, not the second. Same contract as
 * `TestFire.readTargets`.
 *
 * @param {any} venue
 * @returns {{depot:object, drops:Array<object>, dropR:number, band:number,
 *   pace:number, grace:number, limit:number}|null}
 */
export function readRound(venue) {
  const cfg = venue?.config;
  if (!cfg || typeof cfg !== 'object') return null;
  const depot = point(cfg.depot);
  if (!depot) return null;

  const raw = Array.isArray(cfg.drops) ? cfg.drops : null;
  if (!raw || !raw.length) return null;
  const drops = [];
  for (const d of raw) {
    const p = point(d);
    if (!p) continue;
    drops.push({
      id: typeof d?.id === 'string' && d.id ? d.id : `drop-${drops.length}`,
      label: typeof d?.label === 'string' && d.label ? d.label : `Drop ${drops.length + 1}`,
      ...p,
    });
  }
  if (!drops.length) return null;

  const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
  return {
    depot: { id: 'depot', label: typeof cfg.depotLabel === 'string' && cfg.depotLabel ? cfg.depotLabel : 'the depot', ...depot },
    drops,
    dropR: num(cfg.dropR, DEFAULT_DROP_R),
    band: num(cfg.band, DEFAULT_BAND),
    pace: num(cfg.pace, DEFAULT_PACE),
    /* Grace may legitimately be zero, so it is the one field that is not read
     * through `num` - a published 0 would otherwise silently become 8. */
    grace: Number.isFinite(Number(cfg.grace)) && Number(cfg.grace) >= 0 ? Number(cfg.grace) : DEFAULT_GRACE,
    limit: num(cfg.seconds, DEFAULT_SECONDS),
  };
}

/**
 * Expand a round into the ordered list of legs it is actually run as.
 *
 * Exported because the SHAPE of the round - out and back, once per parcel, home
 * at the end - is the design decision this contest is built on, and a test has
 * to be able to state it without driving a simulation. It is also what a world
 * measures its venue disc against: the disc has to hold every leg or
 * `MinigameManager`'s `LEAVE_GRACE_S` abandons the run mid-round.
 *
 * @param {ReturnType<typeof readRound>} round
 * @returns {Array<{from:object, to:object, outbound:boolean, length:number, limit:number}>}
 */
export function legPlan(round) {
  if (!round) return [];
  const legs = [];
  for (const drop of round.drops) {
    legs.push({ from: round.depot, to: drop, outbound: true });
    legs.push({ from: drop, to: round.depot, outbound: false });
  }
  for (const leg of legs) {
    leg.length = Math.hypot(leg.to.x - leg.from.x, leg.to.z - leg.from.z);
    leg.limit = leg.length * round.pace + round.grace;
  }
  return legs;
}

export class DeliveryRun {
  /**
   * @param {object} venue the manager's validated venue record
   * @param {{player?:any, bus?:any, input?:any, worldManager?:any, scene?:any}} ctx
   */
  constructor(venue, ctx = {}) {
    this.id = DELIVERY_GAME_ID;
    this.venue = venue;
    this.bus = ctx.bus ?? null;
    this.player = ctx.player ?? null;

    this.round = readRound(venue);
    if (!this.round) throw new Error('delivery run: the venue publishes no usable round');
    this.legs = legPlan(this.round);

    /** Index into `legs`. */
    this.leg = 0;
    /** Parcels booked in. Advances on outbound arrivals only. */
    this.delivered = 0;
    /** Seconds since the lights went out, over the whole round. */
    this.clock = 0;
    /** Seconds spent on the current leg. */
    this.legClock = 0;
    /** True between `begin` and `dispose`. Nothing counts outside it. */
    this._live = false;

    this._host = ctx.worldManager?.active?.group ?? ctx.scene ?? this.player?.scene ?? null;
    this._marker = null;
    this._markerGeo = null;
    this._markerMat = null;
    this._buildMarker();
  }

  get countdown() {
    return COUNTDOWN_S;
  }

  /** Seconds this leg is allowed, or 0 when the round is over. */
  get legLimit() {
    return this.legs[this.leg]?.limit ?? 0;
  }

  /** The point the player is currently being sent to, or null. */
  get target() {
    return this.legs[this.leg]?.to ?? null;
  }

  /**
   * ONE marker, moved, rather than one per drop.
   *
   * A pillar over every bay would tell the player where all six points are,
   * which is a map and not a delivery round; the contest is "go where you are
   * sent, now". Moving one object also means the run owns exactly one geometry
   * and one material whatever the round's length, which is what makes the
   * dispose path trivially correct.
   *
   * No host group is not an error: it is the headless case, and the contest is
   * unchanged without it. Same contract as `TestFire._buildLamps`.
   */
  _buildMarker() {
    if (!this._host || typeof this._host.add !== 'function') return;
    this._markerGeo = new THREE.CylinderGeometry(0.55, 0.55, 6.0, 12, 1, true);
    this._markerMat = new THREE.MeshBasicMaterial({
      color: 0x4dffa6, toneMapped: false, transparent: true, opacity: 0.42,
      side: THREE.DoubleSide, depthWrite: false,
    });
    this._marker = new THREE.Mesh(this._markerGeo, this._markerMat);
    this._marker.name = `delivery-marker-${this.venue.id}`;
    this._marker.visible = false;
    this._host.add(this._marker);
    this._moveMarker();
  }

  _moveMarker() {
    const t = this.target;
    if (!this._marker) return;
    if (!t) { this._marker.visible = false; return; }
    this._marker.position.set(t.x, t.y + 3.0, t.z);
    this._marker.visible = this._live;
  }

  begin(elapsed) {
    void elapsed;
    this.clock = 0;
    this.legClock = 0;
    this._live = true;
    this._moveMarker();
    this.bus?.emit('delivery:started', {
      venueId: this.venue.id,
      label: this.venue.label,
      parcels: this.round.drops.length,
      legs: this.legs.length,
      seconds: this.round.limit,
    });
    this._announce();
  }

  /** Tell the player where the current leg goes, and how long they have. */
  _announce() {
    const leg = this.legs[this.leg];
    if (!leg) return;
    this.bus?.emit('hud:notify', {
      text: leg.outbound
        ? `Parcel ${this.delivered + 1} of ${this.round.drops.length} — ${leg.to.label}, ${clockText(leg.limit)}`
        : `Back to ${leg.to.label} — ${clockText(leg.limit)}`,
      tone: 'info',
    });
  }

  /**
   * Is the body at this point?
   *
   * Planar disc plus a vertical band. The band is the half that matters: see
   * the class header, and `minigame-delivery.test.mjs` test 5.
   *
   * @param {{x:number,y:number,z:number}} p
   */
  _arrived(p) {
    const b = this.player?.position;
    if (!b || !p) return false;
    if (Math.abs(b.y - p.y) > this.round.band) return false;
    return Math.hypot(b.x - p.x, b.z - p.z) <= this.round.dropR;
  }

  /**
   * @param {number} dt fixed step
   * @param {number} clock seconds since the lights went out
   * @returns {object|null} an outcome ends the contest
   */
  fixedUpdate(dt, clock) {
    if (!this._live) return null;
    this.clock = clock;
    this.legClock += dt;

    const leg = this.legs[this.leg];
    if (!leg) return this._win();

    if (this._arrived(leg.to)) {
      if (leg.outbound) this.delivered++;
      this.leg++;
      this.legClock = 0;
      this.bus?.emit('delivery:leg', {
        venueId: this.venue.id,
        leg: this.leg,
        of: this.legs.length,
        delivered: this.delivered,
        parcels: this.round.drops.length,
        at: leg.to.id,
        time: this.clock,
      });
      if (this.leg >= this.legs.length) return this._win();
      this._moveMarker();
      this._announce();
      return null;
    }

    /* Two clocks, and BOTH have to be able to end the run.
     *
     * The per-leg deadline is the contest. The overall ceiling is the belt to
     * its braces: a round whose legs keep being reset by arrivals has no
     * natural end, and `MinigameManager` carries no clock of its own - a
     * contest runs until its module says it is over. */
    if (leg.limit > 0 && this.legClock >= leg.limit) {
      return this._lose(`late to ${leg.to.label}`);
    }
    if (this.clock >= this.round.limit) {
      return this._lose(`out of time for ${leg.to.label}`);
    }
    return null;
  }

  /**
   * A FIELD OF ONE - `total: 1`, and `place: 1` in both branches.
   *
   * The round is a route against a schedule; nobody else is running it. The
   * card suppresses PLACE on a field of one rather than reporting a position
   * in a contest with a single entrant. See the same note on `DroneHack._win`.
   */
  _win() {
    return {
      won: true,
      place: 1,
      total: 1,
      score: this.delivered,
      scoreLabel: `${this.delivered}/${this.round.drops.length} parcels in ${clockText(this.clock)}`,
      detail: `${this.legs.length} legs, all on schedule`,
    };
  }

  /** @param {string} why names the leg, because "you lost" is not a readout. */
  _lose(why) {
    return {
      won: false,
      place: 1,
      total: 1,
      score: this.delivered,
      scoreLabel: `${this.delivered}/${this.round.drops.length} parcels`,
      detail: why,
    };
  }

  snapshot() {
    const leg = this.legs[this.leg];
    const left = leg ? leg.limit - this.legClock : 0;
    return {
      rows: [
        { k: 'TIME', v: clockText(Math.max(0, left)), tone: left <= 6 ? 'warn' : null },
        { k: 'LEG', v: leg ? `${leg.to.label}` : 'home' },
        { k: 'PARCELS', v: `${this.delivered}/${this.round.drops.length}` },
      ],
      progress: Math.max(0, Math.min(1, this.leg / Math.max(1, this.legs.length))),
    };
  }

  /** Idempotent: the manager tears down on quit, death and world change too. */
  dispose() {
    this._live = false;
    if (this._marker) {
      this._marker.parent?.remove(this._marker);
      this._marker = null;
    }
    this._markerGeo?.dispose?.();
    this._markerMat?.dispose?.();
    this._markerGeo = null;
    this._markerMat = null;
  }
}

/**
 * The factory `minigames.registerGame('courier', ...)` calls.
 *
 * Two gates, in this order:
 *
 *  1. **A usable round.** No depot or no drops, no contest - null, not a throw.
 *  2. **At the depot.** The venue disc has to hold the WHOLE round or
 *     `MinigameManager`'s `LEAVE_GRACE_S` abandons a run in progress, so the
 *     disc is large and the START gate cannot be the disc. It lives here, and
 *     it says WHERE rather than just no: `RooftopTrial`'s recorded reason is
 *     that a bare "not available" over a working venue reads as a broken world.
 *
 * @param {object} venue
 * @param {object} ctx
 * @returns {DeliveryRun|null}
 */
export function createDeliveryRun(venue, ctx = {}) {
  const round = readRound(venue);
  if (!round) return null;

  const p = ctx.player?.position;
  if (p) {
    const d = Math.hypot(p.x - round.depot.x, p.z - round.depot.z);
    if (d > DEPOT_R || Math.abs(p.y - round.depot.y) > DEPOT_BAND) {
      ctx.bus?.emit('hud:notify', {
        text: `${venue.label ?? 'The round'} loads at the depot, ${Math.round(d)} m away`,
        tone: 'warn',
      });
      return null;
    }
  }

  try {
    return new DeliveryRun(venue, ctx);
  } catch (err) {
    console.warn('[delivery] the round failed to build:', err?.message ?? err);
    return null;
  }
}

export default createDeliveryRun;
