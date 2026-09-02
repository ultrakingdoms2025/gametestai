import { allows } from '../worlds/WorldRules.js';
import { venueArticle } from '../ui/PromptSlots.js';

/**
 * Minigames: the shared lifecycle behind every abstracted contest in the game.
 *
 * ── What this is, and what it deliberately is not ────────────────────────────
 *
 * The three contests the sports world is getting - swimming, tennis, skiing -
 * are *abstracted*. None of them is a physics simulation of a sport. What they
 * all genuinely need is the same five things, and this file owns exactly those:
 *
 *   1. a place in the world that offers the contest,
 *   2. a way in that does not fight the five other systems already reading E,
 *   3. a state machine with a countdown, a score and a definite end,
 *   4. a way OUT, mid-contest, that pays nothing,
 *   5. a payout and a quest event when it is over.
 *
 * Everything a specific sport does - what a length is, how a rival paces
 * itself, what a point is - lives in a *game module* registered against a
 * `kind`. This file never learns what swimming is.
 *
 * ── The shape it copies ──────────────────────────────────────────────────────
 *
 * `race/RaceManager.js` is the same problem solved once already: arm off the
 * world, run a countdown, classify, pay, emit. The state names, the
 * `abort(reason)` = quit-with-no-payout contract, the `snapshot()`-polled-by-UI
 * convention and the "countdown from ELAPSED, never from a tick count" rule are
 * all lifted from it on purpose, so a reader who knows one knows the other.
 *
 * ── Venues are published by the world, not registered here ───────────────────
 *
 * Following `Interiors` / `world.enterables`: a world puts plain descriptor
 * objects on itself as `world.minigameVenues`, and this rebuilds its list on
 * `world:changed`. A world that publishes none is not a special case; it just
 * arms nothing. See `_readVenue` for the descriptor contract - every field is
 * validated and a malformed venue is dropped, never thrown on, because a world
 * and this file ship independently.
 */

/** @enum {string} */
export const MINIGAME_STATE = {
  IDLE: 'idle',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  FINISHED: 'finished',
};

/**
 * Credits a win pays.
 *
 * ── The number this replaces, and the measurement that moved it ──────────────
 *
 * It was 10, from the user's own sentence: "if I win I get 10 credits". That
 * was written before there was a shop to spend it in, and the shop is what
 * makes it wrong. The cheapest row on the shelf is a medkit at 95 CR at the
 * station (67 at the sports grounds, 138 in the citadel), so a whole contest
 * paid a ninth of the cheapest thing in the game - while one raider paid 5 CR
 * of bounty PLUS a guaranteed credit drop off the body. Standing in the outer
 * ring shooting out-earned every authored contest in the game, per run and per
 * minute, which is the exact opposite of what the content is for.
 *
 * 120 is not a guess. It is the number the ONE venue authored after the shop
 * existed already pays: `BUTTS_REWARD` in `worlds/dock/YardPlan.js` is 120 for
 * a 45-second clear of the archery butts, and it shipped. Every other venue
 * still sits on the pre-shop 8-18 ladder, so the butts is not an outlier to be
 * trimmed - it is the calibration the other fifteen never got. One contest,
 * one shelf item.
 *
 * A venue may still override it with `reward`; see {@link venuePrize} for what
 * happens to the fifteen venues that publish a number from the old ladder.
 */
export const MINIGAME_PRIZE = 120;

/**
 * The prize this file used to pay, and the middle rung of the legacy ladder.
 *
 * Kept as a named constant rather than inlined because it is the divisor in
 * {@link MINIGAME_REWARD_SCALE}, and the relationship - "the old ladder's
 * middle rung becomes the new standing prize" - is the whole justification for
 * the scale factor being 12 and not some other number.
 */
export const MINIGAME_LEGACY_PRIZE = 10;

/**
 * Top of the pre-shop reward band, exclusive of anything authored since.
 *
 * Every venue in the repo publishes either a number in 8-18 (the fourteen that
 * predate the shop) or 120 (the yard butts). Nothing sits between 19 and 119,
 * so a threshold here separates "a rung on the old ladder" from "credits,
 * meant literally" without needing a flag on the descriptor.
 */
export const MINIGAME_LEGACY_BAND_MAX = 20;

/** Multiplier that lifts a legacy rung onto the shelf. 120 / 10. */
export const MINIGAME_REWARD_SCALE = MINIGAME_PRIZE / MINIGAME_LEGACY_PRIZE;

/**
 * Credits a venue's published `reward` is actually worth.
 *
 * ── Why the manager rescales instead of the worlds being edited ──────────────
 *
 * The fifteen legacy numbers are a DIFFICULTY LADDER and a good one: the Souk
 * Rooftop Dash is an 8, the Long Ascent a 14, the Skyline an 18, and those
 * rungs were chosen by whoever built the routes. A flat floor would flatten
 * them all to one number and throw that judgement away; multiplying the ladder
 * keeps it and moves it onto the shelf, 96-216 CR, straddling the butts' 120.
 *
 * The threshold is a MIGRATION RAMP and is meant to become inert: once the
 * world files carry real credit figures (every one of them is a one-line
 * change), every published reward is >= MINIGAME_LEGACY_BAND_MAX and this
 * function is the identity. It is written so that day costs nothing.
 *
 * @param {number} raw the venue's published `reward`
 * @returns {number} whole credits
 */
export function venuePrize(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return MINIGAME_PRIZE;
  if (n >= MINIGAME_LEGACY_BAND_MAX) return Math.floor(n);
  return Math.floor(n * MINIGAME_REWARD_SCALE);
}

/**
 * Share of the prize a COMPLETED loss pays.
 *
 * ── The number this replaces, and why it was wrong ───────────────────────────
 *
 * It was zero, and `2026-08-23-mission-architecture.md` §8 measured what that
 * costs: "Zero for a completed contest against a named rival teaches players
 * not to enter. A participation floor below the win prize keeps the contest
 * meaningful and the venue used."
 *
 * ── ..and the number it must not become ──────────────────────────────────────
 *
 * §5 of the same document, equally measured: the whole-game faucet is over
 * 250,000 CR against FIVE spend sites, and one clear of one world buys 90% of
 * everything permanent. So this is a sink problem, and a participation floor is
 * the last place to open a new faucet. Three properties keep it from being one:
 *
 *  - It is a SHARE of a prize that did not move, so the ceiling of the faucet is
 *    exactly what it was. A player who wins everything gains nothing here.
 *  - It is clamped strictly below the prize ({@link consolationFor}), so winning
 *    never stops being the point.
 *  - It is paid by `_finish` only, which `abort` never reaches. Walking out of a
 *    contest still pays nothing, so the floor cannot be farmed by starting
 *    contests and leaving them - you have to see one out, which at 45-180 s a
 *    run pays worse per minute than anything else in the game.
 *
 * A quarter put the shipped 8-18 band at 2-4 CR: enough that finishing is not
 * nothing, far too little to be a strategy. The share has NOT moved with the
 * prize rescale (see {@link venuePrize}), so the same quarter now puts the same
 * fifteen venues at 24-54 CR - a quarter of a shelf item for seeing a contest
 * out, against a whole one for winning it. The relationship the share encodes
 * is the point, and it is scale-free.
 */
export const MINIGAME_FLOOR_SHARE = 0.25;

/**
 * Credits a completed loss pays at this venue.
 *
 * Exported because the number is a DESIGN decision that a test has to be able
 * to state, and because a venue is allowed to override it: a contest with no
 * rival and no risk may publish `consolation: 0` and pay nothing, and one that
 * is mostly a long walk may publish more.
 *
 * The clamp is the part worth reading. Two edges break a bare
 * `Math.floor(prize * share)`:
 *
 *  - **Below the prize, always.** A published floor at or above the prize is a
 *    typo, and obeying it would make winning optional. Clamped to `prize - 1`.
 *  - **Never negative, and never a fractional credit.** `resolveReportedEvent`
 *    refuses anything that is not a non-zero integer, so a floor that came out
 *    as 2.5 or -1 would be a server-side refusal logged against a payout that
 *    was correct. `_finish` separately declines to report a zero.
 *
 * @param {{reward?:number, consolation?:number}|null|undefined} venue
 * @returns {number} whole credits in `[0, prize)`
 */
export function consolationFor(venue) {
  const raw = Number(venue?.reward);
  const prize = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : MINIGAME_PRIZE;
  const ceiling = Math.max(0, prize - 1);
  const named = Number(venue?.consolation);
  if (Number.isFinite(named)) {
    return Math.min(ceiling, Math.max(0, Math.floor(named)));
  }
  /* One whole credit is the floor of the floor. A quarter of a two-credit prize
   * rounds to nothing, and "nothing" is the state this whole constant exists to
   * leave - so the derived floor never rounds a payable contest back down to
   * zero. Only a venue that ASKS for zero gets it, which is the branch above. */
  return Math.min(ceiling, Math.max(ceiling > 0 ? 1 : 0, Math.floor(prize * MINIGAME_FLOOR_SHARE)));
}

/**
 * What a medal is worth, as a SHARE of the venue's prize.
 *
 * ── The ladder this completes ────────────────────────────────────────────────
 *
 * The payout ladder had exactly two rungs: {@link MINIGAME_FLOOR_SHARE} for
 * seeing a contest out, and the whole prize for winning it. `RooftopTrial`
 * grades a win three ways off measured par times and seven citadel venues use
 * it, and every one of those grades paid the same number - so a run 14% inside
 * the reference pace and a run that scraped bronze with two seconds to spare
 * were worth identically the same credits, and a repeat visit to a venue you
 * already hold moved nothing at all.
 *
 * ── Why GOLD is 1.0 and not 1.5, which is the tempting shape ────────────────
 *
 * Two reasons, and the second one is a hard external ceiling rather than a
 * judgement.
 *
 *  1. The house rule this file already states twice: the participation floor is
 *     "a SHARE of a prize that did not move, so the ceiling of the faucet is
 *     exactly what it was". The economy was measured at 22 credit sources
 *     against 5 sinks with a whole-game faucet over 250,000 CR. A medal
 *     MULTIPLIER would open a new faucet at the top of the best-rewarded
 *     activity in the game; a medal SHARE re-uses the one that is already
 *     there. The grade is expressed in what the other grades give up, which is
 *     what makes gold mean something.
 *  2. `site/lib/creditPricing.ts` refuses a reported `minigame` event over 250
 *     credits per event. The richest venue publishes `reward: 18`, which
 *     `venuePrize` rescales to 216. Any multiplier above 250/216 = 1.157 would
 *     be SERVER-REFUSED on the Skyline and the Long Water - a payout that was
 *     exactly right, logged as a rejection, with the player's client-side
 *     balance already credited. There is no room above the prize; there is
 *     plenty below it.
 *
 * Bronze is 0.70 rather than something nearer the floor because a bronze on the
 * Souk Dash is still a contest won: at the shipped 96 CR prize it pays 67
 * against a 24 CR participation floor, so the ladder reads 24 / 67 / 81 / 96 -
 * every rung clearly above the last, and winning badly still comfortably better
 * than finishing badly. That ordering is enforced rather than assumed; see
 * {@link medalPrize}.
 *
 * A contest that grades nothing - which is thirteen of the sixteen venues -
 * publishes no medal and pays the full prize exactly as it did before. This
 * table can only ever REDUCE a payout, and only for a contest that told the
 * player which grade they took.
 */
export const MEDAL_PRIZE_SHARE = Object.freeze({ gold: 1, silver: 0.85, bronze: 0.7 });

/**
 * Credits a win pays once its medal is taken into account.
 *
 * The clamp is the part worth reading, and it is the same shape
 * {@link consolationFor}'s is. Winning must pay more than finishing, always:
 * a venue that publishes a large `consolation` against a small `reward` could
 * otherwise make a bronze win pay LESS than the loss beside it, which would
 * teach a player to stop trying at the exact moment the contest got interesting.
 * So the medal share is floored at one credit above the participation floor.
 *
 * @param {number} prize the venue's resolved reward (already `venuePrize`d)
 * @param {string|null} medal 'gold' | 'silver' | 'bronze', or null for ungraded
 * @param {number} [floor] this venue's participation floor
 * @returns {number} whole credits
 */
export function medalPrize(prize, medal, floor = 0) {
  const p = Number(prize);
  if (!Number.isFinite(p) || p <= 0) return 0;
  const share = MEDAL_PRIZE_SHARE[medal];
  /* An ungraded contest is the identity. Thirteen venues, and every test that
   * asserts a win pays the venue reward, go through this branch. */
  if (!(share > 0)) return Math.floor(p);
  const paid = Math.floor(p * share);
  const f = Number(floor);
  const min = Number.isFinite(f) && f >= 0 ? Math.min(Math.floor(p), Math.floor(f) + 1) : 0;
  return Math.min(Math.floor(p), Math.max(min, paid));
}

/**
 * The medal in a result's `score`, or null.
 *
 * `score` is a bag - a clock from the swim, the ski run and the track race, a
 * count from the delivery, the hack and the test fire, a games string from the
 * tennis, and a medal from the rooftop trial. Only one of those is a member of
 * {@link MEDAL_PRIZE_SHARE}, so a set lookup is a complete discriminator and
 * no module needs a second field to say "this one means a medal".
 *
 * @param {any} score
 * @returns {'gold'|'silver'|'bronze'|null}
 */
export function medalOf(score) {
  return typeof score === 'string' && MEDAL_PRIZE_SHARE[score] !== undefined ? score : null;
}

/** Seconds of "on your marks" before a contest begins. */
const COUNTDOWN_S = 4.0;

/**
 * Metres added to a venue's radius once the player is inside it.
 *
 * Without hysteresis a player standing exactly on the boundary makes the prompt
 * - and, worse, the *meaning of the E key* - flicker every frame. Same fix
 * `Interiors._streamSpots` uses for the same reason.
 */
const PROMPT_HYSTERESIS = 2.5;

/** Seconds the result stays up before the venue offers a rematch. */
const RESULT_HOLD_S = 14;

/**
 * Seconds outside the venue before a running contest is abandoned.
 *
 * A player who walks away has quit; making them find the prompt again to say so
 * would leave a state machine running over a pool they are no longer near. Long
 * enough that a wide turn or an overshoot at the far wall is never mistaken for
 * leaving.
 */
const LEAVE_GRACE_S = 9;

export class MinigameManager {
  /**
   * @param {{ bus:any, player:any, economy?:any, input?:any, worldManager?:any }} ctx
   */
  constructor({ bus, player, economy, input, worldManager }) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.economy = economy ?? null;
    this.input = input ?? null;
    this.worldManager = worldManager ?? null;

    /** @type {Map<string, (venue:object, ctx:object)=>object>} kind -> factory */
    this._factories = new Map();

    /** @type {Array<object>} validated venues in the active world */
    this._venues = [];
    /** @type {object|null} venue the player is standing in */
    this._near = null;
    /** @type {object|null} venue the running contest belongs to */
    this._venue = null;
    /** @type {object|null} live game module */
    this._game = null;

    this.state = MINIGAME_STATE.IDLE;
    this.clock = 0;
    this._countdown = 0;
    this._countdownTotal = 0;
    this._lastCount = -1;
    this._resultHold = 0;
    this._awayFor = 0;
    /** @type {object|null} last finished result, for the UI */
    this.result = null;

    this._worldId = null;
    this._promptText = null;

    /* ---- other E consumers, watched so this one never double-fires ----
     *
     * `Input.pressed` does NOT consume: five systems already poll KeyE
     * independently (HUD, Portals, Interiors, Loot, QuestBoard) and each guards
     * itself by hand. This is the sixth, so it does the same. A door, a lift or
     * a portal in reach means E belongs to them; the venue prompt stands down
     * rather than firing alongside.
     *
     * NPC chat is the other way round - Tavius Okonkwo patrols the pool deck,
     * so the venue and a talkable NPC overlap by design. There the venue WINS
     * (the whole point is that arriving at the pool offers a match) and `HUD`
     * carries the one-line guard that stands its E branch down while a venue
     * prompt is up. Talking still works: `T` opens chat unconditionally.
     */
    this._interiorPrompt = null;
    this._nearPortal = null;
    /* The leap of faith is the third claim on E, and it is the one that needed
     * MEASURING rather than reasoning about.
     *
     * `Viewpoints` raises its prompt within LEAP_R = 3.0 m of a published
     * launch point. The citadel's great tower launch beam tip is
     * (0, 68.15, -9.8) and the `citadel_skyline` venue - whose disc has to hold
     * its whole 101.6 m route or `LEAVE_GRACE_S` abandons every run - is
     * centred (-22.73, 44.07, -63.45) with radius 60.81 and yTolerance 33.53.
     * The beam tip is 58.27 m out and 24.08 m up: inside, on both axes. So
     * `_pollNear` resolves the Skyline while the player is standing on the
     * diving board, `_pollPrompt` says "Start the Skyline", and the HUD's venue
     * branch - which sits above the viewpoint branch - buries the leap prompt
     * at the one place in the world it was built for. Minaret 3's platform is
     * inside the same disc.
     *
     * Standing down here rather than only in the HUD keeps the KEY and the
     * WORDS agreeing: a HUD-only fix would show "Leap of faith" on the beam and
     * still start a race on E. Same rule as the interior prompt above, and it
     * costs the player nothing - the Skyline's own start gate is START_RADIUS
     * 12 m of the crown centre and the leap prompt reaches 3 m of a point 8.2 m
     * away from it, so both are pressable from their own spots. */
    this._viewpointPrompt = null;
    /** A talkable NPC whose HUD prompt outranks a venue. See `_keyTaken`. */
    this._priorityNpc = null;

    /** @type {Array<() => void>} */
    this._offs = [];
    if (bus) {
      this._offs.push(bus.on('interior:prompt', (e) => { this._interiorPrompt = e?.text ?? null; }));
      this._offs.push(bus.on('portal:near', (e) => { this._nearPortal = e?.portal ?? null; }));
      this._offs.push(bus.on('viewpoint:prompt', (e) => { this._viewpointPrompt = e?.text ?? null; }));
      /* A QUEST MANAGER or LOREKEEPER outranks a venue in the HUD's prompt,
       * so it must outrank it for the KEY too. Those two are named rather
       * than "any talkable NPC" because the HUD puts exactly those two above
       * the venue branch and every other NPC below it - the lifeguard patrols
       * the pool deck, and being offered a match there rather than a chat is
       * deliberate and documented.
       *
       * Without this, the station hub deck reads "E - Quest Board" while E
       * does nothing: the concourse round's disc has to hold the whole
       * contest, so it covers most of the deck, and 7 of the 12 talkable NPCs
       * stand inside it. The words and the key disagreed, which is the exact
       * fault the `viewpoint:prompt` line above was added to fix - and the
       * note in `HUD._updatePrompt` says why the repair belongs HERE rather
       * than in the branch order: reordering the HUD would have changed the
       * words without changing the key. */
      this._offs.push(bus.on('chat:available', (e) => {
        const npc = e?.npc ?? null;
        this._priorityNpc = (npc?.isQuestManager || npc?.isLorekeeper) ? npc : null;
      }));
      // A contest is bound to the world it started in. Leaving mid-contest
      // abandons it rather than leaving a state machine running over a pool
      // that is no longer in the scene. Same reasoning as RaceManager's.
      this._offs.push(bus.on('world:changing', () => this._teardown()));
      /* Re-arm on EVERY world change - and in a world with no venues, re-arm on
       * NOTHING, which is what clears the last one.
       *
       * Deliberately NOT an early return for worlds that publish no venues.
       * `arm` is what clears the previous world's list, so returning early
       * would leave the pool armed after a portal out: walk from the lido into
       * the maze and the venue would still be there, three worlds away, still
       * answering E. `arm(null)` finds nothing and clears everything, which is
       * both the rule and the cleanup in one call. RaceManager.js has the same
       * comment over the same decision, for the same bug. */
      this._offs.push(bus.on('world:changed', ({ id, world }) => {
        this._worldId = id ?? null;
        this._priorityNpc = null;
        this.arm(world ?? null);
      }));
      this._offs.push(bus.on('player:died', () => this._teardown()));
    }
  }

  /* ================================================================ */
  /* Registration                                                      */
  /* ================================================================ */

  /**
   * Teach the manager one sport.
   *
   * @param {string} kind matched against a venue's `kind`
   * @param {(venue:object, ctx:object)=>object} factory builds a game module
   * @returns {this}
   */
  registerGame(kind, factory) {
    if (typeof kind === 'string' && kind && typeof factory === 'function') {
      this._factories.set(kind, factory);
    }
    return this;
  }

  /* ================================================================ */
  /* Contract surface                                                  */
  /* ================================================================ */

  /** @returns {Array<object>} venues armed in the active world */
  get venues() {
    return this._venues;
  }

  /** True while a contest is counting down or being played. */
  get running() {
    return this.state === MINIGAME_STATE.COUNTDOWN || this.state === MINIGAME_STATE.PLAYING;
  }

  /** The venue the player is standing in, or null. */
  get nearest() {
    return this._near;
  }

  /** The venue the running contest belongs to, or null. */
  get venue() {
    return this._venue;
  }

  /** True when `start()` would do something where the player is standing. */
  get ready() {
    return !this.running && !!this._near;
  }

  /**
   * Read the world's venue contract, if it publishes one.
   *
   * Written to tolerate every partial state a world can be in - not built yet,
   * built with no venues, a venue missing a centre - because a missing field
   * must degrade to "no contest here", never to a thrown exception on a world
   * change.
   *
   * @param {any} world
   * @returns {boolean} true when at least one usable venue was found
   */
  arm(world = this.worldManager?.active ?? null) {
    this._teardown();
    this._venues = [];
    this._near = null;
    this._setPrompt(null, null);

    const list = Array.isArray(world?.minigameVenues) ? world.minigameVenues : null;
    if (list) {
      for (const raw of list) {
        const v = this._readVenue(raw);
        if (!v) continue;
        // A venue whose sport has not been written yet is a published slot, not
        // an error: the tennis court and the ski slope ship their descriptors
        // before their game modules, and both must be inert until they do not.
        if (!this._factories.has(v.kind)) continue;
        // A world that forbids the underlying capability cannot host the
        // contest that needs it - a lido in a world with `swim:false` is
        // scenery. `allows` defaults to permitted, so this costs nothing.
        if (v.requires && !allows(world, v.requires)) continue;
        this._venues.push(v);
      }
    }

    this.bus?.emit('minigame:armed', {
      worldId: this._worldId,
      venues: this._venues.map((v) => ({ id: v.id, kind: v.kind, label: v.label })),
    });
    return this._venues.length > 0;
  }

  /**
   * Begin a contest.
   *
   * @param {string} [venueId] defaults to the venue the player is standing in
   * @returns {boolean}
   */
  start(venueId = this._near?.id) {
    if (this.running) return false;
    const venue = this._venues.find((v) => v.id === venueId) ?? null;
    if (!venue) {
      this.bus?.emit('hud:notify', { text: 'Nothing to compete in here', tone: 'warn' });
      return false;
    }
    const factory = this._factories.get(venue.kind);
    if (!factory) return false;

    let game = null;
    try {
      game = factory(venue, { player: this.player, bus: this.bus, input: this.input });
    } catch (err) {
      console.warn(`[minigame] "${venue.id}" failed to start:`, err);
      game = null;
    }
    if (!game) {
      this.bus?.emit('hud:notify', { text: `${venue.label} is not available`, tone: 'warn' });
      return false;
    }

    this._venue = venue;
    this._game = game;
    this.result = null;
    this.state = MINIGAME_STATE.COUNTDOWN;
    this.clock = 0;
    this._awayFor = 0;
    this._resultHold = 0;
    this._countdownTotal = Number(game.countdown) > 0 ? Number(game.countdown) : COUNTDOWN_S;
    this._countdown = this._countdownTotal;
    this._lastCount = -1;
    this._setPrompt(null, null);

    this.bus?.emit('minigame:countdown', {
      count: Math.ceil(this._countdown),
      of: Math.ceil(this._countdownTotal),
      gameId: game.id,
      venueId: venue.id,
    });
    return true;
  }

  /**
   * Abandon a contest in progress. No payout, no result, no quest credit.
   *
   * The user asked for this by name ("also have option to quit match if one is
   * in progress"), and the reason it pays nothing is the same reason
   * `RaceManager.abort` does: a contest you can leave for free the moment it
   * stops going your way is not a contest.
   *
   * @param {string} [reason]
   */
  abort(reason = 'abandoned') {
    if (!this.running) return;
    const venue = this._venue;
    const gameId = this._game?.id ?? null;
    this._teardown();
    this.bus?.emit('minigame:aborted', {
      reason,
      gameId,
      venueId: venue?.id ?? null,
      label: venue?.label ?? null,
    });
    if (reason === 'player') {
      this.bus?.emit('hud:notify', { text: `${venue?.label ?? 'Contest'} abandoned`, tone: 'info' });
    }
  }

  /** Clear the result card and go back to offering a rematch. */
  reset() {
    if (this.running) return;
    this.state = MINIGAME_STATE.IDLE;
    this.result = null;
    this._resultHold = 0;
    this._venue = null;
    this._game = null;
    /* Announce the reset so UI sheets tied to the previous result can close.
     * Without this, a programmatic reset() while the result card was up left
     * the card's `minigame:menu {open:true}` gameplay block latched forever -
     * and the deadlock was self-sealing, because the countdown that would
     * eventually emit `minigame:started` (the other close path) only ticks in
     * fixedUpdate, which that very block freezes. The UI's close handlers are
     * idempotent, so the _closeBoard -> reset() -> this emit cycle terminates. */
    this.bus?.emit('minigame:reset', {});
  }

  /**
   * Everything the UI needs for one frame, in one object.
   *
   * A snapshot rather than a stream of events, for the reason RaceManager gives:
   * a split-time readout that updated 60 times a second would be 60 emits a
   * second for a two-character change, and the UI already has a frame tick.
   */
  snapshot() {
    const g = this._game;
    return {
      state: this.state,
      running: this.running,
      ready: this.ready,
      gameId: g?.id ?? null,
      venueId: this._venue?.id ?? null,
      label: this._venue?.label ?? null,
      kind: this._venue?.kind ?? null,
      clock: this.clock,
      countdown: Math.max(0, Math.ceil(this._countdown)),
      countdownOf: Math.ceil(this._countdownTotal),
      result: this.result,
      near: this._near ? { id: this._near.id, label: this._near.label, kind: this._near.kind } : null,
      /* The sport's own readout, whatever it is. The UI renders rows out of
       * `live.rows`, so a new sport needs no UI change to get a HUD. */
      live: (this.state === MINIGAME_STATE.COUNTDOWN || this.state === MINIGAME_STATE.PLAYING)
        ? (g?.snapshot?.() ?? null)
        : null,
    };
  }

  /* ================================================================ */
  /* Simulation                                                        */
  /* ================================================================ */

  /**
   * Proximity, prompt and the E key.
   *
   * Frame-rate, not fixed-rate, and deliberately: `Input.pressed` is cleared by
   * `input.endFrame()`, so a fixed step - which runs zero or two times in a
   * frame - would miss keypresses or read them twice.
   *
   * @param {number} dt
   */
  update(dt) {
    this._pollNear();
    this._pollPrompt();
    this._pollKey();
    if (this.state === MINIGAME_STATE.FINISHED && this._resultHold > 0) {
      this._resultHold -= dt;
      if (this._resultHold <= 0) this.reset();
    }
  }

  /**
   * The contest itself.
   *
   * Runs AFTER `player.fixedUpdate` in main.js, so the position a length is
   * measured against is this step's, not last step's - the same ordering
   * requirement `race.fixedUpdate` documents.
   *
   * @param {number} dt fixed timestep
   * @param {number} elapsed engine time
   */
  fixedUpdate(dt, elapsed) {
    if (!this.running) return;

    if (this.state === MINIGAME_STATE.COUNTDOWN) {
      this._countdown -= dt;
      /* Derived from elapsed time, never counted down on a tick.
       *
       * A dropped frame must not be able to skip "1". RaceManager's start
       * lights are built the same way and the note there is the reason. */
      const left = Math.max(0, Math.ceil(this._countdown));
      if (left !== this._lastCount) {
        this._lastCount = left;
        this.bus?.emit('minigame:countdown', {
          count: left,
          of: Math.ceil(this._countdownTotal),
          gameId: this._game?.id ?? null,
          venueId: this._venue?.id ?? null,
        });
      }
      if (this._countdown <= 0) {
        this.state = MINIGAME_STATE.PLAYING;
        this.clock = 0;
        try {
          this._game?.begin?.(elapsed);
        } catch (err) {
          console.warn('[minigame] begin failed:', err);
          this.abort('error');
          return;
        }
        this.bus?.emit('minigame:started', {
          gameId: this._game?.id ?? null,
          venueId: this._venue?.id ?? null,
          label: this._venue?.label ?? null,
        });
      }
      return;
    }

    this.clock += dt;

    // Walking away is quitting. Measured against the venue the contest belongs
    // to, not the nearest one, so wandering into an adjacent venue still counts
    // as leaving this one.
    if (this._venue && !this._inVenue(this._venue, PROMPT_HYSTERESIS)) {
      this._awayFor += dt;
      if (this._awayFor >= LEAVE_GRACE_S) {
        this.abort('left');
        return;
      }
    } else {
      this._awayFor = 0;
    }

    let outcome = null;
    try {
      outcome = this._game?.fixedUpdate?.(dt, this.clock) ?? null;
    } catch (err) {
      console.warn('[minigame] update failed:', err);
      this.abort('error');
      return;
    }
    if (outcome) this._finish(outcome);
  }

  /* ================================================================ */
  /* Private                                                           */
  /* ================================================================ */

  /**
   * Normalise and validate one published venue descriptor.
   *
   * @param {any} raw
   * @returns {object|null} null for anything unusable
   */
  _readVenue(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    if (!id || !kind) return null;

    const c = raw.centre ?? raw.center ?? null;
    const cx = Number(c?.x);
    const cy = Number(c?.y ?? 0);
    const cz = Number(c?.z);
    if (!Number.isFinite(cx) || !Number.isFinite(cz)) return null;

    const radius = Number(raw.radius);
    if (!Number.isFinite(radius) || radius <= 0) return null;

    const reward = Number(raw.reward);
    return {
      id,
      kind,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id,
      centre: { x: cx, y: Number.isFinite(cy) ? cy : 0, z: cz },
      radius,
      /* The pool basin floor is 3 m below its deck and the ski slope will be
       * 50 m above its lodge, so a planar radius alone would either miss the
       * swimmer or offer a race to somebody on a gantry overhead. */
      yTolerance: Number.isFinite(Number(raw.yTolerance)) ? Number(raw.yTolerance) : 8,
      /* Resolved HERE and not at payout, so `consolationFor` - which derives
       * the participation floor as a share of the prize - sees the credits the
       * win actually pays rather than the legacy rung. See `venuePrize`. */
      reward: venuePrize(reward),
      /* A venue's own participation floor, kept RAW and resolved by
       * `consolationFor` at payout. Normalising it here would have to know the
       * reward, and a venue is allowed to publish the two in either order. */
      consolation: raw.consolation,
      /** World rule this venue needs; see `arm`. */
      requires: typeof raw.requires === 'string' ? raw.requires : null,
      /** Opaque to this file - handed straight to the game module. */
      config: raw.config ?? null,
      rival: raw.rival ?? null,
    };
  }

  /** Planar-with-height-band containment test. */
  _inVenue(v, slack = 0) {
    const p = this.player?.position;
    if (!p || !v) return false;
    if (Math.abs(p.y - v.centre.y) > v.yTolerance + slack) return false;
    const dx = p.x - v.centre.x;
    const dz = p.z - v.centre.z;
    return Math.hypot(dx, dz) < v.radius + slack;
  }

  _pollNear() {
    if (!this._venues.length) {
      this._near = null;
      return;
    }
    const p = this.player?.position;
    if (!p) return;
    let best = null;
    let bestD = Infinity;
    for (const v of this._venues) {
      // Only the venue already entered gets the slack, so the boundary is sharp
      // on the way in and forgiving on the way out.
      const slack = this._near?.id === v.id ? PROMPT_HYSTERESIS : 0;
      if (!this._inVenue(v, slack)) continue;
      const d = Math.hypot(p.x - v.centre.x, p.z - v.centre.z);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    this._near = best;
  }

  /** True when another system has a better claim on E this frame. */
  get _keyTaken() {
    return !!this._interiorPrompt || !!this._nearPortal || !!this._viewpointPrompt
      || !!this._priorityNpc;
  }

  _pollPrompt() {
    if (this._keyTaken) {
      this._setPrompt(null, null);
      return;
    }
    if (this.running) {
      // Mid-contest, the venue offers the only decision left: stop. This is the
      // affordance the user asked for - it needs no key they have to discover.
      const v = this._venue;
      this._setPrompt(v ? 'Quit' : null, v);
      return;
    }
    if (this.state === MINIGAME_STATE.FINISHED) {
      this._setPrompt(null, null);
      return;
    }
    this._setPrompt(this._near ? 'Start' : null, this._near);
  }

  _pollKey() {
    if (!this._promptText) return;
    if (!this.input?.pressed?.('KeyE')) return;
    /* Quitting is a request, not an action: the confirm sheet owns the actual
     * `abort`, so a stray E over a venue can never throw a match away. */
    if (this.running) this.bus?.emit('minigame:quitRequest', { venueId: this._venue?.id ?? null });
    else if (this._near) this.start(this._near.id);
  }

  /**
   * Publish the venue prompt.
   *
   * Verb and label are sent separately rather than as one formatted string: the
   * HUD wants the venue name bold like every other noun in that prompt, and
   * keeping the markup on its side is what stops a world's authored label from
   * being able to put HTML on screen. `text` is the plain-language fallback for
   * anything that just wants a sentence.
   *
   * @param {string|null} verb
   * @param {object|null} venue
   */
  _setPrompt(verb, venue) {
    const text = verb && venue ? `${verb} ${venueArticle(venue.label)}${venue.label}` : null;
    if (text === this._promptText) return;
    this._promptText = text;
    this.bus?.emit('minigame:prompt', {
      text,
      verb: text ? verb : null,
      label: text ? venue.label : null,
      venueId: text ? venue.id : null,
    });
  }

  /** Stop everything, right now, with no announcement and no payout. */
  _teardown() {
    if (this._game?.dispose) {
      try {
        this._game.dispose();
      } catch {
        /* a module that already tore itself down is not an error */
      }
    }
    this._game = null;
    this._venue = null;
    this.state = MINIGAME_STATE.IDLE;
    this.clock = 0;
    this._countdown = 0;
    this._lastCount = -1;
    this._awayFor = 0;
    this._resultHold = 0;
    this._setPrompt(null, null);
  }

  /**
   * Classify, pay, and tell the rest of the game.
   *
   * @param {object} outcome from the game module: `{won, place, total, score,
   *   scoreLabel, rivalName, detail}`
   */
  _finish(outcome) {
    const venue = this._venue;
    const game = this._game;
    const won = !!outcome.won;
    /* A COMPLETED loss pays the participation floor; an abandoned one never
     * reaches this method at all. See `consolationFor` for why the floor exists
     * and why it is a share of a prize that did not move.
     *
     * The `> 0` guard is not tidiness: `resolveReportedEvent`'s third statement
     * is `if (!Number.isInteger(d) || d === 0) return { ok:false, reason:'invalid' }`,
     * so reporting a zero would be a server-side refusal recorded against a
     * payout that was exactly right. */
    const floor = consolationFor(venue);
    /* The GRADE, when the contest published one. Seven citadel venues do; the
     * other nine answer null here and pay exactly what they always paid. See
     * `medalPrize` for why a medal can only ever move a payout DOWN. */
    const medal = medalOf(outcome.score);
    const credits = won
      ? medalPrize(venue?.reward ?? MINIGAME_PRIZE, medal, floor)
      : floor;
    if (credits > 0) this.economy?.add?.(credits, 'minigame');

    const result = {
      gameId: game?.id ?? null,
      venueId: venue?.id ?? null,
      kind: venue?.kind ?? null,
      label: venue?.label ?? 'Contest',
      won,
      /* 1 or 2 in a head-to-head, which is what all three sports are. Carried
       * rather than derived so a future three-way contest needs no new field. */
      place: Number.isFinite(Number(outcome.place)) ? Number(outcome.place) : (won ? 1 : 2),
      total: Number.isFinite(Number(outcome.total)) ? Number(outcome.total) : 2,
      score: outcome.score ?? null,
      /* The grade, promoted out of the `score` bag onto a field of its own.
       * `SaveGame._recordTrial` can read either, but a listener that wants to
       * know whether a contest was GRADED should not have to know that the
       * rooftop trial happens to put its medal where the swim puts a clock. */
      medal,
      scoreLabel: outcome.scoreLabel ?? null,
      rivalName: outcome.rivalName ?? null,
      detail: outcome.detail ?? null,
      /* The recorded pace of this run, when the module kept one. Carried and
       * never inspected: this file has no opinion about what a replay is, and
       * `SaveGame` shape-checks it before it reaches a save. See
       * `GhostReplay.js` for why it is a progress polyline and not a track. */
      replay: outcome.replay ?? null,
      time: this.clock,
      credits,
      worldId: this._worldId,
    };

    this.state = MINIGAME_STATE.FINISHED;
    this.result = result;
    this._resultHold = RESULT_HOLD_S;
    this._setPrompt(null, null);

    this.bus?.emit('minigame:finished', result);

    /* Quest credit.
     *
     * Shaped for `QuestSystem._eventTargetCandidates`' DEDICATED `minigame`
     * branch. This comment used to say the DEFAULT branch and that `won` and
     * `place` rode along "for a future step type that wants them - today's
     * matcher does not read either". Both statements stopped being true when
     * that branch landed, and the second one is the dangerous half: `won` is
     * now LOAD-BEARING. The branch composes `${gameId}_won` / `${gameId}_lost`
     * out of it, and eight authored steps target one of those spellings, so
     * dropping `won` from this payload would quietly make "win the match"
     * complete on a loss - which is exactly the failure the composite exists
     * to prevent.
     *
     * What the branch reads, and therefore what a quest author can name:
     *   `name`     the venue label, e.g. "Lido Swim Challenge"
     *   `venueId`  the venue id, e.g. `meridian_court`
     *   `won` + `target`/`id`  composed into `<gameId>_won` / `<gameId>_lost`,
     *             which is also what a bare `<gameId>` or the kind matches
     *             THROUGH, by token run. See the branch for why the game id is
     *             never offered bare.
     * `place` and `score` are still carried and still unread by the matcher;
     * they are on the payload for a listener that wants the shape of the
     * result rather than its identity.
     *
     * Emitted on any FINISH, win or lose, and never on an abort: completing a
     * contest is the thing a step counts, and walking out of one is not
     * completing it. */
    this.bus?.emit('quest:activity', {
      type: 'minigame',
      target: result.gameId,
      id: result.gameId,
      name: result.label,
      kind: result.kind,
      venueId: result.venueId,
      won: result.won,
      place: result.place,
      score: result.score,
      worldId: this._worldId,
    });

    /* The loss notice NAMES the floor.
     *
     * A credit the player is not told about is a credit they do not know they
     * earned, and the whole reason the floor exists is to change what finishing
     * a losing contest feels like. Saying "lost" and quietly adding 3 CR would
     * leave the design decision invisible to the only person it is for. */
    const took = result.rivalName ? ` — ${result.rivalName} took it` : '';
    /* The GRADE goes in the toast, because the grade is now what the payout is
     * a function of. "Won — +67 credits" against a 96 CR venue reads as a bug
     * unless the line also says bronze. */
    const grade = medal ? ` — ${medal}` : '';
    this.bus?.emit('hud:notify', {
      text: won
        ? `${result.label} won${grade} — +${credits} credits`
        : `${result.label} lost${took}${credits > 0 ? ` — +${credits} for finishing` : ''}`,
      tone: won ? 'good' : 'warn',
    });
  }

  dispose() {
    this._teardown();
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* handlers already gone */
      }
    }
    this._offs.length = 0;
  }
}

export default MinigameManager;
