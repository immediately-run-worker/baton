// auth.ts — the two principals R3-1206 serves (BATON_SPEC §10.1): the board sync, by GitHub
// Actions OIDC (R-BTN-15), and the owner, by Cloudflare Access (R-BTN-16). Nothing but a
// verified JWT is trusted: no header, cookie or query parameter stands in for one.
import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { BatonError } from './http';
import { SHA256_HEX } from './validate';

const remoteSets = new Map<string, JWTVerifyGetKey>();

/** The key set at `url`, cached for the isolate's life (jose refreshes it on an unknown kid). */
function remote(url: string): JWTVerifyGetKey {
  let set = remoteSets.get(url);
  if (!set) {
    set = createRemoteJWKSet(new URL(url));
    remoteSets.set(url, set);
  }
  return set;
}

/** The test key set, honoured ONLY under the test bindings (§13a): a deployed Worker, staging
 *  included, has no BATON_TEST_BINDINGS, so no test key can ever verify there. */
function testKeys(env: Env, jwks: string | undefined): JWTVerifyGetKey | null {
  if (env.BATON_TEST_BINDINGS !== 'true' || !jwks) return null;
  return createLocalJWKSet(JSON.parse(jwks));
}

/** The JOSE failures that are the token's fault: a malformed, expired, mis-claimed or
 *  mis-signed token, or one whose key the set does not hold. */
const TOKEN_FAULTS = [
  errors.JWTExpired, errors.JWTClaimValidationFailed, errors.JWTInvalid, errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed, errors.JWKSNoMatchingKey, errors.JWKSMultipleMatchingKeys,
  errors.JOSEAlgNotAllowed, errors.JOSENotSupported,
];

/** A failed verification's code: the token's fault is `unauthenticated`; anything else — a key
 *  set that could not be fetched, answered non-200 or non-JSON, timed out or was malformed (an
 *  outage of GitHub's or Access's key endpoint) — is `unavailable`, so the caller retries
 *  rather than reading an outage as a bad credential. */
export function verifyFailure(e: unknown, what: string): BatonError {
  if (TOKEN_FAULTS.some((cls) => e instanceof cls)) return new BatonError('unauthenticated', `the ${what} token did not verify`);
  return new BatonError('unavailable', `the ${what} key set could not be fetched; retry`);
}

const bearer = (req: Request) => {
  const h = req.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

/**
 * The sync principal (R-BTN-15): a GitHub Actions OIDC token from `baton-sync.yml` on
 * `immediately-run/docs` `main`. Issuer, audience, repository, ref and the workflow ref must
 * all match; a token minted by a workflow on a branch, another workflow or another
 * repository is refused.
 */
export async function verifySync(req: Request, env: Env): Promise<void> {
  const token = bearer(req);
  if (!token) throw new BatonError('unauthenticated', 'an OIDC bearer token is required');
  const keys = testKeys(env, env.TEST_OIDC_JWKS) ?? remote(env.OIDC_JWKS_URL);
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, keys, { issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE }));
  } catch (e) {
    throw verifyFailure(e, 'OIDC');
  }
  if (claims.repository !== env.OIDC_REPOSITORY || claims.ref !== env.OIDC_REF || claims.job_workflow_ref !== env.SYNC_WORKFLOW_REF) {
    throw new BatonError('forbidden', 'the OIDC token is not from the board-sync workflow on docs main');
  }
}

/**
 * The owner principal (R-BTN-16): the Access JWT in `Cf-Access-Jwt-Assertion`, verified
 * against the team's certs with the application's `aud`, for an email in OWNER_EMAILS.
 * Returns that email.
 */
export async function verifyOwner(req: Request, env: Env): Promise<string> {
  const token = req.headers.get('Cf-Access-Jwt-Assertion') ?? '';
  if (!token) throw new BatonError('unauthenticated', 'Cloudflare Access is required');
  const team = env.ACCESS_TEAM_DOMAIN;
  const owners = env.OWNER_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!team || !env.ACCESS_AUD || !owners.length) throw new BatonError('forbidden', 'Access is not configured');
  const keys = testKeys(env, env.TEST_ACCESS_JWKS) ?? remote(`https://${team}/cdn-cgi/access/certs`);
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, keys, { issuer: `https://${team}`, audience: env.ACCESS_AUD }));
  } catch (e) {
    throw verifyFailure(e, 'Access');
  }
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
  if (!owners.includes(email)) throw new BatonError('forbidden', 'not an owner');
  return email;
}

/** R-BTN-16: a state-changing `/v1/ui/*` request needs a JSON body and our own Origin. */
export function checkStateChanging(req: Request, env: Env): void {
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' || req.headers.get('Origin') !== env.PUBLIC_ORIGIN) {
    throw new BatonError('forbidden', 'a state-changing request needs Content-Type: application/json and the dashboard Origin');
  }
}

/** The worker principal (§10.1, R-BTN-13): a bearer token whose SHA-256 is one of the
 *  `TOKEN_HASHES` Worker secret's values (`{credential id: hex}`). Returns that credential id.
 *  Revoking a token is deleting its hash; the credential's policy (hostname, allowed
 *  capabilities) is the `CREDENTIALS` secret, which the object mirrors into `credentials`. */
export async function verifyWorker(req: Request, env: Env): Promise<string> {
  const token = bearer(req);
  if (!token) throw new BatonError('unauthenticated', 'a worker token is required');
  let hashes: Record<string, string>;
  try {
    hashes = JSON.parse(env.TOKEN_HASHES ?? '{}');
  } catch {
    throw new BatonError('unavailable', 'the worker token table is unreadable');
  }
  const presented = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  let match: string | null = null;
  for (const [id, hex] of Object.entries(hashes)) {
    if (!SHA256_HEX.test(hex)) continue;
    const want = Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
    // Compare every entry in constant time, so the scan's timing says nothing.
    if (crypto.subtle.timingSafeEqual(presented, want)) match = id;
  }
  if (!match) throw new BatonError('unauthenticated', 'unknown worker token');
  return match;
}
