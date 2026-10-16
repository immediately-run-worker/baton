#!/usr/bin/env node
// baton-run.mjs — `baton run`'s bundle (BATON_SPEC §6.13 R-BTN-72): bundles src/runner/main.ts
// with esbuild the way scripts/start-local.mjs bundles the local host, and re-exports its
// `runMain`. The bundle lands in `.local/` (gitignored) and is rebuilt on every start, so the
// runner a checkout runs is always its current source.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.local', 'baton-run.mjs');
mkdirSync(join(ROOT, '.local'), { recursive: true });

await build({
  entryPoints: [join(ROOT, 'src/runner/main.ts')],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  loader: { '.json': 'json' },
  logLevel: 'warning',
});

export const { runMain } = await import(pathToFileURL(OUT).href);
