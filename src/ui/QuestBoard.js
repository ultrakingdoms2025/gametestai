/**
 * QuestBoard — full-screen overlay UI for the quest system.
 *
 * Opens on J from anywhere, or on E next to a Quest Manager NPC. Until J
 * existed the board was reachable only by walking to one of the five Quest
 * Managers, which made every quest in the game invisible from everywhere else.
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

    /* Window-level key listener so the board works regardless of focus or
     * pointer-lock state (same pattern as HelpMenu, AudioMenu, KeybindMenu).
     *
     * ── Why J is a FIXED key, not a rebindable one ─────────────────────────
     *
     * `Input.BINDABLE` is for actions gameplay reads through `Input.pressed`,
     * and `Input` stops reporting entirely while a panel has the keyboard —
     * which is exactly when a player needs to be able to close that panel. So
     * every panel key (I, B, K, F1–F9, Esc) owns its own listener instead, and
     * `KeybindMenu.FIXED_KEYS` documents them without offering to move them.
     * The quest board is a panel, so J joins that list rather than BINDABLE.
     *
     * `textCaptured` is checked because this listener runs OUTSIDE `Input`:
     * `Input._bind` swallows gameplay keys while the chat field has focus, but
     * it cannot swallow ours, and without the check typing "jump" into a
     * conversation would throw the quest board over it.
     */
    this._onWindowKey = (e) => {
      if (e.code === 'Escape') {
        if (this._open && this._openGuard === 0) {
          e.preventDefault();
          e.stopPropagation();
          this.close();
        }
        return;
      }
      if (e.code !== 'KeyJ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (this.input?.textCaptured) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      e.stopPropagation();
      if (this._open) {
        if (this._openGuard === 0) this.close();
        return;
      }
      /* Through QuestSystem rather than straight to `open()`: `openBoard()` is
       * the system's own front door and publishes the quest/engagement payload
       * with the request. It had no caller at all before this key existed. */
      if (this.questSystem?.openBoard) this.questSystem.openBoard();
      else this.open();
    };
    window.addEventListener('keydown', this._onWindowKey, true);

    /** @type {Array<()=>void>} */
    this._offs = [];
    if (this.bus) {
      this._offs.push(this.bus.on('quests:board:open',  () => this.open()));
      this._offs.push(this.bus.on('quests:board:close', () => this.close()));
      /* TAKE THE PAYLOAD. `QuestSystem` sends `offline: true` when the quest
       * service is unreachable, and its comment says why: "so it can say
       * offline rather than empty - the same distinction the marketplace
       * draws". This handler used to be a no-argument arrow, so the flag was
       * dropped on the floor and the word "offline" appeared nowhere in this
       * file.
       *
       * That is not cosmetic. While /api/game/quests was returning 500 to
       * every caller in production, the marketplace showed "Trade network
       * unreachable" and this board showed "No quests in this category" - so
       * a total outage of 78 quests read to a player as a world that simply
       * had nothing to do in it. The sender was right and the receiver threw
       * the distinction away. */
      this._offs.push(this.bus.on('quests:changed', (p) => {
        this._offline = p?.offline === true;
        this._refresh();
      }));
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
          <button class="qb-close" title="Close [J / E / ESC]">\u2715</button>
        </div>
        <div class="qb-body">
          <div class="qb-list"></div>
          <div class="qb-detail"></div>
        </div>
        <div class="qb-footer">Press <kbd>J</kbd>, <kbd>E</kbd> or <kbd>ESC</kbd> to close</div>
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
    /* The offline notice now has to survive a NON-EMPTY list.
     *
     * It used to live in the empty-state branch, which was the only state that
     * existed: with the service down the board had nothing to draw. Now
     * `QuestsOffline` fills it, so the outage is invisible unless the banner
     * sits above the rows - and "these are bundled, and accepting one needs the
     * service" is the fact that stops a player thinking the ACCEPT button is
     * broken. Still the marketplace's distinction, just no longer conflated
     * with emptiness. */
    if (this._offline) {
      list.innerHTML = '<div class="qb-empty qb-offline">Quest service unreachable &mdash; '
        + 'showing the quests bundled with this world. Sign in with the service up to accept '
        + 'one; progress you have already made is safe.</div>';
    }
    if (!items.length) {
      /* An unreachable service and an empty category are different facts, and
       * only one of them is the player's problem to solve. */
      if (!this._offline) {
        list.innerHTML = '<div class="qb-empty">No quests in this category.</div>';
      }
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

    /* WHICH WORLD A STEP IS FOR.
     *
     * `QuestSystem._advanceSteps` skips any step whose `step.world` is not the
     * world the player is standing in - that gate is what makes the cross-world
     * quests work at all - and this panel showed no sign of it. 34 steps across
     * 17 quests are cross-world, so on quest 203 a player stands on the station
     * picking up relic coins and watches `collect:relic_coin 0/3` refuse to
     * move, while the row beside it says "Auto" in the same colour as the steps
     * that ARE ticking. The step was not broken and the panel was not lying,
     * exactly - it was withholding the one fact that explains the behaviour.
     *
     * The active world is read off the quest system rather than passed in, so
     * the row re-renders correctly on the `quests:changed` that every world
     * change already produces. */
    const activeWorld = this.questSystem?._worldId
      ?? this.questSystem?.worldManager?.active?.id
      ?? null;

    // Build steps HTML
    let stepsHtml = '';
    for (const step of steps) {
      const state   = stepStates[step.order] ?? { done: false, have: 0 };
      /* A step for somewhere else is neither done nor live. Greyed rather than
       * hidden: "go to Aldermoor and do this" is itself the instruction. */
      const elsewhere = !!step.world && !!activeWorld && step.world !== activeWorld;
      const doneCls = state.done
        ? 'done'
        : (elsewhere ? 'qb-step-away' : (isActive ? 'active-step' : ''));
      const countHtml = step.count > 1
        ? `<span class="qb-step-count">${state.have ?? 0}/${step.count}</span>`
        : '';
      const statusText = state.done ? 'Done' : (elsewhere ? 'Elsewhere' : 'Auto');
      /* `[collect \u00B7 medieval]` rather than a second badge: the type tag is
       * already the row's "what the engine is watching" cell, and the world is
       * the other half of that same fact. A step with no `world` fires
       * anywhere and says nothing extra. */
      const typeText = step.world ? `${step.type} \u00B7 ${step.world}` : String(step.type ?? '');
      /* Inline, because `quest-board.css` is not this change's to edit and a
       * class with no rule behind it would grey nothing. One declaration, on
       * the rows that need it. */
      const dim = elsewhere && !state.done ? ' style="opacity:.45"' : '';
      stepsHtml += `
        <div class="qb-step ${doneCls}"${dim}>
          <span class="qb-step-icon">${state.done ? '\u2713' : '\u25CB'}</span>
          <span class="qb-step-label">${esc(step.label)}</span>
          ${countHtml}
          <span class="qb-step-type">[${esc(typeText)}]</span>
          <span class="qb-step-status">${esc(statusText)}</span>
        </div>`;
    }

    const acceptBtn = !entry || entry.engagement?.status === 'failed'
      ? `<button class="qb-accept-btn" data-quest="${esc(quest.id)}">ACCEPT QUEST</button>`
      : '';

    /* THE WAY OUT.
     *
     * There was none. The only exits from `in_progress` were finishing the
     * quest and the wall-clock timer expiring, and that timer keeps running
     * while the game is closed - so "accept a 45-minute quest, log off, come
     * back tomorrow" was an automatic failure, and "I took the wrong quest"
     * had no answer at all short of waiting the window out. Offered only on a
     * quest that is actually in progress, and confirmed in place rather than
     * through a dialog: giving a quest back is reversible (a failed engagement
     * is re-acceptable from the Available tab), so a second full-screen sheet
     * would be ceremony for a decision that costs nothing but progress. */
    const abandonBtn = isActive
      ? '<button class="qb-accept-btn qb-abandon-btn" style="border-color:rgba(255,110,110,.45);'
        + 'color:#ff9a9a">ABANDON QUEST</button>'
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
        ${abandonBtn}
      </div>`;

    // Abandon handler. Queried first, and by its OWN class: it shares
    // `qb-accept-btn` for the styling, so `querySelector('.qb-accept-btn')`
    // below would otherwise find it - the two are never rendered together
    // today, and relying on that is how the wrong button gets wired tomorrow.
    const abandonEl = container.querySelector('.qb-abandon-btn');
    if (abandonEl) {
      abandonEl.addEventListener('click', async () => {
        abandonEl.disabled = true;
        abandonEl.textContent = 'Abandoning...';
        await this.questSystem?.abandon?.(entry?._engId ?? this._selectedEngId);
        /* Back to Available, where the quest now is: `abandon` files the
         * engagement as failed and `_refresh`'s available filter admits a
         * failed engagement, so the player can see straight away that giving it
         * back did not delete it. */
        this._activeTab     = 'available';
        this._selectedEngId = null;
        this._el.querySelectorAll('.qb-tab').forEach((b) => {
          b.classList.toggle('active', b.dataset.tab === 'available');
        });
        this._refresh();
      });
    }

    // Accept handler
    const acceptEl = container.querySelector('.qb-accept-btn:not(.qb-abandon-btn)');
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
