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
| `src/baton.ts` | The `Baton` Durable Object: migrations, board sync (§7.1), routing, the alarm, the dashboard state |
| `src/workerApi.ts` | The worker API (§11): heartbeat and registration, activities, messages, suspensions, mode and shadow reports, the Workers view |
| `src/validate.ts` | Pure: every worker- and owner-supplied field checked before any write (§10.4) |
| `src/board.ts` | Pure: snapshot validation, the `work_items` row an item becomes, peaks, prices |
| `src/auth.ts` | JWT verification (R-BTN-15, R-BTN-16); worker tokens against `TOKEN_HASHES` (R-BTN-13) |
| `src/migrations/` | Numbered schema migrations, applied before the object serves |
| `src/ui/` | The dashboard: one HTML page, one stylesheet, one ES module (`textContent` only) |
| `src/shared/` | **Vendored** from docs `scripts/lib/` — never edit here (R-BTN-37); `batonSync.mjs` is the board sync's own decision code, which S-BTN-13 drives |
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

## Worker credentials

Workers authenticate with a per-credential bearer token (R-BTN-13) and, after their first
heartbeat, the per-session secret they registered (R-BTN-14). Two secrets carry the
credentials: `TOKEN_HASHES` (`{"<credential>": "<sha256 of its token>"}`) and `CREDENTIALS`
(`{"<credential>": {"hostname": "…", "allowed_capabilities": ["capability", …]}}`). Removing a
credential's hash revokes it on its next call. Only the credential named `test` may send
`test_harness` (R-BTN-32).

## Deploying

`.github/workflows/baton-deploy.yml` runs the suite and then `wrangler deploy` (production,
`workitems.immediately.run`) and `wrangler deploy --env staging`
(`workitems-staging.immediately.run`) on every push to `main`. It needs the
`CLOUDFLARE_API_TOKEN` secret in the `production` environment (R3-1208): Workers Scripts: Edit
on the account, plus Zone: Read and Workers Routes: Edit on the `immediately.run` zone.

With a sibling docs checkout present, the suite also fails when `src/shared/` or the board
fixtures have drifted from docs.
