// S-BTN-12 completion confirmation (BATON_SPEC §13a, §6.7): a worker completes before its push's
// sync arrives, and a push that never lands. Must hold: unclaimable until confirmed by ancestry;
// the never-landed one is flagged at 6 h and never re-issued. The sync is the real decision code
// (scripts/lib/batonSync.mjs, vendored) over the fixture repository's real ancestry.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { syncOnce } from '../../src/shared/batonSync.mjs';
import { claimItem, claimRow, cutover, endClaim, ownerCall, payload, register, setClock, stub, syncCall , tick } from '../helpers';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
type Label = keyof typeof sha;
const labelOf = (s: string) => Object.entries(sha).find(([, v]) => v === s)?.[0];
const items = (l: Label) => board.states[l].state.items as { id: string; status: string }[];

/** The real sync, run for a push of `next`. */
const sync = (next: Label) => syncOnce(sha[next], {
  readHead: async () => (await syncCall('/v1/sync/head')).json(),
  post: async (body: unknown) => {
    const res = await syncCall('/v1/sync/board', body);
    const json = (await res.json()) as Record<string, unknown>;
    return res.ok ? { ok: true, ...json } : json;
  },
  isAncestor: async (a: string, b: string) => board.ancestry[`${labelOf(a)}<${labelOf(b)}`] === true,
  buildPayload: async () => board.states[next],
  statusOf: (id: string) => items(next).find((i) => i.id === id)?.status ?? null,
  sleep: async () => {},
});

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-12 completion confirmation', () => {
  it('completed before the sync: unclaimable until a sync sees it landed, then claimable', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret, { ticket_id: 'R3-9001' });
    // The worker pushed A's history (git first, R-BTN-8) and ends before any sync has run.
    await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.A });
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'R3-9001' })).json.rule).toBe(3);
    // The sync for D: A is an ancestor and the item is no longer in-progress there.
    expect(await sync('D')).toMatchObject({ outcome: 'advanced' });
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0);
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'R3-9001' })).status).toBe(200);
  });

  it('a push that never lands: flagged on the dashboard at 6 h, never re-issued', async () => {
    const a = await register('vm-a', { lease_timeout_s: 86_400 });
    const b = await register('vm-b', { lease_timeout_s: 86_400 });
    const { json: c } = await claimItem('vm-a', a.secret, { ticket_id: 'R3-9001' });
    // It names C — a commit main will never carry once D rewrites it.
    await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.C });
    // The sync runs with main still at A, where the item is ready: C is not an ancestor of A, so
    // nothing is confirmed and nothing is posted.
    expect(await sync('A')).toMatchObject({ outcome: 'confirmed' });
    expect((await claimRow(c.claim_id)).confirmed_at).toBeNull();
    const needs = async () => ((await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { unconfirmed: { id: number }[] } }).needs_you.unconfirmed;
    await setClock(T0 + 6 * 3_600_000 - 1);
    expect(await needs()).toEqual([]);
    await setClock(T0 + 6 * 3_600_000);
    expect(await needs()).toEqual([expect.objectContaining({ id: c.claim_id, ticket_id: 'R3-9001', ended_at_sha: sha.C })]);
    // Days later, the alarm has run and nothing confirmed or re-issued it.
    await setClock(T0 + 3 * 86_400_000);
    await tick();
    expect(await claimRow(c.claim_id)).toMatchObject({ status: 'completed', confirmed_at: null });
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'R3-9001' })).json).toMatchObject({ code: 'not-eligible', rule: 3 });
  });
});
