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
| `src/core/registry.ts` | The registered repositories (R-BTN-47): a checked, insert-only registration, the `BATON_REPOSITORIES` seed, the one repository a sync token binds to (R-BTN-15), qualified ticket ids (`docs:R3-1205`) |
| `src/core/cutover.ts` | The one-way cutover (R-BTN-28): `POST /v1/ui/cutover`, the legacy import, adoption on the owner's confirmation |
| `src/core/validate.ts` | Pure: every worker- and owner-supplied field checked before any write (§10.4) |
| `src/core/observations.ts` | The per-repository observation counter (R-BTN-62): `POST /v1/sync/observation` hands out the next number (`sync-busy` while one is outstanding, void after 10 minutes); a board post's number is used once and must be above the last accepted reading's |
| `src/core/courses.ts` | The course registry each sync posts (R-BTN-48): its shape check, each course file judged by `validateCourse` (a failing one keeps the previous and is listed under Needs you, R-BTN-69), the `min_worker_version` rule 9 reads |
| `src/core/course.ts` | Pure: `validateCourse`, every way a course file breaks R-BTN-69's rules (stations reachable, an end from everywhere, cycles bounded, `start_leg`, inputs) |
| `src/core/board.ts` | Pure: snapshot validation, the `tickets` row an item becomes, peaks, prices |
| `src/core/auth.ts` | JWT verification (R-BTN-15, R-BTN-16); the one verifier of signed requests, SSHSIG over RFC 9421 (R-BTN-13); worker tokens against `TOKEN_HASHES` during the transition |
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

A worker's identity is an SSH key (R-BTN-13 as amended; R3-1239): `ssh-ed25519`,
`ecdsa-sha2-nistp256` or their `sk-` FIDO forms. Every `/v1/runner/*` call carries an RFC 9421
`Signature-Input` and `Signature` covering `@method`, `@authority`, `@path`, `@query` and
`content-digest` (the empty string's digest when there is no body), with `created`, `nonce`,
`keyid` (the key's `SHA256:` fingerprint) and `tag="baton-request"`; the signature value is an
SSHSIG in the namespace `baton-request` — what `ssh-keygen -Y sign -n baton-request` or an
ssh-agent makes. Baton refuses a signature more than 5 minutes from its clock, for another
origin, in another namespace, by an unknown or revoked key, or with a nonce it has seen for
that key in 10 minutes. The front checks the shape, `@authority` and the digest before the
object; the object checks the clock, the key, the signature and the nonce.

Until R3-1240's owner grants, the secret `BATON_KEYS` seeds the worker keys at start:
`[{"key": "ssh-ed25519 AAAA… comment", "name": "<the one hostname it registers>",
"allowed_capabilities": ["capability", …]}]`. A seeded key the list no longer names is revoked,
for good; a machine whose key is lost gets a new one. An unset `BATON_KEYS` changes nothing (`[]`
revokes every seeded key), and a list that cannot be seeded changes nothing and shows under
Needs you.

**The transition.** A request with no signature headers may still use a bearer token: the
secrets `TOKEN_HASHES` (`{"<credential>": "<sha256 of its token>"}`) and `CREDENTIALS`
(`{"<credential>": {"hostname": "…", "allowed_capabilities": ["capability", …]}}`); removing a
credential's hash revokes it on its next call. Bearer tokens go once every worker signs.

After the first heartbeat a worker also presents the per-session secret it registered
(R-BTN-14). Only the credential named `test` may send `test_harness` (R-BTN-32).

## Running locally

For development and CI (BATON_SPEC §3a): the same core, on a SQLite file. It needs Node 22.13 or
later (`node:sqlite` without a flag).

```
npm run start:local -- --db ./baton.db --port 8787 [--origin <url>] [--admin-keys <file>] [--config <file>]
```

- `--origin` is the instance's own origin (default `http://<host>:<port>`): the OIDC audience,
  the dashboard's `Origin` check (R-BTN-56), and must be just that: scheme, host and port, no
  path. It is required with `--port 0`, or a `--host` that is not one IP address or
  `localhost`, where the address clients use cannot be derived.
- One process holds a `--db` file at a time: a second start on it fails.
- `--admin-keys` names a file of administrators' OpenSSH public keys, one per line (R-BTN-57).
- `--config` names a JSON object holding the Worker's other variables and secrets — `OIDC_*`,
  `BATON_REPOSITORIES`, `ACCESS_*`, `OWNER_EMAILS`, `BATON_KEYS`, `TOKEN_HASHES`,
  `CREDENTIALS`, `GITHUB_DISPATCH_TOKEN` — as strings. Without it every principal is unconfigured: the sync
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
