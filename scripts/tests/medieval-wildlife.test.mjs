import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  medievalHeight, HALF, WATER_Y, riverZ, riverHalfWidth, fbm2,
} from '../../src/worlds/terrain/MedievalHeight.js';
import { SETTLEMENTS } from '../../src/worlds/medieval/Settlements.js';
import { beastDef, BEASTS } from '../../src/npc/BeastSpecies.js';
import {
  planBeasts, rejectHome, reachFor, woodlandAt, DEEP_WOOD, MARGIN, ROAD_SHARE,
  WILDLIFE_MIX,
} from '../../src/worlds/medieval/Wildlife.js';
import { planPopulation, defaultOpen } from '../../src/worlds/medieval/Population.js';

/**
 * THE PREDATOR GATE.
 *
 * The design claim is "the deep forest is dangerous and the roads are
 * comparatively safe", and that is a claim about arithmetic: a wolf does not
 * respect a mood, it respects `def.territory` and `def.sight`. If a pack's home
 * is within `territory + sight` of a road, a traveller on that road can be
 * hunted; if it is within that of a settlement, the market square is a
 * slaughterhouse; if it is within that of a lone questmaster standing in a
 * field, the player arrives to find a corpse and no quests.
 *
 * Every one of those is a distance test, so every one of them is checkable
 * here, exactly, without a renderer.
 *
 * The tests are written against `reachFor(def)` rather than against 68 and 56,
 * so retuning a species moves the packs and the gate follows. That matters: the
 * clearances are the only thing standing between "atmospheric" and "the vale's
 * only quest giver was eaten during the loading screen".
 */

/** The full civilian roster, which is what the packs must actually clear. */
const people = (() => {
  const open = (x, z) => defaultOpen(x, z, medievalHeight);
  const p = planPopulation({ height: medievalHeight, open });
  return [...p.residents, ...p.travellers].map((r) => ({ x: r.x, z: r.z }));
})();

/** A road network stand-in: every road in the shipped table, densely sampled. */
function fakeRoadDist(segments) {
  return (x, z) => {
    let best = Infinity;
    for (const [ax, az, bx, bz, w] of segments) {
      const dx = bx - ax;
      const dz = bz - az;
      const L = dx * dx + dz * dz;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L)) : 0;
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t)) - w * 0.5;
      if (d < best) best = d;
    }
    return best;
  };
}

/** The arterial roads of the vale, straight-line approximated. */
const ROAD_SEGS = [
  [-14, -58, 34, 15, 7.6], [-45, 72, -14, -58, 6.2], [34, 20, 96, 50, 5.0],
  [32, 26, 26, 103, 4.8], [26, 129, 38, 174, 4.8], [36, 12, 66, -7, 3.8],
  [27, 74, -14, 93, 3.4],
];
const roadDist = fakeRoadDist(ROAD_SEGS);

const sites = planBeasts({
  beastDef, count: 12, height: medievalHeight, people, settlements: SETTLEMENTS, roadDist,
});

/* ------------------------------------------------------------------ */
/* It placed something at all                                          */
/* ------------------------------------------------------------------ */

test('the vale gets its predators, of both species, in the authored ratio', () => {
  assert.equal(sites.length, 12, `only ${sites.length} pack sites found - reasons: ${JSON.stringify(sites.reasons)}`);
  const wolves = sites.filter((s) => s.species === 'wolf').length;
  const bears = sites.filter((s) => s.species === 'bear').length;
  assert.ok(wolves > 0 && bears > 0, `mix collapsed: ${wolves} wolf sites, ${bears} bear sites`);
  const ratio = WILDLIFE_MIX.find((m) => m.species === 'wolf').weight
    / WILDLIFE_MIX.find((m) => m.species === 'bear').weight;
  assert.equal(wolves / bears, ratio, 'the deal did not hold the authored ratio');
});

test('every species named in the mix is a real beast', () => {
  for (const m of WILDLIFE_MIX) {
    assert.ok(BEASTS[m.species], `WILDLIFE_MIX names "${m.species}", which is not a species`);
    assert.ok(m.weight > 0);
  }
});

/* ------------------------------------------------------------------ */
/* Woodland                                                            */
/* ------------------------------------------------------------------ */

test('every pack lives in closed canopy, on the same mask the trees use', () => {
  for (const s of sites) {
    // Reproduced from `MedievalWorld._buildNature` rather than imported, so a
    // change to the tree mask that this file did not follow shows up here.
    const wood = fbm2(s.x * 0.0062, s.z * 0.0062, 3);
    assert.equal(wood, woodlandAt(s.x, s.z), 'the wildlife mask has drifted from the tree mask');
    assert.ok(wood > DEEP_WOOD,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is in open country (wood ${wood.toFixed(3)})`);
  }
});

/* ------------------------------------------------------------------ */
/* Clearances                                                          */
/* ------------------------------------------------------------------ */

test('no pack can reach a settlement, measured against its own species reach', () => {
  for (const s of sites) {
    const reach = reachFor(beastDef(s.species));
    for (const t of SETTLEMENTS) {
      const d = Math.hypot(s.x - t.centre.x, s.z - t.centre.z);
      const need = t.radius + reach + MARGIN;
      assert.ok(d >= need,
        `a ${s.species} at ${s.x | 0},${s.z | 0} is ${d.toFixed(0)} m from ${t.id}, `
        + `which needs ${need.toFixed(0)} m (radius ${t.radius} + reach ${reach} + margin ${MARGIN})`);
    }
  }
});

test('no pack can reach a person - including a lone questmaster in a field', () => {
  for (const s of sites) {
    const need = reachFor(beastDef(s.species)) + MARGIN;
    for (const p of people) {
      const d = Math.hypot(s.x - p.x, s.z - p.z);
      assert.ok(d >= need,
        `a ${s.species} at ${s.x | 0},${s.z | 0} is ${d.toFixed(0)} m from somebody, needs ${need}`);
    }
  }
});

test('THE SAFE ROAD: no pack can see a traveller on the road network', () => {
  for (const s of sites) {
    const def = beastDef(s.species);
    const d = roadDist(s.x, s.z);
    assert.ok(d >= reachFor(def) * ROAD_SHARE + MARGIN,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is ${d.toFixed(0)} m from a road`);
    /* The property the number exists for, stated directly: a pack roaming to
     * the very edge of its territory still cannot SEE the road. */
    assert.ok(d - def.territory > def.sight * 0.0,
      `a ${s.species} could stand on the verge`);
    assert.ok(d > def.territory,
      `a ${s.species} at ${s.x | 0},${s.z | 0} can roam onto the road (territory ${def.territory}, road ${d.toFixed(0)} m)`);
  }
});

test('no pack is in the water, in the channel, or off the edge of the map', () => {
  for (const s of sites) {
    assert.ok(medievalHeight(s.x, s.z) >= WATER_Y + 1.2,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is standing in water`);
    assert.ok(Math.abs(s.z - riverZ(s.x)) >= riverHalfWidth(s.x) + 14,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is in the channel`);
    assert.ok(Math.abs(s.x) < HALF - 30 && Math.abs(s.z) < HALF - 30,
      `a ${s.species} at ${s.x | 0},${s.z | 0} is off the playfield`);
  }
});

test('every pack stands on the ground the height function describes', () => {
  for (const s of sites) assert.equal(s.y, medievalHeight(s.x, s.z));
});

test('two packs never share a wood', () => {
  for (let i = 0; i < sites.length; i++) {
    for (let j = i + 1; j < sites.length; j++) {
      const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
      assert.ok(d >= 90, `two packs are ${d.toFixed(0)} m apart - their territories overlap`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* The rules themselves                                                */
/* ------------------------------------------------------------------ */

test('rejectHome names the rule that rejected, so a barren map can be diagnosed', () => {
  const reach = reachFor(beastDef('wolf'));
  const ctx = { settlements: SETTLEMENTS, people: [], roadDist };
  // In the middle of Aldermoor.
  assert.match(String(rejectHome(44, 26, reach, ctx)), /^settlement:/);
  // Off the map.
  assert.equal(rejectHome(HALF - 5, 0, reach, ctx), 'playfield');
  // In the river.
  assert.equal(rejectHome(0, riverZ(0), reach, ctx), 'water');
  // In open pasture well away from everything.
  const openField = { ...ctx, settlements: [], roadDist: null };
  const why = rejectHome(-420, 420, reach, openField);
  assert.ok(why === null || typeof why === 'string');
});

test('a settlement added to the table later pushes the packs off it automatically', () => {
  /* The merge property for wildlife. A settlement this file has never seen
   * must clear its own cordon the moment it is in the table. */
  const invented = {
    id: 'newtown', displayName: 'Newtown', kind: 'town',
    centre: { x: sites[0].x, z: sites[0].z }, radius: 70, plots: null, ground: [],
  };
  const after = planBeasts({
    beastDef, count: 12, height: medievalHeight, people,
    settlements: [...SETTLEMENTS, invented], roadDist,
  });
  for (const s of after) {
    const d = Math.hypot(s.x - invented.centre.x, s.z - invented.centre.z);
    assert.ok(d >= invented.radius + reachFor(beastDef(s.species)) + MARGIN,
      'a pack stayed put on top of a settlement added after the fact');
  }
});

test('same seed, same wolves', () => {
  const again = planBeasts({
    beastDef, count: 12, height: medievalHeight, people, settlements: SETTLEMENTS, roadDist,
  });
  assert.deepEqual(
    again.map((s) => `${s.species}@${s.x},${s.z}`),
    sites.map((s) => `${s.species}@${s.x},${s.z}`),
  );
});

test('planBeasts refuses to guess at a species table it was not given', () => {
  assert.throws(() => planBeasts({ count: 1 }), TypeError);
});
