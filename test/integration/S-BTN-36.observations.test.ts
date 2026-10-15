// S-BTN-36 suspension confirmed from a PR (BATON_SPEC §13a, R-BTN-62), the observation half
// R3-1231 part 3 delivers: a reading is judged by the number Baton handed out before the sync read
// anything. Must hold: an older reading arriving after a newer one is refused stale-observation
// and changes nothing; an end is confirmed, and a claim made stale, only by a reading numbered
// above the counter's value when that end or claim happened. The station half — a suspension
// confirmed by the station a snapshot places the ticket at — is part 4's (the §7.1 tickets post).
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { claimItem, claimRow, cutover, endClaim, observe, payload, register, rows, setClock, syncCall } from '../helpers';

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
