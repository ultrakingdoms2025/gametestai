/**
 * QuestSystem — backend-integrated quest tracking.
 *
 * Fetches active quests for the current world from /api/game/quests and tracks
 * player progress by subscribing to the existing event bus:
 *   - npc:killed   → kill-type steps
 *   - loot:collected → collect-type steps
 *   - race:finished → race-type steps (single completion)
 *   - race:lap      → race-type steps with count > 1 (cumulative)
 *
 * Non-auto-tracked step types (visit, interact, deliver, talk, escort, defend,
 * stealth, craft, survive, investigate) are shown in QuestBoard and can be
 * manually marked done by the player via the board UI.
 *
 * Progress is synced to the backend every 10 s and on step completion.
 * Credit awards are paid through `economy.add()` on quest completion.
 */

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

    /** @type {Array<()=>void>} */
    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('world:changed', ({ id }) => {
        this._worldId = id ?? null;
        this._pending = true;
      }));
      this._offs.push(this.bus.on('player:identity', ({ playerId }) => {
        if (playerId) this._playerId = playerId;
      }));
      this._offs.push(this.bus.on('npc:killed',      (e) => this._onKill(e)));
      this._offs.push(this.bus.on('loot:collected',  (e) => this._onCollect(e)));
      this._offs.push(this.bus.on('race:finished',   (e) => this._onRaceFinished(e)));
      this._offs.push(this.bus.on('race:lap',        (e) => this._onRaceLap(e)));
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
    // Periodic backend sync
    this._syncT -= dt;
    if (this._syncT <= 0) {
      this._syncT = 10;
      void this._flushSync();
    }
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
        body: JSON.stringify({
          action: 'accept',
          questId: quest.id,
          questNumber: quest.quest_number,
          questTitle: quest.title,
          world: quest.world,
          durationMinutes: quest.duration_minutes ?? null,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      const res = await fetch(`/api/game/quests?world=${worldId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();

      if (data.player_id && !this._playerId) this._playerId = data.player_id;
      this.worldQuests = data.quests ?? [];

      // Merge backend engagements into local state
      for (const eng of (data.engagements ?? [])) {
        if (this.engagements.has(eng.id)) continue; // local state takes priority

        const quest = this.worldQuests.find((q) => q.id === eng.quest_id) ?? null;
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

      this.bus?.emit('quests:changed', {
        worldId,
        quests: this.worldQuests,
        engagements: this.engagements,
      });
    } catch (err) {
      console.warn('[QuestSystem] load failed:', err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Private — event handlers                                            */
  /* ------------------------------------------------------------------ */

  _onKill(e) {
    const npc = e?.npc;
    if (!npc || npc.type !== 'hostile') return;
    this._advanceSteps('kill', () => true);
  }

  _onCollect(e) {
    this._advanceSteps('collect', () => true);
  }

  _onRaceFinished(e) {
    // Single-completion race steps (count === 1)
    this._advanceSteps('race', (step) => step.count === 1);
  }

  _onRaceLap(e) {
    // Multi-lap steps
    this._advanceSteps('race', (step) => step.count > 1);
  }

  /**
   * Generic step advancer for auto-tracked types.
   * @param {string} type
   * @param {(step:object)=>boolean} filter
   */
  _advanceSteps(type, filter) {
    const worldId = this._worldId;
    for (const [engId, entry] of this.engagements) {
      if (entry.engagement.status !== 'in_progress') continue;
      const steps = this._parseSteps(entry.quest?.steps);
      let changed = false;
      for (const step of steps) {
        if (step.type !== type) continue;
        if (step.world && step.world !== worldId) continue;
        if (!filter(step)) continue;
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

  async _completeQuest(engagementId) {
    const entry = this.engagements.get(engagementId);
    if (!entry) return;
    const credits = entry.quest?.reward_credits ?? 0;
    entry.engagement.status           = 'completed';
    entry.engagement.percent_complete = 100;

    try {
      await fetch('/api/game/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete', engagementId, creditsRewarded: credits }),
      });
    } catch (err) {
      console.error('[QuestSystem] complete sync:', err);
    }

    if (credits > 0) this.economy?.add?.(credits, 'quest');
    this.bus?.emit('quests:quest:complete', { quest: entry.quest, engagementId });
    this.bus?.emit('quests:changed', { engagements: this.engagements });
    this.bus?.emit('hud:notify', {
      text: `Quest complete — ${entry.quest?.title ?? ''} +${credits} CR`,
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
      if (!entry || entry.engagement.status !== 'in_progress') continue;
      const steps = this._parseSteps(entry.quest?.steps);
      const done = steps.filter((s) => entry.stepStates[s.order]?.done).length;
      const pct = Math.round((done / Math.max(steps.length, 1)) * 100);
      try {
        await fetch('/api/game/quests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'progress', engagementId: engId,
            stepStates: entry.stepStates, percentComplete: pct,
          }),
        });
      } catch {
        this._syncQueue.add(engId); // retry next cycle
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Private — helpers                                                   */
  /* ------------------------------------------------------------------ */

  _parseSteps(json) {
    if (!json) return [];
    try { return JSON.parse(json); } catch { return []; }
  }
}
