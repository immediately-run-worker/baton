// course.test.ts — R3-1231: the course file's rules (BATON_SPEC §2e R-BTN-69). The real
// `roadmap-pr` file, vendored byte for byte from docs' .baton/ (scripts/vendor.mjs FIXTURES),
// passes; each rule has a file that breaks only it.
import { describe, it, expect } from 'vitest';
import roadmapPr from '../fixtures/courses/roadmap-pr/course.json';
import { validateCourse, type CourseRule } from '../../src/core/course';

type Course = Record<string, any>;
const copy = (): Course => JSON.parse(JSON.stringify(roadmapPr));
const rules = (c: unknown) => validateCourse(c).map((v) => `${v.rule} ${v.path}`);
const only = (c: unknown, rule: CourseRule) => {
  const v = validateCourse(c);
  expect(v.length).toBeGreaterThan(0);
  expect(new Set(v.map((x) => x.rule))).toEqual(new Set([rule]));
  return v;
};

describe('validateCourse (R-BTN-69)', () => {
  it('passes the real roadmap-pr course file', () => {
    expect(validateCourse(roadmapPr)).toEqual([]);
  });

  it('passes a leg with outcomes, a contract, bounds and renames', () => {
    const c = copy();
    c.stations['changes-requested'] = { label: 'Changes requested' };
    c.stations.approved = { label: 'Approved', renamed_from: 'okayed' };
    c.legs.review = { from: ['pr-open', 'fixed'], to: ['changes-requested', 'approved'], max_runs: 3, max_duration: 3600, max_queue: 50, version: 2, outputs: { findings: { schema: 'schemas/findings.json' } } };
    c.legs.fix = { from: ['changes-requested'], to: 'fixed', max_runs: 2, inputs: { findings: { from: 'review.findings', accepts: [2], required: true } }, renamed_from: ['patch'] };
    c.legs.merge = { from: ['approved', 'adjudicated'], to: 'merged', replay_safe: false };
    c.legs.adjudicate = { from: ['changes-requested'], to: 'adjudicated' };
    delete c.stations.reviewed;
    expect(validateCourse(c)).toEqual([]);
  });

  it('a station no leg reaches is unreachable', () => {
    const c = copy();
    c.stations.orphan = { label: 'Nobody gets here' };
    c.legs.leave = { from: ['orphan'], to: 'merged' };
    expect(only(c, 'unreachable').map((v) => v.path)).toEqual(['stations.orphan']);
  });

  it('a station with no way on is no-end', () => {
    const c = copy();
    c.stations.stuck = { label: 'Stuck' };
    c.legs.wedge = { from: ['pr-open'], to: 'stuck' };
    expect(only(c, 'no-end').map((v) => v.path)).toEqual(['stations.stuck']);
  });

  it('a cycle with no max_runs is unbounded, once per cycle; a bounded leg anywhere in it suffices', () => {
    const c = copy();
    delete c.legs.review.max_runs;
    delete c.legs.fix.max_runs;
    const v = only(c, 'unbounded-cycle');
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('"fix", "review"');
    const half = copy();
    delete half.legs.review.max_runs; // fix still bounds the reviewed ↔ fixed loop
    expect(validateCourse(half)).toEqual([]);
    const self = copy();
    self.legs.poke = { from: ['pr-open'], to: 'pr-open' };
    expect(only(self, 'unbounded-cycle').map((x) => x.path)).toEqual(['legs.poke']);
    self.legs.poke.max_runs = 5;
    expect(validateCourse(self)).toEqual([]);
  });

  it('a from or to that names no station', () => {
    const c = copy();
    c.legs.implement.from = ['filed', 'nowhere'];
    c.legs.adjudicate.to = 'elsewhere';
    // …and with adjudicate's outcome gone, nothing reaches `adjudicated` any more.
    expect(rules(c)).toEqual(['unknown-station legs.adjudicate.to', 'unknown-station legs.implement.from.1', 'unreachable stations.adjudicated']);
  });

  it('start_leg must be a leg that leaves start', () => {
    const c = copy();
    c.start_leg = 'merge';
    expect(only(c, 'start-leg')[0].message).toContain('does not leave');
    c.start_leg = 'launch';
    expect(only(c, 'start-leg')[0].message).toContain('is not a leg');
  });

  it('an input must read a declared output of a leg', () => {
    const c = copy();
    c.legs.review.outputs = { findings: {} };
    c.legs.fix.inputs = { findings: { from: 'review.nope' } };
    expect(rules(c)).toEqual(['input legs.fix.inputs.findings.from']);
    c.legs.fix.inputs = { findings: { from: 'ghost.findings' } };
    expect(validateCourse(c)[0].message).toContain('"ghost" is not a leg');
    c.legs.fix.inputs = { findings: { from: 'findings' } };
    expect(rules(c)).toEqual(['input legs.fix.inputs.findings.from']);
  });

  it('ids, unknown keys and bounds', () => {
    const c = copy();
    c.stations.Bad_Id = { label: 'x' };
    c.legs.implement.to = 'pr-open';
    c.legs.leave = { from: ['Bad_Id'], to: 'merged' };
    c.legs.review.max_run = 3; // a typo must not silently drop the bound
    c.legs.fix.max_runs = 0;
    c.legs.merge.max_duration = 30;
    expect(rules(c)).toContain('id stations.Bad_Id');
    expect(rules(c)).toContain('unknown-key legs.review.max_run');
    expect(rules(c)).toContain('bound legs.fix.max_runs');
    expect(rules(c)).toContain('bound legs.merge.max_duration');
  });

  it('renamed_from may not name a current id nor be claimed twice', () => {
    const c = copy();
    c.legs.fix.renamed_from = 'review';
    c.legs.adjudicate.renamed_from = ['old'];
    c.legs.merge.renamed_from = 'old';
    expect(rules(c)).toEqual(['renamed-from legs.fix.renamed_from', 'renamed-from legs.merge.renamed_from']);
  });

  it('returns every violation of a file at once, in a fixed order', () => {
    const c = copy();
    c.stations.orphan = {};
    c.legs.leave = { from: ['orphan'], to: 'merged' };
    c.start_leg = 'merge';
    c.legs.review.max_run = 3;
    const v = rules(c);
    expect(v).toEqual(['start-leg start_leg', 'unknown-key legs.review.max_run', 'unreachable stations.orphan'].sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1])));
    expect(rules(c)).toEqual(v);
  });

  it('a malformed file is a shape violation, never a throw', () => {
    for (const bad of [null, 7, 'course', [], {}, { stations: [], legs: {} }, { stations: { a: 1 }, legs: { b: 'x' }, start: 'a', start_leg: 'b', end: ['a'] }]) {
      expect(() => validateCourse(bad)).not.toThrow();
      expect(validateCourse(bad).length).toBeGreaterThan(0);
    }
  });
});
