import { itemDef, skinIdFromItem } from './ItemDefs.js';
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
  constructor({ bus, player, inventory, loot, portals, npcManager, combat, mounts, cosmetics, viewpoints } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.inventory = inventory ?? null;
    this.loot = loot ?? null;
    this.portals = portals ?? null;
    this.npcManager = npcManager ?? null;
    this.combat = combat ?? null;
    this.mounts = mounts ?? null;
    this.cosmetics = cosmetics ?? null;
    /* Lodestar Yard's `nav_chart`. Optional like every other collaborator
     * here: a missing system makes `_canApply` answer false, which refuses the
     * use BEFORE `consumeFromBag` at `use()`, so an unwired chart is a chart
     * you still have. */
    this.viewpoints = viewpoints ?? null;
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

    if (!this.player) return { ok: false, reason: 'unavailable' };

    const effect = this._effectFor(itemId);
    if (!effect) return { ok: false, reason: 'unsupported' };
    if (!this._canApply(effect, itemId)) return { ok: false, reason: 'unavailable' };
    if (!this.inventory.consumeFromBag(itemId, 1)) return { ok: false, reason: 'missing' };

    const applied = this._apply(effect, itemId);
    if (!applied) return { ok: false, reason: 'unsupported' };

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
