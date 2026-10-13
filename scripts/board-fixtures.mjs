#!/usr/bin/env node
// board-fixtures.mjs — regenerate test/fixtures/boards.json, the board states S-BTN-13 posts,
// by running the real docs code over the fixture repository (test/lib/fixtureRepo.mjs).
//
//   npm run fixtures                  write test/fixtures/boards.json
//   DOCS_DIR=<path> npm run fixtures  use a docs checkout somewhere else (default ../docs)
//
// The file is committed because CI here cannot read docs (R-BTN-37); the test suite
// recomputes it and fails on drift wherever a sibling docs checkout exists.
import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixtureRepo, boardStates } from '../test/lib/fixtureRepo.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = resolve(process.env.DOCS_DIR ?? join(ROOT, '..', 'docs'));
if (!existsSync(join(docs, 'scripts/factory-state.mjs'))) {
  console.error(`board-fixtures: no docs checkout at ${docs} (set DOCS_DIR)`);
  process.exit(1);
}
const repo = buildFixtureRepo();
const states = await boardStates(repo, docs);
writeFileSync(join(ROOT, 'test/fixtures/boards.json'), JSON.stringify({ shas: repo.shas, states }, null, 2) + '\n');
console.log(`wrote test/fixtures/boards.json (${Object.keys(states).join(', ')})`);
