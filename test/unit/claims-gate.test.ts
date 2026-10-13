// R3-1212, closing baton#5's round-one findings: the held line, ends, the owner's resolution of an
// unconfirmed completion, the reap's dedupe, the stale-board race, rules 2 and 8 through the
// server, the hold and legacy branches, and the dashboard's Running / Timeline / Needs you data.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { runInDurableObject } from 'cloudflare:test';
import type { Baton } from '../../src/baton';
import {
  beat, claimItem, claimRow, cutover, endClaim, ORIGIN, ownerCall, payload, register, rows, setClock, stub, syncCall, workerCall, tick,
} from '../helpers';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const H = 3_600_000;
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const alarmAt = async (ms: number) => {
  await setClock(ms);
  await tick();
};
const uiState = async () => (await (await ownerCall('/v1/ui/state')).json()) as Record<string, any>;
const items = () => structuredClone(board.states.A.state.items) as Record<string, any>[];
const fake = (c: string) => c.repeat(40);

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
  await cutover();
});

describe('§7.1: accepting a held history accepts the line', () => {
  it('main moves while the history is held: the newest force post is accepted once the hold is', async () => {
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B));
    expect((await syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true }))).status).toBe(409);
    await alarmAt(T0 + 24 * H);
    // A push after the rewrite: the sync now posts main's newest commit, still against B.
    const newer = await syncCall('/v1/sync/board', payload(fake('d'), sha.B, board.states.D, { force: true }));
    expect(newer.status).toBe(200);
    expect(((await (await syncCall('/v1/sync/head')).json()) as { sha: string }).sha).toBe(fake('d'));
    // The line is accepted once: a later rewrite of the new head is held again.
    expect((await syncCall('/v1/sync/board', payload(fake('c'), fake('d'), board.states.D, { force: true }))).status).toBe(409);
  });

  it('a rewind to a once-accepted sha is held, never a backwards move', async () => {
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B));
    await syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true }));
    await owner('/v1/ui/board/accept', { sha: sha.D });
    expect((await syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true }))).status).toBe(200);
    await syncCall('/v1/sync/board', payload(fake('7'), sha.D, board.states.D));
    expect((await syncCall('/v1/sync/board', payload(sha.D, fake('7'), board.states.D, { force: true }))).status).toBe(409);
    expect(((await (await syncCall('/v1/sync/head')).json()) as { sha: string }).sha).toBe(fake('7'));
  });

  it('a held post still applies its confirmations', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret);
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.A });
    const res = await syncCall('/v1/sync/board', payload(sha.D, fake('9'), board.states.D, { force: true, confirmations: [{ claim_id: c.claim_id, sha: sha.D }] }));
    expect(res.status).toBe(409);
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0);
  });
});

describe('§6.5 ends', () => {
  it('a released end naming a commit is invalid-params, not a 500; the claim stays active', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret);
    const res = await endClaim('vm-a', secret, c.claim_id, { end_reason: 'released:requested', ended_at_sha: sha.A });
    expect([res.status, res.json.code]).toEqual([400, 'invalid-params']);
    expect((await claimRow(c.claim_id)).status).toBe('active');
  });

  it('R-BTN-8 vs R-BTN-35: a sync that releases the claim stale-board before the worker’s own done keeps the completion', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret, { work_item_id: 'R3-9002' });
    // The worker pushed git first; the sync sees the item gone before its end call arrives.
    const gone = items().filter((i) => i.id !== 'R3-9002');
    await syncCall('/v1/sync/board', payload(fake('b'), sha.A, { ...board.states.A, state: { items: gone }, ready: ['R3-9001', 'R3-9003'] }));
    expect((await claimRow(c.claim_id)).end_reason).toBe('released:stale-board');
    expect((await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: fake('b') })).status).toBe(200);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'completed', end_reason: 'done', confirmed_at: null });
    expect((await beat('vm-a', secret)).json.messages).toEqual([]); // the withdrawn release
    // A released end after stale-board is still claim-ended.
    expect((await endClaim('vm-a', secret, c.claim_id, { end_reason: 'released:requested' })).json.code).toBe('claim-ended');
  });

  it('…but not after a re-tier, nor once someone else has claimed the item', async () => {
    const a = await register('vm-a', { tier_ceiling: 'judgement' });
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' });
    const retiered = items().map((i) => (i.id === 'R3-9001' ? { ...i, tier: 'critical' } : i));
    await syncCall('/v1/sync/board', payload(fake('b'), sha.A, { ...board.states.A, state: { items: retiered }, ready: board.states.A.ready }));
    expect((await claimRow(c.claim_id)).end_reason).toBe('released:stale-board');
    expect((await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'done', ended_at_sha: fake('b') })).json.code).toBe('claim-ended');
    // Gone from git, but another worker claimed it in between: still claim-ended.
    const { json: c2 } = await claimItem('vm-b', b.secret, { work_item_id: 'R3-9001' });
    expect(c2.claim_id).toBeGreaterThan(c.claim_id);
    const gone = retiered.filter((i) => i.id !== 'R3-9001');
    await syncCall('/v1/sync/board', payload(fake('c'), fake('b'), { ...board.states.A, state: { items: gone }, ready: ['R3-9002'] }));
    expect((await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'done', ended_at_sha: fake('c') })).json.code).toBe('claim-ended');
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'released', end_reason: 'released:stale-board' });
  });
});

describe('§6.7: the owner resolves an unconfirmed completion', () => {
  const unconfirmed = async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret, { work_item_id: 'R3-9001' });
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.C });
    return c.claim_id as number;
  };

  it('confirm: the item is confirmed by the owner', async () => {
    const id = await unconfirmed();
    expect((await owner(`/v1/ui/claims/${id}/resolve`, { action: 'confirm' })).status).toBe(400); // names its confirmation
    expect((await owner(`/v1/ui/claims/${id}/resolve`, { action: 'confirm', confirm: true })).status).toBe(200);
    expect((await claimRow(id)).confirmed_at).toBe(T0);
    expect(await rows(`SELECT actor FROM events WHERE kind = 'confirmed'`)).toEqual([{ actor: 'owner:owner@example.com' }]);
  });

  it('release: the completion is voided and the item is claimable again; the commit stays in the event', async () => {
    const id = await unconfirmed();
    const b = await register('vm-b');
    expect((await owner(`/v1/ui/claims/${id}/resolve`, { action: 'release', confirm: true })).status).toBe(200);
    expect(await claimRow(id)).toMatchObject({ status: 'released', end_reason: 'released:requested' });
    expect(await rows(`SELECT json_extract(detail_json, '$.unconfirmed.ended_at_sha') AS s FROM events WHERE kind = 'released'`)).toEqual([{ s: sha.C }]);
    expect((await claimItem('vm-b', b.secret, { work_item_id: 'R3-9001' })).status).toBe(200);
    expect((await owner(`/v1/ui/claims/${id}/resolve`, { action: 'confirm', confirm: true })).status).toBe(404);
  });
});

describe('§9: two stale releases reap a claim once', () => {
  it('one reaped event; every matching release expires', async () => {
    const a = await register('vm-a', { lease_timeout_s: 43_200 });
    const { json: c } = await claimItem('vm-a', a.secret);
    for (const reason of ['requested', 'owner-cancel']) {
      await owner('/v1/ui/messages', { to_worker_id: a.id, kind: 'release', payload: { work_item_id: 'R3-9001', reason } });
    }
    await beat('vm-a', a.secret, { lease_timeout_s: 43_200 });
    await alarmAt(T0 + 2 * H);
    expect(await rows(`SELECT kind FROM events WHERE claim_id = ? ORDER BY seq`, c.claim_id)).toEqual([{ kind: 'claimed' }, { kind: 'reaped' }]);
    expect(await rows(`SELECT status FROM messages WHERE kind = 'release'`)).toEqual([{ status: 'expired' }, { status: 'expired' }]);
  });
});

describe('the holder query takes only an item id', () => {
  it('a malformed escape or a non-id is invalid-params, never a 500', async () => {
    for (const bad of ['%E0%A4%A', 'not-an-item', '..%2F..']) {
      const res = await workerCall(`/v1/worker/items/${bad}/holder`, { cred: 'vm-a' });
      expect([bad, res.status]).toEqual([bad, 400]);
    }
  });
});

describe('§7.2 rules 2 and 8 through the server', () => {
  it('rule 2: two active claims on expedited items (lane or override) hold a third back', async () => {
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B));
    await syncCall('/v1/sync/board', payload(sha.C, sha.B, board.states.C)); // R3-9005 is in the expedite lane
    await rows(`INSERT INTO item_overrides (work_item_id, expedite, set_by, set_at) VALUES ('R3-9002', 1, 'owner:test', 0)`);
    const a = await register('vm-a');
    const b = await register('vm-b');
    const t = await register('test');
    expect((await claimItem('vm-a', a.secret, { work_item_id: 'R3-9002' })).status).toBe(200); // expedited by override
    // One active expedited claim: the lane still has room.
    expect((await claimItem('vm-b', b.secret)).json.work_item_id).toBe('R3-9005');
    await rows(`INSERT INTO item_overrides (work_item_id, expedite, set_by, set_at) VALUES ('R3-9003', 1, 'owner:test', 0)`);
    // Two active expedited claims: a third expedited item waits (R3-9003 is also held back by
    // rule 4, so rule 2 is asked of it first, as isEligible orders them).
    expect(await claimItem('test', t.secret, { work_item_id: 'R3-9003' })).toMatchObject({ status: 409, json: { code: 'not-eligible', rule: 2 } });
  });

  it('rule 8: an item released awaiting-review-capacity goes only to a worker with a qualifying pair; a matrix without a usable row fails closed', async () => {
    const matrix = {
      families: { glm: ['glm'], deepseek: ['deepseek'], qwen: ['qwen'] },
      agents: {
        'review-pr-glm': { reviews_on: 'zai-coding-plan/glm-5.3', bills: ['zai-coding-plan'], cost: 1 },
        'review-pr-deepseek': { reviews_on: 'opencode-go/deepseek-v4', bills: ['opencode-go'], cost: 1 },
        'review-pr-qwen': { reviews_on: 'opencode-go/qwen3', bills: ['opencode-go'], cost: 2 },
      },
      rows: [{ author: 'default', a: [{ agent: 'review-pr-deepseek' }], b: [{ agent: 'review-pr-qwen' }] }],
    };
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B, { matrix, reviewers: matrix.agents }));
    await syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true }));
    await owner('/v1/ui/board/accept', { sha: sha.D });
    await syncCall('/v1/sync/board', payload(sha.D, sha.B, board.states.D, { force: true, matrix, reviewers: matrix.agents }));
    expect(await rows(`SELECT key FROM baton_settings WHERE key IN ('reviewer_matrix', 'reviewer_catalog') ORDER BY key`)).toEqual([{ key: 'reviewer_catalog' }, { key: 'reviewer_matrix' }]);
    const first = await register('vm-a', { session_name: 'author' });
    const { json: c } = await claimItem('vm-a', first.secret, { work_item_id: 'R3-9001' });
    await endClaim('vm-a', first.secret, c.claim_id, { end_reason: 'released:awaiting-review-capacity' });
    // Billing only zai-coding-plan: neither seat's opencode-go reviewer is billable for it.
    const narrow = await register('vm-b', { billing: { 'zai-coding-plan': 'zai' } });
    expect((await claimItem('vm-b', narrow.secret, { work_item_id: 'R3-9001' })).json).toMatchObject({ code: 'not-eligible', rule: 8 });
    const wide = await register('test');
    expect((await claimItem('test', wide.secret, { work_item_id: 'R3-9001' })).status).toBe(200);
  });

  it('rule 8 with a matrix that has no usable row refuses as rule 8, not a 500', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret, { work_item_id: 'R3-9001' });
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'released:awaiting-review-capacity' });
    const b = await register('vm-b');
    expect(await claimItem('vm-b', b.secret, { work_item_id: 'R3-9001' })).toMatchObject({ status: 409, json: { rule: 8 } });
  });
});

describe('the hold override and legacy claims', () => {
  it('a hold override takes an item out of the candidates and isEligible agrees', async () => {
    const { id, secret } = await register('vm-a');
    await rows(`INSERT INTO item_overrides (work_item_id, hold, hold_reason, set_by, set_at) VALUES ('R3-9001', 1, 'owner', 'owner:test', 0)`);
    const got = await runInDurableObject(stub(), (o: Baton) => {
      const c = o.claims as unknown as { candidates: (w: unknown, now: number, limit: number) => string[]; worker: (id: number) => unknown };
      return c.candidates(c.worker(id), T0, 100);
    });
    expect(got).toEqual(['R3-9002']);
    expect((await claimItem('vm-a', secret, { work_item_id: 'R3-9001' })).json).toMatchObject({ code: 'not-eligible', rule: 3 });
  });

  it('a legacy claim is reaped at its reap_after, never by silence, and is not "another live holder"', async () => {
    await rows(`INSERT INTO credentials (id, hostname, allowed_capabilities) VALUES ('legacy', 'legacy', '[]') ON CONFLICT (id) DO NOTHING`);
    await rows(`INSERT INTO workers (hostname, session_name, secret_hash, credential_id, harness, kind, tier_ceiling, lease_timeout_ms, settings_hash, first_seen_at, last_seen_at)
                VALUES ('legacy', 'R3-9001', '', 'legacy', 'claude-code', 'legacy', 'critical', 0, '', 0, 0)`);
    const lw = (await rows<{ id: number }>(`SELECT id FROM workers WHERE kind = 'legacy'`))[0].id;
    await rows(`INSERT INTO work_item_claims (work_item_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status, reap_after)
                VALUES ('R3-9001', ?, 'legacy:R3-9001', 'abc123', '', 0, 'active', ?)`, lw, T0 + 7 * 24 * H);
    expect(await (await workerCall('/v1/worker/items/R3-9001/holder', { cred: 'vm-b' })).json()).toEqual({ held_by_other: false, fence_pending: false });
    await alarmAt(T0 + 7 * 24 * H - 1);
    expect(await rows(`SELECT status FROM work_item_claims WHERE worker_id = ?`, lw)).toEqual([{ status: 'active' }]);
    await alarmAt(T0 + 7 * 24 * H);
    expect(await rows(`SELECT status, end_reason FROM work_item_claims WHERE worker_id = ?`, lw)).toEqual([{ status: 'reaped', end_reason: 'reaped:legacy' }]);
  });
});

describe('§14: Running, Timeline and Needs you', () => {
  it('Running: the reap deadline, stalled after 2 h without activity, and events', async () => {
    const { secret } = await register('vm-a', { lease_timeout_s: 43_200 });
    const { json: c } = await claimItem('vm-a', secret);
    const run = async () => (await uiState()).running[0];
    expect(await run()).toMatchObject({ id: c.claim_id, alive: true, reap_at: T0 + 43_200_000, stalled: false, events: [expect.objectContaining({ kind: 'claimed' })] });
    await setClock(T0 + 2 * H);
    await beat('vm-a', secret, { lease_timeout_s: 43_200 });
    expect((await run()).stalled).toBe(false); // exactly 2 h is not over 2 h
    await setClock(T0 + 2 * H + 1000);
    expect(await run()).toMatchObject({ stalled: true, reap_at: T0 + 2 * H + 43_200_000 });
  });

  it('Timeline: alive lanes only, with each activity’s detail and transcript link', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret);
    await workerCall('/v1/worker/activities', { secret, body: { activities: [
      { id: 'r1', claim_id: c.claim_id, kind: 'review-round', seq: 1, source: 'skill', started_at: T0 },
      { id: 'rv', claim_id: c.claim_id, parent_id: 'r1', kind: 'reviewer', label: 'review-pr-glm', source: 'hook', started_at: T0 },
      { id: 'pr', claim_id: c.claim_id, kind: 'open-pr', source: 'hook', started_at: T0, ended_at: T0 + 1, outcome: 'succeeded', detail: { pr: 'https://github.com/immediately-run/baton/pull/5' } },
    ] } });
    await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'cc/s.jsonl' }] });
    const lanes = (await uiState()).timeline.lanes;
    expect(lanes).toHaveLength(1);
    const acts = lanes[0].claims[0].activities;
    expect(acts.find((a: any) => a.id === 'rv')).toMatchObject({ parent_id: 'r1', transcript_url: 'https://github.com/immediately-run/claude-sessions/blob/HEAD/cc/s.jsonl' });
    expect(JSON.parse(acts.find((a: any) => a.id === 'pr').detail_json)).toEqual({ pr: 'https://github.com/immediately-run/baton/pull/5' });
    await setClock(T0 + 900_000); // silent past its lease: no longer a lane
    expect((await uiState()).timeline.lanes).toEqual([]);
  });

  it('Needs you: unacknowledged releases and fence-pending claims appear and clear', async () => {
    const a = await register('vm-a');
    const { json: c } = await claimItem('vm-a', a.secret);
    await owner('/v1/ui/messages', { to_worker_id: a.id, kind: 'release', payload: { work_item_id: 'R3-9001', reason: 'requested' } });
    expect((await uiState()).needs_you.unacknowledged_releases).toHaveLength(1);
    const msg = (await beat('vm-a', a.secret)).json.messages[0];
    await workerCall(`/v1/worker/messages/${msg.id}/ack`, { secret: a.secret, method: 'POST' });
    expect((await uiState()).needs_you.unacknowledged_releases).toEqual([]);
    await owner(`/v1/ui/claims/${c.claim_id}/reap`, { confirm: true });
    expect((await uiState()).needs_you.fence_pending).toEqual([expect.objectContaining({ id: c.claim_id })]);
    await beat('vm-a', a.secret, { fenced: { claim_id: c.claim_id, terminated: true } });
    expect((await uiState()).needs_you.fence_pending).toEqual([]);
  });
});
