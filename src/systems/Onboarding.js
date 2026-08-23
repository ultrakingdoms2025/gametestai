import { SET_COSMETIC } from './Relics.js';
import { CHARACTER_SKINS_BY_ID } from './Cosmetics.js';

/**
 * THE FIRST TWO MINUTES, AND THEY HAPPEN SIGNED OUT.
 *
 * ===========================================================================
 *  WHY THIS FILE EXISTS AND WHY IT CANNOT USE THE QUEST SYSTEM
 * ===========================================================================
 *
 * Nothing in this game ran once on first play. The de-facto tutorial was the
 * station's ten opening jobs - and those are quests, which means they need an
 * account, a live Postgres and the Next site to appear AT ALL. A first-run
 * player has none of the three, so the tutorial did not exist for the only
 * person it was for. Offline the board does not error; it is simply empty
 * (`QuestSystem.js:426-442`), which is the worst version: nobody is told there
 * was supposed to be anything there.
 *
 * The product decision, taken before this file was written, is that
 * **onboarding works signed out, from bundled local content**. A first-run
 * player with no account gets the whole opening - movement, interaction,
 * combat, reward, mount, marketplace and the objective - and signing in is sold
 * on durability and cross-device, never as a gate on content.
 *
 * So this file has no network of any kind, no account, no storage of its own
 * and no reference to the mission board. It is pure local state over local
 * events, which is what every other progression system in this game already
 * is, and it is why they all work offline and the quest board does not.
 * `onboarding.test.mjs` scrapes this file's CODE for the four ways that could
 * regress.
 *
 * ===========================================================================
 *  EVERY STEP HAS AN EMITTER, AND THAT IS THE RULE THAT WAS PAID FOR
 * ===========================================================================
 *
 * Five step verbs - `stealth investigate deliver escort craft` - were deleted
 * from `QuestSystem` after an audit found 0 of 50 seeded quests completable.
 * Every one of them was an authored objective waiting on a channel nothing
 * fired. A tutorial is that failure at maximum blast radius: it is the FIRST
 * thing a new player is asked to do, and a step they cannot complete is a game
 * they close.
 *
 * So every step below names a bus event that already exists in the shipped
 * game, and the test scrapes `src/` for all of them. Adding a step means
 * finding an emitter first.
 *
 * ===========================================================================
 *  IT IS FORGIVING ON PURPOSE
 * ===========================================================================
 *
 * Steps credit OUT OF ORDER. The panel shows the first one that is still
 * outstanding, so there is always exactly one next action - the acceptance
 * condition for this phase - but a player who wanders into the market before
 * firing a shot has still learned the market, and a tutorial that refused the
 * credit because it was not their turn would be a tutorial arguing with them.
 *
 * ===========================================================================
 *  IT HANDS OFF TO THE OBJECTIVE RATHER THAN ENDING
 * ===========================================================================
 *
 * The last three steps are the station's three DEEDS in `Charters.js` - first
 * trade, first mount, first gateway - which is the station's whole record in
 * the mission design ("arrival, orientation"). Finishing the opening sequence
 * therefore restores the first of the eighteen charters, and the payoff for
 * the tutorial is the objective starting rather than a panel disappearing.
 * The two lists are asserted to agree, because two lists meaning the same thing
 * is how a player finishes a tutorial and is told they have not begun.
 */

/* ====================================================================== */
/* 1. The sequence                                                        */
/* ====================================================================== */

/**
 * The opening sequence, in the order it is offered.
 *
 * `teaches` is the brief's own vocabulary - movement, interaction, combat,
 * reward, mount, marketplace, objective - and it is what the test asserts
 * against, so renaming a step cannot quietly drop one of the seven.
 *
 * Every `text` is an instruction with a key in it. "Explore the station" is not
 * an instruction; "hold W to walk, Space to jump" is.
 */
export const ONBOARDING_STEPS = Object.freeze([
  Object.freeze({
    id: 'move',
    teaches: 'movement',
    event: 'player:footstep',
    title: 'Get your bearings',
    text: 'W A S D to walk, Space to jump, Shift to sprint.',
  }),
  Object.freeze({
    id: 'talk',
    teaches: 'interaction',
    event: 'chat:open',
    title: 'Talk to someone',
    text: 'Walk up to anybody on the concourse and press E. They will talk back.',
  }),
  Object.freeze({
    id: 'fire',
    teaches: 'combat',
    event: 'weapon:fired',
    title: 'Draw and fire',
    text: '1-4 picks a weapon, left mouse fires, R reloads.',
  }),
  Object.freeze({
    id: 'kill',
    teaches: 'combat',
    event: 'npc:killed',
    title: 'Put a hostile down',
    text: 'Raiders work the outer ring. Down one.',
  }),
  Object.freeze({
    id: 'loot',
    teaches: 'reward',
    event: 'loot:collected',
    title: 'Take the drop',
    text: 'Walk over what it left. Credits and ammunition go straight into your bag.',
  }),
  /* --- the station's record, which is also the end of the tutorial ------ */
  Object.freeze({
    id: 'market',
    teaches: 'marketplace',
    event: 'market:trade',
    title: 'Trade',
    text: 'Find a trader and press B. Buy or sell — either counts.',
  }),
  Object.freeze({
    id: 'mount',
    teaches: 'mount',
    event: 'mount:mounted',
    title: 'Ride',
    text: 'G summons your mount. Get on it.',
  }),
  Object.freeze({
    id: 'gateway',
    teaches: 'objective',
    event: 'portal:entering',
    title: 'Chart the Nexus',
    text: 'Six gateways ring this dome and eighteen worlds are missing their records. Step through one.',
  }),
]);

const STEP_BY_ID = new Map(ONBOARDING_STEPS.map((s) => [s.id, s]));

/**
 * The early win.
 *
 * The brief asks for a visible reward inside two minutes, and the honest place
 * for it is the moment the player has just done something: taken their first
 * drop. It is an ITEM rather than credits, deliberately - the first minutes of
 * this game already pay credits from four sources and a fifth number going up
 * teaches nothing, where a medkit in the bag is a thing they now have and will
 * later use.
 *
 * `after` is a step id and is asserted to be one, and to be in the FRONT half
 * of the sequence: a reward that lands last is not an early win.
 */
export const ONBOARDING_GRANT = Object.freeze({
  after: 'loot',
  item: 'medkit',
  qty: 2,
  label: 'Two medkits',
});

/**
 * Which payloads count, per event.
 *
 * Only two channels need a filter and both would otherwise be wrong in a way
 * nobody would notice: `npc:killed` fires for every death in the world
 * including ones the player had nothing to do with, and a tutorial that ticked
 * "put a hostile down" because two raiders shot each other has taught nothing.
 */
const ACCEPTS = {
  'npc:killed': (p) => p?.npc?.type === 'hostile' && p?.byPlayer !== false,
};

/* ====================================================================== */
/* 2. The system                                                          */
/* ====================================================================== */

export class Onboarding {
  /**
   * @param {{bus?:any, inventory?:any}} ctx
   */
  constructor({ bus, inventory } = {}) {
    this.bus = bus ?? null;
    this.inventory = inventory ?? null;

    /**
     * Step ids already done. Identity, so a reordering cannot shift them.
     *
     * ── And there is deliberately no second "paid" receipt beside it ─────────
     * `Viewpoints._setPaid` and `Relics._paid` both keep one, because both of
     * their sets can complete WITHOUT a transition through this process - a
     * cross-device merge can fill the last viewpoint in, and then there is no
     * next sync to pay the prize on, so entering the world has to settle it and
     * a receipt is what stops that paying twice.
     *
     * The opening grant has no such path. It is paid on the one frame `loot`
     * goes from outstanding to done, `_credit` returns early for a step already
     * in this set, and `deserialize` never pays at all. So the set IS the
     * receipt, and a second one would be a second authority that could disagree
     * with the first.
     */
    this._done = new Set();

    this._offs = [];
    if (this.bus) {
      /* One subscription per DISTINCT channel, not one per step, so two steps
       * on the same channel cannot double-subscribe it. */
      const byEvent = new Map();
      for (const step of ONBOARDING_STEPS) {
        const list = byEvent.get(step.event) ?? [];
        list.push(step);
        byEvent.set(step.event, list);
      }
      for (const [event, steps] of byEvent) {
        this._offs.push(bus.on(event, (p) => this._credit(event, steps, p)));
      }
      /* Say the first instruction OUT LOUD the moment the player is in the
       * world, rather than waiting for them to do something.
       *
       * Without this the panel is blank until the first footstep - and the
       * whole point of the first step is to tell somebody who has not moved yet
       * which keys move them. It is also what puts the tutorial face on the
       * shared HUD panel before the charter board claims it. */
      this._offs.push(bus.on('game:started', () => this._announce()));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Read surface                                                        */
  /* ------------------------------------------------------------------ */

  /** @param {string} id */
  done(id) {
    return this._done.has(id);
  }

  /** True once every step is done. */
  get complete() {
    return this._done.size >= ONBOARDING_STEPS.length;
  }

  /**
   * The one thing to do next, or null when there is nothing left.
   *
   * The FIRST outstanding step in publication order, not the nearest or the
   * cheapest: the order is the lesson plan, and a tutorial that reorders itself
   * around what the player happens to have done is a tutorial with no shape.
   */
  next() {
    for (const step of ONBOARDING_STEPS) if (!this._done.has(step.id)) return step;
    return null;
  }

  /** Every step with its state, for a panel to draw. */
  steps() {
    return ONBOARDING_STEPS.map((s) => ({
      id: s.id,
      title: s.title,
      text: s.text,
      teaches: s.teaches,
      done: this._done.has(s.id),
    }));
  }

  /**
   * The aspirational locked reward on display.
   *
   * Read from the two catalogues that already own it - `Relics.SET_COSMETIC`
   * for which skin the relic sweep pays, and `Cosmetics.CHARACTER_SKINS_BY_ID`
   * for its name - rather than named here. A skin id typed into this file would
   * be a fourth copy of something that lives in three places, and it would be
   * the copy that goes stale.
   *
   * It is deliberately something the SHOP DOES NOT SELL. A reward that can be
   * bought is not aspirational, it is a price.
   */
  lockedReward() {
    const skin = CHARACTER_SKINS_BY_ID.get(SET_COSMETIC);
    if (!skin) return null;
    return {
      id: SET_COSMETIC,
      name: skin.name,
      blurb: skin.blurb,
      how: 'Recover every relic in a world.',
      locked: true,
    };
  }

  /** What a panel draws in one object. */
  progress() {
    const next = this.next();
    return {
      done: this._done.size,
      total: ONBOARDING_STEPS.length,
      complete: this.complete,
      next: next ? { id: next.id, title: next.title, text: next.text } : null,
      steps: this.steps(),
      locked: this.lockedReward(),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Crediting                                                           */
  /* ------------------------------------------------------------------ */

  _credit(event, steps, payload) {
    const accept = ACCEPTS[event];
    if (accept && !accept(payload)) return;
    let moved = false;
    for (const step of steps) {
      if (this._done.has(step.id)) continue;
      this._done.add(step.id);
      moved = true;
      this.bus?.emit('onboarding:step', {
        id: step.id, title: step.title, done: this._done.size, total: ONBOARDING_STEPS.length,
      });
      if (ONBOARDING_GRANT.after === step.id) this._pay();
    }
    if (moved) this._announce();
  }

  /**
   * Hand over the opening reward.
   *
   * Called from exactly one place - the frame the grant's step goes from
   * outstanding to done - which is what makes it once-only without a receipt.
   * `loot:collected` fires on every single pickup, so that transition is doing
   * real work: see the note on `_done`.
   *
   * `Inventory.acquire` ignores an unknown id, so this file holds no copy of
   * the item catalogue and a catalogue edit can never turn a tutorial reward
   * into a crash - the rule `SpaceObjectives._payTier` writes down.
   */
  _pay() {
    this.inventory?.acquire?.(ONBOARDING_GRANT.item, ONBOARDING_GRANT.qty);
    this.bus?.emit('hud:notify', {
      text: `${ONBOARDING_GRANT.label} — yours. Press Tab for your bag.`,
      tone: 'good',
    });
  }

  _announce() {
    this.bus?.emit('onboarding:changed', this.progress());
  }

  /* ------------------------------------------------------------------ */
  /* Persistence                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * One identity set and nothing else. No count, no "stage", no index: a step
   * order that changed between builds would move a stored index onto a
   * different lesson, which is the shape of the defect `Relics.serialize` had
   * when it stored a tally instead of a set.
   */
  serialize() {
    return { done: [...this._done] };
  }

  /**
   * Restore. REPLACE, not merge - the rule the whole progress layer records:
   * a load must be able to take progress away, or a player keeps a tutorial
   * state the save they loaded does not contain.
   *
   * An unknown step id is DROPPED rather than kept. A save from a build with a
   * ninth step would otherwise leave it in the set for ever, and the panel
   * would read "9 of 8" while claiming to be finished.
   *
   * @param {any} data
   * @returns {boolean} true when a well-formed payload was applied
   */
  deserialize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    this._done.clear();
    if (Array.isArray(data.done)) {
      for (const id of data.done) if (STEP_BY_ID.has(id)) this._done.add(id);
    }
    this._announce();
    return true;
  }

  dispose() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._done.clear();
  }
}
