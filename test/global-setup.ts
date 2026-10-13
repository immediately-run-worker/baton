// global-setup.ts — runs in Node before the Workers tests (R-BTN-29). It builds the fixture
// git repository, takes its shas and ancestry from real git, and checks the committed inputs
// the Worker-side tests read against their sources wherever a sibling docs checkout exists:
// the board states (test/fixtures/boards.json) and the vendored library (src/shared/, R-BTN-37).
import type { TestProject } from 'vitest/node';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildFixtureRepo, boardStates, LABELS } from './lib/fixtureRepo.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

export default async function setup(project: TestProject) {
  const docs = resolve(process.env.DOCS_DIR ?? join(ROOT, '..', 'docs'));
  const haveDocs = existsSync(join(docs, 'scripts/factory-state.mjs'));

  const committed = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/boards.json'), 'utf8'));
  const repo = buildFixtureRepo();
  if (JSON.stringify(repo.shas) !== JSON.stringify(committed.shas)) {
    throw new Error('the fixture repository produced different shas than test/fixtures/boards.json records — run npm run fixtures');
  }
  if (haveDocs) {
    const live = await boardStates(repo, docs);
    if (JSON.stringify(live) !== JSON.stringify(committed.states)) {
      throw new Error(`test/fixtures/boards.json differs from what ${docs}'s factory-state code computes — run npm run fixtures`);
    }
  }
  const ancestry: Record<string, boolean> = {};
  for (const x of LABELS) for (const y of LABELS) ancestry[`${x}<${y}`] = repo.isAncestor(repo.shas[x as keyof typeof repo.shas], repo.shas[y as keyof typeof repo.shas]);
  project.provide('board', { shas: repo.shas, states: committed.states, ancestry });

  const manifest = JSON.parse(readFileSync(join(ROOT, 'src/shared/manifest.json'), 'utf8'));
  const vendored = Object.fromEntries(Object.keys(manifest.files).map((n) => [n, sha256(join(ROOT, 'src/shared', n))]));
  const upstream = haveDocs ? Object.fromEntries(Object.keys(manifest.files).map((n) => [n, sha256(join(docs, 'scripts/lib', n))])) : null;
  project.provide('shared', { manifest: manifest.files, vendored, upstream });
  project.provide('wranglerToml', readFileSync(join(ROOT, 'wrangler.toml'), 'utf8'));

  // One input from the real producer: today's docs board, as factory-state computes it.
  let liveBoard: { items: unknown[]; ready: string[] } | null = null;
  if (haveDocs) {
    const { computeState } = await import(join(docs, 'scripts/factory-state.mjs'));
    const { rankReady } = await import(join(docs, 'scripts/lib/factoryState.mjs'));
    const state = computeState({});
    liveBoard = { items: state.items, ready: rankReady(state).map((r: { id: string }) => r.id) };
  }
  project.provide('liveBoard', liveBoard);
}
