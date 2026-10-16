// S-BTN-5 retried item with backoff (BATON_SPEC §13a, §6.10, §6.11), the server half: an item's
// claimant releases cannot-finish:transient twice. Must hold: retry_after 1 h then 4 h; the
// third claim gets previous_attempts with both resume records, which carry the branch and PR
// it reuses (G-BTN-33: built from the claims' activities). The client half — reusing the
// branch and PR — is R3-1219's.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { claimItem, cutover, endClaim, hbBody, payload, refresh, register, rows, setClock, syncCall, workerCall } from '../helpers';

const board = inject('board');
const T0 = Date.parse('2026-10-13T12:00:00Z');
const H = 3_600_000;
const PR = 'https://github.com/immediately-run/docs/pull/42'; // the ticket's home repository (R-BTN-92's link rule)

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-5 retried item (server)', () => {
  it('backs off 1 h then 4 h; the third claimant reads both attempts, newest first, with the branch and PR', async () => {
    const workers = [await register('vm-a'), await register('vm-b'), await register('test')];
    const creds = ['vm-a', 'vm-b', 'test'] as const;
    const attempt = async (i: number, at: number) => {
      await setClock(at);
      await workerCall('/v1/runner/heartbeat', { cred: creds[i], secret: workers[i].secret, body: hbBody(creds[i]) });
      const c = await claimItem(creds[i], workers[i].secret, { ticket_id: 'docs:R3-9001' });
      expect([i, c.status]).toEqual([i, 200]);
      return c.json;
    };
    const work = async (i: number, claimId: number, at: number, round: number) => {
      await workerCall('/v1/runner/activities', { cred: creds[i], secret: workers[i].secret, body: { activities: [
        { id: `push-${i}`, claim_id: claimId, kind: 'push', source: 'hook', started_at: at, ended_at: at + 1, outcome: 'succeeded', detail: { branch: 'claude/r3-9001-fixture', sha: 'abc' } },
        { id: `pr-${i}`, claim_id: claimId, kind: 'open-pr', source: 'hook', started_at: at + 2, ended_at: at + 3, outcome: 'succeeded', detail: { pr: PR } },
        { id: `round-${i}`, claim_id: claimId, kind: 'review-round', seq: round, source: 'skill', started_at: at + 4, detail: { findings: 3, blocking: 1 } },
      ] } });
    };

    const first = await attempt(0, T0);
    await work(0, first.claim_id, T0, 1);
    await endClaim('vm-a', workers[0].secret, first.claim_id, { end_reason: 'released:cannot-finish:transient' });
    expect(await rows(`SELECT retry_after FROM ticket_overrides WHERE ticket_id = 'docs:R3-9001'`)).toEqual([{ retry_after: T0 + H }]);

    // §6.7: claimable again only after a sync observed after the end.
    await refresh();
    const second = await attempt(1, T0 + H);
    expect(second.previous_attempts.map((p: { claim_id: number }) => p.claim_id)).toEqual([first.claim_id]);
    await work(1, second.claim_id, T0 + H, 2);
    await endClaim('vm-b', workers[1].secret, second.claim_id, { end_reason: 'released:cannot-finish:transient' });
    expect(await rows(`SELECT retry_after FROM ticket_overrides WHERE ticket_id = 'docs:R3-9001'`)).toEqual([{ retry_after: T0 + 5 * H }]);

    await refresh();
    // Still backing off one millisecond before; claimable at 4 h.
    await setClock(T0 + 5 * H - 1);
    expect((await claimItem('test', workers[2].secret, { ticket_id: 'docs:R3-9001' })).json).toMatchObject({ code: 'backing-off', rule: 10 });
    const third = await attempt(2, T0 + 5 * H);
    expect(third.previous_attempts).toEqual([second.claim_id, first.claim_id].map((id, k) => ({
      claim_id: id, status: 'released', end_reason: 'released:cannot-finish:transient', detail: null, ended_at: [T0 + H, T0][k], legs: [],
      resume: {
        end_reason: 'released:cannot-finish:transient', ended_at: [T0 + H, T0][k],
        branches: ['claude/r3-9001-fixture'], prs: [PR],
        review_rounds: [{ seq: [2, 1][k], findings: 3, blocking: 1, should_fix: null, nit: null, outcome: 'abandoned' }],
        last_activity: { kind: 'review-round', label: null, outcome: 'abandoned', started_at: [T0 + H, T0][k] + 4, ended_at: [T0 + H, T0][k] },
        transcripts: [],
        detail: null, reached: 'filed', legs: [],
      },
    })));
  });
});
