// runner-main.test.ts — `baton run`'s pure half (BATON_SPEC §6.13; R3-1245): the flag parser,
// the course declarations a heartbeat needs (rule 9), the credential the environment names and
// the worker secret's shape. Node only: it writes temp checkouts and runs ssh-keygen.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareCourses, fetchMain, parseRunArgs } from '../../src/runner/main';
import { envAuth } from '../../src/runner/api';
import { freshSecret } from '../../src/runner/home';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'baton-main-'));
  mkdirSync(join(dir, '.baton', 'courses', 'relay'), { recursive: true });
  writeFileSync(join(dir, '.baton', 'courses', 'relay', 'course.json'), '{"start":"a","start_leg":"b","end":["c"],"stations":{},"legs":{}}');
  return dir;
}

describe('parseRunArgs', () => {
  it('defaults from the environment', () => {
    const a = parseRunArgs([], { BATON_HOME: '/h', BATON_URL: 'https://b', IR_BATON_SESSION: 's', BATON_REPOSITORY: 'docs', IR_BATON_NAME: 'vm-x' });
    expect(a).toMatchObject({ harness: 'opencode', home: '/h', url: 'https://b', session: 's', repository: 'docs', hostname: 'vm-x', tier: 'critical', capabilities: ['agent-venue'] });
  });
  it('takes its flags, refusing the unknown and the malformed', () => {
    const a = parseRunArgs(['--harness', 'claude-code', '--home', '/x', '--url', 'https://u', '--session', 's2', '--repository', 'ops', '--tier', 'routine', '--capabilities', 'a,b', '--beat-every', '5000'], {});
    expect(a).toMatchObject({ harness: 'claude-code', home: '/x', url: 'https://u', session: 's2', repository: 'ops', tier: 'routine', capabilities: ['a', 'b'], beatEvery: 5000 });
    expect(() => parseRunArgs(['--nope'], {})).toThrow('not a flag of baton run');
    expect(() => parseRunArgs(['--harness', 'vim'], {})).toThrow('opencode or claude-code');
    expect(() => parseRunArgs(['--beat-every', '10'], {})).toThrow('at least 50 ms');
    expect(() => parseRunArgs(['--home'], {})).toThrow('needs a value');
  });
});

describe('declareCourses (rule 9)', () => {
  it('reads the spec’s baton.json courses[]', () => {
    const dir = home();
    writeFileSync(join(dir, '.baton', 'baton.json'), JSON.stringify({ baton_url: 'https://baton', courses: [{ id: 'relay', version: 7 }] }));
    expect(declareCourses(dir)).toEqual([{ course: 'relay', version: 7 }]);
    rmSync(dir, { recursive: true, force: true });
  });
  it('docs’ interim: a course key with skills_version, or the single directory beside scripts/data', () => {
    const named = home();
    writeFileSync(join(named, '.baton', 'baton.json'), JSON.stringify({ course: 'relay', skills_version: 3 }));
    expect(declareCourses(named)).toEqual([{ course: 'relay', version: 3 }]);
    rmSync(named, { recursive: true, force: true });
    const listed = home();
    mkdirSync(join(listed, 'scripts', 'data'), { recursive: true });
    writeFileSync(join(listed, 'scripts', 'data', 'baton.json'), JSON.stringify({ skills_version: 4 }));
    expect(declareCourses(listed)).toEqual([{ course: 'relay', version: 4 }]);
    rmSync(listed, { recursive: true, force: true });
  });
  it('refuses what it cannot name loudly', () => {
    const several = home();
    mkdirSync(join(several, '.baton', 'courses', 'other'), { recursive: true });
    writeFileSync(join(several, '.baton', 'courses', 'other', 'course.json'), '{}');
    expect(() => declareCourses(several)).toThrow(/2 courses/);
    rmSync(several, { recursive: true, force: true });
    const noVersion = home(); // one course, no version anywhere
    expect(() => declareCourses(noVersion)).toThrow(/no course version/);
    rmSync(noVersion, { recursive: true, force: true });
    const empty = mkdtempSync(join(tmpdir(), 'baton-main-'));
    expect(() => declareCourses(empty)).toThrow(/no .baton\/courses/);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('envAuth (§6.4, R-BTN-13)', () => {
  it('the transition’s bearer token, with the worker secret once known', () => {
    const auth = envAuth({ IR_BATON_TOKEN: 'tok-1' });
    expect(auth('POST', 'https://b.test/v1/runner/heartbeat', '', null)).toEqual({ Authorization: 'Bearer tok-1' });
    expect(auth('POST', 'https://b.test/v1/runner/heartbeat', '', 's3cret')).toEqual({ Authorization: 'Bearer tok-1', 'X-Worker-Secret': 's3cret' });
  });
  it('a key file signs: ssh-keygen makes one, Baton’s verifier shape comes back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-key-'));
    const file = join(dir, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file], { stdio: 'ignore' });
    const auth = envAuth({ IR_BATON_KEY_FILE: file });
    const headers = auth('POST', 'https://b.test/v1/runner/heartbeat', '{}', null);
    expect(headers['Content-Digest']).toMatch(/^sha-256=:/);
    expect(headers['Signature-Input']).toMatch(/tag="baton-request"/);
    expect(headers.Signature).toMatch(/^sig1=:/);
    expect(auth('POST', 'https://b.test/x', '{}', 's')).toHaveProperty('X-Worker-Secret', 's');
    rmSync(dir, { recursive: true, force: true });
  });
  it('no credential at all is an error, never a silent anonymous call', () => {
    expect(() => envAuth({})).toThrow(/no credential/);
  });
});

describe('the worker secret and the bounded fetch', () => {
  it('freshSecret is R-BTN-14’s 256-bit random, hex', () => {
    expect(freshSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(freshSecret()).not.toBe(freshSecret());
  });
  it('fetchMain swallows a failing fetch — the bound is ensureSha’s release', () => {
    const lines: string[] = [];
    expect(() => fetchMain('/nonexistent-checkout', (l) => lines.push(l))).not.toThrow();
    expect(lines.join('\n')).toMatch(/fetch failed/);
  });
});
