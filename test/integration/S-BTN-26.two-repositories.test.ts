// S-BTN-26 two repositories (BATON_SPEC §2a R-BTN-47, §7.1, §10.3 R-BTN-15, R-BTN-61), the
// registry half R3-1231 part 2a delivers: a second repository `ops` with weight 50 and a ticket
// whose local id docs also has. Must hold: `docs:R3-9001` and `ops:R3-9001` are distinct
// tickets; `ops`' sync token cannot post `docs`' board; head, cutover and events are each
// repository's own; every `docs` candidate ranks above every `ops` one. The course clauses
// (W1 never offered `ops`, per-group limits, `min_worker_version`) and the branch clause arrive
// with part 2b and R3-1232.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import {
  captureDispatches, claimItem, cutover, ORIGIN, ownerCall, payload, register, rows, setClock, syncCall, syncToken, withCore, workerCall,
} from '../helpers';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const OPS = {
  id: 'ops', github: 'immediately-run/ops', default_branch: 'main', weight: 50,
  sync_workflow: '.github/workflows/baton-sync.yml', mirror_workflow: '.github/workflows/baton-mirror.yml',
};
const opsToken = (workflow = 'baton-sync.yml') =>
  syncToken({ repository: 'immediately-run/ops', ref: 'refs/heads/main', job_workflow_ref: `immediately-run/ops/.github/workflows/${workflow}@refs/heads/main` });
const opsCall = async (path: string, body?: unknown, workflow?: string) => syncCall(path, body, await opsToken(workflow));
/** ops' board: docs' first item under the same local id, and one of its own. */
const fixture = board.states.A.state.items[0] as Record<string, unknown>;
const opsBoard = {
  items: [{ ...fixture, title: 'ops: same local id' }, { ...fixture, id: 'T-1', title: 'ops: its own ticket', order: 20 }],
  ready: ['R3-9001', 'T-1'],
};
const OPS_SHA = 'f'.repeat(40);
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });

beforeEach(async () => {
  await setClock(T0);
  await withCore((c) => {
    c.registry.register(OPS);
  });
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
  await opsCall('/v1/sync/board', payload(OPS_SHA, null, opsBoard));
});

describe('S-BTN-26 two repositories (registry half)', () => {
  it('one local id in two repositories is two tickets, each on its own board', async () => {
    expect(await rows(`SELECT id, repository_id, local_id, title FROM tickets WHERE local_id = 'R3-9001' ORDER BY id`)).toEqual([
      { id: 'docs:R3-9001', repository_id: 'docs', local_id: 'R3-9001', title: fixture.title },
      { id: 'ops:R3-9001', repository_id: 'ops', local_id: 'R3-9001', title: 'ops: same local id' }]);
    expect(await (await syncCall('/v1/sync/head')).json()).toEqual({ sha: sha.A, unconfirmed: [] });
    expect(await (await opsCall('/v1/sync/head')).json()).toEqual({ sha: OPS_SHA, unconfirmed: [] });
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { repositories: { id: string; weight: number; head: { sha: string }; mode: { mode: string } }[] };
    expect(state.repositories.map((r) => [r.id, r.weight, r.head.sha, r.mode.mode])).toEqual([['docs', 100, sha.A, 'shadow'], ['ops', 50, OPS_SHA, 'shadow']]);
  });

  it('a sync token reaches only its own repository (R-BTN-15)', async () => {
    // ops' token posting what claims to be docs' next board lands on ops', never docs'.
    expect((await opsCall('/v1/sync/board', payload(sha.B, OPS_SHA, board.states.B))).status).toBe(200);
    expect(await (await syncCall('/v1/sync/head')).json()).toMatchObject({ sha: sha.A });
    expect(await rows(`SELECT count(*) AS n FROM tickets WHERE repository_id = 'docs' AND snapshot_sha = ?`, sha.B)).toEqual([{ n: 0 }]);
    // ops' mirror token reads ops' feed, and the board refuses it; another workflow is refused.
    expect((await opsCall('/v1/sync/events?after=0', undefined, 'baton-mirror.yml')).status).toBe(200);
    expect((await opsCall('/v1/sync/board', payload(OPS_SHA, null, opsBoard), 'baton-mirror.yml')).status).toBe(403);
    expect((await opsCall('/v1/sync/head', undefined, 'ci.yml')).status).toBe(403);
    // A repository Baton does not serve is refused, however its workflow is named.
    const stranger = await syncToken({ repository: 'immediately-run/other', job_workflow_ref: 'immediately-run/other/.github/workflows/baton-sync.yml@refs/heads/main' });
    expect((await syncCall('/v1/sync/head', undefined, stranger)).status).toBe(403);
  });

  it('cutover is per repository: claims reach only cut-over repositories, events only their own feed', async () => {
    const { secret } = await register('vm-a');
    const sent = await captureDispatches();
    expect((await owner('/v1/ui/cutover', { repository: 'ops', confirm: true })).status).toBe(200);
    const modeOf = async (repository: string) => (await (await workerCall(`/v1/runner/mode?repository=${repository}`, { secret })).json()) as { mode: string };
    expect([(await modeOf('docs')).mode, (await modeOf('ops')).mode]).toEqual(['shadow', 'cut-over']);
    expect((await workerCall('/v1/runner/mode?repository=nope', { secret })).status).toBe(400); // not registered
    // A docs ticket by name is not-cut-over; an open claim gets ops' first.
    expect((await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9001' })).json.code).toBe('not-cut-over');
    const c = await claimItem('vm-a', secret);
    expect(c.json).toMatchObject({ ticket_id: 'ops:R3-9001', snapshot_sha: OPS_SHA });
    expect(sent).toEqual(['ops:mirror']);
    const feed = (await (await opsCall('/v1/sync/events?after=0', undefined, 'baton-mirror.yml')).json()) as { events: { kind: string; ticket_id: string | null }[]; cutover_at: number };
    expect(feed.cutover_at).toBe(T0);
    expect(feed.events.map((e) => [e.kind, e.ticket_id])).toEqual(expect.arrayContaining([['claimed', 'ops:R3-9001']]));
    const docsFeed = (await (await syncCall('/v1/sync/events?after=0', undefined, await syncToken({ job_workflow_ref: 'immediately-run/docs/.github/workflows/baton-mirror.yml@refs/heads/main' }))).json()) as { events: { ticket_id: string | null }[]; cutover_at: number | null };
    expect(docsFeed.cutover_at).toBeNull();
    expect(docsFeed.events.filter((e) => e.ticket_id?.startsWith('ops:'))).toEqual([]);
  });

  it('R-BTN-61: every candidate of the heavier repository ranks above every one of the lighter', async () => {
    const { id } = await register('vm-a');
    await cutover(1, 'docs');
    await cutover(1, 'ops');
    const candidates = () => withCore((o) => {
      const c = o.claims as unknown as { candidates: (w: unknown, now: number, limit: number) => string[]; worker: (id: number) => unknown };
      return c.candidates(c.worker(id), T0, 100);
    });
    const got = await candidates();
    const firstOps = got.findIndex((t) => t.startsWith('ops:'));
    expect(firstOps).toBeGreaterThan(0);
    expect(got.slice(firstOps).every((t) => t.startsWith('ops:'))).toBe(true);
    expect(got.slice(firstOps)).toEqual(['ops:R3-9001', 'ops:T-1']); // ops' own order within it
    await rows(`UPDATE repositories SET weight = 200 WHERE id = 'ops'`);
    expect((await candidates()).slice(0, 2)).toEqual(['ops:R3-9001', 'ops:T-1']);
  });
});
