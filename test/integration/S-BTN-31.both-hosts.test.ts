// S-BTN-31 both hosts (BATON_SPEC §13a, R-BTN-55, R-BTN-56; G-BTN-56): this file, like every
// scenario here, runs on the Cloudflare host and again on the local one (vitest.config.ts).
// Must hold: the same answers on both; a sync token whose audience names another Baton is
// refused. The hooks clause — a repository's hooks give the same results in a local `workerd`
// with no outbound network — arrives with the hook runners (R3-1236).
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { call, claimItem, cutover, HOST, ORIGIN, ownerCall, payload, register, rows, setClock, syncCall, syncToken, TOKENS } from '../helpers';

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
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { repositories: { head: { sha: string } }[]; ready: { id: string }[] };
    expect(state.repositories[0].head.sha).toBe(board.shas.A);
    expect(state.ready.map((r) => r.id)).toEqual(board.states.A.ready.map((id: string) => `docs:${id}`));
  });

  it('an integer past 2^53 that validation accepts reads back alike: a claim and the dashboard still answer', async () => {
    expect(await rows('SELECT ? AS v', 2 ** 60)).toEqual([{ v: 2 ** 60 }]);
    await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
    await cutover();
    const a = await register('vm-a', { last_activity_at: 2 ** 60 });
    expect((await claimItem('vm-a', a.secret, { ticket_id: 'docs:R3-9002' })).status).toBe(200);
    expect((await ownerCall('/v1/ui/state')).status).toBe(200);
  });

  it('the runner API is under /v1/runner only: the old /v1/worker prefix is not served (R3-1261)', async () => {
    for (const [method, path] of [['POST', '/v1/worker/heartbeat'], ['GET', '/v1/worker/mode'], ['GET', '/v1/worker/next']] as const) {
      const res = await call(path, { method, headers: { Authorization: `Bearer ${TOKENS['vm-a']}`, 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect([path, res.status, ((await res.json()) as { code: string }).code]).toEqual([path, 404, 'not-found']);
    }
    expect((await call('/v1/runner/mode?repository=docs', { headers: { Authorization: `Bearer ${TOKENS['vm-a']}` } })).status).not.toBe(404);
  });

  it.todo('a repository\'s hooks give the same results on both hosts, locally in workerd with no outbound network (R3-1236)');
});
