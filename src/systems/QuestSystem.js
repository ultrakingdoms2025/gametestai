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
import { offlineQuests } from './QuestsOffline.mjs';

/**
 * Seconds of damage-free time that credit one `survive` count.
 *
 * Thirty seconds is long enough that it cannot be earned by standing still for
 * a moment and short enough that a step of `count: 2` is a minute, not a chore.
 * See `_onPlayerDamaged`.
 */
const SURVIVE_TICK_S = 30;

/**
 * Fold any authored identifier down to `[a-z0-9_]`.
 *
 * Module level and exported because a SECOND consumer now needs the same
 * folding: `Loot` matches a refused pickup against the `collect` steps this
 * file publishes on `quests:collect:pending`, and two spellings of "the same
 * id" is how a matcher stops matching. See `tokenRunMatch`.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeTarget(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * True when the shorter token list appears CONTIGUOUSLY in the longer one.
 *
 * The anchoring is the whole point, and the reason is recorded on
 * `QuestSystem._matchesStepTarget`: the old rule was a bare `includes`, which
 * made the single character `1` a candidate that matched every race target
 * containing the digit. Whole underscore-separated tokens keep the useful
 * looseness (`vellum` inside `vellum_ridge_circuit`) and make a fragment
 * incapable of standing in for an identity.
 *
 * @param {string[]} a
 * @param {string[]} b
 */
export function tokenRunMatch(a, b) {
  if (!a?.length || !b?.length) return false;
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

/**
 * Does `candidate` name the thing `target` asks for?
 *
 * The one place the anchored rule is stated, so the quest matcher and the
 * pickup layer cannot drift apart. Both arguments are normalised here, so
 * callers may pass raw authored strings.
 *
 * @param {string} target the step's target
 * @param {string} candidate an identity the event offered
 */
export function targetMatches(target, candidate) {
  const expected = normalizeTarget(target);
  const got = normalizeTarget(candidate);
  if (!expected || !got) return false;
  if (expected === got) return true;
  return tokenRunMatch(expected.split('_').filter(Boolean), got.split('_').filter(Boolean));
}

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
      /* Wheels down. A DEDICATED subscription rather than a `quest:activity`,
       * for the same reason `race:finished` has one: `Piloting` already emits
       * the fact with the world and the pad on it, and routing it through the
       * generic channel would mean editing `Piloting` to say a second time
       * something it already says. `_onActivity` forwards `e.type` verbatim, so
       * only channels that go through it need an emitter edit. */
      this._offs.push(this.bus.on('pilot:landed',    (e) => this._onLanded(e)));
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
      this._emitChanged({});
      this.bus?.emit('hud:notify', { text: `Quest accepted — ${quest.title}`, tone: 'info' });
    } catch (err) {
      console.error('[QuestSystem] accept failed:', err);
      this.bus?.emit('hud:notify', { text: 'Could not accept quest', tone: 'bad' });
    }
  }

  /**
   * Give a quest back.
   *
   * ── The exit that did not exist ──────────────────────────────────────────
   *
   * `abandon` appeared nowhere: not in this file, not in `QuestBoard`, not in
   * the API route. The only ways out of `in_progress` were finishing it and
   * `_failQuest('Time expired')` - and that timer is WALL CLOCK, recomputed on
   * reload as `duration_minutes*60000 - (Date.now() - accepted_at)`, so
   * accepting a 45-minute quest and logging off overnight auto-failed it. That
   * much is recoverable, because a failed engagement is re-acceptable (the
   * board's `available` tab includes them). What was not recoverable was
   * changing your mind: a player who took a quest they did not want had to
   * either complete it or wait out its window to clear the board.
   *
   * Deliberately shaped as a `fail` and not as a deletion. Three consequences,
   * all of them wanted: the engagement is re-acceptable afterwards, the reason
   * is on the row so the board can say what happened, and no server-side
   * completion is implied - abandoning pays nothing, exactly like
   * `MinigameManager.abort` and `RaceManager.abort`.
   *
   * ── The two-step POST, and when it becomes one ───────────────────────────
   *
   * The shipped route knows `accept`, `progress`, `complete` and `fail`, and
   * answers anything else with `400 Unknown action`. So this tries the
   * dedicated `abandon` action first - which is the one the server SHOULD grow,
   * because "the player gave it back" and "the clock ran out" are different
   * facts and a ledger that conflates them cannot tell you which quests people
   * refuse - and falls back to `fail` with an explicit reason, which every
   * deployed server already handles. Delete the fallback once the action lands;
   * nothing else here changes.
   *
   * @param {string} engagementId
   * @returns {Promise<boolean>} true when the engagement was in progress and is
   *   now given back
   */
  async abandon(engagementId) {
    const entry = this.engagements.get(engagementId);
    if (!entry || entry.engagement.status !== 'in_progress') return false;

    entry.engagement.status = 'failed';
    entry.engagement.failure_reason = 'Abandoned';
    entry.timeLeftMs = null;
    /* Any queued step progress belongs to a quest that is no longer running.
     * Left in the queue it would be POSTed after the abandon and re-stamp
     * `percent_complete` on a row the player has given back. */
    this._syncQueue.delete(engagementId);

    try {
      let res = await fetch('/api/game/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'abandon', engagementId, reason: 'Abandoned' }),
      });
      if (!res.ok) {
        res = await fetch('/api/game/quests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ action: 'fail', engagementId, reason: 'Abandoned' }),
        });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      /* The local state still stands down. A server that never heard about it
       * restores the engagement on the next load, which is annoying and
       * recoverable; refusing to release the board because the network is down
       * is neither. Same reasoning as `_questsOffline`. */
      console.error('[QuestSystem] abandon sync:', err);
    }

    this._emitChanged({});
    this.bus?.emit('hud:notify', {
      text: `Quest abandoned — ${entry.quest?.title ?? ''}`,
      tone: 'info',
    });
    return true;
  }

  /* `markStepDone(engagementId, stepOrder)` was here, documented as "called
   * from QuestBoard". It was called from nowhere - one reference in the whole
   * tree, its own definition - and it had been that way long enough that no
   * board ever grew the button.
   *
   * What it did was set `have = stepDef.count; done = true` with NO validation
   * of the step type, then call `_checkQuestComplete`, which posts the
   * completion the server pays out on. Any step of any kind, including a `kill`
   * step, could be marked satisfied by calling it - and `window.GAME` exposes
   * `questSystem` under `?dev=1`, which `main.js:908` is explicit is "not a
   * security boundary, because anyone who wants the handle can simply add the
   * parameter".
   *
   * So it was an unused method whose only remaining function was to be a free
   * quest completion. Deleted rather than guarded: a manual-completion path
   * that nothing calls has no behaviour to preserve, and if a board ever needs
   * one it should be written against the step types that genuinely cannot
   * auto-track, rather than against all eleven.
   *
   * Note this does not close quest forgery in general - `completeQuestEngagement`
   * never reads `step_states`, so the completion POST is itself the assertion.
   * That is recorded in the mission architecture, section 11. */

  destroy() {
    for (const off of this._offs) off?.();
    this._offs.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Private — world load                                                */
  /* ------------------------------------------------------------------ */

  /**
   * A BACKEND THAT IS DOWN IS NOT AN ERROR THE PLAYER CAN ACT ON.
   *
   * This threw a red `bad` toast in the player's face on every world change
   * when `/api/game/quests` was unreachable - which is every session run
   * against the vite dev server alone, and every session where the Next site
   * is simply not up. A tester playing the whole loop cold reported it as a
   * defect, and they were right to: red is the game's colour for "you have a
   * problem", and the player has no problem and nothing to do about it.
   *
   * The quest board already degrades correctly on its own - it draws "No
   * quests in this category" - so the toast added nothing except alarm. The
   * failure is still recorded, once per session, in the console where the
   * person who can act on it will look. This is the same rule the marketplace
   * now follows and the same one Lore has always followed.
   *
   * ONE exception is kept loud: a response that is 200 but is not JSON. That
   * is a proxy or a login wall answering for the API, and it is a
   * configuration fault rather than an absent service - it needs saying.
   */
  async _loadQuestsForWorld(worldId) {
    try {
      const res = await fetch(`/api/game/quests?world=${worldId}`, {
        cache: 'no-store',
        credentials: 'include',
      });
      if (!res.ok) {
        this._questsOffline(`http ${res.status}`, worldId);
        return;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        throw new Error(`Unexpected response type: ${contentType || 'unknown'}`);
      }
      const data = await res.json();

      if (data.player_id && !this._playerId) this._playerId = data.player_id;
      const served = Array.isArray(data.quests) ? data.quests : [];
      this.worldQuests = served;

      /* SIGNED OUT AND SERVED NOTHING IS THE FIRST-RUN CASE, NOT AN EMPTY WORLD.
       *
       * The route answers a signed-out GET with the platform catalogue and
       * `player_id: null`. When that catalogue comes back empty the database
       * has not been seeded (or is not there), and the board would draw "No
       * quests in this category" for a world that has ten of them - which is
       * precisely what a first-run player sees, because `Onboarding` records
       * that first run happens signed out.
       *
       * The bundle is used ONLY in that pair of conditions. In particular it is
       * NOT used when a SIGNED-IN player is served an empty list: that is the
       * operator having switched `is_active` off, and resurrecting rows they
       * deliberately pulled would be this file overruling the admin console.
       * A world with genuinely no seeded quests (the maze, space, the ten
       * planets) yields an empty bundle too, so the two answers agree. */
      let bundled = false;
      if (!served.length && !this._playerId) {
        const fallback = offlineQuests(worldId);
        if (fallback.length) {
          this.worldQuests = fallback;
          bundled = true;
        }
      }

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

      this._emitChanged({ worldId, quests: this.worldQuests, offline: bundled });
    } catch (err) {
      this._questsOffline(err, worldId);
    }
  }

  /**
   * Record that the quest service is unreachable, and fall back to the bundle.
   *
   * The warning used to say "the board will show what is bundled and nothing
   * else" while nothing was bundled - a sentence that was true and useless. It
   * is now literally what happens: `QuestsOffline` carries the seeded content
   * for all six worlds, pinned to `admin/lib/quests/` by a test, and the board
   * draws it with its offline banner up.
   *
   * The engagements Map is left alone. Progress on an already-accepted quest is
   * local state that outlives an outage, and `_flushSync` retries the writes
   * when the service comes back.
   *
   * @param {unknown} why
   * @param {string|null} [worldId] the world whose bundle to fall back to
   */
  _questsOffline(why, worldId = this._worldId) {
    if (!this._questsOfflineLogged) {
      this._questsOfflineLogged = true;
      console.warn('[QuestSystem] quest service unreachable; the board will show what is '
        + 'bundled and nothing else:', why);
    }
    /* Assigned unconditionally, which also fixes the staleness the comment
     * below has always claimed to fix and never did: nothing cleared
     * `worldQuests` on a world change, so a failed load in the SECOND world of
     * a session left the FIRST world's quests on the board looking live. The
     * bundle is per-world, so this replaces them with this world's - and with
     * an empty list for a world that has no seeded quests (the maze, space,
     * the ten planets), which is the correct empty rather than a stale full. */
    this.worldQuests = offlineQuests(worldId);
    /* And the board is told, so it can say "offline" rather than "empty" -
     * the same distinction the marketplace draws. `quests:changed` is what it
     * listens to; sending it with an empty list is what stops a stale list
     * from a previous world sitting there looking live. */
    this._emitChanged({
      worldId: this.worldManager?.active?.id ?? null,
      quests: this.worldQuests,
      offline: true,
    });
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
    /* SOMEBODY ELSE'S KILL IS NOT YOUR QUEST STEP.
     *
     * `Combat.applyNPCDamage` puts `byPlayer` on every `npc:killed`, and
     * `resolveMaul` routes a beast's jaws through it with `byPlayer: false`
     * explicitly, for a reason its own comment states: "so a wolf eating a
     * villager cannot pay the player for it". `Economy._onNPCKilled` honours
     * that flag and pays nothing. This file did not read it at all, so quest 17's
     * four named bandits and quest 20's Rook Gant and Sable Ida all cleared
     * while the player stood back and let a predator do the work.
     *
     * `=== false` and not `!== true`: a hand-rolled or legacy emit that carries
     * no flag is UNKNOWN, not "not the player", and refusing those would break
     * every emitter that predates the field. Only an explicit denial is obeyed,
     * which is the same reading `Onboarding` uses on the same event. */
    if (e?.byPlayer === false) return;
    /* A herbivore is not a kill anybody asked for. `BeastNPC` files every
     * animal as a hostile - see the note on `type` there - and
     * `_matchesStepTarget` returns true for a step with no `target` at all, so
     * an untargeted "kill N" step advanced on the Sunspire camels: 220 HP,
     * no attack of any kind, and a 22 s respawn. Keyed on the species row
     * rather than on the species, so a predator added later still counts. */
    if (npc.isBeast && npc.def?.predator === false) return;
    this._advanceSteps('kill', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
    /* `defend` is NOT advanced here, and that is the fix rather than an
     * omission. Every authored defend step means "land N hits" and says so in
     * its own label - "every hit counts, she does not have to fall". A killing
     * blow emits `npc:damaged` and then `npc:killed`, so advancing on both made
     * the final hit count twice: "land 6 hits" fell to three kills, and the
     * label was lying to the player about its own rule. `_onNpcDamaged` is the
     * single path now, and it sees the killing blow like any other. */
  }
  
  /**
   * `defend` — one count per HIT the player lands. See `_onKill` for why the
   * kill path does not also advance it.
   *
   * ── The flag this reads does not exist yet at the emit site ───────────────
   *
   * `npc:killed` carries `byPlayer`; `npc:damaged` does NOT. There is exactly
   * one emitter - `Combat.applyNPCDamage`, `src/systems/Combat.js:455` - and it
   * has the value in a local variable two lines above the emit:
   *
   *     const byPlayer = opts.byPlayer !== false;      // :396
   *     this.bus.emit('npc:damaged', { npc, amount, health, isHeadshot, weaponId });
   *
   * The one-word repair is to add `byPlayer` to that payload. Until it lands,
   * `defend: Wry Tam x8` (quest 20) is cleared by eight hits from ANYBODY -
   * including the wolf that `resolveMaul` routes through the same choke point
   * with `byPlayer: false` precisely so it cannot pay the player.
   *
   * The guard is written now and defensively: an explicit `false` is refused, a
   * MISSING flag is treated as unknown and allowed through. That means this
   * line is a no-op today and becomes the fix the moment Combat.js:455 carries
   * the field, with no second edit here - and it can never be the thing that
   * silently stops every `defend` step in the game from advancing, which is
   * what `!== true` would have done against today's emitter.
   */
  _onNpcDamaged(e) {
    const npc = e?.npc;
    if (!npc || npc.type !== 'hostile') return;
    if (e?.byPlayer === false) return;
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
  
  /**
   * The generic activity channel — `talk`, `interact`, `minigame`, `mine`, and
   * whatever a future emitter invents. `e.type` is forwarded verbatim.
   *
   * ── One NPC is one person ────────────────────────────────────────────────
   *
   * A role-targeted `talk` step with `count > 1` was satisfiable by standing in
   * front of ONE NPC and pressing E repeatedly. `_advanceSteps` only
   * de-duplicates when `meta.onceKey` is set, and until now the only caller
   * that set one was `_creditVisit` - so eight authored steps across seven
   * quests (3, 5, 11, 31, 52, 102, 105) meant "press E three times at Rafiq"
   * when the content's own note beside them says the opposite: "count: 3 over
   * vendor is three different people and a short walk".
   *
   * The key is `talk:<npc>` with a constant token, which is the "once ever, per
   * engagement" spelling of the existing mechanism (`_creditVisit` uses a
   * moving token because a genuine re-entry SHOULD count again; a second
   * conversation with the same person should not). The stamp is per engagement
   * rather than per step, which is the stricter of the two readings and the one
   * the labels describe.
   *
   * `id` first, `name` as the fallback: `HUD` flattens `{id, name, role}` onto
   * the event, and every spawned NPC has an id, but a hand-rolled emit might
   * only carry a name. An activity with neither is left un-keyed rather than
   * collapsing every anonymous talker into one - `talk:undefined` would make
   * the first conversation the only one that ever counted.
   */
  _onActivity(e) {
    const type = e?.type;
    if (!type) return;
    const meta = { event: e };
    if (type === 'talk') {
      const who = e?.id ?? e?.name ?? e?.npc?.id ?? e?.npc?.name ?? null;
      if (who != null && String(who).trim()) {
        meta.onceKey = `talk:${String(who).trim()}`;
        meta.onceToken = 1;
      }
    }
    this._advanceSteps(type, (step, m) => this._matchesStepTarget(step, m), meta);
  }

  /**
   * Wheels down on a body.
   *
   * The second of the two verbs the mission survey named as significant
   * omissions - piloting and mining are the whole second half of the game, and
   * neither had any mission representation at all. There are still zero quests
   * authored for space or any of the ten planets; this is the machinery that
   * makes writing one possible.
   *
   * Only a real touchdown reaches this. `_forceSetDown` - the anti-stranding
   * recovery that puts a buried or over-speed hull back on the nearest pad -
   * emits `pilot:impact` and NOT `pilot:landed`, so a crash cannot complete a
   * step that asked the player to land.
   */
  _onLanded(e) {
    this._advanceSteps('pilot', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
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
        this._emitChanged({});
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
   *
   * Kept as a method so existing callers and tests reach it where they always
   * have; the implementation is the module-level {@link tokenRunMatch}, which
   * `Loot` shares.
   *
   * @param {string[]} a
   * @param {string[]} b
   */
  _tokenRunMatch(a, b) {
    return tokenRunMatch(a, b);
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
      case 'mine':
        /* Seam identity, as of `Mining._cut`'s own `quest:activity`
         * (`Mining.js`). The element TYPE is the useful spelling - "cut five
         * Rheniite" - and the node id and display name ride along so a step can
         * name one particular deposit or use the words the HUD showed.
         *
         * The world is offered too, so `{type:'mine', target:'cinder'}` means
         * "cut anything on Cinder". That is safe here in a way it would not be
         * for `collect`: this channel only ever fires from a seam. */
        push(event?.target);
        push(event?.id);
        push(event?.name);
        push(event?.worldId);
        break;
      case 'pilot':
        /* Landfall identity, as of `Piloting._touchDown`'s `pilot:landed`.
         * `world` is the planet's world id (`cinder`, `tessera`), `site` is the
         * pad under the keel and is NULL on open ground - which is correct and
         * not a gap: a step naming a pad should not complete for a landing
         * three kilometres away from it. `shipId` is offered so a step can ask
         * for a particular hull to be the one that made the trip. */
        push(event?.world);
        push(event?.site?.id);
        push(event?.site?.name);
        push(event?.shipId);
        break;
      case 'purchase':
        /* A SALE IS NOT A PURCHASE.
         *
         * `market:trade` is emitted by both sides of the counter and says which
         * it was in `kind` ('buy' | 'sell'). This branch pushed `event.itemId`
         * unconditionally, so selling the very item a step asked you to BUY
         * completed the step - and the two station tutorials whose entire
         * subject is the buy side (n 106, "Learn the marketplace: buying AND
         * selling") were among the thirteen quests it affected. Worse than a
         * loophole: a player following the lesson in order sells first, and the
         * step ticks for the wrong half of it.
         *
         * `kind` itself stays a candidate on both paths, because it is the
         * handle the authored `purchase:sell` steps use - a step targeting
         * 'sell' is asking for a sale and must still be satisfied by one. Only
         * the ITEM identities are withheld from a sale, which is exactly the
         * distinction: "you sold something" is true, "you bought this" is not. */
        push(event?.kind);
        if (event?.kind === 'sell') break;
        push(event?.itemId);
        push(event?.packId);
        push(event?.id);
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

  /** @see normalizeTarget — the module-level function `Loot` shares. */
  _normalizeTarget(value) {
    return normalizeTarget(value);
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
    this._emitChanged({});
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

    this._emitChanged({});
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

  /**
   * Announce a change, and republish what the pickup layer needs with it.
   *
   * Every `quests:changed` in this file goes through here so the two can never
   * disagree - a board that redrew and a `Loot` that still believed in a step
   * the player finished thirty seconds ago is exactly the class of bug this
   * file keeps finding in itself.
   *
   * @param {object} extra fields to merge onto the `quests:changed` payload
   */
  _emitChanged(extra = {}) {
    this.bus?.emit('quests:changed', { ...extra, engagements: this.engagements });
    this._publishCollectPending();
  }

  /**
   * The `collect` steps that are live RIGHT NOW, for whoever hands out pickups.
   *
   * `Loot.collectEntry` takes nothing when the bag and the store are both full,
   * and when it takes nothing it emits no `loot:collected` - so a `collect`
   * step simply stops moving, while a throttled "Inventory full" notice appears
   * that says nothing about the quest it is blocking. The player sees a counter
   * frozen at 0/3 and a warning that reads like housekeeping.
   *
   * `Loot` has no handle on this class and main.js does not give it one, so the
   * shape travels over the bus - and it is deliberately a flat, primitive list
   * rather than the engagements Map: the alternative was `Loot` parsing
   * `quest.steps` JSON and re-implementing `_matchesStepTarget`, i.e. a second
   * description of the matcher living in a file that has no business owning
   * one. Targets are pre-normalised here so the consumer needs only a string
   * compare of token runs.
   *
   * Emitted even when empty, because "nothing is blocked" is the state that
   * clears a stale list.
   */
  _publishCollectPending() {
    if (!this.bus) return;
    const worldId = this._worldId;
    const out = [];
    const seen = new Set();
    for (const [, entry] of this.engagements) {
      if (entry?.engagement?.status !== 'in_progress') continue;
      for (const step of this._parseSteps(entry.quest?.steps)) {
        if (step?.type !== 'collect') continue;
        // The STEP's world, exactly as `_advanceSteps` reads it.
        if (step.world && step.world !== worldId) continue;
        const state = entry.stepStates?.[step.order];
        if (state?.done) continue;
        const target = normalizeTarget(step.target);
        const key = `${target}|${step.label ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          target,
          label: String(step.label ?? ''),
          have: Math.max(0, Number(state?.have) || 0),
          count: Math.max(1, Number(step.count) || 1),
          questTitle: String(entry.quest?.title ?? ''),
        });
      }
    }
    this.bus.emit('quests:collect:pending', { worldId, steps: out });
  }

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
