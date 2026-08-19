/**
 * QuestSystem — backend-integrated quest tracking.
 *
 * Fetches active quests for the current world from /api/game/quests and tracks
 * player progress by subscribing to the existing event bus:
 *   - npc:killed      → kill-type steps
 *   - loot:collected  → collect-type steps
 *   - race:finished   → race-type steps (single completion)
 *   - race:lap        → race-type steps with count > 1 (cumulative)
 *   - world:changed   → visit-type steps for the destination world
 *   - quest:activity  → talk/interact/other step types using target IDs
 *
 * Quest steps progress automatically from game events when their target ID and
 * world match the current activity. Manual completion is no longer required.
 *
 * Progress is synced to the backend every 10 s, on step completion, and on page
 * hide (via `sendBeacon`, which survives teardown where `fetch` does not).
 * Credit awards are the SERVER's to decide: the completion response carries the
 * authoritative balance and this class mirrors it. See `_completeQuest`.
 */

import { allows } from '../worlds/WorldRules.js';

/**
 * Seconds of damage-free time that credit one `survive` count.
 *
 * Thirty seconds is long enough that it cannot be earned by standing still for
 * a moment and short enough that a step of `count: 2` is a minute, not a chore.
 * See `_onPlayerDamaged`.
 */
const SURVIVE_TICK_S = 30;

export class QuestSystem {
  /**
   * @param {{ bus:any, player:any, economy:any, worldManager:any, npcManager:any }} ctx
   */
  constructor({ bus, player, economy, worldManager, npcManager } = {}) {
    this.bus         = bus         ?? null;
    this.player      = player      ?? null;
    this.economy     = economy     ?? null;
    this.worldManager= worldManager?? null;
    this.npcManager  = npcManager  ?? null;

    /** @type {string|null} */
    this._playerId  = null;
    /** @type {string|null} */
    this._worldId   = null;
    /** All active quests for the current world. @type {object[]} */
    this.worldQuests = [];
    /**
     * Map of engagementId → { quest, engagement, stepStates, timeLeftMs }
     * @type {Map<string, object>}
     */
    this.engagements = new Map();

    this._syncT     = 10;
    this._syncQueue = new Set();
    this._pending   = false;

    /**
     * Counts world ENTRIES, not worlds. Three call sites have to be able to
     * credit a `visit` (see `_creditVisit`); stamping each engagement with the
     * epoch it was last credited for makes the credit idempotent per entry
     * while still letting a genuine re-entry count again.
     */
    this._visitEpoch = 0;

    /**
     * Seconds of unbroken, undamaged time. Drives `survive` steps; reset to 0
     * by `player:damaged`. See `_onPlayerDamaged` for why this replaced the
     * inverted handler that used to advance `survive` when the player was hit.
     */
    this._surviveT = 0;

    /** @type {Array<()=>void>} */
    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('world:changed', ({ id, world }) => {
        this._worldId = id ?? world?.id ?? null;
        // Bumped before the maze bail-out: leaving and re-entering through a
        // quest-less world is still two separate entries to the world after it.
        this._visitEpoch++;
        // The maze is its own objective.
        if (!allows(world, 'quests')) { this.worldQuests = []; return; }
        this._pending = true;
        this._creditVisit(this._worldId);
      }));
      this._offs.push(this.bus.on('player:identity', ({ playerId }) => {
        if (playerId) this._playerId = playerId;
      }));
      this._offs.push(this.bus.on('npc:killed',      (e) => this._onKill(e)));
      this._offs.push(this.bus.on('npc:damaged',     (e) => this._onNpcDamaged(e)));
      this._offs.push(this.bus.on('loot:collected',  (e) => this._onCollect(e)));
      this._offs.push(this.bus.on('race:finished',   (e) => this._onRaceFinished(e)));
      this._offs.push(this.bus.on('race:lap',        (e) => this._onRaceLap(e)));
      this._offs.push(this.bus.on('player:damaged',  (e) => this._onPlayerDamaged(e)));
      this._offs.push(this.bus.on('portal:entering',  (e) => this._onPortalEntering(e)));
      this._offs.push(this.bus.on('market:trade',    (e) => this._onMarketTrade(e)));
      this._offs.push(this.bus.on('character:changed', (e) => this._onCharacterChanged(e)));
      this._offs.push(this.bus.on('quest:activity',  (e) => this._onActivity(e)));
    }

    /* Up to 10 s of step progress used to die with the tab. `pagehide` is the
     * one event that fires for every teardown path (close, navigate, bfcache)
     * and `visibilitychange` catches a backgrounded mobile tab the OS may never
     * wake again; `beforeunload` is kept for the browsers that still favour it.
     * All three land on the same idempotent flush - it empties the queue, so
     * whichever fires first does the work and the rest are no-ops. */
    if (typeof window !== 'undefined') {
      // `typeof` rather than a bare reference: a headless harness can have a
      // window shim and no document, and an undeclared identifier throws.
      const doc = typeof document !== 'undefined' ? document : null;
      const onHide = () => this._flushBeacon();
      const onVisibility = () => {
        if (doc?.visibilityState === 'hidden') this._flushBeacon();
      };
      window.addEventListener('pagehide', onHide);
      window.addEventListener('beforeunload', onHide);
      doc?.addEventListener('visibilitychange', onVisibility);
      this._offs.push(() => {
        window.removeEventListener('pagehide', onHide);
        window.removeEventListener('beforeunload', onHide);
        doc?.removeEventListener('visibilitychange', onVisibility);
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */

  /** Called every frame by main.js. */
  update(dt) {
    if (this._pending && this._worldId) {
      this._pending = false;
      void this._loadQuestsForWorld(this._worldId);
    }
    // Time-limit tracking
    for (const [id, entry] of this.engagements) {
      if (entry.engagement.status !== 'in_progress') continue;
      if (entry.timeLeftMs === null || entry.timeLeftMs === undefined) continue;
      entry.timeLeftMs -= dt * 1000;
      if (entry.timeLeftMs <= 0) {
        entry.timeLeftMs = 0;
        void this._failQuest(id, 'Time expired');
      }
    }
    /* `survive` — one count per unbroken SURVIVE_TICK_S without damage.
     *
     * Only ticked while there is something to credit, so a player with no
     * quests accrues nothing and the first accepted quest starts from zero.
     *
     * At most ONE credit per frame, and the accumulator is zeroed rather than
     * decremented. A backgrounded tab or a long world generation can hand this
     * a `dt` of many seconds, and draining that with a loop would pay out a
     * whole quest's worth of "survival" for time the player was not playing.
     * The drift this costs is under one frame per 30 s, which is nothing. */
    if (this.engagements.size) {
      this._surviveT += dt;
      if (this._surviveT >= SURVIVE_TICK_S) {
        this._surviveT = 0;
        this._creditSurvive();
      }
    } else {
      this._surviveT = 0;
    }

    // Periodic backend sync
    this._syncT -= dt;
    if (this._syncT <= 0) {
      this._syncT = 10;
      void this._flushSync();
    }
  }

  /**
   * Compact, token-cheap description of the player's IN-PROGRESS quests.
   *
   * Two consumers, one shape. `QuestBoard._renderDetail` already draws exactly
   * this — label, type, have/count, done — so the HUD objective tracker and the
   * NPC chat prompt describe a quest the same way the board does rather than
   * each re-deriving it from `quest.steps` + `stepStates`.
   *
   * Capped because the second consumer is a language-model prompt: an
   * unbounded list of every accepted quest would crowd out the persona it is
   * attached to. Three is enough for "what am I doing right now".
   *
   * @param {number} [limit=3] maximum quests returned
   * @returns {Array<{title:string, world:string|null, percent:number,
   *   steps:Array<{order:number, label:string, type:string, target:string,
   *   have:number, count:number, done:boolean, world:string|null}>}>}
   */
  summary(limit = 3) {
    const out = [];
    for (const [, entry] of this.engagements) {
      if (entry?.engagement?.status !== 'in_progress') continue;
      const quest = entry.quest;
      const steps = this._parseSteps(quest?.steps).map((step) => {
        const state = entry.stepStates?.[step.order] ?? { done: false, have: 0 };
        const count = Math.max(1, Number(step.count) || 1);
        return {
          order: step.order,
          label: String(step.label ?? ''),
          type: String(step.type ?? ''),
          target: String(step.target ?? ''),
          have: Math.min(Math.max(0, Number(state.have) || 0), count),
          count,
          done: !!state.done,
          world: step.world ?? null,
        };
      });
      out.push({
        title: String(quest?.title ?? 'Quest'),
        world: quest?.world ?? entry.engagement?.world ?? null,
        percent: Number(entry.engagement?.percent_complete) || 0,
        steps,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Open the quest board UI. */
  openBoard() {
    this.bus?.emit('quests:board:open', {
      quests: this.worldQuests,
      engagements: this.engagements,
    });
  }

  /**
   * Accept a quest by its DB id.
   * @param {string} questId
   */
  async accept(questId) {
    const quest = this.worldQuests.find((q) => q.id === questId);
    if (!quest) { console.warn('[QuestSystem] quest not found:', questId); return; }
    if (!this._playerId) {
      this.bus?.emit('hud:notify', { text: 'Sign in to accept quests', tone: 'bad' });
      return;
    }
    // Already active?
    for (const [, entry] of this.engagements) {
      if (entry.quest?.id === questId && entry.engagement.status === 'in_progress') {
        this.bus?.emit('hud:notify', { text: 'Quest already in progress', tone: 'info' });
        return;
      }
    }
    try {
      const res = await fetch('/api/game/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          action: 'accept',
          questId: quest.id,
          questNumber: quest.quest_number,
          questTitle: quest.title,
          world: quest.world,
          durationMinutes: quest.duration_minutes ?? null,
        }),
      });
      if (!res.ok) {
        /* A refused accept EXPLAINS itself in the body, and throwing on the
         * status alone threw that explanation away.
         *
         * The route answers an ineligible-but-well-formed accept with 409 and
         * either `{reason:'prerequisites', missing:[...], error:'Complete
         * first: …'}` or `{reason:'already_completed', error:…}`. All of it was
         * discarded here, so a player blocked by a cross-world prerequisite was
         * told "Could not accept quest" — which names neither the reason nor
         * the quest they still have to finish, and reads like a bug rather than
         * a rule. Only a response that explains nothing falls through to the
         * generic failure below. */
        const detail = await res.json().catch(() => null);
        const missing = Array.isArray(detail?.missing) ? detail.missing.filter(Boolean) : [];
        const text = String(detail?.error ?? '').trim()
          || (missing.length ? `Complete first: ${missing.join(', ')}` : '');
        if (text) {
          this.bus?.emit('hud:notify', { text, tone: 'bad' });
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const { engagementId } = await res.json();

      const steps = this._parseSteps(quest.steps);
      const stepStates = {};
      for (const step of steps) stepStates[step.order] = { done: false, have: 0 };
      const timeLeftMs = quest.duration_minutes
        ? quest.duration_minutes * 60 * 1000
        : null;

      this.engagements.set(engagementId, {
        quest,
        engagement: {
          id: engagementId, quest_id: quest.id,
          quest_number: quest.quest_number, quest_title: quest.title,
          world: quest.world, status: 'in_progress',
          percent_complete: 0, accepted_at: new Date().toISOString(),
        },
        stepStates,
        timeLeftMs,
      });
      // A quest taken while already standing in its world still ticks its visit
      // step; `_creditVisit` makes sure the world entry is only counted once.
      this._creditVisit();
      this.bus?.emit('quests:changed', { engagements: this.engagements });
      this.bus?.emit('hud:notify', { text: `Quest accepted — ${quest.title}`, tone: 'info' });
    } catch (err) {
      console.error('[QuestSystem] accept failed:', err);
      this.bus?.emit('hud:notify', { text: 'Could not accept quest', tone: 'bad' });
    }
  }

  /**
   * Manually mark a non-auto step as done (called from QuestBoard).
   * @param {string} engagementId
   * @param {number} stepOrder
   */
  async markStepDone(engagementId, stepOrder) {
    const entry = this.engagements.get(engagementId);
    if (!entry || entry.engagement.status !== 'in_progress') return;
    const steps = this._parseSteps(entry.quest?.steps);
    const stepDef = steps.find((s) => s.order === stepOrder);
    if (!stepDef) return;
    const state = entry.stepStates[stepOrder] ?? { done: false, have: 0 };
    if (state.done) return;
    state.have  = stepDef.count;
    state.done  = true;
    entry.stepStates[stepOrder] = state;
    this.bus?.emit('hud:notify', { text: `Step done: ${stepDef.label}`, tone: 'good' });
    this._syncQueue.add(engagementId);
    this._checkQuestComplete(engagementId);
    this.bus?.emit('quests:changed', { engagements: this.engagements });
  }

  destroy() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Private — world load                                                */
  /* ------------------------------------------------------------------ */

  async _loadQuestsForWorld(worldId) {
    try {
      const res = await fetch(`/api/game/quests?world=${worldId}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) {
        this.bus?.emit('hud:notify', { text: 'Could not load quests', tone: 'bad' });
        return;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Unexpected response type: ${contentType || 'unknown'}`);
      }
      const data = await res.json();

      if (data.player_id && !this._playerId) this._playerId = data.player_id;
      this.worldQuests = data.quests ?? [];

      // Merge backend engagements into local state
      for (const eng of (data.engagements ?? [])) {
        if (this.engagements.has(eng.id)) continue; // local state takes priority

        const quest = this._resolveQuestForEngagement(eng);
        const steps = this._parseSteps(quest?.steps);
        const stored = eng.step_states ? JSON.parse(eng.step_states) : {};
        const stepStates = {};
        for (const step of steps) {
          stepStates[step.order] = stored[step.order] ?? { done: false, have: 0 };
        }

        let timeLeftMs = null;
        if (eng.status === 'in_progress' && eng.duration_minutes) {
          const elapsed = Date.now() - new Date(eng.accepted_at).getTime();
          timeLeftMs = Math.max(0, eng.duration_minutes * 60 * 1000 - elapsed);
        }

        this.engagements.set(eng.id, { quest, engagement: eng, stepStates, timeLeftMs });
      }

      // Engagements restored from the backend get the same one-per-entry credit
      // as locally accepted ones.
      this._creditVisit();

      this.bus?.emit('quests:changed', {
        worldId,
        quests: this.worldQuests,
        engagements: this.engagements,
      });
    } catch (err) {
      console.warn('[QuestSystem] load failed:', err);
      this.bus?.emit('hud:notify', { text: 'Could not load quests', tone: 'bad' });
    }
  }

  /**
   * The quest an engagement belongs to — even when that quest lives in ANOTHER
   * world.
   *
   * `GET /api/game/quests?world=W` scopes `quests` to W but returns engagements
   * for EVERY world, which is what makes the multi-world quests work at all.
   * This used to be `worldQuests.find(...) ?? null`, so every engagement whose
   * quest was not authored in the world the player happened to reload in
   * resolved to `null`. That is not a cosmetic miss: `_parseSteps(null)` is
   * `[]`, so `stepStates` came back empty (discarding the progress the server
   * had stored), `_advanceSteps` had no steps to walk and `_checkQuestComplete`
   * early-returned on `!steps.length`. The engagement could never advance and
   * never complete — permanently stuck, drawn as a blank row on the board.
   *
   * Filtering the engagement list to the current world would "fix" the blank
   * row by hiding the quest entirely, which is the opposite of what a quest
   * that sends you to every world needs.
   *
   * The row already carries everything required: `getPlayerQuestEngagements`
   * LEFT JOINs `quests`, so `quest_line`, `reward_credits` and `quest_steps`
   * ride along with the engagement. Prefer the live world row when there is one
   * (it is the same quest and it is the freshest copy), otherwise rebuild.
   *
   * @param {object} eng engagement row from the API
   * @returns {object} always a usable quest object, never null
   */
  _resolveQuestForEngagement(eng) {
    const local = eng?.quest_id
      ? this.worldQuests.find((q) => q.id === eng.quest_id)
      : null;
    return local ?? this._questFromEngagement(eng);
  }

  /**
   * Rebuild a quest object from an engagement's own denormalised fields.
   *
   * Shaped to match a `quests` row exactly, because every consumer
   * (`QuestBoard`, `summary()`, `_completeQuest`, `_percentFor`) reads
   * `entry.quest` without caring where it came from.
   *
   * `steps` is the load-bearing field — with it, `stepStates` rehydrates from
   * the stored server progress and both `_advanceSteps` and
   * `_checkQuestComplete` work normally. `reward_credits` is only ever a
   * display/fallback value here: the payout is re-read from `quests` by the
   * server on complete, so a wrong or missing number cannot mis-pay.
   *
   * @param {object} eng
   */
  _questFromEngagement(eng) {
    return {
      id:               eng?.quest_id ?? null,
      quest_number:     eng?.quest_number ?? null,
      quest_line:       eng?.quest_line ?? null,
      title:            eng?.quest_title ?? 'Quest',
      // The engagement's world IS the quest's world — it is copied from
      // `quests.world` at accept time and never rewritten.
      world:            eng?.world ?? null,
      reward_credits:   Number(eng?.reward_credits) || 0,
      duration_minutes: eng?.duration_minutes ?? null,
      steps:            eng?.quest_steps ?? null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Private — event handlers                                            */
  /* ------------------------------------------------------------------ */

  _onKill(e) {
    const npc = e?.npc;
    if (!npc || npc.type !== 'hostile') return;
    /* A herbivore is not a kill anybody asked for. `BeastNPC` files every
     * animal as a hostile - see the note on `type` there - and
     * `_matchesStepTarget` returns true for a step with no `target` at all, so
     * an untargeted "kill N" step advanced on the Sunspire camels: 220 HP,
     * no attack of any kind, and a 22 s respawn. Keyed on the species row
     * rather than on the species, so a predator added later still counts. */
    if (npc.isBeast && npc.def?.predator === false) return;
    this._advanceSteps('kill', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
    this._advanceSteps('defend', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
  }
  
  _onNpcDamaged(e) {
    const npc = e?.npc;
    if (!npc || npc.type !== 'hostile') return;
    this._advanceSteps('defend', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
  }
  
  _onCollect(e) {
    this._advanceSteps('collect', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
  }
  
  _onRaceFinished(e) {
    /* A DNF is not a win.
     *
     * `race:finished` fires at the flag for every ending the race can have,
     * including the player abandoning it or still circulating when the winner
     * crossed - RaceManager sets `dnf` for exactly those (RaceManager.js:1292).
     * Without this guard a step targeting a circuit id completed on a run the
     * player did not finish, because the circuit id is in the payload either
     * way. Place-targeted steps were already safe by accident and are now safe
     * by construction: `_eventTargetCandidates` only offers `place_N` when
     * `place > 0`, and a DNF reports place 0.
     */
    if (e?.dnf) return;
    // Single-completion race steps (count === 1)
    this._advanceSteps('race', (step, meta) => step.count === 1 && this._matchesStepTarget(step, meta), { event: e });
  }
  
  _onRaceLap(e) {
    /* Multi-lap steps. `race:lap` fires for EVERY entrant, AI included, so the
     * player's lap counter has to be filtered out of the field's - otherwise a
     * nine-car race credits the player nine laps for one of their own, and now
     * that the event carries a circuit id it would do so for targeted steps
     * too. */
    if (e && e.isPlayer !== true) return;
    this._advanceSteps('race', (step, meta) => step.count > 1 && this._matchesStepTarget(step, meta), { event: e });
  }
  
  /**
   * Taking a hit RESETS survival; it never credits it.
   *
   * This handler used to call `_advanceSteps('survive', …)`, which is the exact
   * inverse of the verb: the more damage a player took, the more "survive"
   * progress they banked, and standing in a fire completed the step fastest.
   *
   * Deleting the handler was the other option and it was rejected. It would
   * have left `survive` with no emitter at all, i.e. a step type a quest author
   * can write and no player can ever complete — the same defect class the audit
   * found in `stealth`/`investigate`/`deliver`/`escort`/`craft`, and the reason
   * 0 of 50 quests were completable. Re-grounding costs a timer and gives the
   * content rewrite a verb the engine actually proves.
   *
   * So `survive` now means what it says: unbroken time on your feet. One count
   * is credited per {@link SURVIVE_TICK_S} seconds without being damaged, and
   * any damage puts the accumulator back to zero — `count: 4` is "go two
   * minutes without being hit", not "get hit four times". The tick is credited
   * in `update()`, which is the only place with a clock.
   */
  _onPlayerDamaged(_e) {
    this._surviveT = 0;
  }
  
  _onPortalEntering(e) {
    /* No `visit` credit here.
     *
     * This fires as the player enters the portal, naming a world they have not
     * reached yet (and might not - the transition can still be refused). The
     * arrival is credited by the `world:changed` handler, which is the single
     * authority for visits; crediting here as well double-counted every portal
     * trip. Only the portal-as-a-thing-you-interacted-with survives. */
    this._advanceSteps('interact', (step, meta) => this._matchesStepTarget(step, meta), {
      event: { type: 'interact', target: e?.to ?? e?.target ?? null, id: e?.to ?? e?.target ?? null, worldId: e?.to ?? e?.target ?? null },
    });
  }
  
  _onActivity(e) {
    const type = e?.type;
    if (!type) return;
    this._advanceSteps(type, (step, meta) => this._matchesStepTarget(step, meta), { event: e });
  }
 
  _onMarketTrade(e) {
    this._advanceSteps('purchase', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
  }
 
  _onCharacterChanged(e) {
    this._advanceSteps('customize', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
  }
  
  /**
   * Credit a `visit` for the world the player is now standing in.
   *
   * One world entry used to be credited up to four times - the `world:changed`
   * handler, `accept()`, `_loadQuestsForWorld()` and `portal:entering` all
   * called `_advanceSteps('visit')`, so a single trip could bump a counter by
   * three. The portal call site is gone (it named a world not yet reached); the
   * other three are all load-bearing - an engagement can be created by any of
   * them - so instead of deleting two the credit is made idempotent per world
   * entry. `_visitEpoch` counts entries and each engagement remembers the epoch
   * it was last offered, so whichever call site runs first wins and the others
   * are no-ops. A later re-entry bumps the epoch and counts again, which is
   * what a "visit N times" step means.
   *
   * @param {string|null} [worldId]
   */
  _creditVisit(worldId = this._worldId) {
    if (!worldId) return;
    this._advanceSteps('visit', (step, meta) => this._matchesStepTarget(step, meta), {
      event: { type: 'visit', target: worldId, worldId },
      onceKey: 'visit',
      onceToken: this._visitEpoch,
    });
  }

  /**
   * Credit one `survive` interval to every in-progress engagement.
   *
   * The event carries the current world so a step written as
   * `{type:'survive', target:'citadel'}` only ticks in the citadel; a step with
   * no target ticks anywhere, which is what an untargeted "stay alive" means.
   */
  _creditSurvive() {
    const worldId = this._worldId;
    this._advanceSteps('survive', (step, meta) => this._matchesStepTarget(step, meta), {
      event: { type: 'survive', target: worldId, worldId },
    });
  }

  /**
   * Generic step advancer for auto-tracked types.
   * @param {string} type
   * @param {(step:object, meta:any)=>boolean} filter
   * @param {any} meta may carry `onceKey`/`onceToken` to make the advance
   *   idempotent per engagement for that token (see `_creditVisit`)
   */
  _advanceSteps(type, filter, meta = {}) {
    const worldId = this._worldId;
    const onceKey = meta?.onceKey ?? null;
    for (const [engId, entry] of this.engagements) {
      if (entry.engagement.status !== 'in_progress') continue;
      if (onceKey) {
        // Stamped before any step is examined: the point is "this engagement has
        // already been offered this occurrence", matched or not.
        const seen = (entry._once ??= {});
        if (seen[onceKey] === meta.onceToken) continue;
        seen[onceKey] = meta.onceToken;
      }
      const steps = this._parseSteps(entry.quest?.steps);
      let changed = false;
      for (const step of steps) {
        if (step.type !== type) continue;
        /* The STEP's world, never the quest's — and that distinction is the
         * whole of cross-world play. A quest authored in `station` may carry a
         * step marked `world:'medieval'`; it fires when the PLAYER is in
         * medieval, and a step with no `world` at all fires anywhere. Gating on
         * `entry.quest.world` here would silently make every global quest
         * finishable only in the world that happens to host it. */
        if (step.world && step.world !== worldId) continue;
        if (!filter(step, meta)) continue;
        const state = entry.stepStates[step.order] ?? { done: false, have: 0 };
        if (state.done) continue;
        state.have = Math.min((state.have ?? 0) + 1, step.count);
        if (state.have >= step.count) {
          state.done = true;
          this.bus?.emit('hud:notify', { text: `Step done: ${step.label}`, tone: 'good' });
        }
        entry.stepStates[step.order] = state;
        changed = true;
      }
      if (changed) {
        this._syncQueue.add(engId);
        this._checkQuestComplete(engId);
        this.bus?.emit('quests:changed', { engagements: this.engagements });
      }
    }
  }

  /**
   * Does this event identify the thing the step names?
   *
   * Matching is ANCHORED: a candidate matches only when it is exactly the
   * target, or when the shorter of the two appears as a run of WHOLE
   * underscore-separated tokens inside the longer. Never a bare substring.
   *
   * The old rule was `a === b || a.includes(b) || b.includes(a)`, and it was a
   * false-completion machine rather than merely a loose one. `_normalizeTarget`
   * folds everything down to `[a-z0-9_]`, and the `race` branch below used to
   * offer the bare integer place, so the single character `1` was a candidate
   * after any P1 finish - and `'qualifier_round1'.includes('1')` is true. Every
   * race target containing the digit 1, on any circuit, completed. The same
   * hazard existed for any short id that happened to be a fragment of another.
   *
   * Token runs keep the looseness that is actually useful - `vellum` matching
   * `vellum_ridge_circuit`, `vellum_ridge` matching it too - while making a
   * digit, a prefix or a fragment incapable of standing in for an identity.
   */
  _matchesStepTarget(step, meta = {}) {
    const target = String(step?.target ?? '').trim();
    if (!target) return true;

    const candidates = this._eventTargetCandidates(step?.type, meta?.event);
    const expected = this._normalizeTarget(target);
    if (!expected) return true;
    const expectedTokens = expected.split('_').filter(Boolean);

    return candidates.some((candidate) => {
      const normalized = this._normalizeTarget(candidate);
      if (!normalized) return false;
      if (normalized === expected) return true;
      return this._tokenRunMatch(expectedTokens, normalized.split('_').filter(Boolean));
    });
  }

  /**
   * True when the shorter token list appears contiguously in the longer one.
   * @param {string[]} a
   * @param {string[]} b
   */
  _tokenRunMatch(a, b) {
    if (!a.length || !b.length) return false;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    for (let i = 0; i + short.length <= long.length; i++) {
      let hit = true;
      for (let j = 0; j < short.length; j++) {
        if (long[i + j] !== short[j]) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }

  _eventTargetCandidates(type, event = {}) {
    const candidates = [];
    const push = (value) => {
      if (value == null) return;
      if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
      else if (typeof value === 'number' && Number.isFinite(value)) candidates.push(String(value));
    };
 
    switch (type) {
      case 'kill':
        push(event?.npc?.id);
        push(event?.npc?.name);
        push(event?.npc?.role);
        push(event?.npc?.label);
        push(event?.npc?.templateId);
        break;
      case 'collect':
        push(event?.itemId);
        push(event?.pickup?.itemId);
        push(event?.pickup?.id);
        push(event?.pickup?.templateId);
        break;
      case 'race':
        // Circuit identity, as of RaceManager's `race:finished` / `race:lap`.
        // Without these no race step could say WHICH race was run.
        push(event?.circuitId);
        push(event?.circuitName);
        push(event?.raceType);
        push(event?.id);
        push(event?.name);
        push(event?.trackId);
        push(event?.trackName);
        push(event?.raceId);
        {
          const place = Number(event?.place ?? event?.result?.place ?? 0);
          if (Number.isFinite(place) && place > 0) {
            /* Namespaced, never the bare integer. `push(place)` put the single
             * character "1" into the candidate list, which the old substring
             * matcher then found inside any target containing that digit. */
            push(`place_${place}`);
            push(`p${place}`);
            const placeLabels = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
            push(placeLabels[place - 1] ?? null);
            push(place === 1 ? 'first' : place === 2 ? 'second' : place === 3 ? 'third' : null);
          }
        }
        break;
      case 'minigame':
        /* Contest identity, as of MinigameManager's finish-time `quest:activity`
         * (MinigameManager.js:679) — emitted on any FINISH, win or loss, and
         * never on an abort, so "played it" is countable and "walked out" is
         * not. Without this branch a step could say WHICH contest was played
         * (the default branch reads `target`/`id`/`name`) but never whether it
         * was WON: `won` rode on the payload and no candidate encoded it.
         *
         * The outcome-neutral identities offered are the venue label (`name`)
         * and the venue id. The game id itself is deliberately NOT offered
         * bare: it only ever appears inside the `<gameId>_won` /
         * `<gameId>_lost` COMPOSITE below, exactly one of which rides on every
         * finish.
         *
         * That omission is the race branch's bare-integer lesson one level up.
         * `_tokenRunMatch` is bidirectional — the SHORTER token list matching
         * as a contiguous run inside the longer — so a bare `tennis_match`
         * (or the module kind, `tennis`) present on every finish would sit
         * inside the target `tennis_match_won` as a whole-token run and
         * complete a "win the match" step on a LOSS. A bare `won` is worse
         * still: it is the last token of EVERY win composite, so it would let
         * a tennis win complete "win the swim challenge". So no candidate here
         * is ever a token-subrun of a composite, and the COMPOSITE carries the
         * identity — which is the trick: every plainer spelling still matches
         * THROUGH it, while the outcome spellings only match the outcome that
         * actually happened.
         *
         *   step target            matches because
         *   tennis_match_won       the composite, exactly — and ONLY on a win
         *   tennis_match_lost      the composite, exactly — and ONLY on a loss
         *   tennis_match           tennis_match ⊂ tennis_match_won AND _lost,
         *                          so any finish counts (the "play it" step)
         *   tennis (the kind)      the same run, one token shorter
         *   won / lost             the composite's own last token
         *   Meridian Tennis Match  the venue label, offered as-is
         *   meridian_court         the venue id, offered as-is
         */
        push(event?.name);     // venue label, e.g. 'Meridian Tennis Match'
        push(event?.venueId);  // venue id, e.g. 'meridian_court'
        {
          const raw = typeof event?.target === 'string' && event.target.trim()
            ? event.target
            : event?.id;
          const gameId = typeof raw === 'string' ? raw.trim() : '';
          if (event?.won === true) {
            if (gameId) push(`${gameId}_won`);
            /* A minigame win is first place, in the race branch's namespaced
             * spelling — never the bare integer (the audit's landmine). */
            push('place_1');
            push('p1');
            push('first');
          } else if (event?.won === false) {
            if (gameId) push(`${gameId}_lost`);
          } else if (gameId) {
            // No outcome on the event: fall back to the bare game id, so a
            // hand-rolled or legacy emit still identifies its contest.
            push(gameId);
          }
        }
        break;
      case 'purchase':
        push(event?.itemId);
        push(event?.packId);
        push(event?.id);
        push(event?.kind);
        push(event?.pack?.id);
        push(event?.pack?.itemId);
        break;
      case 'customize':
        {
          const config = event?.config ?? {};
          push(config.sex);
          push(config.outfit);
          push(config.hairStyle);
          push(config.headgear);
          push(config.build);
          push(config.skinTone);
          push(config.hairColor);
          push(config.eyeColor);
          if (typeof config.build === 'number') {
            const buildLabels = ['slim', 'average', 'heavy'];
            push(buildLabels[config.build] ?? null);
            push(`build_${config.build}`);
          }
          push(event?.field);
          push(event?.value);
        }
        break;
      default:
        push(event?.target);
        push(event?.id);
        push(event?.name);
        // `role` flattened onto the event, as HUD's talk/interact now sends it.
        push(event?.role);
        push(event?.itemId);
        push(event?.npc?.id);
        push(event?.npc?.name);
        push(event?.npc?.role);
        push(event?.portal?.id);
        push(event?.portal?.targetName);
        push(event?.worldId);
        push(event?.world);
        break;
    }

    return candidates;
  }

  _normalizeTarget(value) {
    return String(value ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /* ------------------------------------------------------------------ */
  /* Private — completion / failure                                      */
  /* ------------------------------------------------------------------ */

  _checkQuestComplete(engagementId) {
    const entry = this.engagements.get(engagementId);
    if (!entry || entry.engagement.status !== 'in_progress') return;
    const steps = this._parseSteps(entry.quest?.steps);
    if (!steps.length) return;

    const doneCount = steps.filter((s) => entry.stepStates[s.order]?.done).length;
    const pct = Math.round((doneCount / steps.length) * 100);
    entry.engagement.percent_complete = pct;

    if (doneCount === steps.length) {
      void this._completeQuest(engagementId);
    }
  }

  /**
   * Bank a finished quest.
   *
   * The reward is the SERVER's to decide. Two things follow from that:
   *
   * 1. `creditsRewarded` is no longer sent. It was a client-chosen number that
   *    the route wrote straight into `credit_balance`, i.e. a forgeable payout.
   *    The server re-reads `quests.reward_credits` for itself.
   *
   * 2. The unconditional local `economy.add()` is gone - but it could NOT simply
   *    be deleted, because the client economy is not a read-only mirror. main.js
   *    pushes `credits: economy.credits` to /api/game/state, and that route SETs
   *    `credit_balance`. A local balance left stale would therefore overwrite
   *    the server's grant within ~1.5 s and the reward would vanish. So the
   *    balance is taken FROM the completion response: an absolute balance is
   *    `set`, a reward delta is `add`ed. Only when the POST succeeded but told
   *    us nothing recognisable do we fall back to the quest's own
   *    `reward_credits` - which keeps the payout working until the server half
   *    of this change lands, and costs nothing once it has. A POST that failed
   *    grants nothing at all: the engagement is still `in_progress` server-side,
   *    so the reward is deferred rather than lost.
   */
  async _completeQuest(engagementId) {
    const entry = this.engagements.get(engagementId);
    if (!entry) return;
    const questReward = Math.max(0, Math.floor(Number(entry.quest?.reward_credits ?? 0)) || 0);
    entry.engagement.status           = 'completed';
    entry.engagement.percent_complete = 100;

    let awarded = 0;
    try {
      const res = await fetch('/api/game/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'complete', engagementId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => null);
      const balance = Number(data?.creditBalance ?? data?.credits ?? NaN);
      const reward  = Number(data?.creditsRewarded ?? data?.awarded ?? NaN);

      if (Number.isFinite(reward)) awarded = Math.max(0, Math.floor(reward));
      if (Number.isFinite(balance)) {
        // Authoritative balance: mirror it exactly rather than accumulating.
        const next = Math.max(0, Math.floor(balance));
        if (!Number.isFinite(reward)) awarded = Math.max(0, next - (this.economy?.credits ?? next));
        this.economy?.set?.(next, 'quest');
      } else {
        if (!Number.isFinite(reward)) awarded = questReward;
        if (awarded > 0) this.economy?.add?.(awarded, 'quest');
      }
    } catch (err) {
      console.error('[QuestSystem] complete sync:', err);
    }

    this.bus?.emit('quests:quest:complete', { quest: entry.quest, engagementId, credits: awarded });
    this.bus?.emit('quests:changed', { engagements: this.engagements });
    this.bus?.emit('hud:notify', {
      text: `Quest complete — ${entry.quest?.title ?? ''} +${awarded} CR`,
      tone: 'good',
    });
  }

  async _failQuest(engagementId, reason) {
    const entry = this.engagements.get(engagementId);
    if (!entry) return;
    entry.engagement.status         = 'failed';
    entry.engagement.failure_reason = reason;

    try {
      await fetch('/api/game/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'fail', engagementId, reason }),
      });
    } catch (err) {
      console.error('[QuestSystem] fail sync:', err);
    }

    this.bus?.emit('quests:changed', { engagements: this.engagements });
    this.bus?.emit('hud:notify', {
      text: `Quest failed — ${entry.quest?.title ?? ''}: ${reason}`,
      tone: 'bad',
    });
  }

  async _flushSync() {
    if (!this._syncQueue.size) return;
    const ids = [...this._syncQueue];
    this._syncQueue.clear();
    for (const engId of ids) {
      const entry = this.engagements.get(engId);
      /* `completed` is deliberately allowed through.
       *
       * The step that finishes a quest queues its engagement and then completes
       * it in the same call, so by the time the 10 s tick came round the status
       * was no longer `in_progress` and the FINAL step-state write - the one
       * recording which steps were actually done - was dropped on the floor.
       * `updateQuestStepStates` only touches `step_states`/`percent_complete`,
       * never `status`, so writing it after the completion is safe. */
      if (!entry) continue;
      const status = entry.engagement.status;
      if (status !== 'in_progress' && status !== 'completed') continue;
      try {
        await fetch('/api/game/quests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            action: 'progress', engagementId: engId,
            stepStates: entry.stepStates, percentComplete: this._percentFor(entry),
          }),
        });
      } catch {
        this._syncQueue.add(engId); // retry next cycle
      }
    }
  }

  /**
   * Last-chance flush on page teardown.
   *
   * `fetch` is cancelled when the document goes away, so this uses `sendBeacon`,
   * which the browser delivers afterwards. Nothing in here may throw: an
   * exception from an unload handler can abort the rest of the teardown, and
   * main.js flushes the account state on the same event.
   */
  _flushBeacon() {
    try {
      if (!this._syncQueue.size) return;
      const ids = [...this._syncQueue];
      this._syncQueue.clear();
      const beacon = typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon.bind(navigator)
        : null;
      for (const engId of ids) {
        const entry = this.engagements.get(engId);
        if (!entry) continue;
        const body = JSON.stringify({
          action: 'progress', engagementId: engId,
          stepStates: entry.stepStates, percentComplete: this._percentFor(entry),
        });
        if (beacon) {
          beacon('/api/game/quests', new Blob([body], { type: 'application/json' }));
        } else {
          // `keepalive` is the only other request that outlives the document.
          void fetch('/api/game/quests', {
            method: 'POST', keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include', body,
          }).catch(() => {});
        }
      }
    } catch {
      /* never throw out of an unload handler */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Private — helpers                                                   */
  /* ------------------------------------------------------------------ */

  _parseSteps(json) {
    if (!json) return [];
    // Already decoded. `JSON.parse` on an array stringifies it to
    // "[object Object]" and throws, which would silently return [] — the same
    // empty-steps failure mode that made cross-world engagements unfinishable.
    if (Array.isArray(json)) return json;
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  /** Percent of an engagement's steps that are done. */
  _percentFor(entry) {
    const steps = this._parseSteps(entry?.quest?.steps);
    const done = steps.filter((s) => entry?.stepStates?.[s.order]?.done).length;
    return Math.round((done / Math.max(steps.length, 1)) * 100);
  }
}
