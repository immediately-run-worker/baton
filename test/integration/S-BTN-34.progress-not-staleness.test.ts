// S-BTN-34 progress is not staleness (BATON_SPEC §13a, §2e, R-BTN-35; R3-1232): W1 runs fix, pushes
// and advances into review before any sync, then waits on CI under its claim while syncs still
// place the ticket at reviewed; a ticket W2 holds is withdrawn; a third claim's PR is closed so its
// path goes backwards. Must hold: W1's claim stays active (its path only lagged) and its next
// advance succeeds; W2's claim ends released:stale-board with a release message; the third
// holder's heartbeat shows git.regressed with the posted path, the claim stays active with
// regressed_since set, and after 30 minutes the ticket is under Needs you; a later path that
// extends the expected one clears it. Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { advance, beat, claimItem, claimRow, cutover, endClaim, Git, ownerCall, placed, register, rows, setClock } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const REVIEWED: [string, string][] = [['implement', 'pr-open'], ['review', 'reviewed']];
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git()
    .add('T-1', { rank: 1 }, placed('reviewed', REVIEWED, [['fix', 'ready']]))
    .add('T-2', { rank: 2 })
    .add('T-3', { rank: 3 }, placed('reviewed', REVIEWED, [['fix', 'ready']]));
  await git.post();
  await cutover();
});

describe('S-BTN-34 progress is not staleness', () => {
  it('lag keeps the claim; a withdrawal ends it stale; a path backwards flags it regressed', async () => {
    const w1 = await register('vm-a', { lease_timeout_s: 86_400 });
    const w2 = await register('vm-b', { lease_timeout_s: 86_400 });
    const w3 = await register('mac', { lease_timeout_s: 86_400 });
    const c1 = (await claimItem('vm-a', w1.secret, { ticket_id: 'docs:T-1' })).json;
    const c2 = (await claimItem('vm-b', w2.secret, { ticket_id: 'docs:T-2' })).json;
    const c3 = (await claimItem('mac', w3.secret, { ticket_id: 'docs:T-3' })).json;

    // W1: fix, pushed, and into review before any sync; then 20 minutes on CI under the claim.
    await advance('vm-a', w1.secret, c1.claim_id, { leg: 'fix' });
    await advance('vm-a', w1.secret, c1.claim_id, { reached: 'fixed', leg: 'review' });
    // T-2 is withdrawn (superseded); T-3's PR is closed, so git has it back at filed.
    git.close('T-2', 'withdrawn');
    git.place('T-3', placed('filed', [], [['implement', 'ready']]));
    expect(await git.post()).toMatchObject({ status: 200, stale_released: 1 });
    for (let m = 5; m <= 20; m += 5) {
      await setClock(T0 + m * 60_000);
      expect(await git.refresh()).toMatchObject({ status: 200, stale_released: 0 });
    }
    // W1: active, not regressed — the sync still has reviewed, the path it started from.
    expect(await rows('SELECT status, regressed_since FROM claims WHERE id = ?', c1.claim_id)).toEqual([{ status: 'active', regressed_since: null }]);
    expect((await advance('vm-a', w1.secret, c1.claim_id, { reached: 'reviewed', leg: 'merge' })).status).toBe(200);

    // W2: stale-board, told by a release message.
    expect(await claimRow(c2.claim_id)).toMatchObject({ status: 'released', end_reason: 'released:stale-board' });
    expect((await beat('vm-b', w2.secret, { lease_timeout_s: 86_400 })).json.messages).toEqual([
      expect.objectContaining({ kind: 'release', payload: expect.objectContaining({ ticket_id: 'docs:T-2', reason: 'stale-board', why: 'withdrawn' }) })]);

    // W3: still active; regressed since the first post, the posted path in its heartbeat.
    expect(await rows('SELECT status, regressed_since FROM claims WHERE id = ?', c3.claim_id)).toEqual([{ status: 'active', regressed_since: T0 }]);
    expect((await beat('mac', w3.secret, { lease_timeout_s: 86_400 })).json.claim).toMatchObject({ station: 'reviewed',
      git: { station: 'filed', path: [], path_len: 0, regressed: true } });
    const needs = async () => ((await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { regressed: { id: number }[] } }).needs_you.regressed.map((r) => r.id);
    await setClock(T0 + 30 * 60_000 - 1);
    expect(await needs()).toEqual([]);
    await setClock(T0 + 30 * 60_000);
    expect(await needs()).toEqual([c3.claim_id]);
    expect(await rows(`SELECT count(*) AS n FROM events WHERE kind = 'regressed' AND claim_id = ?`, c3.claim_id)).toEqual([{ n: 1 }]);
    // The PR is reopened: git's path extends the claim's expected one again, and the flag clears.
    git.place('T-3', placed('reviewed', REVIEWED, [['fix', 'ready']]));
    await git.refresh();
    expect(await rows('SELECT regressed_since FROM claims WHERE id = ?', c3.claim_id)).toEqual([{ regressed_since: null }]);
    expect(await needs()).toEqual([]);
  });

  it('a suspension made while regressed is confirmed by any later snapshot: git has already overruled the claim', async () => {
    const w3 = await register('mac');
    const c3 = (await claimItem('mac', w3.secret, { ticket_id: 'docs:T-3' })).json;
    await advance('mac', w3.secret, c3.claim_id, { leg: 'fix' });
    git.place('T-3', placed('pr-open', [['implement', 'pr-open']], [['review', 'ready']]));
    await git.post();
    expect((await rows<{ r: number | null }>('SELECT regressed_since AS r FROM claims WHERE id = ?', c3.claim_id))[0].r).toBe(T0);
    // The runner aborts the leg and suspends at its from.
    await endClaim('mac', w3.secret, c3.claim_id, { end_reason: 'suspended:reviewed' });
    expect(await rows('SELECT regressed_since, ended_regressed FROM claims WHERE id = ?', c3.claim_id)).toEqual([{ regressed_since: null, ended_regressed: 1 }]);
    expect(await rows('SELECT abandoned_at FROM claim_legs WHERE claim_id = ?', c3.claim_id)).toEqual([{ abandoned_at: T0 }]);
    expect(await git.refresh()).toMatchObject({ confirmed: 1 });
  });
});
