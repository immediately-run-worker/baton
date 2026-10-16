#!/usr/bin/env node
// check-wiki.mjs — check content/, Baton's wiki: the tickets and the pages around them, opened
// on immediately.run by Grove (package.json "immediately.run" → content/immediately.run.json).
//
//   npm run check:wiki                 check every page; exit 1 on any error
//   node scripts/check-wiki.mjs DIR    check another content root (the self-test uses this)
//
// Every page:
//   - has YAML frontmatter with `title` and `description` (a `_layout.mdx` needs only the latter);
//   - compiles as MDX — a bare `<word>` or `{word}` in prose fails here, as it would in Grove;
//   - uses only Grove's built-in components and the ones content/immediately.run.json registers;
//   - has no `import`/`export` and no `{expression}` other than a `{/* comment */}`;
//   - links ([text](path) and [[path]]) only to files that exist, relative to the page.
// Every ticket (a file under roadmap/ or roadmap/archive/ named like an id):
//   - matches roadmap/item.schema.json: its required keys, no other keys, the id pattern and the
//     status enum;
//   - is named after its id; is `done` in the archive and never `done` outside it;
//   - depends only on tickets that exist, live or archived.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { compile, createProcessor } from '@mdx-js/mdx';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(process.argv[2] ?? join(REPO, 'content'));

/** Grove's built-in components (grove's viewer.manifest.json), always in scope in an entry. */
const GROVE = ['Backlinks', 'Callout', 'ChildPages', 'Directory', 'DirectoryList', 'DocList', 'DocsByTag',
  'FamilyTree', 'GroveFooter', 'GroveNav', 'GroveSidebar', 'Infobox', 'Kbd', 'KeyValue', 'LayoutGallery',
  'Lede', 'More', 'Outlet', 'PageMeta', 'Quote', 'RecentlyUpdated', 'TableOfContents', 'TagCloud', 'TagList',
  'ThemeGallery', 'Timeline', 'Toc'];

const errors = [];
const fail = (file, msg) => errors.push(`${relative(ROOT, file) || file}: ${msg}`);

const marker = JSON.parse(readFileSync(join(ROOT, 'immediately.run.json'), 'utf8'));
const components = new Set([...GROVE, ...Object.keys(marker.components ?? {})]);
const schema = JSON.parse(readFileSync(join(ROOT, 'roadmap', 'item.schema.json'), 'utf8'));
const idPattern = new RegExp(schema.definitions.itemId.pattern);
const statuses = schema.properties.status.enum;
const allowedKeys = new Set(schema.propertyNames.enum);

/** Every .mdx under the root, except the components folder and `_`-prefixed folders. */
function pages(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'components' || name.startsWith('_') ? [] : pages(path);
    return name.endsWith('.mdx') ? [path] : [];
  });
}

/** Frontmatter and body; the frontmatter's lines are blanked in the body so positions hold. */
function split(file, text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) { fail(file, 'no YAML frontmatter'); return { meta: {}, body: text }; }
  let meta = {};
  try { meta = parseYaml(m[1]) ?? {}; } catch (e) { fail(file, `frontmatter is not YAML: ${e.message.split('\n')[0]}`); }
  return { meta, body: '\n'.repeat(m[0].split('\n').length - 1) + text.slice(m[0].length) };
}

/** A relative link target, resolved against the page; null for external links and anchors. */
function target(file, url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('/')) return null;
  const path = decodeURIComponent(url.split('#')[0]);
  return path ? resolve(dirname(file), path) : null;
}

function walk(node, visit) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

const tickets = new Map(); // id → { file, meta, archived }
const files = pages(ROOT);
const processor = createProcessor();

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const { meta, body } = split(file, text);
  const name = file.split(sep).pop();
  if (name !== '_layout.mdx' && typeof meta.title !== 'string') fail(file, 'frontmatter has no title');
  if (typeof meta.description !== 'string') fail(file, 'frontmatter has no description');

  const rel = relative(ROOT, file).split(sep);
  const archived = rel[0] === 'roadmap' && rel[1] === 'archive' && rel.length === 3;
  const live = rel[0] === 'roadmap' && rel.length === 2;
  const stem = name.replace(/\.mdx$/, '');
  if ((live || archived) && idPattern.test(stem)) {
    for (const key of schema.required) if (!(key in meta)) fail(file, `ticket has no ${key}`);
    for (const key of Object.keys(meta)) if (!allowedKeys.has(key)) fail(file, `ticket has an unknown key ${key}`);
    if (meta.id !== stem) fail(file, `id ${meta.id} does not match the file name`);
    if (!statuses.includes(meta.status)) fail(file, `status ${meta.status} is not one of ${statuses.join(', ')}`);
    if (archived && meta.status !== 'done') fail(file, `an archived ticket is done, not ${meta.status}`);
    if (live && meta.status === 'done') fail(file, 'a done ticket belongs in roadmap/archive/');
    if (tickets.has(stem)) fail(file, `${stem} is also ${relative(ROOT, tickets.get(stem).file)}`);
    tickets.set(stem, { file, meta });
  }

  try {
    await compile(body);
  } catch (e) {
    fail(file, `does not compile as MDX: ${e.reason ?? e.message} (line ${e.line ?? e.place?.line ?? '?'}) — put code-like text in backticks, or escape < and { as \\< and \\{`);
    continue;
  }

  walk(processor.parse(body), (node) => {
    const line = node.position?.start.line;
    if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name && /^[A-Z]/.test(node.name) && !components.has(node.name)) {
      fail(file, `line ${line}: <${node.name}> is neither a Grove component nor registered in immediately.run.json`);
    }
    if (node.type === 'mdxjsEsm') fail(file, `line ${line}: import/export is not allowed in a page`);
    if ((node.type === 'mdxFlowExpression' || node.type === 'mdxTextExpression') && node.data?.estree?.body.length) {
      fail(file, `line ${line}: {${node.value.trim().slice(0, 30)}} is an expression; only {/* comments */} are allowed`);
    }
    if (node.type === 'link' || node.type === 'definition') {
      const path = target(file, node.url);
      if (path && !existsSync(path)) fail(file, `line ${line}: link to ${node.url}, which does not exist`);
    }
    if (node.type === 'text') {
      for (const [, link] of node.value.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
        const path = target(file, link.trim());
        if (path && !existsSync(path)) fail(file, `line ${line}: [[${link}]] does not exist`);
      }
    }
  });

}

for (const [id, { file, meta }] of tickets) {
  const deps = meta.depends_on ?? [];
  if (!Array.isArray(deps)) { fail(file, 'depends_on is not a list'); continue; }
  for (const dep of deps) {
    if (!idPattern.test(String(dep))) fail(file, `depends_on ${dep} is not a ticket id`);
    else if (!tickets.has(dep)) fail(file, `depends_on ${dep}, which is not a ticket here`);
    else if (dep === id) fail(file, 'depends on itself');
  }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`check-wiki: ${errors.length} error(s) in ${files.length} page(s)`);
  process.exit(1);
}
console.log(`check-wiki OK: ${files.length} page(s), ${tickets.size} ticket(s)`);
