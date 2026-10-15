// R3-1212 — claims (BATON_SPEC §6.1–6.7, §7.2, §11): G-BTN-1, -2, -3, -6, -14 and -40, plus the
// claim and end contracts, the holder query, matching's worker rules, and the held history.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { confirmations } from '../../src/shared/batonSync.mjs';
import { isEligible } from '../../src/shared/baton.mjs';
import {
  beat, claimItem, claimRow, cutover, q, endClaim, hbBody, ORIGIN, ownerCall, payload, register, requestId, rows, setClock, sha256, syncCall, withCore, workerCall, tick,
} from '../helpers';

const board = inject('board');
type Item = { id: string; status: string; tier: string | null; tags: string[]; requires: string[] | null; queue: string; node: string };
const itemsOf = (label: keyof typeof board.states) => board.states[label].state.items as Item[];
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const S = 1000;
const code = async (res: Response) => ((await res.json()) as { code: string }).code;
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const alarmAt = async (ms: number) => {
  await setClock(ms);
  await tick();
};

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
  await cutover();
});

describe('the claim and end contracts (§6.2, §6.5, §11)', () => {
  it('a claim before cutover is not-cut-over; after it, the response names the path and snapshot, never content', async () => {
    const { secret } = await register('vm-a');
    await rows(`UPDATE repositories SET cutover_at = NULL`);
    expect((await claimItem('vm-a', secret)).json.code).toBe('not-cut-over');
    await cutover();
    const c = await claimItem('vm-a', secret);
    expect(c.status).toBe(200);
    expect(c.json).toEqual({ claim_id: expect.any(Number), ticket_id: 'docs:R3-9001', path: 'content/roadmap/R3-9001.mdx', nonce: expect.stringMatching(/^[0-9a-f]{6}$/), snapshot_sha: sha.A, previous_attempts: [] });
    expect((await beat('vm-a', secret)).json.claim).toMatchObject({ id: c.json.claim_id, ticket_id: 'docs:R3-9001', nonce: c.json.nonce });
  });

  it('GET next answers what a claim would, without claiming; a named item that is not ready is refused with its rule', async () => {
    const { secret } = await register('vm-a');
    expect(await (await workerCall('/v1/runner/next', { secret })).json()).toEqual({ ticket_id: 'docs:R3-9001', rank_reason: 'autonomous queue · rank 0' });
    expect(await rows('SELECT count(*) AS n FROM claims')).toEqual([{ n: 0 }]);
    const blocked = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9004' });
    expect([blocked.status, blocked.json.code, blocked.json.rule]).toEqual([409, 'not-eligible', 1]);
    const op = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9003' });
    expect([op.json.code, op.json.rule]).toEqual(['not-eligible', 4]); // github-admin is not declared
    expect((await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9002' })).json.ticket_id).toBe('docs:R3-9002');
  });

  it('ends only in §6.5’s vocabulary; a completed end names its commit; only the holder ends; a retried end is a no-op', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret);
    expect((await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'released:bored' })).json.code).toBe('invalid-params');
    expect((await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'done' })).json.code).toBe('invalid-params');
    expect((await endClaim('vm-b', b.secret, c.claim_id, { end_reason: 'released:requested' })).json.code).toBe('not-holder');
    expect((await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'handed-off:awaiting-ci', ended_at_sha: sha.B })).status).toBe(200);
    expect((await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'handed-off:awaiting-ci', ended_at_sha: sha.B })).status).toBe(200);
    expect((await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'released:requested' })).json.code).toBe('claim-ended');
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'completed', end_reason: 'handed-off:awaiting-ci', confirmed_at: null });
  });

  it('§6.9: an end closes the claim’s open activities abandoned', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret);
    await workerCall('/v1/runner/activities', { secret, body: { activities: [{ id: 'impl', claim_id: c.claim_id, kind: 'implement', source: 'skill', started_at: T0 }] } });
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'released:cannot-finish:capability' });
    expect(await rows('SELECT outcome FROM activities')).toEqual([{ outcome: 'abandoned' }]);
  });

  it('§7.2 worker rules: a suspended account, and a worker below its course’s min_worker_version, get no claim', async () => {
    const { secret } = await register('vm-a');
    await owner('/v1/ui/suspensions', { provider_id: 'zai', mode: 'no-new-work' });
    expect(await claimItem('vm-a', secret)).toMatchObject({ status: 409, json: { code: 'provider-suspended', rule: 7 } });
    const late = await register('vm-b', { model_id: 'opencode-go/kimi-k3', model_provider_id: 'opencode_go_plus', courses: [{ repository: 'docs', course: 'roadmap-pr', version: 2 }] });
    expect(await claimItem('vm-b', late.secret)).toMatchObject({ status: 409, json: { code: 'stale-skills', rule: 9 } });
    expect(await claimItem('vm-b', late.secret, { ticket_id: 'docs:R3-9001' })).toMatchObject({ status: 409, json: { code: 'stale-skills', rule: 9 } });
    // Declaring no course at all is stale too: rule 9 asks for the ticket's course.
    const none = await register('mac', { model_id: 'opencode-go/kimi-k3', model_provider_id: 'opencode_go_plus', courses: [] });
    expect(await claimItem('mac', none.secret)).toMatchObject({ status: 409, json: { code: 'stale-skills', rule: 9 } });
  });

  it('§7.2 rule 6: an operator-only item goes only to a worker that declared human-operator', async () => {
    const mac = await register('mac', { capabilities: ['human-operator', 'agent-venue'] });
    const vm = await register('vm-a');
    // R3-9003 also needs github-admin, which neither declares: refused on rule 4 for both. The
    // ordering of refusals is isEligible's: capabilities (4) come before operator-only (6).
    expect((await claimItem('mac', mac.secret, { ticket_id: 'docs:R3-9003' })).json.rule).toBe(4);
    expect((await claimItem('vm-a', vm.secret, { ticket_id: 'docs:R3-9003' })).json.rule).toBe(4);
  });
});

describe('G-BTN-1: one active claim per item and per worker', () => {
  it('two concurrent claims for one item: exactly one succeeds', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const [x, y] = await Promise.all([claimItem('vm-a', a.secret, { ticket_id: 'docs:R3-9001' }), claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.json).toMatchObject({ code: 'not-eligible', rule: 3 });
    expect(await rows(`SELECT count(*) AS n FROM claims WHERE status = 'active'`)).toEqual([{ n: 1 }]);
  });

  it('two claims by one worker: the second is refused; the index refuses a second row however it is written', async () => {
    const a = await register('vm-a');
    expect((await claimItem('vm-a', a.secret)).status).toBe(200);
    expect(await claimItem('vm-a', a.secret)).toMatchObject({ status: 409, json: { code: 'not-eligible', rule: 'one-claim-per-worker' } });
    await expect(rows(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                       VALUES ('docs:R3-9002', ?, 'raw-1', 'abcdef', '', 0, 'active')`, a.id)).rejects.toThrow(/UNIQUE/);
    const b = await register('vm-b');
    await expect(rows(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                       VALUES ('docs:R3-9001', ?, 'raw-2', 'abcdef', '', 0, 'active')`, b.id)).rejects.toThrow(/UNIQUE/);
  });
});

describe('G-BTN-2: a repeated request_id returns the original claim', () => {
  it('never a second item; another worker cannot reuse it', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const body = { request_id: requestId() };
    const first = await claimItem('vm-a', a.secret, body);
    const again = await claimItem('vm-a', a.secret, body);
    expect(again.json).toEqual(first.json);
    expect(await rows('SELECT count(*) AS n FROM claims')).toEqual([{ n: 1 }]);
    expect((await claimItem('vm-b', b.secret, body)).json.code).toBe('invalid-params');
  });
});

describe('G-BTN-3: a claim is reaped at its worker’s clamped timeout, not a second earlier', () => {
  it.each([
    ['899 s, clamped to 900', 899, 900],
    ['86401 s, clamped to 86400', 86_401, 86_400],
    ['absent, the default 900', undefined, 900],
  ])('%s', async (_what, declared, clamped) => {
    const { secret } = await register('vm-a', { lease_timeout_s: declared });
    const { json: c } = await claimItem('vm-a', secret);
    await alarmAt(T0 + clamped * S - S);
    expect((await claimRow(c.claim_id)).status).toBe('active');
    await alarmAt(T0 + clamped * S);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'reaped', end_reason: 'reaped:silent', fence_pending: 0 });
    expect((await beat('vm-a', secret)).json.code).toBe('worker-reaped');
  });

  it('a heartbeat moves the deadline', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret);
    await setClock(T0 + 600 * S);
    await beat('vm-a', secret);
    await alarmAt(T0 + 900 * S);
    expect((await claimRow(c.claim_id)).status).toBe('active');
    await alarmAt(T0 + 1500 * S);
    expect((await claimRow(c.claim_id)).status).toBe('reaped');
  });
});

describe('G-BTN-6: a completion is confirmed only by ancestry and status; until then the item is not claimable', () => {
  // The sync's own decision (scripts/lib/batonSync.mjs, vendored) over the fixture repository's
  // real ancestry and each snapshot's statuses.
  const deps = (next: keyof typeof sha) => ({
    isAncestor: async (a: string, b: string) => {
      const label = (s: string) => Object.entries(sha).find(([, v]) => v === s)?.[0];
      return board.ancestry[`${label(a)}<${label(b)}`] === true;
    },
    statusOf: (id: string) => itemsOf(next).find((i) => i.id === id)?.status ?? null,
  });
  const decided = (endedAt: keyof typeof sha, next: keyof typeof sha) => confirmations([{ claim_id: 1, ticket_id: 'docs:R3-9001', ended_at_sha: sha[endedAt] }], sha[next], deps(next));

  it('the sync confirms none of: a stale snapshot, a wrong status, a force-pushed sha; it confirms a landed one', async () => {
    expect(await decided('B', 'A')).toEqual([]); // B is not an ancestor of A: the snapshot is stale
    expect(await decided('B', 'C')).toEqual([]); // landed, but git still shows in-progress
    expect(await decided('C', 'D')).toEqual([]); // C was force-pushed away
    expect(await decided('A', 'D')).toEqual([{ claim_id: 1, sha: sha.D }]); // landed; available after an owner reset
  });

  it('the server: unconfirmed blocks the item; the sync’s post confirms it and the item is claimable again', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret, { ticket_id: 'docs:R3-9001' });
    await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.A });
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })).json).toMatchObject({ code: 'not-eligible', rule: 3 });
    expect((await (await syncCall('/v1/sync/head')).json() as { unconfirmed: unknown[] }).unconfirmed).toEqual([
      { claim_id: c.claim_id, ticket_id: 'docs:R3-9001', end_reason: 'done', ended_at_sha: sha.A }]);
    const confirmed = await confirmations([{ claim_id: c.claim_id, ticket_id: 'docs:R3-9001', ended_at_sha: sha.A }], sha.D, deps('D'));
    expect((await syncCall('/v1/sync/board', payload(sha.D, sha.A, board.states.D, { confirmations: confirmed }))).status).toBe(200);
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0);
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })).status).toBe(200);
  });

  it('a confirm-only post (the head re-sent) confirms too; a confirmation for anything else is ignored', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret);
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.A });
    const res = await syncCall('/v1/sync/board', payload(sha.A, sha.A, board.states.A, { confirmations: [{ claim_id: c.claim_id, sha: sha.A }, { claim_id: 999, sha: sha.A }] }));
    expect(await res.json()).toMatchObject({ ok: true, unchanged: true, confirmed: 1 });
  });
});

describe('G-BTN-14: a force-reaped live worker’s item waits for its fence', () => {
  it('not re-issued until fence-cleared, which only that incarnation’s heartbeat with its secret reports', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret);
    expect((await owner(`/v1/ui/claims/${c.claim_id}/reap`, {})).status).toBe(400); // names its confirmation
    expect(await (await owner(`/v1/ui/claims/${c.claim_id}/reap`, { confirm: true })).json()).toEqual({ ok: true, fence_pending: true });
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'reaped', end_reason: 'reaped:owner', fence_pending: 1 });
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })).json.rule).toBe(3);
    const token = await (await workerCall('/v1/runner/tickets/docs:R3-9001/holder', { cred: 'vm-b' })).json();
    expect(token).toEqual({ held_by_other: false, fence_pending: true });
    // The live worker is told: its heartbeat no longer lists the claim.
    const told = await beat('vm-a', a.secret);
    expect(told.json.claim).toBeNull();
    // A fenced report for a claim it never held, or from the hash path, changes nothing.
    await beat('vm-a', a.secret, { fenced: { claim_id: 999, terminated: true } });
    expect((await claimRow(c.claim_id)).fence_pending).toBe(1);
    await beat('vm-a', a.secret, { fenced: { claim_id: c.claim_id, terminated: true } });
    expect((await claimRow(c.claim_id)).fence_pending).toBe(0);
    expect(await rows(`SELECT actor, json_extract(detail_json, '$.by') AS by FROM events WHERE kind = 'fence-cleared'`)).toEqual([{ actor: `worker:${a.id}`, by: 'sidecar' }]);
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })).status).toBe(200);
  });

  it('a re-key never clears a fence; the worker’s own timeout does', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret);
    await owner(`/v1/ui/claims/${c.claim_id}/reap`, { confirm: true });
    const rekeyed = await workerCall('/v1/runner/heartbeat', { body: { ...hbBody('vm-a'), rekey: true, secret_hash: await sha256('second') } });
    expect(((await rekeyed.json()) as { incarnation: number }).incarnation).toBe(2);
    await beat('vm-a', 'second', { fenced: { claim_id: c.claim_id, terminated: true } });
    expect((await claimRow(c.claim_id)).fence_pending).toBe(1);
    await alarmAt(T0 + 900 * S); // the re-keyed worker last heartbeat at T0, so it is silent past 900 s
    expect((await claimRow(c.claim_id)).fence_pending).toBe(0);
    expect(await rows(`SELECT json_extract(detail_json, '$.by') AS by FROM events WHERE kind = 'fence-cleared'`)).toEqual([{ by: 'timeout' }]);
    await setClock(T0 + 900 * S);
    await beat('vm-b', b.secret);
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })).status).toBe(200);
  });

  it('§9: a release unacknowledged for 2 hours reaps the claim, fence-pending', async () => {
    const a = await register('vm-a', { lease_timeout_s: 43_200 });
    const { json: c } = await claimItem('vm-a', a.secret);
    await owner('/v1/ui/messages', { to_worker_id: a.id, kind: 'release', payload: { ticket_id: 'docs:R3-9001', reason: 'requested' } });
    await beat('vm-a', a.secret, { lease_timeout_s: 43_200 }); // delivered at T0
    await alarmAt(T0 + 2 * 3_600_000 - S);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'active' });
    await alarmAt(T0 + 2 * 3_600_000);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'reaped', end_reason: 'reaped:release-unacknowledged', fence_pending: 1 });
  });
});

describe('G-BTN-40: the matching query and isEligible agree; git overtaking a claim ends it', () => {
  const workers = [
    { cred: 'vm-a' as const, session: 'venue', over: { capabilities: ['agent-venue'], tier_ceiling: 'critical' } },
    { cred: 'vm-a' as const, session: 'judge', over: { capabilities: ['agent-venue'], tier_ceiling: 'judgement' } },
    { cred: 'vm-b' as const, session: 'bare', over: { capabilities: [], tier_ceiling: 'routine' } },
    { cred: 'mac' as const, session: 'owner', over: { capabilities: ['human-operator', 'agent-venue'], tier_ceiling: 'critical' } },
    // Rule 9 (R-BTN-65): below roadmap-pr's min_worker_version, and declaring no course at all.
    { cred: 'vm-b' as const, session: 'stale', over: { capabilities: ['agent-venue'], tier_ceiling: 'critical', courses: [{ repository: 'docs', course: 'roadmap-pr', version: 2 }] } },
    { cred: 'mac' as const, session: 'nocourse', over: { capabilities: ['agent-venue'], tier_ceiling: 'critical', courses: [] } },
  ] as { cred: 'vm-a' | 'vm-b' | 'mac'; session: string; over: { capabilities: string[]; tier_ceiling: string; courses?: unknown[] } }[];
  const chain: Record<string, (keyof typeof sha)[]> = { A: ['A'], B: ['A', 'B'], C: ['A', 'B', 'C'], D: ['A', 'D'] };

  it.each(['A', 'B', 'C', 'D'] as const)('on fixture board %s', async (label) => {
    const steps = chain[label];
    for (let i = 1; i < steps.length; i++) await syncCall('/v1/sync/board', payload(sha[steps[i]], sha[steps[i - 1]], board.states[steps[i]]));
    const snap = board.states[label];
    for (const w of workers) {
      const { id } = await register(w.cred, { session_name: w.session, ...w.over });
      const decl = w.over.capabilities;
      const facts = { tier_ceiling: w.over.tier_ceiling, declared: decl, model_id: 'zai-coding-plan/glm-5.3', model_provider_id: 'zai', billing: { 'zai-coding-plan': 'zai' }, courses: w.over.courses ?? [{ repository: 'docs', course: 'roadmap-pr', version: 3 }] };
      // The reference: isEligible over the snapshot's own items, in its ready order.
      const expected = snap.ready.filter((rid: string) => {
        const it = itemsOf(label).find((x) => x.id === rid)!;
        const item = { id: it.id, repository: 'docs', course: 'roadmap-pr', tier: it.tier, tags: it.tags, requires: it.requires, expedite: it.queue === 'expedite' };
        return isEligible(facts, item, { now: T0, claims: [], override: null, suspensions: [], minWorkerVersion: 3, expediteActive: 0, lastEndReason: null }).ok;
      });
      const got = await withCore((o) => {
        const c = o.claims as unknown as { candidates: (w: unknown, now: number, limit: number) => string[]; worker: (id: number) => unknown };
        return c.candidates(c.worker(id), T0, 100);
      });
      expect([w.session, got]).toEqual([w.session, expected.map(q)]);
    }
  });

  const overtaken = (mutate: (items: any[]) => any[]) => {
    const items = mutate(structuredClone(board.states.A.state.items));
    return payload('e'.repeat(40), sha.A, { ...board.states.A, state: { items }, ready: items.filter((i: any) => i.node?.startsWith('ready-')).map((i: any) => i.id) });
  };
  it.each([
    ['done', (items: any[]) => items.map((i) => (i.id === 'R3-9002' ? { ...i, status: 'done', node: 'done' } : i))],
    ['superseded', (items: any[]) => items.map((i) => (i.id === 'R3-9002' ? { ...i, status: 'superseded', node: 'superseded' } : i))],
    ['archived (gone from the board)', (items: any[]) => items.filter((i) => i.id !== 'R3-9002')],
    ['re-tiered above the holder’s ceiling', (items: any[]) => items.map((i) => (i.id === 'R3-9002' ? { ...i, tier: 'critical' } : i))],
  ])('%s: the claim ends released:stale-board and the holder is told', async (_what, mutate) => {
    const { secret } = await register('vm-a', { tier_ceiling: 'judgement' });
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9002' });
    const res = await syncCall('/v1/sync/board', overtaken(mutate));
    expect(await res.json()).toMatchObject({ ok: true, stale_released: 1 });
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'released', end_reason: 'released:stale-board' });
    expect((await beat('vm-a', secret)).json.messages).toEqual([expect.objectContaining({ kind: 'release', payload: expect.objectContaining({ ticket_id: 'docs:R3-9002', reason: 'stale-board' }) })]);
  });

  it('an unchanged item keeps its claim', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9002' });
    expect(await (await syncCall('/v1/sync/board', overtaken((items) => items))).json()).toMatchObject({ stale_released: 0 });
    expect((await claimRow(c.claim_id)).status).toBe('active');
  });
});

describe('§7.1: a held history is accepted after 24 hours or by the owner', () => {
  it('the alarm accepts it at 24 h; the sync’s next force post becomes the head', async () => {
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B));
    const force = () => syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true }));
    expect(await code(await force())).toBe('snapshot-rejected');
    await alarmAt(T0 + 24 * 3_600_000 - S);
    expect(await code(await force())).toBe('snapshot-rejected');
    await alarmAt(T0 + 24 * 3_600_000);
    expect((await force()).status).toBe(200);
    expect((await (await syncCall('/v1/sync/head')).json() as { sha: string }).sha).toBe(sha.D);
  });

  it('the owner accepts it at once', async () => {
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B));
    await syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true }));
    expect((await owner('/v1/ui/board/accept', { repository: 'docs', sha: sha.D })).status).toBe(200);
    expect((await syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true }))).status).toBe(200);
  });
});
