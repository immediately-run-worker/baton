// helpers.ts — tokens signed by the per-run test key (vitest.config.ts), requests to the
// Worker, and the fake clock (R-BTN-32). Runs inside the Workers runtime.
import { env, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { importJWK, SignJWT } from 'jose';
import type { Baton } from '../src/baton';

export const ORIGIN = 'https://workitems.immediately.run';
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
  return sign({ ...SYNC_CLAIMS, ...over }, { issuer: opts.issuer ?? env.OIDC_ISSUER, audience: opts.audience ?? env.OIDC_AUDIENCE });
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

/** A board payload as the sync posts it (§7.1, §11). */
export function payload(sha: string, parent: string | null, state: { items: unknown[]; ready: string[] }, extra: Record<string, unknown> = {}) {
  return { sha, parent_sha: parent, state: { items: state.items }, ready: state.ready, confirmations: [], ...extra };
}
