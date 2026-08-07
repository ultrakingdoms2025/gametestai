import * as THREE from 'three';
import { InteriorKit } from '../worlds/InteriorKit.js';
import { allows } from '../worlds/WorldRules.js';

/**
 * Interiors - runtime interaction, animation and collectible manager for the
 * building interiors built by InteriorKit.
 */
export class Interiors {
  constructor(ctx) {
    this.bus = ctx.bus;
    this.player = ctx.player;
    this.physics = ctx.physics;
    this.loot = ctx.loot;
    this.input = ctx.input;
    this.worldManager = ctx.worldManager;

    this._doors = [];
    this._lifts = [];
    this._spots = [];
    this._collected = new Set();

    this._promptText = null;
    this._worldId = null;
    this._autoBuilt = new Set();

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

    // Towers and tunnels are world geometry, not enterable interiors.
    if (!allows(world, 'interiors')) return;

    this._ensureRollout(id, world);

    const enterables = world?.enterables;
    if (!Array.isArray(enterables) || !enterables.length) return;

    for (const e of enterables) {
      for (const d of e.doors || []) {
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
      /* Spots are registered, not spawned.
       *
       * They used to be spawned here, all of them, the instant the world
       * changed. That was fine when the station had six crew rooms with one
       * collectible each; it stopped being fine the moment it grew four outer
       * zones and five enterable hab stacks, because `Loot`'s pool holds a few
       * dozen pickups and persistent ones are never recycled. Fill it with
       * authored collectibles and `_recycleOldest` starts returning null, at
       * which point no enemy anywhere in the game drops anything ever again.
       *
       * So they stream: `update` puts one in the world when the player is close
       * enough to see it and takes it away again when they leave. The set of
       * spots is authored and unbounded; the set of live pickups is small and
       * local. See `_streamSpots`.
       */
      const spots = e.collectibleSpots || [];
      for (let i = 0; i < spots.length; i++) {
        const s = spots[i];
        const tag = `interior:${id}:${e.label || 'bldg'}#${i}`;
        if (this._collected.has(tag)) continue;
        this._spots.push({ tag, position: s.position, tier: s.tier, pickup: null });
      }
    }
    this._streamT = 0;
  }

  /**
   * Bring authored collectibles in and out of the world around the player.
   *
   * `SPAWN_R` is comfortably past the distance a pickup's glow is legible, so
   * one never appears in front of somebody who was already looking at the spot.
   * The despawn radius is deliberately larger than the spawn radius: with a
   * single threshold, a player standing exactly on it makes the pickup flicker
   * in and out every tick.
   */
  _streamSpots(dt) {
    if (!this._spots.length) return;
    this._streamT -= dt;
    if (this._streamT > 0) return;
    this._streamT = 0.25;

    const p = this.player?.position;
    if (!p) return;
    const SPAWN_R2 = 46 * 46;
    const DESPAWN_R2 = 64 * 64;

    for (const s of this._spots) {
      if (this._collected.has(s.tag)) {
        if (s.pickup) { this.loot?.despawn?.(s.pickup); s.pickup = null; }
        continue;
      }
      const dx = p.x - s.position.x;
      const dy = p.y - s.position.y;
      const dz = p.z - s.position.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (!s.pickup && d2 < SPAWN_R2) {
        s.pickup = this.loot?.spawn?.(s.position, this._contentsFor(s.tier), {
          persistent: true,
          snap: false,
          tag: s.tag,
        }) ?? null;
      } else if (s.pickup && d2 > DESPAWN_R2) {
        // If it was collected while in range the tag is already in `_collected`
        // and the branch above handled it; this only ever retires a live one.
        this.loot?.despawn?.(s.pickup);
        s.pickup = null;
      }
    }
  }

  _ensureRollout(id, world) {
    if (!world || this._autoBuilt.has(id)) return;

    // Auto-rollout is opt-in only. Building generic shells at harvested
    // positions stacked geometry on top of existing solid buildings
    // (untextured boxes, clashing roofs, blocked doors, floating shells).
    // Worlds must author enterables explicitly (world.enterables) or set
    // world._autoInteriors = true after providing safe, open-ground
    // candidate positions.
    if (world._autoInteriors !== true) {
      this._autoBuilt.add(id);
      return;
    }

    if (!Array.isArray(world.enterables)) world.enterables = [];
    const seeded = world.enterables.length;

    const candidates = this._collectCandidates(id, world);
    if (!candidates.length) {
      this._autoBuilt.add(id);
      return;
    }

    const existing = world.enterables.map((e) => e?.origin).filter(Boolean);
    const slots = [];
    for (const c of candidates) {
      const p = new THREE.Vector3(c.x, c.y ?? 0, c.z);
      let collide = false;
      for (const o of existing) {
        if (Math.hypot(o.x - p.x, o.z - p.z) < 9.0) {
          collide = true;
          break;
        }
      }
      if (!collide) slots.push(c);
    }
    if (!slots.length) {
      this._autoBuilt.add(id);
      return;
    }

    const target = Math.max(1, Math.floor(slots.length * 0.7));
    const picked = this._pickStable(slots, target, id);
    for (let i = 0; i < picked.length; i++) {
      const c = picked[i];
      const baseY = this._baseY(world, c.x, c.z, c.y);
      const useTower = !!(c.hx >= 5.4 && c.hz >= 5.4 && i % 8 === 0);
      const kit = new InteriorKit(world, { name: `interior:auto:${id}:${i}` });
      if (useTower) {
        kit.buildTower({ x: c.x, z: c.z, baseY });
      } else {
        const intHalf = Math.max(2.8, Math.min(4.0, Math.min(c.hx, c.hz) - 0.6));
        kit.buildHouse({ x: c.x, z: c.z, baseY, intHalf });
      }
      kit.finish();
      const e = kit.exportDescriptors();
      e.origin = new THREE.Vector3(c.x, baseY, c.z);
      e.label = c.label || `Enterable ${i + 1}`;
      if (!useTower && e.collectibleSpots.length > 1) e.collectibleSpots = [e.collectibleSpots[0]];
      world.enterables.push(e);
    }

    this._autoBuilt.add(id);
    console.info(
      `[interiors] "${id}" rollout: ${world.enterables.length - seeded} auto enterables ` +
      `(from ${slots.length} candidates, 70% target ${target})`
    );
  }

  _baseY(world, x, z, hintY) {
    if (Number.isFinite(hintY)) return hintY + 0.06;
    if (typeof world._height === 'function') return world._height(x, z) + 0.06;
    if (typeof world._groundAt === 'function') return world._groundAt(x, z) + 0.06;
    return this.player?.position?.y ?? 1.0;
  }

  _collectCandidates(id, world) {
    const out = [];
    if (Array.isArray(world._interiorCandidates)) {
      for (const c of world._interiorCandidates) out.push(c);
    }
    if (Array.isArray(world._buildings)) {
      for (const b of world._buildings) {
        const hx = Math.max(2.8, Math.min(6.4, (b.w ?? 8) * 0.5 - 0.4));
        const hz = Math.max(2.8, Math.min(6.4, (b.d ?? 8) * 0.5 - 0.4));
        out.push({ x: b.x, z: b.z, y: b.y, hx, hz, label: 'City Building' });
      }
    }
    if (Array.isArray(world._roofs)) {
      for (const r of world._roofs) {
        const hx = Math.max(2.8, Math.min(6.4, (r.w ?? 8) * 0.5 - 0.4));
        const hz = Math.max(2.8, Math.min(6.4, (r.d ?? 8) * 0.5 - 0.4));
        out.push({ x: r.x, z: r.z, y: (r.y ?? 0) - 0.9, hx, hz, label: 'District Building' });
      }
    }
    if (!out.length) {
      for (const c of this._collectFromWorldMeshes(world)) out.push(c);
    }
    if (!out.length) {
      for (const c of this._fallbackCandidates(id)) out.push(c);
    }
    const filtered = out.filter(
      (c) => Number.isFinite(c.x) && Number.isFinite(c.z) && (c.hx ?? 0) >= 2.8 && (c.hz ?? 0) >= 2.8
    );
    return this._dedupeCandidates(filtered);
  }

  _collectFromWorldMeshes(world) {
    const out = [];
    const box = new THREE.Box3();
    const size = new THREE.Vector3();
    const ctr = new THREE.Vector3();
    world.group?.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.visible) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (!o.geometry.boundingBox) return;
      box.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      box.getSize(size);
      box.getCenter(ctr);
      if (size.x < 7 || size.z < 7 || size.y < 4) return;
      if (size.x > 36 || size.z > 36 || size.y > 45) return;
      if (ctr.y > 28) return;
      out.push({
        x: ctr.x,
        z: ctr.z,
        y: box.min.y,
        hx: Math.min(6.4, size.x * 0.45),
        hz: Math.min(6.4, size.z * 0.45),
        label: 'Structure',
      });
    });
    return out;
  }

  _fallbackCandidates(id) {
    if (id === 'station') {
      return [
        { x: -94, z: -20, y: 0.0, hx: 4.2, hz: 4.2, label: 'Hab Block' },
        { x: -78, z: -20, y: 0.0, hx: 4.2, hz: 4.2, label: 'Hab Block' },
        { x: -62, z: -20, y: 0.0, hx: 4.2, hz: 4.2, label: 'Hab Block' },
        { x: -46, z: -20, y: 0.0, hx: 4.2, hz: 4.2, label: 'Hab Block' },
        { x: 68, z: 118, y: 0.0, hx: 5.2, hz: 4.0, label: 'Hangar Annex' },
        { x: 82, z: 114, y: 0.0, hx: 5.2, hz: 4.0, label: 'Hangar Annex' },
        { x: 96, z: 110, y: 0.0, hx: 5.2, hz: 4.0, label: 'Hangar Annex' },
        { x: 30, z: -86, y: 0.0, hx: 4.0, hz: 4.0, label: 'Commercial Unit' },
        { x: 44, z: -84, y: 0.0, hx: 4.0, hz: 4.0, label: 'Commercial Unit' },
        { x: 58, z: -82, y: 0.0, hx: 4.0, hz: 4.0, label: 'Commercial Unit' },
      ];
    }
    if (id === 'sports') {
      return [
        { x: 6, z: 156, y: 0.0, hx: 4.4, hz: 4.4, label: 'Entrance Block' },
        { x: -8, z: 156, y: 0.0, hx: 4.4, hz: 4.4, label: 'Entrance Block' },
        { x: 22, z: 110, y: 0.0, hx: 4.6, hz: 4.0, label: 'Clubhouse Wing' },
        { x: 38, z: 110, y: 0.0, hx: 4.6, hz: 4.0, label: 'Clubhouse Wing' },
        { x: 54, z: 110, y: 0.0, hx: 4.6, hz: 4.0, label: 'Clubhouse Wing' },
        { x: 72, z: 6, y: 0.0, hx: 4.0, hz: 3.8, label: 'Track Service' },
        { x: 88, z: 8, y: 0.0, hx: 4.0, hz: 3.8, label: 'Track Service' },
        { x: 106, z: 10, y: 0.0, hx: 4.0, hz: 3.8, label: 'Track Service' },
        { x: -94, z: 76, y: 0.0, hx: 4.2, hz: 4.2, label: 'Marquee Unit' },
        { x: -82, z: 80, y: 0.0, hx: 4.2, hz: 4.2, label: 'Marquee Unit' },
      ];
    }
    return [];
  }

  _dedupeCandidates(list) {
    const grid = new Map();
    for (const c of list) {
      const key = `${Math.round(c.x / 8)}:${Math.round(c.z / 8)}`;
      const area = (c.hx ?? 0) * (c.hz ?? 0);
      const prev = grid.get(key);
      if (!prev || area > prev._area) {
        grid.set(key, { ...c, _area: area });
      }
    }
    return [...grid.values()].map(({ _area, ...c }) => c);
  }

  _pickStable(list, target, salt) {
    const scored = list.map((c) => ({
      c,
      k: this._hash(`${salt}:${Math.round(c.x * 10)}:${Math.round(c.z * 10)}`),
    }));
    scored.sort((a, b) => a.k - b.k);
    return scored.slice(0, target).map((x) => x.c);
  }

  _hash(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
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
    this._streamSpots(dt);
    if (!this._doors.length && !this._lifts.length) {
      if (this._promptText) this._setPrompt(null);
      return;
    }
    const p = this.player?.position;
    if (!p) return;

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
      /* Where the call point actually is.
       *
       * This used to be derived as `cx - half - 0.5`: the shaft's own -X face,
       * on the assumption that a lift is always axis-aligned and always entered
       * from that side. That holds for the medieval towers, which are built on
       * the world axes, and fails for anything rotated - the station's habitat
       * stacks stand on radiating avenues, so their shaft entrances face six
       * different bearings and the derived point lands inside a wall on five of
       * them. `InteriorKit` has always published `callPos`; nothing read it.
       */
      const ex = l.callPos ? l.callPos.x : f.cx - f.half - 0.5;
      const ez = l.callPos ? l.callPos.z : f.cz;
      const dx = p.x - ex;
      const dz = p.z - ez;
      const dist = Math.hypot(dx, dz);
      // Standing on the car counts as being at the panel: on a seven-storey
      // ride the player is inside it for ten seconds and has to be able to
      // choose the next floor without stepping off.
      const onCar =
        Math.abs(p.x - f.cx) < f.half + 0.3 &&
        Math.abs(p.z - f.cz) < f.half + 0.3 &&
        Math.abs(p.y - l.pos) < 1.6;
      const nearFloor = onCar || l.stops.some((sy) => Math.abs(p.y - sy) < 1.6);
      const reach = onCar ? 0 : dist;
      if (reach < 2.4 && nearFloor && reach < bestD) {
        bestD = reach;
        best = { kind: 'lift', ref: l };
      }
    }

    let prompt = null;
    if (best?.kind === 'door') {
      prompt = best.ref.open ? 'Close door' : 'Open door';
    } else if (best?.kind === 'lift') {
      const l = best.ref;
      const playerFloor = this._nearestStop(l, p.y);
      if (l.stopIndex !== l.target) {
        // Moving. Naming the floor it is heading for is the difference between
        // "something is happening" and a ten-second ride with no feedback.
        prompt = `Lift → floor ${l.target + 1} of ${l.stops.length}`;
      } else if (l.stopIndex !== playerFloor) {
        prompt = 'Call lift';
      } else {
        const next = (l.stopIndex + 1) % l.stops.length;
        prompt = next === 0 ? 'Ride lift to ground' : `Ride lift to floor ${next + 1}`;
      }
    }
    this._setPrompt(prompt);

    if (best && this.input?.pressed?.('KeyE')) {
      if (best.kind === 'door') best.ref.open = !best.ref.open;
      else this._callLift(best.ref, p.y);
    }

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
    if (l.stopIndex !== l.target) return;
    const playerFloor = this._nearestStop(l, playerY);
    if (l.stopIndex !== playerFloor) l.target = playerFloor;
    else l.target = (l.stopIndex + 1) % l.stops.length;
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
