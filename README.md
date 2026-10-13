# Baton

The immediately.run factory's live state — work-item leases, workers, providers and the
dashboard at `https://workitems.immediately.run` — on a Cloudflare Worker and one SQLite
Durable Object.

The design is `BATON_SPEC` in the `immediately-run/docs` repository
(`content/specs/BATON_SPEC.mdx`); the work is the `baton` project's roadmap items there. Where
an item says `infra/baton/<path>`, it means `<path>` in this repository (BATON_SPEC §3).

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | The Worker: verifies the principal (OIDC for the sync, Access for the owner), sets the R-BTN-16 headers, serves the dashboard, forwards the API to the object |
| `src/baton.ts` | The `Baton` Durable Object: migrations, board sync (§7.1), the dashboard state |
| `src/board.ts` | Pure: snapshot validation, the `work_items` row an item becomes, peaks, prices |
| `src/auth.ts` | JWT verification (R-BTN-15, R-BTN-16) |
| `src/migrations/` | Numbered schema migrations, applied before the object serves |
| `src/ui/` | The dashboard: one HTML page, one stylesheet, one ES module (`textContent` only) |
| `src/shared/` | **Vendored** from docs `scripts/lib/` — never edit here (R-BTN-37) |
| `test/unit/`, `test/integration/` | Vitest in the Workers runtime; `S-BTN-n` scenarios in `integration/` |
| `test/lib/fixtureRepo.mjs` | The harness's stand-in for `docs/main`: a real bare git repo |

## Commands

- `npm test` (alias `npm run test:baton`) — the suite, in workerd, with a fake clock.
- `npm run typecheck` — the Worker and the Node scripts.
- `npm run vendor` — re-copy `baton.mjs`, `vocabulary.mjs` and `sessionUsage.mjs` from a sibling `../docs`
  checkout (or `DOCS_DIR`) and rewrite `src/shared/manifest.json`. Do this in a PR here after
  docs changes any of them.
- `npm run fixtures` — regenerate `test/fixtures/boards.json` with the real docs
  `factory-state` code.

With a sibling docs checkout present, the suite also fails when `src/shared/` or the board
fixtures have drifted from docs.
