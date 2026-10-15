// R3-1217, closing baton#6's round-one findings: the board's `since` and `holder`, the cutover's
// refusals, the legacy import's name collisions, and adoption requests that went stale.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import { calendarDate } from '../../src/core/board';
import { hbBody, ORIGIN, ownerCall, payload, register, rows, setClock, syncCall, tick, workerCall } from '../helpers';

const board = inject('board');
const sha = board.shas;
const T0 = Date.parse('2026-10-13T12:00:00Z');
const DAY = 24 * 3_600_000;
const owner = (path: string, body: unknown) =>
  ownerCall(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) });
type Item = Record<string, unknown> & { id: string };
/** Board B with per-item edits to the in-progress items' `since` and `holder`. */
const boardB = (edit: (it: Item) => void) => {
  const items = structuredClone(board.states.B.state.items) as Item[];
  items.forEach(edit);
  return payload(sha.B, sha.A, { ...board.states.B, state: { items } });
};

beforeEach(async () => {
  await setClock(T0);
});

describe('since and holder on the board', () => {
  it('a calendar date only: anything else is unknown, never a refused board', () => {
    expect(['2026-10-13', '2026-02-29', '2026-02-31', '2026-13-01', '2026-1-01', 20261013, null, undefined].map(calendarDate))
      .toEqual(['2026-10-13', null, null, null, null, null, null, null]);
    expect(calendarDate('2028-02-29')).toBe('2028-02-29');
  });

  it('a malformed since or holder is stored as unknown and the snapshot is accepted', async () => {
    await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
    const res = await syncCall('/v1/sync/board', boardB((it) => {
      if (it.id === 'R3-9001') Object.assign(it, { since: '2026-13-01', holder: 'not a session' });
    }));
    expect(res.status).toBe(200);
    expect(await rows(`SELECT since, holder FROM tickets WHERE id = 'docs:R3-9001'`)).toEqual([{ since: null, holder: null }]);
    // The fixture's own factory-state output carries a real date.
    expect(await rows(`SELECT since FROM tickets WHERE id = 'docs:R3-9002'`)).toEqual([{ since: '2026-10-13' }]);
    // An unknown since makes the legacy claim count its 7 days from the cutover.
    await owner('/v1/ui/cutover', { repository: 'docs', confirm: true });
    expect(await rows(`SELECT claimed_at, reap_after FROM claims`)).toEqual([{ claimed_at: T0, reap_after: T0 + 7 * DAY }]);
  });
});

describe('the cutover’s refusals and the import’s names', () => {
  it('refuses with no board at all', async () => {
    expect((await owner('/v1/ui/cutover', { repository: 'docs', confirm: true })).status).toBe(403);
    expect(await rows(`SELECT cutover_at FROM repositories`)).toEqual([{ cutover_at: null }]);
  });

  it('adopt before cutover is not-cut-over', async () => {
    await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
    const { secret } = await register('vm-a');
    const res = await workerCall('/v1/runner/adopt', { secret, body: { ticket_id: 'docs:R3-9001' } });
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([409, 'not-cut-over']);
  });

  it('two in-progress items whose notes name one session: the second falls back to item-<id>', async () => {
    await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
    const items = structuredClone(board.states.B.state.items) as Item[];
    for (const it of items) {
      if (it.id === 'R3-9001' || it.id === 'R3-9002') Object.assign(it, { status: 'in-progress', node: 'in-progress', holder: 'shared-session' });
    }
    await syncCall('/v1/sync/board', payload(sha.B, sha.A, { ...board.states.B, state: { items }, ready: ['R3-9003'] }));
    expect(await (await owner('/v1/ui/cutover', { repository: 'docs', confirm: true })).json()).toMatchObject({ imported: ['docs:R3-9001', 'docs:R3-9002'] });
    expect(await rows(`SELECT c.ticket_id, w.session_name FROM claims c JOIN workers w ON w.id = c.worker_id ORDER BY c.ticket_id`)).toEqual([
      { ticket_id: 'docs:R3-9001', session_name: 'shared-session' }, { ticket_id: 'docs:R3-9002', session_name: 'item-R3-9002' }]);
  });
});

describe('adoption requests that went stale', () => {
  const setup = async () => {
    await syncCall('/v1/sync/board', payload(sha.A, null, board.states.A));
    await syncCall('/v1/sync/board', boardB(() => {}));
    await owner('/v1/ui/cutover', { repository: 'docs', confirm: true });
    const a = await register('vm-a');
    expect((await workerCall('/v1/runner/adopt', { secret: a.secret, body: { ticket_id: 'docs:R3-9001' } })).status).toBe(200);
    return a;
  };
  const adoptions = async () => ((await (await ownerCall('/v1/ui/state')).json()) as { needs_you: { adoptions: unknown[] } }).needs_you.adoptions;

  it('a legacy claim that ends takes its request with it: gone from Needs you; confirm is not-found', async () => {
    await setup();
    expect(await adoptions()).toHaveLength(1);
    await setClock(Date.parse('2026-10-13') + 7 * DAY);
    await tick();
    expect(await rows('SELECT count(*) AS n FROM adoptions')).toEqual([{ n: 0 }]);
    expect(await adoptions()).toEqual([]);
    expect((await owner('/v1/ui/adoptions/docs:R3-9001/confirm', { confirm: true })).status).toBe(404);
  });

  it('a requester that went silent is not handed the claim; its request leaves Needs you until it asks again', async () => {
    const a = await setup();
    await setClock(T0 + 900_000);
    expect(await adoptions()).toEqual([]);
    const res = await owner('/v1/ui/adoptions/docs:R3-9001/confirm', { confirm: true });
    expect([res.status, ((await res.json()) as { rule: string }).rule]).toEqual([409, 'requester-silent']);
    expect(await rows(`SELECT w.kind FROM claims c JOIN workers w ON w.id = c.worker_id`)).toEqual([{ kind: 'legacy' }]);
    // Alive again (a heartbeat), and asking again: the owner can confirm.
    await workerCall('/v1/runner/heartbeat', { secret: a.secret, body: hbBody('vm-a') });
    await workerCall('/v1/runner/adopt', { secret: a.secret, body: { ticket_id: 'docs:R3-9001' } });
    expect((await owner('/v1/ui/adoptions/docs:R3-9001/confirm', { confirm: true })).status).toBe(200);
  });

  it('the item id in an owner route is checked', async () => {
    expect((await owner('/v1/ui/adoptions/docs:R3-9001%2F..%2Fx/confirm', { confirm: true })).status).toBe(400);
    expect((await owner('/v1/ui/overrides/not-an-item', { hold: true })).status).toBe(400);
  });
});
