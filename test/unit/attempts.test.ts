// R3-1217 — attempts, retries and holds (BATON_SPEC §6.10 R-BTN-23, §7.4, §8): G-BTN-31 — only
// the listed ends count as failed attempts; backoff is 1 h then 4 h; the third failed attempt,
// or a non-retryable class, holds the item. The policy is pure (src/attempts.ts) and is tested
// both alone and through the server.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { afterFailure, countsAsFailed, nonRetryableClass, resumeRecord, reviewCapacityRun } from '../../src/attempts';
import {
  beat, claimItem, claimRow, cutover, endClaim, ORIGIN, ownerCall, payload, register, rows, setClock, syncCall, tick, workerCall,
} from '../helpers';

const board = inject('board');
const T0 = Date.parse('2026-10-13T12:00:00Z');
const H = 3_600_000;
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const override = async (item: string) => (await rows<{ hold: number; hold_reason: string | null; retry_after: number | null }>(
  'SELECT hold, hold_reason, retry_after FROM item_overrides WHERE work_item_id = ?', item))[0] ?? null;
const failed = async (item: string) => (await rows<{ n: number }>('SELECT count(*) AS n FROM work_item_claims WHERE work_item_id = ? AND failed_attempt = 1', item))[0].n;

describe('the policy, pure', () => {
  it('counts only a reap for silence, cannot-finish, and lease-lost once per worker', () => {
    for (const r of ['reaped:silent', 'released:cannot-finish:transient', 'released:cannot-finish:capability', 'released:cannot-finish:spec', 'released:lease-lost']) {
      expect([r, countsAsFailed(r)]).toEqual([r, true]);
    }
    expect(countsAsFailed('released:lease-lost', true)).toBe(false);
    for (const r of ['reaped:owner', 'reaped:release-unacknowledged', 'reaped:legacy', 'released:stale-board', 'released:requested',
      'released:owner-cancel', 'released:provider-suspended', 'released:awaiting-review-capacity', 'done', 'handed-off:awaiting-ci', 'remainder:R3-1']) {
      expect([r, countsAsFailed(r)]).toEqual([r, false]);
    }
  });

  it('backs off 1 h then 4 h, and holds at the third; capability and spec are non-retryable', () => {
    expect([afterFailure(0), afterFailure(1), afterFailure(2), afterFailure(3), afterFailure(4)]).toEqual([
      null, { retryAfterMs: H }, { retryAfterMs: 4 * H }, { hold: 'attempts-exhausted' }, { hold: 'attempts-exhausted' }]);
    expect([nonRetryableClass('released:cannot-finish:capability'), nonRetryableClass('released:cannot-finish:spec'), nonRetryableClass('released:cannot-finish:transient')])
      .toEqual(['capability', 'spec', null]);
  });

  it('a review-capacity run is consecutive: another end breaks it', () => {
    const a = 'released:awaiting-review-capacity';
    expect(reviewCapacityRun([a, a, a])).toBe(3);
    expect(reviewCapacityRun([a, 'released:requested', a, a])).toBe(1);
    expect(reviewCapacityRun([])).toBe(0);
  });

  it('a resume record takes branches, PRs, rounds and the last activity from activities only', () => {
    const r = resumeRecord('released:cannot-finish:transient', 5, [
      { kind: 'push', seq: null, label: null, started_at: 1, ended_at: 2, outcome: 'succeeded', detail_json: JSON.stringify({ branch: 'claude/r3-1-x', sha: 'abc' }) },
      { kind: 'open-pr', seq: null, label: null, started_at: 2, ended_at: 3, outcome: 'succeeded', detail_json: JSON.stringify({ pr: 'https://github.com/immediately-run/baton/pull/9' }) },
      { kind: 'review-round', seq: 2, label: null, started_at: 3, ended_at: 4, outcome: 'failed', detail_json: JSON.stringify({ findings: 4, blocking: 1 }) },
      { kind: 'ci-wait', seq: null, label: 'verify', started_at: 4, ended_at: 5, outcome: 'abandoned', detail_json: 'not json' },
    ], [{ repo: 'immediately-run/claude-sessions', path: 'a.jsonl', role: 'session' }]);
    expect(r).toEqual({
      end_reason: 'released:cannot-finish:transient', ended_at: 5,
      branches: ['claude/r3-1-x'], prs: ['https://github.com/immediately-run/baton/pull/9'],
      review_rounds: [{ seq: 2, findings: 4, blocking: 1, should_fix: null, nit: null, outcome: 'failed' }],
      last_activity: { kind: 'ci-wait', label: 'verify', outcome: 'abandoned', started_at: 4, ended_at: 5 },
      transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'a.jsonl', role: 'session' }],
    });
  });
});

describe('G-BTN-31 through the server', () => {
  beforeEach(async () => {
    await setClock(T0);
    await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
    await cutover();
  });

  it('an owner force-reap, an unacknowledged-release reap and a provider-suspended release do not count', async () => {
    const a = await register('vm-a', { lease_timeout_s: 43_200 });
    const one = await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' });
    await owner(`/v1/ui/claims/${one.json.claim_id}/reap`, { confirm: true });
    await beat('vm-a', a.secret, { lease_timeout_s: 43_200, fenced: { claim_id: one.json.claim_id, terminated: true } });
    const two = await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' });
    await owner('/v1/ui/messages', { to_worker_id: a.id, kind: 'release', payload: { work_item_id: 'R3-9001', reason: 'requested' } });
    await beat('vm-a', a.secret, { lease_timeout_s: 43_200 });
    await setClock(T0 + 2 * H);
    await tick();
    expect((await claimRow(two.json.claim_id)).end_reason).toBe('reaped:release-unacknowledged');
    await beat('vm-a', a.secret, { lease_timeout_s: 43_200, fenced: { claim_id: two.json.claim_id, terminated: true } });
    const three = await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' });
    await endClaim('vm-a', a.secret, three.json.claim_id, { end_reason: 'released:provider-suspended' });
    expect(await failed('R3-9001')).toBe(0);
    expect(await override('R3-9001')).toBeNull();
    // Each such end still writes the resume record.
    expect(await rows(`SELECT count(*) AS n FROM work_item_claims WHERE resume_json IS NOT NULL`)).toEqual([{ n: 3 }]);
  });

  it('lease-lost counts once per worker; a second worker’s counts', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    let t = T0;
    const loseLease = async (cred: 'vm-a' | 'vm-b', secret: string) => {
      t += 5 * H; // past any backoff
      await setClock(t);
      await beat(cred, secret);
      const c = await claimItem(cred, secret, { work_item_id: 'R3-9001' });
      expect(c.status).toBe(200);
      await endClaim(cred, secret, c.json.claim_id, { end_reason: 'released:lease-lost' });
    };
    await loseLease('vm-a', a.secret);
    await loseLease('vm-a', a.secret);
    expect(await failed('R3-9001')).toBe(1);
    await loseLease('vm-b', b.secret);
    expect(await failed('R3-9001')).toBe(2);
  });

  it('backoff is 1 h after the first failure and 4 h after the second; the third holds attempts-exhausted', async () => {
    const a = await register('vm-a');
    const fail = async () => {
      const c = await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' });
      expect(c.status).toBe(200);
      await endClaim('vm-a', a.secret, c.json.claim_id, { end_reason: 'released:cannot-finish:transient' });
      return c.json.claim_id as number;
    };
    const first = await fail();
    expect((await override('R3-9001'))!.retry_after).toBe(T0 + H);
    await setClock(T0 + H - 1);
    await beat('vm-a', a.secret);
    expect((await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' })).json).toMatchObject({ code: 'backing-off', rule: 10 });
    await setClock(T0 + H);
    await beat('vm-a', a.secret);
    const second = await fail();
    expect((await override('R3-9001'))!.retry_after).toBe(T0 + 5 * H);
    await setClock(T0 + 5 * H);
    await beat('vm-a', a.secret);
    const third = await fail();
    expect(await override('R3-9001')).toMatchObject({ hold: 1, hold_reason: 'attempts-exhausted' });
    expect(await rows(`SELECT kind, json_extract(detail_json, '$.attempts') AS attempts FROM events WHERE kind IN ('attempts-exhausted', 'held') ORDER BY seq`)).toEqual([
      { kind: 'attempts-exhausted', attempts: JSON.stringify([first, second, third]) }, { kind: 'held', attempts: JSON.stringify([first, second, third]) }]);
    expect((await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' })).json).toMatchObject({ code: 'not-eligible', rule: 3 });
  });

  it('three consecutive awaiting-review-capacity releases hold the item review-capacity; another end breaks the run', async () => {
    // A matrix rule 8 can seat (deepseek and qwen, billed on opencode-go), posted by a snapshot.
    const matrix = {
      families: { glm: ['glm'], deepseek: ['deepseek'], qwen: ['qwen'] },
      agents: {
        'review-pr-deepseek': { reviews_on: 'opencode-go/deepseek-v4', bills: ['opencode-go'], cost: 1 },
        'review-pr-qwen': { reviews_on: 'opencode-go/qwen3', bills: ['opencode-go'], cost: 2 },
      },
      rows: [{ author: 'default', a: [{ agent: 'review-pr-deepseek' }], b: [{ agent: 'review-pr-qwen' }] }],
    };
    await syncCall('/v1/sync/board', payload('e'.repeat(40), board.shas.A, board.states.A, { matrix, reviewers: matrix.agents }));
    const a = await register('vm-a');
    const release = async (item: string, reason: string) => {
      const c = await claimItem('vm-a', a.secret, { work_item_id: item });
      expect([item, reason, c.status]).toEqual([item, reason, 200]);
      await endClaim('vm-a', a.secret, c.json.claim_id, { end_reason: reason });
    };
    // R3-9002: two, then another end, then two — never three in a row.
    for (const r of ['awaiting-review-capacity', 'awaiting-review-capacity', 'requested', 'awaiting-review-capacity', 'awaiting-review-capacity']) {
      await release('R3-9002', `released:${r}`);
    }
    expect(await override('R3-9002')).toBeNull();
    // R3-9001: three in a row hold it.
    for (let i = 0; i < 3; i++) await release('R3-9001', 'released:awaiting-review-capacity');
    expect(await override('R3-9001')).toMatchObject({ hold: 1, hold_reason: 'review-capacity' });
    expect(await failed('R3-9001')).toBe(0); // never a failed attempt
  });

  it('lifting a hold resets the count, clears the backoff, and is the only way back', async () => {
    const a = await register('vm-a');
    for (let i = 0; i < 3; i++) {
      await setClock(T0 + i * 5 * H);
      await beat('vm-a', a.secret);
      const c = await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' });
      await endClaim('vm-a', a.secret, c.json.claim_id, { end_reason: 'released:cannot-finish:transient' });
    }
    expect((await override('R3-9001'))!.hold).toBe(1);
    // Nothing lifts it by itself.
    await setClock(T0 + 30 * 24 * H);
    await tick();
    await beat('vm-a', a.secret);
    expect((await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' })).json.rule).toBe(3);
    expect((await owner('/v1/ui/overrides/R3-9001', { hold: false })).status).toBe(200);
    expect(await override('R3-9001')).toEqual({ hold: 0, hold_reason: null, retry_after: null });
    const c = await claimItem('vm-a', a.secret, { work_item_id: 'R3-9001' });
    expect(c.status).toBe(200);
    // One more failure after the lift is the first again: 1 h, not a hold.
    await endClaim('vm-a', a.secret, c.json.claim_id, { end_reason: 'released:cannot-finish:transient' });
    expect(await override('R3-9001')).toMatchObject({ hold: 0, retry_after: T0 + 30 * 24 * H + H });
  });

  it('the owner can hold and expedite through overrides; each change is an override event', async () => {
    expect((await owner('/v1/ui/overrides/R3-9002', { expedite: true })).status).toBe(200);
    expect((await owner('/v1/ui/overrides/R3-9002', { hold: true })).status).toBe(200);
    expect((await owner('/v1/ui/overrides/R3-9002', { hold: 'yes' })).status).toBe(400);
    expect(await rows(`SELECT kind FROM events WHERE work_item_id = 'R3-9002' ORDER BY seq`)).toEqual([{ kind: 'override' }, { kind: 'override' }, { kind: 'held' }]);
    expect(await rows(`SELECT expedite, hold, hold_reason FROM item_overrides WHERE work_item_id = 'R3-9002'`)).toEqual([{ expedite: 1, hold: 1, hold_reason: 'owner' }]);
    const { secret } = await register('vm-a');
    expect((await workerCall('/v1/worker/next', { secret })).status).toBe(200);
  });
});
