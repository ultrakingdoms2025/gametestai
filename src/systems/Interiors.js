import * as THREE from 'three';

/**
 * Interiors - runtime interaction, animation and collectible manager for the
 * building interiors built by InteriorKit.
 *
 * Responsibilities:
 *   - On `world:changed`, read `world.enterables` (descriptors produced by
 *     InteriorKit), reset doors to closed and lifts to the ground stop, and
 *     spawn hidden collectibles for any spot not already collected this session.
 *   - Per frame, find the nearest interactable (door / lift entrance) to the
 *     player, publish an `interior:prompt` for the HUD, and act on the interact
 *     key: toggle a door (flip its blocker collider `.solid` + swing the leaves)
 *     or call/ride a lift (a Y-only moving floor collider via
 *     `physics.setBoxColliderY`, with the car visual carried alongside).
 *
 * All animated nodes live under the world's statically-baked group, so their
 * matrices are refreshed manually while they move.
 */
export class Interiors {
  constructor(ctx) {
    this.bus = ctx.bus;
    this.player = ctx.player;
    this.physics = ctx.physics;
    this.loot = ctx.loot;
    this.input = ctx.input;
    this.worldManager = ctx.worldManager;

    /** @type {Array<object>} descriptors for the active world */
    this._doors = [];
    this._lifts = [];
    this._spots = [];
    /** tags collected this session so re-entry does not respawn them */
    this._collected = new Set();

    this._promptText = null;
    this._worldId = null;

    this._offs = [];
    this._offs.push(this.bus.on('world:changed', ({ id, world }) => this._onWorld(id, world)));
    this._offs.push(
      this.bus.on('loot:collected', ({ pickup }) => {
        const tag = pickup?.tag;
        if (typeof tag === 'string' && tag.startsWith('interior:')) this._collected.add(tag);
      })
    );
  }

  /* ------------------------------------------------------------------ */
  _onWorld(id, world) {
    this._worldId = id;
    this._doors = [];
    this._lifts = [];
    this._spots = [];
    this._setPrompt(null);

    const enterables = world?.enterables;
    if (!Array.isArray(enterables) || !enterables.length) return;

    for (const e of enterables) {
      for (const d of e.doors || []) {
        // Reset to closed.
        d.open = false;
        d.anim = 0;
        if (d.collider) d.collider.solid = true;
        for (const leaf of d.leaves) {
          leaf.pivot.rotation.y = leaf.closed;
          leaf.pivot.updateMatrixWorld(true);
        }
        this._doors.push(d);
      }
      for (const l of e.lifts || []) {
        l.stopIndex = 0;
        l.target = 0;
        l.pos = l.stops[0];
        if (l.collider) this.physics.setBoxColliderY(l.collider, l.pos - l.plateThick / 2);
        l.car.position.y = l.pos;
        l.car.updateMatrixWorld(true);
        this._lifts.push(l);
      }
      // Spawn uncollected collectibles.
      const spots = e.collectibleSpots || [];
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        const tag = `interior:${id}:${e.label || 'bldg'}#${i}`;
        if (this._collected.has(tag)) continue;
        const contents = this._contentsFor(s.tier);
        const pickup = this.loot?.spawn?.(s.position, contents, {
          persistent: true,
          snap: false,
          tag,
        });
        if (pickup) this._spots.push({ tag, pickup });
      }
    }
  }

  _contentsFor(tier) {
    if (tier === 'prize') {
      return [
        { itemId: 'relic_coin', qty: 3 },
        { itemId: 'shield_5s', qty: 1 },
      ];
    }
    if (tier === 'rare') {
      return [
        { itemId: 'relic_coin', qty: 1 },
        { itemId: 'medkit', qty: 1 },
      ];
    }
    return [{ itemId: 'relic_coin', qty: 1 }];
  }

  /* ------------------------------------------------------------------ */
  update(dt) {
    if (!this._doors.length && !this._lifts.length) {
      if (this._promptText) this._setPrompt(null);
      return;
    }
    const p = this.player?.position;
    if (!p) return;

    // --- Find the nearest interactable within reach ---
    let best = null;
    let bestD = Infinity;

    for (const d of this._doors) {
      const dp = d.position;
      const dx = p.x - dp.x;
      const dz = p.z - dp.z;
      const dy = p.y - dp.y;
      if (Math.abs(dy) > 2.6) continue;
      const dist = Math.hypot(dx, dz);
      if (dist < 3.0 && dist < bestD) {
        bestD = dist;
        best = { kind: 'door', ref: d };
      }
    }

    for (const l of this._lifts) {
      const f = l.footprint;
      // Entrance sits just outside the -X face of the shaft.
      const ex = f.cx - f.half - 0.5;
      const dx = p.x - ex;
      const dz = p.z - f.cz;
      const dist = Math.hypot(dx, dz);
      // Reachable from any floor level near the shaft entrance.
      const nearFloor = l.stops.some((sy) => Math.abs(p.y - sy) < 1.6);
      if (dist < 2.4 && nearFloor && dist < bestD) {
        bestD = dist;
        best = { kind: 'lift', ref: l };
      }
    }

    // --- Prompt + interact ---
    let prompt = null;
    if (best?.kind === 'door') {
      prompt = best.ref.open ? 'Close door' : 'Open door';
    } else if (best?.kind === 'lift') {
      const l = best.ref;
      const playerFloor = this._nearestStop(l, p.y);
      prompt = l.stopIndex === playerFloor ? 'Ride lift up' : 'Call lift';
    }
    this._setPrompt(prompt);

    if (best && this.input?.pressed?.('KeyE')) {
      if (best.kind === 'door') {
        best.ref.open = !best.ref.open;
      } else {
        this._callLift(best.ref, p.y);
      }
    }

    // --- Animate doors ---
    for (const d of this._doors) {
      const target = d.open ? 1 : 0;
      if (d.anim !== target) {
        const step = dt * 3.2;
        d.anim = target > d.anim ? Math.min(target, d.anim + step) : Math.max(target, d.anim - step);
        for (const leaf of d.leaves) {
          leaf.pivot.rotation.y = leaf.closed + (leaf.open - leaf.closed) * d.anim;
          leaf.pivot.updateMatrixWorld(true);
        }
      }
      if (d.collider) d.collider.solid = !d.open && d.anim < 0.05;
    }

    // --- Animate lifts ---
    for (const l of this._lifts) {
      const goal = l.stops[l.target];
      if (Math.abs(l.pos - goal) > 0.005) {
        const step = dt * l.speed;
        l.pos = goal > l.pos ? Math.min(goal, l.pos + step) : Math.max(goal, l.pos - step);
        this.physics.setBoxColliderY(l.collider, l.pos - l.plateThick / 2);
        l.car.position.y = l.pos;
        l.car.updateMatrixWorld(true);
      } else if (l.stopIndex !== l.target) {
        l.pos = goal;
        l.stopIndex = l.target;
        this.physics.setBoxColliderY(l.collider, l.pos - l.plateThick / 2);
        l.car.position.y = l.pos;
        l.car.updateMatrixWorld(true);
      }
    }
  }

  _nearestStop(l, y) {
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < l.stops.length; i++) {
      const d = Math.abs(l.stops[i] - y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  _callLift(l, playerY) {
    // Ignore new calls mid-travel.
    if (l.stopIndex !== l.target) return;
    const playerFloor = this._nearestStop(l, playerY);
    if (l.stopIndex !== playerFloor) {
      l.target = playerFloor; // bring the car to the player
    } else {
      l.target = (l.stopIndex + 1) % l.stops.length; // ride up, wrap to ground
    }
  }

  _setPrompt(text) {
    if (text === this._promptText) return;
    this._promptText = text;
    this.bus.emit('interior:prompt', { text });
  }

  dispose() {
    for (const off of this._offs) {
      try {
        off();
      } catch {
        /* handlers already gone */
      }
    }
    this._offs.length = 0;
  }
}
