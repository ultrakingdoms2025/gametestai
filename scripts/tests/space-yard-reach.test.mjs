import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * CAN THE PLAYER WALK TO A BERTH? THE YARD EXTERIOR, FLOODED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DEFECT THIS FILE EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every pier and all four berths were unreachable on foot, and the suite was
 * green.
 *
 * `DockExterior._buildApron` laid the cross-walk's two guard rails across its
 * Z ENDS - a full 224 m rail at z −84 and another at z −98. Those are not
 * edges. They are the two JUNCTIONS: z −84 is the seam with the apron the
 * player spawns on, and z −98 is where all four piers attach. The cross-walk's
 * real fall edges, x = ±112, had no rail at all. The rails were exactly
 * inverted, and the shape of the yard - four berths on 150 m piers, the reason
 * the station reads as a shipyard - was walled off from the only deck a player
 * ever stands on.
 *
 * Measured over the real colliders before the fix, flooding from the arrival
 * spawn on a 0.5 m lattice:
 *
 *   movement rule                        rise    cross-walk   the four berths
 *   walk (CONFIG.player.stepHeight 0.45) 0.45    unreachable  unreachable
 *   walk + jump (apex 0.93 m)            0.93    unreachable  unreachable
 *   walk + jump + mantle                 2.40    reached      reached
 *
 * The rail is 1.15 m tall. A jump apex is 6.4²/(2·22) = 0.93 m. Only
 * `Climb.js`'s mantle (`MIN_RISE_GROUND` 1.0 ≤ 1.15 ≤ `MAX_RISE` 2.4) cleared
 * it, and nothing in the game teaches that verb - the boot card and F1 both
 * describe Space-at-a-wall, not a 1.15 m step.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY THE OLD TEST DID NOT CATCH IT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `space-yard-exterior.test.mjs` asserted:
 *
 *     assert.ok(host.boxes.length >= 4 * 4,
 *       `only ${host.boxes.length} colliders - the piers are not solid`);
 *     // Collided, so a player standing on a pier is standing on something.
 *
 * That proves a pier holds you up. It has nothing to say about whether you can
 * get onto one, and it counted the very rails that made it impossible. Content
 * BUILT and never REACHED, and the instrument was a collider count.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE INSTRUMENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A flood fill over the colliders a real `DockExterior` build registers -
 * every one of them, taken out of the host it was handed, not a re-derivation
 * of where they ought to be.
 *
 * The exterior emits only axis-aligned boxes (`_box` and `_solid`; `_boxR` is
 * never collided, and says so), so the column under a point is exact: the
 * highest box top spanning that XZ. No raycast, no tolerance.
 *
 * NOTHING BELOW USES A JUMP, and that is the strongest form of the claim: if
 * the deck is connected by walking, it is connected for a player who is out of
 * stamina, has never learned to mantle, and is reading the map.
 *
 * MUTATION RECORD is in the block comment above the last case.
 */

/* ------------------------------------------------------------------ */
/* Headless canvas - the exterior paints its own hull plating          */
/* ------------------------------------------------------------------ */

class Img {
  constructor(a, b, c) {
    if (typeof a === 'number') {
      this.width = a; this.height = b; this.data = new Uint8ClampedArray(a * b * 4);
    } else { this.data = a; this.width = b; this.height = c ?? 1; }
  }
}
if (!globalThis.document) {
  const gradient = { addColorStop() {} };
  const context2d = (canvas) => {
    const real = {
      canvas,
      createImageData: (w, h) => new Img(Math.max(1, w | 0), Math.max(1, (h ?? w) | 0)),
      getImageData: (x, y, w, h) => new Img(Math.max(1, w | 0), Math.max(1, h | 0)),
      createLinearGradient: () => gradient,
      createRadialGradient: () => gradient,
      measureText: () => ({ width: 8 }),
      getLineDash: () => [],
    };
    return new Proxy(real, { get: (o, k) => (k in o ? o[k] : () => undefined), set: () => true });
  };
  globalThis.ImageData = Img;
  globalThis.document = {
    createElement(tag) { const c = { width: 1, height: 1, style: {}, tagName: tag }; c.getContext = () => context2d(c); return c; },
    createElementNS(_ns, tag) { return this.createElement(tag); },
  };
}

const { DockExterior } = await import('../../src/worlds/space/DockExterior.js');
const { DOCK_ANCHOR } = await import('../../src/worlds/space/Bodies.js');
const { CONFIG } = await import('../../src/core/Config.js');

/* ------------------------------------------------------------------ */
/* The envelope, read from the game rather than typed                  */
/* ------------------------------------------------------------------ */

/** The tallest rise a walk absorbs. */
const STEP_UP = CONFIG.player.stepHeight;
/**
 * Jump apex, from the game's own numbers.
 *
 * A closed form, and it OVERSTATES the real apex by about 5 cm - `Player`
 * applies gravity before the integrator moves, so every trajectory loses
 * |g|dt²/2 (see `citadel-reach.test.mjs`, which drove this against a real
 * `fixedUpdate`). Overstating is the right direction here: it is used to show
 * that even a GENEROUS jump did not clear the old rail.
 */
const JUMP_APEX = (CONFIG.player.jumpVelocity ** 2) / (2 * Math.abs(CONFIG.player.gravity));
/** `Climb.MAX_RISE` - the tallest thing a mantle pulls you over. */
const MANTLE = 2.4;
/** Lattice pitch. The narrowest thing that matters is a 1.0 m rail. */
const PITCH = 0.5;

/* ------------------------------------------------------------------ */
/* A build, and the column index over it                               */
/* ------------------------------------------------------------------ */

function fakeHost() {
  const boxes = [];
  return {
    boxes,
    engine: { maxAnisotropy: 1 },
    physics: { addBox: (x, y, z, hx, hy, hz) => ({ x, y, z, hx, hy, hz }) },
    track(c) { boxes.push(c); return c; },
  };
}

/**
 * @param {(host:any)=>void} [ablate] run against the collider list before the
 *   flood, so a case can take a guard away and show the probe notices.
 */
function deck(ablate) {
  const host = fakeHost();
  const dock = new DockExterior(DOCK_ANCHOR, host);
  dock.dispose();
  if (ablate) ablate(host);
  const boxes = host.boxes;

  /** Highest collider top over (x,z), or null where there is no floor. */
  const surface = (x, z) => {
    let top = null;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (x < b.x - b.hx || x > b.x + b.hx) continue;
      if (z < b.z - b.hz || z > b.z + b.hz) continue;
      const t = b.y + b.hy;
      if (top === null || t > top) top = t;
    }
    return top;
  };

  /**
   * Every cell walkable from the spawn under one rise budget.
   * A rail is a collider like any other: its top is 1.15 m, so a rise budget
   * under that simply cannot step onto it, and cells beyond it are not
   * enumerated. That is the whole mechanism the defect turned against itself.
   */
  const flood = (maxRise) => {
    const [sx, , sz] = DOCK_ANCHOR.apronSpawn;
    const key = (x, z) => `${Math.round(x / PITCH)},${Math.round(z / PITCH)}`;
    const seen = new Set([key(sx, sz)]);
    const stack = [[sx, sz]];
    const cells = [];
    while (stack.length) {
      const [x, z] = stack.pop();
      const y = surface(x, z);
      if (y === null) continue;
      cells.push([x, y, z]);
      for (const [dx, dz] of [[PITCH, 0], [-PITCH, 0], [0, PITCH], [0, -PITCH]]) {
        const nx = x + dx, nz = z + dz;
        // Well outside anything this structure builds, so the fill terminates.
        if (nx < -200 || nx > 200 || nz < -320 || nz > 60) continue;
        const k = key(nx, nz);
        if (seen.has(k)) continue;
        const ny = surface(nx, nz);
        if (ny === null) continue;
        if (ny - y > maxRise + 1e-6) continue;
        seen.add(k);
        stack.push([nx, nz]);
      }
    }
    return cells;
  };

  return { boxes, surface, flood };
}

/** Is any flooded cell standing on this berth's pad? */
function onBerth(cells, berth) {
  const [bx, , bz] = berth.position;
  return cells.some(([x, , z]) => Math.abs(x - bx) < 6 && Math.abs(z - bz) < 6);
}

/** Is any flooded cell out on the cross-walk's outboard third? */
function onCrossWalk(cells) {
  return cells.some(([x, , z]) => Math.abs(z + 91) < 4 && Math.abs(x) > 60);
}

let _walk = null;
function walkable() {
  if (!_walk) _walk = deck().flood(STEP_UP);
  return _walk;
}

/* ================================================================== */
/* 1. Every berth is reachable by WALKING - no jump, no mantle         */
/* ================================================================== */

test('all four berths and the cross-walk are reachable on foot, walking', () => {
  const cells = walkable();

  assert.ok(cells.length > 0,
    'the flood found no floor at all under the arrival spawn ' +
    `${JSON.stringify(DOCK_ANCHOR.apronSpawn)} - the apron is not collided`);

  assert.ok(onCrossWalk(cells),
    'the cross-walk cannot be walked to from the apron: the seam at z -84 is ' +
    'blocked. That is where the two mis-placed rails used to stand.');

  const reached = DOCK_ANCHOR.berths.filter((b) => onBerth(cells, b));
  assert.equal(reached.length, DOCK_ANCHOR.berths.length,
    `${reached.length} of ${DOCK_ANCHOR.berths.length} berths reachable by walking. ` +
    `Missing: ${DOCK_ANCHOR.berths.filter((b) => !onBerth(cells, b)).map((b) => b.id).join(', ')}`);
});

/* ================================================================== */
/* 2. The envelope claim: it is a WALK, and the old rail beat a jump   */
/* ================================================================== */

test('the route needs no jump, and a 1.15 m rail would have beaten one', () => {
  /* Floor / achieved / ceiling for the route itself. The floor is "walking is
   * enough"; the ceiling is that a bigger budget does not find MORE berths,
   * i.e. the walk route is not a lucky subset of a climb route. */
  const d = deck();
  const byWalk = DOCK_ANCHOR.berths.filter((b) => onBerth(d.flood(STEP_UP), b)).length;
  const byMantle = DOCK_ANCHOR.berths.filter((b) => onBerth(d.flood(MANTLE), b)).length;
  assert.equal(byWalk, byMantle,
    `walking reaches ${byWalk} berths and mantling reaches ${byMantle} - some berth ` +
    'is behind a climb, which is a verb this game never teaches');

  /* And the arithmetic that made the old rail fatal, stated so a change to
   * either number is visible here rather than in a playthrough. */
  assert.ok(JUMP_APEX < 1.15,
    `a jump apex of ${JUMP_APEX.toFixed(2)} m now clears a 1.15 m rail, so the ` +
    'reasoning in this file no longer holds - re-derive it');
  assert.ok(STEP_UP < 1.15,
    `stepHeight is ${STEP_UP} and a kerb is 1.15 - a kerb no longer stops anyone`);
});

/* ================================================================== */
/* 3. Nowhere on that deck can you walk off it                         */
/* ================================================================== */

/**
 * MUTATION RECORD for this file: 9 of 9 red.
 *
 * Six assertion reversals, plus three deliberate breakages of the geometry
 * itself, each re-run against the single case it should redden:
 *
 *   1. cross-walk rails put back across z −84 / z −98 (the original defect,
 *      reproduced exactly)          -> case 1 red, 0 of 4 berths
 *   2. the mouth containment `_solid` removed
 *                                   -> case 3 red, 353 open cells at z −16
 *   3. the berth pad rails removed  -> case 3 red, 4 pads open on 3.5 edges
 *
 * The ablation inside case 3 is the same instrument used in-line, so the
 * "0 open drops" claim carries its own proof that it can be non-zero.
 */
test('the walkable deck is enclosed: there is nowhere to step off it', () => {
  const d = deck();
  const cells = walkable();

  const open = [];
  for (const [x, , z] of cells) {
    for (const [dx, dz] of [[PITCH, 0], [-PITCH, 0], [0, PITCH], [0, -PITCH]]) {
      if (d.surface(x + dx, z + dz) === null) { open.push([x, z]); break; }
    }
  }
  assert.equal(open.length, 0,
    `${open.length} reachable cells have a no-floor neighbour - the player can ` +
    `walk off the deck, e.g. at ${JSON.stringify(open.slice(0, 5))}. ` +
    '`UnstuckSystem` does recover a fall after 6 s of `FALL_TIME`, so this is ' +
    'not unrecoverable - it is six seconds of falling through a floor you can see.');

  /* CEILING BY ABLATION. Take the rails away and the same probe has to find
   * the drops, or "0" above is measuring nothing. Every collider 1.15 m tall
   * standing on the deck is a rail, which is how they are built. */
  const stripped = deck((host) => {
    host.boxes = host.boxes.filter((b) => !(Math.abs(b.hy - 0.575) < 1e-6));
  });
  let openAblated = 0;
  for (const [x, , z] of stripped.flood(STEP_UP)) {
    for (const [dx, dz] of [[PITCH, 0], [-PITCH, 0], [0, PITCH], [0, -PITCH]]) {
      if (stripped.surface(x + dx, z + dz) === null) { openAblated++; break; }
    }
  }
  assert.ok(openAblated > 200,
    `with every rail removed the probe still finds only ${openAblated} open drops, ` +
    'so it is not actually detecting edges');
});
