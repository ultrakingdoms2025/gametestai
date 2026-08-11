import * as THREE from 'three';

const _sample = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
const _normal = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

export const DRAGON_RACE = {
  type: 'dragon',
  ringSpacing: 55,
  minRings: 10,
  maxRings: 18,
  flightHeight: 10,
  minFlight: 3,
  maxFlight: 25,
  ringRadius: 5.2,
};

function makeNumberTexture(n) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(3,8,16,0.72)';
  ctx.beginPath();
  ctx.roundRect(12, 22, 104, 84, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,228,132,0.95)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.font = '800 58px "Chakra Petch", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff4b8';
  ctx.shadowColor = 'rgba(255,180,74,0.9)';
  ctx.shadowBlur = 12;
  ctx.fillText(String(n), 64, 66);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildDragonRingCheckpoints(path) {
  if (!path?.valid) return [];
  const count = THREE.MathUtils.clamp(Math.round(path.length / DRAGON_RACE.ringSpacing), DRAGON_RACE.minRings, DRAGON_RACE.maxRings);
  const rings = [];
  for (let i = 0; i < count; i++) {
    path.sample(((i + 0.5) / count) * path.length, _sample);
    rings.push({
      x: _sample.x,
      y: _sample.y + DRAGON_RACE.flightHeight,
      z: _sample.z,
      radius: DRAGON_RACE.ringRadius,
      ring: true,
      index: i,
      number: i + 1,
      tx: _sample.tx,
      tz: _sample.tz,
      width: _sample.width,
    });
  }
  return rings;
}

export class RaceRings {
  constructor({ scene }) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'dragon-race-rings';
    this.scene?.add?.(this.root);
    this.rings = [];
    this._torusGeo = new THREE.TorusGeometry(DRAGON_RACE.ringRadius, 0.18, 10, 48);
    this._mat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9, toneMapped: false });
    this._nextMat = new THREE.MeshBasicMaterial({ color: 0x52e9ff, transparent: true, opacity: 1, toneMapped: false });
    this._passed = new Set();
  }

  setCheckpoints(cps) {
    this.clearMeshes();
    if (!Array.isArray(cps) || !cps.length) {
      this.root.visible = false;
      return;
    }
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      const group = new THREE.Group();
      group.name = `dragon-ring-${i + 1}`;
      group.position.set(cp.x, cp.y, cp.z);
      _dir.set(cp.tx ?? 0, 0, cp.tz ?? -1).normalize();
      if (_dir.lengthSq() < 0.5) _dir.set(0, 0, -1);
      _quat.setFromUnitVectors(_normal, _dir);
      group.quaternion.copy(_quat);

      const torus = new THREE.Mesh(this._torusGeo, i === 0 ? this._nextMat : this._mat);
      torus.renderOrder = 7;
      group.add(torus);

      const tex = makeNumberTexture(cp.number ?? i + 1);
      const labelMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
      const label = new THREE.Sprite(labelMat);
      label.position.set(0, DRAGON_RACE.ringRadius + 1.25, 0.1);
      label.scale.set(3.6, 3.6, 1);
      group.add(label);

      this.root.add(group);
      this.rings.push({ group, torus, label, texture: tex, labelMat, baseY: cp.y });
    }
    this._passed.clear();
    this.root.visible = true;
    this.setNext(0);
  }

  clearMeshes() {
    for (const r of this.rings) {
      r.group.removeFromParent();
      r.texture?.dispose?.();
      r.labelMat?.dispose?.();
    }
    this.rings.length = 0;
    this._passed.clear();
  }

  clear() {
    this.clearMeshes();
    this.root.visible = false;
  }

  resetLap() {
    this._passed.clear();
    for (const r of this.rings) r.group.visible = true;
    this.setNext(0);
  }

  pass(index, nextIndex) {
    const r = this.rings[index];
    if (r) {
      r.group.visible = false;
      this._passed.add(index);
    }
    if (nextIndex === 0) this.resetLap();
    else this.setNext(nextIndex);
  }

  setNext(index) {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.torus.material = i === index ? this._nextMat : this._mat;
      r.group.scale.setScalar(i === index ? 1.12 : 1);
    }
  }

  markers(nextIndex = 0) {
    const out = [];
    for (let i = 0; i < this.rings.length; i++) {
      if (this._passed.has(i)) continue;
      const g = this.rings[i].group;
      out.push({ type: 'ring', x: g.position.x, z: g.position.z, index: i, number: i + 1, next: i === nextIndex });
    }
    return out;
  }

  update(elapsed) {
    for (let i = 0; i < this.rings.length; i++) {
      const g = this.rings[i].group;
      g.position.y = this.rings[i].baseY + Math.sin(elapsed * 2.2 + i * 0.7) * 0.35;
    }
  }

  dispose() {
    this.clearMeshes();
    this._torusGeo.dispose();
    this._mat.dispose();
    this._nextMat.dispose();
    this.root.removeFromParent();
  }
}
