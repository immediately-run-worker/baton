// runner-protocol.test.ts — the runner's decisions over a leg script's result (BATON_SPEC §6.13
// R-BTN-72; R3-1245): every result shape, the edge rule with `bars`, a bad pair (never inferring
// the only edge out — R-BTN-83's amendment), the short-waits wait that clears and the one that
// times out at 30 minutes, and how an advance refusal settles. Pure and host-neutral: the graph
// is graphOf over the real roadmap-pr fixture, the producer the runner itself loads per claim.
import { describe, it, expect } from 'vitest';
import roadmapPr from '../fixtures/courses/roadmap-pr/course.json';
import { graphOf } from '../../src/core/graph';
import { SCRIPT_RELEASE_REASONS, SHORT_WAIT_MS, decide, refusalKind, runNumber, shortWaitSpent, waitState } from '../../src/runner/protocol';

const g = graphOf(roadmapPr);
/** review's two outcomes, exercising a leg whose `to` is a list (R-BTN-83). */
const multi = graphOf({
  ...roadmapPr,
  legs: { ...roadmapPr.legs, review: { from: ['pr-open', 'fixed'], to: ['changes-requested', 'approved'], max_runs: 3 }, merge: { from: ['changes-requested', 'approved'], to: 'merged' } },
  stations: { ...roadmapPr.stations, 'changes-requested': { label: 'Changes requested' }, approved: { label: 'Approved' } },
});

describe('decide: the four result shapes', () => {
  it('a go-on result advances into the leg it names', () => {
    expect(decide({ reached: 'pr-open', next: 'review' }, g, 'implement', 'filed')).toEqual({
      kind: 'advance', reached: 'pr-open', leg: 'review', bars: [],
    });
  });

  it('a suspend result rests where the script says, naming the queued leg', () => {
    expect(decide({ suspend: true, reached: 'reviewed', next: 'fix' }, g, 'review', 'pr-open')).toEqual({
      kind: 'suspend', reached: 'reviewed', next: 'fix',
    });
    // given up at its from, the leg itself queued (R-BTN-83)
    expect(decide({ suspend: true, reached: 'pr-open' }, g, 'review', 'pr-open')).toEqual({
      kind: 'suspend', reached: 'pr-open', next: null,
    });
  });

  it('an end result ends done', () => {
    expect(decide({ end: 'done', reached: 'merged', detail: 'archived' }, g, 'merge', 'reviewed')).toEqual({
      kind: 'done', reached: 'merged', detail: 'archived',
    });
  });

  it('a release result names a §6.5 reason', () => {
    expect(decide({ release: 'cannot-finish:transient', reached: 'reviewed' }, g, 'review', 'pr-open')).toEqual({
      kind: 'release', reason: 'cannot-finish:transient', reached: 'reviewed', next: null,
    });
  });

  it('every release reason a script may choose is one §6.5 names, minus the runner and server own', () => {
    expect(SCRIPT_RELEASE_REASONS).toEqual(['stale-board', 'cannot-finish:transient', 'cannot-finish:capability', 'cannot-finish:spec', 'requested', 'provider-exhausted']);
  });
});

describe('decide: the edge rule', () => {
  it('carries the result’s bars on the advance (adjudicated → merge)', () => {
    expect(decide({ reached: 'adjudicated', next: 'merge', bars: ['family:anthropic'] }, g, 'adjudicate', 'reviewed')).toEqual({
      kind: 'advance', reached: 'adjudicated', leg: 'merge', bars: ['family:anthropic'],
    });
  });

  it('never infers the only edge out: no next at a non-end station is a bug (R-BTN-83)', () => {
    // adjudicated has exactly one leg out (merge); the script did not name it — a course change
    // could add a second, so the runner takes nothing without being told.
    const verdict = decide({ reached: 'adjudicated' }, g, 'adjudicate', 'reviewed');
    expect(verdict).toEqual({ bug: true, why: expect.stringContaining('named no next leg'), reached: 'reviewed', next: 'adjudicate' });
  });

  it('a next that is not an edge suspends the leg given up at its from', () => {
    const verdict = decide({ reached: 'pr-open', next: 'merge' }, g, 'implement', 'filed');
    expect(verdict).toEqual({ bug: true, why: expect.stringContaining('merge'), reached: 'filed', next: 'implement' });
  });

  it('a reached that is not an outcome of the leg is a bug', () => {
    const verdict = decide({ reached: 'merged', next: 'merge' }, g, 'implement', 'filed');
    expect(verdict).toEqual({ bug: true, why: expect.stringContaining('not an outcome'), reached: 'filed', next: 'implement' });
  });

  it('a result that is none of the four shapes is a bug, never guessed at', () => {
    for (const bad of [null, 'reviewed', 3, { hello: 'world' }, []]) {
      expect(decide(bad, g, 'implement', 'filed')).toEqual({ bug: true, why: expect.stringContaining('none of the four shapes'), reached: 'filed', next: 'implement' });
    }
  });

  it('an outcome of a many-outcome leg is the script’s word, and a bad one a bug', () => {
    expect(decide({ reached: 'approved', next: 'merge' }, multi, 'review', 'pr-open')).toMatchObject({ kind: 'advance', reached: 'approved', leg: 'merge' });
    expect(decide({ reached: 'triaged', next: 'fix' }, multi, 'review', 'pr-open')).toMatchObject({ bug: true });
  });

  it('an end station ends done whatever next the script named', () => {
    expect(decide({ reached: 'merged', next: 'merge' }, g, 'merge', 'reviewed')).toEqual({ kind: 'done', reached: 'merged' });
  });

  it('an old leg or station name resolves through renamed_from (R-BTN-64)', () => {
    const { fix, ...others } = roadmapPr.legs as Record<string, { from: string[]; to: string; max_runs?: number }>;
    const renamed = graphOf({ ...roadmapPr, legs: { ...others, address: { ...fix, renamed_from: 'fix' } } });
    expect(decide({ reached: 'reviewed', next: 'fix' }, renamed, 'review', 'pr-open')).toEqual({
      kind: 'advance', reached: 'reviewed', leg: 'address', bars: [],
    });
  });

  it('a release reason the runner or the server owns is refused for a script', () => {
    for (const own of ['lease-lost', 'course-changed', 'owner-cancel', 'provider-suspended', 'owner-bar-of-mine']) {
      expect(decide({ release: own, reached: 'pr-open' }, g, 'implement', 'filed')).toMatchObject({ bug: true, why: expect.stringContaining('not a reason a script may choose') });
    }
  });
});

describe('refusalKind: how an advance refusal settles (§6.13)', () => {
  it('off-graph ends released:course-changed; gates and max-runs suspend', () => {
    expect(refusalKind('off-graph')).toBe('course-changed');
    for (const code of ['max-runs', 'policy', 'not-queued', 'barred-tag', 'stale-skills', 'backing-off', undefined]) {
      expect(refusalKind(code)).toBe('suspend');
    }
  });
});

describe('waitState and the 30-minute short wait (R-BTN-40)', () => {
  const next = (state: string, waiting_on?: string) => [{ leg: 'review', state, ...(waiting_on ? { waiting_on } : {}) }];

  it('a ready leg runs; an unlisted leg runs — the holder’s own position leads', () => {
    expect(waitState(next('ready'), 'review', ['ci'])).toBe('run');
    expect(waitState([], 'review', ['ci'])).toBe('run');
    expect(waitState(next('ready'), 'fix', ['ci'])).toBe('run');
  });

  it('a short_waits label holds the claim; anything else suspends', () => {
    expect(waitState(next('waiting', 'ci'), 'review', ['ci'])).toBe('short');
    expect(waitState(next('waiting', 'owner-input'), 'review', ['ci'])).toBe('suspend');
    expect(waitState(next('waiting'), 'review', ['ci'])).toBe('suspend');
    expect(waitState(next('waiting', 'release-approval'), 'review', [])).toBe('suspend');
  });

  it('a short wait is spent at 30 minutes, not before (fake clock)', () => {
    const start = Date.parse('2026-10-16T12:00:00Z');
    expect(shortWaitSpent(start, start + SHORT_WAIT_MS - 1)).toBe(false);
    expect(shortWaitSpent(start, start + SHORT_WAIT_MS)).toBe(true);
    // ten minutes in — S-BTN-41's wait — is well inside
    expect(shortWaitSpent(start, start + 10 * 60_000)).toBe(false);
  });
});

describe('runNumber: git’s runs plus this claim’s, under current names', () => {
  it('counts the path’s runs, the claim’s own, and the one starting', () => {
    const path = [{ leg: 'implement', reached: 'pr-open' }, { leg: 'review', reached: 'reviewed' }, { leg: 'fix', reached: 'fixed' }, { leg: 'review', reached: 'reviewed' }];
    expect(runNumber(g, path, 'review', [])).toBe(3);
    expect(runNumber(g, path, 'fix', ['fix'])).toBe(3);
    expect(runNumber(g, path, 'merge', ['review'])).toBe(1);
  });

  it('an old name in the path counts as the renamed leg (R-BTN-64)', () => {
    const { fix, ...others } = roadmapPr.legs as Record<string, { from: string[]; to: string; max_runs?: number }>;
    const renamed = graphOf({ ...roadmapPr, legs: { ...others, address: { ...fix, renamed_from: 'fix' } } });
    expect(runNumber(renamed, [{ leg: 'fix', reached: 'fixed' }], 'address', [])).toBe(2);
  });
});
