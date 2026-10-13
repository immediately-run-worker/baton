// setup.ts — every test starts from an empty Baton: storage is wiped between tests.
import { reset } from 'cloudflare:test';
import { afterEach } from 'vitest';

afterEach(async () => {
  await reset();
});
