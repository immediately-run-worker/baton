// S-BTN-11 scheduled and timed suspension (BATON_SPEC §7.4, §13a): a suspension scheduled for
// +1 h, ending at +3 h, starts and ends on the fake clock with events. Also the server halves of
// S-BTN-8 (no-new-work) and S-BTN-9 (stop): a heartbeat during each mode's suspension returns it;
// only `stop` sends a `release` with reason `provider-suspended`, and only to that account's
// holders. Holders are seeded claim rows here — R3-1212 makes them real.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { beat, ORIGIN, ownerCall, payload, register, rows, seedClaim, setClock, stub, syncCall , tick } from '../helpers';

const board = inject('board');
const T0 = Date.parse('2026-10-13T12:00:00Z');
const H = 3_600_000;
const owner = (path: string, body: unknown = {}) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
const events = async () =>
  (await rows<{ actor: string; detail_json: string }>(`SELECT actor, detail_json FROM events WHERE kind = 'suspension' ORDER BY seq`))
    .map((e) => ({ actor: e.actor, ...JSON.parse(e.detail_json) }));
const releases = (workerId: number) =>
  rows<{ payload_json: string }>(`SELECT payload_json FROM messages WHERE to_worker_id = ? AND kind = 'release'`, workerId);
// A Go Plus worker: its model's prefix bills to opencode_go_plus.
const GO = { model_id: 'opencode-go/kimi-k3', model_provider_id: 'opencode_go_plus' };

beforeEach(async () => {
  await setClock(T0);
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
});

describe('S-BTN-11 scheduled and timed suspension', () => {
  it('scheduled for +1 h, ending at +3 h: starts and ends on the fake clock, each logged once', async () => {
    const { secret } = await register('vm-a');
    const set = await owner('/v1/ui/suspensions', { provider_id: 'zai', mode: 'no-new-work', starts_at: T0 + H, ends_at: T0 + 3 * H, reason: 'quota reset' });
    expect(set.status).toBe(200);
    const { id } = (await set.json()) as { id: number };
    expect(await events()).toEqual([expect.objectContaining({ action: 'set', id, actor: expect.stringMatching(/^owner:/) })]);

    // Within 24 hours of its start, every heartbeat already carries it.
    expect((await beat('vm-a', secret)).json.suspensions).toEqual([expect.objectContaining({ id, provider_id: 'zai', starts_at: T0 + H })]);

    await setClock(T0 + H - 1);
    await tick();
    expect((await events()).map((e) => e.action)).toEqual(['set']);

    await setClock(T0 + H);
    await tick();
    await setClock(T0 + 2 * H);
    await tick();
    expect(await events()).toEqual([expect.objectContaining({ action: 'set' }), { actor: 'alarm', action: 'started', id }]);

    await setClock(T0 + 3 * H);
    await tick();
    await tick();
    expect((await events()).map((e) => e.action)).toEqual(['set', 'started', 'ended']);
    expect((await beat('vm-a', secret)).json.suspensions).toEqual([]);
  });

  it('a lifted suspension never starts', async () => {
    const set = await owner('/v1/ui/suspensions', { provider_id: 'zai', mode: 'stop', starts_at: T0 + H, ends_at: null, reason: 'maintenance' });
    const { id } = (await set.json()) as { id: number };
    expect((await owner(`/v1/ui/suspensions/${id}/lift`)).status).toBe(200);
    await setClock(T0 + 2 * H);
    await tick();
    expect((await events()).map((e) => e.action)).toEqual(['set', 'lifted']);
  });
});

describe('S-BTN-8 / S-BTN-9 server halves', () => {
  it('no-new-work: the heartbeat returns the suspension; the holder keeps its claim and gets no release', async () => {
    const go = await register('vm-a', GO);
    await seedClaim(go.id, 'R3-9001', T0);
    expect((await owner('/v1/ui/suspensions', { provider_id: 'opencode_go_plus', mode: 'no-new-work', starts_at: T0, ends_at: null, reason: 'over budget' })).status).toBe(200);
    const hb = await beat('vm-a', go.secret, GO);
    expect(hb.json.suspensions).toEqual([expect.objectContaining({ provider_id: 'opencode_go_plus', mode: 'no-new-work' })]);
    expect(hb.json.claim).toMatchObject({ ticket_id: 'R3-9001' });
    expect(hb.json.messages).toEqual([]);
    expect(await releases(go.id)).toEqual([]);
  });

  it('stop: each holder on the account is sent a release with reason provider-suspended; another account’s is not', async () => {
    const go = await register('vm-a', GO);
    const zai = await register('vm-b');
    await seedClaim(go.id, 'R3-9001', T0);
    await seedClaim(zai.id, 'R3-9002', T0);
    expect((await owner('/v1/ui/suspensions', { provider_id: 'opencode_go_plus', mode: 'stop', starts_at: T0, ends_at: null, reason: 'over budget' })).status).toBe(200);

    const hb = await beat('vm-a', go.secret, GO);
    expect(hb.json.suspensions).toEqual([expect.objectContaining({ provider_id: 'opencode_go_plus', mode: 'stop' })]);
    expect(hb.json.messages).toEqual([expect.objectContaining({ kind: 'release', payload: { ticket_id: 'R3-9001', reason: 'provider-suspended' } })]);
    expect((await beat('vm-b', zai.secret)).json.messages).toEqual([]);
    expect(await releases(zai.id)).toEqual([]);

    // The alarm does not send it twice.
    await tick();
    expect(await releases(go.id)).toHaveLength(1);
  });
});
