import * as THREE from 'three';
import {
  DEG, DECK_R, HULL_R, ROAD_W,
  ZONES, ZONE_R, ZONE_CENTRE_R, LINK_LEN,
  DOME_R, DOME_WALL_H, DOME_APEX, domeHeightAt,
  GeoBatch, boxGeo, cylGeo, uvScale, atlasUV, instanced, mulberry32,
  roadPos, zoneCentre, zoneLocal, zoneYaw,
} from './StationKit.js';
import { ZoneContext } from './ZoneContext.js';
import { buildCanteen } from './zones/Canteen.js';
import { buildGym } from './zones/Gym.js';
import { buildHabitation } from './zones/Habitation.js';
import { buildConstruction } from './zones/Construction.js';

/**
 * The outer ring: everything the station grew into once the hub stopped being
 * the whole world.
 *
 * ── The shape of the map ──────────────────────────────────────────────────
 * The hub is unchanged: a 200 m deck under its own plate at 62 m, six avenues,
 * the great window on +X. Four of those avenues now keep going. Each punches
 * through the hull, runs 96 m down a pressurised link, and opens into a zone
 * deck the same 200 m radius as the hub itself - so the finished map is five
 * decks of equal area rather than one deck with some annexes.
 *
 *     avenue 120  ->  Hab Ring C          crew quarters you can go inside
 *     avenue 180  ->  Deck 9 Athletics    the gym
 *     avenue 240  ->  Ring 8 Expansion    the construction site
 *     avenue 300  ->  The Long Galley     the canteen
 *
 * Avenues 0 and 60 are deliberately left alone. Avenue 0 is the axis of the
 * great window and the hero shot of the game; a tunnel mouth down it would put
 * a corridor through the glass. Avenue 60 already terminates in Hangar Bay 4.
 *
 * ── Why it is all under one dome ──────────────────────────────────────────
 * Four separate pressure vessels joined by tubes would have been easier and
 * would have looked like a diagram. One dome over the lot means the great
 * window has something to look at (see `_buildApron`), it means a player
 * standing in a zone's central court can see the hub's roofline across half a
 * kilometre of lit deck, and it gives the whole map a single legible ceiling
 * instead of five unrelated ones.
 *
 * The dome is a very shallow spherical cap - 100 m of rise over 720 m of span -
 * which is both what a pressurised span that wide actually looks like and about
 * two thousand triangles instead of a hemisphere's hundred thousand.
 *
 * ── Why each zone still has a ceiling of its own ──────────────────────────
 * A 200 m deck with nothing overhead but a dome 120 m up has no human scale
 * anywhere in it. Each zone therefore carries a ceiling plate over its outer
 * annulus only - r 112 to the rim, at 30 m - so the built-up edge is a covered
 * arcade you can read the height of, and the middle is an open court under the
 * dome. Tall structures go in the court, low ones under the arcade. That single
 * section is what makes four very different zones feel like the same station.
 */

/* Width of a connecting link's walkable floor. Matched to `ROAD_W` so the
 * avenue does not change gauge when it leaves the hull - a corridor wider than
 * the road feeding it reads as a different piece of architecture. */
const LINK_W = ROAD_W;
/** Half-angle a link mouth occupies at the hull, with clearance for its frame. */
export const LINK_MOUTH_HALF_DEG = Math.asin((LINK_W / 2 + 3.2) / HULL_R) / DEG;
/** Inner radius of a zone's ceiling annulus - inside this is open to the dome. */
const ZONE_COURT_R = 112;
/** Height of the zone ceiling plate over the arcade. */
const ZONE_CEIL_Y = 30;
/** Height of a zone's perimeter wall. Meets the ceiling plate. */
const ZONE_WALL_H = ZONE_CEIL_Y;

/** Bearings that carry a link, for the hull builder to cut around. */
export const LINK_DEGS = ZONES.map((z) => z.deg);

const _v = new THREE.Vector3();

/**
 * Build the dome, the four links, the four zone decks and the apron.
 *
 * @param {import('../StationWorld.js').StationWorld} world
 * @param {import('./StationActors.js').StationActors} actors
 */
export function buildOuterRing(world, actors) {
  buildGreatDome(world);
  buildApron(world);

  const built = [];
  for (const spec of ZONES) {
    buildLink(world, spec);
    built.push(buildZone(world, spec, actors));
  }
  return built;
}

/* ------------------------------------------------------------------ */
/* The great dome                                                      */
/* ------------------------------------------------------------------ */

function buildGreatDome(world) {
  const M = world.mat;
  const B = new GeoBatch();
  const g = new THREE.Group();
  g.name = 'dome';
  world.group.add(g);
  const rng = mulberry32(0xd03e);

  const SEGS = 144;          // 31 m of arc per segment at r=720
  const RIBS = 36;           // meridional ribs, every 10 degrees
  const RINGS = 16;          // latitude rings across the cap

  /* --- The floor -----------------------------------------------------
   *
   * One annulus of deck plating from the hub's rim to the dome wall, under
   * everything else.
   *
   * This was missing entirely, and the way it was missing is worth recording.
   * Collision was complete from the first build - the apron lays a grid of
   * slabs across the whole dome and a probe finds solid ground anywhere inside
   * it - so every floor-coverage sweep passed. What nothing tested was whether
   * anything was *drawn* there. The hub's deck disc stops at DECK_R+4 = 204,
   * the apron's paving started at HULL_R+16 = 218, and the apron only spans the
   * 152 degrees in front of the great window. Everywhere else, and in a 14 m
   * ring right around the hull, a player walked on solid nothing and looked
   * straight down into the starfield.
   *
   * Built by hand rather than with `RingGeometry` because a ring's UVs run 0..1
   * around and across, which over a 517 m annulus stretches one texture tile
   * into a wedge half a kilometre long. These UVs are planar in world space, so
   * the plate reads at the same size here as it does on the plaza.
   */
  {
    const R_IN = DECK_R + 3, R_OUT = DOME_R + 2;
    const SEG = 160, RINGS = 10, TILE = 14;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= RINGS; i++) {
      // Squared spacing again: the interesting radii are near the hub, where
      // the seam with the deck has to be tight.
      const r = R_IN + (R_OUT - R_IN) * ((i / RINGS) ** 1.6);
      for (let s = 0; s <= SEG; s++) {
        const a = (s / SEG) * Math.PI * 2;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        pos.push(x, 0, z);
        uv.push(x / TILE, z / TILE);
      }
    }
    const stride = SEG + 1;
    for (let i = 0; i < RINGS; i++) {
      for (let s = 0; s < SEG; s++) {
        const p0 = i * stride + s, p1 = p0 + 1, p2 = p0 + stride, p3 = p2 + 1;
        idx.push(p0, p2, p1, p1, p2, p3);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const floor = new THREE.Mesh(geo, M.deck);
    floor.position.y = -0.02;   // just under the zone decks and the apron paving
    floor.receiveShadow = true;
    floor.castShadow = false;
    g.add(floor);
  }

  /* --- Perimeter wall ---------------------------------------------- *
   * Glazed, because the whole point of putting the zones under one dome is
   * that you can see out of it. The lower 6 m is solid plate: it is the band
   * that takes the buttress feet, the service runs and every scuff a loading
   * crew will ever put on it, and a floor-to-roof glass wall with nothing at
   * knee height reads as a render, not as a building. */
  const skirt = new THREE.Mesh(
    uvScale(new THREE.CylinderGeometry(DOME_R, DOME_R, 6, SEGS, 1, true), (DOME_R * Math.PI * 2) / 12, 6 / 12),
    M.hullIn
  );
  skirt.position.y = 3;
  skirt.castShadow = false;
  skirt.receiveShadow = true;
  g.add(skirt);

  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(DOME_R, DOME_R, DOME_WALL_H - 6, SEGS, 1, true),
    M.glassHull
  );
  glass.position.y = 6 + (DOME_WALL_H - 6) / 2;
  glass.renderOrder = 6;
  glass.castShadow = glass.receiveShadow = false;
  g.add(glass);

  /* --- Roof cap ----------------------------------------------------- *
   * Built by hand rather than with SphereGeometry because the cap is a
   * 4-degree slice off the top of a 2.6 km sphere: asking Three for that means
   * asking for the whole sphere and throwing 99% of it away, and the phi range
   * that produces it is small enough to lose precision. Walking the profile
   * directly also lets the ring spacing be non-uniform - tight near the
   * springing where the curvature is, loose over the middle where it is flat. */
  const roofPos = [];
  const roofUv = [];
  const roofIdx = [];
  const ringR = [];
  for (let i = 0; i <= RINGS; i++) {
    // Squared spacing: rings bunch toward the rim, which is where the section
    // actually bends. Uniform spacing put twelve of sixteen rings across the
    // flat middle and faceted the springing.
    const t = i / RINGS;
    ringR.push(DOME_R * (1 - t * t));
  }
  for (let i = 0; i <= RINGS; i++) {
    const r = ringR[i];
    const y = domeHeightAt(r);
    for (let s = 0; s <= SEGS; s++) {
      const a = (s / SEGS) * Math.PI * 2;
      roofPos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      roofUv.push((s / SEGS) * 60, (r / DOME_R) * 30);
    }
  }
  const stride = SEGS + 1;
  for (let i = 0; i < RINGS; i++) {
    for (let s = 0; s < SEGS; s++) {
      const a = i * stride + s, b = a + 1, c = a + stride, d = c + 1;
      // Wound so the face normal points DOWN, into the volume - this is a
      // ceiling and it is only ever seen from underneath.
      roofIdx.push(a, b, c, b, d, c);
    }
  }
  const roofGeo = new THREE.BufferGeometry();
  roofGeo.setAttribute('position', new THREE.Float32BufferAttribute(roofPos, 3));
  roofGeo.setAttribute('uv', new THREE.Float32BufferAttribute(roofUv, 2));
  roofGeo.setIndex(roofIdx);
  roofGeo.computeVertexNormals();
  const roof = new THREE.Mesh(roofGeo, M.glassHull);
  roof.renderOrder = 5;
  roof.castShadow = roof.receiveShadow = false;
  g.add(roof);

  /* --- Meridional ribs ---------------------------------------------- *
   * The cap on its own is a sheet of glass with no gauge and no scale - at
   * 720 m across, that photographs as a grey wash. The ribs are what tell the
   * eye how big it is, so they are sized to be legible from the deck: a 2.6 m
   * section 120 m up is about the same visual weight as the hub's ceiling
   * trusses seen from the plaza, which is the reference the player already has. */
  for (let m = 0; m < RIBS; m++) {
    const a = (m / RIBS) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    for (let i = 0; i < RINGS; i++) {
      const r0 = ringR[i], r1 = ringR[i + 1];
      const y0 = domeHeightAt(r0), y1 = domeHeightAt(r1);
      const len = Math.hypot(r0 - r1, y0 - y1);
      const mr = (r0 + r1) / 2, my = (y0 + y1) / 2;
      const pitch = Math.atan2(y1 - y0, r0 - r1);
      const seg = boxGeo(len, 2.6, 1.9, 6);
      B.at('beam', seg, ca * mr, my, sa * mr, -a, 0, pitch);
    }
    // Wall mullion below the springing, continuing the rib line to the deck.
    B.at('trim', boxGeo(1.6, DOME_WALL_H, 2.6, 6), ca * (DOME_R - 1.4), DOME_WALL_H / 2, sa * (DOME_R - 1.4), -a);
  }

  /* Latitude hoops + a lit run on every other one. The dome is the only thing
   * over four of the five decks, so it is also their ambient fixture. */
  for (let i = 1; i < RINGS; i += 2) {
    const r = ringR[i];
    const y = domeHeightAt(r);
    const hoop = new THREE.TorusGeometry(r, 1.15, 6, Math.max(48, Math.round(SEGS * 0.6)));
    hoop.rotateX(-Math.PI / 2);
    uvScale(hoop, 90, 1);
    B.at('beam', hoop, 0, y - 1.6, 0);
    if (i % 4 === 1) {
      const lit = new THREE.TorusGeometry(r, 0.42, 5, Math.max(48, Math.round(SEGS * 0.6)));
      lit.rotateX(-Math.PI / 2);
      uvScale(lit, 90, 1);
      B.at('emDim', lit, 0, y - 2.9, 0);
    }
  }

  /* --- Buttresses ---------------------------------------------------- */
  for (let m = 0; m < RIBS; m++) {
    const a = (m / RIBS) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    B.at('panelDark', boxGeo(5.5, 9, 3.4, 4), ca * (DOME_R - 3.4), 4.5, sa * (DOME_R - 3.4), -a);
    const stay = boxGeo(15, 1.5, 1.5, 4);
    B.at('trimDark', stay, ca * (DOME_R - 8), 13, sa * (DOME_R - 8), -a, 0, 0.62);
  }

  /* --- Crown ---------------------------------------------------------- *
   * Something has to happen at the apex or the dome reads as an unfinished
   * sphere. A lit collar and a lantern give the whole map a single point of
   * reference visible from every deck - which is worth more for orientation
   * than any amount of signage. */
  const crown = new THREE.TorusGeometry(46, 1.9, 8, 72);
  crown.rotateX(-Math.PI / 2);
  uvScale(crown, 60, 1);
  B.at('beam', crown, 0, domeHeightAt(46) - 2.2, 0);
  const collar = new THREE.TorusGeometry(46, 0.7, 6, 72);
  collar.rotateX(-Math.PI / 2);
  B.at('emCyan', collar, 0, domeHeightAt(46) - 4.4, 0);
  B.at('panelDark', cylGeo(14, 20, 9, 20, 3), 0, DOME_APEX - 5, 0);
  B.at('emWhite', cylGeo(11, 11, 1.4, 20, 2), 0, DOME_APEX - 9.6, 0);

  /* --- Collision ------------------------------------------------------ *
   * The dome wall is the edge of the world on foot, and it is the only thing
   * that is. `_collisionSoup` will not reach it (its triangles are outside the
   * extraction radius and its material is glass, which is excluded), and a
   * player who walks off the deck at the rim would otherwise keep going into
   * the void. Chords rather than an arc: a 63 m chord on a 720 m circle sits
   * within 0.7 m of the true curve, which nobody can feel through a capsule. */
  const WALLS = 72;
  for (let i = 0; i < WALLS; i++) {
    const a = ((i + 0.5) / WALLS) * Math.PI * 2;
    const chord = (Math.PI * 2 * DOME_R) / WALLS;
    /* Yaw so the box's long axis lies ALONG the wall.
     *
     * `addRotatedBox` shares `GeoBatch.at`'s convention: local +Z goes to
     * `(sin ry, cos ry)`. Here local +Z has to be the radial direction
     * `(cos a, sin a)`, which gives `ry = PI/2 - a`.
     *
     * This was `-a`, which is the same expression with the axes swapped, and
     * the failure mode is instructive: every panel stood 69 m deep and 5 m
     * wide, so the "wall" was 72 radial fins with 57 m gaps between them - a
     * player could walk straight out of the dome - and each fin reached far
     * enough inward to plant a solid surface 70 m above the outer rim of the
     * zone next to it. Nothing catches this by eye, because the wall the fins
     * are meant to collide is drawn by a cylinder mesh that is not derived
     * from them. It showed up as an anomaly in a floor-height sweep.
     */
    world._solidRot(
      Math.cos(a) * (DOME_R + 1.5), DOME_WALL_H / 2, Math.sin(a) * (DOME_R + 1.5),
      chord * 0.55, DOME_WALL_H / 2, 2.5, Math.PI / 2 - a
    );
  }

  /* --- Roof collision -------------------------------------------------
   *
   * The roof is glass, and `_collisionSoup` drops transparent materials and
   * everything past the hub deck anyway - so until now the dome had a floor,
   * a wall, and nothing at all overhead. On foot that never mattered. On an
   * eagle or a dragon it very much does: you could climb straight through the
   * glazing and end up flying over the outside of a sealed station.
   *
   * Contained with concentric bands of plate rather than a fitted shell. The
   * cap is shallow enough that a band's step is a couple of metres, which is
   * nothing to something that has just gained a hundred, and a stepped ceiling
   * tiles the disc with no radial gap - which is the only property containment
   * actually needs. Segment counts scale with circumference so the inner bands
   * do not pay for the outer ones' resolution.
   */
  const BANDS = 10;
  let roofBoxes = 0;
  for (let i = 0; i < BANDS; i++) {
    const r0 = (i / BANDS) * DOME_R;
    const r1 = ((i + 1) / BANDS) * DOME_R;
    const rm = (r0 + r1) / 2;
    const y = domeHeightAt(r1);          // the LOWER of the band's two edges
    const segs = Math.max(8, Math.round((Math.PI * 2 * rm) / 60));
    for (let s = 0; s < segs; s++) {
      const a = ((s + 0.5) / segs) * Math.PI * 2;
      world._solidRot(
        Math.cos(a) * rm, y + 1.2, Math.sin(a) * rm,
        // Tangential half-width with a healthy overlap at the band's outer edge,
        // then the radial half-depth.
        (Math.PI * r1) / segs, 1.2, (r1 - r0) / 2 + 0.5,
        Math.PI / 2 - a
      );
      roofBoxes++;
    }
  }
  console.info(`[station] dome: roof collided in ${BANDS} bands, ${roofBoxes} panels`);

  B.flush(g, M, 'dome', { cast: false, recv: true });
  world._mmCircle(0, 0, DOME_R, 'rgba(10,20,32,0.30)', 'rgba(120,180,220,0.35)');
}

/* ------------------------------------------------------------------ */
/* The apron - what the great window looks at                          */
/* ------------------------------------------------------------------ */

/**
 * The unbuilt half of the dome, in front of the great window.
 *
 * Zones only hang off four of the six avenues, so roughly a third of the dome
 * floor carries nothing - and it is exactly the third the hero shot points at.
 * Left bare it would be half a kilometre of empty plate under the best view in
 * the game.
 *
 * So it becomes the station's own outdoor yard: shuttles on pads, a fuel farm,
 * container stacks, gantries and a service loop. It is deliberately sparse and
 * deliberately large-featured - everything here is seen from 200 m and up
 * through 55 degrees of glass, where detail costs frames and silhouette is the
 * only thing that survives.
 */
function buildApron(world) {
  const M = world.mat;
  const B = new GeoBatch();
  const g = new THREE.Group();
  g.name = 'apron';
  world.group.add(g);
  const rng = mulberry32(0xa9803);

  /* The apron spans the bearings with no zone on them: 300 round through 0 to
   * 120, minus the margin either side where the two flanking links run. */
  const A0 = -46 * DEG, A1 = 106 * DEG;
  const R0 = HULL_R + 16, R1 = DOME_R - 30;

  // Paved ground. One ring sector, seamed by its own texture rather than by
  // geometry - a 500 m plate wants far fewer triangles than it wants tiles.
  const pad = new THREE.Mesh(
    uvScale(new THREE.RingGeometry(R0, R1, 96, 6, A0, A1 - A0), (R1 - R0) / 14, (R1 - R0) / 14),
    M.road
  );
  pad.rotation.x = Math.PI / 2;
  pad.position.y = 0.04;
  pad.receiveShadow = true;
  pad.castShadow = false;
  g.add(pad);

  /* Floor is solid out to the dome. A grid of slabs rather than one enormous
   * box: the capsule solver rejects on a collider's bounding radius first, and
   * a single 1,000 m box would be a candidate for every query on the map. */
  for (let i = 0; i < 10; i++) {
    for (let j = 0; j < 10; j++) {
      const cx = (i - 4.5) * 150, cz = (j - 4.5) * 150;
      if (Math.hypot(cx, cz) > DOME_R + 60) continue;
      world._solid(cx, -3, cz, 76, 3, 76);
    }
  }

  /* --- Landing pads with a shuttle on two of them -------------------- */
  const pads = [
    { deg: 6, r: 300, rot: 0.3 }, { deg: 34, r: 330, rot: -0.5 },
    { deg: -22, r: 340, rot: 1.1 }, { deg: 62, r: 300, rot: 0.2 },
    { deg: 18, r: 470, rot: -0.9 }, { deg: -34, r: 480, rot: 0.6 },
    { deg: 78, r: 450, rot: 0.9 }, { deg: 48, r: 560, rot: -0.3 },
  ];
  pads.forEach((p, i) => {
    const c = roadPos(p.deg, p.r, 0, 0, new THREE.Vector3());
    const ring = new THREE.TorusGeometry(24, 0.5, 6, 48);
    ring.rotateX(-Math.PI / 2);
    uvScale(ring, 40, 1);
    B.at(i % 2 ? 'emAmber' : 'emCyan', ring, c.x, 0.14, c.z);
    B.at('hazard', uvScale(new THREE.RingGeometry(21, 26, 40, 1).rotateX(Math.PI / 2), 8, 8), c.x, 0.1, c.z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      B.at('trimDark', boxGeo(1.2, 1.6, 1.2, 2), c.x + Math.cos(a) * 27, 0.8, c.z + Math.sin(a) * 27);
      world._solid(c.x + Math.cos(a) * 27, 0.8, c.z + Math.sin(a) * 27, 0.7, 0.8, 0.7);
    }
    world._mmCircle(c.x, c.z, 24, 'rgba(50,70,90,0.35)', 'rgba(150,210,255,0.45)');

    if (i % 3 === 0) shuttle(B, world, c.x, c.z, p.rot, rng);
  });

  /* --- Fuel farm ------------------------------------------------------ */
  for (let i = 0; i < 7; i++) {
    const c = roadPos(-38 + i * 5.5, 250 + (i % 3) * 26, 0, 0, new THREE.Vector3());
    const h = 26 + (i % 3) * 6;
    B.at('shell', cylGeo(11, 11, h, 20, 4), c.x, h / 2, c.z);
    B.at('trim', cylGeo(11.6, 11.6, 1.0, 20, 2), c.x, h - 3, c.z);
    B.at('panelDark', cylGeo(11.9, 9, 3.2, 20, 3), c.x, h + 1.6, c.z);
    B.at('emRed', cylGeo(1.1, 1.1, 0.5, 8, 1), c.x, h + 3.4, c.z);
    world._solid(c.x, h / 2, c.z, 11.2, h / 2, 11.2);
    world._mmCircle(c.x, c.z, 11, 'rgba(90,80,70,0.5)', 'rgba(220,180,120,0.4)');
  }

  /* --- Container stacks and gantries ---------------------------------- */
  const crates = [];
  for (let i = 0; i < 130; i++) {
    const deg = -44 + rng() * 148;
    const r = R0 + 30 + rng() * (R1 - R0 - 90);
    const c = roadPos(deg, r, 0, 0, new THREE.Vector3());
    // Never on a pad, and never so close to the hull that it blocks the window.
    let clear = true;
    for (const p of pads) {
      const q = roadPos(p.deg, p.r, 0, 0, _v);
      if (Math.hypot(q.x - c.x, q.z - c.z) < 40) { clear = false; break; }
    }
    if (!clear) continue;
    const stack = 1 + Math.floor(rng() * 3);
    const yaw = Math.round(rng() * 4) * (Math.PI / 4);
    for (let s = 0; s < stack; s++) {
      crates.push([c.x, 1.6 + s * 3.1, c.z, 0, yaw + (s ? (rng() - 0.5) * 0.05 : 0), 0, 1, 1, 1]);
    }
    world._solidRot(c.x, (stack * 3.1) / 2, c.z, 3.2, (stack * 3.1) / 2, 6.4, yaw);
  }
  g.add(instanced(boxGeo(6.4, 3.0, 12.8, 3), M.crate, crates, { cast: true, recv: true }));

  for (let i = 0; i < 5; i++) {
    const c = roadPos(-30 + i * 34, 380 + (i % 2) * 90, 0, 0, new THREE.Vector3());
    gantry(B, world, c.x, c.z, -(-30 + i * 34) * DEG + Math.PI / 2);
  }

  /* --- Service loop --------------------------------------------------- *
   * A painted road with nothing on it still tells the eye the yard is used,
   * and it is the cheapest possible piece of legibility over 500 m. */
  for (const rr of [270, 420, 560]) {
    const road = new THREE.Mesh(
      uvScale(new THREE.RingGeometry(rr - 7, rr + 7, 90, 1, A0 + 0.06, (A1 - A0) - 0.12), 40, 1),
      M.road
    );
    road.rotation.x = Math.PI / 2;
    road.position.y = 0.09;
    road.receiveShadow = true;
    road.castShadow = false;
    g.add(road);
    for (let i = 0; i < 40; i++) {
      const a = A0 + 0.06 + ((A1 - A0 - 0.12) * i) / 39;
      B.at('emDim', boxGeo(0.4, 0.08, 4.5, 1), Math.cos(a) * (rr + 7.6), 0.12, Math.sin(a) * (rr + 7.6), -a + Math.PI / 2);
    }
    world._mmPath(
      Array.from({ length: 24 }, (_, i) => {
        const a = A0 + ((A1 - A0) * i) / 23;
        return [Math.cos(a) * rr, Math.sin(a) * rr];
      }),
      'rgba(150,190,220,0.3)', 12, false
    );
  }

  B.flush(g, M, 'apron', { cast: true, recv: true });
}

/** A parked shuttle: a hull, two nacelles, a ramp and its own contact patch. */
function shuttle(B, world, x, z, yaw, rng) {
  const L = 26, W = 9, H = 6.5;
  B.at('shell', boxGeo(W, H, L, 5), x, H / 2 + 1.6, z, yaw);
  B.at('panelDark', boxGeo(W + 0.6, 1.2, L * 0.7, 4), x, 1.9, z, yaw);
  // Nose taper and canopy.
  B.at('shell', cylGeo(1.6, W / 2, 6, 12, 4), x + Math.sin(yaw) * (L / 2 + 2), H / 2 + 1.6, z + Math.cos(yaw) * (L / 2 + 2), yaw, Math.PI / 2);
  B.at('glassWindow', boxGeo(W - 2.4, 1.7, 4, 2), x + Math.sin(yaw) * (L / 2 - 3), H + 0.9, z + Math.cos(yaw) * (L / 2 - 3), yaw);
  for (const s of [-1, 1]) {
    const ox = Math.cos(yaw) * s * (W / 2 + 2.6);
    const oz = -Math.sin(yaw) * s * (W / 2 + 2.6);
    B.at('trimDark', cylGeo(2.0, 2.0, 12, 12, 4), x + ox, 4.4, z + oz, yaw, Math.PI / 2);
    B.at('emCyan', cylGeo(1.5, 1.5, 0.7, 12, 2), x + ox - Math.sin(yaw) * 6.1, 4.4, z + oz - Math.cos(yaw) * 6.1, yaw, Math.PI / 2);
    B.at('trim', boxGeo(0.9, 3.4, 3.0, 3), x + ox, 2.0, z + oz, yaw);
  }
  // Boarding ramp down at the tail, so the thing reads as parked, not landed.
  const rampL = 7;
  B.at('grate', boxGeo(4.2, 0.3, rampL, 2), x - Math.sin(yaw) * (L / 2 + rampL / 2 - 0.6), 1.0, z - Math.cos(yaw) * (L / 2 + rampL / 2 - 0.6), yaw, -0.26);
  world._solidRot(x, H / 2 + 1.6, z, W / 2 + 0.4, H / 2 + 1.7, L / 2 + 0.4, yaw);
  world._contact(x, z, L * 1.5);
  world._mmRect(x, z, W + 5, L, yaw, 'rgba(110,130,150,0.6)', 'rgba(180,225,255,0.5)');
}

/** A straddling service gantry, for silhouette against the dome. */
function gantry(B, world, x, z, yaw) {
  const SPAN = 54, H = 30;
  for (const s of [-1, 1]) {
    const ox = Math.cos(yaw) * s * (SPAN / 2);
    const oz = -Math.sin(yaw) * s * (SPAN / 2);
    B.at('beam', boxGeo(3.0, H, 3.0, 5), x + ox, H / 2, z + oz, yaw);
    world._solidRot(x + ox, H / 2, z + oz, 1.6, H / 2, 1.6, yaw);
    for (let i = 1; i < 5; i++) {
      B.at('trimDark', boxGeo(0.6, 0.6, 5.5, 2), x + ox, i * (H / 5), z + oz, yaw, 0, 0.9);
    }
  }
  B.at('beam', boxGeo(SPAN + 4, 3.4, 4.0, 6), x, H - 1.7, z, yaw + Math.PI / 2);
  B.at('grate', boxGeo(SPAN, 0.3, 2.6, 3), x, H - 3.6, z, yaw + Math.PI / 2);
  world._solidRot(x, H - 3.6, z, SPAN / 2, 0.2, 1.3, yaw + Math.PI / 2);
  for (let i = 0; i < 5; i++) {
    B.at('emSodium', boxGeo(3.2, 0.2, 0.6, 1), x + Math.cos(yaw) * ((i - 2) * 11), H - 4.2, z - Math.sin(yaw) * ((i - 2) * 11), yaw + Math.PI / 2);
  }
}

/* ------------------------------------------------------------------ */
/* Links - the pressurised corridors                                   */
/* ------------------------------------------------------------------ */

/**
 * A link is the only piece of this map every player is guaranteed to walk down,
 * so it carries more per metre than anything else out here: a travelator each
 * side that actually moves you, two glazed bays looking out over the apron and
 * the dome, an airlock ring at each end, and the zone's name in letters you can
 * read from the plaza kerb.
 */
function buildLink(world, spec) {
  const M = world.mat;
  const B = new GeoBatch();
  const g = new THREE.Group();
  g.name = `link:${spec.id}`;
  world.group.add(g);

  const deg = spec.deg;
  const R0 = HULL_R - 6;                 // starts inside the hull line, so there is no seam
  const R1 = ZONE_CENTRE_R - ZONE_R;     // ends at the zone rim
  const L = R1 - R0;
  const MID = (R0 + R1) / 2;
  const HALF = LINK_W / 2;
  const CEIL = 9.5;

  /* The avenue's own yaw, so the corridor is the road continued rather than a
   * separate object bolted to the end of it. `roadPos` puts local +X across the
   * carriageway and this yaw puts a box's local +Z along it - the same pair
   * every district builder in the hub already works in. */
  const yaw = -deg * DEG - Math.PI / 2;

  /**
   * Place geometry in corridor coordinates.
   * @param off  metres across the corridor, +X to the right facing the hub
   * @param y    height above the deck
   * @param dr   metres along the corridor from its midpoint, + toward the zone
   */
  const at = (key, geo, off, y, dr, extraYaw = 0, rx = 0, rz = 0) => {
    const p = roadPos(deg, MID + dr, off, y, new THREE.Vector3());
    return B.at(key, geo, p.x, p.y, p.z, yaw + extraYaw, rx, rz);
  };
  const solidAt = (off, y, dr, hx, hy, hz) => {
    const p = roadPos(deg, MID + dr, off, y, new THREE.Vector3());
    return world._solidRot(p.x, p.y, p.z, hx, hy, hz, yaw);
  };

  /* --- Floor --------------------------------------------------------- */
  const floorGeo = uvScale(new THREE.PlaneGeometry(LINK_W + 5, L), (LINK_W + 5) / 12, L / 12);
  floorGeo.rotateX(-Math.PI / 2);
  const floor = new THREE.Mesh(floorGeo, M.deck);
  floor.position.copy(roadPos(deg, MID, 0, 0.03, new THREE.Vector3()));
  floor.rotation.y = yaw;
  floor.receiveShadow = true;
  floor.castShadow = false;
  g.add(floor);
  solidAt(0, -3, 0, (LINK_W + 5) / 2, 3, L / 2);

  /* --- Walls, glazing and roof --------------------------------------- */
  for (const s of [-1, 1]) {
    // Solid dado, glazed above it. Same reasoning as the dome skirt: the band
    // people touch is plate, the band people look through is glass.
    at('panel', boxGeo(0.7, 2.4, L, 3), (HALF + 0.35) * s, 1.2, 0);
    at('trim', boxGeo(0.9, 0.25, L, 2), (HALF + 0.35) * s, 2.5, 0);
    /* Glass faces INWARD. `M.glassWindow` is single-sided, and a pane hung the
     * other way up is invisible from the only side anybody ever sees it from -
     * which is not a subtle bug, it is a corridor with no windows in it. */
    at('glassWindow', new THREE.PlaneGeometry(L, CEIL - 3.2), (HALF + 0.05) * s, (CEIL + 2.4) / 2, 0, s > 0 ? -Math.PI / 2 : Math.PI / 2);
    at('panelDark', boxGeo(0.8, 0.9, L, 3), (HALF + 0.35) * s, CEIL - 0.4, 0);
    solidAt((HALF + 0.5) * s, CEIL / 2, 0, 0.7, CEIL / 2, L / 2);
  }
  // Portal frames every 8 m: two posts and a beam, so the run has a rhythm and
  // a vanishing point rather than being a smooth tube.
  const FRAMES = Math.floor(L / 8);
  for (let i = 0; i <= FRAMES; i++) {
    const dr = -L / 2 + (L * i) / FRAMES;
    for (const s of [-1, 1]) at('trim', boxGeo(0.55, CEIL, 0.55, 2), (HALF + 0.35) * s, CEIL / 2, dr);
    at('trim', boxGeo(0.55, 0.55, LINK_W + 1.6, 2), 0, CEIL, dr);
  }
  at('panelDark', boxGeo(LINK_W + 2.4, 0.6, L, 4), 0, CEIL + 0.3, 0);
  solidAt(0, CEIL + 0.35, 0, (LINK_W + 2.4) / 2, 0.35, L / 2);

  // Lit run down the spine of the ceiling, plus the district accent either side
  // at handrail height - the colour a player followed out of the plaza.
  at('emWhite', boxGeo(1.5, 0.14, L - 4, 1), 0, CEIL - 0.16, 0);
  for (const s of [-1, 1]) at(spec.accent, boxGeo(0.16, 0.1, L - 6, 1), (HALF - 0.4) * s, 2.62, 0);

  /* --- Travelators ---------------------------------------------------- *
   * Two moving walkways, one each way, running the middle 70% of the link.
   * Geometry and a scrolling tread here; the push the player actually feels is
   * applied by StationWorld's update, which is the only place that can see
   * where the player is standing. */
  const TL = L * 0.7;
  const belts = [];
  for (const s of [-1, 1]) {
    const off = s * 5.4;
    at('trimDark', boxGeo(3.4, 0.5, TL, 3), off, 0.25, 0);
    at('grate', boxGeo(3.0, 0.16, TL, 2), off, 0.53, 0);
    for (const e of [-1, 1]) {
      at('panelDark', boxGeo(0.34, 1.05, TL, 2), off + e * 1.75, 0.9, 0);
      at('rubber', boxGeo(0.30, 0.14, TL, 1), off + e * 1.75, 1.48, 0);
    }
    // Comb plates at both ends - the detail that says "this moves".
    for (const e of [-1, 1]) at('hazard', boxGeo(3.0, 0.2, 1.1, 1), off, 0.55, (e * TL) / 2);

    const p = roadPos(deg, MID, off, 0, new THREE.Vector3());
    belts.push({
      x: p.x, z: p.z,
      // Unit vector the belt carries you along, in world XZ. Outward is
      // (cos deg, sin deg); the right-hand belt runs out, the left runs back.
      dx: Math.cos(deg * DEG) * s,
      dz: Math.sin(deg * DEG) * s,
      // Half-extents of the deck plate, in belt-local terms.
      halfLong: TL / 2, halfWide: 1.5,
      top: 0.61,
    });
    solidAt(off, 0.26, 0, 1.7, 0.26, TL / 2);
  }
  (world._travelators ??= []).push(...belts);

  /* --- Airlock rings and signage --------------------------------------- */
  for (const [dr, label] of [[-L / 2 + 4, true], [L / 2 - 4, false]]) {
    // A cylinder's axis is local Y, so it needs a quarter turn about X to lie
    // across the corridor as a ring you walk through.
    at('panelDark', cylGeo(HALF + 3.6, HALF + 3.6, 2.2, 24, 3, true), 0, CEIL / 2, dr, 0, Math.PI / 2);
    at(spec.accent, cylGeo(HALF + 2.0, HALF + 2.0, 0.5, 24, 2, true), 0, CEIL / 2, dr, 0, Math.PI / 2);
    for (const s of [-1, 1]) at('hazard', boxGeo(0.5, CEIL - 1, 0.9, 2), (HALF - 0.5) * s, (CEIL - 1) / 2, dr);
    if (label) {
      const p = roadPos(deg, MID + dr + 2.2, 0, CEIL - 2.4, new THREE.Vector3());
      // The board faces back down the corridor at somebody walking out from the
      // hub, so its normal points inward: yaw + PI/2 turns the sign across the
      // run and PI flips it to face the hub.
      world._signBoard(B, spec.signCell, 8.5, 2.1, p.x, p.y, p.z, yaw + Math.PI, {
        twoSided: true, accent: spec.accent,
      });
    }
  }

  /* --- Glazed bays ------------------------------------------------------ *
   * Two alcoves where the wall steps out and the glass goes to the floor. They
   * exist so the walk has a reason to slow down: this is the only place on the
   * map where you are level with the apron and can see the hub's outer hull,
   * the dome springing and the zone ahead in one frame. */
  for (const [t, s] of [[0.34, -1], [0.66, 1]]) {
    const dr = -L / 2 + L * t;
    const bayFloor = new THREE.PlaneGeometry(7, 9);
    bayFloor.rotateX(-Math.PI / 2);
    uvScale(bayFloor, 7 / 12, 9 / 12);
    at('deck', bayFloor, (HALF + 3.5) * s, 0.06, dr);
    at('glassWindow', new THREE.PlaneGeometry(9, CEIL - 1), (HALF + 7) * s, (CEIL - 1) / 2, dr, s > 0 ? -Math.PI / 2 : Math.PI / 2);
    at('panelDark', boxGeo(7.4, 0.5, 9.4, 3), (HALF + 3.5) * s, CEIL + 0.2, dr);
    at('trim', boxGeo(0.4, 1.0, 9, 2), (HALF + 7) * s, 0.5, dr);
    at('emDim', boxGeo(6, 0.12, 0.3, 1), (HALF + 3.5) * s, CEIL - 0.2, dr);
    // A bench, so the view is somewhere to stop rather than somewhere to notice.
    at('panelWarm', boxGeo(4.2, 0.42, 0.9, 2), (HALF + 4.6) * s, 0.48, dr);
    solidAt((HALF + 4.6) * s, 0.48, dr, 2.1, 0.24, 0.45);

    solidAt((HALF + 7.3) * s, CEIL / 2, dr, 0.4, CEIL / 2, 4.7);
    solidAt((HALF + 3.5) * s, -3, dr, 3.7, 3, 4.7);
    /* The dado runs the whole length of the corridor, so it would seal the bay
     * off if it were not interrupted. These two stubs are what is left of it
     * either side of the opening - without them the alcove is a picture of a
     * room you cannot enter. */
    solidAt((HALF + 0.5) * s, CEIL / 2, dr - 5.2, 0.7, CEIL / 2, 0.4);
    solidAt((HALF + 0.5) * s, CEIL / 2, dr + 5.2, 0.7, CEIL / 2, 0.4);
  }

  /* --- Light ------------------------------------------------------------ */
  for (let i = 0; i <= 4; i++) {
    const p = roadPos(deg, R0 + (L * i) / 4, 0, 0, new THREE.Vector3());
    const l = new THREE.PointLight(0xcfe4ff, 620, 42, 2);
    l.position.set(p.x, CEIL - 1.2, p.z);
    l.castShadow = false;
    g.add(l);
  }

  B.flush(g, M, `link:${spec.id}`, { cast: true, recv: true });
  world._mmPath(
    [[Math.cos(deg * DEG) * R0, Math.sin(deg * DEG) * R0], [Math.cos(deg * DEG) * R1, Math.sin(deg * DEG) * R1]],
    'rgba(150,200,230,0.55)', LINK_W, false
  );
}

/* ------------------------------------------------------------------ */
/* Zone shells                                                         */
/* ------------------------------------------------------------------ */

/**
 * A zone's deck, perimeter, arcade ceiling and entry plaza, then its content.
 *
 * Everything here is common to all four so no zone builder has to think about
 * the floor it is standing on, and - more to the point - so the four cannot
 * disagree about it. The section is fixed: open court inside r=112 under the
 * dome, covered arcade from there to the rim at 30 m.
 */
function buildZone(world, spec, actors) {
  const M = world.mat;
  const B = new GeoBatch();
  const g = new THREE.Group();
  g.name = `zone:${spec.id}`;
  world.group.add(g);
  const rng = mulberry32(0x2013 + spec.deg * 7);

  const centre = zoneCentre(spec.deg);
  const yaw = zoneYaw(spec.deg);
  const ctx = new ZoneContext({ world, spec, group: g, B, actors, rng });

  /* --- Deck ----------------------------------------------------------- */
  const deck = new THREE.Mesh(
    uvScale(new THREE.CircleGeometry(ZONE_R + 3, 96), ((ZONE_R + 3) * 2) / 12, ((ZONE_R + 3) * 2) / 12),
    M.deck
  );
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(centre.x, 0.02, centre.z);
  deck.receiveShadow = true;
  deck.castShadow = false;
  g.add(deck);
  // Four slabs rather than one, for the same broadphase reason as the apron.
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    world._solid(centre.x + ox * 102, -3, centre.z + oz * 102, 104, 3, 104);
  }

  // Court inlay, so the open middle reads as a place rather than as a gap.
  const court = new THREE.Mesh(
    uvScale(new THREE.CircleGeometry(ZONE_COURT_R - 6, 72), ((ZONE_COURT_R - 6) * 2) / 12, ((ZONE_COURT_R - 6) * 2) / 12),
    M.plazaOnDeck
  );
  court.rotation.x = -Math.PI / 2;
  court.position.set(centre.x, 0.08, centre.z);
  court.receiveShadow = true;
  court.castShadow = false;
  g.add(court);
  for (const rr of [34, 62, 92]) {
    const t = new THREE.TorusGeometry(rr, 0.22, 5, 96);
    t.rotateX(-Math.PI / 2);
    uvScale(t, rr * 2, 1);
    B.at(rr === 62 ? spec.accent : 'trimDark', t, centre.x, 0.12, centre.z);
  }

  /* --- Perimeter wall -------------------------------------------------- *
   * Opaque to head height, glazed above, and cut for the link mouth. The gap
   * is generous: a mouth exactly as wide as the corridor reads as a doorway,
   * and this is meant to read as the end of a concourse. */
  const MOUTH_HALF = Math.asin((LINK_W / 2 + 7) / (ZONE_R + 2));
  const SEG = 96;
  for (let i = 0; i < SEG; i++) {
    const a0 = (i / SEG) * Math.PI * 2;
    const a1 = ((i + 1) / SEG) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const p = zoneLocal(spec.deg, Math.sin(am) * (ZONE_R + 2), 0, Math.cos(am) * (ZONE_R + 2));
    // Skip the arc the link comes through.
    if (Math.abs(Math.atan2(Math.sin(am), Math.cos(am))) < MOUTH_HALF) continue;
    const chord = ((Math.PI * 2 * (ZONE_R + 2)) / SEG) * 0.54;
    const wYaw = yaw + am;
    B.at('panel', boxGeo(chord * 2, 6, 1.2, 4), p.x, 3, p.z, wYaw);
    B.at('trim', boxGeo(chord * 2, 0.3, 1.6, 2), p.x, 6.2, p.z, wYaw);
    B.at('glassWindow', new THREE.PlaneGeometry(chord * 2, ZONE_WALL_H - 7.5), p.x - Math.sin(wYaw) * 0.2, 6.4 + (ZONE_WALL_H - 7.5) / 2, p.z - Math.cos(wYaw) * 0.2, wYaw + Math.PI);
    B.at('panelDark', boxGeo(chord * 2, 1.4, 2.2, 3), p.x, ZONE_WALL_H - 0.7, p.z, wYaw);
    if (i % 3 === 0) {
      B.at('trim', boxGeo(0.9, ZONE_WALL_H, 1.8, 4), p.x, ZONE_WALL_H / 2, p.z, wYaw);
    }
    world._solidRot(p.x, ZONE_WALL_H / 2, p.z, chord, ZONE_WALL_H / 2, 1.1, wYaw);
  }

  /* --- Arcade ceiling --------------------------------------------------- */
  const ceilRing = new THREE.RingGeometry(ZONE_COURT_R, ZONE_R + 3, 96, 1);
  uvScale(ceilRing, (ZONE_R * 2) / 18, (ZONE_R * 2) / 18);
  const ceil = new THREE.Mesh(ceilRing, M.ceiling);
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(centre.x, ZONE_CEIL_Y, centre.z);
  ceil.castShadow = ceil.receiveShadow = false;
  g.add(ceil);

  /* The arcade plate is solid.
   *
   * Same omission as the dome roof, one scale down: the plate is drawn, it is
   * the thing that gives the arcade its height, and it was not collided - so a
   * mount could rise through it and sit inside the roof structure. The court
   * inside r=112 stays open, which is the whole point of the section. */
  for (let i = 0; i < 32; i++) {
    const a = ((i + 0.5) / 32) * Math.PI * 2;
    const rm = (ZONE_COURT_R + ZONE_R + 3) / 2;
    world._solidRot(
      centre.x + Math.cos(a) * rm, ZONE_CEIL_Y + 0.4, centre.z + Math.sin(a) * rm,
      (Math.PI * (ZONE_R + 3)) / 32, 0.4, (ZONE_R + 3 - ZONE_COURT_R) / 2 + 0.5,
      Math.PI / 2 - a
    );
  }

  // Collar at the court edge - the ring that tells you where the roof stops.
  const collar = new THREE.TorusGeometry(ZONE_COURT_R + 1.4, 0.9, 8, 96);
  collar.rotateX(-Math.PI / 2);
  uvScale(collar, 90, 1);
  B.at('beam', collar, centre.x, ZONE_CEIL_Y - 1.3, centre.z);
  const lit = new THREE.TorusGeometry(ZONE_COURT_R + 1.4, 0.3, 6, 96);
  lit.rotateX(-Math.PI / 2);
  B.at(spec.accent, lit, centre.x, ZONE_CEIL_Y - 2.6, centre.z);

  // Radial trusses across the arcade, with a lit trough on every third.
  const TRUSS_L = ZONE_R + 3 - ZONE_COURT_R;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    const mr = ZONE_COURT_R + TRUSS_L / 2;
    B.at('beam', boxGeo(TRUSS_L, 1.9, 2.6, 5), centre.x + Math.cos(a) * mr, ZONE_CEIL_Y - 1.5, centre.z + Math.sin(a) * mr, -a);
    if (i % 3 === 0) {
      B.at('trimDark', boxGeo(TRUSS_L - 8, 0.7, 2.2, 3), centre.x + Math.cos(a) * mr, ZONE_CEIL_Y - 3.1, centre.z + Math.sin(a) * mr, -a);
      B.at('emWhite', boxGeo(TRUSS_L - 10, 0.16, 1.4, 1), centre.x + Math.cos(a) * mr, ZONE_CEIL_Y - 3.5, centre.z + Math.sin(a) * mr, -a);
    }
  }
  for (const rr of [ZONE_COURT_R + 30, ZONE_COURT_R + 62]) {
    const hoop = new THREE.TorusGeometry(rr, 0.7, 6, 84);
    hoop.rotateX(-Math.PI / 2);
    uvScale(hoop, 60, 1);
    B.at('beam', hoop, centre.x, ZONE_CEIL_Y - 2.2, centre.z);
  }

  /* --- Entry plaza ------------------------------------------------------ *
   * Where the link lands. Every zone gets the same arrival: a paved apron, the
   * zone's name overhead, a wayfinding pylon and a bench pair, so a player
   * always knows they have arrived somewhere and always knows where they are. */
  const ez = ZONE_R - 26;
  ctx.floorQuad('plaza', 44, 40, 0, ez, 0, 0.1, 12);
  ctx.sign(spec.signCell ?? 24, 13, 3.3, 0, 12.5, ZONE_R - 8, Math.PI, { twoSided: true, accent: spec.accent });
  for (const s of [-1, 1]) {
    ctx.box('panelDark', 1.4, 12.5, 1.4, s * 12, 6.25, ZONE_R - 8);
    ctx.solid(s * 12, 6.25, ZONE_R - 8, 0.8, 6.25, 0.8);
    ctx.box(spec.accent, 1.5, 0.2, 1.5, s * 12, 12.6, ZONE_R - 8);
  }
  // Wayfinding pylon, holographic and two-sided.
  ctx.box('panelDark', 1.1, 4.2, 0.5, 0, 2.1, ez - 14);
  ctx.box('holo', 2.6, 2.4, 0.06, 0, 3.4, ez - 14.35);
  ctx.solid(0, 2.1, ez - 14, 0.6, 2.1, 0.35);
  ctx.contact(0, ez - 14, 5);

  /* --- Practicals -------------------------------------------------------- *
   * The zones are 500 m from the hub's key light, which cannot reach them and
   * should not try - its shadow box is 160 m across for a reason. Each zone
   * lights itself with practicals; `gfx/LightRig.js` scores them by delivered
   * energy near the camera and gives the best eight a slot, so the count in the
   * shader cache key never moves however many are authored here. */
  const addLight = (lx, lz, ly, hex, power, dist) => {
    const p = zoneLocal(spec.deg, lx, ly, lz);
    const l = new THREE.PointLight(hex, power, dist, 2);
    l.position.copy(p);
    l.castShadow = false;
    g.add(l);
    return l;
  };
  addLight(0, ez, 12, 0xd6e8ff, 2100, 70);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    addLight(Math.sin(a) * 152, Math.cos(a) * 152, ZONE_CEIL_Y - 5, 0xc8dcf4, 1500, 62);
  }
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    addLight(Math.sin(a) * 64, Math.cos(a) * 64, 22, spec.accentHex, 1200, 58);
  }

  /* --- Content ---------------------------------------------------------- */
  const CONTENT = {
    canteen: buildCanteen,
    gym: buildGym,
    habitation: buildHabitation,
    construction: buildConstruction,
  };
  const build = CONTENT[spec.id];
  if (build) build(ctx);
  else console.warn(`[station] zone "${spec.id}" has no content builder`);

  B.flush(g, M, `zone:${spec.id}`, { cast: true, recv: true, room: { cast: false, recv: false }, holo: { cast: false, recv: false } });

  world._mmCircle(centre.x, centre.z, ZONE_R, 'rgba(30,48,66,0.45)', 'rgba(150,215,255,0.55)');
  world._mmCircle(centre.x, centre.z, ZONE_COURT_R, 'rgba(46,70,94,0.35)', 'rgba(120,180,220,0.4)');
  return ctx;
}

export { ZONE_COURT_R, ZONE_CEIL_Y, LINK_W };
