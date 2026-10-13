// R3-1206 — board sync's compare-and-set (BATON_SPEC §7.1 R-BTN-11; G-BTN-7).
import { describe, it, expect, inject } from 'vitest';
import { payload, rows, setClock, syncCall } from '../helpers';

const board = inject('board');
const { A, B, C, D } = board.shas;
const post = (sha: string, parent: string | null, label: keyof typeof board.states, extra = {}) =>
  syncCall('/v1/sync/board', payload(sha, parent, board.states[label], extra));
const body = async (res: Response) => (await res.json()) as Record<string, unknown>;
const head = async () => ((await (await syncCall('/v1/sync/head')).json()) as { sha: string | null }).sha;

describe('POST /v1/sync/board', () => {
  it('accepts the first snapshot with parent_sha null, and only while no head exists', async () => {
    expect((await post(A, null, 'A')).status).toBe(200);
    expect(await head()).toBe(A);
    const again = await post(B, null, 'B');
    expect(again.status).toBe(409);
    expect((await body(again)).code).toBe('head-moved');
    expect(await head()).toBe(A);
  });

  it('advances only from the current head; a stale parent gets head-moved', async () => {
    await post(A, null, 'A');
    expect((await post(B, A, 'B')).status).toBe(200);
    const stale = await post(C, A, 'C');
    expect(stale.status).toBe(409);
    expect((await body(stale)).code).toBe('head-moved');
    expect(await head()).toBe(B);
    expect((await post(C, B, 'C')).status).toBe(200);
    expect(await head()).toBe(C);
    const snaps = await rows<{ sha: string; parent_sha: string | null }>('SELECT sha, parent_sha FROM board_snapshots ORDER BY received_at, rowid');
    expect(snaps).toEqual([{ sha: A, parent_sha: null }, { sha: B, parent_sha: A }, { sha: C, parent_sha: B }]);
  });

  it('a repeat of the head is a no-op', async () => {
    await post(A, null, 'A');
    const res = await post(A, null, 'A');
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ ok: true, unchanged: true });
  });

  it('G-BTN-7: force is held — the head stays, a snapshot-rejected event records it', async () => {
    await setClock(Date.parse('2026-10-13T12:00:00Z'));
    await post(A, null, 'A');
    await post(B, A, 'B');
    const res = await post(D, B, 'D', { force: true });
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe('snapshot-rejected');
    expect(await head()).toBe(B);
    const ev = await rows<{ kind: string; detail_json: string }>(`SELECT kind, detail_json FROM events WHERE kind = 'snapshot-rejected'`);
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].detail_json)).toMatchObject({ sha: D, parent_sha: B, head: B, held: true, auto_accept_at: Date.parse('2026-10-14T12:00:00Z') });
    // Nothing of D reached the cache: R3-9003 (archived in D) is still there.
    expect(await rows(`SELECT id FROM work_items WHERE id = 'R3-9003'`)).toHaveLength(1);
  });

  it.each([
    ['a short sha', { sha: 'abc', parent_sha: null, state: { items: [] }, ready: [] }],
    ['no state', { sha: A, parent_sha: null, ready: [] }],
    ['ready naming an item the state lacks', { sha: A, parent_sha: null, state: { items: [] }, ready: ['R3-9001'] }],
    ['a malformed item id', { sha: A, parent_sha: null, state: { items: [{ id: '../etc', title: 't', status: 'available', queue: 'autonomous', node: 'blocked' }] }, ready: [] }],
    ['a control character in a title', { sha: A, parent_sha: null, state: { items: [{ id: 'R3-1', title: 'a\u0007b', status: 'available', queue: 'autonomous', node: 'blocked' }] }, ready: [] }],
  ])('refuses %s with invalid-params, writing nothing', async (_what, bad) => {
    const res = await syncCall('/v1/sync/board', bad);
    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe('invalid-params');
    expect(await head()).toBeNull();
  });
});
