// S-BTN-2 silent worker reaped (BATON_SPEC §13a), the server half: a worker's sidecar dies and
// the clock passes its lease timeout. Must hold: reaped exactly at the timeout; the item is
// re-issued; the dead session can no longer act on it (its heartbeat is worker-reaped, and the
// holder query its pre-push hook asks names another holder). The client half is R3-1213's.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { beat, claimItem, claimRow, cutover, payload, register, rows, setClock, stub, syncCall, workerCall , tick } from '../helpers';

const board = inject('board');
const T0 = Date.parse('2026-10-13T12:00:00Z');

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-2 silent worker reaped (server half)', () => {
  it('reaped exactly at its timeout, the item re-issued, the dead session fenced out', async () => {
    const dead = await register('vm-a');
    const { json: c } = await claimItem('vm-a', dead.secret, { work_item_id: 'R3-9001' });
    // The sidecar is killed after its last heartbeat at T0 + 2 min.
    await setClock(T0 + 120_000);
    await beat('vm-a', dead.secret);
    const live = await register('vm-b');

    await setClock(T0 + 120_000 + 900_000 - 1);
    await tick();
    expect((await claimRow(c.claim_id)).status).toBe('active');
    expect((await claimItem('vm-b', live.secret, { work_item_id: 'R3-9001' })).json.rule).toBe(3);

    await setClock(T0 + 120_000 + 900_000);
    await tick();
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'reaped', end_reason: 'reaped:silent', fence_pending: 0 });
    expect(await rows(`SELECT kind, actor FROM events WHERE claim_id = ? ORDER BY seq`, c.claim_id)).toEqual([{ kind: 'claimed', actor: `worker:${dead.id}` }, { kind: 'reaped', actor: 'alarm' }]);

    await beat('vm-b', live.secret);
    const reissued = await claimItem('vm-b', live.secret, { work_item_id: 'R3-9001' });
    expect(reissued.status).toBe(200);
    expect(reissued.json.previous_attempts).toEqual([{ claim_id: c.claim_id, status: 'reaped', end_reason: 'reaped:silent', ended_at: T0 + 1_020_000, resume: null }]);

    // The dead session, resumed: its heartbeat is refused, and its pre-push hook's holder query
    // (token alone) finds another live holder.
    expect((await beat('vm-a', dead.secret)).json.code).toBe('worker-reaped');
    expect(await (await workerCall('/v1/worker/items/R3-9001/holder', { cred: 'vm-a' })).json()).toEqual({ held_by_other: true, fence_pending: false });
    // The new holder asking about its own item is not "another".
    expect(await (await workerCall('/v1/worker/items/R3-9001/holder', { cred: 'vm-b', secret: live.secret })).json()).toEqual({ held_by_other: false, fence_pending: false });
  });
});
