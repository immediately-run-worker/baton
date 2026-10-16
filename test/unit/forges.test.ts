// R3-1262 — forge-aware repositories and the sync's credentials (BATON_SPEC §2k R-BTN-92, R-BTN-93):
// the forge path's grammar, `web_base` and the one link rule, registrations off GitHub, GitLab CI
// tokens bound to their project, branch and role, and migration 0012 on a deployed database.
import { describe, it, expect } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { fileUrl, isForgePath, isPullRequestUrl, isWebBase, transcriptUrl, underWebBase } from '../../src/core/links';
import { checkRegistration } from '../../src/core/registry';
import { MIGRATIONS } from '../../src/migrations';
import { call, gitlabToken, withCore } from '../helpers';

const code = async (res: Response) => ((await res.json()) as { code: string }).code;

describe('the forge path and web_base (R-BTN-92)', () => {
  it.each([
    ['github', 'immediately-run/docs', true], ['github', 'a/b/c', false], ['gitlab', 'group/sub/team/app', true],
    ['gitlab', 'a/b/c/d/e', false], ['git', 'server/plain', true], ['github', 'a/..', false], ['github', 'a/b.git', false],
    ['github', 'a/b c', false], ['gitea', 'a/b', true],
  ] as const)('%s %s: %s', (forge, path, want) => {
    expect(isForgePath(forge, path)).toBe(want);
  });

  it('a web_base is https://host[:port]/<forge path>, nothing else', () => {
    expect(isWebBase('gitlab', 'https://gitlab.example.com:8443/team/app', 'team/app')).toBe(true);
    for (const bad of ['http://gitlab.example.com/team/app', 'https://x@gitlab.example.com/team/app', 'https://gitlab.example.com/team/app/', 'https://gitlab.example.com/team/app?x=1', 'https://gitlab.example.com/other/app']) {
      expect([bad, isWebBase('gitlab', bad, 'team/app')]).toEqual([bad, false]);
    }
    expect(isWebBase('git', 'https://git.example/server/plain', 'server/plain')).toBe(false);
  });

  it('the one link rule: host, port, whole leading segments, no dot segments or userinfo', () => {
    const base = 'https://github.com/immediately-run/docs';
    expect(underWebBase('https://github.com/immediately-run/docs/pull/1', base)).toBe(true);
    expect(underWebBase('https://GitHub.com/Immediately-Run/Docs/blob/main/x', base)).toBe(true);
    // Dot segments are judged as written, inside the base too (round 1, 1-A-4, 1-B-1).
    for (const bad of ['https://github.com/immediately-run/docs/x/../pull/1', 'https://github.com/immediately-run/docs/%2e%2e/docs/pull/1', 'https://github.com/immediately-run/docs/pull/1/../2', 'https://github.com/immediately-run/docs//pull/1']) {
      expect([bad, underWebBase(bad, base)]).toEqual([bad, false]);
    }
    expect(isWebBase('github', 'https://github.com/x/../immediately-run/docs', 'immediately-run/docs')).toBe(false);
    for (const bad of ['https://github.com/immediately-run/docs-evil/pull/1', 'https://github.com:444/immediately-run/docs/pull/1', 'https://u@github.com/immediately-run/docs',
      'http://github.com/immediately-run/docs', 'https://github.com/immediately-run/docs/%2e%2e/x', 'https://github.com/immediately-run/docs/a%2Fb', 'javascript:alert(1)', 'https://github.com/immediately-run/docs#x']) {
      expect([bad, underWebBase(bad, base)]).toEqual([bad, false]);
    }
  });

  it('pull request paths per forge; file and transcript links per forge; none for git', () => {
    expect(isPullRequestUrl('github', 'https://github.com/o/r/pull/3', 'https://github.com/o/r')).toBe(true);
    expect(isPullRequestUrl('gitea', 'https://tea.example/o/r/pulls/3', 'https://tea.example/o/r')).toBe(true);
    expect(isPullRequestUrl('gitea', 'https://tea.example/o/r/pull/3', 'https://tea.example/o/r')).toBe(false);
    expect(isPullRequestUrl('gitlab', 'https://lab.example/g/s/r/-/merge_requests/3', 'https://lab.example/g/s/r')).toBe(true);
    expect(fileUrl('gitlab', 'https://lab.example/g/r', 'main', 'a/b.md')).toBe('https://lab.example/g/r/-/blob/main/a/b.md');
    expect(fileUrl('git', null, 'main', 'a.md')).toBeNull();
    expect(transcriptUrl('immediately-run/claude-sessions', 'cc/s.jsonl')).toBe('https://github.com/immediately-run/claude-sessions/blob/HEAD/cc/s.jsonl');
    expect(transcriptUrl('gitlab:https://lab.example/team/t', 'a.jsonl')).toBe('https://lab.example/team/t/-/blob/HEAD/a.jsonl');
    expect(transcriptUrl('immediately-run/claude-sessions', '../x')).toBeNull();
  });
});

describe('registrations off GitHub (R-BTN-92, R-BTN-93)', () => {
  const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
  it('a git repository needs a sync key and has no web_base; a gitlab one names its issuer', () => {
    expect(checkRegistration({ id: 'plain', github: 'server/plain', forge: 'git', remote: 'ssh://git@h/plain.git', default_branch: 'main', sync_keys: [{ public_key: key, role: 'sync' }] }))
      .toMatchObject({ forge: 'git', web_base: null, ci_identity: null, sync_workflow: '' });
    expect(() => checkRegistration({ id: 'plain', github: 'server/plain', forge: 'git', remote: 'ssh://git@h/plain.git', default_branch: 'main' })).toThrow(/CI identity or a sync key/);
    expect(() => checkRegistration({ id: 'plain', github: 'server/plain', forge: 'git', remote: 'ssh://h/p', web_base: 'https://h/server/plain', default_branch: 'main', sync_keys: [{ public_key: key, role: 'sync' }] })).toThrow(/web_base/);
    expect(checkRegistration({ id: 'lab', github: 'group/lab', forge: 'gitlab', remote: 'https://gitlab.test/group/lab.git', web_base: 'https://gitlab.test/group/lab', default_branch: 'main', ci_identity: { kind: 'gitlab-ci', issuer: 'https://gitlab.test' } }))
      .toMatchObject({ ci_identity: { kind: 'gitlab-ci', issuer: 'https://gitlab.test', mirror: false } });
    expect(() => checkRegistration({ id: 'lab', github: 'group/lab', forge: 'gitlab', remote: 'https://gitlab.test/group/lab.git', web_base: 'https://gitlab.test/group/lab', default_branch: 'main', ci_identity: { kind: 'github-actions' } })).toThrow(/github-actions|workflows/);
  });

  it('round 1: github.com alone takes workflows; remotes carry no credential; a GitLab issuer is its own instance', () => {
    const ghe = { id: 'ghe', github: 'o/r', forge: 'github', web_base: 'https://ghe.corp/o/r', remote: 'https://ghe.corp/o/r.git', default_branch: 'main' };
    expect(() => checkRegistration({ ...ghe, sync_workflow: '.github/workflows/s.yml' })).toThrow(/github.com only/);
    expect(checkRegistration({ ...ghe, sync_keys: [{ public_key: key, role: 'sync' }] })).toMatchObject({ ci_identity: null });
    expect(() => checkRegistration({ id: 'tea', github: 'o/r', forge: 'gitea', web_base: 'https://tea.example/o/r', remote: 'https://tea.example/o/r.git', default_branch: 'main', sync_workflow: '.github/workflows/s.yml' })).toThrow(/github.com only/);
    for (const remote of ['https://x-access-token:secret@github.com/o/r.git', 'https://user@github.com/o/r.git', 'ssh://git:pw@host/o/r.git']) {
      expect([remote, () => checkRegistration({ id: 'ops', github: 'o/r', remote, default_branch: 'main', sync_workflow: '.github/workflows/s.yml' })]).toEqual([remote, expect.any(Function)]);
      expect(() => checkRegistration({ id: 'ops', github: 'o/r', remote, default_branch: 'main', sync_workflow: '.github/workflows/s.yml' })).toThrow(/credential/);
    }
    expect(checkRegistration({ id: 'ops', github: 'o/r', remote: 'git@github.com:o/r.git', default_branch: 'main', sync_workflow: '.github/workflows/s.yml' }).remote).toBe('git@github.com:o/r.git');
    expect(() => checkRegistration({ id: 'lab', github: 'group/lab', forge: 'gitlab', remote: 'https://gitlab.test/group/lab.git', web_base: 'https://gitlab.test/group/lab', default_branch: 'main', ci_identity: { kind: 'gitlab-ci', issuer: 'https://gitlab.other' } })).toThrow(/GitLab instance/);
  });

  it('register refuses sync keys it cannot add; registerWithKeys and the seed add them (round 1, 1-A-1, 1-A-7)', async () => {
    const entry = { id: 'plain', github: 'server/plain', forge: 'git', remote: 'ssh://git@h/plain.git', default_branch: 'main', sync_keys: [{ public_key: key, role: 'sync' }] };
    await withCore(async (c) => {
      expect(() => c.registry.register(entry)).toThrow(/registerWithKeys/);
      const config = { BATON_REPOSITORIES: JSON.stringify([entry]) } as never;
      expect(c.registry.seed(config)).toEqual(['plain']);
      await c.registry.seedSyncKeys(config, []);
      await c.registry.seedSyncKeys(config, []); // a second start finds the key in place
      expect(c.registry.syncKey('SHA256:' + 'x')).toBeNull();
      expect(c.store.exec(`SELECT repository_id, role, added_by FROM sync_keys`).toArray()).toEqual([{ repository_id: 'plain', role: 'sync', added_by: 'admin:seed' }]);
      // The same key listed for another repository is a conflict, as a malformed seed throws.
      const other = { ...entry, id: 'plain2', github: 'server/plain2' };
      const both = { BATON_REPOSITORIES: JSON.stringify([entry, other]) } as never;
      c.registry.seed(both);
      await expect(c.registry.seedSyncKeys(both, [])).rejects.toMatchObject({ code: 'conflict' });
    });
  });
});

describe('GitLab CI tokens (R-BTN-93)', () => {
  const register = (over: Record<string, unknown> = {}) => withCore((c) => {
    c.registry.register({ id: 'lab', github: 'group/lab', forge: 'gitlab', remote: 'https://gitlab.test/group/lab.git', web_base: 'https://gitlab.test/group/lab', default_branch: 'main', ci_identity: { kind: 'gitlab-ci', issuer: 'https://gitlab.test' }, ...over });
  });
  const head = async (token: string) => call('/v1/sync/head', { headers: { Authorization: `Bearer ${token}` } });

  it('a token from the listed issuer, for the project’s default branch, in the route’s role, passes', async () => {
    await register();
    const res = await head(await gitlabToken());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: null, unconfirmed: [] });
  });

  it.each([
    ['a tag named like the default branch', { ref_type: 'tag' }, {}, 403],
    ['another branch', { ref: 'feature' }, {}, 403],
    ['another project', { project_path: 'group/other' }, {}, 403],
    ['the mirror audience on a sync route', {}, { role: 'mirror' as const }, 403],
    ['an issuer the deployment does not list', {}, { issuer: 'https://evil.test' }, 401],
    ['an audience naming no role', {}, { audience: 'https://baton.immediately.run' }, 401],
  ])('refuses %s', async (_what, over, opts, status) => {
    await register();
    const res = await head(await gitlabToken(over, opts));
    expect([res.status, await code(res)]).toEqual([status, status === 401 ? 'unauthenticated' : 'forbidden']);
  });

  it('the mirror audience reads events only where the identity says the repository has a GitLab mirror', async () => {
    await register();
    expect((await call('/v1/sync/events?after=0', { headers: { Authorization: `Bearer ${await gitlabToken({}, { role: 'mirror' })}` } })).status).toBe(403);
    await withCore((c) => c.store.exec(`UPDATE repositories SET ci_identity = '{"kind":"gitlab-ci","issuer":"https://gitlab.test","mirror":true}' WHERE id = 'lab'`));
    expect((await call('/v1/sync/events?after=0', { headers: { Authorization: `Bearer ${await gitlabToken({}, { role: 'mirror' })}` } })).status).toBe(200);
  });
});

describe('migration 0012 on a deployed database (R3-1262)', () => {
  it('backfills every repository as GitHub and adds sync_keys', async () => {
    const id = env.BATON.idFromName('migrations-0012');
    await runInDurableObject(env.BATON.get(id), (_o: unknown, state: DurableObjectState) => {
      const sql = state.storage.sql;
      sql.exec('PRAGMA foreign_keys = OFF');
      for (const o of sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray() as { name: string }[]) sql.exec(`DROP TABLE IF EXISTS "${o.name}"`);
      for (const m of MIGRATIONS.filter((x) => x.id <= 11)) sql.exec(m.sql);
      sql.exec(`INSERT INTO repositories (id, github, default_branch, sync_workflow, mirror_workflow) VALUES ('docs', 'immediately-run/docs', 'main', '.github/workflows/baton-sync.yml', '.github/workflows/baton-mirror.yml')`);
      sql.exec(MIGRATIONS.find((x) => x.id === 12)!.sql);
      expect(sql.exec('SELECT forge, remote, web_base, ci_identity, dispatch, sync_wanted_at FROM repositories').toArray()).toEqual([{
        forge: 'github', remote: 'https://github.com/immediately-run/docs.git', web_base: 'https://github.com/immediately-run/docs',
        ci_identity: '{"kind":"github-actions"}', dispatch: '{"kind":"github-app"}', sync_wanted_at: null }]);
      sql.exec(`INSERT INTO sync_keys (fingerprint, repository_id, role, public_key, added_by, added_at) VALUES ('SHA256:a', 'docs', 'sync', 'ssh-ed25519 A', 'admin:x', 1)`);
      expect(() => sql.exec(`INSERT INTO sync_keys (fingerprint, repository_id, role, public_key, added_by, added_at) VALUES ('SHA256:b', 'docs', 'owner', 'ssh-ed25519 B', 'admin:x', 1)`)).toThrow(/CHECK/);
      expect(() => sql.exec(`UPDATE repositories SET forge = 'svn'`)).toThrow(/CHECK/);
    });
  });
});
