// R3-1206 — the vendored decision library (BATON_SPEC §3 R-BTN-37): the copies match their
// manifest always, and the docs checkout's current files wherever one exists.
import { describe, it, expect, inject } from 'vitest';
import * as baton from '../../src/shared/baton.mjs';
import * as vocabulary from '../../src/shared/vocabulary.mjs';

describe('src/shared', () => {
  const { manifest, vendored, upstream } = inject('shared');

  it('each copy is the file its manifest pins', () => {
    expect(Object.keys(manifest).sort()).toEqual(['baton.mjs', 'sessionUsage.mjs', 'vocabulary.mjs']);
    expect(vendored).toEqual(manifest);
  });

  it.skipIf(!upstream)('each copy matches the sibling docs checkout (run npm run vendor on drift)', () => {
    expect(vendored).toEqual(upstream);
  });

  it('bundles and runs in the Workers runtime', () => {
    expect([...vocabulary.capabilitiesOf(['agent-venue'])].sort()).toEqual(['authentication', 'create-pr', 'drivable-browser', 'llm-call']);
    expect(vocabulary.fitsTier(null, 'judgement')).toBe(false);
    expect(baton.familyOf('opencode-go/deepseek-v4-pro', { families: { deepseek: ['deepseek'] } })).toBe('deepseek');
  });
});
