// S-BTN-10 no reviewer capacity (BATON_SPEC §13a, R-BTN-40, R-BTN-71; R3-1232): every qualifying seat
// is barred, so the sync posts `review` leaving pr-open as `waiting` on `review-seats`. Must hold:
// the holder at pr-open finds no ready leg, ends `suspended:pr-open`, and nothing is released —
// it is a completed end, never a failed attempt; the next sync confirms it; the ticket is not
// offered while its leg waits, and is recommended again, to anyone, once the sync shows it ready.
// (The owner bar that empties the seats, its lift dispatching a sync, is R3-1240's; listing the
// ticket under Needs you after 72 h not ready is R3-1251's.) Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { advance, beat, claimItem, claimRow, cutover, endClaim, Git, placed, recommended, register, rows, setClock } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git().add('T-1');
  await git.post();
  await cutover();
});

describe('S-BTN-10 no reviewer capacity', () => {
  it('suspends at pr-open with no ready leg; confirmed; offered again once review is ready', async () => {
    const w1 = await register('vm-a');
    const w2 = await register('vm-b');
    const { json: c } = await claimItem('vm-a', w1.secret);
    await advance('vm-a', w1.secret, c.claim_id, { leg: 'implement' });
    // implement's evidence is pushed; the sync places the ticket at pr-open, review waiting.
    git.place('T-1', placed('pr-open', [['implement', 'pr-open']], [['review', 'waiting', 'review-seats']]));
    await git.post();
    expect((await beat('vm-a', w1.secret)).json.claim.git).toEqual({ station: 'pr-open', path: [{ leg: 'implement', reached: 'pr-open' }], path_len: 1, regressed: false,
      next: [{ leg: 'review', state: 'waiting', waiting_on: 'review-seats' }] });
    // No ready leg: the holder suspends where it reached, with its hand-off (R-BTN-44).
    expect((await endClaim('vm-a', w1.secret, c.claim_id, { end_reason: 'suspended:pr-open', detail: 'awaiting-review-seats' })).status).toBe(200);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'completed', end_reason: 'suspended:pr-open', confirmed_at: null });
    expect(await rows('SELECT failed_attempt FROM claims WHERE id = ?', c.claim_id)).toEqual([{ failed_attempt: 0 }]);
    expect(await rows(`SELECT to_station, finished_at FROM claim_legs WHERE claim_id = ?`, c.claim_id)).toEqual([{ to_station: 'pr-open', finished_at: T0 }]);
    // The next sync, observed after the end, shows the path the claim expects: confirmed.
    expect(await git.refresh()).toMatchObject({ status: 200, confirmed: 1 });
    // Waiting, it is offered to nobody, and a claim by name is refused on readiness.
    expect(await recommended(w2.id)).toEqual([]);
    expect((await claimItem('vm-b', w2.secret, { ticket_id: 'docs:T-1' })).json).toMatchObject({ code: 'not-eligible', rule: 1, rule_code: 'not-ready' });
    // The seats free up: the sync posts review ready, and the ticket is recommended again — the
    // same worker included — at pr-open, review queued, with no owner action.
    git.place('T-1', placed('pr-open', [['implement', 'pr-open']], [['review', 'ready']]));
    await git.refresh();
    expect(await recommended(w2.id)).toEqual(['docs:T-1']);
    expect(await recommended(w1.id)).toEqual(['docs:T-1']);
    const again = await claimItem('vm-b', w2.secret);
    expect(again.json).toMatchObject({ ticket_id: 'docs:T-1', station: 'pr-open', legs: ['review'] });
    expect(again.json.previous_attempts[0]).toMatchObject({ claim_id: c.claim_id, end_reason: 'suspended:pr-open', detail: 'awaiting-review-seats',
      legs: [{ leg: 'implement', from: 'filed', reached: 'pr-open', outcome: 'finished' }] });
  });
});
