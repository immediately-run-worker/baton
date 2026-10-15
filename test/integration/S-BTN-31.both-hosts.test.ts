// S-BTN-31 both hosts (BATON_SPEC §13a, R-BTN-55, R-BTN-56; G-BTN-56): this file, like every
// scenario here, runs on the Cloudflare host and again on the local one (vitest.config.ts).
// Must hold: the same answers on both; a sync token whose audience names another Baton is
// refused. The hooks clause — a repository's hooks give the same results in a local `workerd`
// with no outbound network — arrives with the hook runners (R3-1236).
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { HOST, ORIGIN, ownerCall, payload, setClock, syncCall, syncToken } from '../helpers';

const board = inject('board');

beforeEach(async () => {
  await setClock(Date.parse('2026-10-13T12:00:00Z'));
});

describe(`S-BTN-31 both hosts (${HOST})`, () => {
  it('a sync token minted for another Baton is refused; one for this Baton is accepted', async () => {
    for (const audience of ['https://baton-staging.immediately.run', 'http://127.0.0.1:8787', `${ORIGIN}/`]) {
      const res = await syncCall('/v1/sync/head', undefined, await syncToken({}, { audience }));
      expect([audience, res.status]).toEqual([audience, 401]);
      expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
    }
    const own = await syncCall('/v1/sync/head', undefined, await syncToken({}, { audience: ORIGIN }));
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ sha: null, unconfirmed: [] });
  });

  it('a posted board is served back in the order the sync ranked it', async () => {
    expect((await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A))).status).toBe(200);
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { head: { sha: string }; ready: { id: string }[] };
    expect(state.head.sha).toBe(board.shas.A);
    expect(state.ready.map((r) => r.id)).toEqual(board.states.A.ready);
  });

  it.todo('a repository\'s hooks give the same results on both hosts, locally in workerd with no outbound network (R3-1236)');
});
