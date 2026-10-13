#!/usr/bin/env node
// vendor.mjs — copy Baton's decision library from a sibling `docs` checkout (BATON_SPEC §3,
// R-BTN-37).
//
//   npm run vendor                   copy docs/scripts/lib/{baton,vocabulary}.mjs into
//                                    src/shared/ and rewrite src/shared/manifest.json
//   npm run vendor -- --check        exit 1 when a copy differs from the sibling checkout
//   DOCS_DIR=<path> npm run vendor   use a docs checkout somewhere else (default ../docs)
//
// docs is private, so this repository's CI cannot read it: the copies are committed, and the
// manifest pins each one by the docs commit it came from and its SHA-256. The test suite
// checks the copies against the manifest on every run, and against the sibling checkout
// wherever one exists (test/unit/shared.test.ts).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHARED = ['baton.mjs', 'vocabulary.mjs'];
export const docsDir = () => resolve(process.env.DOCS_DIR ?? join(ROOT, '..', 'docs'));
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function main(argv) {
  const docs = docsDir();
  if (!existsSync(join(docs, 'scripts/lib/baton.mjs'))) {
    console.error(`vendor: no docs checkout at ${docs} (set DOCS_DIR)`);
    process.exit(1);
  }
  const check = argv.includes('--check');
  let drift = 0;
  const files = {};
  for (const name of SHARED) {
    const src = readFileSync(join(docs, 'scripts/lib', name));
    const dest = join(ROOT, 'src/shared', name);
    files[name] = sha256(src);
    const cur = existsSync(dest) ? readFileSync(dest) : null;
    if (cur && sha256(cur) === files[name]) continue;
    if (check) {
      console.error(`✗ src/shared/${name} differs from ${docs}/scripts/lib/${name} — run npm run vendor`);
      drift++;
    } else {
      writeFileSync(dest, src);
      console.log(`vendored ${name}`);
    }
  }
  if (check) {
    if (drift) process.exit(1);
    return console.log('✓ src/shared matches the docs checkout');
  }
  const commit = execFileSync('git', ['-C', docs, 'log', '-n1', '--format=%H', '--', ...SHARED.map((n) => `scripts/lib/${n}`)], { encoding: 'utf8' }).trim();
  const manifest = { $comment: 'Written by scripts/vendor.mjs (R-BTN-37): the docs commit these copies were taken from and their SHA-256. Never edit the copies here; change them in docs and re-vendor.', docs_commit: commit, files };
  writeFileSync(join(ROOT, 'src/shared/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`manifest: docs@${commit.slice(0, 8)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
