// R3-1231 part 3 — the observation counter (BATON_SPEC R-BTN-62, §11 POST /v1/sync/observation):
// one number outstanding per repository, each used once, a post refused whole unless its number
// is the outstanding one and above the last accepted reading's.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { MIRROR_WORKFLOW_REF, observe, payload, rows, setClock, syncCall, syncToken, withCore } from '../helpers';
import { checkPayload } from '../../src/core/board';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const MIN = 60_000;
const code = async (res: Response) => ((await res.json()) as { code: string }).code;
const head = async () => ((await (await syncCall('/v1/sync/head')).json()) as { sha: string | null }).sha;

beforeEach(async () => {
  await setClock(T0);
});

describe('POST /v1/sync/observation (R-BTN-62)', () => {
  it('hands out the next number with the head; sync-busy while one is outstanding; void after ten minutes', async () => {
    expect(await observe()).toEqual({ status: 200, json: { sha: null, observation: 1, bars: [] } });
    const busy = await observe();
    expect([busy.status, busy.json.code]).toEqual([409, 'sync-busy']);
    await setClock(T0 + 10 * MIN - 1);
    expect((await observe()).json.code).toBe('sync-busy');
    await setClock(T0 + 10 * MIN);
    expect((await observe()).json).toEqual({ sha: null, observation: 2, bars: [] });
    expect(await rows(`SELECT last_handed_out, handed_out_at, observation FROM board_head WHERE repository_id = 'docs'`)).toEqual([
      { last_handed_out: 2, handed_out_at: T0 + 10 * MIN, observation: 0 }]);
  });

  it('takes only the repository’s sync workflow, and each repository counts on its own', async () => {
    const mirror = await observe(await syncToken({ job_workflow_ref: MIRROR_WORKFLOW_REF }));
    expect(mirror.status).toBe(403);
    await withCore((c) => {
      c.registry.register({ id: 'ops', github: 'immediately-run/ops', default_branch: 'main', sync_workflow: '.github/workflows/baton-sync.yml' });
    });
    const ops = await syncToken({ repository: 'immediately-run/ops', job_workflow_ref: 'immediately-run/ops/.github/workflows/baton-sync.yml@refs/heads/main' });
    expect((await observe()).json.observation).toBe(1);
    expect((await observe(ops)).json.observation).toBe(1); // docs' outstanding number does not busy ops
  });
});

describe('a board post carries its number (R-BTN-62)', () => {
  it('a post with no number, or one not handed out, is refused and writes nothing', async () => {
    const none = await syncCall('/v1/sync/board', { ...payload(sha.A, null, board.states.A), observation: null });
    expect([none.status, await code(none)]).toEqual([400, 'invalid-params']);
    const never = await syncCall('/v1/sync/board', { ...payload(sha.A, null, board.states.A), observation: 7 });
    expect(await code(never)).toBe('stale-observation');
    expect(await head()).toBeNull();
  });

  it('a number is used once: by an accepted post, a refused one (head-moved) and a malformed one alike', async () => {
    const n = (await observe()).json.observation;
    expect((await syncCall('/v1/sync/board', { ...payload(sha.A, null, board.states.A), observation: n })).status).toBe(200);
    expect(await code(await syncCall('/v1/sync/board', { ...payload(sha.B, sha.A, board.states.B), observation: n }))).toBe('stale-observation');
    const m = (await observe()).json.observation;
    expect(await code(await syncCall('/v1/sync/board', { ...payload(sha.C, sha.B, board.states.C), observation: m }))).toBe('head-moved');
    expect((await observe()).status).toBe(200); // used, so not outstanding
    const k = (await observe()).json;
    expect(k.code).toBe('sync-busy');
    await setClock(T0 + 10 * MIN);
    const bad = (await observe()).json.observation;
    expect(await code(await syncCall('/v1/sync/board', { sha: 'x', observation: bad }))).toBe('invalid-params');
    expect((await observe()).status).toBe(200); // the malformed post used it too
  });

  it('a held force post records its number and still advances the reading', async () => {
    await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B));
    const n = (await observe()).json.observation;
    const held = await syncCall('/v1/sync/board', { ...payload(sha.D, sha.B, board.states.D, { force: true }), observation: n });
    expect(await code(held)).toBe('snapshot-rejected');
    expect(await rows('SELECT sha, observation FROM held_snapshots')).toEqual([{ sha: sha.D, observation: n }]);
    expect(await rows(`SELECT observation FROM board_head WHERE repository_id = 'docs'`)).toEqual([{ observation: n }]);
  });
});

describe('two posts judged at once (round 1, 1-B-2)', () => {
  it('a post whose number another run overtook while its rows were hashed is refused; one wins, the head never goes back', async () => {
    await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
    const out = await withCore(async (c) => {
      const repo = c.registry.get('docs')!;
      const first = c.observations.observe('docs').observation;
      const p1 = c.board(repo, checkPayload({ ...payload(sha.B, sha.A, board.states.B), observation: first })).then((r) => ({ ok: r }), (e) => ({ code: (e as { code: string }).code }));
      // p1 used its number and is awaiting its row hashes: a second run takes the next and posts.
      const second = c.observations.observe('docs').observation;
      const p2 = c.board(repo, checkPayload({ ...payload(sha.C, sha.A, board.states.C), observation: second })).then((r) => ({ ok: r }), (e) => ({ code: (e as { code: string }).code }));
      return Promise.all([p1, p2]);
    });
    const won = out.filter((r) => 'ok' in r);
    expect(won).toHaveLength(1);
    expect(out.find((r) => 'code' in r)).toMatchObject({ code: expect.stringMatching(/^(head-moved|stale-observation)$/) });
    const h = await rows<{ sha: string; observation: number }>(`SELECT sha, observation FROM board_head WHERE repository_id = 'docs'`);
    expect([sha.B, sha.C]).toContain(h[0].sha);
  });
});
