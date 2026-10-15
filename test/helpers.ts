// helpers.ts — tokens signed by the per-run test key (vitest.config.ts), requests to the
// Worker, and the fake clock (R-BTN-32). Runs inside the Workers runtime.
import { env, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { importJWK, SignJWT } from 'jose';
import type { Baton } from '../src/baton';

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

/** A Cloudflare Access token for `email`. */
export function accessToken(email = 'owner@example.com', opts: { audience?: string } = {}) {
  return sign({ email }, { issuer: `https://${env.ACCESS_TEAM_DOMAIN}`, audience: opts.audience ?? env.ACCESS_AUD });
}

export function call(path: string, init: RequestInit = {}) {
  return (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default.fetch(new Request(ORIGIN + path, init));
}

export async function syncCall(path: string, body?: unknown, token?: string) {
  return call(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token ?? (await syncToken())}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function ownerCall(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Cf-Access-Jwt-Assertion', await accessToken());
  return call(path, { ...init, headers });
}

/** The fixed object, for direct inspection and the fake clock. */
export function stub() {
  return env.BATON.get(env.BATON.idFromName('baton'));
}

/** Set the object's clock to a fixed time (R-BTN-32). */
export function setClock(ms: number) {
  return runInDurableObject(stub(), (o: Baton) => {
    o.now = () => ms;
  });
}

/** Run SQL in the object and return the rows. */
export function rows<T = Record<string, unknown>>(query: string, ...params: unknown[]): Promise<T[]> {
  return runInDurableObject(stub(), (_o: Baton, state: DurableObjectState) => state.storage.sql.exec(query, ...(params as SqlStorageValue[])).toArray() as T[]);
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
  return { ...reference, sha, parent_sha: parent, state: { items: state?.items ?? items ?? [] }, ready, confirmations: [], ...extra };
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

/** A heartbeat body with sensible defaults for `cred`'s host. */
export function hbBody(cred: keyof typeof TOKENS, over: Record<string, unknown> = {}) {
  return {
    hostname: HOSTS[cred], session_name: `s-${cred}`, harness: 'opencode', kind: 'vm', model_id: 'zai-coding-plan/glm-5.3',
    model_provider_id: 'zai', billing: { 'zai-coding-plan': 'zai', 'opencode-go': 'opencode_go_plus' }, capabilities: ['agent-venue'],
    tier_ceiling: 'critical', lease_timeout_s: 900, skills_version: 3, ...over,
  };
}

/** Register a worker with a fresh secret; returns its id and secret. */
export async function register(cred: keyof typeof TOKENS = 'vm-a', over: Record<string, unknown> = {}) {
  const secret = `secret-${cred}-${Math.random().toString(16).slice(2)}`;
  const res = await workerCall('/v1/worker/heartbeat', { cred, body: hbBody(cred, { secret_hash: await sha256(secret), ...over }) });
  const json = (await res.json()) as Record<string, unknown>;
  if (res.status !== 200) throw new Error(`register ${cred}: ${res.status} ${JSON.stringify(json)}`);
  return { id: json.worker_id as number, secret, first: json };
}

/** A later heartbeat, authenticated by the secret. */
export async function beat(cred: keyof typeof TOKENS, secret: string, over: Record<string, unknown> = {}) {
  const res = await workerCall('/v1/worker/heartbeat', { cred, secret, body: hbBody(cred, over) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** An active claim row, seeded directly: claims are R3-1212's; R3-1211 only reads them. */
export async function seedClaim(workerId: number, item: string, at = 0) {
  await rows(`INSERT INTO claims (ticket_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
              VALUES (?, ?, ?, 'abc123', '', ?, 'active')`, item, workerId, `seed:${workerId}:${item}`, at);
  return (await rows<{ id: number }>(`SELECT id FROM claims WHERE ticket_id = ? AND status = 'active'`, item))[0].id;
}

// ── claims (R3-1212) ──────────────────────────────────────────────────────────────────────

/** The one-way cutover, set directly as the harness does (R-BTN-28; R3-1217 adds the call). */
export function cutover(at = 1) {
  return rows(`INSERT INTO baton_settings (key, value) VALUES ('cutover_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, String(at));
}

let requests = 0;
/** A fresh client-generated `request_id`. */
export const requestId = () => `req-${++requests}-${Math.random().toString(16).slice(2, 10)}`;

/** `POST /v1/worker/claim`; returns the status and the body. */
export async function claimItem(cred: keyof typeof TOKENS, secret: string, body: Record<string, unknown> = {}) {
  const res = await workerCall('/v1/worker/claim', { cred, secret, body: { request_id: requestId(), ...body } });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** `POST /v1/worker/claims/{id}/end`. */
export async function endClaim(cred: keyof typeof TOKENS, secret: string, claimId: number, body: Record<string, unknown>) {
  const res = await workerCall(`/v1/worker/claims/${claimId}/end`, { cred, secret, body });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** A claim's row, for assertions. */
export async function claimRow(id: number) {
  return (await rows<{ status: string; end_reason: string | null; fence_pending: number; confirmed_at: number | null; ticket_id: string }>(
    'SELECT status, end_reason, fence_pending, confirmed_at, ticket_id FROM claims WHERE id = ?', id))[0];
}

/** One alarm tick, run directly. Not `runDurableObjectAlarm`: the fake clock sits behind the
 *  real one, so every alarm the object arms is already overdue and workerd may be running it in
 *  the background — when it is, nothing is scheduled and `runDurableObjectAlarm` runs nothing. */
export function tick() {
  return runInDurableObject(stub(), (o: Baton) => o.alarm());
}

// ── the mirror (R3-1218) ──────────────────────────────────────────────────────────────────

/** A call as the mirror workflow: an OIDC token from baton-mirror.yml on docs main. */
export async function mirrorCall(path: string, body?: unknown) {
  return syncCall(path, body, await syncToken({ job_workflow_ref: env.MIRROR_WORKFLOW_REF }));
}

/** Record the object's workflow dispatches instead of sending them; returns the live list. */
export async function captureDispatches() {
  const sent: string[] = [];
  await runInDurableObject(stub(), (o: Baton) => {
    o.dispatcher = async (wf) => {
      sent.push(wf);
      return true;
    };
  });
  return sent;
}
