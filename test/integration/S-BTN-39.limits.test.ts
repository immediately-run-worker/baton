// S-BTN-39 limits agents cannot change (BATON_SPEC §13a, R-BTN-66, R-BTN-67, R-BTN-23, R-BTN-58;
// R3-1240): docs' owner sets an owner bar on `account:go_plus` (every course, claims only, from
// +1 h), an owner bar on `family:x` for the course `chore` only, the required bar
// `{course: roadmap-pr, leg: *, except: [implement, review, adjudicate], tag_prefix: family:}`,
// `retry` of one backoff, and a grant `max_tier` of routine; an agent then commits a sync that
// drops every `family:` bar, a `baton.json` with no backoff, and a ticket re-tiered `routine` from
// `critical`. Must hold: from +1 h Go workers are refused new claims `barred-tag` while a held Go
// claim still advances; the `chore` bar bars no `roadmap-pr` leg; the next snapshot's `fix` and
// `merge` legs are stored `waiting` on `policy` and listed under Needs you; the retry policy is
// the owner's; the re-tiered ticket is offered to the routine-capped key (a ticket's tier is
// git's), which the dashboard shows beside the commit that changed it. Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { advance, beat, claimItem, cutover, endClaim, Git, hbBody, keyCall, ORIGIN, ownerCall, placed, register, rows, setAdminKeys, setClock, sha256, withCore } from '../helpers';
import { makeKey, signedRequest, type TestKey } from '../lib/sshKeys';
import { call as hostCall } from '#host';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const H = 3_600_000;
const REVIEWED: [string, string][] = [['implement', 'pr-open'], ['review', 'reviewed']];
const AT_REVIEWED = (bars: Record<string, string[]>) =>
  placed('reviewed', REVIEWED, [['fix', 'ready'], ['adjudicate', 'waiting', 'disagreement'], ['merge', 'ready']], { bars });
let admin: TestKey;
let owner: TestKey;
let git: Git;

const own = (path: string, body: unknown, method?: string) => keyCall(owner, `/v1/owner/docs${path}`, body, method);

async function workerAs(key: TestKey, path: string, body?: unknown, secret?: string) {
  const created = Math.floor((await withCore((c) => c.now())) / 1000);
  const req = await signedRequest(key, ORIGIN + path, { created, body: body === undefined ? undefined : JSON.stringify(body), headers: secret ? { 'X-Worker-Secret': secret } : {} });
  const res = await hostCall(req);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeEach(async () => {
  await setClock(T0);
  admin = await makeKey('ssh-ed25519', 'admin');
  owner = await makeKey('ssh-ed25519', 'docs-owner');
  await setAdminKeys(admin);
  git = new Git()
    .add('T-1', { rank: 1 })
    .add('T-2', { rank: 2 })
    .add('T-3', { rank: 3 }, AT_REVIEWED({ fix: ['family:glm'], merge: ['family:glm'] }))
    .add('T-4', { rank: 4, tier: 'critical' });
  await git.post();
  await cutover();
  expect((await keyCall(admin, '/v1/admin/repositories', { id: 'docs', owner_keys_add: [owner.publicKey] })).status).toBe(200);
});

describe('S-BTN-39 limits agents cannot change', () => {
  it('an owner bar on every course, claims only, from +1 h: new Go claims are refused, a held one still advances', async () => {
    expect((await own('/bars', { course: '*', tag: 'account:go_plus', applies: 'claim', starts_at: T0 + H, reason: 'go-quota' })).status).toBe(200);
    // Scheduled, not yet in force: the observation shows it, and a Go worker still claims.
    const go1 = await register('vm-a', { tags: ['account:go_plus'] });
    const held = await claimItem('vm-a', go1.secret, { ticket_id: 'docs:T-1' });
    expect(held.status).toBe(200);

    await setClock(T0 + H);
    const go2 = await register('vm-b', { tags: ['account:go_plus'] });
    expect((await claimItem('vm-b', go2.secret, { ticket_id: 'docs:T-2' })).json).toMatchObject({ code: 'barred-tag', rule: 8 });
    // The heartbeat names the bar in force.
    expect((await beat('vm-a', go1.secret)).json.bars).toEqual([expect.objectContaining({ tag: 'account:go_plus', course: '*', applies: 'claim' })]);
    // Claims only: the held Go claim advances.
    expect((await advance('vm-a', go1.secret, held.json.claim_id, { leg: 'implement' })).json).toMatchObject({ ok: true, station: 'filed' });
    expect((await advance('vm-a', go1.secret, held.json.claim_id, { reached: 'pr-open', leg: 'review' })).json).toMatchObject({ ok: true, station: 'pr-open' });
    // Another worker is not barred.
    const other = await register('test', { tags: ['account:other'] });
    expect((await claimItem('test', other.secret, { ticket_id: 'docs:T-2' })).status).toBe(200);
  });

  it('a bar for the course chore bars no roadmap-pr leg', async () => {
    expect((await own('/bars', { course: 'chore', tag: 'family:x', applies: 'claim+advance', reason: 'chore-only' })).status).toBe(200);
    const x = await register('vm-a', { tags: ['family:x'] });
    const c = await claimItem('vm-a', x.secret, { ticket_id: 'docs:T-1' });
    expect(c.status).toBe(200);
    expect((await advance('vm-a', x.secret, c.json.claim_id, { leg: 'implement' })).status).toBe(200);
    expect((await advance('vm-a', x.secret, c.json.claim_id, { reached: 'pr-open', leg: 'review' })).status).toBe(200);
  });

  it('a sync that drops every family: bar leaves fix and merge waiting on policy, under Needs you', async () => {
    const required = [{ course: 'roadmap-pr', leg: '*', except: ['implement', 'review', 'adjudicate'], tag_prefix: 'family:' }];
    expect((await own('/settings', { required_bars: required }, 'PUT')).status).toBe(200);
    // With the bars posted, fix is ready.
    await git.refresh();
    expect(await rows(`SELECT leg, state, waiting_on FROM ticket_next_legs WHERE ticket_id = 'docs:T-3' ORDER BY leg`)).toEqual([
      { leg: 'adjudicate', state: 'waiting', waiting_on: 'disagreement' },
      { leg: 'fix', state: 'ready', waiting_on: null },
      { leg: 'merge', state: 'ready', waiting_on: null },
    ]);
    // An agent commits a course-side change that posts no bars at all.
    git.place('T-3', AT_REVIEWED({}));
    expect(await git.post()).toMatchObject({ status: 200 });
    expect(await rows(`SELECT leg, state, waiting_on FROM ticket_next_legs WHERE ticket_id = 'docs:T-3' ORDER BY leg`)).toEqual([
      { leg: 'adjudicate', state: 'waiting', waiting_on: 'disagreement' },
      { leg: 'fix', state: 'waiting', waiting_on: 'policy' },
      { leg: 'merge', state: 'waiting', waiting_on: 'policy' },
    ]);
    const state = (await (await ownerCall('/v1/ui/state')).json()) as Record<string, any>;
    expect(state.needs_you.policy).toEqual([
      { ticket_id: 'docs:T-3', leg: 'fix', waiting_since: T0 },
      { ticket_id: 'docs:T-3', leg: 'merge', waiting_since: T0 },
    ]);
    // Nor is the ticket offered.
    const w = await register('vm-a', { tags: ['family:glm'] });
    expect((await claimItem('vm-a', w.secret, { ticket_id: 'docs:T-3' })).status).toBe(409);
  });

  it('the retry policy and transcript repositories are the owner’s, whatever baton.json says', async () => {
    expect((await own('/settings', { retry: { backoff_ms: [2 * H], max_failed: 2 }, transcript_repos: ['immediately-run/transcripts'] }, 'PUT')).status).toBe(200);
    // The sync posts a baton.json with no backoff and other transcript repositories: ignored.
    git.add('T-5', { rank: 5 });
    expect(await git.post({ retry: { backoff_ms: [], max_failed: 9 }, transcript_repos: ['someone/else'] })).toMatchObject({ status: 200 });
    expect(await rows(`SELECT retry, transcript_repos FROM repositories WHERE id = 'docs'`)).toEqual([
      { retry: JSON.stringify({ backoff_ms: [2 * H], max_failed: 2 }), transcript_repos: JSON.stringify(['immediately-run/transcripts']) },
    ]);
    const w = await register('vm-a');
    const first = await claimItem('vm-a', w.secret, { ticket_id: 'docs:T-1' });
    await endClaim('vm-a', w.secret, first.json.claim_id, { end_reason: 'released:cannot-finish:transient' });
    expect(await rows(`SELECT retry_after, hold FROM ticket_overrides WHERE ticket_id = 'docs:T-1'`)).toEqual([{ retry_after: T0 + 2 * H, hold: 0 }]);
    // The second failed attempt is the owner's max_failed: held.
    await git.refresh();
    await setClock(T0 + 2 * H);
    await beat('vm-a', w.secret);
    const second = await claimItem('vm-a', w.secret, { ticket_id: 'docs:T-1' });
    expect(second.status).toBe(200);
    await endClaim('vm-a', w.secret, second.json.claim_id, { end_reason: 'released:cannot-finish:transient' });
    expect(await rows(`SELECT hold, hold_reason FROM ticket_overrides WHERE ticket_id = 'docs:T-1'`)).toEqual([{ hold: 1, hold_reason: 'attempts-exhausted' }]);
  });

  it('a ticket re-tiered in git is offered to the routine-capped key, beside the commit that changed it', async () => {
    const k = await makeKey('ssh-ed25519', 'k');
    expect((await own('/grants', { public_key: k.publicKey, hostname: 'k-host', capabilities: ['agent-venue'], max_tier: 'routine' })).status).toBe(200);
    const secret = 'secret-k';
    expect((await workerAs(k, '/v1/runner/heartbeat', hbBody('vm-a', { hostname: 'k-host', session_name: 'k', secret_hash: await sha256(secret), tier_ceiling: 'critical' }))).json).toMatchObject({ worker_id: expect.any(Number) });
    expect((await workerAs(k, '/v1/runner/claim', { request_id: 'req-k-critical', ticket_id: 'docs:T-4' }, secret)).json).toMatchObject({ code: 'not-eligible', rule: 5 });
    // An agent re-tiers T-4 in git: the tier is git's, and the grant's cap now admits it.
    git.add('T-4', { rank: 4, tier: 'routine' });
    expect(await git.post()).toMatchObject({ status: 200 });
    const state = (await (await ownerCall('/v1/ui/state')).json()) as Record<string, any>;
    expect(state.ready.find((t: { id: string }) => t.id === 'docs:T-4')).toMatchObject({ tier: 'routine', changed_in: git.head });
    // The dashboard's limits show the grant's cap by name.
    expect(state.limits.grants).toEqual([expect.objectContaining({ repository_id: 'docs', hostname: 'k-host', max_tier: 'routine' })]);
    expect((await workerAs(k, '/v1/runner/claim', { request_id: 'req-k-routine', ticket_id: 'docs:T-4' }, secret)).json).toMatchObject({ ticket_id: 'docs:T-4' });
  });
});
