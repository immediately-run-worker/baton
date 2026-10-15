// S-BTN-15 stale skills (BATON_SPEC §13a, R-BTN-22, R-BTN-48, R-BTN-65): a worker declaring
// `roadmap-pr` below the registry's `min_worker_version`. Must hold: no new claim on its tickets
// (`stale-skills`); its held claim finishes.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { beat, claimItem, claimRow, course, cutover, endClaim, ownerCall, payload, register, setClock, syncCall } from '../helpers';

const board = inject('board');
const sha = board.shas;
const at = (version: number) => ({ courses: [{ repository: 'docs', course: 'roadmap-pr', version }] });

beforeEach(async () => {
  await setClock(Date.parse('2026-10-13T12:00:00Z'));
  await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A, { registry: [course(3)] }));
  await cutover();
});

describe('S-BTN-15 stale skills', () => {
  it('a worker that falls below min_worker_version keeps its claim, finishes it, and gets no new one', async () => {
    const { id, secret } = await register('vm-a', at(3));
    const { json: c } = await claimItem('vm-a', secret, { ticket_id: 'docs:R3-9001' });
    // A protocol change older workers would misbehave under: roadmap-pr 4, workers needed at 4.
    expect((await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B, { registry: [course(4)] }))).status).toBe(200);
    const hb = await beat('vm-a', secret, at(3));
    expect(hb.json.stale_courses).toEqual([{ repository: 'docs', course: 'roadmap-pr', version: 3, min_worker_version: 4 }]);
    expect(hb.json.claim?.id).toBe(c.claim_id); // still held: rule 9 is checked at a claim only
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { stale_skills: { id: number; course_id: string }[] } };
    expect(state.needs_you.stale_skills.map((w) => [w.id, w.course_id])).toEqual([[id, 'roadmap-pr']]);
    expect((await endClaim('vm-a', secret, c.claim_id, { end_reason: 'done', ended_at_sha: sha.B })).status).toBe(200);
    expect((await claimRow(c.claim_id)).status).toBe('completed');
    expect(await claimItem('vm-a', secret)).toMatchObject({ status: 409, json: { code: 'stale-skills', rule: 9 } });
    // Reloaded from a pulled checkout: claims again.
    await beat('vm-a', secret, at(4));
    expect((await claimItem('vm-a', secret)).status).toBe(200);
  });

  it('R-BTN-65: a new version that leaves min_worker_version alone keeps older workers claiming', async () => {
    const { secret } = await register('vm-a', at(3));
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, board.states.B, { registry: [course(5, 3)] }));
    expect((await beat('vm-a', secret, at(3))).json.stale_courses).toEqual([]);
    expect((await claimItem('vm-a', secret)).status).toBe(200);
  });
});
