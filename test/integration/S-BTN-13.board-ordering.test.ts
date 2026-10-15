// S-BTN-13 board ordering (BATON_SPEC §13a R-BTN-30): two pushes whose syncs finish out of
// order, and a force-push. Must hold: the head never moves backwards; the force-push is held.
//
// The sync is the REAL one, in two halves. Its decisions: `syncOnce` from docs
// scripts/lib/batonSync.mjs (vendored, R-BTN-37), the code baton-sync.mjs runs in the
// workflow, posting to the real Worker. Its payloads: docs baton-sync.mjs's own `buildPayload`
// run over the fixture repository (test/fixtures/boards.json, recomputed and compared wherever
// docs is a sibling — Baton's CI cannot read docs). Ancestry is real git: global-setup.ts asks
// `git merge-base --is-ancestor` of the fixture repository.
import { describe, it, expect, inject } from 'vitest';
import { syncOnce } from '../../src/shared/batonSync.mjs';
import { observe, ownerCall, setClock, syncCall } from '../helpers';

type Label = 'A' | 'B' | 'C' | 'D';
const board = inject('board');
const sha = board.shas;
const labelOf = (s: string | null) => (Object.entries(sha).find(([, v]) => v === s)?.[0] ?? null) as Label | null;
const isAncestor = async (a: string, b: string) => board.ancestry[`${labelOf(a)}<${labelOf(b)}`] === true;

const readHead = async () => (await (await syncCall('/v1/sync/head')).json()) as { sha: string | null; unconfirmed: unknown[] };
const post = async (body: unknown) => {
  const res = await syncCall('/v1/sync/board', body);
  const json = (await res.json()) as Record<string, unknown>;
  return res.ok ? { ok: true, ...json } : json;
};

/** The sync's dependencies for the run that will post `next`; `seen` is the head that run read
 *  when it started (possibly long ago), after which it reads the live head as the real one does. */
function depsFor(next: Label, seen?: { sha: string | null; unconfirmed: unknown[] }) {
  let first = seen;
  return {
    // R-BTN-62: the run's number, from the real route, before it reads anything.
    observe: async () => {
      const o = await observe();
      return o.status === 200 ? o.json : { ok: false, code: o.json.code };
    },
    readHead: async () => {
      if (first) {
        const h = first;
        first = undefined;
        return h;
      }
      return readHead();
    },
    post,
    isAncestor,
    // The real sync's payload for `next`: docs' buildPayload over the fixture repository
    // (test/fixtures/boards.json, rechecked against docs wherever docs is a sibling).
    buildPayload: async () => board.states[next],
    statusOf: () => null,
    sleep: async () => {},
  };
}

describe('S-BTN-13 board ordering', () => {
  it('the git history is the one the scenario needs', () => {
    expect(board.ancestry['A<B'] && board.ancestry['B<C'] && board.ancestry['A<D']).toBe(true);
    expect(board.ancestry['C<D'] || board.ancestry['D<C']).toBe(false);
  });

  it('two syncs finishing out of order never move the head backwards; a force-push is held', async () => {
    await setClock(Date.parse('2026-10-13T12:00:00Z'));
    const heads: (Label | null)[] = [];
    const record = async () => heads.push(labelOf((await readHead()).sha));

    expect(await syncOnce(sha.A, depsFor('A'))).toMatchObject({ outcome: 'advanced' });
    await record();

    // B and C are pushed in quick succession. Both runs read the head (A) at start; C's run
    // finishes first.
    const seenByB = await readHead();
    const seenByC = await readHead();
    expect(await syncOnce(sha.C, depsFor('C', seenByC))).toMatchObject({ outcome: 'advanced' });
    await record();
    // B's run, late, loses the compare-and-set, re-reads the head (C), and finds B already
    // behind it: it posts nothing more.
    const late = await syncOnce(sha.B, depsFor('B', seenByB));
    expect(late.outcome).toBe('confirmed');
    expect(late.steps).toEqual([`advance over ${sha.A}`, 'head-moved', `confirm-only over ${sha.C}`]);
    await record();

    // B's run posted nothing, so its number stays outstanding: a run inside ten minutes is busy
    // (R-BTN-62), and after them the number is void.
    expect(await syncOnce(sha.D, depsFor('D'))).toMatchObject({ outcome: 'busy' });
    await setClock(Date.parse('2026-10-13T12:10:00Z'));
    // main is rewritten: D descends from A but not from C. Its 15-minute re-post changes nothing.
    expect(await syncOnce(sha.D, depsFor('D'))).toMatchObject({ outcome: 'held' });
    await setClock(Date.parse('2026-10-13T12:25:00Z'));
    expect(await syncOnce(sha.D, depsFor('D'))).toMatchObject({ outcome: 'held' });
    await record();

    expect(heads).toEqual(['A', 'C', 'C', 'C']);
    // Never backwards: each head descends from the one before it.
    for (let i = 1; i < heads.length; i++) expect(board.ancestry[`${heads[i - 1]}<${heads[i]}`]).toBe(true);

    // The held history is on the dashboard once, with its first 24-hour auto-accept time.
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { held: { sha: string; head_sha: string; auto_accept_at: number }[]; repositories: { head: { sha: string } }[] };
    expect(state.repositories[0].head.sha).toBe(sha.C);
    expect(state.held).toEqual([expect.objectContaining({ sha: sha.D, head_sha: sha.C, auto_accept_at: Date.parse('2026-10-14T12:10:00Z') })]);
  });
});
