// S-BTN-28 a course with no reviews — the stations-and-legs runs (BATON_SPEC §13a; R3-1232, round 3,
// 3-A-2): the toy course `chore` — open → done-once → checked, with `redo` a self-loop on done-once
// (max_runs 2), no hooks, `verify` barred by a tag — runs S-BTN-17's whole ticket, S-BTN-24's gate
// case and S-BTN-34's regression in its own terms, in core's default order, with no Baton change.
// A suspension after giving up a redo is confirmed by git's unchanged path. (The rest of S-BTN-28 —
// its `retry` setting and the boundary test — is R3-1240's and R3-1237's.) Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import chore from '../fixtures/courses/chore/course.json';
import { advance, claimItem, claimRow, course, cutover, endClaim, Git, placed, recommended, register, rows, setClock } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const CHORE = [{ repository: 'docs', course: 'roadmap-pr', version: 3 }, { repository: 'docs', course: 'chore', version: 1 }];
const DONE_ONCE: [string, string][] = [['do', 'done-once']];
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git();
  git.registry = [course(), course(1, 1, { id: 'chore', skill: 'chore', course: chore, step_kinds: ['other'] })];
  git.add('C-1', { course_id: 'chore', rank: 1 }, placed('open', [], [['do', 'ready']]));
  git.add('C-2', { course_id: 'chore', rank: 2 }, placed('done-once', DONE_ONCE, [['verify', 'ready'], ['redo', 'ready']], { bars: { verify: ['family:glm'] } }));
  await git.post();
  await cutover();
});

describe('S-BTN-28 the chore course (stations and legs)', () => {
  it('one claim runs the whole ticket: do, redo twice, verify; a third redo is the loop spent; done from checked, confirmed', async () => {
    const w = await register('vm-a', { courses: CHORE });
    const { json: c } = await claimItem('vm-a', w.secret, { ticket_id: 'docs:C-1' });
    expect(c).toMatchObject({ station: 'open', legs: ['do'] });
    for (const body of [{ leg: 'do' }, { reached: 'done-once', leg: 'redo' }, { reached: 'done-once', leg: 'redo' }]) {
      expect((await advance('vm-a', w.secret, c.claim_id, body)).status).toBe(200);
    }
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'done-once', leg: 'redo' })).json).toMatchObject({ code: 'not-eligible', rule_code: 'max-runs' });
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'done-once', leg: 'verify' })).json).toMatchObject({ ok: true, station: 'done-once' });
    await endClaim('vm-a', w.secret, c.claim_id, { end_reason: 'done', reached: 'checked' });
    git.place('C-1', placed('checked', [...DONE_ONCE, ['redo', 'done-once'], ['redo', 'done-once'], ['verify', 'checked']], []));
    expect(await git.post()).toMatchObject({ confirmed: 1 });
  });

  it('S-BTN-24’s gate case: verify barred by a tag — a worker carrying it is neither offered nor given C-2; core’s default order puts resume before start', async () => {
    const glm = await register('vm-a', { courses: CHORE, tags: ['family:glm'] });
    const qwen = await register('vm-b', { courses: CHORE, tags: ['family:qwen'] });
    // Resume before start: C-2 (one leg to an end) before C-1 (two).
    expect(await recommended(qwen.id)).toEqual(['docs:C-2', 'docs:C-1']);
    expect(await recommended(glm.id)).toEqual(['docs:C-1']);
    expect(await claimItem('vm-a', glm.secret, { ticket_id: 'docs:C-2' })).toMatchObject({ status: 409, json: { code: 'barred-tag', rule: 8 } });
    expect((await claimItem('vm-b', qwen.secret)).json).toMatchObject({ ticket_id: 'docs:C-2', station: 'done-once', legs: ['verify'] });
  });

  it('a self-loop given up: the holder suspends at done-once and git’s unchanged path confirms it (3-A-1)', async () => {
    const w = await register('vm-a', { courses: CHORE });
    git.place('C-2', placed('done-once', DONE_ONCE, [['redo', 'ready'], ['verify', 'waiting', 'ci']], { next_leg: 'redo' }));
    await git.refresh();
    const { json: c } = await claimItem('vm-a', w.secret, { ticket_id: 'docs:C-2' });
    expect(c).toMatchObject({ station: 'done-once', legs: ['redo'] });
    await advance('vm-a', w.secret, c.claim_id, { leg: 'redo' });
    expect((await endClaim('vm-a', w.secret, c.claim_id, { end_reason: 'suspended:done-once' })).status).toBe(200);
    expect(await rows('SELECT to_station, finished_at, abandoned_at FROM claim_legs WHERE claim_id = ?', c.claim_id)).toEqual([{ to_station: null, finished_at: null, abandoned_at: T0 }]);
    expect(await git.refresh()).toMatchObject({ confirmed: 1 });
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0);
  });

  it('an advance past a given-up self-loop, then a suspension: confirmed whether or not git shows the loop (3-A-1, adjudication)', async () => {
    // At done-once, redo queued: redo given up (nothing pushed), verify started, then suspended.
    const w2 = await register('vm-b', { courses: CHORE, tags: ['family:qwen'] });
    git.place('C-2', placed('done-once', DONE_ONCE, [['redo', 'ready'], ['verify', 'ready']], { next_leg: 'redo' }));
    await git.refresh();
    const { json: d } = await claimItem('vm-b', w2.secret, { ticket_id: 'docs:C-2' });
    await advance('vm-b', w2.secret, d.claim_id, { leg: 'redo' });
    await advance('vm-b', w2.secret, d.claim_id, { reached: 'done-once', leg: 'verify' });
    await endClaim('vm-b', w2.secret, d.claim_id, { end_reason: 'suspended:done-once' });
    expect(await git.refresh()).toMatchObject({ confirmed: 1 }); // git shows no redo
    expect((await claimRow(d.claim_id)).confirmed_at).toBe(T0);
  });

  it('S-BTN-34 in chore’s terms: a path that goes backwards flags the claim regressed, never stale', async () => {
    const other = await register('vm-b', { courses: CHORE });
    const { json: d } = await claimItem('vm-b', other.secret, { ticket_id: 'docs:C-1' });
    await advance('vm-b', other.secret, d.claim_id, { leg: 'do' });
    git.place('C-1', placed('done-once', DONE_ONCE, [['verify', 'ready']]));
    await git.refresh();
    git.place('C-1', placed('open', [], [['do', 'ready']])); // the evidence of do was removed
    expect(await git.refresh()).toMatchObject({ stale_released: 0 });
    expect(await rows('SELECT status, regressed_since FROM claims WHERE id = ?', d.claim_id)).toEqual([{ status: 'active', regressed_since: T0 }]);
  });
});
