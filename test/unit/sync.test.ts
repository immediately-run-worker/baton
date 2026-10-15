// R3-1206 — board sync's compare-and-set (BATON_SPEC §7.1 R-BTN-11; G-BTN-7).
import { describe, it, expect, inject } from 'vitest';
import { course, payload, rows, setClock, syncCall } from '../helpers';

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

  it('a repeat of the head applies its registry: a head posted before the registry gets its courses', async () => {
    await syncCall('/v1/sync/board', payload(A, null, board.states.A));
    await rows(`DELETE FROM courses`);
    const res = await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [course(3)] }));
    expect(await res.json()).toMatchObject({ ok: true, unchanged: true });
    expect(await rows(`SELECT id, version FROM courses`)).toEqual([{ id: 'roadmap-pr', version: 3 }]);
  });

  it('an oversized course file is that course’s refusal: the one in force stays and the board advances', async () => {
    await syncCall('/v1/sync/board', payload(A, null, board.states.A));
    const res = await syncCall('/v1/sync/board', payload(board.shas.B, A, board.states.B, { registry: [course(4, 4, { course: { pad: 'x'.repeat(65 * 1024) } })] }));
    expect(await res.json()).toMatchObject({ ok: true, courses_refused: ['roadmap-pr'] });
    expect(await head()).toBe(board.shas.B);
    expect(await rows(`SELECT version FROM courses`)).toEqual([{ version: 3 }]);
    expect(await rows(`SELECT version, json_extract(violations, '$[0].rule') AS rule FROM course_refusals`)).toEqual([{ version: 4, rule: 'bound' }]);
  });

  it('the registry is the whole registry: a course it no longer lists leaves, unless a ticket still names it', async () => {
    await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [course(3), extra] }));
    expect(await rows(`SELECT id FROM courses ORDER BY id`)).toEqual([{ id: 'roadmap-pr' }, { id: 'runbook' }]);
    await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [course(3), { ...extra, version: 2, course: { ...runbook, start_leg: 'nope' } }] }));
    expect(await rows(`SELECT course_id FROM course_refusals`)).toEqual([{ course_id: 'runbook' }]);
    await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [course(3)] }));
    expect(await rows(`SELECT id FROM courses`)).toEqual([{ id: 'roadmap-pr' }]);
    expect(await rows(`SELECT count(*) AS n FROM course_refusals`)).toEqual([{ n: 0 }]);
    // Every ticket is roadmap-pr's: a registry without it refuses the post and changes nothing.
    const res = await syncCall('/v1/sync/board', payload(A, null, board.states.A, { registry: [extra] }));
    expect([res.status, (await body(res)).code]).toEqual([400, 'invalid-params']);
    expect(await rows(`SELECT id FROM courses`)).toEqual([{ id: 'roadmap-pr' }]);
  });
});
