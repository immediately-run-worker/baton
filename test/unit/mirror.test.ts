// R3-1218 — what the git mirror reads and reports (BATON_SPEC §12, §10.3, R-BTN-36): the mirror
// principal, the event feed, the foreign-claim report, and the dispatches after a transition.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import {
  beat, captureDispatches, claimItem, cutover, endClaim, ORIGIN, ownerCall, payload, register, rows, setClock, syncCall, tick, workerCall, mirrorCall,
} from '../helpers';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const feed = async (after = 0, limit?: number) =>
  (await (await mirrorCall(`/v1/sync/events?after=${after}${limit ? `&limit=${limit}` : ''}`)).json()) as { events: any[]; next: number; cutover_at: number | null };

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
});

describe('§10.3: the mirror principal', () => {
  it('the feed takes only baton-mirror.yml’s token; the board only baton-sync.yml’s', async () => {
    expect((await syncCall('/v1/sync/events')).status).toBe(403);
    expect((await mirrorCall('/v1/sync/events')).status).toBe(200);
    expect((await mirrorCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B))).status).toBe(403);
    expect((await mirrorCall('/v1/sync/head')).status).toBe(403);
    expect((await mirrorCall('/v1/sync/events?after=x')).status).toBe(400);
  });
});

describe('§12: the event feed', () => {
  it('pages from the cursor, oldest first; each event carries its claim, and an ended one its work', async () => {
    await cutover(T0);
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret);
    await workerCall('/v1/runner/activities', { secret, body: { activities: [
      { id: 'p', claim_id: c.claim_id, kind: 'push', source: 'hook', started_at: T0, ended_at: T0 + 1, outcome: 'succeeded', detail: { branch: 'claude/r3-9001-x', sha: 'abc' } }] } });
    await beat('vm-a', secret, { transcripts: [{ repo: 'immediately-run/claude-sessions', path: 'cc/s.jsonl' }] });
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'released:cannot-finish:transient' });

    const all = await feed();
    const kinds = all.events.map((e) => e.kind);
    expect(kinds).toEqual(['snapshot-accepted', 'claimed', 'released', 'override']);
    expect(all.cutover_at).toBe(T0);
    expect(all.next).toBe(all.events.at(-1).seq);
    const claimed = all.events[1];
    expect(claimed).toMatchObject({ kind: 'claimed', ticket_id: 'R3-9001', claim_id: c.claim_id, actor: 'worker', detail: {} });
    expect(claimed.claim).toMatchObject({ nonce: c.nonce, status: 'released', started: true, legacy: false });
    expect(claimed.claim.request_id).toBeUndefined();
    const released = all.events[2];
    expect(released.detail).toEqual({ end_reason: 'released:cannot-finish:transient' });
    expect(released.claim.activities).toEqual([expect.objectContaining({ kind: 'push', detail_json: JSON.stringify({ branch: 'claude/r3-9001-x', sha: 'abc' }) })]);
    expect(released.claim.transcripts).toEqual([{ repo: 'immediately-run/claude-sessions', path: 'cc/s.jsonl', role: 'session' }]);
    // The page and the cursor.
    const page = await feed(all.events[0].seq, 2);
    expect(page.events.map((e) => e.kind)).toEqual(['claimed', 'released']);
    expect((await feed(all.next)).events).toEqual([]);
  });

  it('G-BTN-41 (server half): no session, hostname, worker id or email leaves through the feed', async () => {
    await cutover(T0);
    const a = await register('vm-a', { session_name: 'sess-secret-name' });
    const { json: c } = await claimItem('vm-a', a.secret);
    await owner('/v1/ui/overrides/R3-9002', { hold: true });
    await owner(`/v1/ui/claims/${c.claim_id}/reap`, { confirm: true });
    const text = JSON.stringify(await feed());
    for (const leak of ['sess-secret-name', 'vm-a', 'owner@example.com', 'request_id', `worker:${a.id}`, 'worker_id']) {
      expect([leak, text.includes(leak)]).toEqual([leak, false]);
    }
  });
});

describe('§12: foreign claims', () => {
  const report = (body: Record<string, unknown>) => mirrorCall('/v1/sync/foreign-claim', { ticket_id: 'R3-9001', nonce: 'f0f0f0', sha: sha.B, at: T0, ...body });

  it('before cutover git decides alone: ignored', async () => {
    expect(await (await report({})).json()).toEqual({ ignored: 'shadow' });
    expect(await rows('SELECT count(*) AS n FROM claims')).toEqual([{ n: 0 }]);
  });

  it('a held item keeps its holder: the answer names the holder’s nonce and the report is logged', async () => {
    await cutover(T0);
    const { secret } = await register('vm-a');
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'R3-9001' });
    expect(await (await report({})).json()).toEqual({ held: true, claim_id: c.claim_id, nonce: c.nonce, claimed_at: T0 });
    expect((await beat('vm-a', secret)).json.claim).toMatchObject({ id: c.claim_id, nonce: c.nonce });
    expect(await rows(`SELECT kind, json_extract(detail_json, '$.nonce') AS nonce FROM events WHERE kind = 'foreign-claim'`)).toEqual([{ kind: 'foreign-claim', nonce: 'f0f0f0' }]);
     // A repeated report of the same commit logs nothing new.
    await report({});
    expect(await rows(`SELECT count(*) AS n FROM events WHERE kind = 'foreign-claim'`)).toEqual([{ n: 1 }]);
  });

  it('an unheld item is imported as a legacy claim under the commit’s own nonce; a repeat is idempotent', async () => {
    await cutover(T0);
    expect(await (await report({})).json()).toEqual({ imported: true, claim_id: expect.any(Number), nonce: 'f0f0f0' });
    expect(await (await report({})).json()).toEqual({ imported: true, claim_id: expect.any(Number), nonce: 'f0f0f0' });
    expect(await rows(`SELECT c.nonce, c.reap_after, w.kind FROM claims c JOIN workers w ON w.id = c.worker_id`)).toEqual([
      { nonce: 'f0f0f0', reap_after: T0 + 7 * 24 * 3_600_000, kind: 'legacy' }]);
    // The cutover import's shape, its claimed (legacy) event included: the export's claim record.
    const feedKinds = (await feed()).events.filter((e) => e.ticket_id === 'R3-9001').map((e) => [e.kind, e.detail]);
    expect(feedKinds).toEqual([['claimed', { legacy: true, foreign: true }], ['foreign-claim', { nonce: 'f0f0f0', sha: sha.B, imported: true }]]);
    expect((await feed()).events.find((e) => e.kind === 'claimed').claim).toMatchObject({ nonce: 'f0f0f0', legacy: true });
  });

  it('refuses a malformed report', async () => {
    await cutover(T0);
    for (const bad of [{ nonce: 'xyz' }, { ticket_id: '../R3' }, { sha: 'abc' }, { at: -1 }]) {
      expect([JSON.stringify(bad), (await report(bad)).status]).toEqual([JSON.stringify(bad), 400]);
    }
  });
});

describe('§10.3: Baton dispatches the workflows after a transition', () => {
  it('nothing before cutover; after it, a claim and an end dispatch the mirror, a completion the sync too', async () => {
    const sent = await captureDispatches();
    const { secret } = await register('vm-a');
    await workerCall('/v1/runner/shadow-report', { secret, body: { transition: 'claim', ticket_id: 'R3-9001', status: 'in-progress', nonce: 'aaaaaa', at: T0 } });
    expect(sent).toEqual([]);
    await workerCall('/v1/runner/shadow-report', { secret, body: { transition: 'set', ticket_id: 'R3-9001', status: 'available', at: T0 } });
    expect(sent).toEqual([]);
    await cutover(T0);
    const { json: c } = await claimItem('vm-a', secret);
    expect(sent).toEqual(['baton-mirror.yml']);
    await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.A });
    expect(sent).toEqual(['baton-mirror.yml', 'baton-mirror.yml', 'baton-sync.yml']);
  });

  it('a refused call dispatches nothing; the alarm’s reap and the owner’s hold and expedite do', async () => {
    await cutover(T0);
    const sent = await captureDispatches();
    const { secret } = await register('vm-a');
    expect((await claimItem('vm-a', secret, { ticket_id: 'R3-9004' })).status).toBe(409);
    expect(sent).toEqual([]);
    await claimItem('vm-a', secret);
    sent.length = 0;
    await setClock(T0 + 900_000);
    await tick();
    expect(sent).toEqual(['baton-mirror.yml']);
    sent.length = 0;
    await owner('/v1/ui/overrides/R3-9002', { expedite: true });
    await owner('/v1/ui/overrides/R3-9003', { hold: true });
    expect(sent).toEqual(['baton-mirror.yml', 'baton-mirror.yml']);
  });
});
