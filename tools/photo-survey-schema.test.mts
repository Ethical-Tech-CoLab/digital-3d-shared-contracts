/**
 * Negative proofs for the photo-survey relaxations.
 *
 * Two constraints in this schema were loosened so a harvested archival corpus could be
 * expressed at all: a camera position may be missing, and a timestamp may be truncated.
 * Loosening a rule is where contracts rot, because the relaxation is visible in review and
 * the remaining constraint is not. Each test below feeds the schema the exact defect the
 * relaxation was shaped around and asserts it is still refused.
 *
 * The positive cases live in examples/photo-survey.fixture.json; these are the ones that
 * must fail, which no fixture can express.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
const ID = 'https://contracts.digital-3d.org/v1/photo-survey.schema.json';

const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);
for (const f of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'))) {
  ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')));
}
const validate = ajv.getSchema(ID)!;

/** A minimal valid survey with one observation, merged with the defect under test. */
function survey(observation: Record<string, unknown>) {
  return {
    contract_version: '1.0.0',
    module_id: 'example-module',
    frame_id: 'frame-1',
    observations: [
      {
        observation_id: 'obs_0001',
        license: 'CC0-1.0',
        usage: 'redistribute',
        review: { status: 'auto_screened' },
        ...observation,
      },
    ],
  };
}

const ok = (o: Record<string, unknown>) => validate(survey(o)) as boolean;

test('a missing position is legal only when the record declares it unknown', () => {
  assert.ok(ok({ position_source: 'unknown' }), 'archival plate with no camera fix');
  assert.ok(!ok({}), 'position dropped with no explanation at all');
  assert.ok(
    !ok({ position_source: 'exif_gps' }),
    'claims a GPS fix and then has none — a survey that lost its position, not an archive photo',
  );
});

test('a present position is unaffected by the relaxation', () => {
  assert.ok(ok({ position: { lon: -73.99, lat: 40.7 }, position_source: 'exif_gps' }));
});

test('a truncated date is legal, and free text is not', () => {
  assert.ok(ok({ position_source: 'unknown', captured_at: '1898', captured_precision: 'year' }));
  assert.ok(ok({ position_source: 'unknown', captured_at: '1890s', captured_precision: 'decade' }));
  assert.ok(ok({ position_source: 'unknown', captured_at: '2016-06', captured_precision: 'month' }));
  // The literal string a truncating harvester produced from "Taken on 2 June 2016".
  assert.ok(
    !ok({ position_source: 'unknown', captured_at: 'Taken on 2', captured_precision: 'day' }),
    'scraped free text must not pass as a date',
  );
  assert.ok(!ok({ position_source: 'unknown', captured_at: '16-06-02' }), 'ambiguous two-digit year');
});

test('stated precision may not exceed what the timestamp carries', () => {
  assert.ok(
    !ok({ position_source: 'unknown', captured_at: '2016', captured_precision: 'day' }),
    'a year cannot be day-precise',
  );
  assert.ok(
    !ok({ position_source: 'unknown', captured_at: '2016-06-02', captured_precision: 'exact' }),
    'a date with no time cannot be exact',
  );
  assert.ok(ok({ position_source: 'unknown', captured_at: '2016-06-02', captured_precision: 'day' }));
  assert.ok(
    ok({ position_source: 'unknown', captured_at: '2016-06-02T14:23:11Z', captured_precision: 'exact' }),
  );
});

test('structural categories are accepted and typos are still caught', () => {
  assert.ok(ok({ position_source: 'unknown', category: 'saddle', categories: ['saddle', 'masonry'] }));
  assert.ok(!ok({ position_source: 'unknown', category: 'sadle' }), 'near-miss must not slip through');
});

test('an observation may not name a dimensional aspect', () => {
  assert.ok(
    ok({
      position_source: 'unknown',
      observes: [{ asset_id: 'urn:d3d:example-module:saddle', aspect: ['connection_detail'] }],
    }),
  );
  assert.ok(
    !ok({
      position_source: 'unknown',
      observes: [{ asset_id: 'urn:d3d:example-module:saddle', aspect: ['span_length'] }],
    }),
    'the vocabulary has no dimensional member, and inventing one must not validate',
  );
});
