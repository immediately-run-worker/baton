// boundary-host.test.ts — R-BTN-55, G-BTN-56: a check, not a convention. Nothing under
// src/core/ names the Cloudflare platform — no `cloudflare:*` import, no Durable Object type,
// no `ctx` — so the same core runs on the local host; and the local host imports none of it.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|mjs|js)$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** `src` with comments removed, so prose about the platform does not count. */
const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PLATFORM = [
  /['"]cloudflare:[a-z]+['"]/,
  /\bctx\b/,
  /\bDurableObject[A-Za-z]*\b/,
  /\bSqlStorage[A-Za-z]*\b/,
  /\bExportedHandler\b/,
  /\bwaitUntil\s*\(/,
];

describe('the host boundary (R-BTN-55)', () => {
  it('src/core/ imports nothing from Cloudflare and reads no ctx', () => {
    const hits = files(join(ROOT, 'src/core')).flatMap((p) => {
      const text = code(p);
      return PLATFORM.filter((re) => re.test(text)).map((re) => `${relative(ROOT, p)}: ${re}`);
    });
    expect(hits).toEqual([]);
  });

  it('src/local/ imports nothing from Cloudflare or src/cloudflare/', () => {
    const hits = files(join(ROOT, 'src/local')).filter((p) => /['"]cloudflare:|\/cloudflare\//.test(code(p))).map((p) => relative(ROOT, p));
    expect(hits).toEqual([]);
  });

  it('the scan sees a violation when there is one', () => {
    expect(PLATFORM.some((re) => re.test(code(join(ROOT, 'src/cloudflare/baton.ts'))))).toBe(true);
  });
});
