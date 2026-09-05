/**
 * The bag shows the merchant's picture.
 *
 * Reported from play: "when i purchase things from the merchant ... the
 * inventory images do not match to the merchants". They never matched. The
 * merchant renders `item.image` from the catalogue row; every bag cell calls
 * `itemIconSVG(id)`, which draws a procedural SVG from the item's `kind`; and
 * `ItemDefs` has no image field, so the bag could not have reached the
 * catalogue's art even in principle.
 *
 * It only became visible when merchants started showing real pictures instead
 * of a category emoji - the same Field Medkit is a photograph in the shop and a
 * green cross in the bag.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { itemIconSVG, setItemArt, itemArtFor } from '../../src/systems/ItemDefs.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('with no catalogue art, the procedural icon is unchanged', () => {
  setItemArt(new Map());
  const out = itemIconSVG('medkit', 44);
  assert.match(out, /^<svg/, 'an item the shop has no picture for keeps its icon');
  assert.equal(itemArtFor('medkit'), null);
});

test('catalogue art replaces the procedural icon at the requested size', () => {
  setItemArt(new Map([['medkit', PNG]]));
  const out = itemIconSVG('medkit', 44);
  assert.match(out, /^<img/, 'the bag must draw the picture the shop draws');
  assert.ok(out.includes(PNG), 'and it must be that exact image');
  assert.ok(out.includes('width="44"'), 'honouring the size the panel asked for');
});

test('an item with no art still falls back while others use theirs', () => {
  /* The catalogue does not cover the whole bag - loot, quest items and world
   * drops have no shop row - so the fallback is the common case, not an edge. */
  setItemArt(new Map([['medkit', PNG]]));
  assert.match(itemIconSVG('medkit'), /^<img/);
  assert.match(itemIconSVG('alloy_scrap'), /^<svg/);
});

test('setItemArt replaces rather than accumulates', () => {
  /* It is called once per catalogue load, and a vendor in another world stocks
   * a different set. Accumulating would leave a previous world's art on items
   * this vendor does not sell. */
  setItemArt(new Map([['medkit', PNG]]));
  setItemArt(new Map([['bullet', PNG]]));
  assert.equal(itemArtFor('medkit'), null);
  assert.equal(itemArtFor('bullet'), PNG);
});

test('rubbish in the map cannot reach the DOM', () => {
  setItemArt({ medkit: '', bullet: null, arrow: 42, ok: PNG });
  assert.equal(itemArtFor('medkit'), null, 'an empty string is not artwork');
  assert.equal(itemArtFor('bullet'), null);
  assert.equal(itemArtFor('arrow'), null, 'a non-string must never be interpolated into src');
  assert.equal(itemArtFor('ok'), PNG);
  setItemArt(new Map());
});

test('Marketplace maps catalogue rows onto the bag items they grant', async () => {
  const { Marketplace } = await import('../../src/systems/Marketplace.js');
  const m = new Marketplace({ ui: false });

  /* Rows shaped like the real catalogue: a consumable that grants a bag item,
   * an ammo pack, and a livery that grants nothing a bag can hold. */
  m._catalog = [
    { source_key: 'pack_medkit:station', image: 'IMG_MEDKIT' },
    { source_key: 'pack_bullets:station', image: 'IMG_BULLET' },
    { source_key: 'skin_kingfisher:station', image: 'IMG_LIVERY' },
    { source_key: 'pack_medkit:dock', image: 'IMG_MEDKIT_DOCK' },
  ];
  m._publishItemArt();

  assert.equal(itemArtFor('medkit'), 'IMG_MEDKIT', 'the consumable gets the shop art');
  assert.equal(itemArtFor('bullet'), 'IMG_BULLET');
  /* A livery has artwork and no bag cell. Mapping it would paint that picture
   * onto whatever item id happened to collide. */
  assert.equal(itemArtFor('skin_kingfisher'), null, 'a non-bag grant must map nothing');

  setItemArt(new Map());
});

test('a row with no image contributes nothing', () => {
  /* Un-baked rows carry an empty image and the shop draws a placeholder for
   * them. The bag must keep its icon rather than render an empty src. */
  const out = itemIconSVG('medkit');
  assert.match(out, /^<svg/);
});
