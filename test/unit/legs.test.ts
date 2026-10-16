// legs.test.ts — R3-1232's remaining contracts: a holder's declared bars that a later snapshot lacks
// log bars-mismatch and list it under Needs you (R-BTN-63); a ticket is claimable again only after
// a sync since its last end, in the query and gatesFor alike (§6.7, G-BTN-40); the heartbeat shows
// a closed ticket as closed; an advance on an ended claim is claim-ended.
import { describe, it, expect, beforeEach } from 'vitest';
import { advance, beat, claimItem, cutover, endClaim, Git, ownerCall, placed, recommended, register, rows, setClock, withCore } from '../helpers';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const REVIEWED: [string, string][] = [['implement', 'pr-open'], ['review', 'reviewed']];
let git: Git;

beforeEach(async () => {
  await setClock(T0);
  git = new Git().add('T-1', {}, placed('reviewed', REVIEWED, [['fix', 'ready']], { bars: { fix: ['family:deepseek'] } }));
  await git.post();
  await cutover();
});

describe('R-BTN-63: bars the holder declared and the sync does not post', () => {
  it('logs bars-mismatch once and lists it under Needs you; the sync’s reading binds', async () => {
    const w = await register('vm-a', { tags: ['family:glm'] });
    const { json: c } = await claimItem('vm-a', w.secret);
    expect((await advance('vm-a', w.secret, c.claim_id, { leg: 'fix', bars: ['family:deepseek', 'family:qwen'] })).status).toBe(200);
    // The same snapshot's bars do not judge a leg started after its number.
    expect(await rows(`SELECT 1 FROM events WHERE kind = 'bars-mismatch'`)).toEqual([]);
    // A later snapshot posts fix's bars without family:qwen.
    await git.refresh();
    await git.refresh();
    expect(await rows(`SELECT claim_id, json_extract(detail_json, '$.declared_only') AS only FROM events WHERE kind = 'bars-mismatch'`)).toEqual([
      { claim_id: c.claim_id, only: '["family:qwen"]' }]);
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { bars_mismatch: { claim_id: number }[] } };
    expect(state.needs_you.bars_mismatch.map((b) => b.claim_id)).toEqual([c.claim_id]);
    // A snapshot that posts no bars for the leg says nothing about them.
    git.place('T-1', placed('reviewed', REVIEWED, [['fix', 'ready']]));
    await git.refresh();
    expect(await rows(`SELECT count(*) AS n FROM events WHERE kind = 'bars-mismatch'`)).toEqual([{ n: 1 }]);
  });
});

describe('§6.7, G-BTN-40: claimable again only after a sync since the last end', () => {
  it('the query and gatesFor both leave the ticket out until a reading follows the end', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret);
    await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'released:requested' });
    const agree = async () => withCore((o) => {
      const k = o.claims as unknown as { candidates: (w: unknown, page: number) => { id: string }[]; worker: (id: number) => unknown;
        item: (id: string) => unknown; gate: (w: unknown, item: unknown, leg: string, phase: string) => { ok: boolean; code?: string } };
      const w = k.worker(b.id);
      return { query: k.candidates(w, 0).map((r) => r.id), gate: k.gate(w, k.item('docs:T-1'), 'fix', 'claim') };
    });
    expect(await agree()).toEqual({ query: [], gate: { ok: false, rule: 1, code: 'awaiting-sync' } });
    expect((await claimItem('vm-b', b.secret, { ticket_id: 'docs:T-1' })).json).toMatchObject({ code: 'not-eligible', rule: 1, rule_code: 'awaiting-sync' });
    await git.refresh();
    expect(await agree()).toEqual({ query: ['docs:T-1'], gate: { ok: true } });
    expect(await recommended(b.id)).toEqual(['docs:T-1']);
  });
});

describe('the holder’s view and an ended claim', () => {
  it('a ticket the holder archived shows closed: done; withdrawn shows withdrawn after the stale release', async () => {
    const w = await register('vm-a');
    const { json: c } = await claimItem('vm-a', w.secret);
    await advance('vm-a', w.secret, c.claim_id, { leg: 'fix' });
    git.close('T-1', 'done');
    expect(await git.post()).toMatchObject({ stale_released: 0 });
    expect((await beat('vm-a', w.secret)).json.claim).toMatchObject({ station: 'reviewed', leg: 'fix', git: { closed: 'done' } });
    expect((await endClaim('vm-a', w.secret, c.claim_id, { end_reason: 'done', reached: 'fixed' })).status).toBe(200);
    expect((await advance('vm-a', w.secret, c.claim_id, { reached: 'fixed', leg: 'review' })).json.code).toBe('claim-ended');
  });

  it('an advance by another worker is not-holder; a malformed one is invalid-params', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret);
    expect((await advance('vm-b', b.secret, c.claim_id, { leg: 'fix' })).json.code).toBe('not-holder');
    for (const body of [{}, { leg: 'Fix!' }, { leg: 'fix', bars: ['a b'] }, { leg: 'fix', evidence: 'ftp://x' }, { leg: 'fix', reached: 3 }]) {
      expect([body, (await advance('vm-a', a.secret, c.claim_id, body)).json.code]).toEqual([body, 'invalid-params']);
    }
  });
});

describe('round 1 fixes', () => {
  it('a refresh that no longer places a live ticket places it nowhere, so it is not offered on its old station (1-A-0, 1-B-0)', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const { json: c } = await claimItem('vm-a', a.secret);
    await advance('vm-a', a.secret, c.claim_id, { leg: 'fix' });
    await endClaim('vm-a', a.secret, c.claim_id, { end_reason: 'released:requested' });
    delete git.stations['T-1'];
    await git.refresh();
    expect(await rows(`SELECT 1 FROM ticket_stations WHERE ticket_id = 'docs:T-1'`)).toEqual([]);
    expect(await recommended(b.id)).toEqual([]);
  });

  it('bars-mismatch is judged for an ended claim too: at the snapshot that confirms its suspension (1-A-1)', async () => {
    const w = await register('vm-a', { tags: ['family:glm'] });
    const { json: c } = await claimItem('vm-a', w.secret);
    await advance('vm-a', w.secret, c.claim_id, { leg: 'fix', bars: ['family:deepseek', 'family:qwen'] });
    await endClaim('vm-a', w.secret, c.claim_id, { end_reason: 'suspended:fixed', reached: 'fixed' });
    git.place('T-1', placed('fixed', [...REVIEWED, ['fix', 'fixed']], [['review', 'ready']], { bars: { fix: ['family:deepseek'] } }));
    expect(await git.refresh()).toMatchObject({ confirmed: 1 });
    expect(await rows(`SELECT claim_id, json_extract(detail_json, '$.declared_only') AS only FROM events WHERE kind = 'bars-mismatch'`)).toEqual([
      { claim_id: c.claim_id, only: '["family:qwen"]' }]);
  });

  it('past the expedite bound an expedited ticket sorts as unexpedited in its group, and places follow that order (1-A-2, 1-B-1)', async () => {
    git.add('N-1', { rank: 1 }).add('N-2', { rank: 10 }).add('E-3', { rank: 3, expedite: true }).add('E-4', { rank: 4, expedite: true }).add('E-5', { rank: 5, expedite: true });
    git.place('T-1', placed('reviewed', REVIEWED, [['fix', 'waiting', 'ci']]));
    await git.post();
    const x = await register('vm-a');
    const y = await register('vm-b');
    await claimItem('vm-a', x.secret, { ticket_id: 'docs:E-4' });
    await claimItem('vm-b', y.secret, { ticket_id: 'docs:E-5' });
    const t = await register('test');
    expect(await recommended(t.id)).toEqual(['docs:N-1', 'docs:E-3', 'docs:N-2']);
  });
});
