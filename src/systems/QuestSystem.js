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
      this._offs.push(this.bus.on('world:changed', ({ id, world }) => {
        this._worldId = id ?? world?.id ?? null;
        this._pending = true;
        this._advanceSteps('visit', (step, meta) => this._matchesStepTarget(step, meta), {
          event: { type: 'visit', target: this._worldId, worldId: this._worldId },
        });
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
      this._advanceSteps('visit', (step, meta) => this._matchesStepTarget(step, meta), {
        event: { type: 'visit', target: this._worldId, worldId: this._worldId },
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

      this._advanceSteps('visit', (step, meta) => this._matchesStepTarget(step, meta), {
        event: { type: 'visit', target: this._worldId, worldId: this._worldId },
      });

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

  /* ------------------------------------------------------------------ */
  /* Private — event handlers                                            */
  /* ------------------------------------------------------------------ */

  _onKill(e) {
    const npc = e?.npc;
    if (!npc || npc.type !== 'hostile') return;
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
    // Single-completion race steps (count === 1)
    this._advanceSteps('race', (step, meta) => step.count === 1 && this._matchesStepTarget(step, meta), { event: e });
  }
  
  _onRaceLap(e) {
    // Multi-lap steps
    this._advanceSteps('race', (step, meta) => step.count > 1 && this._matchesStepTarget(step, meta), { event: e });
  }
  
  _onPlayerDamaged(e) {
    this._advanceSteps('survive', (step, meta) => this._matchesStepTarget(step, meta), { event: e });
  }
  
  _onPortalEntering(e) {
    this._advanceSteps('visit', (step, meta) => this._matchesStepTarget(step, meta), {
      event: { type: 'visit', target: e?.to ?? e?.target ?? null, worldId: e?.to ?? e?.target ?? null },
    });
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
   * Generic step advancer for auto-tracked types.
   * @param {string} type
   * @param {(step:object, meta:any)=>boolean} filter
   * @param {any} meta
   */
  _advanceSteps(type, filter, meta = {}) {
    const worldId = this._worldId;
    for (const [engId, entry] of this.engagements) {
      if (entry.engagement.status !== 'in_progress') continue;
      const steps = this._parseSteps(entry.quest?.steps);
      let changed = false;
      for (const step of steps) {
        if (step.type !== type) continue;
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

  _matchesStepTarget(step, meta = {}) {
    const target = String(step?.target ?? '').trim();
    if (!target) return true;

    const candidates = this._eventTargetCandidates(step?.type, meta?.event);
    const expected = this._normalizeTarget(target);
    if (!expected) return true;

    return candidates.some((candidate) => {
      const normalized = this._normalizeTarget(candidate);
      return normalized === expected || normalized.includes(expected) || expected.includes(normalized);
    });
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
        push(event?.id);
        push(event?.name);
        push(event?.trackId);
        push(event?.trackName);
        push(event?.raceId);
        const place = Number(event?.place ?? event?.result?.place ?? 0);
        if (Number.isFinite(place) && place > 0) {
          push(place);
          const placeLabels = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
          push(placeLabels[place - 1] ?? null);
          push(place === 1 ? 'first' : place === 2 ? 'second' : place === 3 ? 'third' : null);
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
        credentials: 'include',
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
      if (!entry || entry.engagement.status !== 'in_progress') continue;
      const steps = this._parseSteps(entry.quest?.steps);
      const done = steps.filter((s) => entry.stepStates[s.order]?.done).length;
      const pct = Math.round((done / Math.max(steps.length, 1)) * 100);
      try {
        await fetch('/api/game/quests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
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
