// S-BTN-15 stale skills (BATON_SPEC §13a, R-BTN-22): a worker below min_skills_version. Must
// hold: no new claim (stale-skills); its held claim finishes.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { beat, claimItem, claimRow, cutover, endClaim, ownerCall, payload, register, setClock, syncCall } from '../helpers';

const board = inject('board');
const sha = board.shas;

beforeEach(async () => {
  await setClock(Date.parse('2026-10-13T12:00:00Z'));
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
  await cutover();
});

describe('S-BTN-15 stale skills', () => {
  it('a worker that falls below min_skills_version keeps its claim, finishes it, and gets no new one', async () => {
    const { id, secret } = await register('vm-a', { skills_version: 3 });
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'R3-9001' });
    // A protocol change: the next snapshot raises min_skills_version to 4.
    expect((await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B, { min_skills_version: 4 }))).status).toBe(200);
    const hb = await beat('vm-a', secret, { skills_version: 3 });
    expect([hb.json.min_skills_version, hb.json.claim?.id]).toEqual([4, c.claim_id]); // still held
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { stale_skills: { id: number }[] } };
    expect(state.needs_you.stale_skills.map((w) => w.id)).toEqual([id]);
    expect((await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.B })).status).toBe(200);
    expect((await claimRow(c.claim_id)).status).toBe('completed');
    expect(await claimItem('vm-a', secret)).toMatchObject({ status: 409, json: { code: 'stale-skills', rule: 9 } });
    // Reloaded skills: claims again.
    await beat('vm-a', secret, { skills_version: 4 });
    expect((await claimItem('vm-a', secret)).status).toBe(200);
  });
});
