// S-BTN-36 suspension confirmed from a PR (BATON_SPEC §13a, R-BTN-62), the observation half
// R3-1231 part 3 delivers: a reading is judged by the number Baton handed out before the sync read
// anything. Must hold: an older reading arriving after a newer one is refused stale-observation
// and changes nothing; an end is confirmed, and a claim made stale, only by a reading numbered
// above the counter's value when that end or claim happened. The station half (R3-1232): a
// suspension is confirmed by the path the first snapshot observed after it places the ticket on,
// never by ancestry, and the next claimant starts at git's station.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { advance, claimItem, claimRow, cutover, endClaim, Git, observe, payload, placed, register, rows, setClock, syncCall, tick } from '../helpers';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const MIN = 60_000;
const head = async () => ((await (await syncCall('/v1/sync/head')).json()) as { sha: string | null }).sha;
/** Board A again under a new sha over the head, R3-9002 marked done, carrying number `n`. */
const doneBoard = (at: string, parent: string, n: number, extra: Record<string, unknown> = {}) => {
  const items = (structuredClone(board.states.A.state.items) as Record<string, unknown>[]).map((i: Record<string, unknown>) => (i.id === 'R3-9002' ? { ...i, status: 'done', node: 'done' } : i));
  return { ...payload(at, parent, { ...board.states.A, state: { items }, ready: items.filter((i: Record<string, unknown>) => String(i.node).startsWith('ready-')).map((i: Record<string, unknown>) => String(i.id)) }, extra), observation: n };
};

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-36 (observation half)', () => {
  it('an older reading arriving after a newer one is refused stale-observation and changes nothing', async () => {
    const older = (await observe()).json.observation; // a run that stalls past ten minutes
    await setClock(T0 + 11 * MIN);
    const newer = (await observe()).json.observation;
    expect((await syncCall('/v1/sync/board', { ...payload(sha.B, sha.A, board.states.B), observation: newer })).status).toBe(200);
    const before = await rows('SELECT id, row_hash FROM tickets ORDER BY id');
    const late = await syncCall('/v1/sync/board', { ...payload(sha.C, sha.B, board.states.C), observation: older });
    expect([late.status, ((await late.json()) as { code: string }).code]).toEqual([409, 'stale-observation']);
    expect(await head()).toBe(sha.B);
    expect(await rows('SELECT id, row_hash FROM tickets ORDER BY id')).toEqual(before);
  });

  it('an end is confirmed only by a reading numbered after it', async () => {
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9001' });
    const n = (await observe()).json.observation; // the sync's run starts reading…
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.A }); // …and the worker ends meanwhile
    const confirm = [{ claim_id: c.claim_id, sha: sha.A }];
    expect(await (await syncCall('/v1/sync/board', { ...payload(sha.A, sha.A, board.states.A, { confirmations: confirm }), observation: n })).json()).toMatchObject({ ok: true, confirmed: 0 });
    expect((await claimRow(c.claim_id)).confirmed_at).toBeNull();
    // The next run's number is above the end's: it may judge it.
    expect(await (await syncCall('/v1/sync/board', payload(sha.A, sha.A, board.states.A, { confirmations: confirm }))).json()).toMatchObject({ ok: true, confirmed: 1 });
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0);
  });

  it('a regression is judged only by a reading numbered after the claim’s latest advance (R3-1244: found by the model-based tests)', async () => {
    const git = new Git().add('T-1', {}, placed('pr-open', [['implement', 'pr-open']], [['review', 'ready']]));
    git.head = await head(); // over the fixture board beforeEach posted
    expect(await git.post()).toMatchObject({ status: 200 });
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:T-1' });
    const n = (await observe()).json.observation; // the sync starts reading…
    expect((await advance('vm-a', secret, c.claim_id, { leg: 'review' })).status).toBe(200); // …the holder advances…
    git.place('T-1', placed('filed', [], [['implement', 'ready']])); // …and git has gone back
    expect(await git.post({ observation: n })).toMatchObject({ status: 200 });
    // the reading began before the advance: it cannot judge the claim
    expect((await rows<{ regressed_since: number | null }>('SELECT regressed_since FROM claims WHERE id = ?', c.claim_id))[0].regressed_since).toBeNull();
    // a reading numbered after it can
    await git.refresh();
    expect((await rows<{ regressed_since: number | null }>('SELECT regressed_since FROM claims WHERE id = ?', c.claim_id))[0].regressed_since).not.toBeNull();
  });

  it('a claim is made stale only by a reading numbered after it', async () => {
    const { secret } = await register('vm-a');
    const n = (await observe()).json.observation; // the sync reads git before the claim…
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9002' });
    expect(await (await syncCall('/v1/sync/board', doneBoard('e'.repeat(40), sha.A, n))).json()).toMatchObject({ ok: true, stale_released: 0 });
    expect((await claimRow(c.claim_id)).status).toBe('active');
    const m = (await observe()).json.observation;
    expect(await (await syncCall('/v1/sync/board', doneBoard('f'.repeat(40), 'e'.repeat(40), m))).json()).toMatchObject({ ok: true, stale_released: 1 });
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'released', end_reason: 'released:stale-board' });
    expect(await rows('SELECT claim_observation, end_observation FROM claims WHERE id = ?', c.claim_id)).toEqual([{ claim_observation: n, end_observation: m }]);
  });

  it('a refresh at the head judges a claim the post that moved the head could not (round 1, 1-B-1)', async () => {
    const { secret } = await register('vm-a');
    const n = (await observe()).json.observation;
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9002' });
    await syncCall('/v1/sync/board', doneBoard('e'.repeat(40), sha.A, n));
    expect((await claimRow(c.claim_id)).status).toBe('active');
    // main does not move; the next run posts a refresh of the same head under a later number.
    const m = (await observe()).json.observation;
    expect(await (await syncCall('/v1/sync/board', doneBoard('e'.repeat(40), 'e'.repeat(40), m))).json()).toMatchObject({ ok: true, unchanged: true, stale_released: 1 });
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'released', end_reason: 'released:stale-board' });
  });

  it('a held force post judges claims too, so staleness does not stall for the hold (round 2, 2-A-0)', async () => {
    const { secret } = await register('vm-a');
    const n = (await observe()).json.observation;
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9002' });
    await syncCall('/v1/sync/board', doneBoard('e'.repeat(40), sha.A, n));
    expect((await claimRow(c.claim_id)).status).toBe('active');
    // main is rewritten: every run now posts a force, held for the owner.
    const m = (await observe()).json.observation;
    const held = await syncCall('/v1/sync/board', { ...payload(sha.D, sha.A, board.states.D, { force: true }), observation: m });
    expect(((await held.json()) as { code: string }).code).toBe('snapshot-rejected');
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'released', end_reason: 'released:stale-board' });
  });

});

describe('S-BTN-36 (station half, R3-1232)', () => {
  it('a suspension at fixed is confirmed by the first snapshot observed after it placing the ticket there, never by ancestry; the next claimant starts at git’s station', async () => {
    const reviewed: [string, string][] = [['implement', 'pr-open'], ['review', 'reviewed']];
    const git = new Git();
    git.head = sha.A; // docs' interim head; from here its sync posts the normative board
    git.add('T-1', {}, placed('reviewed', reviewed, [['fix', 'ready']]));
    await git.post();
    const w1 = await register('vm-a', { lease_timeout_s: 86_400 });
    const { json: c } = await claimItem('vm-a', w1.secret, { ticket_id: 'docs:T-1' });
    await advance('vm-a', w1.secret, c.claim_id, { leg: 'fix' });
    // The fix is pushed to a code repository's branch: docs' main does not move. W1 suspends.
    const older = (await observe()).json.observation; // a run that stalls past ten minutes
    await endClaim('vm-a', w1.secret, c.claim_id, { end_reason: 'suspended:fixed', reached: 'fixed', ended_at_sha: 'a'.repeat(40) });
    await setClock(T0 + 11 * MIN);
    // The newer run: a refresh of docs' unchanged head, its station read from the PR.
    git.place('T-1', placed('fixed', [...reviewed, ['fix', 'fixed']], [['review', 'ready']]));
    expect(await git.refresh()).toMatchObject({ status: 200, unchanged: true, confirmed: 1 });
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0 + 11 * MIN);
    // The stalled run arrives after it, still at reviewed: refused whole, changing nothing.
    git.place('T-1', placed('reviewed', reviewed, [['fix', 'ready']]));
    const late = await syncCall('/v1/sync/board', { ...git.body(git.head!, git.head), observation: older });
    expect([late.status, ((await late.json()) as { code: string }).code]).toEqual([409, 'stale-observation']);
    expect(await rows(`SELECT station FROM ticket_stations WHERE ticket_id = 'docs:T-1'`)).toEqual([{ station: 'fixed' }]);

    // W2 claims and is reaped mid-review; W3 claims at git's station, with both attempts.
    const w2 = await register('vm-b');
    const { json: c2 } = await claimItem('vm-b', w2.secret, { ticket_id: 'docs:T-1' });
    expect(c2).toMatchObject({ station: 'fixed', legs: ['review'] });
    await advance('vm-b', w2.secret, c2.claim_id, { leg: 'review' });
    await setClock(T0 + 11 * MIN + 900_000);
    await tick();
    expect(await claimRow(c2.claim_id)).toMatchObject({ status: 'reaped', end_reason: 'reaped:silent' });
    git.place('T-1', placed('fixed', [...reviewed, ['fix', 'fixed']], [['review', 'ready']]));
    await git.refresh();
    await setClock(T0 + 11 * MIN + 900_000 + 3_600_000); // past the reap's backoff
    await git.refresh();
    const w3 = await register('test');
    const { json: c3 } = await claimItem('test', w3.secret, { ticket_id: 'docs:T-1' });
    expect(c3).toMatchObject({ station: 'fixed', legs: ['review'] });
    expect(await rows(`SELECT station FROM ticket_stations WHERE ticket_id = 'docs:T-1'`)).toEqual([{ station: c3.station }]);
    expect(c3.previous_attempts.map((p: { claim_id: number; legs: { leg: string; outcome: string }[] }) => [p.claim_id, p.legs.map((l) => `${l.leg}:${l.outcome}`)]))
      .toEqual([[c2.claim_id, ['review:abandoned']], [c.claim_id, ['fix:finished']]]);
  });
});
