/**
 * QuestBoard — full-screen overlay UI for the quest system.
 *
 * Opens when the player presses E near a Quest Manager NPC.
 * Shows three tabs: Available / In Progress / Completed.
 * Quest steps now advance automatically from player activity and target IDs.
 */

import './quest-board.css';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class QuestBoard {
  /**
   * @param {{ root: HTMLElement, bus: any, input: any,
   *           questSystem: import('../systems/QuestSystem.js').QuestSystem }} ctx
   */
  constructor({ root, bus, input, questSystem }) {
    this.root        = root;
    this.bus         = bus;
    this.input       = input;
    this.questSystem = questSystem;

    this._open            = false;
    this._activeTab       = 'available';
    this._selectedQuestId = null;
    this._selectedEngId   = null;
    /** Frames to skip close-key checks after opening (prevents same-frame close). */
    this._openGuard       = 0;
    /** Set by close(); prevents HUD re-emitting quests:board:open in the same frame. */
    this._justClosed      = false;

    this._el = this._build();
    root.appendChild(this._el);

    // Window-level Escape listener so closing works regardless of focus or
    // pointer-lock state (same pattern as HelpMenu, AudioMenu, etc.).
    this._onWindowKey = (e) => {
      if (this._open && this._openGuard === 0 && e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    window.addEventListener('keydown', this._onWindowKey, true);

    /** @type {Array<()=>void>} */
    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('quests:board:open',  () => this.open()));
      this._offs.push(this.bus.on('quests:board:close', () => this.close()));
      this._offs.push(this.bus.on('quests:changed',     () => this._refresh()));
    }
  }

  get isOpen() { return this._open; }

  open() {
    // Prevent a same-frame close→reopen cycle: if close() was called earlier
    // this frame (e.g. questBoard.update() closed it, then HUD re-emits open),
    // skip the reopen. _justClosed is cleared at the top of the next update().
    if (this._justClosed) return;
    if (this._open) return;
    // Opening from gameplay should immediately free the cursor for UI clicks.
    this.input?.exitLock?.();
    this._open = true;
    this._openGuard = 2; // skip close-key checks for 2 frames so the E press that opened us doesn't immediately close us
    this._refresh();
    this._el.classList.add('open');
    document.body.classList.add('quest-board-open');
    this.bus?.emit('hud:block', { id: 'quest-board', block: true });
  }

  close() {
    if (!this._open) return;
    this._open = false;
    this._justClosed = true;
    this._el.classList.remove('open');
    document.body.classList.remove('quest-board-open');
    this.bus?.emit('hud:block', { id: 'quest-board', block: false });
    this.bus?.emit('quests:board:close');
  }

  /** Called every frame. */
  update(_dt) {
    // Clear same-frame reopen guard at the start of each new frame.
    this._justClosed = false;
    if (!this._open) return;
    if (this._openGuard > 0) {
      this._openGuard--;
      return;
    }
    // E toggles the board (gameplay key, checked via Input polling).
    // Escape is handled by the window keydown listener above.
    if (this.input?.pressed('KeyE')) {
      this.close();
    }
  }

  destroy() {
    window.removeEventListener('keydown', this._onWindowKey, true);
    for (const off of this._offs) off?.();
    this._offs.length = 0;
    this._el.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Build                                                               */
  /* ------------------------------------------------------------------ */

  _build() {
    const el = document.createElement('div');
    el.className = 'qb-root';
    el.innerHTML = `
      <div class="qb-panel">
        <div class="qb-header">
          <span class="qb-title">QUEST BOARD</span>
          <div class="qb-tabs">
            <button class="qb-tab active" data-tab="available">AVAILABLE</button>
            <button class="qb-tab"         data-tab="active">IN PROGRESS</button>
            <button class="qb-tab"         data-tab="completed">COMPLETED</button>
          </div>
          <button class="qb-close" title="Close [E / ESC]">\u2715</button>
        </div>
        <div class="qb-body">
          <div class="qb-list"></div>
          <div class="qb-detail"></div>
        </div>
        <div class="qb-footer">Press <kbd>E</kbd> or <kbd>ESC</kbd> to close</div>
      </div>`;

    el.querySelector('.qb-close').addEventListener('click', () => this.close());

    el.querySelectorAll('.qb-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.qb-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this._activeTab       = btn.dataset.tab;
        this._selectedQuestId = null;
        this._selectedEngId   = null;
        this._refresh();
      });
    });

    return el;
  }

  /* ------------------------------------------------------------------ */
  /* Refresh                                                             */
  /* ------------------------------------------------------------------ */

  _refresh() {
    if (!this._open) return;

    const qs          = this.questSystem;
    const worldQuests = qs?.worldQuests ?? [];
    const engagements = qs?.engagements ?? new Map();

    // Build a quick lookup: questId → engagement entry
    const engByQuestId = new Map();
    for (const [id, entry] of engagements) {
      const qid = entry.quest?.id ?? entry.engagement?.quest_id;
      if (qid && !engByQuestId.has(qid)) engByQuestId.set(qid, { _engId: id, ...entry });
    }

    // Build list items for the active tab
    let items = [];
    if (this._activeTab === 'available') {
      items = worldQuests.filter((q) => {
        const eng = engByQuestId.get(q.id);
        return !eng || eng.engagement?.status === 'failed';
      });
    } else if (this._activeTab === 'active') {
      for (const [engId, entry] of engagements) {
        if (entry.engagement?.status === 'in_progress') {
          items.push({ _engId: engId, _entry: entry, ...(entry.quest ?? {}) });
        }
      }
    } else {
      for (const [engId, entry] of engagements) {
        if (entry.engagement?.status === 'completed') {
          items.push({ _engId: engId, _entry: entry, ...(entry.quest ?? {}) });
        }
      }
    }

    const list   = this._el.querySelector('.qb-list');
    const detail = this._el.querySelector('.qb-detail');

    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="qb-empty">No quests in this category.</div>';
    }

    for (const item of items) {
      const engId    = item._engId;
      const quest    = item._entry?.quest ?? item;
      const pct      = item._entry?.engagement?.percent_complete ?? 0;
      const reward   = quest?.reward_credits ?? 0;
      const dur      = quest?.duration_minutes;
      const durText  = dur ? (dur < 60 ? `${dur}m` : `${Math.round(dur / 60)}h`) : '--';
      const selected = this._activeTab === 'available'
        ? this._selectedQuestId === quest?.id
        : this._selectedEngId   === engId;

      const div = document.createElement('div');
      div.className = 'qb-item' + (selected ? ' selected' : '');

      let inner = `
        <div class="qb-item-title">${esc(quest?.title ?? 'Quest')}</div>
        <div class="qb-item-meta">
          <span class="qb-reward">+${reward} CR</span>
          <span class="qb-dur">${durText}</span>
          ${this._activeTab === 'active' ? `<span class="qb-pct">${pct}%</span>` : ''}
        </div>`;

      if (this._activeTab === 'active') {
        inner += `<div class="qb-prog-bar"><div class="qb-prog-fill" style="width:${pct}%"></div></div>`;
      }

      div.innerHTML = inner;
      div.addEventListener('click', () => {
        if (this._activeTab === 'available') {
          this._selectedQuestId = quest?.id ?? null;
          this._selectedEngId   = null;
        } else {
          this._selectedEngId   = engId;
          this._selectedQuestId = quest?.id ?? null;
        }
        this._refresh();
      });
      list.appendChild(div);
    }

    // Render the detail panel
    if (this._activeTab === 'available' && this._selectedQuestId) {
      const q = worldQuests.find((x) => x.id === this._selectedQuestId);
      if (q) this._renderDetail(detail, q, null);
      else detail.innerHTML = '<div class="qb-empty">Select a quest to view details.</div>';
    } else if (this._activeTab !== 'available' && this._selectedEngId) {
      const entry = engagements.get(this._selectedEngId);
      if (entry?.quest) this._renderDetail(detail, entry.quest, entry);
      else detail.innerHTML = '<div class="qb-empty">Select a quest to view details.</div>';
    } else {
      detail.innerHTML = '<div class="qb-empty">Select a quest to view details.</div>';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Detail panel                                                        */
  /* ------------------------------------------------------------------ */

  _renderDetail(container, quest, entry) {
    const steps      = this._parseSteps(quest.steps);
    const stepStates = entry?.stepStates ?? {};
    const isActive   = entry?.engagement?.status === 'in_progress';
    const isDone     = entry?.engagement?.status === 'completed';
    const dur        = quest.duration_minutes;
    const durText    = dur ? (dur < 60 ? `${dur} min` : `${Math.round(dur / 60)} hr`) : 'No time limit';

    let timeLeft = '';
    if (isActive && entry?.timeLeftMs != null) {
      const ms = Math.max(0, entry.timeLeftMs);
      const h  = Math.floor(ms / 3600000);
      const m  = Math.floor((ms % 3600000) / 60000);
      timeLeft = h > 0 ? `${h}h ${m}m remaining` : `${m}m remaining`;
    }

    const preSteps = quest.pre_steps ? JSON.parse(quest.pre_steps) : [];

    // Build steps HTML
    let stepsHtml = '';
    for (const step of steps) {
      const state   = stepStates[step.order] ?? { done: false, have: 0 };
      const doneCls = state.done ? 'done' : (isActive ? 'active-step' : '');
      const countHtml = step.count > 1
        ? `<span class="qb-step-count">${state.have ?? 0}/${step.count}</span>`
        : '';
      const statusText = state.done ? 'Done' : 'Auto';
      stepsHtml += `
        <div class="qb-step ${doneCls}">
          <span class="qb-step-icon">${state.done ? '\u2713' : '\u25CB'}</span>
          <span class="qb-step-label">${esc(step.label)}</span>
          ${countHtml}
          <span class="qb-step-type">[${esc(step.type)}]</span>
          <span class="qb-step-status">${esc(statusText)}</span>
        </div>`;
    }

    const acceptBtn = !entry || entry.engagement?.status === 'failed'
      ? `<button class="qb-accept-btn" data-quest="${esc(quest.id)}">ACCEPT QUEST</button>`
      : '';

    container.innerHTML = `
      <div class="qb-detail-inner">
        <div class="qb-detail-title">${esc(quest.title)}</div>
        <div class="qb-detail-line">${esc(quest.quest_line ?? '')}</div>
        <div class="qb-detail-meta">
          <span>Reward: <b class="qb-reward">${quest.reward_credits} CR</b></span>
          <span>Time: <b>${esc(durText)}</b></span>
          ${timeLeft  ? `<span class="qb-time-left">${esc(timeLeft)}</span>` : ''}
          ${isDone    ? `<span class="qb-completed-badge">COMPLETED</span>` : ''}
        </div>
        ${preSteps.length ? `<div class="qb-prereqs">Requires: ${preSteps.map(esc).join(', ')}</div>` : ''}
        <div class="qb-steps-header">STEPS</div>
        <div class="qb-steps">${stepsHtml}</div>
        ${acceptBtn}
      </div>`;

    // Accept handler
    const acceptEl = container.querySelector('.qb-accept-btn');
    if (acceptEl) {
      acceptEl.addEventListener('click', async () => {
        acceptEl.disabled     = true;
        acceptEl.textContent  = 'Accepting...';
        await this.questSystem?.accept(quest.id);
        // Switch to In Progress tab
        this._activeTab       = 'active';
        this._el.querySelectorAll('.qb-tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.tab === 'active');
        });
        this._refresh();
      });
    }

  }

  _parseSteps(json) {
    if (!json) return [];
    try { return JSON.parse(json); } catch { return []; }
  }
}
