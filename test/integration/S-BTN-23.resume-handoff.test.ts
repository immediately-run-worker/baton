// S-BTN-23 resume from a hand-off document (BATON_SPEC §13a, R-BTN-24, R-BTN-44, §6.11; R3-1232): W2
// resumes a ticket W1 suspended at reviewed. Must hold: W2's claim response carries the hand-off
// URL and W1's resume record — its branch and PR, the legs it ran, where it rests — so W2 reuses
// W1's branch and PR; the hand-off is a comment on the primary PR, never in the diff, and Baton
// holds only its URL. Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { advance, claimItem, cutover, endClaim, Git, placed, register, setClock, workerCall } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const PR = 'https://github.com/immediately-run/docs/pull/41';
const HANDOFF = `${PR}#issuecomment-9001`;
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git().add('T-1');
  await git.post();
  await cutover();
});

describe('S-BTN-23 resume from a hand-off document', () => {
  it('W2’s claim carries the hand-off URL and W1’s resume record; it starts where git has the ticket', async () => {
    const w1 = await register('vm-a');
    const { json: c } = await claimItem('vm-a', w1.secret);
    await advance('vm-a', w1.secret, c.claim_id, { leg: 'implement' });
    await workerCall('/v1/runner/activities', { secret: w1.secret, body: { activities: [
      { id: 'p1', claim_id: c.claim_id, kind: 'push', source: 'skill', started_at: T0, ended_at: T0, outcome: 'succeeded', detail: { branch: 'claude/t-1-fixture' } },
      { id: 'o1', claim_id: c.claim_id, kind: 'open-pr', source: 'skill', started_at: T0, ended_at: T0, outcome: 'succeeded', detail: { pr: PR } },
    ] } });
    await advance('vm-a', w1.secret, c.claim_id, { reached: 'pr-open', leg: 'review' });
    // The round ends; W1's context is spent: it writes the hand-off on the PR and suspends.
    expect((await endClaim('vm-a', w1.secret, c.claim_id, { end_reason: 'suspended:reviewed', reached: 'reviewed', detail: 'context-spent', ended_at_sha: HANDOFF })).status).toBe(200);
    git.place('T-1', placed('reviewed', [['implement', 'pr-open'], ['review', 'reviewed']], [['fix', 'ready'], ['merge', 'waiting', 'findings']], { handoff_url: HANDOFF }));
    expect(await git.refresh()).toMatchObject({ confirmed: 1 });

    const w2 = await register('vm-b');
    const { json: r } = await claimItem('vm-b', w2.secret);
    expect(r).toMatchObject({ ticket_id: 'docs:T-1', station: 'reviewed', legs: ['fix'], handoff_url: HANDOFF,
      next: [{ leg: 'fix', state: 'ready' }, { leg: 'merge', state: 'waiting', waiting_on: 'findings' }] });
    expect(r.previous_attempts).toEqual([{
      claim_id: c.claim_id, status: 'completed', end_reason: 'suspended:reviewed', detail: 'context-spent', ended_at: T0,
      legs: [{ leg: 'implement', from: 'filed', reached: 'pr-open', outcome: 'finished' }, { leg: 'review', from: 'pr-open', reached: 'reviewed', outcome: 'finished' }],
      resume: expect.objectContaining({ end_reason: 'suspended:reviewed', reached: 'reviewed', detail: 'context-spent', branches: ['claude/t-1-fixture'], prs: [PR] }),
    }]);
    // W2 starts the queued leg from git's position, never from before W1's last push.
    expect((await advance('vm-b', w2.secret, r.claim_id, { leg: 'fix' })).json).toMatchObject({ ok: true, station: 'reviewed' });
  });
});
