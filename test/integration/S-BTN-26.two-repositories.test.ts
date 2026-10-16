// S-BTN-26 two repositories, two courses (BATON_SPEC §2a R-BTN-47, R-BTN-48, §7.1, §10.3
// R-BTN-15, R-BTN-61, §6.3), the clauses R3-1231 delivers: a second repository `ops` with weight
// 50, its own course `runbook`, and tickets whose local ids docs also has. Must hold: `docs:T-1`
// and `ops:T-1` are distinct tickets; `ops`' sync token cannot post `docs`' board; head, cutover
// and events are each repository's own; every `docs` candidate ranks above every `ops` one; W1
// (roadmap-pr only) is never offered `ops`' tickets; a `runbook` change raising
// `min_worker_version` stops W2 there until it declares that version; a branch both `T-1`s map to
// is refused while either is held. The recommendation clauses — each repository in its own
// hook's or default order, the per-group limit with 60 ready docs legs — are R3-1232's.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { beat, captureDispatches, claimItem, claimRow, course, cutover, endClaim, ORIGIN, ownerCall, payload, recommended, register, rows, setClock, syncCall, syncToken, withCore, workerCall } from '../helpers';

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
/** ops' course (R-BTN-48): two legs, its own version line. */
const RUNBOOK_FILE = {
  start: 'filed', start_leg: 'prepare', end: ['done'],
  stations: { filed: { label: 'Filed' }, prepared: { label: 'Prepared' }, done: { label: 'Done' } },
  legs: { prepare: { from: ['filed'], to: 'prepared' }, run: { from: ['prepared'], to: 'done' } },
};
const runbook = (version = 1, min = version, branch_pattern = 'claude/{ticket}-*', previous_branch_pattern?: string) =>
  course(version, min, { id: 'runbook', skill: 'run-runbook', course: RUNBOOK_FILE, step_kinds: ['orient', 'other-step'], branch_pattern, ...(previous_branch_pattern ? { previous_branch_pattern } : {}) });
const opsBoard = {
  items: [{ ...fixture, title: 'ops: same local id', course: 'runbook' }, { ...fixture, id: 'T-1', title: 'ops: its own ticket', order: 20, course: 'runbook' }],
  ready: ['R3-9001', 'T-1'],
  registry: [runbook()],
};
/** W2 (R-BTN-48): declares both repositories' courses; the default worker, W1, docs' alone. */
const BOTH = { courses: [{ repository: 'docs', course: 'roadmap-pr', version: 3 }, { repository: 'ops', course: 'runbook', version: 1 }] };
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
    const { secret } = await register('vm-a', BOTH);
    const sent = await captureDispatches();
    expect((await owner('/v1/ui/cutover', { repository: 'ops', confirm: true })).status).toBe(200);
    const modeOf = async (repository: string) => (await (await workerCall(`/v1/runner/mode?repository=${repository}`, { secret })).json()) as { mode: string };
    expect([(await modeOf('docs')).mode, (await modeOf('ops')).mode]).toEqual(['shadow', 'cut-over']);
    expect((await workerCall('/v1/runner/mode?repository=nope', { secret })).status).toBe(400); // not registered
    // A docs ticket by name is not-cut-over; an open claim gets ops' first.
    expect((await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9001' })).json.code).toBe('not-cut-over');
    const c = await claimItem('vm-a', secret);
    expect(c.json).toMatchObject({ ticket_id: 'ops:R3-9001', snapshot_sha: OPS_SHA });
    expect(sent).toEqual(['ops:mirror', 'ops:sync']); // R-BTN-73: a claim dispatches the sync too
    const feed = (await (await opsCall('/v1/sync/events?after=0', undefined, 'baton-mirror.yml')).json()) as { events: { kind: string; ticket_id: string | null }[]; cutover_at: number };
    expect(feed.cutover_at).toBe(T0);
    expect(feed.events.map((e) => [e.kind, e.ticket_id])).toEqual(expect.arrayContaining([['claimed', 'ops:R3-9001']]));
    const docsFeed = (await (await syncCall('/v1/sync/events?after=0', undefined, await syncToken({ job_workflow_ref: 'immediately-run/docs/.github/workflows/baton-mirror.yml@refs/heads/main' }))).json()) as { events: { ticket_id: string | null }[]; cutover_at: number | null };
    expect(docsFeed.cutover_at).toBeNull();
    expect(docsFeed.events.filter((e) => e.ticket_id?.startsWith('ops:'))).toEqual([]);
  });

  it('R-BTN-61: every candidate of the heavier repository ranks above every one of the lighter', async () => {
    const { id } = await register('vm-a', BOTH);
    await cutover(1, 'docs');
    await cutover(1, 'ops');
    const candidates = () => recommended(id);
    const got = await candidates();
    const firstOps = got.findIndex((t) => t.startsWith('ops:'));
    expect(firstOps).toBeGreaterThan(0);
    expect(got.slice(firstOps).every((t) => t.startsWith('ops:'))).toBe(true);
    expect(got.slice(firstOps)).toEqual(['ops:R3-9001', 'ops:T-1']); // ops' own order within it
    await rows(`UPDATE repositories SET weight = 200 WHERE id = 'ops'`);
    expect((await candidates()).slice(0, 2)).toEqual(['ops:R3-9001', 'ops:T-1']);
  });

  it('one repository’s sync confirms no completion of another’s (R-BTN-47)', async () => {
    const { secret } = await register('vm-a', BOTH);
    await cutover(1, 'docs');
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9001' });
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.A });
    const confirm = { claim_id: c.claim_id, sha: OPS_SHA };
    expect((await opsCall('/v1/sync/board', payload(OPS_SHA, null, opsBoard, { confirmations: [confirm] }))).status).toBe(200);
    expect((await claimRow(c.claim_id)).confirmed_at).toBeNull();
    // ops' head lists none of docs' unconfirmed completions; docs' does, and docs' sync confirms it.
    expect(await (await opsCall('/v1/sync/head')).json()).toEqual({ sha: OPS_SHA, unconfirmed: [] });
    expect(((await (await syncCall('/v1/sync/head')).json()) as { unconfirmed: { claim_id: number }[] }).unconfirmed.map((u) => u.claim_id)).toEqual([c.claim_id]);
    await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A, { confirmations: [{ claim_id: c.claim_id, sha: sha.A }] }));
    expect((await claimRow(c.claim_id)).confirmed_at).toBe(T0);
  });

  it('a mirror reports foreign claims only on its own repository’s tickets', async () => {
    await cutover(1, 'ops');
    const report = (ticket_id: string) => opsCall('/v1/sync/foreign-claim', { ticket_id, nonce: 'abc123', sha: 'a'.repeat(40), at: T0 }, 'baton-mirror.yml');
    const refused = await report('docs:R3-9001');
    expect(refused.status).toBe(403);
    expect(await rows(`SELECT count(*) AS n FROM claims`)).toEqual([{ n: 0 }]);
    expect(await (await report('ops:R3-9001')).json()).toMatchObject({ imported: true });
    expect(await rows(`SELECT ticket_id FROM claims`)).toEqual([{ ticket_id: 'ops:R3-9001' }]);
  });

  it('only the fleet repository writes the instance’s fleet data (interim until part 2b)', async () => {
    const fleet = () => rows(`SELECT key, value FROM baton_settings WHERE key = 'reviewer_matrix'`);
    const before = await fleet();
    expect(before.length).toBe(1);
    const res = await opsCall('/v1/sync/board', payload('e'.repeat(40), OPS_SHA, opsBoard, { matrix: { ...(board.states.A.matrix as Record<string, unknown>), families: {} }, providers: board.states.A.providers }));
    expect(await res.json()).toMatchObject({ ok: true, fleet_ignored: true });
    expect(await fleet()).toEqual(before);
    // docs' own post still writes it, and says nothing was ignored.
    const docs = await (await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B, { matrix: { ...(board.states.A.matrix as Record<string, unknown>), families: {} } }))).json();
    expect(docs).not.toHaveProperty('fleet_ignored');
    expect(JSON.parse((await fleet())[0].value as string).families).toEqual({});
  });

  it('§6.8: a transcript pointer names one of its claim’s own repository’s transcript repositories', async () => {
    await rows(`UPDATE repositories SET transcript_repos = '["immediately-run/ops-sessions"]' WHERE id = 'ops'`);
    const { secret } = await register('vm-a', BOTH);
    await cutover(1, 'ops');
    await claimItem('vm-a', secret, { ticket_id: 'ops:R3-9001' });
    const res = await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'cc/a.jsonl' }, { repo: 'immediately-run/ops-sessions', path: 'cc/b.jsonl' }] });
    expect(res.json.transcripts_refused).toEqual([expect.objectContaining({ index: 0, code: 'invalid-params' })]);
    expect(await rows(`SELECT repo, path FROM transcripts`)).toEqual([{ repo: 'immediately-run/ops-sessions', path: 'cc/b.jsonl' }]);
  });

  it('a repository that names no transcript repositories keeps the defaults when another names its own', async () => {
    await rows(`UPDATE repositories SET transcript_repos = '["immediately-run/docs-sessions"]' WHERE id = 'docs'`);
    await rows(`UPDATE repositories SET transcript_repos = '[]' WHERE id = 'ops'`);
    const { secret } = await register('vm-a', BOTH);
    await cutover(1, 'ops');
    await claimItem('vm-a', secret, { ticket_id: 'ops:R3-9001' });
    const res = await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'cc/a.jsonl' }] });
    expect(res.json.transcripts_refused).toBeUndefined();
    expect(await rows(`SELECT repo FROM transcripts`)).toEqual([{ repo: 'immediately-run/claude-sessions' }]);
  });

  it('a pointer reported before the claim is linked only if the claim’s repository allows it', async () => {
    await rows(`UPDATE repositories SET transcript_repos = '["immediately-run/ops-sessions"]' WHERE id = 'ops'`);
    const { secret } = await register('vm-a', BOTH);
    await cutover(1, 'ops');
    await beat('vm-a', secret, { ...BOTH, transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'cc/a.jsonl' }, { repo: 'immediately-run/ops-sessions', path: 'cc/b.jsonl' }] });
    await claimItem('vm-a', secret, { ticket_id: 'ops:R3-9001' });
    expect(await rows(`SELECT repo FROM transcripts`)).toEqual([{ repo: 'immediately-run/ops-sessions' }]);
  });

  it('R-BTN-61: at equal weight the repositories interleave by their place in their own order', async () => {
    const { id } = await register('vm-a', BOTH);
    await cutover(1, 'docs');
    await cutover(1, 'ops');
    await rows(`UPDATE repositories SET weight = 100 WHERE id = 'ops'`);
    const got = await recommended(id);
    // Each repository's first candidate comes before either's second.
    expect(got.slice(0, 2).sort()).toEqual(['docs:R3-9001', 'ops:R3-9001']);
  });

  it('two in-progress tickets of one local id with no holder: both legacy claims stay adoptable', async () => {
    const inProgress = (board.states.B.state.items as Record<string, unknown>[]).find((it) => it.id === 'R3-9001')!;
    expect(inProgress.status).toBe('in-progress');
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B));
    await opsCall('/v1/sync/board', payload('e'.repeat(40), OPS_SHA, { items: [inProgress], ready: [] }));
    expect((await owner('/v1/ui/cutover', { repository: 'docs', confirm: true })).status).toBe(200);
    expect((await owner('/v1/ui/cutover', { repository: 'ops', confirm: true })).status).toBe(200);
    const names = await rows<{ ticket_id: string; session_name: string }>(`SELECT c.ticket_id, w.session_name FROM claims c JOIN workers w ON w.id = c.worker_id ORDER BY c.ticket_id`);
    expect(names.map((n) => n.ticket_id)).toEqual(['docs:R3-9001', 'ops:R3-9001']);
    expect(names[1].session_name).toMatch(/^item-R3-9001-[0-9a-f]{6}$/);
    const { secret } = await register('vm-a', BOTH);
    for (const t of ['docs:R3-9001', 'ops:R3-9001']) {
      expect((await workerCall('/v1/runner/adopt', { secret, body: { ticket_id: t } })).status).toBe(200);
    }
  });

  it('R-BTN-48: a worker gets only tickets of courses it declares; ops raising min_worker_version stops only ops’', async () => {
    await cutover(1, 'docs');
    await cutover(1, 'ops');
    const w1 = await register('vm-b'); // docs' roadmap-pr only
    const w2 = await register('vm-a', BOTH);
    const candidates = (id: number) => recommended(id);
    expect((await candidates(w1.id)).filter((t) => t.startsWith('ops:'))).toEqual([]);
    expect((await candidates(w2.id)).filter((t) => t.startsWith('ops:'))).toEqual(['ops:R3-9001', 'ops:T-1']);
    expect(await claimItem('vm-b', w1.secret, { ticket_id: 'ops:T-1' })).toMatchObject({ status: 409, json: { code: 'stale-skills', rule: 9 } });
    // With every docs ticket claimed, W1 is not told to restart for ops' course it never runs.
    await rows(`UPDATE ticket_next_legs SET state = 'waiting' WHERE ticket_id LIKE 'docs:%'`);
    expect(await claimItem('vm-b', w1.secret)).toMatchObject({ status: 404, json: { code: 'no-eligible-ticket' } });
    await rows(`UPDATE ticket_next_legs SET state = 'ready' WHERE ticket_id IN (SELECT id FROM tickets WHERE repository_id = 'docs' AND rank IS NOT NULL)`);
    // A runbook change older workers would misbehave under.
    await opsCall('/v1/sync/board', payload('e'.repeat(40), OPS_SHA, { ...opsBoard, registry: [runbook(2)] }));
    expect((await beat('vm-a', w2.secret, BOTH)).json.stale_courses).toEqual([{ repository: 'ops', course: 'runbook', version: 1, min_worker_version: 2 }]);
    expect((await candidates(w2.id)).filter((t) => t.startsWith('ops:'))).toEqual([]);
    expect((await candidates(w2.id)).some((t) => t.startsWith('docs:'))).toBe(true);
    await beat('vm-a', w2.secret, { courses: [BOTH.courses[0], { ...BOTH.courses[1], version: 2 }] });
    expect((await candidates(w2.id)).filter((t) => t.startsWith('ops:'))).toEqual(['ops:R3-9001', 'ops:T-1']);
  });

  it('R-BTN-69: ops’ failing course file keeps the previous one and is listed under Needs you', async () => {
    const loop = { ...RUNBOOK_FILE, legs: { ...RUNBOOK_FILE.legs, redo: { from: ['prepared'], to: 'filed' } } }; // a cycle with no max_runs
    const res = await opsCall('/v1/sync/board', payload('e'.repeat(40), OPS_SHA, { ...opsBoard, registry: [{ ...runbook(2, 1), course: loop }] }));
    expect(await res.json()).toMatchObject({ ok: true, courses_refused: ['runbook'] });
    expect(await rows(`SELECT id, version FROM courses WHERE repository_id = 'ops'`)).toEqual([{ id: 'runbook', version: 1 }]);
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { courses_refused: { repository_id: string; course_id: string; version: number; violations: { rule: string }[] }[] } };
    expect(state.needs_you.courses_refused).toEqual([expect.objectContaining({ repository_id: 'ops', course_id: 'runbook', version: 2 })]);
    expect(state.needs_you.courses_refused[0].violations.map((v) => v.rule)).toContain('unbounded-cycle');
    // A passing file clears it.
    await opsCall('/v1/sync/board', payload('f'.repeat(39) + 'e', 'e'.repeat(40), { ...opsBoard, registry: [runbook(3, 1)] }));
    expect(await rows(`SELECT version FROM courses WHERE repository_id = 'ops'`)).toEqual([{ version: 3 }]);
    expect(await rows(`SELECT count(*) AS n FROM course_refusals`)).toEqual([{ n: 0 }]);
  });

  it('R-BTN-69: a failing course file with none in force refuses the whole post; a ticket must name a registered course', async () => {
    const other = { id: 'other', github: 'immediately-run/other', default_branch: 'main', sync_workflow: '.github/workflows/baton-sync.yml' };
    await withCore((c) => {
      c.registry.register(other);
    });
    const token = await syncToken({ repository: 'immediately-run/other', job_workflow_ref: 'immediately-run/other/.github/workflows/baton-sync.yml@refs/heads/main' });
    const broken = { ...runbook(), course: { ...RUNBOOK_FILE, start_leg: 'nope' } };
    const refused = await syncCall('/v1/sync/board', payload(OPS_SHA, null, { ...opsBoard, registry: [broken] }), token);
    expect([refused.status, ((await refused.json()) as { code: string }).code]).toEqual([400, 'invalid-params']);
    expect(await rows(`SELECT count(*) AS n FROM tickets WHERE repository_id = 'other'`)).toEqual([{ n: 0 }]);
    const unnamed = await syncCall('/v1/sync/board', payload(OPS_SHA, null, { ...opsBoard, registry: [] }), token);
    expect(((await unnamed.json()) as { message: string }).message).toMatch(/course runbook is not in other's registry/);
    expect(await rows(`SELECT count(*) AS n FROM courses WHERE repository_id = 'other'`)).toEqual([{ n: 0 }]);
  });

  it('§6.3: a branch both repositories’ T-1 map to is refused while either is held by another worker', async () => {
    const code = { repos: ['immediately-run/sandbox'] }; // a code repository both tickets list
    const docsItems = [...(board.states.A.state.items as Record<string, unknown>[]), { ...fixture, id: 'T-1', title: 'docs: T-1', ...code }];
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, { ...board.states.A, state: { items: docsItems }, ready: [...board.states.A.ready, 'T-1'] }));
    await opsCall('/v1/sync/board', payload('e'.repeat(40), OPS_SHA, { ...opsBoard, items: opsBoard.items.map((i) => ((i as { id?: string }).id === 'T-1' ? { ...i, ...code } : i)) }));
    await cutover(1, 'ops');
    const w1 = await register('vm-b');
    const w2 = await register('vm-a', BOTH);
    const ask = async (branch: string, secret?: string, repo = 'immediately-run/sandbox') =>
      (await workerCall(`/v1/runner/branch-holder?repo=${encodeURIComponent(repo)}&branch=${encodeURIComponent(branch)}`, { cred: secret === w2.secret ? 'vm-a' : 'vm-b', secret })).json();
    expect(await ask('claude/T-1-fix')).toEqual({ tickets: ['docs:T-1', 'ops:T-1'], held_by_other: false, fence_pending: false });
    expect((await claimItem('vm-a', w2.secret, { ticket_id: 'ops:T-1' })).status).toBe(200);
    expect(await ask('claude/T-1-fix', w1.secret)).toMatchObject({ held_by_other: true });
    expect(await ask('claude/t-1-fix', w1.secret)).toMatchObject({ held_by_other: true }); // GitHub branch case
    expect(await ask('claude/T-1-fix#2', w1.secret)).toMatchObject({ held_by_other: true }); // any legal git name (1-A-1)
    // git's own spellings, as a pre-push hook has them (round 2, 2-A-0).
    expect(await ask('refs/heads/claude/T-1-fix', w1.secret, 'immediately-run/sandbox.git')).toMatchObject({ tickets: ['docs:T-1', 'ops:T-1'], held_by_other: true });
    expect(await ask('claude/T-1-fix', w2.secret)).toMatchObject({ held_by_other: false }); // its own claim
    // A branch no pattern maps, or a repository neither ticket lists, maps to nothing.
    expect(await ask('claude/T-1')).toMatchObject({ tickets: [] });
    expect(await ask('claude/T-1-fix', undefined, 'immediately-run/other')).toMatchObject({ tickets: [] });
    // docs' own repository is its tickets' home; ops' R3-9001 lists docs among its repos, so the
    // branch maps to both — the collision failing safe.
    expect(await ask('claude/R3-9001-x', undefined, 'immediately-run/docs')).toMatchObject({ tickets: ['docs:R3-9001', 'ops:R3-9001'] });
    for (const bad of ['repo=x&branch=claude/T-1-x', 'repo=immediately-run/sandbox&branch=a..b']) {
      expect((await workerCall(`/v1/runner/branch-holder?${bad}`, { cred: 'vm-b' })).status).toBe(400);
    }
  });

  it('§6.3: a course’s previous pattern still maps its branches, and a reaped claim’s fence is reported (round 3, 3-A-0)', async () => {
    // ops renames its branches; live ones keep the previous pattern (R-BTN-51).
    const renamed = { ...opsBoard, registry: [runbook(1, 1, 'work/{ticket}', 'claude/{ticket}-*')] };
    await opsCall('/v1/sync/board', payload('e'.repeat(40), OPS_SHA, renamed));
    await cutover(1, 'ops');
    const w2 = await register('vm-a', BOTH);
    const ask = async (branch: string) =>
      (await workerCall(`/v1/runner/branch-holder?repo=immediately-run/ops&branch=${encodeURIComponent(branch)}`, { cred: 'vm-b' })).json();
    expect(await ask('work/T-1')).toMatchObject({ tickets: ['ops:T-1'] });
    expect(await ask('claude/T-1-x')).toMatchObject({ tickets: ['ops:T-1'] }); // the previous pattern
    const { json: c } = await claimItem('vm-a', w2.secret, { ticket_id: 'ops:T-1' });
    expect(await ask('claude/T-1-x')).toMatchObject({ held_by_other: true, fence_pending: false });
    // The owner reaps the live holder: its claim is fence-pending until its sidecar confirms.
    expect(await (await owner(`/v1/ui/claims/${c.claim_id}/reap`, { confirm: true })).json()).toMatchObject({ fence_pending: true });
    expect(await ask('claude/T-1-x')).toEqual({ tickets: ['ops:T-1'], held_by_other: false, fence_pending: true });
  });

  it('R-BTN-61 (R3-1232): each repository in its own default order, and with 60 ready docs legs ops’ candidates still reach the merge (per-group limit)', async () => {
    const { id } = await register('vm-a', BOTH);
    await cutover(1, 'docs');
    await cutover(1, 'ops');
    // 60 ready docs tickets, ranked in reverse of their ids, so the order is the rank's alone.
    const items = Array.from({ length: 60 }, (_, i) => ({ ...fixture, id: `D-${String(i + 1).padStart(2, '0')}`, title: `docs ${i + 1}` }));
    const ready = items.map((it) => it.id).reverse();
    expect((await syncCall('/v1/sync/board', payload(sha.B, sha.A, { items, ready }))).status).toBe(200);
    const got = await recommended(id, 100);
    // docs (weight 100) above ops (50): all 60, in docs' rank order — 50 read, then a second page
    // because the group was full — and ops' own two after them, never crowded out of the merge.
    expect(got.slice(0, 60)).toEqual(ready.map((t) => `docs:${t}`));
    expect(got.slice(60)).toEqual(['ops:R3-9001', 'ops:T-1']);
    // ?limit= applies after the merge.
    expect(await recommended(id, 5)).toEqual(ready.slice(0, 5).map((t) => `docs:${t}`));
  });
});
