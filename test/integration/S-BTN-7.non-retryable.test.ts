// S-BTN-7 non-retryable failure (BATON_SPEC §13a, §6.10): a claimant releases
// cannot-finish:spec. Must hold: held at once; no backoff claim.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { claimItem, cutover, endClaim, payload, register, rows, setClock, syncCall } from '../helpers';

const board = inject('board');

beforeEach(async () => {
  await setClock(Date.parse('2026-10-13T12:00:00Z'));
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-7 non-retryable failure', () => {
  it.each(['spec', 'capability'])('cannot-finish:%s holds the item at once, with no backoff', async (cls) => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const c = (await claimItem('vm-a', a.secret, { ticket_id: 'R3-9001' })).json;
    await endClaim('vm-a', a.secret, c.claim_id, { end_reason: `released:cannot-finish:${cls}` });
    expect(await rows(`SELECT hold, hold_reason, retry_after FROM ticket_overrides WHERE ticket_id = 'R3-9001'`)).toEqual([{ hold: 1, hold_reason: `non-retryable:${cls}`, retry_after: null }]);
    expect(await rows(`SELECT json_extract(detail_json, '$.hold_reason') AS r FROM events WHERE kind = 'held'`)).toEqual([{ r: `non-retryable:${cls}` }]);
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'R3-9001' })).json).toMatchObject({ code: 'not-eligible', rule: 3 });
    expect((await claimItem('vm-b', b.secret)).json.ticket_id).toBe('R3-9002');
  });
});
