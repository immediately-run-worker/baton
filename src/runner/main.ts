// main.ts — `baton run`'s entry (BATON_SPEC §6.13): parses the flags, refuses to nest (a session
// that carries IR_BATON_PARENT is a leg session — it never claims, advances or ends: the runner
// that started it does), wires the API client (the machine's key, or the transition's token),
// the state file, the home checkout and R-BTN-34's bounded fetch, and runs the loop. The pure
// half (`parseRunArgs`, `declareCourses`, `envAuth`) is unit-tested in
// test/unit/runner-main.test.ts; the wiring is exercised end-to-end by S-BTN-41 against the
// local host.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_URL } from '../../cli/baton.mjs';
import { BatonApi, envAuth } from './api';
import { Runner } from './runner';

export interface RunArgs {
  harness: 'opencode' | 'claude-code';
  home: string;
  url: string;
  session: string;
  repository: string;
  hostname: string;
  tier: string;
  capabilities: string[];
  beatEvery: number;
}

/** `baton run [--harness opencode|claude-code] [--home <checkout>] [--url <url>] [--session <id>]
 * [--repository <id>] [--hostname <name>] [--tier <tier>] [--capabilities a,b] [--beat-every <ms>]`.
 * Unknown flags are refused, never dropped. */
export function parseRunArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunArgs {
  const out: RunArgs = {
    harness: 'opencode', home: env.BATON_HOME ?? process.cwd(), url: env.BATON_URL ?? DEFAULT_URL,
    session: env.IR_BATON_SESSION ?? `run-${Math.random().toString(16).slice(2, 10)}`,
    repository: env.BATON_REPOSITORY ?? 'docs', hostname: env.IR_BATON_NAME ?? hostname(),
    tier: 'critical', capabilities: ['agent-venue'], beatEvery: 2 * 60_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--harness') {
      const v = value();
      if (v !== 'opencode' && v !== 'claude-code') throw new Error('--harness: opencode or claude-code');
      out.harness = v;
    } else if (a === '--home') out.home = value();
    else if (a === '--url') out.url = value();
    else if (a === '--session') out.session = value();
    else if (a === '--repository') out.repository = value();
    else if (a === '--hostname') out.hostname = value();
    else if (a === '--tier') out.tier = value();
    else if (a === '--capabilities') out.capabilities = value().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--beat-every') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 50) throw new Error('--beat-every: an integer of at least 50 ms');
      out.beatEvery = n;
    } else throw new Error(`${a}: not a flag of baton run`);
  }
  return out;
}

/** A repository's course declarations for the heartbeat (rule 9): the spec's
 * `.baton/baton.json` `courses: [{id, version}]` (§2c/R-BTN-51) first; docs' interim is the
 * skills_version every course runs at (`{course}` naming one, or the single directory). The
 * runner refuses to guess a version it cannot find — a wrong declaration silences rule 9. */
export function declareCourses(home: string): { course: string; version: number }[] {
  const read = (p: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(readFileSync(join(home, p), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const batonJson = read('.baton/baton.json');
  if (batonJson && Array.isArray(batonJson.courses) && batonJson.courses.length) {
    const out: { course: string; version: number }[] = [];
    for (const c of batonJson.courses as Record<string, unknown>[]) {
      if (typeof c.id !== 'string' || typeof c.version !== 'number') throw new Error('.baton/baton.json courses[] entries must be {id, version}');
      out.push({ course: c.id, version: c.version });
    }
    return out;
  }
  const version = (() => {
    if (batonJson && typeof batonJson.skills_version === 'number') return batonJson.skills_version;
    const data = read('scripts/data/baton.json');
    return typeof data?.skills_version === 'number' ? data.skills_version : null;
  })();
  if (typeof batonJson?.course === 'string') {
    if (version == null) throw new Error('the home checkout names no course version (.baton/baton.json courses[] or skills_version, or scripts/data/baton.json)');
    return [{ course: batonJson.course, version }];
  }
  const coursesDir = join(home, '.baton', 'courses');
  if (!existsSync(coursesDir)) throw new Error(`${home} has no .baton/courses`);
  const listed = readdirSync(coursesDir).filter((d) => existsSync(join(coursesDir, d, 'course.json')));
  if (listed.length !== 1) throw new Error(`the home checkout runs ${listed.length} courses and .baton/baton.json names none: ${listed.join(', ')}`);
  if (version == null) throw new Error('the home checkout names no course version (.baton/baton.json courses[] or skills_version, or scripts/data/baton.json)');
  return [{ course: listed[0], version }];
}

/** The one place `~/.cache/immediately-run` is materialised for a cloud key (§6.4). */
function cacheDir(): string {
  const dir = join(homedir(), '.cache', 'immediately-run', 'baton');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** R-BTN-34's bounded fetch: one `git fetch origin main` in the home checkout, its failure
 * logged and swallowed — `ensureSha` re-checks and releases `stale-board` when the commit is
 * still missing, which is exactly the bound. */
export function fetchMain(home: string, log: (l: string) => void = () => {}): void {
  try {
    execFileSync('git', ['-C', home, 'fetch', 'origin', 'main'], { stdio: 'ignore' });
  } catch (e) {
    log(`baton: the snapshot fetch failed (${e instanceof Error ? e.message : String(e)})`);
  }
}

export async function runMain(argv: string[], io: { log?: (l: string) => void; fetch?: (home: string) => void } = {}): Promise<number> {
  // §6.13: a leg session never claims — the runner that started it does. A nested `baton run`
  // is exactly that session trying, so it is refused before anything else.
  if (process.env.IR_BATON_PARENT) {
    process.stderr.write(`baton: this session carries IR_BATON_PARENT=${process.env.IR_BATON_PARENT}: a leg session never claims (§6.13)\n`);
    return 1;
  }
  const a = parseRunArgs(argv);
  const auth = envAuth(process.env, (material) => {
    const file = join(cacheDir(), 'key');
    const text = `${material.replace(/\r\n/g, '\n').trim()}\n`;
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeFileSync(file, text, { mode: 0o600 });
    chmodSync(file, 0o600);
    return file;
  });
  const log = io.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const runner = new Runner({
    api: new BatonApi({ url: a.url, transport: (req) => fetch(req), auth }, log),
    home: a.home, repository: a.repository, hostname: a.hostname, harness: a.harness, session: a.session,
    tierCeiling: a.tier, capabilities: a.capabilities,
    courses: declareCourses(a.home),
    stateFile: join(cacheDir(), `${a.session}.json`),
    beatEvery: a.beatEvery, log,
    fetch: io.fetch ?? ((home) => fetchMain(home, log)),
  });
  await runner.work();
  return 0;
}
