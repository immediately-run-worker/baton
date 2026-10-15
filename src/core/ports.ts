// ports.ts — the platform services core needs, one small interface each (BATON_SPEC §3a,
// R-BTN-55). Everything under src/core/ names only these; src/cloudflare/ and src/local/ each
// implement them. Nothing here imports a platform.

/** A value SQLite stores and returns: the Durable Object's `SqlStorageValue`. */
export type SqlValue = ArrayBuffer | string | number | null;
export type Row = Record<string, SqlValue>;

/** One statement's result: every row, or exactly one (`one` throws on any other count). */
export interface Cursor<T> {
  toArray(): T[];
  one(): T;
}

/**
 * The database (§3, §4). Synchronous on both hosts — the Durable Object's SQLite and
 * `node:sqlite` alike — so an operation that does not await is atomic with no lock.
 */
export interface Store {
  /** One statement with bound parameters. */
  exec<T = Row>(query: string, ...params: unknown[]): Cursor<T>;
  /** Several statements with no parameters: a migration file. */
  script(sql: string): void;
  /** Run `fn` as one transaction (nestable): its writes commit together or not at all. */
  transaction<T>(fn: () => T): T;
}

/** The one alarm (§3): when it next fires, and setting that. */
export interface Scheduler {
  get(): Promise<number | null>;
  set(at: number): Promise<void>;
}

/** Baton's clock (R-BTN-32): epoch milliseconds. Core reads time only through its `now`;
 *  without one the core uses the system clock, on both hosts alike. */
export type Clock = () => number;

/** The administrators' public keys (R-BTN-57): the `BATON_ADMIN_KEYS` secret, or the file
 *  `--admin-keys` names. One OpenSSH public key per entry. */
export interface AdminKeys {
  list(): string[];
}

/** A hook call (R-BTN-52, R-BTN-59): a Dynamic Worker on Cloudflare, a local `workerd`
 *  process locally — the same module format, input, output and limits. R3-1236 builds both. */
export interface HookRunner {
  run(hook: { module: string; entry: string }, input: unknown, limits: { timeout_ms: number }): Promise<unknown>;
}

/** §10.3: a workflow Baton dispatches after a committed transition: one repository's sync or
 *  mirror, resolved by the core to the GitHub repository and the workflow file. */
export interface Workflow {
  repository: string;
  kind: 'sync' | 'mirror';
}
export interface DispatchTarget {
  github: string;
  /** The workflow file's name, as `actions/workflows/{workflow}/dispatches` takes it. */
  workflow: string;
  ref: string;
}

/** Outbound dispatch (§10.3), and the host's way to finish work after a response. */
export interface Dispatch {
  send(target: DispatchTarget): Promise<unknown>;
  /** Let `work` finish after the response: `waitUntil` on Cloudflare. Never awaited. */
  defer(work: Promise<unknown>): void;
}

/** The instance's settings (§3a): wrangler.toml's vars and the Worker secrets on Cloudflare,
 *  the start-up options and `--config` file locally. */
export interface Config {
  BATON_ORIGIN: string;
  OIDC_ISSUER: string;
  OIDC_JWKS_URL: string;
  /** The repositories registered at start, insert-only (R-BTN-47; src/core/registry.ts): a JSON
   *  array of `POST /v1/admin/repositories` bodies less their owner keys. Each binds its own
   *  sync and mirror workflow to its board (R-BTN-15). */
  BATON_REPOSITORIES?: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAILS: string;
  /** `{credential id: SHA-256 of its token}` and `{credential id: {hostname, allowed_capabilities}}`
   *  (R-BTN-13; R3-1208 sets them as Worker secrets). */
  TOKEN_HASHES?: string;
  CREDENTIALS?: string;
  /** §10.3: a fine-grained token, Actions: write on docs only, for workflow_dispatch. Absent,
   *  the two workflows run on their 15-minute schedules. */
  GITHUB_DISPATCH_TOKEN?: string;
  /** Test bindings only (vitest.config.ts, §13a): never set by a deploy or a local start. */
  BATON_TEST_BINDINGS?: string;
  TEST_OIDC_JWKS?: string;
  TEST_ACCESS_JWKS?: string;
  TEST_SIGNING_JWK?: string;
}

/** §3: the two awaits at which another request may run — a request's signature check, once
 *  R3-1239 moves it inside the core, and a hook call (R3-1236); their callers await through
 *  this. The Durable Object's input gate opens there by itself; the local queue is released.
 *  Today the front verifies its JWTs before a request reaches the core, and nothing calls it. */
export interface Gate {
  outside<T>(work: () => Promise<T>): Promise<T>;
}

/** What a host hands core (R-BTN-55). */
export interface Ports {
  store: Store;
  scheduler: Scheduler;
  config: Config;
  dispatch: Dispatch;
  adminKeys: AdminKeys;
  /** Absent until R3-1236; a test injects a fake. */
  hooks?: HookRunner;
  /** Absent on Cloudflare, where the input gate needs nothing. */
  gate?: Gate;
  clock?: Clock;
}
