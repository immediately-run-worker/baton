// confirm.test.ts — R-BTN-71 and §2e, R3-1232: confirmation by path extension, read against the
// course file. A posted path confirms a suspension when it extends the claim's expected path —
// equal, or continued by edges of the file in order — and never by a non-edge step; a loop that
// brings a station back is told apart by the path, not the station. Regression is a path shorter
// than git's last or the claim's start path, set and cleared through the server.
import { describe, it, expect } from 'vitest';
import roadmapPr from '../fixtures/courses/roadmap-pr/course.json';
import { extendsPath, graphOf, onGraph, resolveLeg, resolveStation, runsOf, type Step } from '../../src/core/graph';

const g = graphOf(roadmapPr);
const p = (...steps: [string, string][]): Step[] => steps.map(([leg, reached]) => ({ leg, reached }));

describe('the course file as a graph', () => {
  it('to_end counts the legs on the shortest route to an end, so resume comes before start', () => {
    expect(Object.fromEntries(g.toEnd)).toEqual({ merged: 0, reviewed: 1, adjudicated: 1, 'pr-open': 2, fixed: 2, filed: 3 });
  });

  it('a whole path follows the file from its start, or it does not', () => {
    expect(onGraph(g, [])).toBe(true);
    expect(onGraph(g, p(['implement', 'pr-open'], ['review', 'reviewed'], ['fix', 'fixed'], ['review', 'reviewed'], ['merge', 'merged']))).toBe(true);
    expect(onGraph(g, p(['review', 'reviewed']))).toBe(false); // review does not leave filed
    expect(onGraph(g, p(['implement', 'reviewed']))).toBe(false); // implement does not reach reviewed
  });
});

describe('confirmation by path extension (R-BTN-71)', () => {
  const expected = p(['implement', 'pr-open'], ['review', 'reviewed']);

  it('equal paths extend: the usual case, the ticket at the named station', () => {
    expect(extendsPath(g, expected, expected, g.start)).toBe(true);
  });

  it('a path extended by edges in order extends: git is ahead of the claim', () => {
    expect(extendsPath(g, expected, [...expected, ...p(['fix', 'fixed'])], g.start)).toBe(true);
    expect(extendsPath(g, expected, [...expected, ...p(['fix', 'fixed'], ['review', 'reviewed'], ['merge', 'merged'])], g.start)).toBe(true);
  });

  it('a non-edge extension does not: fix cannot follow fixed, merge does not reach fixed', () => {
    expect(extendsPath(g, expected, [...expected, ...p(['fix', 'fixed'], ['fix', 'fixed'])], g.start)).toBe(false);
    expect(extendsPath(g, expected, [...expected, ...p(['merge', 'fixed'])], g.start)).toBe(false);
  });

  it('a shorter path, or one that differs inside the expected one, does not', () => {
    expect(extendsPath(g, expected, p(['implement', 'pr-open']), g.start)).toBe(false);
    expect(extendsPath(g, expected, p(['implement', 'pr-open'], ['adjudicate', 'reviewed']), g.start)).toBe(false);
  });

  it('a loop recurring the station: the second reviewed is not the first', () => {
    const round2 = [...expected, ...p(['fix', 'fixed'], ['review', 'reviewed'])];
    // A claim that suspended at the first reviewed is confirmed by a path that went round again…
    expect(extendsPath(g, expected, round2, g.start)).toBe(true);
    // …but a claim that suspended at the second is not confirmed by a path at the first: the
    // station alone matches, the path does not.
    expect(extendsPath(g, round2, expected, g.start)).toBe(false);
  });

  it('an empty expected path is extended from the station the claim started at', () => {
    expect(extendsPath(g, [], p(['implement', 'pr-open']), 'filed')).toBe(true);
    expect(extendsPath(g, [], p(['review', 'reviewed']), 'filed')).toBe(false);
  });
});

describe('renames (R-BTN-64): old names resolve, and runs count under the new name', () => {
  const { fix, ...rest } = roadmapPr.legs;
  const renamed = graphOf({ ...roadmapPr, legs: { ...rest, address: { ...fix, renamed_from: 'fix' } } });

  it('an old leg resolves to its new name; an unknown one to nothing', () => {
    expect(resolveLeg(renamed, 'fix')).toBe('address');
    expect(resolveLeg(renamed, 'address')).toBe('address');
    expect(resolveLeg(renamed, 'nope')).toBeNull();
    expect(resolveStation(renamed, 'fixed')).toBe('fixed');
  });

  it('max_runs counts the old name’s runs as the new one’s', () => {
    expect(runsOf(renamed, 'address', ['implement', 'review', 'fix', 'review', 'address'])).toBe(2);
  });

  it('a path written in old names extends one in new names', () => {
    expect(extendsPath(renamed, p(['implement', 'pr-open'], ['review', 'reviewed'], ['fix', 'fixed']), p(['implement', 'pr-open'], ['review', 'reviewed'], ['address', 'fixed']), 'filed')).toBe(true);
  });
});
