// S-BTN-6 poisoned item (BATON_SPEC §13a, §6.10): three claimants fail — reaped for silence,
// lease-lost, cannot-finish:transient. Must hold: held attempts-exhausted (the mirror's note and
// the owner-inbox report are R3-1218's and the witness's); lifting the hold resets the count.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { beat, claimItem, cutover, endClaim, ORIGIN, ownerCall, payload, register, rows, setClock, syncCall, tick } from '../helpers';

const board = inject('board');
const T0 = Date.parse('2026-10-13T12:00:00Z');
const H = 3_600_000;
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-6 poisoned item', () => {
  it('three different failures hold it attempts-exhausted; Needs you lists it with its attempts; a lift resets the count', async () => {
    // 1. Reaped for silence.
    const a = await register('vm-a');
    const c1 = (await claimItem('vm-a', a.secret, { ticket_id: 'docs:R3-9001' })).json;
    await setClock(T0 + 900_000);
    await tick();
    // 2. lease-lost, after the 1 h backoff.
    await setClock(T0 + 900_000 + H);
    const b = await register('vm-b');
    const c2 = (await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })).json;
    await endClaim('vm-b', b.secret, c2.claim_id, { end_reason: 'released:lease-lost' });
    // 3. cannot-finish:transient, after the 4 h backoff.
    await setClock(T0 + 900_000 + 5 * H);
    await beat('vm-b', b.secret);
    const c3 = (await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' })).json;
    await endClaim('vm-b', b.secret, c3.claim_id, { end_reason: 'released:cannot-finish:transient' });

    expect(await rows(`SELECT hold, hold_reason FROM ticket_overrides WHERE ticket_id = 'docs:R3-9001'`)).toEqual([{ hold: 1, hold_reason: 'attempts-exhausted' }]);
    expect(await rows(`SELECT kind FROM events WHERE kind IN ('attempts-exhausted', 'held')`)).toEqual([{ kind: 'attempts-exhausted' }, { kind: 'held' }]);
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { held_items: { ticket_id: string; hold_reason: string; attempts: { id: number }[] }[] } };
    expect(state.needs_you.held_items).toEqual([expect.objectContaining({ ticket_id: 'docs:R3-9001', hold_reason: 'attempts-exhausted' })]);
    expect(state.needs_you.held_items[0].attempts.map((x) => x.id)).toEqual([c1.claim_id, c2.claim_id, c3.claim_id]);

    // The owner lifts it: the count starts again, so one more failure backs off, not holds.
    await owner('/v1/ui/overrides/docs:R3-9001', { hold: false });
    const c4 = await claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9001' });
    expect(c4.status).toBe(200);
    await endClaim('vm-b', b.secret, c4.json.claim_id, { end_reason: 'released:cannot-finish:transient' });
    expect(await rows(`SELECT hold, hold_reason, retry_after FROM ticket_overrides WHERE ticket_id = 'docs:R3-9001'`)).toEqual([{ hold: 0, hold_reason: null, retry_after: T0 + 900_000 + 6 * H }]);
  });
});
