// R3-1206 — board sync's compare-and-set (BATON_SPEC §7.1 R-BTN-11; G-BTN-7).
import { describe, it, expect, inject } from 'vitest';
import { course, Git, payload, placed, rows, setClock, syncCall, ticket } from '../helpers';

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

  it('G-BTN-7: force is held once per sha — the head stays, the first deadline stands', async () => {
    await setClock(Date.parse('2026-10-13T12:00:00Z'));
    await post(A, null, 'A');
    await post(B, A, 'B');
    const res = await post(D, B, 'D', { force: true });
    expect(res.status).toBe(409);
    expect((await body(res)).code).toBe('snapshot-rejected');
    expect(await head()).toBe(B);
    // The sync re-posts every 15 minutes: a repeat changes nothing.
    await setClock(Date.parse('2026-10-13T12:15:00Z'));
    expect((await body(await post(D, B, 'D', { force: true }))).code).toBe('snapshot-rejected');
    const held = await rows('SELECT sha, parent_sha, head_sha, ticket_count, received_at, auto_accept_at, accepted_at FROM held_snapshots');
    expect(held).toEqual([{ sha: D, parent_sha: B, head_sha: B, ticket_count: 3, received_at: Date.parse('2026-10-13T12:00:00Z'), auto_accept_at: Date.parse('2026-10-14T12:00:00Z'), accepted_at: null }]);
    expect(await rows(`SELECT 1 FROM events WHERE kind = 'snapshot-rejected'`)).toHaveLength(1);
    // Nothing of D reached the cache: R3-9003 (archived in D) is still there.
    expect(await rows(`SELECT id FROM tickets WHERE id = 'docs:R3-9003'`)).toHaveLength(1);
  });

  it.each([
    ['a short sha', { sha: 'abc', parent_sha: null, state: { items: [] }, ready: [] }],
    ['no state', { sha: A, parent_sha: null, ready: [] }],
    ['ready naming an item the state lacks', { sha: A, parent_sha: null, state: { items: [] }, ready: ['R3-9001'] }],
    ['a malformed item id', { sha: A, parent_sha: null, state: { items: [{ id: '../etc', title: 't', status: 'available', queue: 'autonomous', node: 'blocked' }] }, ready: [] }],
    ['a control character in a title', { sha: A, parent_sha: null, state: { items: [{ id: 'R3-1', title: 'a\u0007b', status: 'available', queue: 'autonomous', node: 'blocked' }] }, ready: [] }],
    ['force as a string', { ...payload(A, null, board.states.A), force: 'false' }],
    ['a registry that is not a list', { ...payload(A, null, board.states.A), registry: {} }],
    ['a course named twice', { ...payload(A, null, board.states.A), registry: [course(), course()] }],
    ['a min_worker_version above its version', { ...payload(A, null, board.states.A), registry: [course(3, 4)] }],
    ['a branch pattern without {ticket}', { ...payload(A, null, board.states.A), registry: [course(3, 3, { branch_pattern: 'claude/*' })] }],
    ['a registry of 65 courses', { ...payload(A, null, board.states.A), registry: Array.from({ length: 65 }, (_, i) => course(3, 3, { id: `c${i}` })) }],
    ['a course file over 64 KiB with none in force', { ...payload(A, null, board.states.A), registry: [course(3, 3, { course: { pad: 'x'.repeat(65 * 1024) } })] }],
    ['a previous branch pattern without {ticket}', { ...payload(A, null, board.states.A), registry: [course(3, 3, { previous_branch_pattern: 'feature/*' })] }],
    ['65 step kinds', { ...payload(A, null, board.states.A), registry: [course(3, 3, { step_kinds: Array.from({ length: 65 }, (_, i) => `k${i}`) })] }],
    ['a report horizon past 168 hours', { ...payload(A, null, board.states.A), registry: [course(3, 3, { report_horizon_h: 169 })] }],
    ['a version past the ceiling', { ...payload(A, null, board.states.A), registry: [course(1_000_000_001, 0)] }],
    ['an item naming a malformed course', { sha: A, parent_sha: null, state: { items: [{ id: 'R3-1', title: 't', status: 'available', queue: 'autonomous', node: 'blocked', course: 'Roadmap PR' }] }, ready: [] }],
    ['an account list that is not a list', { ...payload(A, null, board.states.A), providers: { accounts: 'x', peak_schedules: [], models: [] } }],
    ['an unknown billing kind', { ...payload(A, null, board.states.A), providers: { accounts: [{ id: 'zai', name: 'Z', billing: 'credits', window_limits: null }], peak_schedules: [], models: [] } }],
    ['a model on an unknown schedule', { ...payload(A, null, board.states.A), providers: { accounts: [{ id: 'zai', name: 'Z', billing: 'api', window_limits: null }], peak_schedules: [], models: [{ provider: 'zai', model: 'm', monthly_limit_usd: null, peak_schedule: 'nope' }] } }],
    ['a model on an unknown account', { ...payload(A, null, board.states.A), providers: { accounts: [], peak_schedules: [], models: [{ provider: 'zai', model: 'm', monthly_limit_usd: null }] } }],
    ['a price pattern that does not compile', { ...payload(A, null, board.states.A), prices: { models: [{ match: '(', input: 1 }] } }],
    ['a repeated peak schedule id', { ...payload(A, null, board.states.A), providers: { accounts: [], peak_schedules: [{ id: 'x', rules: { days: [1], hoursUtc: [[1, 2]] }, factor: 0.5 }, { id: 'x', rules: { days: [1], hoursUtc: [[1, 2]] }, factor: 0.5 }], models: [] } }],
    ['a repeated (provider, model) pair', { ...payload(A, null, board.states.A), providers: { accounts: [{ id: 'zai', name: 'Z', billing: 'api', window_limits: null }], peak_schedules: [], models: [{ provider: 'zai', model: 'm', monthly_limit_usd: null }, { provider: 'zai', model: 'm', monthly_limit_usd: 1 }] } }],
    ['a repeated account id', { ...payload(A, null, board.states.A), providers: { accounts: [{ id: 'zai', name: 'Z', billing: 'api', window_limits: null }, { id: 'zai', name: 'Z2', billing: 'api', window_limits: null }], peak_schedules: [], models: [] } }],
    ['a reviewer with no bills', { ...payload(A, null, board.states.A), matrix: { families: {}, agents: { 'review-pr-x': { reviews_on: 'm' } } } }],
  ])('refuses %s with invalid-params, writing nothing', async (_what, bad) => {
    const res = await syncCall('/v1/sync/board', bad);
    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe('invalid-params');
    expect(await head()).toBeNull();
  });

  it.skipIf(!inject('liveBoard'))("accepts what the docs sync builds for today's board, reference data included", async () => {
    // buildPayload(origin/main) from the sibling docs checkout: the real producer's output
    // through the real validator (R3-386's annotated repos entry was refused before repoName).
    const live = inject('liveBoard') as { state: { items: unknown[] }; ready: string[]; providers: { accounts: unknown[] }; reviewers: object };
    const res = await syncCall('/v1/sync/board', payload('f'.repeat(40), null, live));
    expect(res.status).toBe(200);
    expect(await rows('SELECT count(*) AS n FROM tickets')).toEqual([{ n: live.state.items.length }]);
    expect(await rows('SELECT count(*) AS n FROM model_providers')).toEqual([{ n: live.providers.accounts.length }]);
    expect(await rows('SELECT count(*) AS n FROM reviewer_agents')).toEqual([{ n: Object.keys(live.reviewers).length }]);
  });
});

describe('the course registry on a board post (R-BTN-48, R-BTN-69)', () => {
  const runbook = { start: 'a', start_leg: 'go', end: ['b'], stations: { a: { label: 'A' }, b: { label: 'B' } }, legs: { go: { from: ['a'], to: 'b' } } };
  const extra = course(1, 1, { id: 'runbook', skill: 'run-runbook', course: runbook, step_kinds: ['orient'] });

  it('a repeat of the head does not apply its registry: its body may be built at an ancestor (round 2, 2-A-0)', async () => {
    await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [course(5)] }));
    const res = await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [course(3)] }));
    expect(await res.json()).toMatchObject({ ok: true, unchanged: true });
    expect(await rows(`SELECT id, version FROM courses`)).toEqual([{ id: 'roadmap-pr', version: 5 }]);
  });

  it('an oversized course file is that course’s refusal: the one in force stays and the board advances', async () => {
    await syncCall('/v1/sync/board', payload(A, null, board.states.A));
    const res = await syncCall('/v1/sync/board', payload(board.shas.B, A, board.states.B, { registry: [course(4, 4, { course: { pad: 'x'.repeat(65 * 1024) } })] }));
    expect(await res.json()).toMatchObject({ ok: true, courses_refused: ['roadmap-pr'] });
    expect(await head()).toBe(board.shas.B);
    expect(await rows(`SELECT version FROM courses`)).toEqual([{ version: 3 }]);
    expect(await rows(`SELECT version, json_extract(violations, '$[0].rule') AS rule FROM course_refusals`)).toEqual([{ version: 4, rule: 'bound' }]);
  });

  it('a refused file’s violations are stored bounded and safe to show (round 3, 3-A-0)', async () => {
    await syncCall('/v1/sync/board', payload(A, null, board.states.A));
    const key = `<b>\u0007${'k'.repeat(25_000)}`;
    const hostile = { start: 'filed', stations: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`${key}${i}`, {}])) };
    const res = await syncCall('/v1/sync/board', payload(board.shas.B, A, board.states.B, { registry: [course(4, 4, { course: hostile })] }));
    expect(await res.json()).toMatchObject({ ok: true, courses_refused: ['roadmap-pr'] });
    const [r] = await rows<{ violations: string }>(`SELECT violations FROM course_refusals`);
    const vs = JSON.parse(r.violations) as { path: string; message: string }[];
    expect(vs.length).toBeLessThanOrEqual(20);
    for (const v of vs) {
      expect([...v.path].length).toBeLessThanOrEqual(500);
      expect([...v.message].length).toBeLessThanOrEqual(500);
      expect(v.path + v.message).not.toMatch(/[\u0000-\u001f<>{}]/);
    }
  });

  it('the registry is the whole registry: a course it no longer lists leaves, unless a ticket still names it', async () => {
    const { B, C, D } = board.shas;
    await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [course(3), extra] }));
    expect(await rows(`SELECT id FROM courses ORDER BY id`)).toEqual([{ id: 'roadmap-pr' }, { id: 'runbook' }]);
    await syncCall('/v1/sync/board', payload(B, A, board.states.B, { registry: [course(3), { ...extra, version: 2, course: { ...runbook, start_leg: 'nope' } }] }));
    expect(await rows(`SELECT course_id FROM course_refusals`)).toEqual([{ course_id: 'runbook' }]);
    await syncCall('/v1/sync/board', payload(C, B, board.states.C, { registry: [course(3)] }));
    expect(await rows(`SELECT id FROM courses`)).toEqual([{ id: 'roadmap-pr' }]);
    expect(await rows(`SELECT count(*) AS n FROM course_refusals`)).toEqual([{ n: 0 }]);
    // Every ticket is roadmap-pr's: a registry without it refuses the post and changes nothing.
    const res = await syncCall('/v1/sync/board', payload(D, C, board.states.C, { registry: [extra] }));
    expect([res.status, (await body(res)).code]).toEqual([400, 'invalid-params']);
    expect(await rows(`SELECT id FROM courses`)).toEqual([{ id: 'roadmap-pr' }]);
    expect(await head()).toBe(C);
  });
});

describe('the normative board post (§7.1, R3-1232)', () => {
  const T0 = Date.parse('2026-10-16T12:00:00Z');
  const fresh = () => {
    const git = new Git();
    git.add('T-1').add('T-2', { rank: 1, display: { status: 'in-review', project: 'baton' } }, placed('pr-open', [['implement', 'pr-open']], [['review', 'waiting', 'ci']], { bars: { fix: ['family:qwen'], merge: ['family:qwen'] }, handoff_url: 'https://github.com/immediately-run/docs/pull/2#issuecomment-1' }));
    return git;
  };

  it('stores the tickets’ filter fields, where each is, its next legs and its barred tags; display is kept, never read', async () => {
    await setClock(T0);
    expect(await fresh().post()).toMatchObject({ status: 200, upserted: 2 });
    expect(await rows(`SELECT id, path, status, node, queue, expedite, display FROM tickets ORDER BY id`)).toEqual([
      { id: 'docs:T-1', path: 'content/roadmap/T-1.mdx', status: '', node: '', queue: '', expedite: 0, display: null },
      { id: 'docs:T-2', path: 'content/roadmap/T-2.mdx', status: '', node: '', queue: '', expedite: 0, display: '{"status":"in-review","project":"baton"}' }]);
    expect(await rows(`SELECT ticket_id, station, path_len, to_end, next_leg, next_source, handoff_url FROM ticket_stations ORDER BY ticket_id`)).toEqual([
      { ticket_id: 'docs:T-1', station: 'filed', path_len: 0, to_end: 3, next_leg: 'implement', next_source: 'marker', handoff_url: null },
      { ticket_id: 'docs:T-2', station: 'pr-open', path_len: 1, to_end: 2, next_leg: 'review', next_source: 'marker', handoff_url: 'https://github.com/immediately-run/docs/pull/2#issuecomment-1' }]);
    expect(await rows(`SELECT ticket_id, leg, state, waiting_on, ready_since, waiting_since FROM ticket_next_legs ORDER BY ticket_id`)).toEqual([
      { ticket_id: 'docs:T-1', leg: 'implement', state: 'ready', waiting_on: null, ready_since: T0, waiting_since: null },
      { ticket_id: 'docs:T-2', leg: 'review', state: 'waiting', waiting_on: 'ci', ready_since: null, waiting_since: T0 }]);
    expect(await rows(`SELECT leg, tag FROM ticket_bars ORDER BY leg`)).toEqual([{ leg: 'fix', tag: 'family:qwen' }, { leg: 'merge', tag: 'family:qwen' }]);
  });

  it('ready_since runs from the first snapshot that showed the leg ready', async () => {
    await setClock(T0);
    const git = fresh();
    await git.post();
    await setClock(T0 + 60_000);
    git.place('T-2', placed('pr-open', [['implement', 'pr-open']], [['review', 'ready']]));
    await git.refresh();
    await setClock(T0 + 120_000);
    await git.refresh();
    expect(await rows(`SELECT ticket_id, ready_since FROM ticket_next_legs ORDER BY ticket_id`)).toEqual([
      { ticket_id: 'docs:T-1', ready_since: T0 }, { ticket_id: 'docs:T-2', ready_since: T0 + 60_000 }]);
  });

  it('a closure is kept after the ticket goes, with the first observation that reported it, and deleted if the ticket returns', async () => {
    const git = fresh();
    await git.post();
    git.close('T-1', 'done');
    await git.post();
    const n = (await rows<{ observation: number }>(`SELECT observation FROM board_head WHERE repository_id = 'docs'`))[0].observation;
    expect(await rows('SELECT ticket_id, closed_as, observation FROM closed_tickets')).toEqual([{ ticket_id: 'docs:T-1', closed_as: 'done', observation: n }]);
    expect(await rows(`SELECT 1 FROM ticket_stations WHERE ticket_id = 'docs:T-1'`)).toEqual([]);
    git.add('T-1');
    await git.post();
    expect(await rows('SELECT ticket_id FROM closed_tickets')).toEqual([]);
  });

  it('a station or leg the course file does not have places the ticket nowhere and logs off-graph; so does a path that skips an edge', async () => {
    const git = fresh();
    await git.post();
    git.place('T-1', placed('nowhere', [], []));
    await git.post();
    expect(await rows(`SELECT 1 FROM ticket_stations WHERE ticket_id = 'docs:T-1'`)).toEqual([]);
    // T-2 jumps from pr-open straight to merged: a step that is no edge of the file — stored (git
    // wins), and logged.
    git.place('T-2', placed('merged', [['implement', 'pr-open'], ['merge', 'merged']], []));
    await git.post();
    expect(await rows(`SELECT station FROM ticket_stations WHERE ticket_id = 'docs:T-2'`)).toEqual([{ station: 'merged' }]);
    expect(await rows(`SELECT ticket_id, json_extract(detail_json, '$.why') AS why FROM events WHERE kind = 'off-graph' ORDER BY seq`)).toEqual([
      { ticket_id: 'docs:T-1', why: 'unknown station nowhere' },
      { ticket_id: 'docs:T-2', why: 'the path does not extend the previous one by edges' }]);
  });

  it('a live ticket the post does not place is placed nowhere: never offered on an old station', async () => {
    const git = fresh();
    await git.post();
    delete git.stations['T-1'];
    await git.post();
    expect(await rows(`SELECT ticket_id FROM ticket_stations`)).toEqual([{ ticket_id: 'docs:T-2' }]);
  });

  it('refuses a malformed post whole: both shapes, a station of no ticket, a bad tag, a bad path, an http hand-off', async () => {
    const git = fresh();
    const bad = [
      { ...git.body(A, null), state: { items: [] }, ready: [] },
      { ...git.body(A, null), stations: { ...git.stations, 'T-9': placed('filed', [], []) } },
      { ...git.body(A, null), stations: { 'T-1': placed('filed', [], [], { bars: { fix: ['bad tag'] } }) } },
      { ...git.body(A, null), tickets: [ticket('T-1', { path: '../etc/passwd' })], stations: {} },
      { ...git.body(A, null), stations: { 'T-1': placed('filed', [], [], { handoff_url: 'http://x' }) } },
      { ...git.body(A, null), closed: [{ id: 'T-1', as: 'done' }] }, // closed and live at once
      { ...git.body(A, null), tickets: [ticket('T-1', { requires: 'none' })], stations: {} },
    ];
    for (const b of bad) {
      const res = await syncCall('/v1/sync/board', b);
      expect([res.status, (await body(res)).code]).toEqual([400, 'invalid-params']);
    }
    expect(await head()).toBeNull();
  });
});
