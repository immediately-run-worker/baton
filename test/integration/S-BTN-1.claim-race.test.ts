// S-BTN-1 claim race (BATON_SPEC §13a): two workers claim the same item at once, and a lost
// claim response is retried. Must hold: one holder; the retry returns the same claim.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { beat, claimItem, cutover, payload, register, requestId, rows, setClock, syncCall } from '../helpers';

const board = inject('board');

beforeEach(async () => {
  await setClock(Date.parse('2026-10-13T12:00:00Z'));
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-1 claim race', () => {
  it('two workers asking for the next item at once: one holds it, the other gets the next one; a retried request is the same claim', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const ra = { request_id: requestId() };
    const rb = { request_id: requestId() };
    const [x, y] = await Promise.all([claimItem('vm-a', a.secret, ra), claimItem('vm-b', b.secret, rb)]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(new Set([x.json.work_item_id, y.json.work_item_id])).toEqual(new Set(['R3-9001', 'R3-9002']));

    // vm-a's response was lost: it retries the same request_id and gets the same claim.
    const retry = await claimItem('vm-a', a.secret, ra);
    expect(retry.json).toEqual(x.json);
    expect(await rows(`SELECT work_item_id, count(*) AS n FROM work_item_claims WHERE status = 'active' GROUP BY work_item_id ORDER BY work_item_id`))
      .toEqual([{ work_item_id: 'R3-9001', n: 1 }, { work_item_id: 'R3-9002', n: 1 }]);
    expect((await beat('vm-a', a.secret)).json.claim.id).toBe(x.json.claim_id);
  });

  it('two workers naming the same item at once: exactly one holder', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const both = await Promise.all([claimItem('vm-a', a.secret, { work_item_id: 'R3-9002' }), claimItem('vm-b', b.secret, { work_item_id: 'R3-9002' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await rows(`SELECT count(*) AS n FROM work_item_claims WHERE work_item_id = 'R3-9002'`)).toEqual([{ n: 1 }]);
  });
});
