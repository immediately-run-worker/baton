# Baton

The immediately.run factory's live state — work-item leases, workers, providers and the
dashboard at `https://baton.immediately.run` — on a Cloudflare Worker and one SQLite
Durable Object.

The design is `BATON_SPEC` in the `immediately-run/docs` repository
(`content/specs/BATON_SPEC.mdx`); the work is the `baton` project's roadmap items there. Where
an item says `infra/baton/<path>`, it means `<path>` in this repository (BATON_SPEC §3).

How Baton differs from a durable-execution engine such as Temporal, and where each fits:
[`docs/compared-to-temporal.md`](docs/compared-to-temporal.md).

## Layout

| Path | What |
|---|---|
| `src/core/` | Everything Baton decides, on either host (R-BTN-55): no platform import, checked by `test/unit/boundary-host.test.ts` |
| `src/core/ports.ts` | The platform services core takes: `Store`, `Scheduler`, `Clock`, `AdminKeys`, `HookRunner`, `Dispatch`, `Gate`, and the instance's `Config` |
| `src/core/front.ts` | What stands in front of the core: verifies the principal (OIDC for the sync, Access for the owner), sets the R-BTN-16 headers, serves the dashboard, forwards the API |
| `src/core/baton.ts` | The core: migrations, board sync (§7.1), routing, the alarm, the dashboard state |
| `src/core/workerApi.ts` | The worker API (§11): heartbeat and registration, activities, messages, suspensions, mode and shadow reports, the Workers view |
| `src/core/claims.ts` | The lease (§6, R3-1212): claim and end, matching (§7.2 rules 1–9 via `isEligible`), the alarm's reaps, the fence before re-issue, confirmations, git winning over a stale claim, the Running / Timeline / Needs you data |
| `src/core/attempts.ts` | Pure: the retry policy (§6.10 R-BTN-23) — which ends count, backoff, holds, the review-capacity run, the resume record (R-BTN-24) |
| `src/core/cutover.ts` | The one-way cutover (R-BTN-28): `POST /v1/ui/cutover`, the legacy import, adoption on the owner's confirmation |
| `src/core/validate.ts` | Pure: every worker- and owner-supplied field checked before any write (§10.4) |
| `src/core/board.ts` | Pure: snapshot validation, the `tickets` row an item becomes, peaks, prices |
| `src/core/auth.ts` | JWT verification (R-BTN-15, R-BTN-16); worker tokens against `TOKEN_HASHES` (R-BTN-13) |
| `src/cloudflare/` | The Cloudflare host: the Worker (`worker.ts`) and the `Baton` Durable Object (`baton.ts`), wiring `ctx.storage`, the alarm and `waitUntil` into the ports |
| `src/local/` | The local host: `node:sqlite` as the `Store` (`store.ts`), one queue for every request and alarm tick (`queue.ts`), a timer as the alarm (`host.ts`), `node:http` (`server.ts`), the command line (`main.ts`) |
| `src/migrations/` | Numbered schema migrations, applied before the object serves |
| `src/ui/` | The dashboard: one HTML page, one stylesheet, one ES module (`textContent` only) |
| `src/shared/` | **Vendored** from docs `scripts/lib/` — never edit here (R-BTN-37); `batonSync.mjs` is the board sync's own decision code, which S-BTN-13 drives |
| `test/unit/`, `test/integration/` | Vitest; `S-BTN-n` scenarios in `integration/`. Project `cloudflare` runs everything in the Workers runtime; project `local` runs every scenario again on the local host, plus the Node-only tests |
| `test/hosts/` | The two hosts the harness drives, behind one interface (`#host`) |
| `test/lib/fixtureRepo.mjs` | The harness's stand-in for `docs/main`: a real bare git repo |

## Commands

- `npm test` (alias `npm run test:baton`) — the suite on both hosts, with a fake clock; `npx vitest --project local`
  (or `cloudflare`) runs one.
- `npm run start:local -- --db <path> --port <n>` — Baton as a local process (below).
- `npm run typecheck` — the Worker, the local host and the Node scripts.
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

## Running locally

For development and CI (BATON_SPEC §3a): the same core, on a SQLite file. It needs Node 22.13 or
later (`node:sqlite` without a flag).

```
npm run start:local -- --db ./baton.db --port 8787 [--origin <url>] [--admin-keys <file>] [--config <file>]
```

- `--origin` is the instance's own origin (default `http://<host>:<port>`): the OIDC audience,
  the dashboard's `Origin` check (R-BTN-56). It is required with `--port 0` or a wildcard
  `--host`, where the address clients use cannot be derived.
- `--admin-keys` names a file of administrators' OpenSSH public keys, one per line (R-BTN-57).
- `--config` names a JSON object holding the Worker's other variables and secrets — `OIDC_*`,
  `*_WORKFLOW_REF`, `ACCESS_*`, `OWNER_EMAILS`, `TOKEN_HASHES`, `CREDENTIALS`,
  `GITHUB_DISPATCH_TOKEN` — as strings. Without it every principal is unconfigured: the sync
  and the owner are refused and no worker token is known, so the example above serves only
  refusals. Nothing is read from `.dev.vars`, and the test bindings are refused.

One queue runs every request and alarm tick one at a time, as the Durable Object does. A local
Baton trusts the hooks of the repositories it serves (R-BTN-59): register only repositories
whose writers you trust.

## Deploying

`.github/workflows/baton-deploy.yml` runs the suite and then `wrangler deploy` (production,
`baton.immediately.run`) and `wrangler deploy --env staging`
(`baton-staging.immediately.run`) on every push to `main`. It needs the
`CLOUDFLARE_API_TOKEN` secret in the `production` environment (R3-1208): Workers Scripts: Edit
on the account, plus Zone: Read and Workers Routes: Edit on the `immediately.run` zone.

With a sibling docs checkout present, the suite also fails when `src/shared/` or the board
fixtures have drifted from docs.
