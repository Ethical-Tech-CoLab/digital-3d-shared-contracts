#!/usr/bin/env node
/**
 * Validate documents against the Digital 3D shared contracts.
 *
 * Used three ways:
 *   node tools/validate.mjs                       validate the bundled self-test fixtures
 *   node tools/validate.mjs --schema tour-script path/to/tour.json
 *   node tools/validate.mjs --detect  path/to/*.json     infer the schema from the document shape
 *
 * Module repositories call this in their own build so a malformed manifest is caught where it is
 * produced, not where it is consumed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import process from 'node:process';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCHEMA_DIR = join(ROOT, 'schemas');
const EXAMPLE_DIR = join(ROOT, 'examples');

const SCHEMA_BASE = 'https://contracts.digital-3d.org/v1/';

function loadSchemas() {
  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'));
  return files.map((file) => ({
    file,
    name: file.replace('.schema.json', ''),
    schema: JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')),
  }));
}

function buildAjv(schemas) {
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  for (const { schema } of schemas) ajv.addSchema(schema);
  return ajv;
}

/** Infer which contract a document claims to satisfy, from its own fields. */
function detectSchema(doc) {
  if (doc && typeof doc === 'object') {
    if ('tour_id' in doc && 'stops' in doc) return 'tour-script';
    if ('observations' in doc) return 'photo-survey';
    if ('prototypes' in doc && 'instances' in doc) return 'scene-props';
    if ('layers' in doc && 'default_layer' in doc) return 'basemap';
    if ('authoritative_for' in doc && 'modes' in doc) return 'module-manifest';
    if ('scheme' in doc && 'tiles' in doc) return 'tile-index';
    if ('assets' in doc && 'ladder_id' in doc) return 'asset-registry';
    if ('levels' in doc && 'selection' in doc) return 'lod';
    if ('anchor' in doc && 'render_convention' in doc) return 'georeference';
    if ('sources' in doc && 'grades' in doc) return 'source-confidence';
    if ('asset_id' in doc && 'category' in doc) return 'metadata';
  }
  return null;
}

function formatErrors(errors) {
  return errors
    .map((e) => `      ${e.instancePath || '/'} ${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ''}`)
    .join('\n');
}

function validateFile(ajv, schemaName, filePath) {
  const validate = ajv.getSchema(`${SCHEMA_BASE}${schemaName}.schema.json`);
  if (!validate) {
    console.error(`  ! unknown schema '${schemaName}'`);
    return false;
  }
  let doc;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`  FAIL ${basename(filePath)}: not valid JSON: ${error.message}`);
    return false;
  }
  const ok = validate(doc);
  if (ok) {
    console.log(`  ok   ${basename(filePath)}  [${schemaName}]`);
    return true;
  }
  console.error(`  FAIL ${basename(filePath)}  [${schemaName}]`);
  console.error(formatErrors(validate.errors ?? []));
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const schemas = loadSchemas();
  const ajv = buildAjv(schemas);

  // Every schema must at minimum compile.
  let failures = 0;
  for (const { name } of schemas) {
    const compiled = ajv.getSchema(`${SCHEMA_BASE}${name}.schema.json`);
    if (!compiled) {
      console.error(`  FAIL schema '${name}' did not compile or has an unexpected $id`);
      failures++;
    }
  }
  if (failures) {
    console.error(`\n${failures} schema(s) failed to compile`);
    process.exit(1);
  }
  console.log(`compiled ${schemas.length} schemas`);

  let targets = [];
  let forced = null;

  const schemaFlag = args.indexOf('--schema');
  if (schemaFlag >= 0) {
    forced = args[schemaFlag + 1];
    targets = args.slice(schemaFlag + 2);
  } else {
    targets = args.filter((a) => !a.startsWith('--'));
  }

  if (!targets.length) {
    targets = readdirSync(EXAMPLE_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => join(EXAMPLE_DIR, f));
    console.log(`\nvalidating ${targets.length} bundled fixture(s)`);
  } else {
    console.log(`\nvalidating ${targets.length} document(s)`);
  }

  for (const target of targets) {
    const path = resolve(target);
    let schemaName = forced;
    if (!schemaName) {
      try {
        schemaName = detectSchema(JSON.parse(readFileSync(path, 'utf8')));
      } catch {
        schemaName = null;
      }
    }
    if (!schemaName) {
      console.error(`  FAIL ${basename(path)}: could not infer a schema; pass --schema <name>`);
      failures++;
      continue;
    }
    if (!validateFile(ajv, schemaName, path)) failures++;
  }

  if (failures) {
    console.error(`\n${failures} document(s) failed validation`);
    process.exit(1);
  }
  console.log('\nall documents valid');
}

main();
