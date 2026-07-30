/**
 * Inventory item use dispatcher.
 *
 * Right now this is intentionally small: it gives the marketplace-backed
 * consumables a real in-game effect and leaves a clean bus hook for the more
 * ambitious powerup items that will come later.
 */

export class ItemUseSystem {
  constructor({ bus, player, inventory } = {}) {
    this.bus = bus ?? null;
    this.player = player ?? null;
    this.inventory = inventory ?? null;
  }

  use(itemId) {
    if (!this.inventory || !this.player || typeof itemId !== 'string' || !itemId) {
      return { ok: false, reason: 'unavailable' };
    }

    if (itemId === 'medkit') {
      if (this.player.health >= this.player.maxHealth) {
        return { ok: false, reason: 'full' };
      }
      if (!this.inventory.consumeFromBag('medkit', 1)) {
        return { ok: false, reason: 'missing' };
      }
      const healed = this.player.heal(50);
      if (healed <= 0) return { ok: false, reason: 'full' };
      this.bus?.emit('inventory:item-used', { itemId, effect: 'restore_health', amount: healed });
      this.bus?.emit('hud:notify', { text: 'Medkit used', tone: 'info' });
      return { ok: true, amount: healed };
    }

    return { ok: false, reason: 'unsupported' };
  }
}
