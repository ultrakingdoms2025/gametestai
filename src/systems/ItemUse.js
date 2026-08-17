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
  constructor({ bus, player, inventory, loot, portals, npcManager, combat, mounts, cosmetics } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.inventory = inventory ?? null;
    this.loot = loot ?? null;
    this.portals = portals ?? null;
    this.npcManager = npcManager ?? null;
    this.combat = combat ?? null;
    this.mounts = mounts ?? null;
    this.cosmetics = cosmetics ?? null;
  }

  use(itemId) {
    if (!this.inventory || !this.player || typeof itemId !== 'string' || !itemId) {
      return { ok: false, reason: 'unavailable' };
    }

    // Mount skins are not effects: they are consumed by applyMountSkin only on
    // a successful apply, so they must never reach the generic consume below.
    if (itemDef(itemId)?.kind === 'skin') return this._useSkin(itemId);

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
    const res = applyMountSkin({ mounts: this.mounts, cosmetics: this.cosmetics, inventory: this.inventory, bus: this.bus }, skinId);
    if (!res.ok) {
      const text = res.reason === 'not-mounted' || res.reason === 'wrong-mount'
        ? `Mount your ${skin.mount} and press F10 to apply this skin`
        : 'This skin cannot be applied right now';
      this.bus?.emit('hud:notify', { text, tone: 'warn' });
      return { ok: false, reason: res.reason };
    }
    this.bus?.emit('inventory:item-used', { itemId, effect: 'skin', amount: 1 });
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
        return typeof this.loot?.setMagnet === 'function';
      case 'portalPing':
        return Array.isArray(this.portals?.portals) && this.portals.portals.length > 0;
      case 'pauseNpcs':
        return typeof this.npcManager?.pauseFor === 'function';
      case 'shield':
        return typeof this.player.grantShield === 'function';
      case 'firepower':
        return typeof this.combat?.boostPlayerDamage === 'function';
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
        this.bus?.emit('hud:notify', { text: `Loot magnet active for ${effect.duration}s`, tone: 'info' });
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
