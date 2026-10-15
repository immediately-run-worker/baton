// S-BTN-16 cutover (BATON_SPEC §13a, §13 step 3, R-BTN-28), the server half: shadow → cutover
// with an in-flight git claim. Must hold: the legacy claim imported and adoptable on owner
// confirmation (G-BTN-19); cutover is one-way (G-BTN-35, server half). The clone's sticky
// marker and git fallback are R3-1219's.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import {
  beat, claimItem, claimRow, ORIGIN, ownerCall, payload, register, rows, setClock, syncCall, tick, workerCall,
} from '../helpers';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const DAY = 24 * 3_600_000;
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const mode = async (secret: string) => (await (await workerCall('/v1/runner/mode', { secret })).json()) as { mode: string; cutover_at?: number };
/** Board B, where R3-9001 is in progress (claimed 2026-10-13), optionally naming its holder. */
const boardB = (holder?: string) => {
  const items = structuredClone(board.states.B.state.items) as Record<string, unknown>[];
  if (holder) for (const it of items) if (it.id === 'R3-9001') it.holder = holder;
  return payload(sha.B, sha.A, { ...board.states.B, state: { items } });
};

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
});

describe('S-BTN-16 cutover (server)', () => {
  it('shadow until the owner cuts over; the in-flight git claim is imported as a legacy claim', async () => {
    const { secret } = await register('vm-a');
    await syncCall('/v1/sync/board', boardB());
    expect(await mode(secret)).toEqual({ mode: 'shadow' });
    expect((await claimItem('vm-a', secret)).json.code).toBe('not-cut-over');

    expect((await owner('/v1/ui/cutover', {})).status).toBe(400); // names its confirmation
    const res = await owner('/v1/ui/cutover', { confirm: true });
    expect(await res.json()).toEqual({ ok: true, cutover_at: T0, imported: ['R3-9001'] });
    expect(await mode(secret)).toEqual({ mode: 'cut-over', cutover_at: T0 });

    // G-BTN-19: one legacy worker per item, its claim reaped at the note's date + 7 days.
    expect(await rows(`SELECT hostname, session_name, kind, credential_id FROM workers WHERE kind = 'legacy'`)).toEqual([
      { hostname: 'legacy', session_name: 'item-R3-9001', kind: 'legacy', credential_id: 'legacy' }]);
    expect(await rows(`SELECT ticket_id, status, claimed_at, reap_after, snapshot_sha FROM claims`)).toEqual([
      { ticket_id: 'R3-9001', status: 'active', claimed_at: Date.parse('2026-10-13'), reap_after: Date.parse('2026-10-13') + 7 * DAY, snapshot_sha: sha.B }]);
    expect(await rows(`SELECT kind FROM events WHERE kind IN ('claimed', 'cutover') ORDER BY seq`)).toEqual([{ kind: 'claimed' }, { kind: 'cutover' }]);
    // The legacy claim blocks re-issue but is not "another live holder" for status writes (R-BTN-7).
    expect(await (await workerCall('/v1/runner/tickets/R3-9001/holder', { cred: 'vm-b' })).json()).toEqual({ held_by_other: false, fence_pending: false });
    // Claims now go through Baton.
    expect((await claimItem('vm-a', secret)).json.ticket_id).toBe('R3-9002');
  });

  it('G-BTN-35 (server half): one-way — a repeat keeps the first cutover_at; no call clears it; shadow reports end', async () => {
    const { secret } = await register('vm-a');
    await owner('/v1/ui/cutover', { confirm: true });
    await setClock(T0 + 60_000);
    await syncCall('/v1/sync/board', boardB());
    expect(await (await owner('/v1/ui/cutover', { confirm: true })).json()).toEqual({ ok: true, cutover_at: T0, imported: [] });
    for (const body of [{ confirm: false }, { cutover: false }, { cutover_at: null }]) await owner('/v1/ui/cutover', body);
    expect(await mode(secret)).toEqual({ mode: 'cut-over', cutover_at: T0 });
    const shadow = await workerCall('/v1/runner/shadow-report', { secret, body: { transition: 'claim', ticket_id: 'R3-9002', status: 'in-progress', nonce: 'abcdef', at: T0 } });
    expect(shadow.status).toBe(403);
    expect(await rows(`SELECT value FROM baton_settings WHERE key = 'cutover_at'`)).toEqual([{ value: String(T0) }]);
  });

  it('refuses a board older than 15 minutes', async () => {
    await setClock(T0 + 15 * 60_000);
    expect((await owner('/v1/ui/cutover', { confirm: true })).status).toBe(403);
    await setClock(T0 + 15 * 60_000 - 1);
    expect((await owner('/v1/ui/cutover', { confirm: true })).status).toBe(200);
  });

  it('G-BTN-19: the session the note names asks to adopt; the claim moves only when the owner confirms', async () => {
    const mine = await register('vm-a'); // session s-vm-a
    const other = await register('vm-b');
    await syncCall('/v1/sync/board', boardB('s-vm-a'));
    await owner('/v1/ui/cutover', { confirm: true });
    expect(await rows(`SELECT session_name FROM workers WHERE kind = 'legacy'`)).toEqual([{ session_name: 's-vm-a' }]);
    const legacy = (await rows<{ id: number; nonce: string }>(`SELECT id, nonce FROM claims`))[0];

    expect((await workerCall('/v1/runner/adopt', { cred: 'vm-b', secret: other.secret, body: { ticket_id: 'R3-9001' } })).status).toBe(403);
    const asked = await workerCall('/v1/runner/adopt', { secret: mine.secret, body: { ticket_id: 'R3-9001' } });
    expect(await asked.json()).toEqual({ claim_id: legacy.id, nonce: legacy.nonce, pending: true });
    // Not moved yet: a public name alone proves nothing.
    expect((await beat('vm-a', mine.secret)).json.claim).toBeNull();
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { adoptions: { ticket_id: string; session_name: string }[] } };
    expect(state.needs_you.adoptions).toEqual([expect.objectContaining({ ticket_id: 'R3-9001', session_name: 's-vm-a', legacy_session: 's-vm-a' })]);

    expect((await owner('/v1/ui/adoptions/R3-9001/confirm', { confirm: true })).status).toBe(200);
    expect((await beat('vm-a', mine.secret)).json.claim).toMatchObject({ id: legacy.id, ticket_id: 'R3-9001', nonce: legacy.nonce });
    expect(await rows(`SELECT reap_after FROM claims WHERE id = ?`, legacy.id)).toEqual([{ reap_after: null }]);
    expect(await rows(`SELECT kind, actor FROM events WHERE kind = 'adopted'`)).toEqual([{ kind: 'adopted', actor: 'owner:owner@example.com' }]);
    // Adopted, it is an ordinary claim: no legacy reap, and the per-worker index applies.
    expect((await claimItem('vm-a', mine.secret)).json.rule).toBe('one-claim-per-worker');
  });

  it('a note with no holder: any session may ask; the owner still decides; a session holding another item cannot adopt', async () => {
    const a = await register('vm-a');
    await syncCall('/v1/sync/board', boardB());
    await owner('/v1/ui/cutover', { confirm: true });
    await claimItem('vm-a', a.secret, { ticket_id: 'R3-9002' });
    expect((await workerCall('/v1/runner/adopt', { secret: a.secret, body: { ticket_id: 'R3-9001' } })).status).toBe(200);
    expect(await (await owner('/v1/ui/adoptions/R3-9001/confirm', { confirm: true })).json()).toMatchObject({ code: 'not-eligible', rule: 'one-claim-per-worker' });
    expect((await workerCall('/v1/runner/adopt', { secret: a.secret, body: { ticket_id: 'R3-9002' } })).status).toBe(404);
  });

  it('an unadopted legacy claim is reaped at its reap_after, not counted as a failed attempt', async () => {
    await syncCall('/v1/sync/board', boardB());
    await owner('/v1/ui/cutover', { confirm: true });
    const id = (await rows<{ id: number }>(`SELECT id FROM claims`))[0].id;
    await setClock(Date.parse('2026-10-13') + 7 * DAY - 1);
    await tick();
    expect((await claimRow(id)).status).toBe('active');
    await setClock(Date.parse('2026-10-13') + 7 * DAY);
    await tick();
    expect(await claimRow(id)).toMatchObject({ status: 'reaped', end_reason: 'reaped:legacy' });
    expect(await rows(`SELECT failed_attempt FROM claims WHERE id = ?`, id)).toEqual([{ failed_attempt: 0 }]);
  });
});
