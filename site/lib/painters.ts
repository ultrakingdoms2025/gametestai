/**
 * Every picture on this site, drawn in code.
 *
 * Not a flourish. The product's entire claim is that it generates its own art
 * at runtime, and a storefront illustrated with exported screenshots would be
 * arguing against the thing it is selling. It also means the site ships no
 * image files at all, so there is nothing to optimise, host or cache-bust.
 */

/** Deterministic PRNG, so a reload draws the same picture (re-exported for callers of this module). */
import { mulberry32 } from './sceneMath';
export { mulberry32 };

/** Size a canvas to its CSS box at device resolution. */
export function fit(cv: HTMLCanvasElement) {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.max(1, Math.round(r.width * dpr));
  cv.height = Math.max(1, Math.round(r.height * dpr));
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

export type Painter = (
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rnd: () => number
) => void;

/* ------------------------------------------------------------------ hero -- */

/**
 * The title backdrop: stars, a portal ring, and three ridge layers.
 *
 * The ridges use value noise summed at increasing frequency, drawn back to
 * front and desaturated toward the sky. That last part is aerial perspective,
 * and it is the cheapest way to make a flat canvas read as deep.
 */
export function paintHero(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
  animate: boolean
) {
  ctx.clearRect(0, 0, w, h);

  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#050b16');
  g.addColorStop(0.52, '#0a1728');
  g.addColorStop(1, '#04070d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  const rnd = mulberry32(0x51a7);
  for (let i = 0; i < 240; i++) {
    const x = rnd() * w;
    const y = rnd() * h * 0.68;
    const base = 0.18 + rnd() * 0.6;
    const tw = animate ? 0.75 + 0.25 * Math.sin(t * 0.0011 + i * 1.7) : 1;
    ctx.globalAlpha = base * tw;
    ctx.fillStyle = i % 9 === 0 ? '#9fe4ff' : '#dfeffb';
    const s = rnd() > 0.87 ? 2 : 1;
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;

  // The portal ring — the one shape this game is recognisable by. Off-centre,
  // so the title lockup is not fighting it.
  const rx = w * 0.78;
  const ry = h * 0.6;
  const rr = Math.min(w, h) * 0.17;
  const pulse = animate ? 0.9 + 0.1 * Math.sin(t * 0.0016) : 1;
  const halo = ctx.createRadialGradient(rx, ry, rr * 0.2, rx, ry, rr * 2.4);
  halo.addColorStop(0, `rgba(82,233,255,${(0.2 * pulse).toFixed(3)})`);
  halo.addColorStop(1, 'rgba(82,233,255,0)');
  ctx.fillStyle = halo;
  ctx.fillRect(rx - rr * 2.6, ry - rr * 2.6, rr * 5.2, rr * 5.2);
  ctx.strokeStyle = `rgba(120,240,255,${(0.85 * pulse).toFixed(3)})`;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(rx, ry, rr, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,176,58,0.9)';
  ctx.beginPath();
  ctx.arc(rx, ry, rr * 0.16, 0, Math.PI * 2);
  ctx.fill();

  const layers = [
    { y: 0.6, amp: 0.055, col: '#0d1d2e', freq: 2.1, seed: 11 },
    { y: 0.7, amp: 0.075, col: '#0a1523', freq: 3.0, seed: 29 },
    { y: 0.82, amp: 0.1, col: '#060d17', freq: 4.4, seed: 47 },
  ];
  for (const L of layers) {
    const r2 = mulberry32(L.seed);
    const n = 10;
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) pts.push(r2());
    ctx.fillStyle = L.col;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 3) {
      const u = (x / w) * L.freq;
      const i = Math.floor(u) % n;
      const f = u - Math.floor(u);
      const s = f * f * (3 - 2 * f);
      const nz = pts[i] + (pts[i + 1] - pts[i]) * s;
      ctx.lineTo(x, h * L.y + (nz - 0.5) * h * L.amp * 2);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  }
}

/* ---------------------------------------------------------------- worlds -- */

/**
 * One study per world, in a shared palette so the five read as a set taken by
 * the same instrument rather than as five unrelated pictures.
 */
export const painters: Record<string, Painter> = {
  station(ctx, w, h, rnd) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#050a14');
    g.addColorStop(1, '#0a1422');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 90; i++) {
      ctx.globalAlpha = 0.2 + rnd() * 0.6;
      ctx.fillStyle = '#dfeffb';
      ctx.fillRect(rnd() * w, rnd() * h, 1, 1);
    }
    ctx.globalAlpha = 1;
    const pg = ctx.createRadialGradient(w * 1.02, h * 1.28, h * 0.2, w * 1.02, h * 1.28, h * 1.05);
    pg.addColorStop(0, '#2b6b8f');
    pg.addColorStop(0.7, '#14364c');
    pg.addColorStop(1, '#07131e');
    ctx.fillStyle = pg;
    ctx.beginPath();
    ctx.arc(w * 1.02, h * 1.28, h, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8fa6b6';
    ctx.fillRect(w * 0.1, h * 0.44, w * 0.62, h * 0.055);
    ctx.fillStyle = '#c3d3de';
    for (let i = 0; i < 5; i++) ctx.fillRect(w * (0.16 + i * 0.12), h * 0.34, w * 0.032, h * 0.26);
    ctx.strokeStyle = 'rgba(82,233,255,0.75)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(w * 0.41, h * 0.47, h * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffcf6e';
    for (let i = 0; i < 26; i++) ctx.fillRect(w * (0.12 + rnd() * 0.58), h * (0.45 + rnd() * 0.04), 2, 2);
  },

  valley(ctx, w, h, rnd) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#16324a');
    g.addColorStop(0.6, '#1d4257');
    g.addColorStop(1, '#0c1a1a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const hills: Array<[string, number]> = [['#173a33', 0.6], ['#122d29', 0.72], ['#0c1f1d', 0.85]];
    for (const [col, base] of hills) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let x = 0; x <= w; x += 6) {
        ctx.lineTo(x, h * base - Math.sin((x / w) * 5 + base * 9) * h * 0.07 - rnd() * 2);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(60,140,170,0.5)';
    ctx.fillRect(0, h * 0.84, w, h * 0.16);
    ctx.fillStyle = '#2c3a44';
    ctx.fillRect(w * 0.42, h * 0.34, w * 0.17, h * 0.3);
    for (let i = 0; i < 3; i++) ctx.fillRect(w * (0.4 + i * 0.08), h * 0.26, w * 0.05, h * 0.38);
    ctx.fillStyle = '#ffb44a';
    for (let i = 0; i < 8; i++) ctx.fillRect(w * (0.42 + rnd() * 0.15), h * (0.38 + rnd() * 0.2), 2, 3);
    ctx.fillStyle = '#0a1a18';
    for (let i = 0; i < 16; i++) {
      const x = rnd() * w;
      const y = h * (0.68 + rnd() * 0.14);
      const s = 5 + rnd() * 7;
      ctx.beginPath();
      ctx.moveTo(x, y - s * 2);
      ctx.lineTo(x - s * 0.6, y);
      ctx.lineTo(x + s * 0.6, y);
      ctx.closePath();
      ctx.fill();
    }
  },

  sports(ctx, w, h, rnd) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#060d18');
    g.addColorStop(1, '#0d1a26');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (const fx of [0.14, 0.86]) {
      ctx.strokeStyle = '#5d6d79';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(w * fx, h * 0.9);
      ctx.lineTo(w * fx, h * 0.16);
      ctx.stroke();
      const lg = ctx.createRadialGradient(w * fx, h * 0.15, 2, w * fx, h * 0.15, h * 0.5);
      lg.addColorStop(0, 'rgba(220,245,255,0.55)');
      lg.addColorStop(1, 'rgba(220,245,255,0)');
      ctx.fillStyle = lg;
      ctx.fillRect(w * fx - h * 0.5, h * 0.15 - h * 0.5, h, h);
      ctx.fillStyle = '#e8f6ff';
      ctx.fillRect(w * fx - 9, h * 0.12, 18, 7);
    }
    ctx.strokeStyle = 'rgba(214,120,70,0.85)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.74, w * 0.3, h * 0.16, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.74, w * 0.26, h * 0.125, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(60,170,205,0.75)';
    ctx.fillRect(w * 0.38, h * 0.68, w * 0.24, h * 0.12);
    ctx.fillStyle = '#1a2632';
    ctx.fillRect(0, h * 0.44, w, h * 0.14);
    const crowd = ['#e2564b', '#4a8fd4', '#e8c451', '#63b86e'];
    ctx.globalAlpha = 0.75;
    for (let i = 0; i < 120; i++) {
      ctx.fillStyle = crowd[Math.floor(rnd() * 4)];
      ctx.fillRect(rnd() * w, h * (0.45 + rnd() * 0.12), 2, 3);
    }
    ctx.globalAlpha = 1;
  },

  citadel(ctx, w, h, rnd) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#20304a');
    g.addColorStop(0.45, '#6d5a52');
    g.addColorStop(1, '#3b2a22');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const sg = ctx.createRadialGradient(w * 0.2, h * 0.4, 2, w * 0.2, h * 0.4, h * 0.6);
    sg.addColorStop(0, 'rgba(255,196,110,0.8)');
    sg.addColorStop(1, 'rgba(255,196,110,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#4a3327';
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(0, h * 0.72);
    ctx.lineTo(w * 0.22, h * 0.62);
    ctx.lineTo(w * 0.78, h * 0.62);
    ctx.lineTo(w, h * 0.74);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    for (let i = 0; i < 26; i++) {
      const bw = w * (0.05 + rnd() * 0.05);
      const bh = h * (0.08 + rnd() * 0.16);
      const bx = w * (0.08 + rnd() * 0.82) - bw / 2;
      const by = h * 0.62 - bh;
      ctx.fillStyle = rnd() > 0.5 ? '#c2a184' : '#a88769';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(bx, by, bw * 0.28, bh);
    }
    ctx.fillStyle = '#d8bb99';
    ctx.fillRect(w * 0.55, h * 0.16, w * 0.07, h * 0.46);
    ctx.fillStyle = '#eddcc4';
    ctx.beginPath();
    ctx.moveTo(w * 0.545, h * 0.16);
    ctx.lineTo(w * 0.585, h * 0.05);
    ctx.lineTo(w * 0.625, h * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffb44a';
    for (let i = 0; i < 10; i++) ctx.fillRect(w * (0.56 + rnd() * 0.05), h * (0.22 + rnd() * 0.34), 2, 3);
  },

  maze(ctx, w, h, rnd) {
    // The Verdant Coil, seen from above: dark forest floor, hedge walls in the
    // world's #8fd67a green family, and one warm lantern somewhere in the lanes.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#07130c');
    g.addColorStop(0.55, '#0b2013');
    g.addColorStop(1, '#050e08');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Drifting spores catching the light — this world's stand-in for stars.
    for (let i = 0; i < 70; i++) {
      ctx.globalAlpha = 0.1 + rnd() * 0.32;
      ctx.fillStyle = i % 7 === 0 ? '#c9f0b4' : '#8fd67a';
      ctx.fillRect(rnd() * w, rnd() * h, 1, 1);
    }
    ctx.globalAlpha = 1;

    // The maze court, inset so the ring reads as a shape against the ground.
    const mx = w * 0.11;
    const my = h * 0.15;
    const mw = w - mx * 2;
    const mh = h - my * 2;
    const cols = 11;
    const rows = 7;
    const cw = mw / cols;
    const ch = mh / rows;
    const lw = Math.max(3, Math.min(cw, ch) * 0.34);

    /* A hedge is two strokes: a dark body and a thinner lit crown, so the walls
       read as volumes from above rather than as drawn lines. */
    const hedge = (x1: number, y1: number, x2: number, y2: number) => {
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#274f28';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.strokeStyle = '#6fb75c';
      ctx.lineWidth = Math.max(1, lw * 0.42);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };

    // Outer ring, with an entrance gap cut low on the near side.
    hedge(mx, my, mx + mw, my);
    hedge(mx, my, mx, my + mh);
    hedge(mx + mw, my, mx + mw, my + mh);
    hedge(mx, my + mh, mx + mw, my + mh);
    ctx.fillStyle = '#081409';
    ctx.fillRect(mx + mw * 0.44, my + mh - lw, mw * 0.12, lw * 2);

    /* Interior walls: one seeded coin per cell decides open lane, top-edge wall
       or left-edge wall — the binary-tree maze, which always yields connected
       corridors and costs one rnd() per cell, so seed → layout is stable. */
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const r = rnd();
        if (r < 0.34) continue; // open lane
        const x = mx + cx * cw;
        const y = my + cy * ch;
        if (r < 0.68) {
          if (cy > 0) hedge(x, y, x + cw, y); // wall along the cell's top edge
        } else if (cx > 0) {
          hedge(x, y, x, y + ch); // wall along the cell's left edge
        }
      }
    }

    // Soft green mist pooling over the lanes.
    const mist = ctx.createRadialGradient(
      w * 0.5, h * 0.56, Math.min(w, h) * 0.08,
      w * 0.5, h * 0.56, Math.max(w, h) * 0.72
    );
    mist.addColorStop(0, 'rgba(143,214,122,0.17)');
    mist.addColorStop(0.6, 'rgba(143,214,122,0.06)');
    mist.addColorStop(1, 'rgba(143,214,122,0)');
    ctx.fillStyle = mist;
    ctx.fillRect(0, 0, w, h);

    // The Keeper's lantern: one warm point in a lane, over the mist.
    const lx = mx + (1.5 + Math.floor(rnd() * (cols - 3))) * cw;
    const ly = my + (1.5 + Math.floor(rnd() * (rows - 3))) * ch;
    const lr = Math.min(cw, ch) * 2.3;
    const lg = ctx.createRadialGradient(lx, ly, 1, lx, ly, lr);
    lg.addColorStop(0, 'rgba(255,207,110,0.8)');
    lg.addColorStop(0.32, 'rgba(255,176,58,0.22)');
    lg.addColorStop(1, 'rgba(255,176,58,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(lx - lr, ly - lr, lr * 2, lr * 2);
    ctx.fillStyle = '#ffcf6e';
    ctx.fillRect(lx - 1.5, ly - 1.5, 3, 3);
  },

  circuit(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#8fb8d4');
    g.addColorStop(0.5, '#6d96b4');
    g.addColorStop(1, '#3f5a4a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#4a6a52';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) ctx.lineTo(x, h * 0.52 - Math.sin((x / w) * 4.2) * h * 0.09);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#3a5742';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 6) ctx.lineTo(x, h * 0.64 - Math.sin((x / w) * 6 + 2) * h * 0.06);
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();

    /* The ribbon: a track receding to a vanishing point, as a series of quads
       that narrow with distance. One tapered polygon would be flat; per-segment
       lets the kerbs alternate down the length. */
    const vpX = w * 0.56;
    const vpY = h * 0.55;
    const segs = 16;
    const edge = (t: number) => {
      const y = vpY + (h - vpY) * (t * t);
      const half = w * 0.02 + w * 0.46 * (t * t);
      const cx = vpX + Math.sin(t * 2.6) * w * 0.1 * (1 - t);
      return { y, half, cx };
    };
    for (let i = 0; i < segs; i++) {
      const a = edge(i / segs);
      const b = edge((i + 1) / segs);
      ctx.fillStyle = '#2b3238';
      ctx.beginPath();
      ctx.moveTo(a.cx - a.half, a.y);
      ctx.lineTo(a.cx + a.half, a.y);
      ctx.lineTo(b.cx + b.half, b.y);
      ctx.lineTo(b.cx - b.half, b.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = i % 2 ? '#e8e8e6' : '#d0453a';
      const kw = Math.max(1.5, a.half * 0.09);
      ctx.beginPath();
      ctx.moveTo(a.cx - a.half, a.y);
      ctx.lineTo(a.cx - a.half + kw, a.y);
      ctx.lineTo(b.cx - b.half + kw, b.y);
      ctx.lineTo(b.cx - b.half, b.y);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(a.cx + a.half, a.y);
      ctx.lineTo(a.cx + a.half - kw, a.y);
      ctx.lineTo(b.cx + b.half - kw, b.y);
      ctx.lineTo(b.cx + b.half, b.y);
      ctx.closePath();
      ctx.fill();
    }

    // Start gantry, four of five columns lit — the tensest frame of the start.
    ctx.fillStyle = '#25406b';
    ctx.fillRect(vpX - w * 0.16, vpY - h * 0.1, w * 0.32, h * 0.028);
    ctx.fillRect(vpX - w * 0.16, vpY - h * 0.1, w * 0.014, h * 0.13);
    ctx.fillRect(vpX + w * 0.146, vpY - h * 0.1, w * 0.014, h * 0.13);
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i < 4 ? '#ff2f14' : '#3a1410';
      ctx.fillRect(vpX - w * 0.07 + i * w * 0.033, vpY - h * 0.094, w * 0.018, h * 0.016);
    }
    const cars: Array<[number, number, number, string]> = [
      [vpX - w * 0.05, h * 0.82, w * 0.09, '#1b2f5e'],
      [vpX + w * 0.1, h * 0.7, w * 0.06, '#c2472f'],
    ];
    for (const [cx, cy, cw, col] of cars) {
      ctx.fillStyle = col;
      ctx.fillRect(cx - cw / 2, cy, cw, cw * 0.42);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(cx - cw * 0.3, cy + cw * 0.06, cw * 0.6, cw * 0.16);
    }
  },

  /**
   * Lodestar Yard, looking down the keel line from the apron.
   *
   * The framing is the world's own opening shot: `arrivalFor` stands a player
   * at z 49.4 facing the blast door, with the berths staggered either side and
   * the crane bridge overhead. So the plate is one-point perspective on the
   * keel line, a hull on a cradle each side, the gantry across at eight metres
   * and the countdown board over the door at the vanishing point.
   *
   * Sodium over cyan, which is the world's own lighting rule: the worklights
   * are warm and the wayfinding is cold, and that inversion is what stops the
   * yard reading as another station concourse.
   */
  yard(ctx, w, h, rnd) {
    const vpX = w * 0.5;
    const vpY = h * 0.52;

    // Shed interior: cold at the roof, warmer down at the deck where the
    // worklights are, and never black - the yard has a roof over it.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b1119');
    g.addColorStop(0.55, '#141c26');
    g.addColorStop(1, '#20242a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Roof trusses, converging.
    ctx.strokeStyle = 'rgba(120,140,160,0.30)';
    ctx.lineWidth = Math.max(1, w * 0.0022);
    for (let i = 0; i < 7; i++) {
      const y = h * (0.04 + i * 0.028);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(vpX, vpY - h * 0.16);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Deck: the keel line and the setting-out grid running to the door.
    ctx.strokeStyle = 'rgba(147,163,180,0.22)';
    ctx.lineWidth = Math.max(1, w * 0.0016);
    for (let i = -6; i <= 6; i++) {
      ctx.beginPath();
      ctx.moveTo(vpX + i * w * 0.17, h);
      ctx.lineTo(vpX + i * w * 0.012, vpY);
      ctx.stroke();
    }
    for (let i = 1; i < 7; i++) {
      const t = i / 7;
      const y = vpY + (h - vpY) * t * t;
      ctx.globalAlpha = 0.5 - t * 0.3;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // The keel line itself - chalk with a brass inlay either side.
    ctx.fillStyle = 'rgba(127,216,239,0.14)';
    ctx.beginPath();
    ctx.moveTo(vpX - w * 0.115, h);
    ctx.lineTo(vpX - w * 0.008, vpY);
    ctx.lineTo(vpX + w * 0.008, vpY);
    ctx.lineTo(vpX + w * 0.115, h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(127,216,239,0.55)';
    ctx.lineWidth = Math.max(1, w * 0.0018);
    for (const s2 of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(vpX + s2 * w * 0.108, h);
      ctx.lineTo(vpX + s2 * w * 0.0075, vpY);
      ctx.stroke();
    }

    // Two hulls on cradles, staggered so neither occludes the other.
    const hull = (cx: number, cy: number, len: number, tint: string, trim: string) => {
      const bh = len * 0.30;
      ctx.fillStyle = tint;
      ctx.beginPath();
      ctx.moveTo(cx - len / 2, cy);
      ctx.lineTo(cx - len * 0.28, cy - bh);
      ctx.lineTo(cx + len * 0.34, cy - bh * 0.92);
      ctx.lineTo(cx + len / 2, cy - bh * 0.35);
      ctx.lineTo(cx + len * 0.42, cy + bh * 0.22);
      ctx.lineTo(cx - len * 0.4, cy + bh * 0.2);
      ctx.closePath();
      ctx.fill();
      // The bolted string course at the section joint - the yard's one motif.
      ctx.fillStyle = trim;
      ctx.fillRect(cx - len * 0.42, cy - bh * 0.30, len * 0.82, bh * 0.10);
      // Cradle.
      ctx.fillStyle = '#2b3138';
      ctx.fillRect(cx - len * 0.34, cy + bh * 0.18, len * 0.09, bh * 0.55);
      ctx.fillRect(cx + len * 0.22, cy + bh * 0.18, len * 0.09, bh * 0.55);
      // Canopy.
      ctx.fillStyle = 'rgba(90,150,175,0.75)';
      ctx.fillRect(cx + len * 0.30, cy - bh * 0.72, len * 0.14, bh * 0.30);
    };
    hull(w * 0.24, h * 0.80, w * 0.40, '#8d97a4', '#c9a13c');
    hull(w * 0.79, h * 0.70, w * 0.30, '#6f7d8c', '#c23a2f');

    // The gantry at eight metres, and the crane bridge above it.
    ctx.fillStyle = '#39424c';
    ctx.fillRect(0, vpY + h * 0.06, w, h * 0.017);
    ctx.fillStyle = '#2a323a';
    ctx.fillRect(0, vpY - h * 0.10, w, h * 0.022);
    ctx.strokeStyle = 'rgba(160,180,200,0.45)';
    ctx.lineWidth = Math.max(1, w * 0.0015);
    ctx.beginPath();
    ctx.moveTo(0, vpY + h * 0.035);
    ctx.lineTo(w, vpY + h * 0.035);
    ctx.stroke();

    // Sodium worklights hung high, warm against the cold wayfinding.
    for (let i = 0; i < 5; i++) {
      const lx = w * (0.1 + i * 0.2);
      const ly = vpY - h * 0.14;
      const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, w * 0.11);
      lg.addColorStop(0, 'rgba(255,186,92,0.55)');
      lg.addColorStop(1, 'rgba(255,186,92,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.arc(lx, ly, w * 0.11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffcf86';
      ctx.fillRect(lx - w * 0.012, ly - h * 0.006, w * 0.024, h * 0.012);
    }

    // The blast door, and the board over it that has never moved.
    ctx.fillStyle = '#171d25';
    ctx.fillRect(vpX - w * 0.085, vpY - h * 0.055, w * 0.17, h * 0.115);
    ctx.strokeStyle = 'rgba(255,160,64,0.7)';
    ctx.lineWidth = Math.max(1, w * 0.002);
    ctx.strokeRect(vpX - w * 0.085, vpY - h * 0.055, w * 0.17, h * 0.115);
    ctx.fillStyle = '#0a0f16';
    ctx.fillRect(vpX - w * 0.062, vpY - h * 0.088, w * 0.124, h * 0.028);
    ctx.fillStyle = '#ff4b45';
    ctx.font = `${Math.round(h * 0.021)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('LAUNCHES: 000', vpX, vpY - h * 0.074);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    // Dust in the light shafts. Seeded, so the plate is the same every load.
    ctx.fillStyle = 'rgba(255,214,160,0.5)';
    for (let i = 0; i < 70; i++) {
      ctx.globalAlpha = 0.06 + rnd() * 0.18;
      ctx.fillRect(rnd() * w, vpY - h * 0.2 + rnd() * h * 0.55, 1, 1);
    }
    ctx.globalAlpha = 1;
  },
};

/** A cool grade and a bottom fade, applied to every world plate. */
export function grade(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = 'rgba(6,14,24,0.24)';
  ctx.fillRect(0, 0, w, h);
  const fade = ctx.createLinearGradient(0, h * 0.55, 0, h);
  fade.addColorStop(0, 'rgba(8,13,23,0)');
  fade.addColorStop(1, 'rgba(8,13,23,0.85)');
  ctx.fillStyle = fade;
  ctx.fillRect(0, h * 0.55, w, h * 0.45);
}
