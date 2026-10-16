// setup.ts — every test starts from an empty Baton, on whichever host the project runs. The local
// host first writes the test's run as a trace (R3-1244: test/.traces/, which
// scripts/check-traces.mjs replays through the formal model); the Cloudflare host records none.
import { afterEach, expect } from 'vitest';
import { reset, writeTrace } from '#host';

afterEach(async () => {
  const { testPath, currentTestName } = expect.getState();
  await writeTrace(testPath ?? '', currentTestName ?? '');
  await reset();
});
