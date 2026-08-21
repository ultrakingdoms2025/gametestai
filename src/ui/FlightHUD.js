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
 *   TRANSIT      TWO different things share one tag, and they are mutually
 *                exclusive by construction so it can only ever be showing one.
 *                The DRIVE (`Flight`'s transit mode, on Z) draws its state -
 *                spinning up, engaged, dropping - in amber, because a 1.8 s
 *                spool with nothing on screen to show for it reads as a key
 *                that did not register. The MULTIPLIER (`Piloting._transit`,
 *                which engages itself) draws its factor in cyan, because it
 *                changes how far a second of flight goes by eight and an
 *                unannounced 8x is a bug report. `Piloting._transitFactor`
 *                returns 1 whenever the drive is live, which is what makes
 *                "only one" true rather than merely likely.
 *   SPEED UNIT   m/s below 1,000 and km/s above it. The drive tops out at
 *                5,000 and the last three digits of that change every frame.
 *   ETA          time to arrival, on the nav row the nose is pointed at, off
 *                the CLOSING speed. See `_drawNav` - the selection is the
 *                `.ahead` class this file has always drawn, not a new one.
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
 *   CONTACTS     every live hostile, as a bearing glyph and a range, in the
 *                SAME rows the nav list draws Cinder in. This is the answer to
 *                "combat is invisible at range" that is not a range change: a
 *                skiff at 850 m is nine pixels and no amount of emissive fixes
 *                that, so past the range where a contact can be SEEN it has to
 *                be FINDABLE, and findable is a glyph you can steer on and a
 *                number you can act on. `SpaceCombat.contactReport` fills the
 *                same shape `Piloting.navReport` does precisely so that this
 *                file draws both with one `arrow()`, one `range()` and one
 *                `.row`; the only difference is a class name.
 *   CONTACT PIPS one hollow bracket per hostile at its screen position, with
 *                its range under it - CLAMPED TO THE EDGE when the contact is
 *                off the plate or astern, because a marker that vanishes
 *                exactly when the target leaves the frame is a marker that is
 *                absent whenever it is needed, and FADED once the hull is big
 *                enough to be its own marker, because a box round a ship you
 *                can already see is one more thing between you and the fight.
 *   HELD         one line, shown only while the transit drive is being denied,
 *                counting down the seconds of broken contact left before it
 *                comes back. Being pinned with no idea why - or for how long -
 *                is the failure mode an interdiction invites.
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

/**
 * Contact rows and pips built up front. Six, which is `SpaceCombat`'s own
 * `MAX_HOSTILES` - the pool cannot produce a seventh, so this cannot be the
 * number that cuts one off the way `NAV_ROWS: 5` used to cut the two furthest
 * bodies off the nav list.
 *
 * They are PERSISTENT NODES rather than an `innerHTML` rebuild, and that is
 * the whole reason the contact list can run every frame while the nav list
 * runs at 5 Hz: a hostile's range changes every step of a fight, so a string
 * compare would fail every frame and rebuild six rows of DOM sixty times a
 * second. Writing `textContent` on two spans behind a compare is what the rest
 * of this file does and it costs nothing.
 */
const MAX_CONTACTS = 6;

/** NDC -> the CSS percentage of the overlay. -1..1 with +Y up becomes 0..100%
 *  with +Y down, which is the same conversion `_mark` makes. */
function pct(n) { return (n * 50 + 50).toFixed(2); }

/** Distance, in the unit a pilot can act on. */
function range(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  if (m < 100000) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m / 1000)} km`;
}

/**
 * Speed, in the unit that is READABLE at that speed.
 *
 * The transit drive tops out at 5,000 m/s and the last three digits of that
 * number change every frame, so "4,983" is not a reading, it is noise - a
 * pilot cannot tell it from 3,983 at a glance and gets no sense of closing at
 * all. The switch is at 1,000 because that is where the m/s figure stops
 * fitting a mental model built on 120-455, and because 1 km/s is a round place
 * to change units.
 *
 * Returned as a pair rather than one string: the markup already has a `<small>`
 * for the unit and re-writing both nodes only when they change is what keeps
 * this file's every-frame block down to two text writes.
 *
 * @returns {[string, string]} [number, unit]
 */
function speedText(mps) {
  const v = Number.isFinite(mps) ? Math.max(0, mps) : 0;
  if (v < 1000) return [String(Math.round(v)), 'm/s'];
  return [(v / 1000).toFixed(2), 'km/s'];
}

/**
 * Seconds as a DURATION a pilot reads, in the unit that duration fits in.
 *
 * ── WHY THIS IS NOT JUST m:ss WITH A CLAMP ─────────────────────────────────
 *
 * It was, and the clamp was `99:59`. That is the FIRST ETA the game ever shows
 * you: leave the yard under thrust and the nearest unaimed body is 155 km off
 * at 19 m/s, which is 8,158 seconds, which clamped. So the player's opening
 * impression of the instrument was a readout stuck at the maximum a clock can
 * count to - and a clock stuck at its maximum does not read as "a long way", it
 * reads as BROKEN. An ETA nobody believes is worse than no ETA, because it also
 * discredits the four rows above it.
 *
 * The honest number is 2 h 16 m, and the honest number happens to be exactly
 * the thing the player needs to know at that moment: you are crawling, and this
 * is what the transit drive is for. So past an hour this stops pretending to be
 * a stopwatch and becomes a duration - the same switch, and the same reason, as
 * `speedText` changing to km/s at 1,000.
 *
 * `--:--` survives for the two cases that genuinely have no number: not closing
 * at all (`navReport` already publishes `null` there, so this only sees it via
 * a NaN) and closing so slowly that even hours are noise.
 */
function clock(s) {
  if (!Number.isFinite(s) || s < 0) return '--:--';
  if (s < 3600) {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
  }
  /* 99 h is where a duration stops being one. At the yard's own scale that is a
   * ship closing on a 250 km body at under a metre a second - drifting, not
   * flying - and the answer to "when do I arrive" is honestly "you do not". */
  if (s < 356400) {
    const h = Math.floor(s / 3600);
    return `${h}h ${String(Math.floor((s - h * 3600) / 60)).padStart(2, '0')}m`;
  }
  return '--:--';
}

/** What the tag says, per drive state. Null hides it. */
const TRANSIT_TAG = {
  spooling: 'TRANSIT ▸ SPINNING UP',
  engaged: 'TRANSIT ▸ ENGAGED',
  dropping: 'TRANSIT ▸ DROPPING',
};

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
    /* Last strings written into the speed block and the transit tag. Every
     * write in `update` is behind a compare, per this file's own rule that the
     * DOM write is the expensive half. */
    this._spdText = '';
    this._spdUnit = '';
    this._tagText = '';
    /** Last value written into the landed hint. See `update`. */
    this._sitText = '';
    /* Last touchdown-envelope string drawn, so the row is a compare and not a
     * DOM write per frame - the same rule every other row in this file keeps. */
    this._landKey = null;

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
        <div class="n"><span data-fl="spd">0</span><small data-fl="spdunit">m/s</small></div>
        <div class="fl-bar"><u data-fl="mark"></u><i data-fl="bar"></i></div>
        <div class="fl-bar fl-fuel"><i data-fl="fuel"></i></div>
        <span class="fl-tag" data-fl="tag">TRANSIT</span>
        <div class="fl-sit" data-fl="sit"></div>
      </div>
      <div class="fl-nav">
        <div class="fl-hostiles" data-fl="hostiles">
          <h4>Contacts</h4>
          <div data-fl="hrows"></div>
          <div class="fl-held" data-fl="held"></div>
        </div>
        <h4>Navigation</h4>
        <div data-fl="rows"></div>
        <div class="fl-alt" data-fl="alt"></div>
        <div class="fl-land" data-fl="land"></div>
        <div class="fl-hold" data-fl="hold"></div>
      </div>
      <div class="fl-pips" data-fl="pips"></div>
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
    this.spdUnitEl = q('spdunit');
    this.barEl = q('bar');
    this.markEl = q('mark');
    this.fuelEl = q('fuel');
    this.tagEl = q('tag');
    this.sitEl = q('sit');
    this.rowsEl = q('rows');
    this.altEl = q('alt');
    this.landEl = q('land');
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
    this.hostilesEl = q('hostiles');
    this.heldEl = q('held');
    this.pipsEl = q('pips');
    this.aimEl = q('aim');
    this.leadEl = q('lead');

    /* The contact rows and the contact pips, built once. See `MAX_CONTACTS`.
     * Each entry caches the last string written into each node, because the
     * DOM write is the expensive half and a range that has not changed is a
     * write that should not happen. */
    this._hrows = [];
    this._pips = [];
    const hrowsEl = q('hrows');
    for (let i = 0; i < MAX_CONTACTS; i++) {
      const row = document.createElement('div');
      row.className = 'row hostile';
      const ar = document.createElement('span');
      ar.className = 'ar';
      const nm = document.createElement('span');
      nm.className = 'nm';
      const rg = document.createElement('span');
      rg.className = 'rg';
      row.append(ar, nm, rg);
      hrowsEl.appendChild(row);
      this._hrows.push({ el: row, arEl: ar, nmEl: nm, rgEl: rg, ar: '', nm: '', rg: '', on: false });

      const pip = document.createElement('div');
      pip.className = 'fl-ct';
      const mark = document.createElement('i');
      const lab = document.createElement('b');
      pip.append(mark, lab);
      this.pipsEl.appendChild(pip);
      this._pips.push({ el: pip, labEl: lab, lab: '', cls: '', on: false });
    }
    /** Filled in place by `SpaceCombat.contactReport`; this file owns it. */
    this._cts = [];
    this._heldText = '';
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

    /* THE NUMBER, and it is `speed x multiplier` because the displacement
     * multiplier keeps `flight.speed` honest while covering eight times the
     * ground - so the honest number would be a speedometer that disagrees with
     * the window. The DRIVE needs no such correction: it moves the ship for
     * real, so its 5,000 is 5,000, and `_transitFactor` returns 1 whenever the
     * drive is live precisely so these two can never both be applied. */
    const shown = r.speed * (r.transit > 1 ? r.transit : 1);
    const [num, unit] = speedText(shown);
    if (num !== this._spdText) { this._spdText = num; this.spdEl.textContent = num; }
    if (unit !== this._spdUnit) { this._spdUnit = unit; this.spdUnitEl.textContent = unit; }

    /* The bar is drawn against the HULL's own cap and therefore pins at 100%
     * for the whole of a transit leg - which is correct and useless, so the
     * drive gets the tag and the ETA instead of a bar that has nothing to say. */
    const cap = r.boostTop || 1;
    this.barEl.style.width = `${Math.min(100, (r.speed / cap) * 100).toFixed(1)}%`;
    this.markEl.style.left = `${Math.min(100, (r.cruiseTop / cap) * 100).toFixed(1)}%`;
    this.barWrap.classList.toggle('boost', r.speed > r.cruiseTop);
    this.fuelEl.style.width = `${Math.max(0, Math.min(1, r.boostFuel)) * 100}%`;

    /* THE DRIVE FIRST, then the multiplier. They are mutually exclusive by
     * construction (see `Piloting._transitFactor`), and the drive is the one
     * the player pressed a key for - a state they asked for outranks one that
     * happened to them. */
    const tag = TRANSIT_TAG[r.transitState] ?? (r.transit > 1.05 ? `TRANSIT x${r.transit.toFixed(1)}` : null);
    this.tagEl.classList.toggle('on', !!tag);
    this.tagEl.classList.toggle('drive', !!TRANSIT_TAG[r.transitState]);
    if (tag && tag !== this._tagText) { this._tagText = tag; this.tagEl.textContent = tag; }

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
    /* ── A BODY WITH NO GROUND SAYS SO, IN THE ROW THAT INVITED THE DESCENT ─
     *
     * This printed `Ceraunus · ALT 0 m · ATMOSPHERE` for four and a half
     * minutes while the ship flew from 20 km outside the gas giant to 24 m
     * from its centre, because ALT is clamped at zero and ATMOSPHERE is a
     * phase name that reads as "you have arrived". The objective panel one
     * corner over was simultaneously saying "fly in until the readout says
     * APPROACH, then descend". Two rows, both true-looking, both wrong about
     * the only thing that mattered.
     *
     * For a body the ship cannot land on, the useful number is not the height
     * above a surface that does not exist - it is HOW MUCH IS LEFT before the
     * hull stops, which `Piloting.report` publishes as `hullClear`. */
    const phase = r.noSurface ? 'NO SURFACE' : String(r.phase).toUpperCase();
    const height = r.noSurface && r.hullClear !== null && r.hullClear !== undefined
      ? `HULL ${range(Math.max(0, r.hullClear))}`
      : (r.altitude === null || r.altitude === undefined ? null : `ALT ${range(Math.max(0, r.altitude))}`);
    const vs = falling ? ` · <i class="fl-vs${hot ? ' hot' : ''}">▼ ${r.descent.toFixed(0)} m/s</i>` : '';
    this.altEl.innerHTML = height === null
      ? `<b>${r.bodyName ?? ''}</b>${vs}`
      : `<b>${r.bodyName ?? ''}</b> · ${height} · ${phase}${vs}`;

    /* ── THE TWO NUMBERS THE TOUCHDOWN IS JUDGED ON ────────────────────────
     *
     * Six landings out of six came in as "Hard landing - 78 to 139 m/s" for
     * 55 integrity apiece, and the reason is not that the rule is harsh: it is
     * that the rule was invisible. `Piloting._groundContact` refuses a landing
     * on EITHER of two tests, and the HUD published one of the two live values
     * and neither of the two limits - so the failing state was the default
     * state and there was nothing on screen to fly against.
     *
     * Both, with their limits, in the shape of a gauge rather than a warning:
     * a pilot reads "4 / 21" as "I have room" without being told anything, and
     * the number turns red at the line the seam actually enforces. Shown from
     * the moment there is ground under the ship rather than only while it is
     * falling fast, because an envelope you are only shown once you are
     * outside it is a post-mortem. */
    const envelope = r.world !== 'space' && !r.landed && r.active
      && r.altitude !== null && r.altitude !== undefined;
    if (envelope) {
      const dHot = r.descent > r.descentLimit;
      const sHot = r.speed > r.touchdownSpeed;
      const key = `${Math.round(r.descent)}|${Math.round(r.speed)}|${dHot}|${sHot}|${r.padName}|${r.padRimDeg}`;
      if (key !== this._landKey) {
        this._landKey = key;
        /* "SET DOWN" and not "SET DOWN UNDER": measured in the built page, the
         * longer label wrapped the row onto two lines inside the nav panel and
         * left a naked "m/s" underneath it. The slash already reads as
         * "against". */
        this.landEl.innerHTML = 'SET DOWN'
          + ` <i class="${dHot ? 'hot' : ''}">▼ ${Math.max(0, r.descent).toFixed(0)}/${r.descentLimit.toFixed(0)}</i>`
          + ` <i class="${sHot ? 'hot' : ''}">▶ ${r.speed.toFixed(0)}/${r.touchdownSpeed.toFixed(0)}</i> m/s`
          /* AND WHAT YOU ARE LANDING ON. Seven of the ten worlds have a pad you
           * can walk off and never climb back onto, and they are the rich ones
           * - the pads worth flying to. `PlanetWorld` has always measured each
           * disc's rim; this is the first thing to read it. The name shows for
           * every pad in range; the rim only when it is a shelf rather than a
           * clearing, because annotating a 12 m drop is annotating "this is a
           * pad". */
          + (r.padName
            ? `<b class="pad">${r.padName}${r.padRimDeg !== null && r.padRimDeg !== undefined
              ? ` · <i class="hot">${r.padRimDeg}° rim, ${r.padDrop} m drop</i>` : ''}</b>`
            : '');
      }
    } else if (this._landKey !== null) {
      this._landKey = null;
      this.landEl.innerHTML = '';
    }
    this.landEl.classList.toggle('on', !!envelope);

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
    this._drawContacts(c, r);

    /* Opacity straight off the system's countdown rather than a CSS
     * animation: two hits 80 ms apart have to restart one decay, and a
     * keyframe animation restarted from JS drops a frame doing it. */
    const f = Math.max(0, Math.min(1, r.hitFlash / 0.34));
    this.flashEl.style.opacity = f > 0 ? f.toFixed(3) : '0';
    this.flashEl.className = `fl-flash${r.hitKind === 'hull' ? ' hull' : r.hitKind === 'down' ? ' down' : ''}`;
  }

  /**
   * THE FINDABILITY HALF: every live hostile as a row and a pip.
   *
   * Nothing here computes anything, per this file's rule. `contactReport`
   * fills rows in the shape `Piloting.navReport` publishes - `ahead`, `above`,
   * `right`, `range` - and this draws them with the same `arrow()` glyph and
   * the same `range()` formatter the nav list uses. A hostile is a nav target
   * that shoots back; it should read like one.
   *
   * Every write is behind a compare and no node is created or destroyed, so
   * this runs at frame rate. That matters: a nav range moves 91 m in a frame
   * and a contact's moves by nothing you would notice either - but its BEARING
   * moves through a whole quadrant in a turn, and a glyph that updated at 5 Hz
   * would point the wrong way for a fifth of a second at the exact moments a
   * pilot is reading it.
   *
   * @param {object} c the combat system, for `contactReport`
   * @param {object} r its `report()`, already read by the caller
   */
  _drawContacts(c, r) {
    const rows = c.contactReport ? c.contactReport(this._cts) : this._cts;
    const n = rows.length;
    this.hostilesEl.classList.toggle('on', n > 0 || r.locked);

    for (let i = 0; i < MAX_CONTACTS; i++) {
      const row = this._hrows[i];
      const pip = this._pips[i];
      const t = i < n ? rows[i] : null;

      if (!t) {
        if (row.on) { row.on = false; row.el.classList.remove('on'); }
        if (pip.on) { pip.on = false; pip.el.classList.remove('on'); }
        continue;
      }

      if (!row.on) { row.on = true; row.el.classList.add('on'); }
      const g = arrow(t.ahead, t.above, t.right);
      if (g !== row.ar) { row.ar = g; row.arEl.textContent = g; }
      if (t.name !== row.nm) { row.nm = t.name; row.nmEl.textContent = t.name; }
      const rg = range(t.range);
      if (rg !== row.rg) { row.rg = rg; row.rgEl.textContent = rg; }
      row.el.classList.toggle('lock', !!t.locked);
      row.el.classList.toggle('hot', !!t.inRange);

      /* THE PIP. `contactReport` has already resolved the awkward half - a
       * contact behind the camera or off the plate arrives with `edge` set and
       * `ndc` carrying the BEARING instead of a projection, because a
       * projection of something astern is a confident lie in the opposite
       * corner. All that is left here is where on the border to put it.
       *
       * The finite test is not defensive theatre. `left: NaN%` is dropped by
       * the browser without complaint, which pins the pip silently to the
       * top-left corner - a marker pointing at a hostile that is not there is
       * worse than no marker, and this project has a NaN in its history that
       * cost a day. */
      let x = t.ndc?.x;
      let y = t.ndc?.y;
      if (!t.ndc?.on || !Number.isFinite(x) || !Number.isFinite(y)) {
        if (pip.on) { pip.on = false; pip.el.classList.remove('on'); }
        continue;
      }
      if (t.edge) {
        /* Pushed out to the border along its own bearing. `|| 1` because a
         * bearing of exactly zero in both axes is the one case this cannot
         * normalise, and dividing by it is the mistake. */
        const m = Math.max(Math.abs(x), Math.abs(y)) || 1;
        x = (x / m) * 0.86;
        y = (y / m) * 0.86;
      } else {
        x = Math.max(-0.97, Math.min(0.97, x));
        y = Math.max(-0.97, Math.min(0.97, y));
      }
      if (!pip.on) { pip.on = true; pip.el.classList.add('on'); }
      pip.el.style.left = `${pct(x)}%`;
      pip.el.style.top = `${pct(-y)}%`;
      /* `legible` is `SpaceCombat`'s own answer to "can the player see this
       * without help", derived from the hull's real span and the camera's real
       * FOV rather than from a range typed here. Past it the bracket fades -
       * see the note on `.fl-ct.near` in `flight.css`. */
      const cls = `fl-ct on${t.edge ? ' edge' : ''}${t.locked ? ' lock' : ''}`
        + `${t.inRange ? ' hot' : ''}${t.legible ? ' near' : ''}`;
      if (cls !== pip.cls) { pip.cls = cls; pip.el.className = cls; }
      if (rg !== pip.lab) { pip.lab = rg; pip.labEl.textContent = rg; }
    }

    /* HOW TO GET AWAY, ON SCREEN, WHILE YOU CANNOT.
     *
     * `SpaceCombat` denies the transit drive while something has been in reach
     * of you or gaining on you within the last `LOCK_GRACE` seconds, and
     * `Piloting` refuses the key with a toast that expires. A pilot who
     * pressed Z ten seconds ago and is still in normal space has no way to
     * know whether they are being held or whether the key is broken, and no
     * way to know what would fix it.
     *
     * So it is a COUNTDOWN and not a label. The moment the player is clear of
     * every gun and nothing is gaining, the number starts ticking - and a
     * number that runs down while you hold a heading, and snaps back to
     * "BREAK CONTACT" the instant a skiff turns in again, teaches the whole
     * rule in one encounter without a word of tutorial. */
    const held = r.locked
      ? (typeof r.lockIn === 'number'
        ? `TRANSIT HELD · CLEAR IN ${Math.ceil(r.lockIn)}s`
        : 'TRANSIT HELD · BREAK CONTACT')
      : '';
    if (held !== this._heldText) {
      this._heldText = held;
      this.heldEl.textContent = held;
      this.heldEl.classList.toggle('on', !!held);
    }
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
    /* TIME TO ARRIVAL, ON THE TARGET THE PILOT IS AIMED AT.
     *
     * There has never been a "selected nav target" in this game and this is
     * not the file to invent one: `navReport` sorts by range and pins home to
     * row 0, and the only selection that exists anywhere is the `.ahead` class
     * this loop already puts on the row the nose is on. So THAT is the
     * selection - the row with the largest `ahead` above the same 0.93 cone -
     * and the ETA is drawn on it and on nothing else. One number, on the thing
     * you are pointed at, which is what a pilot is asking.
     *
     * The arithmetic is `Piloting.navReport`'s, off the closing speed rather
     * than the speed; see the note there for why that distinction is the whole
     * point at 5 km/s.
     */
    let focus = -1;
    for (let i = 0; i < Math.min(NAV_ROWS, rows.length); i++) {
      if (rows[i].ahead > 0.93 && (focus < 0 || rows[i].ahead > rows[focus].ahead)) focus = i;
    }

    let html = '';
    for (let i = 0; i < Math.min(NAV_ROWS, rows.length); i++) {
      const t = rows[i];
      const cls = `row${t.kind === 'dock' ? ' home' : ''}${t.ahead > 0.93 ? ' ahead' : ''}`;
      const eta = i === focus && t.eta !== null && t.eta !== undefined
        ? `<span class="eta">ETA ${clock(t.eta)}</span>` : '';
      html += `<div class="${cls}"><span class="ar">${arrow(t.ahead, t.above, t.right)}</span>`
        + `<span class="nm">${t.name}</span><span class="rg">${range(t.range)}</span>${eta}</div>`;
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
