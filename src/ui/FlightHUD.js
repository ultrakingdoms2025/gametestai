import './flight.css';
import { pickPrompt, pickPromptSlot, promptSlot } from './PromptSlots.js';

/**
 * THE COCKPIT READOUT.
 *
 * Separate from `HUD.js` on purpose, and the reason is the one that decides
 * every "should this go in the big file" question in this repo: `HUD.js` is
 * 3,000 lines shared by every world and every system, and a flight readout that
 * lived in it would be five more branches in a frame handler that already has
 * forty. This is one overlay, shown by one mode, and it reads its whole state
 * from two calls - `piloting.report()` and `piloting.navReport()` - both of
 * which fill objects the caller owns.
 *
 * ── What it must say, and why each row is here ─────────────────────────────
 *
 *   SPEED        the number, plus a bar split at this hull's own cruise top.
 *                Two hulls with different `powerMul` have different ceilings
 *                and a bar that pretended otherwise would tell a Dray pilot
 *                they were flat out at 60%.
 *   BOOST FUEL   because boost is a budget (3.35 s from full) and a pilot
 *                emptying it into open space with a planet still 40 km away has
 *                made a decision they could not see.
 *   TRANSIT      the multiplier, when it is engaged. It changes how far a
 *                second of flight goes by a factor of eight; an unannounced 8x
 *                is a bug report.
 *   NAV          every body, nearest first, WITH THE YARD PINNED TO THE TOP.
 *                This is the anti-stranding row. `Piloting.navReport` puts it
 *                first unconditionally and this draws it in the yard's amber so
 *                it is findable without reading.
 *   ALTITUDE     surface distance to the nearest body, and the approach phase.
 *                `Bodies.approachState` already computes both every frame for
 *                the seam logic; drawing them costs nothing and turns a descent
 *                from a guess into an instrument approach.
 *   HOLD         ore aboard against capacity, and it turns amber when full,
 *                because a full hold silently refusing pickups is the mining
 *                loop's version of a door that does not open.
 *
 * ── The gunnery half ───────────────────────────────────────────────────────
 *
 * Added with the combat drop, and it reads from a second source -
 * `combat.report()` - by exactly the same rule: the system fills an object
 * this file owns, and this file draws it. Nothing here computes anything.
 *
 *   RETICLE      where the nose is pointing, at the gun's own range. Drawn
 *                from the NDC `SpaceCombat` publishes rather than pinned to
 *                the middle of the plate, because the chase camera looks at a
 *                point thirty metres AHEAD of the hull - so screen centre and
 *                the gun line are several degrees apart, and a fixed
 *                crosshair would be a lie you could not shoot straight with.
 *   LEAD PIP     the firing solution for the current contact. The single most
 *                useful thing on the screen in a fight, and the one that
 *                teaches the player what the enemy is already doing to them.
 *   SHIELD, GUN  the two pools, each under its own label. The labels are not
 *                tidiness: a shield at zero draws an empty bar, so the first
 *                build showed the words SHIELDS DOWN sitting directly above a
 *                full green bar - which was the GUN's - and read as the panel
 *                contradicting itself. Both are decisions: shields decide
 *                whether to stay in, the capacitor decides whether to keep the
 *                trigger down. Neither is visible outside the seat.
 *   CONTACT      name, range and integrity of what is being shot at.
 *   FLASH        a vignette when hit, cyan / white / red for shield holding,
 *                shield breaking and hull.
 *
 * The gunnery block is skipped entirely when no combat system was handed in,
 * so a build without one draws exactly the HUD it drew before.
 *
 * ── Update rate ────────────────────────────────────────────────────────────
 * The speed block is written every frame; the nav list is rebuilt at 5 Hz.
 * Range to a body 245 km away changes by 91 m in a frame at cruise, which is
 * 0.04% of the number drawn - so rebuilding six rows of DOM sixty times a
 * second would be sixty times the layout cost for a digit that does not move.
 * Both intervals are re-derived from `dt`, so neither depends on frame rate.
 */

const NAV_HZ = 5;
/**
 * Rows drawn. Seven, which is EVERY target there is - see `navTargets()`.
 *
 * -- WHY THIS WAS THE WORST NUMBER IN THE GAME ------------------------------
 * It was 5, under a comment reading "six bodies plus the belt plus the yard is
 * eight; five fits". There are FIVE bodies, so the total is seven, and the
 * constant was picked against arithmetic that was already wrong.
 *
 * `Piloting.navReport` sorts by range and then pins home to row 0, so drawing
 * five of seven cuts the two FURTHEST every time - not just at the start.
 * From anywhere a player will ever be, those two are Ceraunus (~245 km) and
 * Erenmark (~651 km): the exact two the OBJECTIVES panel demands as `CER` and
 * `ERE`, worth 350 and 1,450 credits. 1,450 is the largest single prize in the
 * campaign.
 *
 * Flown through the real integrator, they only entered the drawn list once
 * the ship was already most of the way there - Erenmark at 371.8 km out, 48%
 * of the flight; Ceraunus at 144.2 km, 82%. And Erenmark is dead astern at the
 * launch point (`ahead = -0.67`), so there was no bearing, no range and no
 * marker for either. Content built and unreachable, with the reward attached.
 *
 * Seven rows is 84 px of a 900 px frame at the row height in `flight.css`, and
 * the list is rebuilt at `NAV_HZ` behind a string compare, so the cost of the
 * two extra rows is two `<div>`s that almost never change.
 */
const NAV_ROWS = 7;

/** Distance, in the unit a pilot can act on. */
function range(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/**
 * Where a target is, as one glyph.
 *
 * A compass bearing needs a horizon and there is not one out here, so this is
 * the signed dot with the nose and with the ship's own up vector - which is
 * what the pilot actually steers by, and which stays correct through a roll.
 */
function arrow(ahead, above, right) {
  if (ahead > 0.93) return '●';                    // dead ahead
  if (ahead < -0.5) return '↺';                    // behind: turn round
  if (Math.abs(above) > Math.abs(right)) return above > 0 ? '▲' : '▼';
  return right > 0 ? '▶' : '◀';
}

export class FlightHUD {
  /** @param {{root:HTMLElement, bus:any, piloting:any, combat?:any}} ctx */
  constructor({ root, bus, piloting, combat = null }) {
    this.bus = bus ?? null;
    this.piloting = piloting ?? null;
    this.combat = combat;
    this._navT = 0;
    this._prompt = null;
    this._report = {};
    this._fight = {};
    this._nav = [];
    this._lastNavKey = '';
    this._lastTgtKey = '';
    this._took = false;
    /** Last value written into the landed hint. See `update`. */
    this._sitText = '';

    this.el = this._build();
    root?.appendChild?.(this.el);

    /* The board prompt is published whether or not the mode is active, so it is
     * an event rather than a poll: on foot the wrap is hidden and only the
     * prompt line shows. */
    /** One slot per publisher on `pilot:prompt`. See `./PromptSlots.js`. */
    this._slots = { board: null, mining: null };
    /** The keycap letter each publisher wants drawn, same keys as `_slots`. */
    this._keys = { board: 'F', mining: 'E' };
    /* THE DEATH SCREEN.
     *
     * There was not one. Being shot down produced a single `warn` toast -
     * "Autopilot returned the hull to Lodestar Yard." - which expires, and
     * three test sessions ended with the player standing in the yard with no
     * idea why. This card does not expire: it stays until it is dismissed,
     * because "what just happened to me" is the one question a game must never
     * make the player answer from an event log.
     *
     * It lives OUTSIDE `.fl-wrap` for the reason the prompt does - the wrap is
     * hidden the instant `piloting.active` goes false, and being shot down is
     * exactly the moment that happens. A death card inside a hidden parent is
     * the built-but-unreachable defect as a div, and this file has already had
     * that bug once.
     */
    this._offDown = bus?.on?.('pilot:downed', (e) => this._showDowned(e)) ?? null;

    this._offPrompt = bus?.on?.('pilot:prompt', (e) => {
      const slot = promptSlot(e?.source);
      this._slots[slot] = e?.text ?? null;
      if (typeof e?.key === 'string' && e.key) this._keys[slot] = e.key;
      const won = pickPromptSlot(this._slots);
      const text = won ? this._slots[won] : null;
      const key = won ? this._keys[won] : '';
      const composed = text ? `${key}\u0000${text}` : null;
      if (composed === this._prompt) return;
      this._prompt = composed;
      /* A keycap chip and a sentence, exactly like `.prompt` in `hud.css`.
       *
       * These two prompts appear on screen SIMULTANEOUSLY - stand on the pier
       * beside a deck hand and your own hull and both are up - and until now
       * one was a proper chip ("E | Talk to Rig-Chief Odalys Prieto") and the
       * other was plain white text in a grey box ("[F] Board the Kestrel").
       * Two visual languages for one idea, eight pixels apart.
       *
       * `textContent` on the parts, never on a concatenated string: the text
       * carries an authored node name, and building this line with innerHTML
       * would put a world's content into the markup path. */
      this.promptKeyEl.textContent = key;
      this.promptTextEl.textContent = text ?? '';
      this.promptEl.classList.toggle('on', !!text);
    });
  }

  _build() {
    const wrap = document.createElement('div');
    wrap.className = 'fl-wrap';
    wrap.innerHTML = `
      <div class="fl-speed">
        <div class="lab" data-fl="name">SHIP</div>
        <div class="n"><span data-fl="spd">0</span><small>m/s</small></div>
        <div class="fl-bar"><u data-fl="mark"></u><i data-fl="bar"></i></div>
        <div class="fl-bar fl-fuel"><i data-fl="fuel"></i></div>
        <span class="fl-tag" data-fl="tag">TRANSIT</span>
        <div class="fl-sit" data-fl="sit"></div>
      </div>
      <div class="fl-nav">
        <h4>Navigation</h4>
        <div data-fl="rows"></div>
        <div class="fl-alt" data-fl="alt"></div>
        <div class="fl-hold" data-fl="hold"></div>
      </div>
      <div class="fl-def" data-fl="def">
        <div class="lab" data-fl="deflab">Shields <b>100%</b></div>
        <div class="fl-shield" data-fl="shwrap"><i data-fl="shield"></i></div>
        <div class="lab lab2">Guns</div>
        <div class="fl-gun" data-fl="gunwrap"><i data-fl="gun"></i></div>
      </div>
      <div class="fl-tgt" data-fl="tgt">
        <span class="nm" data-fl="tgtname"></span><span class="rg" data-fl="tgtrange"></span>
        <div class="hp"><i data-fl="tgthp"></i></div>
      </div>
      <div class="fl-warn" data-fl="warn"></div>
      <div class="fl-mark aim" data-fl="aim"><i></i></div>
      <div class="fl-mark lead" data-fl="lead"></div>
      <div class="fl-flash" data-fl="flash"></div>
      <div class="fl-down" data-fl="down">
        <div class="fl-down-card">
          <div class="fl-down-title">SHOT DOWN</div>
          <div class="fl-down-what" data-fl="downwhat"></div>
          <div class="fl-down-cost" data-fl="downcost"></div>
          <div class="fl-down-go" data-fl="downgo">Continue</div>
        </div>
      </div>`;

    const q = (k) => wrap.querySelector(`[data-fl="${k}"]`);
    this.nameEl = q('name');
    this.spdEl = q('spd');
    this.barEl = q('bar');
    this.markEl = q('mark');
    this.fuelEl = q('fuel');
    this.tagEl = q('tag');
    this.sitEl = q('sit');
    this.rowsEl = q('rows');
    this.altEl = q('alt');
    this.holdEl = q('hold');
    this.barWrap = this.barEl.parentElement;

    this.defEl = q('def');
    this.defLabEl = q('deflab');
    this.shieldEl = q('shield');
    this.shieldWrap = q('shwrap');
    this.gunEl = q('gun');
    this.gunWrap = q('gunwrap');
    this.tgtEl = q('tgt');
    this.tgtNameEl = q('tgtname');
    this.tgtRangeEl = q('tgtrange');
    this.tgtHpEl = q('tgthp');
    this.warnEl = q('warn');
    this.aimEl = q('aim');
    this.leadEl = q('lead');
    this.flashEl = q('flash');
    this.downEl = q('down');
    this.downWhatEl = q('downwhat');
    this.downCostEl = q('downcost');
    this.downGoEl = q('downgo');

    /* The prompt sits OUTSIDE `.fl-wrap`, which is hidden whenever the player
     * is not in the seat. It has to be visible on foot - it is the thing that
     * tells you the ship is boardable at all - and a prompt inside a hidden
     * parent is the built-but-unreachable defect as a div. */
    this.promptEl = document.createElement('div');
    this.promptEl.className = 'fl-prompt';
    this.promptKeyEl = document.createElement('b');
    this.promptKeyEl.className = 'fl-prompt-key';
    this.promptTextEl = document.createElement('span');
    this.promptTextEl.className = 'fl-prompt-text';
    this.promptEl.append(this.promptKeyEl, this.promptTextEl);

    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    host.appendChild(wrap);
    host.appendChild(this.promptEl);
    // See the note on `pilot:downed`: the wrap is hidden by the time this
    // needs to be on screen, so the card is re-parented out of it.
    host.appendChild(this.downEl);
    this.downGoEl.addEventListener('click', () => this._hideDowned());
    this.wrap = wrap;
    return host;
  }

  update(dt) {
    const p = this.piloting;
    const on = !!p?.active;
    this.wrap.classList.toggle('on', on);
    /* One class on the body, and `flight.css` does the rest - see the takeover
     * block at the bottom of that file. It is a class rather than a set of
     * inline styles so that nothing here has to know how `HUD.js` builds any of
     * the panels it hides, and so every one of them comes back the instant the
     * hatch opens. */
    if (this._took !== on) {
      this._took = on;
      document.body.classList.toggle('is-piloting', on);
    }
    if (!on) return;

    const r = p.report(this._report);
    this.nameEl.textContent = (r.name ?? 'SHIP').toUpperCase();
    this.spdEl.textContent = Math.round(r.speed * (r.transit > 1 ? r.transit : 1));

    const cap = r.boostTop || 1;
    this.barEl.style.width = `${Math.min(100, (r.speed / cap) * 100).toFixed(1)}%`;
    this.markEl.style.left = `${Math.min(100, (r.cruiseTop / cap) * 100).toFixed(1)}%`;
    this.barWrap.classList.toggle('boost', r.speed > r.cruiseTop);
    this.fuelEl.style.width = `${Math.max(0, Math.min(1, r.boostFuel)) * 100}%`;

    const transit = r.transit > 1.05;
    this.tagEl.classList.toggle('on', transit);
    if (transit) this.tagEl.textContent = `TRANSIT x${r.transit.toFixed(1)}`;

    /* HOW TO TAKE OFF, WHILE YOU ARE SITTING THERE NOT TAKING OFF.
     *
     * `Piloting.board` fires one info toast - "Kestrel - systems live. W to
     * lift." - and toasts expire. Driven cold, the tester sat in the seat
     * reading LANDED with no prompt anywhere on screen, looked around, and
     * wrote "Nothing says how to take off." A hint that has already gone by
     * the time you look for it is not a hint.
     *
     * Shown only while stationary on a surface, and it goes the instant the
     * ship moves - so it is on screen for exactly as long as it is the
     * question, and never once the player has answered it. One string
     * compare per frame and no DOM write unless it changed, like everything
     * else in this file. */
    const sitting = r.landed && r.speed < 1.5;
    const sit = sitting ? 'W to lift  ·  X airbrake  ·  F to leave the seat' : '';
    if (sit !== this._sitText) {
      this._sitText = sit;
      this.sitEl.textContent = sit;
      this.sitEl.classList.toggle('on', !!sit);
    }

    this.holdEl.textContent = r.cargoCap > 0
      ? `Hold ${r.cargoUnits} / ${r.cargoCap} m³${r.cargoValue > 0 ? `  ·  ${r.cargoValue} cr` : ''}`
      : 'No hold';
    this.holdEl.classList.toggle('full', r.cargoCap > 0 && r.cargoUnits >= r.cargoCap);

    /* Altitude, phase, AND rate of descent. The last one is the instrument the
     * landing rule was being enforced without: `Piloting` refuses a touchdown
     * over `descentLimit` m/s down, and until this line the pilot had no way to
     * know either the number or how close they were to it. Shown only while
     * falling and only over a surface, so it is absent in the yard and in the
     * void where it would mean nothing. */
    const falling = r.world !== 'space' && !r.landed && r.descent > 0.5;
    const hot = falling && r.descent > r.descentLimit;
    /* "ALT", spelled out.
     *
     * The nav list above this line prints RANGE TO CENTRE and this line prints
     * ALTITUDE ABOVE THE SURFACE, and neither said so - the HUD showed
     * "Cinder 49.6 km" one row above "Cinder · 40.6 km · APPROACH" and left
     * the pilot to work out that the 9,000 m difference is the planet's
     * radius. Two numbers for one body that visibly disagree read as a bug,
     * every time, and the fix is one word. */
    this.altEl.innerHTML = r.altitude === null || r.altitude === undefined
      ? `<b>${r.bodyName ?? ''}</b>${falling ? ` · <i class="fl-vs${hot ? ' hot' : ''}">▼ ${r.descent.toFixed(0)} m/s</i>` : ''}`
      : `<b>${r.bodyName ?? ''}</b> · ALT ${range(Math.max(0, r.altitude))} · ${String(r.phase).toUpperCase()}`
        + `${falling ? ` · <i class="fl-vs${hot ? ' hot' : ''}">▼ ${r.descent.toFixed(0)} m/s</i>` : ''}`;

    this._drawFight();

    this._navT -= dt;
    if (this._navT > 0) return;
    this._navT = 1 / NAV_HZ;
    this._drawNav(p);
  }

  /**
   * The gunnery half. Every frame, because all of it moves every frame: the
   * reticle tracks the nose through a roll, the lead pip tracks a target doing
   * 170 m/s, and the flash is decaying on the system's own clock.
   *
   * The one thing rate-limited is the contact NAME, which is a DOM text write
   * and only changes when the target does.
   */
  _drawFight() {
    const c = this.combat;
    if (!c) return;
    const r = c.report(this._fight);

    this.defEl.classList.add('on');
    const shPct = Math.round(r.shieldFrac * 100);
    this.defLabEl.innerHTML = r.shieldFrac > 0
      ? `Shields <b>${shPct}%</b>`
      : 'Shields <b>DOWN</b>';
    this.defLabEl.classList.toggle('down', r.shieldFrac <= 0);
    this.shieldEl.style.width = `${(r.shieldFrac * 100).toFixed(1)}%`;
    this.shieldWrap.classList.toggle('low', r.shieldFrac > 0 && r.shieldFrac < 0.34);
    this.shieldWrap.classList.toggle('out', r.shieldFrac <= 0);
    this.gunEl.style.width = `${(r.gun * 100).toFixed(1)}%`;
    /* "Dry" is the bar going amber below one shot's worth, which is the point
     * at which holding the trigger stops producing bolts. Without it the only
     * symptom of an empty capacitor is a gun that has silently stopped. */
    this.gunWrap.classList.toggle('dry', r.gun < 0.09);

    const t = r.target;
    this.tgtEl.classList.toggle('on', !!t);
    if (t) {
      const key = t.name;
      if (key !== this._lastTgtKey) { this._lastTgtKey = key; this.tgtNameEl.textContent = key; }
      this.tgtRangeEl.textContent = range(t.range);
      this.tgtHpEl.style.width = `${(t.frac * 100).toFixed(0)}%`;
    }

    this.warnEl.classList.toggle('on', r.warn > 0);
    if (r.warn > 0) this.warnEl.textContent = r.warnText;

    this._mark(this.aimEl, r.aim);
    this._mark(this.leadEl, r.lead);

    /* Opacity straight off the system's countdown rather than a CSS
     * animation: two hits 80 ms apart have to restart one decay, and a
     * keyframe animation restarted from JS drops a frame doing it. */
    const f = Math.max(0, Math.min(1, r.hitFlash / 0.34));
    this.flashEl.style.opacity = f > 0 ? f.toFixed(3) : '0';
    this.flashEl.className = `fl-flash${r.hitKind === 'hull' ? ' hull' : r.hitKind === 'down' ? ' down' : ''}`;
  }

  /**
   * Place one NDC mark.
   *
   * `left`/`top` as percentages and not a `vw`/`vh` transform: a percentage
   * resolves against the CONTAINING BLOCK, which is the overlay - the same
   * rectangle the camera renders into - whereas `vw` is the viewport, and the
   * two stop agreeing the moment anything gives the canvas a margin. A reticle
   * that is right on this machine and wrong on the next is worse than no
   * reticle.
   */
  _mark(el, m) {
    if (!m?.on) { el.classList.remove('on'); return; }
    el.classList.add('on');
    /* NDC is -1..1 with +Y up; CSS is 0..100% with +Y down. */
    el.style.left = `${(m.x * 50 + 50).toFixed(3)}%`;
    el.style.top = `${(50 - m.y * 50).toFixed(3)}%`;
  }

  _drawNav(p) {
    const rows = p.navReport(this._nav);
    if (!rows.length) {
      if (this._lastNavKey !== 'empty') { this.rowsEl.innerHTML = ''; this._lastNavKey = 'empty'; }
      return;
    }
    let html = '';
    for (let i = 0; i < Math.min(NAV_ROWS, rows.length); i++) {
      const t = rows[i];
      const cls = `row${t.kind === 'dock' ? ' home' : ''}${t.ahead > 0.93 ? ' ahead' : ''}`;
      html += `<div class="${cls}"><span class="ar">${arrow(t.ahead, t.above, t.right)}</span>`
        + `<span class="nm">${t.name}</span><span class="rg">${range(t.range)}</span></div>`;
    }
    // The DOM write is the expensive half; skip it when nothing visible changed.
    if (html === this._lastNavKey) return;
    this._lastNavKey = html;
    this.rowsEl.innerHTML = html;
  }

  /**
   * Draw the death card.
   *
   * Everything on it is a fact off the event, and the cost line is the whole
   * reason the card is worth having: being shot down now empties the un-banked
   * hold (`Piloting._onDied`), and a cost the player is not told about is a
   * cost they experience as a bug.
   *
   * @param {{hullName?:string, place?:string, killer?:string|null,
   *          lostCredits?:number, lostUnits?:number}} e
   */
  _showDowned(e) {
    const where = e?.place ? ` over ${e.place}` : '';
    const by = e?.killer === 'laser' ? 'Hostile fire'
      : e?.killer ? `Lost to ${e.killer}`
      : 'Hull integrity failed';
    this.downWhatEl.textContent =
      `${by}${where}. The ${e?.hullName ?? 'hull'} was flown back to Lodestar Yard on autopilot.`;
    const units = Number(e?.lostUnits) || 0;
    this.downCostEl.textContent = units > 0
      ? `Cargo lost: ${units} m³, ${Number(e?.lostCredits) || 0} CR unsold.`
      : 'The hold was empty. Nothing was lost.';
    this.downCostEl.classList.toggle('none', units <= 0);
    this.downEl.classList.add('on');
    /* Focus so Enter and Space dismiss it too. `pointer-events` is off on the
     * overlay root, so the card turns them back on for itself - a dismiss
     * button that cannot be clicked is the same defect as no button. */
    this.downGoEl.focus?.();
  }

  _hideDowned() {
    this.downEl.classList.remove('on');
  }

  dispose() {
    document.body.classList.remove('is-piloting');
    this._offPrompt?.();
    this._offDown?.();
    this.el.remove();
  }
}
