import { itemDef, mountPowerFromItem, skinIdFromItem } from './ItemDefs.js';
import { applyMountSkin } from './MountSkins.js';
import { MOUNT_SKINS_BY_ID } from './Cosmetics.js';

/**
 * Inventory item use dispatcher.
 *
 * Bag items are ordinary inventory rows, so the use path has to do three jobs:
 * 1. validate that the item is actually supported,
 * 2. consume one unit from the bag, and
 * 3. apply the effect through the owning gameplay systems.
 */

export class ItemUseSystem {
  constructor({
    bus, player, inventory, loot, portals, npcManager, combat, mounts, cosmetics, viewpoints, effects,
    spaceCombat,
  } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.inventory = inventory ?? null;
    this.loot = loot ?? null;
    this.portals = portals ?? null;
    this.npcManager = npcManager ?? null;
    this.combat = combat ?? null;
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
      this.bus?.emit('hud:notify', {
        text: `Your ${grant.mount} already runs this fitting at tier ${owned} — kept, not spent`,
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
        return { type: 'heal', amount: 50 };
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
      case 'nav_chart':
        return { type: 'chart' };
      /* LASER CELLS. Width, not ammunition.
       *
       * The ship gun is a capacitor and it stays one - `SpaceCombat.GUN`
       * recharges at 30 a second forever, and the reason is written over
       * `laser_cell` in `ItemDefs`: a dry gun 60 km from the yard is a walk
       * home. What a cell buys is thirty seconds during which the same trigger
       * pull lays down seven bolts across a fifty-metre arc instead of two
       * down one line, so a pass through a wing can touch more than one craft.
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
          bolts: 7,
          refusal: {
            reason: 'not-flying',
            text: 'Board a ship and launch first — a cell widens SHIP guns. Kept, not spent.',
          },
        };
      default:
        return null;
    }
  }

  _canApply(effect, itemId) {
    switch (effect.type) {
      case 'heal':
        return this.player.health < this.player.maxHealth;
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
