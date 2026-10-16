// R3-1231 part 4 — tiers are a repository setting (BATON_SPEC R-BTN-66, §7.2 rule 5): a ticket's
// tier arrives by name and is matched as its position in its repository's ladder; a worker's
// ceiling may differ per repository. S-BTN-26.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { ceilingIn, tierPosition } from '../../src/core/registry';
import { claimItem, course, cutover, payload, register, rows, setClock, syncCall, syncToken, withCore, workerCall, hbBody, sha256, recommended } from '../helpers';

const board = inject('board');
const T0 = Date.parse('2026-10-13T12:00:00Z');
const LADDER = ['small', 'large'];
const fixture = board.states.A.state.items[0] as Record<string, unknown>;
const opsToken = () => syncToken({ repository: 'immediately-run/ops', ref: 'refs/heads/main', job_workflow_ref: 'immediately-run/ops/.github/workflows/baton-sync.yml@refs/heads/main' });
const RUNBOOK = { start: 'a', start_leg: 'go', end: ['b'], stations: { a: { label: 'A' }, b: { label: 'B' } }, legs: { go: { from: ['a'], to: 'b' } } };
const DECLARES = { courses: [{ repository: 'docs', course: 'roadmap-pr', version: 3 }, { repository: 'ops', course: 'runbook', version: 1 }] };

beforeEach(async () => {
  await setClock(T0);
  // docs' board carries the fleet data a worker's provider is resolved from (rule 7).
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
  await withCore((c) => {
    c.registry.register({ id: 'ops', github: 'immediately-run/ops', default_branch: 'main', sync_workflow: '.github/workflows/baton-sync.yml', tiers: LADDER });
  });
  const items = [
    { ...fixture, id: 'T-small', tier: 'small', course: 'runbook' },
    { ...fixture, id: 'T-large', tier: 'large', course: 'runbook' },
    { ...fixture, id: 'T-none', tier: null, course: 'runbook' },
    { ...fixture, id: 'T-other', tier: 'judgement', course: 'runbook' }, // not in ops' ladder
  ];
  await syncCall('/v1/sync/board', payload('f'.repeat(40), null, { items, ready: items.map((i) => i.id as string),
    registry: [course(1, 1, { id: 'runbook', skill: 'run', course: RUNBOOK, step_kinds: ['orient'] })] }), await opsToken());
  await cutover(1, 'ops');
});

const offered = (id: number) => recommended(id);

describe('tiers per repository (R-BTN-66)', () => {
  it('stores each ticket’s position in its ladder: untiered null, an unknown name the ladder’s length', async () => {
    expect(await rows(`SELECT local_id, tier, tier_position FROM tickets WHERE repository_id = 'ops' ORDER BY local_id`)).toEqual([
      { local_id: 'T-large', tier: 'large', tier_position: 1 },
      { local_id: 'T-none', tier: null, tier_position: null },
      { local_id: 'T-other', tier: 'judgement', tier_position: 2 },
      { local_id: 'T-small', tier: 'small', tier_position: 0 }]);
  });

  it('rule 5 compares in the repository’s ladder at the ceiling the worker declared for it', async () => {
    const low = await register('vm-a', { ...DECLARES, tier_ceilings: { ops: 'small' } });
    expect(await offered(low.id)).toEqual(['ops:T-small']);
    const high = await register('vm-b', { ...DECLARES, tier_ceilings: { ops: 'large' } });
    // The untiered ticket fits the top only; a name ops' ladder lacks fits nothing.
    expect((await offered(high.id)).sort()).toEqual(['ops:T-large', 'ops:T-none', 'ops:T-small']);
    // The named claim agrees with the query (G-BTN-40).
    expect(await claimItem('vm-a', low.secret, { ticket_id: 'ops:T-large' })).toMatchObject({ status: 409, json: { rule: 5 } });
    expect(await claimItem('vm-b', high.secret, { ticket_id: 'ops:T-other' })).toMatchObject({ status: 409, json: { rule: 5 } });
  });

  it('a single tier_ceiling applies where the ladder has it; else the top if unrestricted, the bottom if not', async () => {
    const unrestricted = await register('vm-a', DECLARES); // tier_ceiling critical: no limit
    expect((await offered(unrestricted.id)).filter((t) => t.startsWith('ops:')).sort()).toEqual(['ops:T-large', 'ops:T-none', 'ops:T-small']);
    const cheap = await register('vm-b', { ...DECLARES, tier_ceiling: 'routine' }); // ops' ladder has no routine
    expect((await offered(cheap.id)).filter((t) => t.startsWith('ops:'))).toEqual(['ops:T-small']);
    expect(ceilingIn('ops', LADDER, {}, 'routine')).toBe('small');
    expect(ceilingIn('ops', LADDER, {}, 'critical')).toBe('large');
    expect(ceilingIn('ops', LADDER, { ops: 'small' }, 'critical')).toBe('small');
    expect(tierPosition(LADDER, 'nope')).toBe(2);
  });

  it('a heartbeat’s per-repository ceiling must name a tier of that registered repository’s ladder', async () => {
    for (const tier_ceilings of [{ ops: 'critical' }, { ops: 'Small' }]) {
      const res = await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: await sha256('s'), tier_ceilings }) });
      expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([400, 'invalid-params']);
    }
    // One for a repository Baton does not serve is reported, never refusing the heartbeat
    // (round 1, 1-A-5): a refused heartbeat would cost the worker its leases everywhere.
    const res = await workerCall('/v1/runner/heartbeat', { body: hbBody('vm-a', { secret_hash: await sha256('s'), tier_ceilings: { nope: 'small', ops: 'small' } }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ tier_ceilings_unregistered: ['nope'] });
    // Kept (round 2, 2-A-1): once nope registers, the worker is not widened to its top.
    expect(await rows(`SELECT tier_ceilings FROM workers WHERE hostname = 'vm-a'`)).toEqual([{ tier_ceilings: '{"nope":"small","ops":"small"}' }]);
  });

  it('a ticket re-tiered above its holder’s ceiling in that ladder ends stale-board', async () => {
    const w = await register('vm-a', { ...DECLARES, tier_ceilings: { ops: 'small' } });
    await claimItem('vm-a', w.secret, { ticket_id: 'ops:T-small' });
    const items = [{ ...fixture, id: 'T-small', tier: 'large', course: 'runbook' }];
    const res = await syncCall('/v1/sync/board', payload('e'.repeat(40), 'f'.repeat(40), { items, ready: ['T-small'],
      registry: [course(1, 1, { id: 'runbook', skill: 'run', course: RUNBOOK, step_kinds: ['orient'] })] }), await opsToken());
    expect(await res.json()).toMatchObject({ ok: true, stale_released: 1 });
  });

  it('G-BTN-40 for rule 5: the query and gatesFor agree for every ceiling, in docs’ ladder and ops’', async () => {
    const workers = [
      { cred: 'vm-a' as const, over: { tier_ceilings: { ops: 'small' } } },
      { cred: 'vm-b' as const, over: { tier_ceilings: { ops: 'large', docs: 'routine' } } },
      { cred: 'mac' as const, over: { tier_ceiling: 'judgement' } }, // ops' ladder lacks it: its bottom
      { cred: 'test' as const, over: {} },
    ];
    await cutover(1, 'docs');
    for (const w of workers) {
      const { id } = await register(w.cred, { ...DECLARES, ...w.over });
      const agree = await withCore((o) => {
        const c = o.claims as unknown as { candidates: (w: unknown, page: number) => { id: string }[]; worker: (id: number) => unknown;
          item: (id: string) => { station: { next_leg: string } }; gate: (w: unknown, item: unknown, leg: string, phase: string) => { ok: boolean } };
        const facts = c.worker(id);
        const query = new Set(c.candidates(facts, 0).map((r) => r.id));
        const all = (o.store.exec<{ id: string }>(`SELECT t.id FROM tickets t JOIN ticket_next_legs a ON a.ticket_id = t.id AND a.state = 'ready'`).toArray()).map((r) => r.id);
        return all.map((t) => { const item = c.item(t); return [t, query.has(t), c.gate(facts, item, item.station.next_leg, 'claim').ok]; });
      });
      for (const [t, q, e] of agree) expect([w.cred, t, q]).toEqual([w.cred, t, e]);
    }
  });
});

