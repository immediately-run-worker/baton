// S-BTN-13 board ordering (BATON_SPEC §13a R-BTN-30): two pushes whose syncs finish out of
// order, and a force-push. Must hold: the head never moves backwards; the force-push is held.
//
// The git side is real: global-setup.ts builds the fixture repository (test/lib/fixtureRepo.mjs)
// and answers ancestry with `git merge-base --is-ancestor`; the board states come from the real
// docs factory-state code. Each sync run below follows §7.1's three steps against the real
// Worker: read the head, decide by ancestry, post — and on head-moved, re-read and decide again.
import { describe, it, expect, inject } from 'vitest';
import { ownerCall, payload, setClock, syncCall } from '../helpers';

type Label = 'A' | 'B' | 'C' | 'D';
const board = inject('board');
const sha = board.shas;
const labelOf = (s: string | null) => (Object.entries(sha).find(([, v]) => v === s)?.[0] ?? null) as Label | null;
const ancestor = (x: Label, y: Label) => board.ancestry[`${x}<${y}`];

const readHead = async () => labelOf(((await (await syncCall('/v1/sync/head')).json()) as { sha: string | null }).sha);

/** §7.1 step 3: what a sync run that found `head` does with `next`. */
function decide(head: Label | null, next: Label): 'post' | 'confirm-only' | 'force' {
  if (head === null) return 'post';
  if (head === next || ancestor(next, head)) return 'confirm-only';
  return ancestor(head, next) ? 'post' : 'force';
}

/** One sync run for `next`, which read the head as `seen` (possibly long ago). Returns what it did. */
async function syncRun(next: Label, seen: Label | null): Promise<string[]> {
  const log: string[] = [];
  let head = seen;
  for (let attempt = 0; attempt < 2; attempt++) {
    const d = decide(head, next);
    log.push(`${next}: ${d} over ${head ?? '∅'}`);
    if (d === 'confirm-only') return log;
    const res = await syncCall('/v1/sync/board', payload(sha[next], head ? sha[head] : null, board.states[next], d === 'force' ? { force: true } : {}));
    const out = (await res.json()) as { ok?: boolean; code?: string };
    log.push(`${next}: ${out.ok ? 'accepted' : out.code}`);
    if (out.code !== 'head-moved') return log;
    head = await readHead(); // §7.1: re-read and retry once
  }
  return log;
}

describe('S-BTN-13 board ordering', () => {
  it('the git history is the one the scenario needs', () => {
    expect(ancestor('A', 'B') && ancestor('B', 'C') && ancestor('A', 'D')).toBe(true);
    expect(ancestor('C', 'D') || ancestor('D', 'C')).toBe(false);
  });

  it('two syncs finishing out of order never move the head backwards; a force-push is held', async () => {
    await setClock(Date.parse('2026-10-13T12:00:00Z'));
    const heads: (Label | null)[] = [];
    const record = async () => heads.push(await readHead());

    expect(await syncRun('A', await readHead())).toEqual(['A: post over ∅', 'A: accepted']);
    await record();

    // B and C are pushed in quick succession. Both runs read the head (A) at start; C's run
    // finishes first.
    const seenByB = await readHead();
    const seenByC = await readHead();
    expect(await syncRun('C', seenByC)).toEqual(['C: post over A', 'C: accepted']);
    await record();
    // B's run, late, loses the compare-and-set, re-reads the head (C), and finds B already
    // behind it: it posts nothing.
    expect(await syncRun('B', seenByB)).toEqual(['B: post over A', 'B: head-moved', 'B: confirm-only over C']);
    await record();

    // main is rewritten: D descends from A but not from C.
    expect(await syncRun('D', await readHead())).toEqual(['D: force over C', 'D: snapshot-rejected']);
    await record();

    expect(heads).toEqual(['A', 'C', 'C', 'C']);
    // Never backwards: each head descends from the one before it.
    for (let i = 1; i < heads.length; i++) expect(ancestor(heads[i - 1]!, heads[i]!)).toBe(true);

    // The held history is on the dashboard, with its 24-hour auto-accept time.
    const state = (await (await ownerCall('/v1/ui/state')).json()) as { held: { sha: string; auto_accept_at: number }[]; head: { sha: string } };
    expect(state.head.sha).toBe(sha.C);
    expect(state.held).toEqual([expect.objectContaining({ sha: sha.D, auto_accept_at: Date.parse('2026-10-14T12:00:00Z') })]);
  });
});
