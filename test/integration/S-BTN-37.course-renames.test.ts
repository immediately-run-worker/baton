// S-BTN-37 a course changes under a claim — the rename half (BATON_SPEC §13a, R-BTN-64, R-BTN-22;
// R3-1232): while W1 runs fix, roadmap-pr merges a course file renaming fix to address
// (`renamed_from: fix`) and adding a station, raising `version` but not `min_worker_version`.
// Must hold: W1's claim carries over — Baton rewrites its leg to address, its next advance into
// review is accepted with its earlier fix runs counted as address's, and a W2 advance still naming
// fix resolves to address; W2, still on the old version, keeps claiming. A later file that drops
// the claim's station shows `station: unknown` on the heartbeat. (The required bar's `except` list,
// the course-changed release by the runner and `baton test-course` are R3-1240's, R3-1245's and
// R3-1248's.) Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import roadmapPr from '../fixtures/courses/roadmap-pr/course.json';
import { advance, beat, claimItem, course, cutover, Git, placed, register, rows, setClock } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const REVIEWED: [string, string][] = [['implement', 'pr-open'], ['review', 'reviewed']];
const { fix, ...others } = roadmapPr.legs;
/** roadmap-pr with fix renamed address, and a station `triaged` that one more leg reaches. */
const RENAMED = {
  ...roadmapPr,
  stations: { ...roadmapPr.stations, triaged: { label: 'Triaged' } },
  legs: { ...others, address: { ...fix, renamed_from: 'fix' }, triage: { from: ['triaged'], to: 'pr-open' }, park: { from: ['pr-open'], to: 'triaged', max_runs: 1 } },
};
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git()
    .add('T-1', { rank: 1 }, placed('reviewed', REVIEWED, [['fix', 'ready']]))
    // T-2 has run fix once already, in git, before W2 claims it.
    .add('T-2', { rank: 2 }, placed('reviewed', [...REVIEWED, ['fix', 'fixed'], ['review', 'reviewed']], [['fix', 'ready']]));
  await git.post();
  await cutover();
});

describe('S-BTN-37 a course changes under a claim (renames)', () => {
  it('a renamed leg carries its claims, its runs and old names over', async () => {
    const w1 = await register('vm-a');
    const w2 = await register('vm-b');
    const c1 = (await claimItem('vm-a', w1.secret, { ticket_id: 'docs:T-1' })).json;
    const c2 = (await claimItem('vm-b', w2.secret, { ticket_id: 'docs:T-2' })).json;
    expect((await advance('vm-a', w1.secret, c1.claim_id, { leg: 'fix' })).status).toBe(200);

    // The course change merges: version 4, workers still needed at 3. The sync's stations name
    // the new leg.
    git.registry = [course(4, 3, { course: RENAMED })];
    git.place('T-1', placed('reviewed', REVIEWED, [['address', 'ready']]));
    git.place('T-2', placed('reviewed', [...REVIEWED, ['address', 'fixed'], ['review', 'reviewed']], [['address', 'ready']]));
    expect(await git.post()).toMatchObject({ status: 200 });
    expect(await rows('SELECT station, leg FROM claims WHERE id = ?', c1.claim_id)).toEqual([{ station: 'reviewed', leg: 'address' }]);
    expect((await beat('vm-a', w1.secret)).json.claim).toMatchObject({ station: 'reviewed', leg: 'address', git: { station: 'reviewed' } });

    // W1 finishes the leg it started as fix and goes on into review.
    expect((await advance('vm-a', w1.secret, c1.claim_id, { reached: 'fixed', leg: 'review' })).json).toMatchObject({ ok: true, station: 'fixed' });
    // W2's runner still says fix: it resolves to address, and the fix run in git counts — once more
    // is the second of address's two.
    expect((await advance('vm-b', w2.secret, c2.claim_id, { leg: 'fix' })).json).toMatchObject({ ok: true, station: 'reviewed' });
    expect(await rows('SELECT leg FROM claim_legs WHERE claim_id = ?', c2.claim_id)).toEqual([{ leg: 'address' }]);
    await advance('vm-b', w2.secret, c2.claim_id, { reached: 'fixed', leg: 'review' });
    expect((await advance('vm-b', w2.secret, c2.claim_id, { reached: 'reviewed', leg: 'address' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'max-runs' });

    // Workers on the old version keep claiming: min_worker_version did not move.
    git.add('T-3', { rank: 3 });
    await git.post();
    const w3 = await register('test');
    expect((await claimItem('test', w3.secret, { ticket_id: 'docs:T-3' })).status).toBe(200);
  });

  it('a file that no longer has the claim’s station: the heartbeat says unknown', async () => {
    const w1 = await register('vm-a');
    const c1 = (await claimItem('vm-a', w1.secret, { ticket_id: 'docs:T-1' })).json;
    // A course whose reviewed station is gone (renamed with no renamed_from: a new station).
    const { reviewed, ...stations } = roadmapPr.stations;
    const legs = Object.fromEntries(Object.entries(roadmapPr.legs).map(([k, l]) => [k, {
      ...l, from: (l.from as string[]).map((s) => (s === 'reviewed' ? 'checked' : s)), to: l.to === 'reviewed' ? 'checked' : l.to,
    }]));
    git.registry = [course(5, 3, { course: { ...roadmapPr, stations: { ...stations, checked: reviewed }, legs } })];
    git.place('T-1', placed('checked', [['implement', 'pr-open'], ['review', 'checked']], [['fix', 'ready']]));
    git.place('T-2', placed('checked', [['implement', 'pr-open'], ['review', 'checked']], [['fix', 'ready']]));
    expect(await git.post()).toMatchObject({ status: 200 });
    expect((await beat('vm-a', w1.secret)).json.claim).toMatchObject({ station: 'reviewed', git: 'unknown' });
    expect((await advance('vm-a', w1.secret, c1.claim_id, { leg: 'fix' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'off-graph' });
  });
});
