// entry.ts — the local start's process entry (scripts/start-local.mjs bundles it).
import { main } from './main';

main(process.argv.slice(2)).catch((e) => {
  console.error(`baton: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
