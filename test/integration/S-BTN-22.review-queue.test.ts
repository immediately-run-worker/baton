// S-BTN-22 review queue bound (BATON_SPEC §13a, R-BTN-41, R-BTN-45, §7.2's default order; R3-1232):
// eight tickets wait for review, none with room. Core's half: with no hook (or a failing one) the
// default order applies — expedite, then resume before start (`to_end`), rank, age, id — nothing is
// flagged, and a worker that claims against the order is accepted and records the override.
// (`roadmap-pr`'s hook sorting `implement` legs last, flagged `wip-bound`, is R3-1235's on R3-1236's
// hooks.) Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { claimItem, cutover, Git, placed, register, rows, setClock, workerCall } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git();
  // Eight tickets wait for review (not ready: no seat has room); three are ready to start; one
  // is reviewed with merge ready; one fixed with review ready.
  for (let i = 1; i <= 8; i++) git.add(`R-${i}`, { rank: i }, placed('pr-open', [['implement', 'pr-open']], [['review', 'waiting', 'review-seats']]));
  for (let i = 1; i <= 3; i++) git.add(`F-${i}`, { rank: 20 + i });
  git.add('M-1', { rank: 40 }, placed('reviewed', [['implement', 'pr-open'], ['review', 'reviewed']], [['merge', 'ready']]));
  git.add('X-1', { rank: 30 }, placed('fixed', [['implement', 'pr-open'], ['review', 'reviewed'], ['fix', 'fixed']], [['review', 'ready']]));
  await git.post();
  await cutover();
});

describe('S-BTN-22 review queue bound', () => {
  it('core’s default order, nothing flagged; a claim against it is accepted and recorded', async () => {
    const w = await register('vm-a');
    const res = await workerCall('/v1/runner/recommendations?limit=50', { secret: w.secret });
    const recs = ((await res.json()) as { recommendations: { ticket_id: string; station: string; legs: string[]; flags: string[]; score: unknown; advice: unknown }[] }).recommendations;
    // Resume before start: one leg to an end (M-1 at reviewed), then two (X-1 at fixed), then the
    // filed tickets by rank; the waiting reviews are not offered at all.
    expect(recs.map((r) => [r.ticket_id, r.station, r.legs])).toEqual([
      ['docs:M-1', 'reviewed', ['merge']], ['docs:X-1', 'fixed', ['review']],
      ['docs:F-1', 'filed', ['implement']], ['docs:F-2', 'filed', ['implement']], ['docs:F-3', 'filed', ['implement']]]);
    expect(recs.every((r) => r.flags.length === 0 && r.score === null && r.advice === null)).toBe(true);
    // ?limit= applies after the merge.
    const two = (await (await workerCall('/v1/runner/recommendations?limit=2', { secret: w.secret })).json()) as { recommendations: unknown[] };
    expect(two.recommendations).toHaveLength(2);
    expect((await workerCall('/v1/runner/recommendations?limit=0', { secret: w.secret })).status).toBe(400);
    // A worker that starts a new ticket anyway is accepted, the order it went against recorded.
    const c = await claimItem('vm-a', w.secret, { ticket_id: 'docs:F-3' });
    expect(c.status).toBe(200);
    expect(await rows(`SELECT json_extract(detail_json, '$.overridden[0].place') AS place FROM events WHERE kind = 'advice-overridden' AND claim_id = ?`, c.json.claim_id))
      .toEqual([{ place: 5 }]);
  });

  it('age breaks a tie of station and rank: the leg ready longest first, then the id', async () => {
    git.add('A-2', { rank: 50 });
    git.add('A-1', { rank: 50 });
    await git.post();
    await setClock(T0 + 60_000);
    git.add('A-0', { rank: 50 });
    await git.post();
    const w = await register('vm-a');
    const recs = ((await (await workerCall('/v1/runner/recommendations?limit=50', { secret: w.secret })).json()) as { recommendations: { ticket_id: string }[] }).recommendations;
    expect(recs.map((r) => r.ticket_id).slice(-3)).toEqual(['docs:A-1', 'docs:A-2', 'docs:A-0']);
  });
});
