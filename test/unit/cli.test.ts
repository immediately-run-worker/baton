// cli.test.ts — `baton admin …` / `baton owner …` (R3-1240; BATON_SPEC §10.6, R-BTN-57/-58,
// R-BTN-66/-67): each command's one request (`plan`, pure), and a request signed with a real key
// file by `ssh-keygen -Y sign` that Baton's verifier accepts. Node only: it runs ssh-keygen.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duration, parseArgs, plan, send } from '../../cli/baton.mjs';
import { ORIGIN, setAdminKeys, setClock } from '../helpers';
import type { TestKey } from '../lib/sshKeys';
import { call as hostCall } from '#host';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOwner';
const key = (p: string) => p;

describe('plan: one request per command', () => {
  it('admin commands', () => {
    expect(plan('admin', ['repo', 'add', 'immediately-run/ops', '--id', 'ops', '--owner-key', PUB, '--weight', '2', '--tiers', 'routine,critical', '--cut-over'], key)).toEqual({
      method: 'POST', path: '/v1/admin/repositories',
      body: { id: 'ops', github: 'immediately-run/ops', default_branch: 'main', weight: 2, tiers: ['routine', 'critical'], cut_over: true, owner_keys: [PUB] },
    });
    expect(plan('admin', ['repo', 'retire', 'ops'], key)).toEqual({ method: 'POST', path: '/v1/admin/repositories', body: { id: 'ops', retire: true } });
    expect(plan('admin', ['grant', 'docs', '--key', PUB, '--hostname', 'h', '--capabilities', 'human-operator'], key).body)
      .toEqual({ repository: 'docs', public_key: PUB, hostname: 'h', capabilities: ['human-operator'] });
    expect(plan('admin', ['revoke', 'SHA256:a/b'], key).path).toBe('/v1/admin/keys/SHA256%3Aa%2Fb/revoke');
    expect(plan('admin', ['open'], key)).toEqual({ method: 'POST', path: '/v1/admin/login-links', body: {} });
    expect(() => plan('admin', ['repo', 'add', 'x/y'], key)).toThrow('--id is required');
  });

  it('owner commands, the required bars in their groups', () => {
    expect(plan('owner', ['grant', 'docs', '--key', PUB, '--capabilities', 'agent-venue', '--max-tier', 'routine'], key))
      .toEqual({ method: 'POST', path: '/v1/owner/docs/grants', body: { public_key: PUB, capabilities: ['agent-venue'], max_tier: 'routine' } });
    expect(plan('owner', ['owners', 'docs', '--remove', 'SHA256:x'], key).body).toEqual({ fingerprint: 'SHA256:x', remove: true });
    expect(plan('owner', ['bar', 'docs', '--course', '*', '--tag', 'account:go_plus', '--applies', 'claim', '--starts-at', '2026-10-16T13:00:00Z', '--reason', 'go-quota', '--release-holders'], key).body)
      .toEqual({ course: '*', tag: 'account:go_plus', applies: 'claim', starts_at: Date.parse('2026-10-16T13:00:00Z'), release_holders: true, reason: 'go-quota' });
    expect(plan('owner', ['bar', 'lift', 'docs', '7'], key).path).toBe('/v1/owner/docs/bars/7/lift');
    expect(plan('owner', ['settings', 'docs', '--required-bar', '*', '--course', 'roadmap-pr', '--except', 'implement,review', '--tag-prefix', 'family:',
      '--required-bar', 'merge', '--course', 'roadmap-pr', '--tag-prefix', 'account:', '--retry', '1h,4h', '--max-failed', '3'], key)).toEqual({
      method: 'PUT', path: '/v1/owner/docs/settings', body: {
        required_bars: [{ course: 'roadmap-pr', leg: '*', except: ['implement', 'review'], tag_prefix: 'family:' }, { course: 'roadmap-pr', leg: 'merge', tag_prefix: 'account:' }],
        retry: { backoff_ms: [3_600_000, 14_400_000], max_failed: 3 },
      } });
    expect(() => plan('owner', ['settings', 'docs'], key)).toThrow('at least one setting');
    expect(() => plan('owner', ['bar', 'docs', '--course', '*', '--tag', 't', '--applies', 'claim', '--starts-at', 'soon', '--reason', 'r'], key)).toThrow('not a date');
  });

  it('parseArgs and duration', () => {
    expect(parseArgs(['a', '--x', '1', '--flag'], ['flag'])).toEqual({ flags: { x: '1', flag: true }, positional: ['a'], groups: [] });
    expect(() => parseArgs(['--x'])).toThrow('needs a value');
    expect(duration('30m')).toBe(1_800_000);
    expect(() => duration('1w')).toThrow();
  });
});

describe('send: signed with a key file, verified by Baton', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'baton-cli-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('an administrator’s key file signs a request Baton accepts; another key is unauthenticated', async () => {
    const file = join(dir, 'admin');
    expect(spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]).status).toBe(0);
    const other = join(dir, 'other');
    spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', other]);
    // ssh-keygen signs at the wall clock: Baton's clock is set to it.
    await setClock(Date.now());
    await setAdminKeys({ publicKey: readFileSync(`${file}.pub`, 'utf8').trim() } as TestKey);
    const fetchImpl = (url: string, init: RequestInit) => hostCall(new Request(url, init));
    const ok = await send(ORIGIN, plan('admin', ['open']), file, fetchImpl);
    expect(ok.status).toBe(200);
    expect(ok.json.url).toMatch(/\/login#[0-9a-f]{64}$/);
    expect(await send(ORIGIN, plan('admin', ['open']), other, fetchImpl)).toMatchObject({ status: 401, json: { code: 'unauthenticated' } });
  });
});
