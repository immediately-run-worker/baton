// admin.test.ts — R3-1240: every refusal of R-BTN-57/-58's administrator and owner functions, by
// code, through the signed routes the CLI calls (src/core/admin.ts is their one implementation);
// owner bars per course (R-BTN-67: a bar on `chore` never bars a `roadmap-pr` leg, a `*` bar bars
// both); and requiredBarCovers following `renamed_from` and `except`.
import { describe, it, expect, beforeEach } from 'vitest';
import roadmapPr from '../fixtures/courses/roadmap-pr/course.json';
import chore from '../fixtures/courses/chore/course.json';
import { requiredBarCovers, isOwnerBarReason, checkRetry } from '../../src/core/admin';
import { graphOf } from '../../src/core/graph';
import { adminSession, ownerCall, call, captureDispatches, claimItem, hbBody, ORIGIN, sessionCall, sha256, tick, withCore, course, cutover, Git, keyCall, placed, recommended, register, rows, setAdminKeys, setClock } from '../helpers';
import { makeKey, signedRequest, type TestKey } from '../lib/sshKeys';
import { call as hostCall } from '#host';

const T0 = Date.parse('2026-10-16T12:00:00Z');
let admin: TestKey;
let owner: TestKey;
let worker: TestKey;
let git: Git;
const REGISTER = { id: 'ops', github: 'immediately-run/ops', default_branch: 'main', sync_workflow: '.github/workflows/baton-sync.yml' };
const code = async (p: Promise<{ status: number; json: Record<string, any> }>) => {
  const r = await p;
  return r.status === 200 ? 200 : r.json.code;
};
const own = (path: string, body: unknown, method?: string) => keyCall(owner, `/v1/owner/docs${path}`, body, method);
const adm = (path: string, body: unknown) => keyCall(admin, `/v1/admin${path}`, body);

beforeEach(async () => {
  await setClock(T0);
  admin = await makeKey('ssh-ed25519', 'admin');
  owner = await makeKey('ssh-ed25519', 'owner');
  worker = await makeKey('ssh-ed25519', 'worker');
  await setAdminKeys(admin);
  git = new Git().add('T-1');
  await git.post();
  await cutover();
  expect(await code(adm('/repositories', { id: 'docs', owner_keys_add: [owner.publicKey] }))).toBe(200);
});

describe('principals: who may call what', () => {
  it('an unknown key is unauthenticated; an owner key on /v1/admin, or on another repository, is forbidden', async () => {
    const stranger = await makeKey('ssh-ed25519', 'stranger');
    expect(await code(keyCall(stranger, '/v1/admin/probes', {}))).toBe('unauthenticated');
    expect(await code(keyCall(stranger, '/v1/owner/docs/bars', {}))).toBe('unauthenticated');
    expect(await code(keyCall(owner, '/v1/admin/probes', {}))).toBe('forbidden');
    const opsOwner = await makeKey('ssh-ed25519', 'ops-owner');
    expect(await code(adm('/repositories', { ...REGISTER, owner_keys: [opsOwner.publicKey] }))).toBe(200);
    expect(await code(keyCall(opsOwner, '/v1/owner/docs/bars', { course: '*', tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe('forbidden');
    // An administrator's key is no owner's (§11: an owner route takes that repository's owner keys).
    expect(await code(keyCall(admin, '/v1/owner/docs/bars', { course: '*', tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe('forbidden');
  });

  it('unsigned management requests never reach the core', async () => {
    const res = await call('/v1/admin/probes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });
});

describe('R-BTN-57: administrators', () => {
  it('registering refuses no owner key, an administrator key as owner, and unknown fields', async () => {
    expect(await code(adm('/repositories', { ...REGISTER, owner_keys: [] }))).toBe('invalid-params');
    expect(await code(adm('/repositories', { ...REGISTER, owner_keys: [admin.publicKey] }))).toBe('conflict');
    expect(await code(adm('/repositories', { ...REGISTER, owner_keys: [owner.publicKey, owner.publicKey] }))).toBe('invalid-params');
    expect(await code(adm('/repositories', { id: 'docs', github: 'someone/else' }))).toBe('invalid-params');
    expect(await code(adm('/repositories', { id: 'nope', retire: true }))).toBe('not-found');
  });

  it('a change refuses bad weights and tiers; tiers recompute a grant’s max_tier by name', async () => {
    expect(await code(adm('/repositories', { id: 'docs', weight: -1 }))).toBe('invalid-params');
    expect(await code(adm('/repositories', { id: 'docs', tiers: ['a', 'a'] }))).toBe('invalid-params');
    await own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: [], max_tier: 'judgement' });
    expect(await code(adm('/repositories', { id: 'docs', tiers: ['trivial', 'routine', 'judgement', 'critical'] }))).toBe(200);
    expect(await rows('SELECT max_tier FROM worker_grants')).toEqual([{ max_tier: 2 }]);
  });

  it('a probe key is one role: an owner or worker key is refused', async () => {
    expect(await code(adm('/probes', { public_key: owner.publicKey, label: 'p', instances: [] }))).toBe('conflict');
    await own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: [] });
    expect(await code(adm('/probes', { public_key: worker.publicKey, label: 'p', instances: [] }))).toBe('conflict');
    expect(await code(adm('/probes', { public_key: (await makeKey('ssh-ed25519', 'p')).publicKey, label: '', instances: [] }))).toBe('invalid-params');
  });

  it('revoking an unknown key is not-found; a revoked key is never granted again', async () => {
    expect(await code(adm('/keys/SHA256%3Anope/revoke', {}))).toBe('not-found');
    await own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: [] });
    expect(await code(adm(`/keys/${encodeURIComponent(worker.fingerprint)}/revoke`, {}))).toBe(200);
    expect(await code(own('/grants', { public_key: worker.publicKey, capabilities: [] }))).toBe('conflict');
  });

  it('an unknown login token is refused (single use and expiry: S-BTN-32)', async () => {
    const login = (token: string) => call('/v1/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ token }) });
    expect((await login('0'.repeat(64))).status).toBe(401);
  });
});

describe('R-BTN-58: owners', () => {
  it('a grant refuses human-operator from an owner, an unknown key without a hostname, a taken hostname, another hostname, a bad max_tier', async () => {
    expect(await code(own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: ['human-operator'] }))).toBe('forbidden');
    expect(await code(own('/grants', { public_key: worker.publicKey, capabilities: [] }))).toBe('invalid-params');
    expect(await code(own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: [], max_tier: 'epic' }))).toBe('invalid-params');
    expect(await code(own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: ['Bad Name'] }))).toBe('invalid-params');
    expect(await code(own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: ['agent-venue'] }))).toBe(200);
    expect(await code(own('/grants', { public_key: worker.publicKey, hostname: 'w-other', capabilities: [] }))).toBe('conflict');
    const twin = await makeKey('ssh-ed25519', 'twin');
    expect(await code(own('/grants', { public_key: twin.publicKey, hostname: 'w-host', capabilities: [] }))).toBe('conflict');
    // An administrator may rename it.
    expect(await code(adm('/grants', { repository: 'docs', public_key: worker.publicKey, hostname: 'w-other', capabilities: ['human-operator'] }))).toBe(200);
    // An owner's re-grant keeps the administrator's human-operator.
    expect(await code(own('/grants', { public_key: worker.publicKey, capabilities: ['llm-call'] }))).toBe(200);
    expect(JSON.parse((await rows<{ capabilities: string }>('SELECT capabilities FROM worker_grants'))[0].capabilities)).toContain('human-operator');
    // Stored expanded: a role as its capabilities.
    expect(await rows('SELECT hostname FROM credentials WHERE id = ?', worker.fingerprint)).toEqual([{ hostname: 'w-other' }]);
  });

  it('one role per key: an owner’s or administrator’s key is never granted', async () => {
    expect(await code(own('/grants', { public_key: owner.publicKey, hostname: 'o-host', capabilities: [] }))).toBe('conflict');
    expect(await code(own('/grants', { public_key: admin.publicKey, hostname: 'a-host', capabilities: [] }))).toBe('conflict');
    await own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: [] });
    expect(await code(own('/owners', { public_key: worker.publicKey }))).toBe('conflict');
    expect(await code(own('/owners', { public_key: admin.publicKey }))).toBe('conflict');
  });

  it('a grant on a retired repository is not-found; revoking a grant that is not there is not-found', async () => {
    expect(await code(own(`/grants/${encodeURIComponent(worker.fingerprint)}/revoke`, {}))).toBe('not-found');
    const opsOwner = await makeKey('ssh-ed25519', 'ops-owner');
    await adm('/repositories', { ...REGISTER, owner_keys: [opsOwner.publicKey] });
    await adm('/repositories', { id: 'ops', retire: true });
    expect(await code(keyCall(opsOwner, '/v1/owner/ops/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: [] }))).toBe('not-found');
  });

  it('owners: never the last; removing a non-owner is not-found', async () => {
    expect(await code(own('/owners', { fingerprint: owner.fingerprint, remove: true }))).toBe('conflict');
    expect(await code(own('/owners', { fingerprint: 'SHA256:nope', remove: true }))).toBe('not-found');
    const second = await makeKey('ssh-ed25519', 'second');
    expect(await code(own('/owners', { public_key: second.publicKey }))).toBe(200);
    expect(await code(own('/owners', { fingerprint: owner.fingerprint, remove: true }))).toBe(200);
    // A key that owns nothing is no principal at all.
    expect(await code(own('/bars', { course: '*', tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe('unauthenticated');
  });

  it('owner bars refuse legs under *, a closed reason, bad times and unknown fields; lifting one not in force is not-found', async () => {
    const bar = { course: 'roadmap-pr', tag: 'family:glm', applies: 'claim', reason: 'quota' };
    expect(await code(own('/bars', { ...bar, course: '*', legs: ['fix'] }))).toBe('invalid-params');
    expect(await code(own('/bars', { ...bar, reason: 'done' }))).toBe('invalid-params');
    expect(await code(own('/bars', { ...bar, reason: 'cannot-finish:transient' }))).toBe('invalid-params');
    expect(await code(own('/bars', { ...bar, applies: 'advance' }))).toBe('invalid-params');
    expect(await code(own('/bars', { ...bar, ends_at: T0 - 1 }))).toBe('invalid-params');
    expect(await code(own('/bars', { ...bar, colour: 'red' }))).toBe('invalid-params');
    expect(await code(own('/bars/999/lift', {}))).toBe('not-found');
    const { json } = await own('/bars', { ...bar, legs: ['fix'] });
    expect(await code(own(`/bars/${json.id}/lift`, {}))).toBe(200);
    expect(await code(own(`/bars/${json.id}/lift`, {}))).toBe('not-found');
  });

  it('settings refuse an empty body, a named leg under *, except beside a named leg, a leg the course file lacks, a bad retry or trigger', async () => {
    const put = (body: unknown) => code(own('/settings', body, 'PUT'));
    expect(await put({})).toBe('invalid-params');
    expect(await put({ required_bars: [{ course: '*', leg: 'fix', tag_prefix: 'family:' }] })).toBe('invalid-params');
    expect(await put({ required_bars: [{ course: 'roadmap-pr', leg: 'fix', except: ['merge'], tag_prefix: 'family:' }] })).toBe('invalid-params');
    expect(await put({ required_bars: [{ course: 'roadmap-pr', leg: 'polish', tag_prefix: 'family:' }] })).toBe('invalid-params');
    expect(await put({ required_bars: [{ course: 'roadmap-pr', leg: 'fix', tag_prefix: '' }] })).toBe('invalid-params');
    expect(await put({ retry: { backoff_ms: [1000], max_failed: 2 } })).toBe('invalid-params');
    expect(await put({ retry: { backoff_ms: [3_600_000], max_failed: 0 } })).toBe('invalid-params');
    expect(await put({ transcript_repos: ['not a repo'] })).toBe('invalid-params');
    expect(await put({ unblocked_trigger: { kind: 'github-app', workflow: 'x.yml' } })).toBe('invalid-params');
    expect(await put({ required_bars: [{ course: 'roadmap-pr', leg: 'fix', tag_prefix: 'family:' }], retry: null })).toBe(200);
  });
});

describe('R-BTN-67: owner bars per course', () => {
  const COURSES = [{ repository: 'docs', course: 'roadmap-pr', version: 3 }, { repository: 'docs', course: 'chore', version: 1 }];
  beforeEach(async () => {
    git.registry = [course(), course(1, 1, { id: 'chore', skill: 'chore', course: chore, step_kinds: ['other'] })];
    await git.add('C-1', { course_id: 'chore', rank: 1 }, placed('open', [], [['do', 'ready']])).post();
  });

  it('a bar on chore never bars a roadmap-pr leg; a * bar bars both', async () => {
    const w = await register('vm-a', { courses: COURSES, tags: ['family:x'] });
    const { json: bar } = await own('/bars', { course: 'chore', tag: 'family:x', applies: 'claim', reason: 'chore-only' });
    expect(await recommended(w.id)).toEqual(['docs:T-1']);
    expect((await claimItem('vm-a', w.secret, { ticket_id: 'docs:C-1' })).json).toMatchObject({ code: 'barred-tag', rule: 8 });
    await own(`/bars/${bar.id}/lift`, {});
    expect((await recommended(w.id)).sort()).toEqual(['docs:C-1', 'docs:T-1']);
    await own('/bars', { course: '*', tag: 'family:x', applies: 'claim', reason: 'everything' });
    expect(await recommended(w.id)).toEqual([]);
    expect((await claimItem('vm-a', w.secret, { ticket_id: 'docs:T-1' })).json).toMatchObject({ code: 'barred-tag', rule: 8 });
  });

  it('a bar on named legs bars only those legs', async () => {
    const w = await register('vm-a', { courses: COURSES, tags: ['family:x'] });
    await own('/bars', { course: 'roadmap-pr', legs: ['fix'], tag: 'family:x', applies: 'claim', reason: 'fix-only' });
    expect((await recommended(w.id)).sort()).toEqual(['docs:C-1', 'docs:T-1']);
  });
});

describe('requiredBarCovers and the reason rule', () => {
  const g = graphOf(roadmapPr);
  const { fix, ...others } = roadmapPr.legs;
  const renamed = graphOf({ ...roadmapPr, legs: { ...others, address: { ...fix, renamed_from: 'fix' } } });
  it('a named leg follows renamed_from; * covers every leg but except’s; a course bar covers its course only', () => {
    const bar = { course: 'roadmap-pr', leg: 'fix', tag_prefix: 'family:' };
    expect(requiredBarCovers(bar, 'roadmap-pr', 'fix', g)).toBe(true);
    expect(requiredBarCovers(bar, 'roadmap-pr', 'address', renamed)).toBe(true);
    expect(requiredBarCovers(bar, 'chore', 'fix', null)).toBe(false);
    const all = { course: '*', leg: '*', except: ['implement', 'fix'], tag_prefix: 'family:' };
    expect(requiredBarCovers(all, 'chore', 'do', null)).toBe(true);
    expect(requiredBarCovers(all, 'roadmap-pr', 'implement', g)).toBe(false);
    expect(requiredBarCovers(all, 'roadmap-pr', 'address', renamed)).toBe(false);
    // A missing except entry is dropped: it excepts nothing.
    expect(requiredBarCovers({ ...all, except: ['polish'] }, 'roadmap-pr', 'merge', g)).toBe(true);
  });
  it('an owner bar’s reason is never one of §6.5’s closed reasons', () => {
    expect(isOwnerBarReason('quota')).toBe(true);
    for (const r of ['done', 'cannot-finish', 'leg-timeout', 'awaiting-review-capacity', 'Bad Reason', '']) expect([r, isOwnerBarReason(r)]).toEqual([r, false]);
    expect(checkRetry({ backoff_ms: [60_000], max_failed: 1 })).toEqual({ backoff_ms: [60_000], max_failed: 1 });
  });
});

describe('round 1: one role per key, revocations that stay, bars that name what exists', () => {
  it('a key named both as owner and as sync key is refused, and nothing is registered (1-A-1)', async () => {
    const k = await makeKey('ssh-ed25519', 'both');
    expect(await code(adm('/repositories', { ...REGISTER, owner_keys: [k.publicKey], sync_keys: [{ public_key: k.publicKey, role: 'sync' }] }))).toBe('conflict');
    expect(await rows(`SELECT id FROM repositories WHERE id = 'ops'`)).toEqual([]);
    // A change likewise refuses before it writes a sync key.
    expect(await code(adm('/repositories', { id: 'docs', owner_keys_add: [k.publicKey], sync_keys_add: [{ public_key: k.publicKey, role: 'sync' }] }))).toBe('conflict');
    expect(await rows('SELECT 1 FROM sync_keys WHERE fingerprint = ?', k.fingerprint)).toEqual([]);
  });

  it('an owner key an administrator revoked is never added back by another owner (1-A-3)', async () => {
    const second = await makeKey('ssh-ed25519', 'second');
    await own('/owners', { public_key: second.publicKey });
    expect(await code(adm(`/keys/${encodeURIComponent(second.fingerprint)}/revoke`, {}))).toBe(200);
    expect(await code(own('/owners', { public_key: second.publicKey }))).toBe('conflict');
    expect(await code(keyCall(second, '/v1/owner/docs/bars', { course: '*', tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe('unauthenticated');
  });

  it('a key added to BATON_ADMIN_KEYS after it was an owner or a worker acts as neither (1-A-7)', async () => {
    await own('/grants', { public_key: worker.publicKey, hostname: 'w-host', capabilities: ['agent-venue'] });
    await setAdminKeys(admin, owner, worker);
    expect(await code(own('/bars', { course: '*', tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe('forbidden');
    const created = Math.floor((await withCore((c) => c.now())) / 1000);
    const res = await hostCall(await signedRequest(worker, `${ORIGIN}/v1/runner/heartbeat`, { created, body: JSON.stringify(hbBody('vm-a', { hostname: 'w-host', session_name: 'w', secret_hash: await sha256('s') })) }));
    expect(res.status).toBe(403);
  });

  it('an owner grants no BATON_KEYS-seeded key; an administrator takes it over (1-B-0)', async () => {
    await rows(`INSERT INTO credentials (id, hostname, allowed_capabilities, kind, public_key, created_by) VALUES (?, 'seeded', '["agent-venue"]', 'worker', ?, 'seed')`,
      worker.fingerprint, worker.publicKey.split(' ').slice(0, 2).join(' '));
    expect(await code(own('/grants', { public_key: worker.publicKey, capabilities: [] }))).toBe('conflict');
    expect(await rows('SELECT created_by FROM credentials WHERE id = ?', worker.fingerprint)).toEqual([{ created_by: 'seed' }]);
    expect(await code(adm('/grants', { repository: 'docs', public_key: worker.publicKey, capabilities: [] }))).toBe(200);
    expect(await rows('SELECT created_by FROM credentials WHERE id = ?', worker.fingerprint)).toEqual([{ created_by: `admin:${admin.fingerprint}` }]);
  });

  it('an owner bar names a course the repository registers, and legs its file has (1-A-4)', async () => {
    expect(await code(own('/bars', { course: 'chores', tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe('invalid-params');
    expect(await code(own('/bars', { course: 'roadmap-pr', legs: ['fx'], tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe('invalid-params');
    expect(await code(own('/bars', { course: 'roadmap-pr', legs: ['fix'], tag: 'a:b', applies: 'claim', reason: 'x' }))).toBe(200);
  });

  it('a retry policy has at least one backoff (1-B-4); a required-bar change dispatches the sync (1-A-8)', async () => {
    expect(await code(own('/settings', { retry: { backoff_ms: [], max_failed: 2 } }, 'PUT'))).toBe('invalid-params');
    const sent = await captureDispatches();
    expect(await code(own('/settings', { required_bars: [{ course: 'roadmap-pr', leg: 'fix', tag_prefix: 'family:' }] }, 'PUT'))).toBe(200);
    await tick();
    expect(sent).toContain('docs:sync');
  });

  it('the dashboard: Access alone serves only while no administrator key is configured; a session always (1-A-6)', async () => {
    const access = () => ownerCall('/v1/ui/state');
    expect((await access()).status).toBe(401);
    expect((await sessionCall(await adminSession(admin), '/v1/ui/state')).status).toBe(200);
    await setAdminKeys();
    expect((await access()).status).toBe(200);
  });
});
