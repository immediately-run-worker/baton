// The Worker's bindings (wrangler.toml), plus the test-only ones vitest.config.ts adds.
declare module '*.sql' { const text: string; export default text; }
declare module '*.html' { const text: string; export default text; }
declare module '*.css' { const text: string; export default text; }
declare module '*/ui/app.js' { const text: string; export default text; }
declare module '*/shared/baton.mjs';
declare module '*/shared/vocabulary.mjs';

interface Env {
  BATON: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  OIDC_ISSUER: string;
  OIDC_JWKS_URL: string;
  OIDC_AUDIENCE: string;
  OIDC_REPOSITORY: string;
  OIDC_REF: string;
  SYNC_WORKFLOW_REF: string;
  /** §10.3: the mirror's OIDC principal, for `/v1/sync/events` and `/v1/sync/foreign-claim`. */
  MIRROR_WORKFLOW_REF: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAILS: string;
  /** Worker secrets (R3-1208 sets them): `{credential id: SHA-256 of its token}` and
   *  `{credential id: {hostname, allowed_capabilities}}`. */
  TOKEN_HASHES?: string;
  CREDENTIALS?: string;
  /** §10.3: a fine-grained token, Actions: write on docs only, for workflow_dispatch. Absent,
   *  the two workflows run on their 15-minute schedules. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** Test bindings only (vitest.config.ts, §13a): never set in wrangler.toml or by a deploy. */
  BATON_TEST_BINDINGS?: string;
  TEST_OIDC_JWKS?: string;
  TEST_ACCESS_JWKS?: string;
  TEST_SIGNING_JWK?: string;
}

// `env` from cloudflare:test is typed as Cloudflare.Env.
declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
declare module '*/shared/sessionUsage.mjs';
declare module '*/shared/batonSync.mjs';
