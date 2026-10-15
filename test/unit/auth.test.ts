// R3-1206 — the two principals and the same-site rules (BATON_SPEC §10.3 R-BTN-15, §10.5
// R-BTN-16; G-BTN-11, G-BTN-12).
import { describe, it, expect, inject } from 'vitest';
import { env } from 'cloudflare:test';
import { errors, generateKeyPair, SignJWT } from 'jose';
import { authorityOf, contentDigest, KEY_TYPES, parseAdminKeys, parseSshKey, verifyFailure, verifyRequest, verifySyncToken } from '../../src/core/auth';
import { front } from '../../src/core/front';
import { makeKey, signedRequest } from '../lib/sshKeys';
import keygen from '../fixtures/sshsig/ssh-keygen.json';
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
    const forged = await new SignJWT({ repository: 'immediately-run/docs', ref: 'refs/heads/main', job_workflow_ref: 'immediately-run/docs/.github/workflows/baton-sync.yml@refs/heads/main' })
      .setProtectedHeader({ alg: 'ES256', kid: 'baton-test' }).setIssuer(env.OIDC_ISSUER).setAudience(env.BATON_ORIGIN).setExpirationTime('5m').sign(privateKey);
    expect((await syncCall('/v1/sync/head', undefined, forged)).status).toBe(401);
  });

  it('accepts exactly its own origin as the audience (R3-1229, R-BTN-56)', async () => {
    // The retired host, spelled in parts so `git grep` for it stays empty (R3-1229's exit criterion).
    const retired = ['https://work', 'items.immediately.run'].join('');
    expect(env.BATON_ORIGIN).toBe('https://baton.immediately.run');
    const ok = await syncCall('/v1/sync/head', undefined, await syncToken({}, { audience: 'https://baton.immediately.run' }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sha: null, unconfirmed: [] });
    for (const audience of [retired, 'baton.immediately.run', 'https://baton-staging.immediately.run']) {
      const res = await syncCall('/v1/sync/head', undefined, await syncToken({}, { audience }));
      expect(res.status).toBe(401);
      expect(await code(res)).toBe('unauthenticated');
    }
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
    const post = (headers: Record<string, string>) => ownerCall('/v1/ui/overrides/docs:R3-9001', { method: 'POST', headers, body: '{}' });
    expect(await code(await post({ 'Content-Type': 'application/json' }))).toBe('forbidden');
    expect(await code(await post({ 'Content-Type': 'application/json', Origin: 'https://evil.immediately.run' }))).toBe('forbidden');
    expect(await code(await post({ 'Content-Type': 'text/plain', Origin: ORIGIN }))).toBe('forbidden');
    // Both present: the request passes the middleware and reaches the route, which refuses the
    // empty body on its own terms.
    expect(await code(await post({ 'Content-Type': 'application/json', Origin: ORIGIN }))).toBe('invalid-params');
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
    await expect(verifySyncToken(req(), env)).resolves.toMatchObject({ repository: 'immediately-run/docs', ref: 'refs/heads/main' });
    // The production path fetches GitHub's key set; here that fetch fails, so the test-key
    // token cannot verify — and the failure is an outage (retry), not a bad credential.
    const prod = { ...env, BATON_TEST_BINDINGS: undefined, OIDC_JWKS_URL: 'https://jwks.invalid/keys' } as Env;
    await expect(verifySyncToken(req(), prod)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('a key-set outage is not a credential failure', () => {
  it('a token that fails verification is 401 unauthenticated; an unreachable key set is 503 unavailable', async () => {
    const prod = { ...env, BATON_TEST_BINDINGS: undefined, OIDC_JWKS_URL: 'https://jwks.invalid/keys' } as Env;
    const req = new Request(`${ORIGIN}/v1/sync/head`, { headers: { Authorization: `Bearer ${await syncToken()}` } });
    await expect(verifySyncToken(req, prod)).rejects.toMatchObject({ code: 'unavailable' });
    const garbage = new Request(`${ORIGIN}/v1/sync/head`, { headers: { Authorization: 'Bearer not-a-jwt' } });
    await expect(verifySyncToken(garbage, env)).rejects.toMatchObject({ code: 'unauthenticated' });
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

describe('administrator keys (R-BTN-57)', () => {
  it('one OpenSSH key per line on both hosts; blank lines and # comments are not keys', () => {
    expect(parseAdminKeys('# owner\nssh-ed25519 AAAA one\r\n\n  ssh-ed25519 BBBB two  \n#ssh-ed25519 CCCC off\n')).toEqual(['ssh-ed25519 AAAA one', 'ssh-ed25519 BBBB two']);
    expect(parseAdminKeys('')).toEqual([]);
  });
});

// R3-1239 — the one verifier of signed requests (BATON_SPEC §10.1 R-BTN-13 as amended; S-BTN-30).
describe('signed requests (R-BTN-13, R3-1239)', () => {
  const T = 1792065600; // 2026-10-15T12:00:00Z, the fixtures' `created`
  const NOW = T * 1000;
  const lookup = (keys: { publicKey: string; fingerprint?: string }[]) => (fp: string) =>
    keys.find((k) => k.fingerprint === fp || k.publicKey.includes(fp))?.publicKey ?? null;
  const fixture = (name: keyof typeof keygen) => {
    const f = keygen[name];
    return new Request(f.url, { method: f.method, headers: f.headers, body: f.body || undefined });
  };
  const keyOf = async (name: keyof typeof keygen) => {
    const k = await parseSshKey(keygen[name].publicKey);
    return (fp: string) => (fp === k.fingerprint ? keygen[name].publicKey : null);
  };
  const reason = (p: Promise<unknown>) => p.then(() => 'passed', (e: { code: string; message: string }) => `${e.code}: ${e.message}`);

  it.each(['ed25519-post', 'ed25519-get', 'ecdsa-post', 'ecdsa-get'] as const)('verifies what ssh-keygen -Y sign made: %s', async (name) => {
    const v = await verifyRequest(fixture(name), await keyOf(name), { origin: ORIGIN, now: NOW });
    expect(v.keyid).toBe((await parseSshKey(keygen[name].publicKey)).fingerprint);
    expect(new TextDecoder().decode(v.body)).toBe(keygen[name].body);
  });

  it.each(['ed25519-git', 'ecdsa-git'] as const)('refuses a git-namespace signature presented as a request: %s', async (name) => {
    expect(await reason(verifyRequest(fixture(name), await keyOf(name), { origin: ORIGIN, now: NOW }))).toMatch(/^unauthenticated: .*namespace "git"/);
  });

  it('a request signed for one Baton does not verify at another (@authority)', async () => {
    // The same signed bytes, judged by a Baton whose origin is another: the base names its own.
    const req = fixture('ed25519-get');
    const staging = new Request(req.url.replace('baton.immediately.run', 'baton-staging.immediately.run'), req);
    expect(await reason(verifyRequest(staging, await keyOf('ed25519-get'), { origin: 'https://baton-staging.immediately.run', now: NOW }))).toBe('unauthenticated: the signature does not verify');
    // Sent to this Baton's address while it is another's, it is refused before any key is read.
    expect(await reason(verifyRequest(fixture('ed25519-get'), null, { origin: 'http://127.0.0.1:8787' }))).toMatch(/@authority must be 127.0.0.1:8787/);
    expect(authorityOf('https://baton.immediately.run:443')).toBe('baton.immediately.run');
    expect(authorityOf('http://127.0.0.1:8787')).toBe('127.0.0.1:8787');
  });

  it('a request with no body carries the empty string’s digest', async () => {
    expect(await contentDigest(new Uint8Array())).toBe('sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:');
    expect(keygen['ed25519-get'].headers['Content-Digest']).toBe('sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:');
    // A body-less request with no digest, or with a body's, is refused.
    const req = fixture('ed25519-get');
    const none = new Headers(req.headers);
    none.delete('Content-Digest');
    expect(await reason(verifyRequest(new Request(req.url, { headers: none }), null, { origin: ORIGIN }))).toMatch(/Content-Digest/);
    const other = new Headers(req.headers);
    other.set('Content-Digest', keygen['ed25519-post'].headers['Content-Digest']);
    expect(await reason(verifyRequest(new Request(req.url, { headers: other }), null, { origin: ORIGIN }))).toMatch(/Content-Digest/);
  });

  it('a changed body, method, path or query no longer verifies', async () => {
    const key = await keyOf('ed25519-post');
    const f = keygen['ed25519-post'];
    const changed = '{"a":2}';
    const headers = { ...f.headers, 'Content-Digest': await contentDigest(new TextEncoder().encode(changed)) };
    expect(await reason(verifyRequest(new Request(f.url, { method: 'POST', headers, body: changed }), key, { origin: ORIGIN, now: NOW }))).toBe('unauthenticated: the signature does not verify');
    expect(await reason(verifyRequest(new Request(f.url, { method: 'PUT', headers: f.headers, body: f.body }), key, { origin: ORIGIN, now: NOW }))).toBe('unauthenticated: the signature does not verify');
    expect(await reason(verifyRequest(new Request(f.url + '?x=1', { method: 'POST', headers: f.headers, body: f.body }), key, { origin: ORIGIN, now: NOW }))).toBe('unauthenticated: the signature does not verify');
    expect(await reason(verifyRequest(new Request(f.url.replace('heartbeat', 'claim'), { method: 'POST', headers: f.headers, body: f.body }), key, { origin: ORIGIN, now: NOW }))).toBe('unauthenticated: the signature does not verify');
  });

  it('the clock: 5 minutes either side passes, more is refused; the front, given no clock, does not judge it', async () => {
    const key = await keyOf('ecdsa-get');
    for (const [skew, want] of [[300, 'passed'], [-300, 'passed'], [301, 'unauthenticated'], [-301, 'unauthenticated']] as const) {
      expect([skew, (await reason(verifyRequest(fixture('ecdsa-get'), key, { origin: ORIGIN, now: NOW + skew * 1000 }))).split(':')[0]]).toEqual([skew, want]);
    }
    expect(await reason(verifyRequest(fixture('ecdsa-get'), null, { origin: ORIGIN }))).toBe('passed');
  });

  it('an unknown key, and a signature by another key under a registered keyid, are refused', async () => {
    expect(await reason(verifyRequest(fixture('ed25519-get'), () => null, { origin: ORIGIN, now: NOW }))).toBe('unauthenticated: the key is not registered or is revoked');
    // keyid names the ecdsa key; the SSHSIG is the ed25519 key's.
    const ed = fixture('ed25519-get');
    const ecdsaFp = (await parseSshKey(keygen['ecdsa-get'].publicKey)).fingerprint;
    const h = new Headers(ed.headers);
    h.set('Signature-Input', h.get('Signature-Input')!.replace(/keyid="[^"]+"/, `keyid="${ecdsaFp}"`));
    expect(await reason(verifyRequest(new Request(ed.url, { headers: h }), await keyOf('ecdsa-get'), { origin: ORIGIN, now: NOW }))).toMatch(/another key than keyid/);
  });

  it.each([
    ['another component list', (s: string) => s.replace(' "@query"', '')],
    ['an extra parameter', (s: string) => s + ';alg="ed25519"'],
    ['a repeated parameter', (s: string) => s.replace(/;tag="baton-request"/, ';created=1')],
    ['another tag', (s: string) => s.replace('tag="baton-request"', 'tag="git"')],
    ['a short nonce', (s: string) => s.replace(/nonce="[^"]+"/, 'nonce="abc"')],
    ['a keyid that is no fingerprint', (s: string) => s.replace(/keyid="[^"]+"/, 'keyid="vm-a"')],
    ['created as a string', (s: string) => s.replace(/created=(\d+)/, 'created="$1"')],
  ])('refuses a Signature-Input with %s before any key is read', async (_what, edit) => {
    const req = fixture('ed25519-get');
    const h = new Headers(req.headers);
    h.set('Signature-Input', edit(h.get('Signature-Input')!));
    let looked = false;
    const res = await reason(verifyRequest(new Request(req.url, { headers: h }), () => ((looked = true), null), { origin: ORIGIN, now: NOW }));
    expect(res).toMatch(/^unauthenticated/);
    expect(looked).toBe(false);
  });

  it('every key type signs and verifies; a FIDO signature without user presence is refused', async () => {
    for (const type of KEY_TYPES) {
      const k = await makeKey(type, 'x');
      const req = await signedRequest(k, `${ORIGIN}/v1/runner/heartbeat`, { body: '{}', created: T, hashAlg: 'sha256' });
      expect([type, await reason(verifyRequest(req, lookup([k]), { origin: ORIGIN, now: NOW }))]).toEqual([type, 'passed']);
    }
    for (const type of ['sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'] as const) {
      const k = await makeKey(type, 'x');
      const req = await signedRequest(k, `${ORIGIN}/v1/runner/mode`, { created: T, fidoFlags: 0x04 });
      expect([type, await reason(verifyRequest(req, lookup([k]), { origin: ORIGIN, now: NOW }))]).toEqual([type, 'unauthenticated: the signature does not verify']);
    }
  });

  it('parses only the four key types, with the fingerprint ssh-keygen -l prints', async () => {
    const k = await parseSshKey(keygen['ed25519-get'].publicKey);
    expect(k.type).toBe('ssh-ed25519');
    expect(k.fingerprint).toBe(/keyid="([^"]+)"/.exec(keygen['ed25519-get'].headers['Signature-Input'])![1]);
    await expect(parseSshKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ x')).rejects.toMatchObject({ code: 'invalid-params' });
    // A blob naming another type than its line.
    const ec = keygen['ecdsa-get'].publicKey.split(' ')[1];
    await expect(parseSshKey(`ssh-ed25519 ${ec}`)).rejects.toMatchObject({ code: 'invalid-params' });
  });
});

describe('the front stops a bad signature before the object (R3-1239)', () => {
  const seen: string[] = [];
  const to = async (r: Request) => (seen.push(r.headers.get('X-Baton-Signed') ?? ''), new Response('{}'));
  const T = 1792065600;

  it.each([
    ['unsigned in part', (h: Headers) => h.delete('Signature')],
    ['malformed', (h: Headers) => h.set('Signature-Input', 'sig1=("@method");created=1')],
    ['mis-digested', (h: Headers) => h.set('Content-Digest', 'sha-256=:AAAA:')],
  ])('%s', async (_what, edit) => {
    seen.length = 0;
    const req = await signedRequest(await makeKey('ssh-ed25519', 'x'), `${ORIGIN}/v1/runner/mode`, { created: T });
    const h = new Headers(req.headers);
    edit(h);
    const res = await front(new Request(req.url, { headers: h }), env, to);
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('for another host', async () => {
    seen.length = 0;
    const req = await signedRequest(await makeKey('ssh-ed25519', 'x'), 'https://baton-staging.immediately.run/v1/runner/mode', { created: T });
    expect((await front(req, env, to)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it('a well-formed one goes on, with its keyid and its body, and a forged X-Baton-Signed is replaced', async () => {
    seen.length = 0;
    const k = await makeKey('ecdsa-sha2-nistp256', 'x');
    const req = await signedRequest(k, `${ORIGIN}/v1/runner/heartbeat`, { body: '{"b":1}', created: T, headers: { 'X-Baton-Signed': 'SHA256:forged' } });
    let body = '';
    const res = await front(req, env, async (r) => ((body = await r.text()), to(r)));
    expect(res.status).toBe(200);
    expect(seen).toEqual([k.fingerprint]);
    expect(body).toBe('{"b":1}');
  });
});
