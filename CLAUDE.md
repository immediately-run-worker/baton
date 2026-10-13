# CLAUDE.md — Baton

Baton is specified by `BATON_SPEC` in `immediately-run/docs` (`content/specs/BATON_SPEC.mdx`),
and built through the `baton` project's roadmap items there. Read the item and the spec
sections it cites before changing anything. See `README.md` for the layout.

## Rules

- **`src/shared/` is vendored.** Change `baton.mjs`, `vocabulary.mjs` or `sessionUsage.mjs` in docs, then
  `npm run vendor` here. The suite fails on a copy that does not match its manifest.
- **One clock.** The object reads time only through `this.now` (R-BTN-32); tests set it with
  `setClock`. Never call `Date.now()` anywhere else in `src/`.
- **Text, never markup.** The dashboard renders with `textContent`; no `innerHTML` (§10.4).
- **Trust only verified JWTs.** The test key set is honoured only under the test bindings in
  `vitest.config.ts`; never add `BATON_TEST_BINDINGS` or a `TEST_*` binding to `wrangler.toml`.
- **Migrations are append-only.** A schema change is a new numbered file in `src/migrations/`.
- **Filter fields only (R-BTN-33).** No item body, note, exit criterion or PR list is ever
  stored.
- **Validate before you write.** Every worker- or owner-supplied field goes through
  `src/validate.ts` before any SQL; a heartbeat's writes run in one `transactionSync`.
- **Every behaviour change names its `S-BTN-n` scenario** (R-BTN-31) and keeps `npm test` green.

## Commands

`npm test` · `npm run typecheck` · `npm run vendor` · `npm run fixtures`
