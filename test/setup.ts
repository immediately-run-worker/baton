// setup.ts — every test starts from an empty Baton, on whichever host the project runs.
import { afterEach } from 'vitest';
import { reset } from '#host';

afterEach(async () => {
  await reset();
});
