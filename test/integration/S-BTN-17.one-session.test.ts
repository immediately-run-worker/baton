// S-BTN-17 one session, whole ticket (BATON_SPEC §13a, §2e R-BTN-63, §6.12; R3-1232): every line has
// room; the reviews, fixes and checks land in PRs, and no sync runs between the advances. Must
// hold: one claim makes five advances — implement, review, fix, review, merge — moving filed →
// pr-open → reviewed → fixed → reviewed, each accepted as an edge on the holder's word, the
// advances into fix and merge carrying the seats' families as bars; it ends done from merged; no
// barred-tag, no hand-off, no stale-board release; the next sync confirms the end. (The required
// bar those bars meet is an owner setting, R3-1240.) Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { advance, beat, claimItem, claimRow, cutover, endClaim, Git, placed, register, rows, setClock } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const SEATS = ['family:deepseek', 'family:qwen'];
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git().add('T-1');
  expect((await git.post()).status).toBe(200);
  await cutover();
});

describe('S-BTN-17 one session, whole ticket', () => {
  it('five advances on the holder’s word, ended done from merged, confirmed by the next sync', async () => {
    const w = await register('vm-a', { tags: ['family:glm'] });
    const { json: c } = await claimItem('vm-a', w.secret);
    expect(c).toMatchObject({ ticket_id: 'docs:T-1', station: 'filed', legs: ['implement'] });

    const steps: [Record<string, unknown>, string][] = [
      [{ leg: 'implement' }, 'filed'],
      [{ reached: 'pr-open', leg: 'review', evidence: 'https://github.com/immediately-run/docs/pull/7' }, 'pr-open'],
      [{ reached: 'reviewed', leg: 'fix', bars: SEATS }, 'reviewed'],
      [{ reached: 'fixed', leg: 'review' }, 'fixed'],
      [{ reached: 'reviewed', leg: 'merge', bars: SEATS }, 'reviewed'],
    ];
    for (const [body, station] of steps) {
      const res = await advance('vm-a', w.secret, c.claim_id, body);
      expect([body.leg, res.status, res.json.station]).toEqual([body.leg, 200, station]);
    }
    expect(await rows('SELECT seq, leg, from_station, to_station, bars FROM claim_legs WHERE claim_id = ? ORDER BY seq', c.claim_id)).toEqual([
      { seq: 1, leg: 'implement', from_station: 'filed', to_station: 'pr-open', bars: '[]' },
      { seq: 2, leg: 'review', from_station: 'pr-open', to_station: 'reviewed', bars: '[]' },
      { seq: 3, leg: 'fix', from_station: 'reviewed', to_station: 'fixed', bars: JSON.stringify(SEATS) },
      { seq: 4, leg: 'review', from_station: 'fixed', to_station: 'reviewed', bars: '[]' },
      { seq: 5, leg: 'merge', from_station: 'reviewed', to_station: null, bars: JSON.stringify(SEATS) },
    ]);
    expect((await beat('vm-a', w.secret)).json.claim).toMatchObject({ station: 'reviewed', leg: 'merge' });

    // The leg archives the ticket (git first, R-BTN-8); W1 ends done from merged before any sync.
    expect((await endClaim('vm-a', w.secret, c.claim_id, { end_reason: 'done', reached: 'merged', ended_at_sha: 'f'.repeat(40) })).status).toBe(200);
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'completed', end_reason: 'done', confirmed_at: null });
    expect(await rows(`SELECT kind FROM events WHERE claim_id = ? AND kind IN ('released', 'advice-overridden') `, c.claim_id)).toEqual([]);
    // The next sync, observed after the end, shows the ticket closed: the end is confirmed.
    git.close('T-1', 'done');
    expect(await git.post()).toMatchObject({ status: 200, confirmed: 1, stale_released: 0 });
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0);
    // No hand-off document, and the resume record lists the five legs.
    const resume = JSON.parse((await rows<{ resume_json: string }>('SELECT resume_json FROM claims WHERE id = ?', c.claim_id))[0].resume_json);
    expect(resume).toMatchObject({ end_reason: 'done', reached: 'merged' });
    expect(resume.legs.map((l: { leg: string; outcome: string }) => `${l.leg}:${l.outcome}`)).toEqual(['implement:finished', 'review:finished', 'fix:finished', 'review:finished', 'merge:finished']);
  });

  it('the edge and the run limit are the only checks on a leg: off-graph, not-queued and max-runs refuse, changing nothing', async () => {
    const w = await register('vm-a', { tags: ['family:glm'] });
    const { json: c } = await claimItem('vm-a', w.secret);
    // The first advance starts the offered leg (R-BTN-83).
    expect((await advance('vm-a', w.secret, c.claim_id, { leg: 'review' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'not-queued' });
    expect((await advance('vm-a', w.secret, c.claim_id, { leg: 'nope' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'off-graph' });
    await advance('vm-a', w.secret, c.claim_id, { leg: 'implement' });
    // implement reaches pr-open only.
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'reviewed', leg: 'merge' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'off-graph' });
    // fix does not leave pr-open.
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'pr-open', leg: 'fix' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'off-graph' });
    expect(await rows('SELECT station, leg FROM claims WHERE id = ?', c.claim_id)).toEqual([{ station: 'filed', leg: 'implement' }]);
    // fix runs twice at most (max_runs: 2): the third is refused, the loop spent.
    await advance('vm-a', w.secret, c.claim_id, { reached: 'pr-open', leg: 'review' });
    for (let i = 0; i < 2; i++) {
      expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'reviewed', leg: 'fix' })).status).toBe(200);
      expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'fixed', leg: 'review' })).status).toBe(200);
    }
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'reviewed', leg: 'fix' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'max-runs' });
    // The holder's own bars bind it at the advance: barring its own family from merge refuses it.
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'reviewed', leg: 'merge', bars: ['family:glm'] })).json).toMatchObject({ code: 'barred-tag', rule: 8 });
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'reviewed', leg: 'merge' })).status).toBe(200);
    // A leg of several outcomes needs its `reached`; a station the running leg cannot reach is off-graph.
    expect((await endClaim('vm-a', w.secret, c.claim_id, { end_reason: 'suspended:fixed' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'off-graph' });
  });

  it('a leg no sync has posted yet is fine; a hold binds the holder at its next advance', async () => {
    const w = await register('vm-a');
    const { json: c } = await claimItem('vm-a', w.secret);
    await advance('vm-a', w.secret, c.claim_id, { leg: 'implement' });
    await rows(`INSERT INTO ticket_overrides (ticket_id, hold, hold_reason, set_by, set_at) VALUES ('docs:T-1', 1, 'owner', 'owner:test', 0)`);
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'pr-open', leg: 'review' })).json).toMatchObject({ code: 'not-eligible', rule: 3, rule_code: 'held' });
    await rows(`UPDATE ticket_overrides SET hold = 0`);
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'pr-open', leg: 'review' })).status).toBe(200);
    // The sync still shows filed: the holder's position is ahead of git, and that is lag (§2e).
    git.place('T-1', placed('filed', [], [['implement', 'ready']]));
    expect(await git.refresh()).toMatchObject({ status: 200, stale_released: 0 });
    expect(await rows('SELECT status, regressed_since FROM claims WHERE id = ?', c.claim_id)).toEqual([{ status: 'active', regressed_since: null }]);
  });
});
