import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PHOTO_CATEGORY,
  PHOTO_CATEGORY_GRANTS,
  photoCategoryGrants,
  type PhotoCategory,
} from '../packages/contracts/src/index.ts';

const sorted = (xs: readonly string[]) => [...xs].sort();

test('a bridge photograph derives nothing, because another module owns the subject', () => {
  const grant = photoCategoryGrants(['bridge']);
  assert.deepEqual(grant.materials, []);
  assert.equal(grant.attaches, false);
  assert.equal(grant.foreign, true);
});

test('bridge alongside facade yields exactly the facade, with no rule needed for the pair', () => {
  const pair = photoCategoryGrants(['bridge', 'facade']);
  const facade = photoCategoryGrants(['facade']);
  assert.deepEqual(sorted(pair.materials), sorted(facade.materials));
  assert.equal(pair.attaches, true);
  assert.equal(pair.foreign, false, 'a frame containing a usable facade is not foreign');
});

test('historic is contagious: one archival tag suppresses every colour in the set', () => {
  const grant = photoCategoryGrants(['facade', 'historic']);
  assert.deepEqual(grant.materials, [], 'an archival wall may have been repainted twice since');
  assert.ok(grant.aspects.includes('facade_material'), 'but it still says what the building looked like');
  assert.equal(grant.historic, true);
});

test('permissions are otherwise the union of the tags', () => {
  const grant = photoCategoryGrants(['facade', 'surface', 'greenery']);
  assert.deepEqual(sorted(grant.materials), ['brick', 'foliage', 'paving']);
  assert.ok(grant.aspects.includes('facade_colour'));
  assert.ok(grant.aspects.includes('paving_material'));
  assert.ok(grant.aspects.includes('tree_size'));
});

test('order of tags does not change the outcome', () => {
  const a = photoCategoryGrants(['greenery', 'bridge', 'facade']);
  const b = photoCategoryGrants(['facade', 'greenery', 'bridge']);
  assert.deepEqual(sorted(a.materials), sorted(b.materials));
  assert.deepEqual(sorted(a.aspects), sorted(b.aspects));
  assert.equal(a.attaches, b.attaches);
});

test('an untagged photograph falls back to facade, matching the review sheet', () => {
  assert.deepEqual(photoCategoryGrants(undefined), photoCategoryGrants([DEFAULT_PHOTO_CATEGORY]));
  assert.deepEqual(photoCategoryGrants([]), photoCategoryGrants([DEFAULT_PHOTO_CATEGORY]));
});

test('only categories that own a subject may bind a photograph to one building', () => {
  const attaching = (Object.keys(PHOTO_CATEGORY_GRANTS) as PhotoCategory[]).filter(
    (c) => PHOTO_CATEGORY_GRANTS[c].attaches,
  );
  assert.deepEqual(sorted(attaching), [
    'arcade', 'cable', 'cornice', 'deck', 'facade', 'landmark',
    'masonry', 'promenade', 'saddle', 'stair', 'truss',
  ]);
});

test('the diffuse categories stay unattachable, however many structural tags are added', () => {
  // The complement matters more than the list above: these name a condition of the scene
  // rather than a thing, so binding one to a single asset would be a category error.
  const loose = (Object.keys(PHOTO_CATEGORY_GRANTS) as PhotoCategory[]).filter(
    (c) => !PHOTO_CATEGORY_GRANTS[c].attaches,
  );
  assert.deepEqual(sorted(loose), [
    'bridge', 'context', 'furniture', 'greenery', 'historic',
    'lawn', 'lighting', 'railing', 'surface', 'waterside',
  ]);
});

test('no structural category grants a measurement', () => {
  // The load-bearing rule of the whole survey: a photograph without scale control in the
  // frame cannot measure, however sharp it is. Sizes come from drawings. If a future edit
  // adds a dimensional aspect to a structural grant, this fails rather than quietly
  // licensing a number read off a picture.
  const structural: PhotoCategory[] = [
    'masonry', 'arcade', 'cornice', 'saddle', 'truss',
    'cable', 'deck', 'promenade', 'stair', 'lighting',
  ];
  const measures = /size|length|width|height|span|thickness|diameter|dimension/i;
  for (const tag of structural) {
    for (const aspect of PHOTO_CATEGORY_GRANTS[tag].aspects) {
      assert.ok(!measures.test(aspect), `${tag} grants the dimensional aspect ${aspect}`);
    }
  }
});

test('every structural category is reachable through the union rule', () => {
  // Guards the pairing a reviewer actually produces: a saddle is photographed against
  // masonry, and the frame is usually archival. The historic tag must suppress the
  // materials without suppressing the arrangement the photograph was kept for.
  const grant = photoCategoryGrants(['saddle', 'masonry', 'historic']);
  assert.deepEqual(grant.materials, [], 'archival ironwork may have been repainted since');
  assert.ok(grant.aspects.includes('connection_detail'));
  assert.ok(grant.aspects.includes('masonry_coursing'));
  assert.equal(grant.attaches, true, 'a saddle is a specific thing, so it still binds');
});

test('every category grants at least one aspect, so no tag is silently inert', () => {
  for (const [name, grant] of Object.entries(PHOTO_CATEGORY_GRANTS)) {
    assert.ok(grant.aspects.length > 0, `${name} grants no aspects`);
  }
});
