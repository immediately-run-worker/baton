// helpers.ts — tokens signed by the per-run test key (vitest.config.ts), requests to Baton, and
// the fake clock (R-BTN-32). Host-neutral (S-BTN-31): `#host` is the Cloudflare host (workerd)
// or the local one (Node), per vitest project.
import { importJWK, SignJWT } from 'jose';
import roadmapPr from './fixtures/courses/roadmap-pr/course.json';
import { ACTIVITY_KINDS } from '../src/core/validate';
import { call as hostCall, config as env, tick as hostTick, withCore } from '#host';
import { signedRequest, type SignOptions, type TestKey } from './lib/sshKeys';
import { deliverySignature } from '../src/core/webhook';

export { HOST, withCore } from '#host';

export const ORIGIN = env.BATON_ORIGIN;
const SYNC_CLAIMS = {
  repository: 'immediately-run/docs',
  ref: 'refs/heads/main',
  job_workflow_ref: 'immediately-run/docs/.github/workflows/baton-sync.yml@refs/heads/main',
};

async function sign(claims: Record<string, unknown>, { issuer, audience }: { issuer: string; audience: string }) {
  const key = await importJWK(JSON.parse(env.TEST_SIGNING_JWK!), 'ES256');
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'baton-test' })
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(key);
}

/** A GitHub Actions OIDC token; `over` replaces any claim (another repo, ref, workflow…). */
export function syncToken(over: Record<string, unknown> = {}, opts: { issuer?: string; audience?: string } = {}) {
  return sign({ ...SYNC_CLAIMS, ...over }, { issuer: opts.issuer ?? env.OIDC_ISSUER, audience: opts.audience ?? env.BATON_ORIGIN });
}

/** A GitLab CI `id_tokens` JWT from `issuer` (R-BTN-93), its audience `<origin>#<role>` unless given. */
export function gitlabToken(over: Record<string, unknown> = {}, opts: { issuer?: string; audience?: string; role?: 'sync' | 'mirror' } = {}) {
  return sign({ project_path: 'group/lab', ref: 'main', ref_type: 'branch', ...over },
    { issuer: opts.issuer ?? 'https://gitlab.test', audience: opts.audience ?? `${env.BATON_ORIGIN}#${opts.role ?? 'sync'}` });
}

/** A Cloudflare Access token for `email`. */
export function accessToken(email = 'owner@example.com', opts: { audience?: string } = {}) {
  return sign({ email }, { issuer: `https://${env.ACCESS_TEAM_DOMAIN}`, audience: opts.audience ?? env.ACCESS_AUD });
}

export function call(path: string, init: RequestInit = {}) {
  return hostCall(new Request(ORIGIN + path, init));
}

export async function syncCall(path: string, body?: unknown, token?: string) {
  const auth = token ?? (await syncToken());
  const send = (p: string, b?: unknown) => call(p, {
    method: b === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  // R-BTN-62: a board post carries a number from POST /v1/sync/observation, taken first as the
  // sync does; a test that names its own (or none, as `null`) posts it as it is.
  if (path === '/v1/sync/board' && body && typeof body === 'object' && !('observation' in body)) {
    const o = await send('/v1/sync/observation', {});
    if (o.ok) body = { ...(body as object), observation: ((await o.json()) as { observation: number }).observation };
  }
  return send(path, body);
}

/** `POST /v1/sync/observation` as a repository's sync (R-BTN-62): its JSON and status. */
export async function observe(token?: string) {
  const res = await call('/v1/sync/observation', { method: 'POST', headers: { Authorization: `Bearer ${token ?? (await syncToken())}`, 'Content-Type': 'application/json' }, body: '{}' });
  return { status: res.status, json: (await res.json()) as { sha: string | null; observation: number; bars: unknown[]; code?: string } };
}

export async function ownerCall(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cf-Access-Jwt-Assertion', await accessToken());
  return call(path, { ...init, headers });
}

/** Set the core's clock to a fixed time (R-BTN-32). */
export function setClock(ms: number) {
  return withCore((c) => {
    c.now = () => ms;
  });
}

/** Run SQL in the core's store and return the rows. */
export function rows<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> {
  return withCore((c) => c.store.exec<T>(query, ...params).toArray());
}

/** A board payload as the sync posts it (§7.1, §11): either a fixture snapshot (the real
 *  sync's `buildPayload` output — `state`, `ready` and the reference data) or a hand-built
 *  `{items, ready}`, at `sha` over `parent`. */
export function payload(
  sha: string,
  parent: string | null,
  snap: { items?: unknown[]; state?: { items: unknown[] }; ready: string[]; [k: string]: unknown },
  extra: Record<string, unknown> = {},
) {
  const { items, state, ready, sha: _s, parent_sha: _p, ...reference } = snap;
  return { registry: [course()], ...reference, sha, parent_sha: parent, state: { items: state?.items ?? items ?? [] }, ready, confirmations: [], ...extra };
}

/** A registry entry (R-BTN-48) as the sync posts it: docs' `roadmap-pr`, its course file the
 *  vendored fixture, at `version` with workers needed at `min` (rule 9). */
export function course(version = 3, min = version, over: Record<string, unknown> = {}) {
  return { id: 'roadmap-pr', version, min_worker_version: min, skill: 'next-roadmap-item', course: roadmapPr,
    step_kinds: [...ACTIVITY_KINDS], branch_pattern: 'claude/{ticket}-*', ...over };
}

// ── workers (R3-1211) ─────────────────────────────────────────────────────────────────────

export const TOKENS = { 'vm-a': 'tok-vm-a', 'vm-b': 'tok-vm-b', mac: 'tok-mac', test: 'tok-test' } as const;
const HOSTS = { 'vm-a': 'vm-a', 'vm-b': 'vm-b', mac: 'owner-mac', test: 'harness' } as const;

export async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A worker call with a credential's token and, after the first heartbeat, the secret. */
export function workerCall(path: string, { cred = 'vm-a', secret, body, method }: { cred?: keyof typeof TOKENS; secret?: string; body?: unknown; method?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKENS[cred]}`, 'Content-Type': 'application/json' };
  if (secret) headers['X-Worker-Secret'] = secret;
  return call(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** The run's test SSH keys (vitest.config.ts), by the name each registers: `vm-ed`,
 *  `vm-p256`, `vm-sk-ed`, `vm-sk-p256` (R-BTN-13 as amended, R3-1239). */
export const SSH_KEYS: Record<string, TestKey> = Object.fromEntries((JSON.parse(env.TEST_SSH_KEYS ?? '[]') as TestKey[]).map((k) => [k.name, k]));

/** A worker call signed with test key `name` (R-BTN-13): `created` is the core's clock unless
 *  given; a body is JSON. Returns the request too, to replay it. */
export async function signedCall(name: string, path: string, o: Omit<SignOptions, 'body'> & { body?: unknown; secret?: string; url?: string } = {}) {
  const created = o.created ?? Math.floor((await withCore((c) => c.now())) / 1000);
  const headers: Record<string, string> = o.secret ? { 'X-Worker-Secret': o.secret } : {};
  const req = await signedRequest(SSH_KEYS[name], o.url ?? ORIGIN + path, { ...o, created, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  const replay = req.clone();
  const res = await hostCall(req);
  return { res, replay };
}

/** A heartbeat body with sensible defaults for `cred`'s host. */
export function hbBody(cred: keyof typeof TOKENS, over: Record<string, unknown> = {}) {
  return {
    hostname: HOSTS[cred], session_name: `s-${cred}`, harness: 'opencode', kind: 'vm', model_id: 'zai-coding-plan/glm-5.3',
    model_provider_id: 'zai', billing: { 'zai-coding-plan': 'zai', 'opencode-go': 'opencode_go_plus' }, capabilities: ['agent-venue'],
    tier_ceiling: 'critical', lease_timeout_s: 900, courses: [{ repository: 'docs', course: 'roadmap-pr', version: 3 }], ...over,
  };
}

/** Register a worker with a fresh secret; returns its id and secret. */
export async function register(cred: keyof typeof TOKENS = 'vm-a', over: Record<string, unknown> = {}) {
  const secret = `secret-${cred}-${Math.random().toString(16).slice(2)}`;
  const res = await workerCall('/v1/runner/heartbeat', { cred, body: hbBody(cred, { secret_hash: await sha256(secret), ...over }) });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`register ${cred}: ${res.status} ${JSON.stringify(json)}`);
  return { id: json.worker_id as number, secret, first: json };
}

/** A later heartbeat, authenticated by the secret. */
export async function beat(cred: keyof typeof TOKENS, secret: string, over: Record<string, unknown> = {}) {
  const res = await workerCall('/v1/runner/heartbeat', { cred, secret, body: hbBody(cred, over) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** An active claim row, seeded directly: claims are R3-1212's; R3-1211 only reads them. */
export async function seedClaim(workerId: number, item: string, at = 0) {
  await rows(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
              VALUES (?, ?, ?, 'abc123', '', ?, 'active')`, item, workerId, `seed:${workerId}:${item}`, at);
  return (await rows<{ id: number }>(`SELECT id FROM claims WHERE ticket_id = ? AND status = 'active'`, item))[0].id;
}

// ── claims (R3-1212) ──────────────────────────────────────────────────────────────────────

/** The one-way cutover of a repository (docs by default), set directly as the harness does
 *  (R-BTN-28; R3-1217 adds the call). */
export function cutover(at = 1, repository = 'docs') {
  return rows('UPDATE repositories SET cutover_at = ? WHERE id = ?', at, repository);
}

let requests = 0;
/** A fresh client-generated `request_id`. */
export const requestId = () => `req-${++requests}-${Math.random().toString(16).slice(2, 10)}`;

/** `POST /v1/runner/claim`; returns the status and the body. */
export async function claimItem(cred: keyof typeof TOKENS, secret: string, body: Record<string, unknown> = {}) {
  const res = await workerCall('/v1/runner/claim', { cred, secret, body: { request_id: requestId(), ...body } });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** `POST /v1/runner/claims/{id}/end`. */
export async function endClaim(cred: keyof typeof TOKENS, secret: string, claimId: number, body: Record<string, unknown>) {
  const res = await workerCall(`/v1/runner/claims/${claimId}/end`, { cred, secret, body });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** A claim's row, for assertions. */
export async function claimRow(id: number) {
  return (await rows<{ status: string; end_reason: string | null; fence_pending: number; confirmed_at: number | null; ticket_id: string }>(
    'SELECT status, end_reason, fence_pending, confirmed_at, ticket_id FROM claims WHERE id = ?', id))[0];
}

/** One alarm tick, run directly (each host says how). */
export function tick() {
  return hostTick();
}

// ── the mirror (R3-1218) ──────────────────────────────────────────────────────────────────

/** docs' mirror workflow, as its OIDC token names it (wrangler.toml's BATON_REPOSITORIES). */
export const MIRROR_WORKFLOW_REF = 'immediately-run/docs/.github/workflows/baton-mirror.yml@refs/heads/main';

/** A call as the mirror workflow: an OIDC token from baton-mirror.yml on docs main. */
export async function mirrorCall(path: string, body?: unknown) {
  return syncCall(path, body, await syncToken({ job_workflow_ref: MIRROR_WORKFLOW_REF }));
}

/** Record the core's workflow dispatches instead of sending them, as `<repository>:<kind>`;
 *  returns the live list. */
export async function captureDispatches() {
  const sent: string[] = [];
  await withCore((c) => {
    c.dispatcher = async (wf) => {
      sent.push(`${wf.repository}:${wf.kind}`);
      return true;
    };
  });
  return sent;
}

/** A qualified ticket id in docs, the repository the fixtures post (R-BTN-47). */
export const q = (local: string) => `docs:${local}`;

// ── GitHub App webhooks (R3-1247) ─────────────────────────────────────────────────────────

/** A GitHub App delivery of `event` with `payload`, signed with the run's webhook secret
 *  unless `secret` says otherwise (R-BTN-73). */
export async function webhookCall(event: string, payload: unknown, { id = requestId(), secret = env.BATON_GITHUB_WEBHOOK_SECRET!, signature }: { id?: string; secret?: string; signature?: string } = {}) {
  const body = JSON.stringify(payload);
  const sig = signature ?? (await deliverySignature(secret, new TextEncoder().encode(body)));
  return call('/v1/github/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-GitHub-Delivery': id, 'X-Hub-Signature-256': sig }, body });
}

/** The core's armed alarm (§3), as its scheduler reports it. */
export function armedAt() {
  return withCore((c) => (c as unknown as { ports: { scheduler: { get(): Promise<number | null> } } }).ports.scheduler.get());
}
