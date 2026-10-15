// start-local.mjs — `npm run start:local -- --db <path> --port <n>` (BATON_SPEC §3a R-BTN-55):
// bundles src/local/main.ts with the schema migrations and the dashboard as text, as wrangler's
// Text rule does for the Worker, and runs it in this Node.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, '.local');
mkdirSync(OUT, { recursive: true });

/** The dashboard's ES module is served to the browser, never run here: load it as text. */
const uiScriptAsText = {
  name: 'ui-script-as-text',
  setup(b) {
    b.onLoad({ filter: /[\\/]ui[\\/]app\.js$/ }, async (args) => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  },
};

await build({
  entryPoints: [join(ROOT, 'src/local/entry.ts')],
  outfile: join(OUT, 'baton-local.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  loader: { '.sql': 'text', '.html': 'text', '.css': 'text' },
  plugins: [uiScriptAsText],
  logLevel: 'warning',
});
await import(pathToFileURL(join(OUT, 'baton-local.mjs')).href);
