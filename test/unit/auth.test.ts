// R3-1206 — the two principals and the same-site rules (BATON_SPEC §10.3 R-BTN-15, §10.5
// R-BTN-16; G-BTN-11, G-BTN-12).
import { describe, it, expect, inject } from 'vitest';
import { env } from 'cloudflare:test';
import { errors, generateKeyPair, SignJWT } from 'jose';
import { verifyFailure, verifySync } from '../../src/auth';
import { accessToken, call, ORIGIN, ownerCall, syncCall, syncToken } from '../helpers';

const code = async (res: Response) => ((await res.json()) as { code: string }).code;

describe('the sync principal (R-BTN-15, G-BTN-11)', () => {
  it('accepts the board-sync workflow on docs main', async () => {
    const res = await syncCall('/v1/sync/head');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sha: null, unconfirmed: [] });
  });

  it.each([
    ['another repository', { repository: 'immediately-run/site-main' }],
    ['a branch', { ref: 'refs/heads/claude/r3-1206-x' }],
    ['another workflow', { job_workflow_ref: 'immediately-run/docs/.github/workflows/ci.yml@refs/heads/main' }],
    ['the sync workflow on a branch', { job_workflow_ref: 'immediately-run/docs/.github/workflows/baton-sync.yml@refs/heads/feature' }],
    ['the mirror workflow (it reads events, never posts the board)', { job_workflow_ref: 'immediately-run/docs/.github/workflows/baton-mirror.yml@refs/heads/main' }],
  ])('refuses a token from %s', async (_what, over) => {
    const res = await syncCall('/v1/sync/head', undefined, await syncToken(over));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('forbidden');
  });

  it('refuses another audience, another issuer, no token, and a key it does not know', async () => {
    expect((await syncCall('/v1/sync/head', undefined, await syncToken({}, { audience: 'example.com' }))).status).toBe(401);
    expect((await syncCall('/v1/sync/head', undefined, await syncToken({}, { issuer: 'https://evil.example' }))).status).toBe(401);
    expect((await call('/v1/sync/head')).status).toBe(401);
    const { privateKey } = await generateKeyPair('ES256');
    const forged = await new SignJWT({ repository: 'immediately-run/docs', ref: 'refs/heads/main', job_workflow_ref: env.SYNC_WORKFLOW_REF })
      .setProtectedHeader({ alg: 'ES256', kid: 'baton-test' }).setIssuer(env.OIDC_ISSUER).setAudience(env.OIDC_AUDIENCE).setExpirationTime('5m').sign(privateKey);
    expect((await syncCall('/v1/sync/head', undefined, forged)).status).toBe(401);
  });

  it('an owner token is no sync token', async () => {
    const res = await call('/v1/sync/head', { headers: { Authorization: `Bearer ${await accessToken()}` } });
    expect(res.status).toBe(401);
  });
});

describe('the owner principal (R-BTN-16)', () => {
  it('serves the state and the page to the owner', async () => {
    expect((await ownerCall('/v1/ui/state')).status).toBe(200);
    const page = await ownerCall('/');
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Type')).toMatch(/text\/html/);
    expect(await page.text()).toContain('<script type="module" src="/ui/app.js">');
  });

  it('refuses another email, another aud, no assertion, and a sync token', async () => {
    const as = async (token: string) => call('/v1/ui/state', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    expect((await as(await accessToken('someone@example.com'))).status).toBe(403);
    expect((await as(await accessToken('owner@example.com', { audience: 'another-app' }))).status).toBe(401);
    expect((await call('/v1/ui/state')).status).toBe(401);
    expect((await call('/')).status).toBe(401);
    expect((await as(await syncToken())).status).toBe(401);
  });

  it('G-BTN-12: a state-changing /v1/ui call needs JSON and the dashboard Origin', async () => {
    const post = (headers: Record<string, string>) => ownerCall('/v1/ui/overrides/R3-9001', { method: 'POST', headers, body: '{}' });
    expect(await code(await post({ 'Content-Type': 'application/json' }))).toBe('forbidden');
    expect(await code(await post({ 'Content-Type': 'application/json', Origin: 'https://evil.immediately.run' }))).toBe('forbidden');
    expect(await code(await post({ 'Content-Type': 'text/plain', Origin: ORIGIN }))).toBe('forbidden');
    // Both present: the request passes the middleware and reaches routing (no ui write exists yet).
    expect(await code(await post({ 'Content-Type': 'application/json', Origin: ORIGIN }))).toBe('not-found');
  });
});

describe('every response carries the R-BTN-16 headers', () => {
  it.each([
    ['an owner page', () => ownerCall('/')],
    ['the module', () => ownerCall('/ui/app.js')],
    ['an API answer', () => syncCall('/v1/sync/head')],
    ['a refusal', () => call('/v1/ui/state')],
    ['an unknown path', () => call('/nope')],
  ])('%s', async (_what, make) => {
    const res = await make();
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'self'; frame-ancestors 'none'");
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
});

describe('the test key exists only in the test bindings (§13a)', () => {
  it('wrangler.toml defines none of them', () => {
    const toml = inject('wranglerToml');
    for (const name of ['BATON_TEST_BINDINGS', 'TEST_OIDC_JWKS', 'TEST_ACCESS_JWKS', 'TEST_SIGNING_JWK']) expect(toml).not.toContain(name);
  });

  it('without BATON_TEST_BINDINGS the test key set is ignored: verification goes to the remote key set', async () => {
    const req = () => new Request(`${ORIGIN}/v1/sync/head`, { headers: { Authorization: `Bearer ${tokenNow}` } });
    const tokenNow = await syncToken();
    await expect(verifySync(req(), env)).resolves.toBeUndefined();
    // The production path fetches GitHub's key set; here that fetch fails, so the test-key
    // token cannot verify — and the failure is an outage (retry), not a bad credential.
    const prod = { ...env, BATON_TEST_BINDINGS: undefined, OIDC_JWKS_URL: 'https://jwks.invalid/keys' } as Env;
    await expect(verifySync(req(), prod)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('a key-set outage is not a credential failure', () => {
  it('a token that fails verification is 401 unauthenticated; an unreachable key set is 503 unavailable', async () => {
    const prod = { ...env, BATON_TEST_BINDINGS: undefined, OIDC_JWKS_URL: 'https://jwks.invalid/keys' } as Env;
    const req = new Request(`${ORIGIN}/v1/sync/head`, { headers: { Authorization: `Bearer ${await syncToken()}` } });
    await expect(verifySync(req, prod)).rejects.toMatchObject({ code: 'unavailable' });
    const garbage = new Request(`${ORIGIN}/v1/sync/head`, { headers: { Authorization: 'Bearer not-a-jwt' } });
    await expect(verifySync(garbage, env)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('classifies what jose throws: a key endpoint answering 503 or non-JSON is unavailable', () => {
    // jose's remote key set throws a plain JOSEError for a non-200 answer and for a body that
    // is not JSON (jwks/remote.js), JWKSTimeout for a timeout, and a TypeError for a failed fetch.
    for (const e of [new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'), new errors.JOSEError('Failed to parse the JSON Web Key Set HTTP response as JSON'), new errors.JWKSTimeout(), new errors.JWKSInvalid(), new TypeError('fetch failed')]) {
      expect(verifyFailure(e, 'OIDC').code).toBe('unavailable');
    }
    for (const e of [new errors.JWTExpired('exp', {}), new errors.JWTClaimValidationFailed('aud', {}), new errors.JWSSignatureVerificationFailed(), new errors.JWSInvalid(), new errors.JWTInvalid(), new errors.JWKSNoMatchingKey()]) {
      expect(verifyFailure(e, 'OIDC').code).toBe('unauthenticated');
    }
  });
});
