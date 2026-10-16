// R3-1211 — workers (BATON_SPEC §5, §6.8, §6.9, §9, §10.1–10.4, §11): G-BTN-5, -13, -17, -23,
// -24, messages, mode and shadow reports.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { WorkerApi } from '../../src/core/workerApi';
import { beat, call, hbBody, ORIGIN, ownerCall, payload, register, rows, seedClaim, setClock, sha256, syncCall, workerCall , tick, withCore } from '../helpers';

const board = inject('board');
const T0 = Date.parse('2026-10-13T12:00:00Z');
const code = async (res: Response) => ((await res.json()) as { code: string }).code;
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });

beforeEach(async () => {
  await setClock(T0);
  // Reference data: the fixture board's providers (zai, opencode_go_plus) and catalog.
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
});

describe('G-BTN-5: identity — the secret, the hostname and the capability allow-list', () => {
  it('a first heartbeat registers; later calls need the secret; a wrong one is session-taken', async () => {
    const { id, secret, first } = await register('vm-a');
    expect(first).toMatchObject({ worker_id: id, incarnation: 1, lease_timeout_s: 900, claim: null, messages: [], mode: { docs: 'shadow' }, stale_courses: [] });
    expect((await beat('vm-a', secret)).status).toBe(200);
    const wrong = await beat('vm-a', 'not-the-secret');
    expect(wrong.status).toBe(409);
    expect(wrong.json.code).toBe('session-taken');
    // The server stores only the hash.
    const [w] = await rows<{ secret_hash: string }>('SELECT secret_hash FROM workers WHERE id = ?', id);
    expect(w.secret_hash).toBe(await sha256(secret));
    expect(JSON.stringify(first)).not.toContain(secret);
  });

  it('refuses another hostname, a capability outside the allow-list, an unknown token and a revoked credential', async () => {
    const other = await workerCall('/v1/runner/heartbeat', { cred: 'vm-a', body: hbBody('vm-a', { hostname: 'vm-b', secret_hash: await sha256('x') }) });
    expect([other.status, await code(other)]).toEqual([403, 'forbidden']);
    const op = await workerCall('/v1/runner/heartbeat', { cred: 'vm-a', body: hbBody('vm-a', { capabilities: ['human-operator'], secret_hash: await sha256('x') }) });
    expect([op.status, await code(op)]).toEqual([403, 'forbidden']);
    // The owner's Mac credential may declare human-operator.
    expect((await workerCall('/v1/runner/heartbeat', { cred: 'mac', body: hbBody('mac', { capabilities: ['human-operator'], secret_hash: await sha256('y') }) })).status).toBe(200);
    const unknown = await call401('tok-nobody');
    expect(unknown).toBe(401);
  });

  it('R-BTN-32: test_harness is refused from every credential but the test one', async () => {
    const vm = await workerCall('/v1/runner/heartbeat', { cred: 'vm-a', body: hbBody('vm-a', { test_harness: true, secret_hash: await sha256('x') }) });
    expect([vm.status, await code(vm)]).toEqual([403, 'forbidden']);
    expect((await workerCall('/v1/runner/heartbeat', { cred: 'test', body: hbBody('test', { test_harness: true, secret_hash: await sha256('z') }) })).status).toBe(200);
  });

  it('stores capabilities expanded with what was declared, clamps the lease, and fails closed on unknown accounts', async () => {
    const { id } = await register('vm-a', { capabilities: ['agent-venue', 'mcp-chrome'], lease_timeout_s: 60, billing: { 'zai-coding-plan': 'zai', anthropic: 'anthropic' }, model_provider_id: 'nope' });
    expect(await rows('SELECT capability, declared FROM worker_capabilities WHERE worker_id = ? ORDER BY capability', id)).toEqual([
      { capability: 'authentication', declared: 'agent-venue' }, { capability: 'create-pr', declared: 'agent-venue' },
      { capability: 'drivable-browser', declared: 'agent-venue' }, { capability: 'llm-call', declared: 'agent-venue' },
      { capability: 'mcp-chrome', declared: 'mcp-chrome' }]);
    // anthropic is not an account the reference data knows: left out, so it counts as suspended (§7.4).
    expect(await rows('SELECT prefix, provider_id FROM worker_providers WHERE worker_id = ?', id)).toEqual([{ prefix: 'zai-coding-plan', provider_id: 'zai' }]);
    expect(await rows('SELECT lease_timeout_ms, model_provider_id FROM workers WHERE id = ?', id)).toEqual([{ lease_timeout_ms: 900_000, model_provider_id: null }]);
    const { first } = await register('vm-b', { lease_timeout_s: 999_999 });
    expect(first.lease_timeout_s).toBe(86400);
  });

  it('§3 write budget: capability and provider rows are rewritten only when the settings change', async () => {
    const { id, secret } = await register('vm-a');
    const before = await rows('SELECT rowid, capability FROM worker_capabilities WHERE worker_id = ? ORDER BY rowid', id);
    await beat('vm-a', secret);
    expect(await rows('SELECT rowid, capability FROM worker_capabilities WHERE worker_id = ? ORDER BY rowid', id)).toEqual(before);
    await beat('vm-a', secret, { capabilities: ['mcp-chrome'] });
    expect(await rows('SELECT capability FROM worker_capabilities WHERE worker_id = ?', id)).toEqual([{ capability: 'mcp-chrome' }]);
  });
});

async function call401(token: string) {
  const res = await (await import('../helpers')).call('/v1/runner/heartbeat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  return res.status;
}

describe('G-BTN-17: a retried first heartbeat, and re-keys', () => {
  it('a retried first heartbeat with the same hash is the same worker', async () => {
    const hash = await sha256('retry-secret');
    const a = await (await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: hash }) })).json() as { worker_id: number };
    const b = await (await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: hash }) })).json() as { worker_id: number };
    expect(b.worker_id).toBe(a.worker_id);
    expect(await rows('SELECT count(*) AS n FROM workers')).toEqual([{ n: 1 }]);
  });

  it('re-keys without a claim; refuses while holding one; a reaped worker must re-key', async () => {
    const { id, secret } = await register('vm-a');
    await seedClaim(id, 'docs:R3-9001');
    const refused = await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { rekey: true, secret_hash: await sha256('new') }) });
    expect([refused.status, await code(refused)]).toEqual([409, 'session-taken']);
    await rows(`UPDATE claims SET status = 'released', ended_at = 1, end_reason = 'released:requested'`);
    const ok = await (await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { rekey: true, secret_hash: await sha256('new') }) })).json() as { incarnation: number };
    expect(ok.incarnation).toBe(2);
    expect((await workerCall('/v1/runner/activities', { secret, body: { activities: [] } })).status).toBe(401); // the old secret is gone
    expect(await rows(`SELECT kind FROM events WHERE kind = 'rekeyed'`)).toHaveLength(1);
    // Reaped (R3-1212 sets this): every call is worker-reaped until a re-key.
    await rows('UPDATE workers SET reaped_at = 5 WHERE id = ?', id);
    expect((await beat('vm-a', 'new')).json.code).toBe('worker-reaped');
    const back = await (await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { rekey: true, secret_hash: await sha256('newer') }) })).json() as { incarnation: number };
    expect(back.incarnation).toBe(3);
    expect(await rows('SELECT reaped_at FROM workers WHERE id = ?', id)).toEqual([{ reaped_at: null }]);
  });
});

describe('G-BTN-13: free text and identifiers are validated before any write', () => {
  it.each([
    ['a session name with a space', { session_name: 'my session' }],
    ['a label with markup', { transcripts: [], session_name: 's-1' }],
  ])('refuses %s', async (what, over) => {
    if (what.startsWith('a label')) {
      const { secret } = await register('vm-a');
      const res = await workerCall('/v1/runner/activities', { secret, body: { activities: [{ id: 'a1', kind: 'orient', source: 'skill', started_at: T0, label: '<script>' }] } });
      expect(((await res.json()) as { refused: { code: string }[] }).refused[0].code).toBe('invalid-params');
      return;
    }
    const res = await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: await sha256('x'), ...over }) });
    expect([res.status, await code(res)]).toEqual([400, 'invalid-params']);
    expect(await rows('SELECT count(*) AS n FROM workers')).toEqual([{ n: 0 }]);
  });

  it('an activity detail takes only its kind’s keys, a PR URL of the ticket’s repositories, and 2 KB at most', async () => {
    const { id, secret } = await register('vm-a');
    const claim = await seedClaim(id, 'docs:R3-9001');
    const post = (detail: unknown) => workerCall('/v1/runner/activities', { secret, body: { activities: [{ id: `d${Math.random()}`, claim_id: claim, kind: 'open-pr', source: 'hook', started_at: T0, detail }] } });
    const refusedOf = async (res: Response) => ((await res.json()) as { refused: unknown[] }).refused.length;
    expect(await refusedOf(await post({ pr: 'https://github.com/immediately-run/docs/pull/4' }))).toBe(0);
    expect(await refusedOf(await post({ pr: 'https://evil.example/pull/4' }))).toBe(1);
    // R-BTN-92's link rule (R3-1262): only the ticket's home or its repos:, whole segments, its forge's PR path.
    for (const pr of ['https://github.com/immediately-run/docs-evil/pull/4', 'https://github.com/immediately-run/docs/pulls/4',
      'https://github.com:8443/immediately-run/docs/pull/4', 'https://x@github.com/immediately-run/docs/pull/4', 'https://github.com/immediately-run/docs/pull/4/../../x/pull/4']) {
      expect([pr, await refusedOf(await post({ pr }))]).toEqual([pr, 1]);
    }
    expect(await refusedOf(await post({ secret: 'x' }))).toBe(1);
    // A ticket's repos — owner/name or docs' short names under the home's owner (round 1, 1-A-8); the claim above,
    // whose ticket the board does not carry, took any registered repository's.
    await rows(`INSERT INTO tickets (id, repository_id, local_id, path, title, status, node, queue, tags, requires_clause, depends_on, blocked_by, repos, snapshot_sha, row_hash)
                VALUES ('docs:R3-9777', 'docs', 'R3-9777', 'p', 't', 'in-progress', 'ready', 'ready-autonomous', '[]', 'listed', '[]', '[]', '["baton","immediately-run/sandbox"]', 'a', 'h')`);
    await rows(`UPDATE claims SET status = 'released', ended_at = 1 WHERE id = ?`, claim); // one active claim per worker
    const withRepos = await seedClaim(id, 'docs:R3-9777', 1);
    const postOn = (claimId: number | null, pr: string) => workerCall('/v1/runner/activities', { secret, body: { activities: [{ id: `e${Math.random()}`, claim_id: claimId, kind: 'open-pr', source: 'hook', started_at: T0, detail: { pr } }] } });
    expect(await refusedOf(await postOn(withRepos, 'https://github.com/immediately-run/baton/pull/1'))).toBe(0);
    expect(await refusedOf(await postOn(withRepos, 'https://github.com/immediately-run/sandbox/pull/2'))).toBe(0);
    expect(await refusedOf(await postOn(withRepos, 'https://github.com/someone/baton/pull/3'))).toBe(1);
    expect(await refusedOf(await post({ note: 'x'.repeat(2100) }))).toBe(1);
  });
});

describe('G-BTN-23: transcript pointers', () => {
  it('takes only allow-listed repos and safe paths; links under a claim, waits without one; the dashboard builds the link', async () => {
    const { id, secret } = await register('vm-a');
    const t = (repo: string, path: string) => ({ transcripts: [{ repo, path }] });
    expect((await beat('vm-a', secret, t('immediately-run/claude-sessions', 'claude-code/2026-10-13-s.jsonl'))).status).toBe(200);
    expect(await rows('SELECT repo, path FROM pending_transcripts WHERE worker_id = ?', id)).toEqual([{ repo: 'immediately-run/claude-sessions', path: 'claude-code/2026-10-13-s.jsonl' }]);
    // A bad pointer is refused on its own; the heartbeat still counts (last_seen_at moves).
    for (const [i, bad] of [t('evil/repo', 'x.md'), t('immediately-run/claude-sessions', '../etc/passwd'), t('immediately-run/claude-sessions', 'a//b')].entries()) {
      await setClock(T0 + (i + 1) * 1000);
      const res = await beat('vm-a', secret, bad);
      expect([res.status, res.json.transcripts_refused?.[0]]).toEqual([200, expect.objectContaining({ index: 0, code: 'invalid-params' })]);
      expect(await rows('SELECT last_seen_at FROM workers WHERE id = ?', id)).toEqual([{ last_seen_at: T0 + (i + 1) * 1000 }]);
    }
    expect(await rows('SELECT count(*) AS n FROM pending_transcripts WHERE worker_id = ?', id)).toEqual([{ n: 1 }]);
    // An activity not received yet defers the link: the pointer is stored and linked later.
    const early = await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'sub/r.jsonl', role: 'subagent', activity_id: 'not-yet' }] });
    expect([early.json.transcripts_refused, early.json.transcripts_unlinked]).toEqual([undefined, [0]]);
    expect(await rows(`SELECT activity_id FROM pending_transcripts WHERE path = 'sub/r.jsonl'`)).toEqual([{ activity_id: null }]);
    // Once the activity arrives, the next report of the pointer links it.
    const act = await workerCall('/v1/runner/activities', { secret, body: { activities: [{ id: 'not-yet', kind: 'orient', source: 'hook', started_at: T0 }] } });
    expect(((await act.json()) as { refused: unknown[] }).refused).toEqual([]);
    const later = await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'sub/r.jsonl', role: 'subagent', activity_id: 'not-yet' }] });
    expect(later.json.transcripts_unlinked).toBeUndefined();
    expect(await rows(`SELECT activity_id FROM pending_transcripts WHERE path = 'sub/r.jsonl'`)).toEqual([{ activity_id: 'not-yet' }]);
    const claim = await seedClaim(id, 'docs:R3-9001');
    await beat('vm-a', secret, t('immediately-run-worker/session-transcripts', 'vm-a/s.md'));
    expect(await rows('SELECT claim_id, path FROM transcripts WHERE worker_id = ?', id)).toEqual([{ claim_id: claim, path: 'vm-a/s.md' }]);
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { workers: { id: number; transcript_url: string }[] };
    expect(state.workers.find((w) => w.id === id)!.transcript_url).toMatch(/^https:\/\/github\.com\/immediately-run(-worker)?\/[a-z-]+\/blob\/HEAD\//);
  });
});

describe('G-BTN-24: activities', () => {
  it('upserts by (worker, id), refuses another worker’s claim, parents a reviewer, and records a substitution', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const claimA = await seedClaim(a.id, 'docs:R3-9001');
    const post = (secret: string, activities: unknown[]) => workerCall('/v1/runner/activities', { cred: secret === a.secret ? 'vm-a' : 'vm-b', secret, body: { activities } }).then((r) => r.json() as Promise<{ refused: { id: string; code: string }[] }>);
    expect((await post(a.secret, [{ id: 'orient-1', claim_id: null, kind: 'orient', source: 'skill', started_at: T0 }])).refused).toEqual([]);
    expect((await post(a.secret, [{ id: 'x', claim_id: null, kind: 'implement', source: 'skill', started_at: T0 }])).refused[0].code).toBe('invalid-params');
    expect((await post(a.secret, [{ id: 'round', claim_id: claimA, kind: 'review-round', seq: 1, source: 'skill', started_at: T0 }])).refused).toEqual([]);
    expect((await post(a.secret, [{ id: 'rev', claim_id: claimA, kind: 'reviewer', source: 'hook', started_at: T0 + 1, label: 'review-pr-glm', detail: { agent: 'review-pr-glm', substituted_for: 'review-pr-deepseek' } }])).refused).toEqual([]);
    expect(await rows(`SELECT parent_id FROM activities WHERE id = 'rev'`)).toEqual([{ parent_id: 'round' }]);
    expect(await rows(`SELECT ticket_id, json_extract(detail_json, '$.substituted_for') AS f FROM events WHERE kind = 'reviewer-substituted'`)).toEqual([{ ticket_id: 'docs:R3-9001', f: 'review-pr-deepseek' }]);
    // A retry is an upsert; closing it sets the outcome.
    expect((await post(a.secret, [{ id: 'round', claim_id: claimA, kind: 'review-round', seq: 1, source: 'skill', started_at: T0, ended_at: T0 + 9, outcome: 'succeeded' }])).refused).toEqual([]);
    expect(await rows(`SELECT count(*) AS n, max(outcome) AS o FROM activities WHERE id = 'round'`)).toEqual([{ n: 1, o: 'succeeded' }]);
    // Worker B can neither report under A's claim nor touch A's row: its 'round' is its own.
    expect((await post(b.secret, [{ id: 'round', claim_id: claimA, kind: 'review-round', source: 'skill', started_at: T0 }])).refused[0].code).toBe('not-holder');
    expect(await rows(`SELECT worker_id FROM activities WHERE id = 'round'`)).toEqual([{ worker_id: a.id }]);
  });

  it('after a claim ends, only closing updates are accepted, and only for 10 minutes', async () => {
    const { id, secret } = await register('vm-a');
    const claim = await seedClaim(id, 'docs:R3-9001');
    const post = (activities: unknown[]) => workerCall('/v1/runner/activities', { secret, body: { activities } }).then((r) => r.json() as Promise<{ refused: { code: string }[] }>);
    await post([{ id: 'push-1', claim_id: claim, kind: 'push', source: 'hook', started_at: T0 }, { id: 'push-2', claim_id: claim, kind: 'push', source: 'hook', started_at: T0 }]);
    await rows(`UPDATE claims SET status = 'released', ended_at = ?, end_reason = 'released:requested'`, T0);
    await setClock(T0 + 5 * 60_000);
    expect((await post([{ id: 'push-1', claim_id: claim, kind: 'push', source: 'hook', started_at: T0, ended_at: T0 + 1, outcome: 'succeeded' }])).refused).toEqual([]);
    expect((await post([{ id: 'new', claim_id: claim, kind: 'push', source: 'hook', started_at: T0 }])).refused[0].code).toBe('claim-ended');
    await setClock(T0 + 11 * 60_000);
    expect((await post([{ id: 'push-2', claim_id: claim, kind: 'push', source: 'hook', started_at: T0, ended_at: T0 + 1, outcome: 'succeeded' }])).refused[0].code).toBe('claim-ended');
  });
});

describe('messages (§9)', () => {
  it('a status request is delivered in the heartbeat, re-sent until acknowledged, and its reply is stored', async () => {
    const { id, secret } = await register('vm-a');
    const sent = (await (await owner('/v1/ui/messages', { to_worker_id: id, kind: 'status_request' })).json()) as { id: number };
    const first = await beat('vm-a', secret);
    expect(first.json.messages).toEqual([{ id: sent.id, kind: 'status_request', payload: null, sent_at: T0 }]);
    expect((await beat('vm-a', secret)).json.messages).toHaveLength(1); // not acknowledged yet
    expect((await workerCall(`/v1/runner/messages/${sent.id}/ack`, { secret, body: { reply: { text: 'implementing' } } })).status).toBe(200);
    expect((await beat('vm-a', secret)).json.messages).toEqual([]);
    expect(await rows(`SELECT from_worker_id, json_extract(payload_json, '$.text') AS text FROM messages WHERE kind = 'status_report'`)).toEqual([{ from_worker_id: id, text: 'implementing' }]);
  });

  it('a release names an item and a §6.5 reason; anything else is refused', async () => {
    const { id } = await register('vm-a');
    const bad = await owner('/v1/ui/messages', { to_worker_id: id, kind: 'release', payload: { ticket_id: 'docs:R3-9001', reason: 'because' } });
    expect([bad.status, await code(bad)]).toEqual([400, 'invalid-params']);
    expect((await owner('/v1/ui/messages', { to_worker_id: id, kind: 'release', payload: { ticket_id: 'docs:R3-9001', reason: 'owner-cancel' } })).status).toBe(200);
  });

  it('the alarm expires a reaped worker’s open messages', async () => {
    const { id } = await register('vm-a');
    await owner('/v1/ui/messages', { to_worker_id: id, kind: 'status_request' });
    await rows('UPDATE workers SET reaped_at = 1 WHERE id = ?', id);
    await tick();
    expect(await rows('SELECT status FROM messages')).toEqual([{ status: 'expired' }]);
  });
});

describe('mode and shadow reports (R-BTN-28, §13 step 2)', () => {
  it('reports shadow until cutover, then cut-over', async () => {
    const { secret } = await register('vm-a');
    expect(await (await workerCall('/v1/runner/mode?repository=docs', { secret })).json()).toEqual({ mode: 'shadow' });
    await rows(`UPDATE repositories SET cutover_at = 123 WHERE id = 'docs'`);
    expect(await (await workerCall('/v1/runner/mode?repository=docs', { secret })).json()).toEqual({ mode: 'cut-over', cutover_at: 123 });
  });

  it('records git claims as claim rows; a second holder is a shadow-conflict, never a second claim', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const report = (cred: 'vm-a' | 'vm-b', secret: string, body: unknown) => workerCall('/v1/runner/shadow-report', { cred, secret, body }).then((r) => r.json() as Promise<Record<string, unknown>>);
    expect(await report('vm-a', a.secret, { transition: 'claim', ticket_id: 'docs:R3-9001', status: 'in-progress', nonce: 'aaaaaa', at: T0 })).toMatchObject({ ok: true });
    expect(await report('vm-b', b.secret, { transition: 'claim', ticket_id: 'docs:R3-9001', status: 'in-progress', nonce: 'bbbbbb', at: T0 })).toMatchObject({ ok: true, conflict: `held-by-worker:${a.id}` });
    expect(await rows(`SELECT count(*) AS n FROM claims WHERE status = 'active'`)).toEqual([{ n: 1 }]);
    expect(await rows(`SELECT count(*) AS n FROM events WHERE kind = 'shadow-conflict'`)).toEqual([{ n: 1 }]);
    // A retried claim report (same nonce) is the same claim, not a conflict.
    expect(await report('vm-a', a.secret, { transition: 'claim', ticket_id: 'docs:R3-9001', status: 'in-progress', nonce: 'aaaaaa', at: T0 })).toEqual({ ok: true, claim_id: expect.any(Number) });
    expect(await rows(`SELECT count(*) AS n FROM events WHERE kind = 'shadow-conflict'`)).toEqual([{ n: 1 }]);
    // §6.5: in-review is an activity of the active claim; the claim lasts through the gate.
    expect(await report('vm-a', a.secret, { transition: 'set', ticket_id: 'docs:R3-9001', status: 'in-review', at: T0 + 5 })).toMatchObject({ ok: true });
    expect(await rows(`SELECT status FROM claims`)).toEqual([{ status: 'active' }]);
    const claimId = (await rows<{ id: number }>('SELECT id FROM claims'))[0].id;
    await setClock(T0 + 11 * 60_000);
    const round = await workerCall('/v1/runner/activities', { cred: 'vm-a', secret: a.secret, body: { activities: [{ id: 'r1', claim_id: claimId, kind: 'review-round', source: 'skill', started_at: T0 + 10 }] } });
    expect(((await round.json()) as { refused: unknown[] }).refused).toEqual([]);
    expect(await report('vm-a', a.secret, { transition: 'set', ticket_id: 'docs:R3-9001', status: 'done', at: T0 + 9 })).toMatchObject({ ok: true });
    expect(await rows(`SELECT status, end_reason FROM claims`)).toEqual([{ status: 'released', end_reason: 'shadow:done' }]);
  });
});

describe('round-one review fixes (baton#4)', () => {
  it('R-BTN-14: once the secret has been presented, the body hash no longer authenticates', async () => {
    const hash = await sha256('s1');
    expect((await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: hash }) })).status).toBe(200);
    expect((await beat('vm-a', 's1')).status).toBe(200);
    const replay = await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: hash }) });
    expect([replay.status, await code(replay)]).toEqual([409, 'session-taken']);
  });

  it('R-BTN-14: a re-key with the same hash cannot bring a reaped worker back; a retried re-key is idempotent', async () => {
    const { id } = await register('vm-a');
    const rekey = (s: string) => workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { rekey: true, secret_hash: s }) });
    const h2 = await sha256('two');
    expect((await rekey(h2)).status).toBe(200);
    expect((await rekey(h2)).status).toBe(200); // a lost response, retried
    expect(await rows('SELECT incarnation FROM workers WHERE id = ?', id)).toEqual([{ incarnation: 2 }]);
    await rows('UPDATE workers SET reaped_at = 5 WHERE id = ?', id);
    const same = await rekey(h2);
    expect([same.status, await code(same)]).toEqual([400, 'invalid-params']);
    expect(await rows('SELECT reaped_at, incarnation FROM workers WHERE id = ?', id)).toEqual([{ reaped_at: 5, incarnation: 2 }]);
    // Once the new secret has been presented, repeating its hash as a re-key is no bearer token.
    await rows('UPDATE workers SET reaped_at = NULL WHERE id = ?', id);
    expect((await beat('vm-a', 'two')).status).toBe(200);
    const replay = await rekey(h2);
    expect([replay.status, await code(replay)]).toEqual([409, 'session-taken']);
  });

  it('§3: credentials are mirrored once per change of the secrets, not on every call; a dropped hash or policy revokes', async () => {
    const { secret } = await register('vm-a');
    expect(await rows(`SELECT id FROM credentials WHERE revoked_at IS NOT NULL`)).toEqual([{ id: 'gone' }]);
    // Tamper with the mirror: an unchanged secret is not re-mirrored, so the tampered row stands.
    await rows(`UPDATE credentials SET hostname = 'elsewhere' WHERE id = 'vm-a'`);
    expect((await beat('vm-a', secret)).json.code).toBe('forbidden');
    // A changed secret is mirrored: the hash removed revokes vm-a.
    await withCore((o) => {
      const hashes = JSON.parse(env.TOKEN_HASHES!);
      delete hashes['vm-a'];
      const api = new WorkerApi({ store: o.store, config: { ...env, TOKEN_HASHES: JSON.stringify(hashes) }, now: () => o.now() });
      expect(() => api.credential('vm-a')).toThrow(/revoked/);
      expect(() => api.credential('vm-b')).not.toThrow();
    });
    expect(await rows(`SELECT hostname, revoked_at IS NOT NULL AS revoked FROM credentials WHERE id = 'vm-a'`)).toEqual([{ hostname: 'vm-a', revoked: 1 }]);
  });

  it('§7.4: a billed account the reference data learns later is written on the next heartbeat', async () => {
    const { id, secret } = await register('vm-a', { billing: { 'zai-coding-plan': 'zai', newco: 'newco' } });
    expect(await rows('SELECT prefix FROM worker_providers WHERE worker_id = ? ORDER BY prefix', id)).toEqual([{ prefix: 'zai-coding-plan' }]);
    await rows(`INSERT INTO model_providers (id, name, billing) VALUES ('newco', 'NewCo', 'subscription')`);
    await beat('vm-a', secret, { billing: { 'zai-coding-plan': 'zai', newco: 'newco' } });
    expect(await rows('SELECT prefix FROM worker_providers WHERE worker_id = ? ORDER BY prefix', id)).toEqual([{ prefix: 'newco' }, { prefix: 'zai-coding-plan' }]);
  });

  it('§7.3: usage replaces the hour’s row, unknown accounts are skipped, rate limits are logged', async () => {
    const { id, secret } = await register('vm-a');
    const hour = T0 - (T0 % 3_600_000);
    await beat('vm-a', secret, { usage: [{ provider_id: 'zai', model_id: 'glm-5.3', hour, usd_list: 1.5 }, { provider_id: 'nope', model_id: 'm', hour, usd_list: 9 }], rate_limits: [{ provider_id: 'zai', resets_at: T0 + 60_000 }] });
    await beat('vm-a', secret, { usage: [{ provider_id: 'zai', model_id: 'glm-5.3', hour, usd_list: 2.25 }] });
    expect(await rows('SELECT provider_id, usd_list FROM usage_reports WHERE worker_id = ?', id)).toEqual([{ provider_id: 'zai', usd_list: 2.25 }]);
    expect(await rows('SELECT provider_id, resets_at FROM rate_limit_events WHERE worker_id = ?', id)).toEqual([{ provider_id: 'zai', resets_at: T0 + 60_000 }]);
  });

  it('§7.2 rule 6: a declared human-operator gets its own capability row', async () => {
    const { id } = await register('mac', { capabilities: ['human-operator'] });
    // The role expands to its capabilities (ROLES), and rule 6's own row names the role itself.
    expect(await rows(`SELECT capability FROM worker_capabilities WHERE worker_id = ? AND declared = 'human-operator' ORDER BY capability`, id))
      .toEqual(['authentication', 'create-pr', 'drivable-browser', 'human-operator', 'llm-call'].map((capability) => ({ capability })));
  });

  it('§6.8: the synced transcript_repos replaces the default allow-list', async () => {
    const { secret } = await register('vm-a');
    await syncCall('/v1/sync/board', payload(board.shas.B, board.shas.A, board.states.B, { transcript_repos: ['immediately-run/other-transcripts'] }));
    expect((await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/other-transcripts', path: 'a.md' }] })).json.transcripts_refused).toBeUndefined();
    expect((await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'a.md' }] })).json.transcripts_refused).toHaveLength(1);
  });

  it('§9: an ack reply is validated before the write; a malformed body acknowledges nothing; no body is a plain ack', async () => {
    const { id, secret } = await register('vm-a');
    const send = async () => ((await (await owner('/v1/ui/messages', { to_worker_id: id, kind: 'status_request' })).json()) as { id: number }).id;
    const m1 = await send();
    for (const body of [{ reply: { text: '' } }, { reply: { text: '<b>' } }, { reply: { text: 'x'.repeat(501) } }]) {
      const res = await workerCall(`/v1/runner/messages/${m1}/ack`, { secret, body });
      expect([res.status, await code(res)]).toEqual([400, 'invalid-params']);
    }
    const raw = await call(`/v1/runner/messages/${m1}/ack`, { method: 'POST', headers: { Authorization: 'Bearer tok-vm-a', 'X-Worker-Secret': secret, 'Content-Type': 'application/json' }, body: '{not json' });
    expect(raw.status).toBe(400);
    expect(await rows('SELECT status FROM messages WHERE id = ?', m1)).toEqual([{ status: 'pending' }]);
    expect((await workerCall(`/v1/runner/messages/${m1}/ack`, { secret, method: 'POST' })).status).toBe(200);
    expect(await rows('SELECT status FROM messages WHERE id = ?', m1)).toEqual([{ status: 'acknowledged' }]);
  });

  it('§7.4: a window already over is refused; a lifted timed suspension never logs an end', async () => {
    const past = await owner('/v1/ui/suspensions', { provider_id: 'zai', mode: 'stop', starts_at: T0 - 3 * 3_600_000, ends_at: T0 - 3_600_000 });
    expect([past.status, await code(past)]).toEqual([400, 'invalid-params']);
    const { id } = (await (await owner('/v1/ui/suspensions', { provider_id: 'zai', mode: 'no-new-work', ends_at: T0 + 3_600_000 })).json()) as { id: number };
    await owner(`/v1/ui/suspensions/${id}/lift`, {});
    await setClock(T0 + 2 * 3_600_000);
    await tick();
    expect((await rows<{ a: string }>(`SELECT json_extract(detail_json, '$.action') AS a FROM events WHERE kind = 'suspension' ORDER BY seq`)).map((r) => r.a)).toEqual(['set', 'started', 'lifted']);
  });
});

describe('R-BTN-48: the courses a heartbeat declares', () => {
  const at = (n: number) => ({ repository: 'docs', course: 'roadmap-pr', version: n });
  it.each([
    ['65 courses', Array.from({ length: 65 }, (_, i) => ({ repository: 'docs', course: `c${i}`, version: 1 }))],
    ['one course twice', [at(3), at(4)]],
    ['a negative version', [at(-1)]],
    ['a version past the ceiling', [at(1_000_000_001)]],
    ['an entry that is not an object', ['docs:roadmap-pr']],
    ['a malformed repository', [{ repository: 'Docs', course: 'roadmap-pr', version: 1 }]],
    ['a malformed course', [{ repository: 'docs', course: 'Roadmap PR', version: 1 }]],
    ['courses that are not a list', { docs: 3 }],
  ])('refuses %s', async (_what, courses) => {
    const res = await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: await sha256('s'), courses }) });
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([400, 'invalid-params']);
  });

  it('a worker that declares no course is stale on every registered course, and Needs you lists it', async () => {
    const { id, first } = await register('vm-a', { courses: [] });
    expect(first.stale_courses).toEqual([{ repository: 'docs', course: 'roadmap-pr', version: null, min_worker_version: 3 }]);
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { stale_skills: { id: number; course_id: string | null }[] } };
    expect(state.needs_you.stale_skills).toEqual([expect.objectContaining({ id, course_id: null })]);
  });
});
