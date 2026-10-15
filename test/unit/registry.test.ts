// R3-1231 part 2a — the repository registry (BATON_SPEC §2a R-BTN-47, §10.3 R-BTN-15): a
// registration is checked before it is written and is insert-only; the BATON_REPOSITORIES seed
// never changes a repository Baton knows; a sync token binds to exactly one repository's
// workflow on its default branch; a dispatch names that repository's workflow. S-BTN-26.
import { describe, it, expect } from 'vitest';
import { checkRegistration } from '../../src/core/registry';
import type { DispatchTarget } from '../../src/core/ports';
import { rows, withCore } from '../helpers';

const OPS = { id: 'ops', github: 'immediately-run/ops', default_branch: 'trunk', sync_workflow: '.github/workflows/sync.yml' };
const claimsOf = (repository: string, workflow: string, branch = 'trunk') =>
  ({ repository, ref: `refs/heads/${branch}`, job_workflow_ref: `${repository}/.github/workflows/${workflow}@refs/heads/${branch}` });

describe('checkRegistration', () => {
  it('fills the defaults and keeps what it was given', () => {
    expect(checkRegistration(OPS)).toEqual({ ...OPS, mirror_workflow: null, weight: 100, tiers: ['routine', 'judgement', 'critical'], transcript_repos: [], cut_over: false });
  });

  it.each([
    ['an id with a colon (it would split a qualified id)', { id: 'o:ps' }],
    ['an upper-case id', { id: 'Ops' }],
    ['a GitHub name without an owner', { github: 'ops' }],
    ['a branch with ..', { default_branch: 'a..b' }],
    ['a workflow outside .github/workflows', { sync_workflow: 'sync.yml' }],
    ['a negative weight', { weight: -1 }],
    ['a fractional weight', { weight: 1.5 }],
    ['repeated tiers', { tiers: ['a', 'a'] }],
    ['no tiers', { tiers: [] }],
    ['a transcript repository that is not owner/name', { transcript_repos: ['x'] }],
    ['a cut_over that is not boolean', { cut_over: 'yes' }],
  ])('refuses %s', (_what, over) => {
    expect(() => checkRegistration({ ...OPS, ...over })).toThrow(expect.objectContaining({ code: 'invalid-params' }));
  });
});

describe('the registry', () => {
  it('the deployment seed registered docs, with its board head waiting for a first snapshot', async () => {
    expect(await rows(`SELECT id, github, weight, cutover_at FROM repositories`)).toEqual([{ id: 'docs', github: 'immediately-run/docs', weight: 100, cutover_at: null }]);
    expect(await rows(`SELECT repository_id, sha FROM board_head`)).toEqual([{ repository_id: 'docs', sha: null }]);
  });

  it('is insert-only: a known id or GitHub repository (in any case) is refused', async () => {
    await withCore((c) => {
      c.registry.register(OPS);
      expect(() => c.registry.register({ ...OPS, github: 'immediately-run/other' })).toThrow(/already registered/);
      expect(() => c.registry.register({ ...OPS, id: 'ops2', github: 'Immediately-Run/OPS' })).toThrow(/already registered/);
    });
    expect(await rows(`SELECT id FROM repositories ORDER BY id`)).toEqual([{ id: 'docs' }, { id: 'ops' }]);
  });

  it('the seed adds what is new and leaves a known repository as it is; a malformed one throws', async () => {
    await withCore((c) => {
      const seed = (v: unknown) => c.registry.seed({ BATON_REPOSITORIES: JSON.stringify(v) } as never);
      expect(seed([{ ...OPS, weight: 7 }, { id: 'docs', github: 'immediately-run/docs', default_branch: 'other', sync_workflow: '.github/workflows/x.yml' }])).toEqual(['ops']);
      expect(c.registry.get('docs')!.default_branch).toBe('main');
      expect(seed([{ ...OPS, weight: 9 }])).toEqual([]);
      expect(c.registry.get('ops')!.weight).toBe(7);
      expect(() => c.registry.seed({ BATON_REPOSITORIES: '{' } as never)).toThrow(/not JSON/);
      expect(() => seed({ id: 'x' })).toThrow(/array/);
      expect(() => seed([{ id: 'bad id' }])).toThrow(expect.objectContaining({ code: 'invalid-params' }));
    });
  });

  it('R-BTN-15: a token binds to its repository’s workflow for the role, on its default branch', async () => {
    await withCore((c) => {
      c.registry.register(OPS);
      const forbidden = expect.objectContaining({ code: 'forbidden' });
      expect(c.registry.forSync(claimsOf('immediately-run/ops', 'sync.yml'), 'sync').id).toBe('ops');
      // GitHub's spelling of the name may differ in case; the binding still holds.
      expect(c.registry.forSync(claimsOf('Immediately-Run/Ops', 'sync.yml'), 'sync').id).toBe('ops');
      expect(() => c.registry.forSync(claimsOf('immediately-run/ops', 'sync.yml', 'main'), 'sync')).toThrow(forbidden);
      expect(() => c.registry.forSync(claimsOf('immediately-run/ops', 'other.yml'), 'sync')).toThrow(forbidden);
      // ops has no mirror: no token is a mirror token for it.
      expect(() => c.registry.forSync(claimsOf('immediately-run/ops', 'sync.yml'), 'mirror')).toThrow(forbidden);
      // A workflow ref naming another repository's file does not pass for this one's.
      expect(() => c.registry.forSync({ ...claimsOf('immediately-run/ops', 'sync.yml'), job_workflow_ref: 'immediately-run/docs/.github/workflows/sync.yml@refs/heads/trunk' }, 'sync')).toThrow(forbidden);
      c.store.exec(`UPDATE repositories SET retired_at = 1 WHERE id = 'ops'`);
      expect(() => c.registry.forSync(claimsOf('immediately-run/ops', 'sync.yml'), 'sync')).toThrow(forbidden);
      expect(c.registry.all().map((r) => r.id)).toEqual(['docs']);
    });
  });

  it('a dispatch names the repository’s own workflow file and default branch; no mirror, no dispatch', async () => {
    const sent = await withCore(async (c) => {
      c.registry.register(OPS);
      const got: DispatchTarget[] = [];
      (c as unknown as { ports: { dispatch: { send: (t: DispatchTarget) => Promise<boolean> } } }).ports.dispatch = { send: async (t) => (got.push(t), true) };
      expect(await c.dispatcher({ repository: 'ops', kind: 'sync' })).toBe(true);
      expect(await c.dispatcher({ repository: 'docs', kind: 'mirror' })).toBe(true);
      expect(await c.dispatcher({ repository: 'ops', kind: 'mirror' })).toBe(false);
      expect(await c.dispatcher({ repository: 'nope', kind: 'sync' })).toBe(false);
      return got;
    });
    expect(sent).toEqual([
      { github: 'immediately-run/ops', workflow: 'sync.yml', ref: 'trunk' },
      { github: 'immediately-run/docs', workflow: 'baton-mirror.yml', ref: 'main' }]);
  });
});
