// fixtureRepo.mjs — the integration harness's stand-in for `docs/main` (BATON_SPEC §13a
// R-BTN-29): a local bare repository with fixture roadmap items and real git history. Node
// only; test/integration/global-setup.ts and scripts/board-fixtures.mjs use it.
//
// The history (commit dates and identity fixed, so every run produces the same shas):
//   A  R3-9001..9004 filed (R3-9004 blocked on R3-9001; R3-9003's repos entry is annotated,
//      `deploy (provisioning)`, as real items' are), plus scripts/data/ (test/fixtures/data)
//   B  R3-9001 claimed: status in-progress, body edited               (child of A)
//   C  R3-9005 filed with the EXPEDITE tag                            (child of B)
//   D  a rewritten main: from A, R3-9003 archived; force-pushed over C (child of A only)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const LABELS = ['A', 'B', 'C', 'D'];
export const NOW = '2026-10-13T12:00:00.000Z';

const ENV = {
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};

/** Build the repository; returns `{ bare, shas: {A, B, C, D}, isAncestor(x, y) }`. */
export function buildFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'baton-fixture-'));
  const bare = join(root, 'docs.git');
  const work = join(root, 'work');
  const git = (cwd, args, date) => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...ENV, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env: { ...process.env, ...ENV } });
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env: { ...process.env, ...ENV } });
  const roadmap = join(work, 'content/roadmap');
  mkdirSync(join(roadmap, 'archive'), { recursive: true });
  writeFileSync(join(roadmap, 'archive', '.keep'), '');
  const commit = (msg, date) => {
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', msg], date);
    return git(work, ['rev-parse', 'HEAD']);
  };
  const put = (id, text) => writeFileSync(join(roadmap, `${id}.mdx`), text);
  const fixture = (id) => readFileSync(join(FIXTURES, 'roadmap', `${id}.mdx`), 'utf8');

  for (const f of readdirSync(join(FIXTURES, 'roadmap'))) put(f.replace(/\.mdx$/, ''), fixture(f.replace(/\.mdx$/, '')));
  mkdirSync(join(work, 'scripts/data'), { recursive: true });
  for (const f of readdirSync(join(FIXTURES, 'data'))) copyFileSync(join(FIXTURES, 'data', f), join(work, 'scripts/data', f));
  const A = commit('roadmap: file R3-9001..9004', '2026-10-13T10:00:00Z');
  git(work, ['remote', 'add', 'origin', bare]);
  git(work, ['push', '-q', 'origin', 'main']);

  put('R3-9001', fixture('R3-9001').replace('status: available', 'status: in-progress').replace('_(filed 2026-10-13)_', '_claimed 2026-10-13 — docs (claim abc123)._\n\n_(filed 2026-10-13)_'));
  const B = commit('roadmap: claim R3-9001 (in progress)', '2026-10-13T10:10:00Z');
  git(work, ['push', '-q', 'origin', 'main']);

  put('R3-9005', fixture('R3-9001').replaceAll('R3-9001', 'R3-9005').replace('a routine docs change', 'an outage fix').replace('  - FEAT\n', '  - FEAT\n  - EXPEDITE\n').replace('order: 10', 'order: 50'));
  const C = commit('roadmap: file R3-9005', '2026-10-13T10:20:00Z');
  git(work, ['push', '-q', 'origin', 'main']);

  git(work, ['reset', '-q', '--hard', A]);
  renameSync(join(roadmap, 'R3-9003.mdx'), join(roadmap, 'archive', 'R3-9003.mdx'));
  const D = commit('roadmap: R3-9003 done (archived)', '2026-10-13T10:30:00Z');
  git(work, ['push', '-q', '--force', 'origin', 'main']);

  const shas = { A, B, C, D };
  // Every commit stays reachable in the work clone, so ancestry is answerable for all four.
  const isAncestor = (x, y) => {
    try {
      execFileSync('git', ['-C', work, 'merge-base', '--is-ancestor', x, y]);
      return true;
    } catch {
      return false;
    }
  };
  return { root, bare, work, shas, isAncestor };
}

/** The snapshot the sync posts at each commit, produced by the REAL docs sync —
 *  `buildPayload` from docs scripts/baton-sync.mjs, run over the fixture repository (it reads
 *  the board with factory-state's code and the data files at that commit) — minus its
 *  internal `_state`. */
export async function boardStates(repo, docsDir) {
  const { buildPayload } = await import(join(docsDir, 'scripts/baton-sync.mjs'));
  const out = {};
  for (const label of LABELS) {
    const { _state, ...payload } = buildPayload(repo.shas[label], { root: repo.work, now: NOW });
    out[label] = payload;
  }
  return out;
}
