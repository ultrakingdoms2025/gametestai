import { itemDef, mountPowerFromItem, skinIdFromItem } from './ItemDefs.js';
import { applyMountSkin } from './MountSkins.js';
import { MOUNT_SKINS_BY_ID } from './Cosmetics.js';
import { applyShipSkin } from '../ships/ShipSkins.js';
import { SHIP_SKINS_BY_ID, shipSkinIdFromItem } from '../ships/ShipStats.js';
/* The bag's ceiling, imported rather than re-typed. `Inventory` owns the
 * number, clamps `deserialize` to it and stops `expandBag` at it; this file
 * needs the same 60 to refuse a rig BEFORE the consume and to word the toast.
 * A literal here would be a second copy of the cap that nothing compares. */
import { BAG_CAPACITY_MAX } from './Inventory.js';

/**
 * Inventory item use dispatcher.
 *
 * Bag items are ordinary inventory rows, so the use path has to do three jobs:
 * 1. validate that the item is actually supported,
 * 2. consume one unit from the bag, and
 * 3. apply the effect through the owning gameplay systems.
 */

/** A hull id as the yard spells it: `pike` -> `Pike`. */
const shipName = (id) => (id ? id[0].toUpperCase() + id.slice(1) : 'ship');

/**
 * What a refused ship livery says, per reason.
 *
 * A table rather than a ternary chain because there are four distinct pieces
 * of news here and `_useSkin` above already shows what happens when two of
 * them are collapsed: mount skins tell a player to "mount your dragon" whether
 * the problem is that they are on foot or that they are riding the wrong
 * animal. The whole value of a reason code is spent if the toast throws it
 * away, and every line below names the ACTION rather than the state -
 * `_effectFor`'s `refusal` convention, applied to a dispatch that predates it.
 *
 * Each ends by saying the livery is kept. That sentence is doing real work:
 * the player is holding a single-use item they paid several hundred credits
 * for, and "it did not go on" and "it is gone" are the same picture from the
 * outside unless somebody says otherwise.
 * @type {Record<string, (skin:{name:string, ship:string}) => string>}
 */
const REFUSAL_TEXT = {
  'wrong-ship': (s) => `${s.name} is cut for the ${shipName(s.ship)} — pick that berth in Esc → Customise ship. Kept, not spent.`,
  'not-here': (s) => `Your ${shipName(s.ship)} is not in this world — fly to Lodestar Yard to have it painted. Kept, not spent.`,
  'not-owned': (s) => `You are not carrying a ${s.name} livery any more. Nothing was spent.`,
  unavailable: (s) => `${s.name} cannot go on right now. Kept, not spent.`,
  'unknown-scheme': (s) => `${s.name} is not a livery this yard recognises. Kept, not spent.`,
};

export class ItemUseSystem {
  constructor({
    bus, player, inventory, loot, portals, npcManager, combat, mounts, cosmetics, viewpoints, effects,
    spaceCombat, stamina, ships,
  } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.inventory = inventory ?? null;
    this.loot = loot ?? null;
    this.portals = portals ?? null;
    this.npcManager = npcManager ?? null;
    this.combat = combat ?? null;
    /* The pool the stamina draughts scale. Passed rather than reached through
     * `player.stamina`, which is the same choice `loot`, `combat` and
     * `npcManager` already got: this system's collaborators arrive at the
     * constructor, and a system that went hunting for one of them through
     * another object would be a second way to find the same thing. Optional
     * like all of them - `_canApply` answers false without it, which refuses
     * the use BEFORE `consumeFromBag`, so an unwired pool is a draught the
     * player still has. @see ./Stamina.js */
    this.stamina = stamina ?? null;
    /* Read - never written - by `_useSkin` and by `_useMountPower`, which asks
     * it the two questions the marketplace asks before a mount purchase: does
     * this mount sell this stat, and does the rider already have this tier.
     * The grant itself leaves as `mount:power:buy` on the bus, the way a
     * purchase does, and main.js is what routes that to the ledger. */
    this.mounts = mounts ?? null;
    this.cosmetics = cosmetics ?? null;
    /* Lodestar Yard's `nav_chart`. Optional like every other collaborator
     * here: a missing system makes `_canApply` answer false, which refuses the
     * use BEFORE `consumeFromBag` at `use()`, so an unwired chart is a chart
     * you still have. */
    this.viewpoints = viewpoints ?? null;
    /* The HUD's active-effect ledger. Optional like every other collaborator
     * here, and deliberately NOT consulted by `_canApply`: a missing ledger
     * must cost the player a chip, never the use. @see ./ActiveEffects.js */
    this.effects = effects ?? null;
    /* The ship-to-ship gun, for `laser_cell`. Optional like the chart, and
     * asked the same way: `_canApply` calls `canWidenGuns()` BEFORE
     * `consumeFromBag`, so an unwired `SpaceCombat` refuses the use and the
     * player still has their cells. Constructed after this system in main.js
     * (it needs `piloting`, which needs the world manager), so it is assigned
     * there rather than passed here - exactly as `viewpoints` is, and for the
     * same reason: re-ordering the two would only move the knot.
     * @see ../ships/SpaceCombat.js */
    this.spaceCombat = spaceCombat ?? null;
    /* The hull registry, read - never written - by `_useShipSkin`, which asks
     * it the two questions a livery turns on: is this livery for the hull the
     * panel is pointed at, and is that hull standing in this world at all.
     *
     * Optional like every other collaborator here, and for the identical
     * reason: `applyShipSkin` answers `unavailable` without it, which refuses
     * the use BEFORE `consumeFromBag`, so an unwired registry is a livery the
     * player still has. Assigned in main.js after construction, like
     * `viewpoints` and `spaceCombat` - `ShipRegistry` needs the world manager,
     * which is built after this system, and moving this system down would only
     * move the knot. @see ../ships/ShipRegistry.js */
    this.ships = ships ?? null;
  }

  use(itemId) {
    if (!this.inventory || typeof itemId !== 'string' || !itemId) {
      return { ok: false, reason: 'unavailable' };
    }

    // Mount skins are not effects: they are consumed by applyMountSkin only on
    // a successful apply, so they must never reach the generic consume below.
    // This dispatch runs before the player requirement below because a skin
    // needs inventory/mounts/cosmetics, not the player.
    if (itemDef(itemId)?.kind === 'skin') return this._useSkin(itemId);

    // A mount upgrade is not an effect either: it writes a tier into the
    // mount ledger and is consumed only if that write is a change. Dispatched
    // here for the same reason a skin is - it needs `mounts` and the bag, not
    // the player - and BEFORE the generic path, whose `consumeFromBag` runs
    // ahead of `_apply` and would spend the kit on a refusal.
    if (itemDef(itemId)?.kind === 'mountpower') return this._useMountPower(itemId);

    // A ship livery is the mount skin's twin, one vehicle over, and gets the
    // same treatment for the same reason: `applyShipSkin` consumes it only on
    // a successful apply, so it must never reach the generic consume below.
    // Dispatched here because it needs `ships`, `cosmetics` and the bag - not
    // the player, who does not have to be alive, healthy or anywhere near a
    // seat to have a hull painted.
    if (itemDef(itemId)?.kind === 'shipskin') return this._useShipSkin(itemId);

    if (!this.player) return { ok: false, reason: 'unavailable' };

    const effect = this._effectFor(itemId);
    if (!effect) return { ok: false, reason: 'unsupported' };
    if (!this._canApply(effect, itemId)) {
      /* AN ACTIONABLE REFUSAL, WHERE THE EFFECT HAS ONE TO GIVE.
       *
       * `_canApply` answering false leaves `use()` returning `unavailable`,
       * and main.js turns that into "Cannot use that right now" - which is
       * true, useless, and the reason `_useSkin` and `_useMountPower` both
       * grew their own toasts telling the player what to DO instead. Rather
       * than a third bespoke method, an effect may declare a `refusal`, and
       * declaring one also gives the failure its OWN reason code so main.js's
       * generic branch does not fire and stack a second toast on top of it.
       *
       * The predicate stays a predicate: nothing is emitted from inside
       * `_canApply`, so a caller can still ask the question without the player
       * being told anything. */
      if (effect.refusal) {
        this.bus?.emit('hud:notify', { text: effect.refusal.text, tone: 'warn' });
        return { ok: false, reason: effect.refusal.reason };
      }
      return { ok: false, reason: 'unavailable' };
    }
    if (!this.inventory.consumeFromBag(itemId, 1)) return { ok: false, reason: 'missing' };

    const applied = this._apply(effect, itemId);
    if (!applied) return { ok: false, reason: 'unsupported' };

    /* THE CHIP, raised HERE and not inside `_apply`.
     *
     * This line runs only after `_apply` returned non-null, which is the only
     * evidence that the owning system actually took the effect - `boostSpeed`
     * refuses a multiplier of 1, `pingNearest` refuses a world with no
     * gateways, and both were already reachable through `_canApply`. Raising
     * the chip inside `_apply` would have put an indicator on screen for the
     * refusals as well.
     *
     * `effect.duration` is undefined for `heal` and for `chart`, and
     * `ActiveEffects.start` answers false to that - which is how a medkit and
     * a nav chart get no chip without this file holding a second list of which
     * effects are timed. @see ./ActiveEffects.js `EFFECT_KINDS` */
    this.effects?.start(effect.type, effect.duration, itemDef(itemId)?.name);

    this.bus?.emit('inventory:item-used', { itemId, effect: effect.type, amount: effect.amount ?? effect.duration ?? 0 });
    return { ok: true, ...applied };
  }

  _useSkin(itemId) {
    const skinId = skinIdFromItem(itemId);
    const skin = skinId ? MOUNT_SKINS_BY_ID.get(skinId) : null;
    if (!skin) return { ok: false, reason: 'unsupported' };
    const res = applyMountSkin({ mounts: this.mounts, cosmetics: this.cosmetics, inventory: this.inventory }, skinId);
    if (!res.ok) {
      const text = res.reason === 'not-mounted' || res.reason === 'wrong-mount'
        ? `Mount your ${skin.mount}, then Esc → Customise mount to apply this skin`
        : 'This skin cannot be applied right now';
      this.bus?.emit('hud:notify', { text, tone: 'warn' });
      return { ok: false, reason: res.reason };
    }
    if (res.consumed) this.bus?.emit('inventory:item-used', { itemId, effect: 'skin', amount: 1 });
    this.bus?.emit('hud:notify', { text: `${skin.name} applied to your ${skin.mount}`, tone: 'info' });
    return { ok: true, consumed: res.consumed };
  }

  /**
   * Wear a ship livery: paint one hull, and spend the tin.
   *
   * `_useSkin`'s twin, and it differs in exactly one place - the refusal copy -
   * because the two failures a livery has are DIFFERENT PROBLEMS with different
   * fixes, and a single "cannot be applied right now" would have hidden that:
   *
   *   `wrong-ship`  You are holding a Kestrel livery and the panel is pointed
   *                 at the Pike. The fix is one click: take the other tab. The
   *                 message names the hull the livery is FOR, because that is
   *                 the fact the player is missing.
   *   `not-here`    The hull is not in this world. The fix is a flight to the
   *                 yard, and telling someone in Aldermoor Vale to "take the
   *                 other tab" would send them looking for a panel that does
   *                 not open there.
   *   `not-owned`   The bag row is gone from under the use - a second window,
   *                 a stale panel. Says so rather than blaming the hull.
   *
   * Nothing here is consumed on any of those: `applyShipSkin` asks every one of
   * these questions BEFORE `consumeFromBag`, which is the rule this whole file
   * is built around and the one `_useMountPower` states at length.
   *
   * The hull it aims at is the SELECTED one - `ships.selectedId` - and falls
   * back to the livery's own hull when nothing is selected. That fallback is
   * what makes the inventory Use button work at all: a player who opens the bag
   * without first opening the ship panel has selected nothing, and refusing
   * them for it would be a button that only works after you have pressed a
   * different button. With the fallback, using a Pike livery in the yard paints
   * the Pike, which is the only thing it could have meant.
   *
   * @param {string} itemId
   * @returns {{ok:boolean, reason?:string, consumed?:boolean}}
   */
  _useShipSkin(itemId) {
    const skinId = shipSkinIdFromItem(itemId);
    const skin = skinId ? SHIP_SKINS_BY_ID.get(skinId) : null;
    if (!skin) return { ok: false, reason: 'unsupported' };

    /* Selected hull first, the livery's own hull second. `selectedId` is a
     * plain getter and answers null off a registry with no world, so this is
     * safe against an unwired one - which `applyShipSkin` then refuses on its
     * own terms, keeping the tin. */
    const shipId = this.ships?.selectedId ?? skin.ship;
    const res = applyShipSkin(
      { ships: this.ships, cosmetics: this.cosmetics, inventory: this.inventory }, shipId, skinId,
    );
    if (!res.ok) {
      const text = REFUSAL_TEXT[res.reason]?.(skin) ?? `The ${skin.name} livery cannot go on right now`;
      this.bus?.emit('hud:notify', { text, tone: 'warn' });
      return { ok: false, reason: res.reason };
    }
    if (res.consumed) this.bus?.emit('inventory:item-used', { itemId, effect: 'shipskin', amount: 1 });
    this.bus?.emit('hud:notify', { text: `${skin.name} laid on your ${shipName(skin.ship)}`, tone: 'info' });
    return { ok: true, consumed: res.consumed };
  }

  /**
   * Fit a mount upgrade: raise one stat tier on one mount, and spend the kit.
   *
   * The emit is `mount:power:buy`, byte for byte what a merchant purchase
   * sends and what `Loot.collectEntry` used to send on collection, at
   * `cost: 0` with `catalogId: null` so nothing downstream can mistake it for
   * a sale. main.js already routes it to `MountManager.grantPower` and
   * schedules the local and remote persists; nothing new listens, because the
   * purchase path IS the grant path. That is also why this does NOT require
   * the player to be mounted: buying the upgrade at a shop never did, and a
   * rule that only the bag copy has to be ridden to apply would be a second
   * economy again.
   *
   * ── Owning the tier already REFUSES; it does not silently eat the kit ────
   * `grantPower` is `max(existing, tier)`, so applying a tier you already
   * hold is a no-op in the ledger. Consuming the unit for that no-op is the
   * failure this file already names in `_canApply`'s `chart` branch - the
   * unit destroyed for nothing - and here it is worse, because the kit is
   * still worth something to the player: it is the *only* copy of an upgrade
   * they may want on a fresh account. So the refusal is loud, actionable and
   * keeps the item.
   *
   * @param {string} itemId
   * @returns {{ok:boolean, reason?:string, mount?:string, power?:string, tier?:number}}
   */
  _useMountPower(itemId) {
    const grant = mountPowerFromItem(itemId);
    if (!grant) return { ok: false, reason: 'unsupported' };
    const name = itemDef(itemId)?.name ?? itemId;

    /* Asked BEFORE `consumeFromBag`, like every other guard here: without the
     * ledger neither of the two questions below can be answered, so the game
     * cannot vouch for the grant and must leave the kit in the bag rather
     * than swallow it. `getPowers` and not `grantPower`, because reading is
     * what this method actually does - probing for a function nobody calls is
     * a guard that stops meaning anything the moment the class is refactored. */
    if (typeof this.mounts?.getPowers !== 'function') {
      this.bus?.emit('hud:notify', { text: `${name} cannot be fitted right now`, tone: 'warn' });
      return { ok: false, reason: 'unavailable' };
    }
    /* The same refusal the marketplace makes on the same question: a stat the
     * mount does not sell (Fire on a horse) is DROPPED by `grantPower`, so
     * consuming the kit for it would destroy it for nothing. Unreachable
     * through the generated items - they are built from `MOUNT_STATS` - and
     * kept because a save, a cheat or a later mount rename can all put an
     * item id in the bag that the ledger no longer honours. */
    if (this.mounts.sellsPower?.(grant.mount, grant.power) === false) {
      this.bus?.emit('hud:notify', { text: `A ${grant.mount} has no fitting for this`, tone: 'warn' });
      return { ok: false, reason: 'wrong-mount' };
    }
    const owned = Number(this.mounts.getPowers(grant.mount)?.[grant.power] ?? 0);
    if (owned >= grant.tier) {
      /* Owning it and RUNNING it are two different things since the fitting
       * became switchable, and the refusal has to say which one it means.
       *
       * The player who hits this is nearly always someone who switched the
       * fitting off, watched their mount go back to stock, and reached for the
       * spare kit in their bag to "put it back". Told only "already runs this
       * fitting", they would conclude the kit was broken. So the message names
       * the switch and where it is - and still keeps the item, because the
       * grant would be the same no-op either way and there is nothing here
       * worth spending the only copy of an upgrade on.
       *
       * Deliberately does NOT switch the fitting back on: consuming a use to
       * flip a switch the player can flip for free is exactly the "unit
       * destroyed for nothing" failure the rest of this file refuses.
       *
       * Optional call, like `sellsPower` above: a manager without the switch
       * answers undefined, which is not `false`, so the old wording stands. */
      const off = this.mounts.isPowerEnabled?.(grant.mount, grant.power) === false;
      this.bus?.emit('hud:notify', {
        text: off
          ? `Your ${grant.mount} owns this fitting at tier ${owned} but it is switched OFF — switch it on from Esc → Customise mount. Kept, not spent`
          : `Your ${grant.mount} already runs this fitting at tier ${owned} — kept, not spent`,
        tone: 'warn',
      });
      return { ok: false, reason: 'owned' };
    }

    if (!this.inventory.consumeFromBag(itemId, 1)) return { ok: false, reason: 'missing' };

    this.bus?.emit('mount:power:buy', {
      mount: grant.mount, power: grant.power, tier: grant.tier, catalogId: null, cost: 0,
    });
    this.bus?.emit('inventory:item-used', { itemId, effect: 'mountpower', amount: grant.tier });
    this.bus?.emit('hud:notify', { text: `${name} fitted to your ${grant.mount}`, tone: 'info' });
    return { ok: true, mount: grant.mount, power: grant.power, tier: grant.tier };
  }

  _effectFor(itemId) {
    switch (itemId) {
      case 'medkit':
        /* The refusal is chosen HERE rather than being one fixed string,
         * because the two ways a medkit can be refused are not the same news:
         * "you are already whole" is a shrug, and "you are dead" is the
         * explanation for why the button did nothing at the exact moment the
         * player most needed it to work. `_effectFor` is re-read on every use,
         * so this reads live state and cannot go stale. */
        return {
          type: 'heal',
          amount: 50,
          refusal: this.player?.isDead
            ? {
              reason: 'dead',
              text: 'You are down — a medkit cannot reach you until you are back on your feet. Kept, not spent.',
            }
            : {
              reason: 'already-whole',
              text: 'You are already at full health. Kept, not spent.',
            },
        };
      case 'speed_boost_25':
        return { type: 'speed', multiplier: 1.25, duration: 30 };
      case 'speed_boost_50':
        return { type: 'speed', multiplier: 1.5, duration: 30 };
      case 'speed_boost_75':
        return { type: 'speed', multiplier: 1.75, duration: 30 };
      case 'speed_boost_100':
        return { type: 'speed', multiplier: 2.0, duration: 30 };
      case 'loot_magnet_30s':
        return { type: 'magnet', duration: 30, range: 5.5 };
      /* FERRO-BASALT. The one Cinder ore with a use in the hand.
       *
       * It is magnetite-bearing basalt - a lodestone - so it routes to the
       * magnet effect that already exists rather than to an effect invented
       * for it. Weaker than the Vacuum Rune on both axes (20 s at 4.5 m
       * against 30 s at 5.5 m) because a rock out of the ground should not
       * beat the manufactured article; a rune stays worth its 165 credits.
       *
       * Nothing else in `ItemDefs`' six-element Cinder set appears here, and
       * that is deliberate rather than unfinished: the other five are cargo.
       * Giving a lump of tephra a switch case would be an effect nobody wants
       * attached to an item whose whole job is to be sold, and the recorded
       * cost of a use that fires and does nothing is the unit destroyed for
       * nothing (see `chart` in `_canApply` below). */
      case 'ferrobasalt':
        return { type: 'magnet', duration: 20, range: 4.5, label: 'Lodestone clipped on' };
      /* THE THREE HAND SAMPLES. Ore that reaches a bag, and what it does there.
       *
       * `ferrobasalt` above was the only ore with a case because it was the
       * only ore that could reach a bag. `Mining.mine` now has a second
       * destination - a node the ship cannot take, and that is small enough to
       * pocket, goes into the bag instead of being refused - so twenty-one of
       * the forty-seven ores can now be held. Three of them do something.
       *
       * Every one of them obeys the two rules `ferrobasalt` wrote down:
       *
       *   1. ROUTE TO AN EFFECT THAT ALREADY EXISTS. None of these three
       *      invents a type. A flux stone glazed over a coat is a `ward`, a
       *      hard cube behind a round is `firepower`, and beaten leaf scribed
       *      and read is a `chart`. An effect invented for a rock is an effect
       *      with one caller and no reviewer.
       *   2. WEAKER THAN THE MANUFACTURED ARTICLE, ON BOTH AXES. 20 s rather
       *      than 30, and a shallower multiplier, against the charm each one
       *      imitates - so a Bastion Ward and an Ardent Charm are still worth
       *      their 44 credits to somebody who is standing next to a counter.
       *
       * The third has no axes to be weaker on, and pays the difference in
       * credits instead. See the note over `aurichalc` in `ItemDefs`.
       *
       * `20` and `0.85`/`1.15` are stated here and repeated in the item
       * descriptions, which is the same two-copies-of-one-number hazard the
       * `ferrobasalt` note records having been caught in ("this note used to
       * say half a minute and the item said thirty seconds"). The gate that
       * watches it is `scripts/tests/ore-in-the-bag.test.mjs`, which reads the
       * duration out of the effect and asserts the item's own `desc` says the
       * same thing in words. */
      case 'cryolite':
        return this._wardEffect(0.85, 20);
      case 'sperrylite':
        return { type: 'firepower', multiplier: 1.15, duration: 20 };
      case 'aurichalc':
        /* The Cartographer's Plate's refusal, verbatim and for the same
         * reason: without one, `_canApply`'s false arrives as main.js's
         * "Cannot use that right now", which does not tell a player whether
         * the thing in their hand is broken, spent, or simply in the wrong
         * sky. The difference is what it costs to find out - a chip of
         * aurichalc is 700 cr/m3 and the Plate is 90. */
        return {
          type: 'chart',
          refusal: {
            reason: 'nothing-to-chart',
            text: 'Nothing here left to chart — leaf marks a district you have not stood on, in a world that has them. Kept, not spent.',
          },
        };
      case 'portal_ping_30s':
        return { type: 'portalPing', duration: 30 };
      case 'npc_pause_5s':
        return { type: 'pauseNpcs', duration: 5 };
      case 'npc_pause_10s':
        return { type: 'pauseNpcs', duration: 10 };
      case 'npc_pause_30s':
        return { type: 'pauseNpcs', duration: 30 };
      case 'npc_pause_60s':
        return { type: 'pauseNpcs', duration: 60 };
      case 'shield_5s':
        return { type: 'shield', duration: 5 };
      case 'firepower_boost_25':
        return { type: 'firepower', multiplier: 1.25, duration: 30 };
      case 'firepower_boost_50':
        return { type: 'firepower', multiplier: 1.5, duration: 30 };
      case 'firepower_boost_75':
        return { type: 'firepower', multiplier: 1.75, duration: 30 };
      case 'firepower_boost_100':
        return { type: 'firepower', multiplier: 2.0, duration: 30 };
      /* THE DAMAGE-REDUCTION WARDS. The defensive mirror of the four above.
       *
       * Thirty seconds, the same as the firepower rungs they mirror and the
       * same as every other timed thing in this switch, so the one number that
       * differs between an offensive rung and a defensive one is the number on
       * the label.
       *
       * The multipliers stop at 0.5 and there are three rungs rather than
       * four, and both of those are argued at length over the items in
       * `ItemDefs` - the short version is that the fourth rung of a
       * damage-reduction ladder is immunity, and `shield_5s` two cases above
       * already sells it, for five seconds, by name. */
      case 'ward_20':
        return this._wardEffect(0.80);
      case 'ward_35':
        return this._wardEffect(0.65);
      case 'ward_50':
        return this._wardEffect(0.50);
      /* THE STAMINA DRAUGHTS. Four rungs against the one player resource that
       * had nothing to buy for it.
       *
       * ── THIRTY SECONDS FOR THREE OF THEM, AND FIFTEEN FOR THE FOURTH ─────
       *
       * Thirty is what every other timed rung in this switch costs a player in
       * duration, and a new ladder that quietly ran longer than its neighbours
       * would be a balance decision hidden in a constant - the argument written
       * over `laser_cell` below.
       *
       * `stamina_draught_100` breaks that on purpose, and the break is the
       * decision this family needed most. x0 is not "one more rung of a
       * ladder": the other three make exertion cheaper and leave the resource
       * in the game, and this one REMOVES THE RESOURCE for its duration.
       * Nothing the player does costs anything - and because `Stamina.drain`
       * treats a scaled cost of zero as no drain at all rather than as a drain
       * of zero, the pool also refills underneath a sprint. The game has
       * exactly one other total-negation consumable, the Aegis Shard, and it is
       * priced in SECONDS rather than in a full window for precisely this
       * reason: five, against the thirty every graded effect gets.
       *
       * So this is priced the same way. Fifteen seconds, which is derived and
       * not picked: the pool is 100 and a sprint drains `sprintStaminaDrain`
       * = 15 a second, so one full pool is 6.7 s of unbroken sprint and this is
       * two of them. That is a real, felt window - long enough to cross ground
       * or take a wall that stamina would otherwise have stopped - and short
       * enough that it does not delete free-climbing, which is the system where
       * the pool is the actual challenge rather than a tax.
       *
       * KEPT AT x0 RATHER THAN ARGUED DOWN. The alternative was a top rung of
       * x0.1, and it was rejected because the action id this row is sold under
       * is `stamina_slowdown_100`, whose catalogue label is "Stamina drain off"
       * and whose description is "Temporarily pauses stamina drain". An effect
       * that left a tenth of the drain running would make the shop text a lie
       * about the only thing the item does. Duration is the honest lever, and
       * it is the one this game already reaches for. */
      case 'stamina_draught_25':
        return this._staminaEffect(0.75, 30);
      case 'stamina_draught_50':
        return this._staminaEffect(0.5, 30);
      case 'stamina_draught_75':
        return this._staminaEffect(0.25, 30);
      case 'stamina_draught_100':
        return this._staminaEffect(0, 15);
      /* THE SHIELD RECHARGE CELL. Space's first defensive consumable.
       *
       * `laser_cell` below was the only thing space sold, and it is a gun. The
       * ship's absorption pool takes every hit before the hull does
       * (`SpaceCombat._playerHit`) and structurally cannot recover during a
       * fight - `_shieldIdle` is zeroed by every hit and `_regen` waits
       * `SHIELD_DELAY` seconds of quiet that a live engagement never gives.
       *
       * Instantaneous, like `heal`, so there is deliberately NO `duration` and
       * therefore no chip: `ActiveEffects.start` answers false to an undefined
       * duration, which is how a medkit and a nav chart get no countdown
       * without this file keeping a second list of which effects are timed.
       *
       * `amount` is stated here rather than defaulted for the reason
       * `laser_cell` states its `bolts`: the number a player actually gets
       * should be visible from the item that grants it. It is
       * `SpaceCombat.SHIELD_CELL_CHARGE`, and the test pins the two together.
       *
       * `refusal` copied line for line from `laser_cell`, including the fact of
       * having one at all: without it `_canApply`'s false becomes main.js's
       * "Cannot use that right now", which says nothing about the two
       * conditions that actually produce it. The wording names the likelier -
       * a cell used on the concourse - and `_canApply` also refuses a full
       * shield, which the toast covers in its second clause. */
      case 'shield_cell':
        return {
          type: 'shipShield',
          amount: 110,
          refusal: {
            reason: 'no-shield',
            text: 'Board a ship and launch first — a cell charges a SHIP shield, and only one with room in it. Kept, not spent.',
          },
        };
      case 'nav_chart':
        /* Only two worlds publish viewpoints, so a chart carried anywhere else
         * - or one read after every district is already marked - is refused.
         * Without its own refusal that arrived as the generic "Cannot use that
         * right now", which does not tell a player whether the chart is broken,
         * spent, or simply in the wrong sky. */
        return {
          type: 'chart',
          refusal: {
            reason: 'nothing-to-chart',
            text: 'Nothing here left to chart — a chart marks a district you have not stood on, in a world that has them. Kept, not spent.',
          },
        };
      /* THE BAG EXPANSION RIGS. The only effect here that changes the
       * CONTAINER rather than what is in it.
       *
       * The three ids are listed explicitly and the SIZE is read off the item,
       * which is the whole shape of this case. Listing them means an id that
       * merely happens to grow a `bagSlots` field can never become a bag
       * expander by accident; reading `bagSlots` means the 5, the 10 and the 15
       * live in `ItemDefs` and only in `ItemDefs`, so a re-tune is one edit and
       * cannot leave the shop selling one number while the effect grants
       * another.
       *
       * `refusal` for the same reason `laser_cell` carries one: without it the
       * false from `_canApply` becomes main.js's "Cannot use that right now",
       * which is true, useless, and says nothing about the sixty-slot ceiling
       * the player has just hit. The reason code is its own (`bag-full`) so
       * that generic branch does not also fire and stack a second toast.
       *
       * Like `laser_cell`'s, the wording names the likeliest of the two
       * conditions `_canApply` folds together - at the cap, or an inventory
       * with no `expandBag` - and the second is unreachable in the shipped
       * game, where `ItemUse` is constructed with the real `Inventory`. */
      case 'bag_expand_5':
      case 'bag_expand_10':
      case 'bag_expand_15': {
        const slots = Math.floor(Number(itemDef(itemId)?.bagSlots) || 0);
        if (!(slots > 0)) return null;
        return {
          type: 'bagSlots',
          slots,
          refusal: {
            reason: 'bag-full',
            text: `Your bag already holds the maximum of ${BAG_CAPACITY_MAX} slots — kept, not spent.`,
          },
        };
      }
      /* LASER CELLS. Width, not ammunition.
       *
       * The ship gun is a capacitor and it stays one - `SpaceCombat.GUN`
       * recharges at 30 a second forever, and the reason is written over
       * `laser_cell` in `ItemDefs`: a dry gun 60 km from the yard is a walk
       * home. What a cell buys is thirty seconds during which the same trigger
       * pull lays down eight bolts across a fifty-metre arc instead of two
       * down one line, so a pass through a wing can touch more than one craft.
       * Two of the eight are the stock gun's own convergent pair, unmoved,
       * which is what makes the effect incapable of costing the player damage
       * on the craft already in their crosshair - see `FAN_BOLTS`.
       *
       * Thirty seconds because that is what every other timed thing in this
       * switch costs a player in duration (`speed`, `magnet`, `firepower`,
       * `portalPing`), and a new effect that quietly ran twice as long as its
       * neighbours would be a balance decision hidden in a constant.
       *
       * Seven bolts because `SpaceCombat.FAN_BOLTS` is where the arithmetic
       * that sizes the arc lives, and this is the one caller. Passed rather
       * than defaulted so the number a player actually gets is visible from
       * the item that grants it. */
      case 'laser_cell':
        return {
          type: 'gunSpread',
          duration: 30,
          bolts: 8,
          refusal: {
            reason: 'not-flying',
            text: 'Board a ship and launch first — a cell widens SHIP guns. Kept, not spent.',
          },
        };
      default:
        return null;
    }
  }

  /**
   * One ward rung, with the refusal chosen off live state.
   *
   * A helper rather than three copies of one object literal, for the reason
   * the medkit's refusal is picked inside `_effectFor` rather than being a
   * fixed string: the two ways a ward can be refused are not the same news,
   * and `_effectFor` is re-read on every use so this cannot go stale.
   *
   * THE DEAD CASE IS THE ONE THAT MATTERS, and it is the medkit's defect
   * exactly. A corpse can open the bag - `gameplayBlocked` skips
   * `player.fixedUpdate`, so the respawn tick does not run while a panel is up
   * - and `Player.respawn` ZEROES the ward. A ward used over your own body is
   * therefore not merely useless (`applyDamage` returns 0 while dead anyway),
   * it is guaranteed to be erased by the very next thing that happens to you.
   * That is the unit destroyed for nothing, with a receipt.
   *
   * `duration` defaults to the 30 s every graded effect in this switch runs
   * for, and is a PARAMETER only so `cryolite` can be shorter. A cracked flux
   * stone is not a cast charm and must not last as long as one; passing the
   * number is how that stays visible at the call site rather than becoming a
   * second helper that drifts from this one.
   *
   * @param {number} mul incoming damage multiplier, 0..1
   * @param {number} [duration] seconds of play time
   * @returns {{type:string, multiplier:number, duration:number, refusal:object}}
   */
  _wardEffect(mul, duration = 30) {
    return {
      type: 'ward',
      multiplier: mul,
      duration,
      refusal: this.player?.isDead
        ? {
          reason: 'dead',
          text: 'You are down — and getting back up wipes a ward, so this one would be gone before you could feel it. Kept, not spent.',
        }
        : {
          reason: 'no-ward',
          text: 'A ward cannot be fixed to you right now. Kept, not spent.',
        },
    };
  }

  /**
   * One draught rung, with the refusal chosen off live state.
   *
   * `_wardEffect` above in the mirror, and the dead case is the same argument
   * one step weaker: a corpse exerts nothing, so every second of the window
   * ticks away over a body that cannot spend a point of the pool it was bought
   * to protect. `Stamina.reset()` also refills the pool outright on respawn,
   * so what the player gets up with is a full bar and a draught that has
   * already spent part of itself on nothing.
   *
   * @param {number} scale what an exertion is multiplied by, 0..1
   * @param {number} duration seconds of play time
   * @returns {{type:string, scale:number, duration:number, refusal:object}}
   */
  _staminaEffect(scale, duration) {
    return {
      type: 'stamina',
      scale,
      duration,
      refusal: this.player?.isDead
        ? {
          reason: 'dead',
          text: 'You are down — a draught spends its whole minute on a body that is not exerting. Kept, not spent.',
        }
        : {
          reason: 'no-stamina',
          text: 'Your wind cannot be read right now. Kept, not spent.',
        },
    };
  }

  _canApply(effect, itemId) {
    switch (effect.type) {
      case 'heal':
        /* `!isDead` FIRST, and it is not redundant with the health test.
         *
         * A corpse has `_health = 0` (`Player._die`), so the health term alone
         * answers TRUE - and `_canApply` is asked BEFORE `consumeFromBag`, so
         * the kit was debited and only then did `Player.heal` refuse it with
         * `if (this._dead) return 0`, which made `_apply` return null and the
         * player read "That item has no use effect" about the one item in the
         * game whose whole job is healing.
         *
         * It is not a narrow window either: opening the panel raises
         * `gameplayBlocked`, which skips `player.fixedUpdate` entirely, so the
         * respawn tick never runs while the bag is open. A player could stand
         * over their own corpse and burn every medkit they owned, one
         * three-second hold at a time. */
        return !this.player.isDead && this.player.health < this.player.maxHealth;
      case 'speed':
        return typeof this.player.boostSpeed === 'function';
      case 'magnet':
        /* Covers the Vacuum Rune and the ferro-basalt lodestone alike: the
         * guard is on the SYSTEM, and it is asked before `consumeFromBag`, so
         * an unwired `Loot` refuses the use and leaves the rock in the bag
         * rather than eating it. */
        return typeof this.loot?.setMagnet === 'function';
      case 'portalPing':
        return Array.isArray(this.portals?.portals) && this.portals.portals.length > 0;
      case 'pauseNpcs':
        return typeof this.npcManager?.pauseFor === 'function';
      case 'shield':
        return typeof this.player.grantShield === 'function';
      case 'ward':
        /* `!isDead` FIRST, and it is load-bearing rather than defensive: this
         * is the only effect in the switch that a respawn actively DELETES
         * (`Player.respawn` sets `_wardUntil = 0`), so a ward applied to a
         * corpse is a unit spent on something the game is about to throw away
         * three seconds later. The probe half is the same guard every other
         * case makes - a Player old enough not to have `grantWard` cannot
         * vouch for the effect, so the charm stays in the bag. */
        return !this.player.isDead && typeof this.player.grantWard === 'function';
      case 'stamina':
        /* Same two questions, same order, and the same reasoning one step
         * weaker: a corpse exerts nothing, so every second of a draught used
         * over one is spent on nobody. @see _staminaEffect */
        return !this.player.isDead && typeof this.stamina?.setDrainScale === 'function';
      case 'firepower':
        return typeof this.combat?.boostPlayerDamage === 'function';
      case 'gunSpread':
        /* Asked BEFORE the consume, and this is the whole point of the item.
         *
         * The guard is `canWidenGuns()` and not a `typeof` probe because the
         * question is not "is the system wired" but "is there a gun in the
         * player's hands right now": `SpaceCombat._playable()` is false on
         * foot, mid-seam, landed, and in every world but `space`, and
         * `_playerGun` is gated on exactly the same predicate. A cell spent
         * standing on the concourse would buy thirty seconds of an effect on
         * a weapon that is nowhere near the player, and the recorded cost of
         * that is the unit destroyed for nothing - see `chart` below, which
         * is this same reasoning about a nav chart in a world with nothing
         * left to mark.
         *
         * Optional-chained, so an unwired or absent `SpaceCombat` answers
         * false and refuses the use rather than eating the cell. */
        return this.spaceCombat?.canWidenGuns?.() === true;
      case 'shipShield':
        /* The `gunSpread` guard directly above, asked of the other method, and
         * copied deliberately down to the `=== true` and the optional chain -
         * an unwired `SpaceCombat` must answer "no" and keep the cell, not
         * throw and not pass.
         *
         * `canChargeShield()` carries one term `canWidenGuns()` does not:
         * `shield < shieldMax`. A cell dumped into a full pool would be
         * consumed and absorb nothing, which is the unit-destroyed-for-nothing
         * failure this file keeps naming under `chart`; the check belongs in
         * `SpaceCombat` beside the pool it is about, and this asks it. */
        return this.spaceCombat?.canChargeShield?.() === true;
      case 'bagSlots':
        /* Asked BEFORE the consume, which is the whole reason a rig used at
         * the cap is KEPT rather than eaten - `use()` only reaches
         * `consumeFromBag` after this answers true.
         *
         * `<` and not `<=`: a bag at 59 given a +15 rig is NOT refused. It
         * gains the one slot that fits, the rig is consumed, and `_apply` says
         * so in the toast. Refusing a use that delivers real value would be
         * the mirror of the failure this file keeps naming - not a unit
         * destroyed for nothing, but a unit withheld for nothing - and a
         * player at 59/60 would be left holding an item the game will not let
         * them spend on the only thing it does.
         *
         * The `typeof` half is the same guard `magnet` and `chart` make: an
         * inventory without `expandBag` cannot vouch for the grant, so the rig
         * stays in the bag rather than being swallowed by an `_apply` that
         * would return null after the consume had already happened. */
        return typeof this.inventory?.expandBag === 'function'
          && this.inventory.bagCapacity < BAG_CAPACITY_MAX;
      case 'chart':
        /* Asked BEFORE the consume, and it asks two things: that the system
         * exists at all, and that there is something left in this world for a
         * chart to mark. Without the second half, reading a fourth chart in a
         * three-viewpoint world would destroy the unit and mark nothing - the
         * `_apply` default-return-null case, which the header calls out as
         * destroying the unit for nothing, arrived at by a different door. */
        return typeof this.viewpoints?.canChart === 'function' && this.viewpoints.canChart();
      default:
        return !!itemId;
    }
  }

  _apply(effect, itemId) {
    switch (effect.type) {
      case 'heal': {
        const healed = this.player.heal(effect.amount);
        if (!(healed > 0)) return null;
        this.bus?.emit('hud:notify', { text: 'Medkit used', tone: 'info' });
        return { amount: healed };
      }
      case 'speed':
        if (!this.player.boostSpeed(effect.multiplier, effect.duration)) return null;
        this.bus?.emit('hud:notify', {
          text: `Speed boost engaged — ${Math.round((effect.multiplier - 1) * 100)}% for ${effect.duration}s`,
          tone: 'info',
        });
        return { amount: effect.duration };
      case 'magnet':
        if (!this.loot.setMagnet(effect.duration, effect.range)) return null;
        /* `label` so the toast names the thing the player just used. A pilot
         * who clipped a rock to their belt and read "Loot magnet active" would
         * have no way to tell whether the rock did it or something else did. */
        this.bus?.emit('hud:notify', {
          text: effect.label
            ? `${effect.label} — loose salvage comes to you for ${effect.duration}s`
            : `Loot magnet active for ${effect.duration}s`,
          tone: 'info',
        });
        return { amount: effect.duration };
      case 'portalPing': {
        // Light the gateway up for real, and fall back to the local search only
        // where `PortalSystem` is old enough not to have `pingNearest` (tests
        // stub `portals` as a bare `{ portals: [...] }`). The toast stays: the
        // highlight tells you WHERE, the notification tells you WHICH.
        const portal = this.portals?.pingNearest?.(effect.duration) ?? this._nearestPortal();
        if (!portal) return null;
        const dest = portal.label || this._worldNameFor(portal.target) || portal.target || 'the Nexus';
        this.bus?.emit('hud:notify', { text: `Nearest portal: ${dest}`, tone: 'lore' });
        return { amount: effect.duration };
      }
      case 'pauseNpcs':
        if (!this.npcManager.pauseFor(effect.duration)) return null;
        this.bus?.emit('hud:notify', { text: `NPCs paused for ${effect.duration}s`, tone: 'info' });
        return { amount: effect.duration };
      case 'shield':
        if (!this.player.grantShield(effect.duration)) return null;
        this.bus?.emit('hud:notify', { text: `Shield active for ${effect.duration}s`, tone: 'info' });
        return { amount: effect.duration };
      case 'ward': {
        if (!this.player.grantWard(effect.multiplier, effect.duration)) return null;
        /* The RUNNING rate, not this item's rate. `grantWard` keeps the better
         * of the two when a second ward is fixed over a first, so a Bulwark
         * used under an Adamant leaves 50% off and not 20% - and a toast
         * quoting `effect.multiplier` would tell the player their protection
         * had just got worse at the exact moment it got longer. Reading it back
         * off the player is the same discipline the bag rigs use when they
         * report what `expandBag` actually added rather than what the rig
         * promised. */
        const cut = Math.round((1 - this.player.wardMultiplier) * 100);
        this.bus?.emit('hud:notify', {
          text: `Ward fixed — ${cut}% less damage taken for ${effect.duration}s`,
          tone: 'info',
        });
        return { amount: effect.duration, multiplier: this.player.wardMultiplier };
      }
      case 'stamina': {
        if (!this.stamina.setDrainScale(effect.scale, effect.duration)) return null;
        /* The running scale, for the reason the ward above reads the running
         * multiplier: a weak draught drunk under a strong one extends the
         * strong one, and a toast quoting this item's own number would be
         * announcing a downgrade that did not happen. */
        const scale = this.stamina.drainScale;
        const cut = Math.round((1 - scale) * 100);
        this.bus?.emit('hud:notify', {
          text: scale <= 0
            ? `Wellspring — nothing you do costs stamina for ${effect.duration}s`
            : `Draught taken — ${cut}% less stamina spent for ${effect.duration}s`,
          tone: 'info',
        });
        return { amount: effect.duration, scale };
      }
      case 'firepower':
        if (!this.combat.boostPlayerDamage(effect.multiplier, effect.duration)) return null;
        this.bus?.emit('hud:notify', {
          text: `Firepower boosted — ${Math.round((effect.multiplier - 1) * 100)}% for ${effect.duration}s`,
          tone: 'info',
        });
        return { amount: effect.duration };
      case 'gunSpread': {
        if (!this.spaceCombat.setGunSpread(effect.duration, effect.bolts)) return null;
        this.bus?.emit('hud:notify', {
          text: `Wide dispersal — ${effect.bolts} bolts across a widened arc for ${effect.duration}s`,
          tone: 'info',
        });
        return { amount: effect.duration, bolts: effect.bolts };
      }
      case 'shipShield': {
        /* THE PARTIAL CHARGE IS NOT A REFUSAL, and the number in the toast is
         * the return value rather than `effect.amount` - the bag rigs'
         * argument, in a ship. `chargeShield` clamps to what fits, so a pool
         * 30 points down takes 30 of the cell's 110 and the other 80 are gone.
         * Refusing that would be a unit WITHHELD for nothing (the pool will
         * never be further from full than it is now, if the player is winning),
         * and reporting 110 while the bar moves 30 would leave the player
         * asking which of the two is lying. Grant what fits, spend the cell,
         * and say the true number. */
        const put = this.spaceCombat.chargeShield(effect.amount);
        if (!(put > 0)) return null;
        const shield = Math.round(this.spaceCombat.shield);
        const max = Math.round(this.spaceCombat.shieldMax);
        this.bus?.emit('hud:notify', {
          text: `Shield recharged +${Math.round(put)} — ${shield} of ${max}`,
          tone: 'info',
        });
        return { amount: Math.round(put), shield, shieldMax: max };
      }
      case 'bagSlots': {
        /* THE PARTIAL GRANT IS THE INTERESTING CASE, AND IT IS NOT A REFUSAL.
         *
         * `expandBag` returns what it ACTUALLY added, which is less than the
         * rig promises whenever the bag was within the rig's size of the cap -
         * 55 slots given a +10 grows by 5. Three ways to handle that, and only
         * one of them is honest:
         *
         *   Refuse and keep the item. The player is then holding a +10 rig
         *   they can never use, because the bag will never be further from the
         *   cap than it is now. That is a unit withheld for nothing.
         *   Grant 5 and say "+10". The panel then shows 60 while the toast
         *   claims 65, and the player's next question is which one is lying.
         *   Grant 5, consume the rig, and SAY FIVE. This.
         *
         * So the number in the toast is the return value, never `effect.slots`,
         * and when the bag lands on the ceiling the message names the ceiling
         * rather than reporting a total that is about to stop moving. A player
         * who reads "your bag is now at its maximum of 60" knows not to buy a
         * fourth rig, which is the one thing they most need to be told here. */
        const added = this.inventory?.expandBag?.(effect.slots) ?? 0;
        if (!(added > 0)) return null;
        const capacity = this.inventory.bagCapacity;
        this.bus?.emit('hud:notify', {
          text: capacity >= BAG_CAPACITY_MAX
            ? `+${added} slots — your bag is now at its maximum of ${BAG_CAPACITY_MAX}.`
            : `+${added} slots — your bag now holds ${capacity}.`,
          tone: 'info',
        });
        return { amount: added, capacity };
      }
      case 'chart': {
        const marked = this.viewpoints.chartNearest();
        if (!marked) return null;
        this.bus?.emit('hud:notify', {
          text: `${marked.name} charted — that district is on your map, and you have still never stood on it`,
          tone: 'lore',
        });
        return { amount: 1, viewpointId: marked.id };
      }
      default:
        return null;
    }
  }

  _nearestPortal() {
    const portals = this.portals?.portals;
    const playerPos = this.player?.position;
    if (!Array.isArray(portals) || !playerPos) return null;
    let nearest = null;
    let nearestD2 = Infinity;
    for (const portal of portals) {
      if (!portal?.position) continue;
      const dx = portal.position.x - playerPos.x;
      const dy = portal.position.y - playerPos.y;
      const dz = portal.position.z - playerPos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearest = portal;
      }
    }
    return nearest;
  }

  _worldNameFor(worldId) {
    const world = this.portals?.worldManager?.getWorld?.(worldId);
    return world?.displayName ?? null;
  }
}
