// auth.ts — Baton's principals (BATON_SPEC §10.1): the board sync, by GitHub
// Actions OIDC (R-BTN-15), and the owner, by Cloudflare Access (R-BTN-16) — and machines, by
// SSH-signed requests (R-BTN-13 as amended, below). Nothing but a verified JWT or signature is
// trusted: no header, cookie or query parameter stands in for one.
import { createLocalJWKSet, createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { BatonError } from './http';
import type { Config } from './ports';
import type { SyncClaims } from './registry';
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
function testKeys(env: Config, jwks: string | undefined): JWTVerifyGetKey | null {
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
 * The sync principal (R-BTN-15): a GitHub Actions OIDC token for this Baton — issuer and
 * audience (its own origin, R-BTN-56) checked here, before the core. Which repository it acts
 * for, and whether its workflow and branch are that repository's sync or mirror, the core
 * decides from its registry (`Registry.forSync`), so a token reaches only its own board.
 * Returns the claims that bind it.
 */
export async function verifySyncToken(req: Request, env: Config): Promise<SyncClaims> {
  const token = bearer(req);
  if (!token) throw new BatonError('unauthenticated', 'an OIDC bearer token is required');
  const keys = testKeys(env, env.TEST_OIDC_JWKS) ?? remote(env.OIDC_JWKS_URL);
  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, keys, { issuer: env.OIDC_ISSUER, audience: env.BATON_ORIGIN }));
  } catch (e) {
    throw verifyFailure(e, 'OIDC');
  }
  const { repository, ref, job_workflow_ref } = claims;
  if (typeof repository !== 'string' || typeof ref !== 'string' || typeof job_workflow_ref !== 'string') {
    throw new BatonError('forbidden', 'the OIDC token names no repository, ref and workflow');
  }
  return { repository, ref, job_workflow_ref };
}

/**
 * The owner principal (R-BTN-16): the Access JWT in `Cf-Access-Jwt-Assertion`, verified
 * against the team's certs with the application's `aud`, for an email in OWNER_EMAILS.
 * Returns that email.
 */
export async function verifyOwner(req: Request, env: Config): Promise<string> {
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
export function checkStateChanging(req: Request, env: Config): void {
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' || req.headers.get('Origin') !== env.BATON_ORIGIN) {
    throw new BatonError('forbidden', 'a state-changing request needs Content-Type: application/json and the dashboard Origin');
  }
}

/** The worker principal (§10.1, R-BTN-13): a bearer token whose SHA-256 is one of the
 *  `TOKEN_HASHES` Worker secret's values (`{credential id: hex}`). Returns that credential id.
 *  Revoking a token is deleting its hash; the credential's policy (hostname, allowed
 *  capabilities) is the `CREDENTIALS` secret, which the object mirrors into `credentials`. */
export async function verifyWorker(req: Request, env: Config): Promise<string> {
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
    if (equalBytes(presented, want)) match = id;
  }
  if (!match) throw new BatonError('unauthenticated', 'unknown worker token');
  return match;
}

/** Constant-time equality of two byte strings: every byte is compared whatever differs, so the
 *  time says nothing about where. Portable, where `crypto.subtle.timingSafeEqual` is
 *  Cloudflare's alone (R-BTN-55). */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** The administrators' keys (R-BTN-57) from `BATON_ADMIN_KEYS` or an `--admin-keys` file: one
 *  OpenSSH public key per line; blank lines and `#` comments are not keys. Both hosts read
 *  them through this one parse. */
export function parseAdminKeys(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// ── signed requests (§10.1 R-BTN-13 as amended; R3-1239) ──────────────────────────────────
// A machine's identity is an SSH key. Every call it makes carries an RFC 9421 signature whose
// value is an SSHSIG (OpenSSH PROTOCOL.sshsig) in the `baton-request` namespace, so ssh-agent
// and `ssh-keygen -Y sign` can make it for every key type, and no git signature made with the
// same key can pass for one. This is the one verifier: the front runs it without a key or a
// clock (shape, `@authority`, digest) and the core runs it whole, then checks the nonce.

/** The four key types (R-BTN-13): Ed25519, P-256 (the Secure Enclave's), and their FIDO forms. */
export const KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'] as const;
export type KeyType = (typeof KEY_TYPES)[number];
export const REQUEST_NAMESPACE = 'baton-request';
/** `created` may be this far either side of Baton's clock. */
export const SIGNATURE_WINDOW_MS = 5 * 60_000;
/** A nonce is remembered this long per key: the window on both sides of the clock, so no
 *  request that could carry it is still fresh once it is forgotten. */
export const NONCE_TTL_MS = 10 * 60_000;
/** A signed body is read whole to digest it; no API body comes near this. */
export const MAX_SIGNED_BODY = 1 << 20;

const LABEL_AND_PARAMS = /^([a-z][a-z0-9_-]{0,31})=(\("@method" "@authority" "@path" "@query" "content-digest"\)((?:;[a-z]+=(?:"[\x20\x21\x23-\x5b\x5d-\x7e]*"|[0-9]{1,15})){4}))$/;
const PARAM = /;([a-z]+)=(?:"([\x20\x21\x23-\x5b\x5d-\x7e]*)"|([0-9]{1,15}))/g;
const NONCE = /^[A-Za-z0-9+/_=-]{22,64}$/;
export const KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SSHSIG_MAGIC = new TextEncoder().encode('SSHSIG');

const unauthenticated = (why: string) => new BatonError('unauthenticated', why);

/** Standard base64, padded; anything else (a length that is no multiple of 4 included) throws
 *  a plain Error for the caller to name. */
function b64decode(s: string): Uint8Array {
  if (s.length % 4 !== 0 || !B64.test(s)) throw new Error('not base64');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64encode(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, (at += p.length) - p.length);
  return out;
}
function u32(n: number): Uint8Array {
  return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}
/** SSH's `string`: a uint32 length and the bytes. */
export function sshString(b: Uint8Array | string): Uint8Array {
  const bytes = typeof b === 'string' ? new TextEncoder().encode(b) : b;
  return concat(u32(bytes.length), bytes);
}
/** Node's WebCrypto types want an ArrayBuffer-backed view; every view here is one. */
const view = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
async function sha(alg: 'SHA-256' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, view(data)));
}

/** A reader of SSH wire encoding; any overrun is a malformed blob. */
class Wire {
  private at = 0;
  constructor(private readonly b: Uint8Array) {}
  bytes(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.b.length) throw new Error('truncated');
    return this.b.subarray(this.at, (this.at += n));
  }
  u32(): number {
    const v = this.bytes(4);
    return ((v[0] << 24) | (v[1] << 16) | (v[2] << 8) | v[3]) >>> 0;
  }
  string(): Uint8Array {
    return this.bytes(this.u32());
  }
  text(): string {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(this.string());
  }
  end(): void {
    if (this.at !== this.b.length) throw new Error('trailing bytes');
  }
}

/** A parsed OpenSSH public key. */
export interface SshKey {
  type: KeyType;
  /** The wire blob: what the fingerprint hashes and an SSHSIG names. */
  blob: Uint8Array;
  /** Ed25519's 32 bytes, or P-256's uncompressed point. */
  point: Uint8Array;
  /** A FIDO key's application (`ssh:` by default); null for the others. */
  application: string | null;
  /** `SHA256:` and the unpadded base64 of the blob's SHA-256, as `ssh-keygen -l` prints it. */
  fingerprint: string;
}

/** An OpenSSH public key line (`type base64 [comment]`) of one of the four types, or throws
 *  `invalid-params`. */
export async function parseSshKey(text: string): Promise<SshKey> {
  const bad = (why: string) => new BatonError('invalid-params', `not an OpenSSH public key of an R-BTN-13 type: ${why}`);
  const m = /^(\S+) (\S+)(?: [^\r\n]*)?$/.exec(text.trim());
  if (!m || !(KEY_TYPES as readonly string[]).includes(m[1])) throw bad('the type is not one of ' + KEY_TYPES.join(', '));
  if (!B64.test(m[2]) || m[2].length > 1024) throw bad('the key is not base64');
  const type = m[1] as KeyType;
  try {
    const blob = b64decode(m[2]);
    const w = new Wire(blob);
    if (w.text() !== type) throw new Error('the blob names another type');
    let point: Uint8Array;
    if (type.includes('ed25519')) {
      point = w.string();
      if (point.length !== 32) throw new Error('an Ed25519 key is 32 bytes');
    } else {
      if (w.text() !== 'nistp256') throw new Error('the curve is not nistp256');
      point = w.string();
      if (point.length !== 65 || point[0] !== 4) throw new Error('not an uncompressed P-256 point');
    }
    const application = type.startsWith('sk-') ? w.text() : null;
    w.end();
    return { type, blob, point, application, fingerprint: await fingerprintOf(blob) };
  } catch (e) {
    throw bad(e instanceof Error ? e.message : 'malformed');
  }
}

/** The key's fingerprint, as `ssh-keygen -l` prints it. */
export async function fingerprintOf(blob: Uint8Array): Promise<string> {
  return 'SHA256:' + b64encode(await sha('SHA-256', blob)).replace(/=+$/, '');
}

/** An SSH ECDSA signature's two mpints as WebCrypto's raw r‖s, 32 bytes each. */
function ecdsaRaw(sig: Uint8Array): Uint8Array {
  const w = new Wire(sig);
  const fixed = (mp: Uint8Array) => {
    let i = 0;
    while (i < mp.length - 1 && mp[i] === 0) i++;
    const v = mp.subarray(i);
    if (v.length > 32) throw new Error('mpint too long');
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = fixed(w.string());
  const s = fixed(w.string());
  w.end();
  return concat(r, s);
}

/** An SSH signature (`string type, string blob` and, for a FIDO key, its flags and counter) by
 *  `key` over `data`. A FIDO signature covers sha256(application)‖flags‖counter‖sha256(data)
 *  (PROTOCOL.u2f), and must assert the user's presence, as OpenSSH requires by default. */
async function verifySshSignature(key: SshKey, sig: Uint8Array, data: Uint8Array): Promise<boolean> {
  try {
    const w = new Wire(sig);
    if (w.text() !== key.type) return false;
    const raw = w.string();
    let message = data;
    if (key.application !== null) {
      const flags = w.bytes(1);
      const counter = w.bytes(4);
      if (!(flags[0] & 0x01)) return false;
      message = concat(await sha('SHA-256', new TextEncoder().encode(key.application)), flags, counter, await sha('SHA-256', data));
    }
    w.end();
    if (key.type.includes('ed25519')) {
      if (raw.length !== 64) return false;
      const k = await crypto.subtle.importKey('raw', view(key.point), { name: 'Ed25519' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'Ed25519' }, k, view(raw), view(message));
    }
    const k = await crypto.subtle.importKey('raw', view(key.point), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, view(ecdsaRaw(raw)), view(message));
  } catch {
    return false;
  }
}

/** The data an SSHSIG signs (PROTOCOL.sshsig): the preamble, the namespace, the reserved field,
 *  the hash algorithm and the message's hash under it. */
export async function sshsigSignedData(namespace: string, hashAlg: 'sha256' | 'sha512', message: Uint8Array, reserved: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
  const h = await sha(hashAlg === 'sha256' ? 'SHA-256' : 'SHA-512', message);
  return concat(SSHSIG_MAGIC, sshString(namespace), sshString(reserved), sshString(hashAlg), sshString(h));
}

/** An SSHSIG blob by `key` over `message` in the `baton-request` namespace. */
async function verifySshsig(key: SshKey, blob: Uint8Array, message: Uint8Array): Promise<void> {
  let ns: string, reserved: Uint8Array, hashAlg: string, signature: Uint8Array;
  try {
    const w = new Wire(blob);
    const magic = w.bytes(6);
    if (!magic.every((b, i) => b === SSHSIG_MAGIC[i]) || w.u32() !== 1) throw new Error('not an SSHSIG v1');
    const pk = w.string();
    if (!equalBytes(pk, key.blob)) throw unauthenticated('the signature names another key than keyid');
    ns = w.text();
    reserved = w.string();
    hashAlg = w.text();
    signature = w.string();
    w.end();
  } catch (e) {
    if (e instanceof BatonError) throw e;
    throw unauthenticated('the Signature is not an SSHSIG');
  }
  // Namespace before anything else: a git commit's signature, or any other made with this key,
  // is never a request's.
  if (ns !== REQUEST_NAMESPACE) throw unauthenticated(`the signature is in the namespace ${JSON.stringify(ns.slice(0, 64))}, not ${REQUEST_NAMESPACE}`);
  if (hashAlg !== 'sha256' && hashAlg !== 'sha512') throw unauthenticated('the SSHSIG hash is neither sha256 nor sha512');
  const data = await sshsigSignedData(ns, hashAlg, message, reserved);
  if (!(await verifySshSignature(key, signature, data))) throw unauthenticated('the signature does not verify');
}

/** An origin's RFC 9421 `@authority`: its host, lower-case, and its port only when not the
 *  scheme's default (§3a; RFC 9421 §2.2.3) — what `URL.host` gives. */
export function authorityOf(origin: string): string {
  return new URL(origin).host.toLowerCase();
}

/** A request whose signature passed: the key's fingerprint, its nonce, and the body it read
 *  (a verified request's body is consumed; the caller sends this on). */
export interface SignedRequest {
  keyid: string;
  nonce: string;
  created: number;
  body: Uint8Array;
}

/** The signature base (RFC 9421 §2.5) of a Baton request: the five components, then the
 *  parameters exactly as `Signature-Input` serialised them. */
export function signatureBase(m: { method: string; authority: string; path: string; query: string; digest: string; params: string }): string {
  return [
    `"@method": ${m.method}`,
    `"@authority": ${m.authority}`,
    `"@path": ${m.path}`,
    `"@query": ${m.query}`,
    `"content-digest": ${m.digest}`,
    `"@signature-params": ${m.params}`,
  ].join('\n');
}

/** `Content-Digest` (RFC 9530) of a body: its SHA-256, the empty string's for none. */
export async function contentDigest(body: Uint8Array): Promise<string> {
  return `sha-256=:${b64encode(await sha('SHA-256', body))}:`;
}

/**
 * The one verifier of a signed request (R-BTN-13 as amended). It refuses (`unauthenticated`)
 * an unsigned or malformed request, one whose `@authority` is not `origin`'s, a body whose
 * `Content-Digest` is not its own, and — given `now` — a `created` more than 5 minutes either
 * side of it; given `lookupKey` (the public key a fingerprint names, null for an unknown or
 * revoked one), an unknown key or a signature that is not that key's SSHSIG over this request
 * in the `baton-request` namespace. The base always takes `@authority` from `origin`, so a
 * request signed for another Baton never verifies here. The nonce is the caller's: it is
 * Baton's state, checked in the caller's own turn.
 */
export async function verifyRequest(
  req: Request,
  lookupKey: ((fingerprint: string) => string | null) | null,
  opts: { origin: string; now?: number },
): Promise<SignedRequest> {
  const input = req.headers.get('Signature-Input');
  const sigHeader = req.headers.get('Signature');
  if (!input || !sigHeader) throw unauthenticated('a signed request (Signature-Input and Signature) is required');
  const m = LABEL_AND_PARAMS.exec(input.trim());
  if (!m) throw unauthenticated('Signature-Input must cover exactly ("@method" "@authority" "@path" "@query" "content-digest") with created, nonce, keyid and tag');
  const [, label, params, list] = m;
  const p: Record<string, string> = {};
  for (const [, name, str, int] of list.matchAll(PARAM)) {
    if (Object.hasOwn(p, name)) throw unauthenticated(`Signature-Input repeats ${name}`);
    p[name] = str ?? int;
  }
  const isInt = (name: string) => /^[0-9]+$/.test(p[name] ?? '') && !list.includes(`;${name}="`);
  const isStr = (name: string) => list.includes(`;${name}="`);
  if (!isInt('created') || !isStr('nonce') || !isStr('keyid') || !isStr('tag')) throw unauthenticated('Signature-Input needs created (an integer), nonce, keyid and tag, and nothing else');
  if (p.tag !== REQUEST_NAMESPACE) throw unauthenticated(`the signature's tag must be "${REQUEST_NAMESPACE}"`);
  if (!NONCE.test(p.nonce)) throw unauthenticated('the nonce must be 128 random bits, encoded');
  if (!KEY_FINGERPRINT.test(p.keyid)) throw unauthenticated('keyid must be the key fingerprint, SHA256:…');
  const sm = /^([a-z][a-z0-9_-]{0,31})=:([A-Za-z0-9+/]+={0,2}):$/.exec(sigHeader.trim());
  if (!sm || sm[1] !== label || sm[2].length > 4096) throw unauthenticated(`Signature must carry the ${label} signature as a byte sequence`);

  const url = new URL(req.url);
  const authority = authorityOf(opts.origin);
  // A request sent to another host than this Baton's own is not for it.
  if (url.host.toLowerCase() !== authority) throw unauthenticated(`@authority must be ${authority}`);
  const created = Number(p.created) * 1000;
  if (opts.now !== undefined && Math.abs(opts.now - created) > SIGNATURE_WINDOW_MS) throw unauthenticated('the signature is older or newer than 5 minutes');

  const body = await readCapped(req, MAX_SIGNED_BODY);
  const digest = req.headers.get('Content-Digest') ?? '';
  if (digest !== (await contentDigest(body))) throw unauthenticated('Content-Digest must be sha-256 of the body (of the empty string when there is none)');
  const signed: SignedRequest = { keyid: p.keyid, nonce: p.nonce, created, body };
  if (!lookupKey) return signed;

  const text = lookupKey(p.keyid);
  if (!text) throw unauthenticated('the key is not registered or is revoked');
  let key: SshKey;
  try {
    key = await parseSshKey(text);
  } catch {
    throw unauthenticated('the registered key is unreadable');
  }
  if (key.fingerprint !== p.keyid) throw unauthenticated('keyid does not name this key');
  const base = signatureBase({ method: req.method, authority, path: url.pathname, query: url.search || '?', digest, params });
  let blob: Uint8Array;
  try {
    blob = b64decode(sm[2]);
  } catch {
    throw unauthenticated('the Signature is not base64');
  }
  await verifySshsig(key, blob, new TextEncoder().encode(base));
  return signed;
}

/** A request's body, refused `invalid-params` as soon as it passes `max` bytes — by its
 *  Content-Length before a byte is read, else while it streams — so no body is buffered whole
 *  before its size is judged. */
async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const tooLarge = () => new BatonError('invalid-params', 'the body is too large');
  if (Number(req.headers.get('Content-Length') ?? 0) > max) throw tooLarge();
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

/** A verified request with its body put back, for the handler to read. */
export function withBody(req: Request, body: Uint8Array, headers: Headers = req.headers): Request {
  return new Request(req.url, { method: req.method, headers, body: body.length && req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(body) : undefined });
}
