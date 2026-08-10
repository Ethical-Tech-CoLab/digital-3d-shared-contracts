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
  assert.deepEqual(sorted(attaching), ['facade', 'landmark']);
});

test('every category grants at least one aspect, so no tag is silently inert', () => {
  for (const [name, grant] of Object.entries(PHOTO_CATEGORY_GRANTS)) {
    assert.ok(grant.aspects.length > 0, `${name} grants no aspects`);
  }
});
