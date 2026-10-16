#!/usr/bin/env node
// check-model-links.mjs — `npm run model:links` (R3-1244; owner, 2026-10-15: code and model kept
// in sync, checkably). Each action of model/baton.qnt names its implementation in the comment
// above it — `// @impl src/core/<file>.ts#<function>` — or `// @impl external — <who>` for a
// step only the environment takes (a worker's push, git, time). Each implementing function names
// the action back in its own leading comment, with a hash of the action's text:
// `// @model <action> sha256:<12 hex>`. A missing end, a function that is not there, or a stale
// hash fails, naming them — so a model change names the functions to re-check, and re-stamping
// the hash (`--stamp` prints the current ones) is the reviewed step.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'model/baton.qnt';

/** The model's actions: name → { text, impls: [{file, fn} | {external}] }, from the module's
 *  top level. An action's text runs from its `action` line to the line before the next
 *  top-level declaration or comment. */
export function modelActions(src) {
  const lines = src.split('\n');
  const top = /^ {2}(\/\/|action |pure |def |val |type |var |const |run |temporal |\})/;
  const actions = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}action (\w+)/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !top.test(lines[j]) && !/^\}/.test(lines[j])) j++;
    const body = lines.slice(i, j).map((l) => l.replace(/\s+$/, ''));
    while (body.length && body.at(-1) === '') body.pop();
    const impls = [];
    for (let k = i - 1; k >= 0 && /^ {2}\/\//.test(lines[k]); k--) {
      const im = /@impl (src\/[\w/.-]+\.ts)#(\w+)/.exec(lines[k]);
      if (im) impls.push({ file: im[1], fn: im[2] });
      else if (/@impl external/.test(lines[k])) impls.push({ external: true });
    }
    actions.set(m[1], { text: body.join('\n'), impls, line: i + 1 });
  }
  return actions;
}

export const hashOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);

/** Every top-level declaration of the module: name → text (round 1, 1-A-6). */
export function declarations(src) {
  const lines = src.split('\n');
  const top = /^ {2}(\/\/|action |pure |def |val |type |var |const |run |temporal |\})/;
  const decls = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}(?:pure def|def|pure val|val|action|type|var|const) (\w+)/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !top.test(lines[j]) && !/^\}/.test(lines[j])) j++;
    const body = lines.slice(i, j).map((l) => l.replace(/\s+$/, ''));
    while (body.length && body.at(-1) === '') body.pop();
    decls.set(m[1], body.join('\n'));
  }
  return decls;
}

/** The text an action's meaning rests on: its own, and every declaration it reaches — the helpers,
 *  the gates, the judge, the course and the state's type — each once, in name order. A change to
 *  any of them changes the hash, so the functions that implement the action are re-checked. */
export function closureText(name, decls) {
  const seen = new Set([name]);
  const queue = [name];
  while (queue.length) {
    const text = decls.get(queue.shift()) ?? '';
    for (const id of text.match(/[A-Za-z_]\w*/g) ?? []) if (decls.has(id) && !seen.has(id)) { seen.add(id); queue.push(id); }
  }
  return [decls.get(name), ...[...seen].filter((n) => n !== name).sort().map((n) => decls.get(n))].join('\n\n');
}

/** The leading comment of `fn` in `src` (a method or function), or null when it is not there. */
export function leadingComment(src, fn) {
  const lines = src.split('\n');
  const def = new RegExp(`^\\s*(export\\s+)?(async\\s+)?(function\\s+)?(private\\s+|public\\s+)?(async\\s+)?${fn}\\s*(<[^>]*>)?\\(`);
  const at = lines.findIndex((l) => def.test(l));
  if (at < 0) return null;
  const out = [];
  for (let k = at - 1; k >= 0 && /^\s*(\/\/|\/\*\*|\*|\*\/)/.test(lines[k]); k--) out.unshift(lines[k]);
  return out.join('\n');
}

export function check(root = ROOT) {
  const errors = [];
  const src = readFileSync(join(root, MODEL), 'utf8');
  const actions = modelActions(src);
  const decls = declarations(src);
  for (const [name, a] of actions) a.text = closureText(name, decls);
  const files = new Map();
  const read = (f) => {
    if (!files.has(f)) files.set(f, existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : null);
    return files.get(f);
  };
  for (const [name, a] of actions) {
    if (!a.impls.length) { errors.push(`${MODEL}:${a.line}: action ${name} names no implementation (// @impl src/core/<file>.ts#<fn> or // @impl external — <who>)`); continue; }
    const want = `@model ${name} sha256:${hashOf(a.text)}`;
    for (const im of a.impls) {
      if (im.external) continue;
      const src = read(im.file);
      if (src == null) { errors.push(`action ${name}: ${im.file} does not exist`); continue; }
      const comment = leadingComment(src, im.fn);
      if (comment == null) { errors.push(`action ${name}: ${im.file} has no function ${im.fn}`); continue; }
      const back = [...comment.matchAll(new RegExp(`@model ${name} sha256:([0-9a-f]{12})`, 'g'))];
      if (!back.length) errors.push(`${im.file}#${im.fn} does not name action ${name} back (// ${want})`);
      else if (back[0][1] !== hashOf(a.text)) errors.push(`${im.file}#${im.fn}: action ${name} changed (now sha256:${hashOf(a.text)}, stamped ${back[0][1]}) — re-check the function against it, then re-stamp`);
    }
  }
  // and every back-link names an action that names it
  for (const [f, src] of [...listSources(root)].map((f) => [f, read(f)])) {
    if (!src) continue;
    for (const m of src.matchAll(/@model (\w+) sha256:[0-9a-f]{12}/g)) {
      const a = actions.get(m[1]);
      if (!a) { errors.push(`${f}: @model ${m[1]} names no action of ${MODEL}`); continue; }
      if (!a.impls.some((im) => im.file === f)) errors.push(`${f}: @model ${m[1]}, but the action does not name ${f}`);
    }
  }
  return { errors, actions };
}

function listSources(root) {
  const out = new Set(readdirSync(join(root, 'src/core')).filter((f) => f.endsWith('.ts')).map((f) => `src/core/${f}`));
  for (const a of modelActions(readFileSync(join(root, MODEL), 'utf8')).values()) for (const im of a.impls) if (im.file) out.add(im.file);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { errors, actions } = check();
  if (process.argv.includes('--stamp')) for (const [n, a] of actions) console.log(`${n}: @model ${n} sha256:${hashOf(a.text)}  (${a.impls.map((i) => (i.external ? 'external' : `${i.file}#${i.fn}`)).join(', ')})`);
  for (const e of errors) console.log(`✗ ${e}`);
  if (!errors.length) console.log(`✓ every action of ${MODEL} and its implementation name each other; hashes current (${actions.size} actions)`);
  process.exit(errors.length ? 1 : 0);
}
