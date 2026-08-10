/**
 * Cross-checks the TypeScript mirror of the review categories against the district's
 * Python implementation, for every subset of tags.
 *
 * Run: node --experimental-strip-types tools/check-photo-categories.mts <python-json>
 * where <python-json> is the output of the district's dump of merged_spec().
 */
import { readFileSync } from 'node:fs';
import {
  PHOTO_CATEGORY_GRANTS,
  photoCategoryGrants,
  type PhotoCategory,
} from '../packages/contracts/src/index.ts';

const reference = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Record<
  string,
  { aspects: string[]; materials: string[]; attaches: boolean; foreign: boolean; historic: boolean }
>;

const sorted = (xs: readonly string[]) => [...xs].sort();
let failures = 0;

for (const [key, want] of Object.entries(reference)) {
  const got = photoCategoryGrants(key.split(',') as PhotoCategory[]);
  const problems: string[] = [];
  if (JSON.stringify(sorted(got.aspects)) !== JSON.stringify(sorted(want.aspects)))
    problems.push(`aspects ${JSON.stringify(sorted(got.aspects))} != ${JSON.stringify(sorted(want.aspects))}`);
  if (JSON.stringify(sorted(got.materials)) !== JSON.stringify(sorted(want.materials)))
    problems.push(`materials ${JSON.stringify(sorted(got.materials))} != ${JSON.stringify(sorted(want.materials))}`);
  if (got.attaches !== want.attaches) problems.push(`attaches ${got.attaches} != ${want.attaches}`);
  if (got.foreign !== want.foreign) problems.push(`foreign ${got.foreign} != ${want.foreign}`);
  if (got.historic !== want.historic) problems.push(`historic ${got.historic} != ${want.historic}`);
  if (problems.length) {
    failures++;
    console.log(`  FAIL ${key}`);
    for (const p of problems) console.log(`       ${p}`);
  }
}

const total = Object.keys(reference).length;
console.log(
  failures
    ? `\n${failures} of ${total} tag combinations disagree with the Python implementation`
    : `all ${total} tag combinations agree, across ${Object.keys(PHOTO_CATEGORY_GRANTS).length} categories`,
);
process.exit(failures ? 1 : 0);
