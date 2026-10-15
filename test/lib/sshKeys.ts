// sshKeys.ts — SSH keys of the four R-BTN-13 types, made with WebCrypto, and requests signed
// with them as RFC 9421 signatures whose value is an SSHSIG (PROTOCOL.sshsig), the way
// ssh-agent or `ssh-keygen -Y sign` would sign them (R3-1239, S-BTN-30). A FIDO key is played by
// a WebCrypto key that signs what the authenticator signs (PROTOCOL.u2f). Runs in Node (the
// vitest config makes the run's keys) and in workerd (the tests sign with them).
// Nothing here comes from src/: the signer is written from the specifications alone, so a test
// it passes is not the verifier agreeing with itself.

export type KeyType = 'ssh-ed25519' | 'ecdsa-sha2-nistp256' | 'sk-ssh-ed25519@openssh.com' | 'sk-ecdsa-sha2-nistp256@openssh.com';

export interface TestKey {
  name: string;
  type: KeyType;
  /** The OpenSSH public key line. */
  publicKey: string;
  fingerprint: string;
  privateJwk: JsonWebKey;
  application: string | null;
}

const enc = new TextEncoder();
const concat = (...p: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of p) out.set(x, (at += x.length) - x.length);
  return out;
};
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
/** Node's types want an ArrayBuffer-backed view; every view here is one. */
const view = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;
const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', view(b)));
const u32 = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
/** SSH's `string`. */
const sshString = (b: Uint8Array | string) => {
  const bytes = typeof b === 'string' ? enc.encode(b) : b;
  return concat(u32(bytes.length), bytes);
};
const fingerprintOf = async (blob: Uint8Array) => 'SHA256:' + b64(await sha256(blob)).replace(/=+$/, '');
/** RFC 9530: `sha-256=:…:` of the body. */
export const contentDigest = async (body: Uint8Array) => `sha-256=:${b64(await sha256(body))}:`;
/** PROTOCOL.sshsig: what the key signs. */
async function sshsigSignedData(namespace: string, hashAlg: 'sha256' | 'sha512', message: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest(hashAlg === 'sha256' ? 'SHA-256' : 'SHA-512', view(message)));
  return concat(enc.encode('SSHSIG'), sshString(namespace), sshString(''), sshString(hashAlg), sshString(h));
}
/** RFC 9421 §2.5: the signature base of the five covered components and the parameters. */
function signatureBase(m: { method: string; authority: string; path: string; query: string; digest: string; params: string }) {
  return `"@method": ${m.method}\n"@authority": ${m.authority}\n"@path": ${m.path}\n"@query": ${m.query}\n"content-digest": ${m.digest}\n"@signature-params": ${m.params}`;
}
const algOf = (type: KeyType) => (type.includes('ed25519') ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' });

/** A fresh key of `type`, registered under `name`. */
export async function makeKey(type: KeyType, name: string, application = 'ssh:'): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(algOf(type), true, ['sign', 'verify'])) as CryptoKeyPair;
  const point = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const app = type.startsWith('sk-') ? application : null;
  const blob = concat(
    sshString(type),
    ...(type.includes('ed25519') ? [sshString(point)] : [sshString('nistp256'), sshString(point)]),
    ...(app !== null ? [sshString(app)] : []),
  );
  return {
    name, type, application: app,
    publicKey: `${type} ${b64(blob)} ${name}@test`,
    fingerprint: await fingerprintOf(blob),
    privateJwk: (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey,
  };
}

/** An SSH mpint of a 32-byte big-endian integer. */
function mpint(v: Uint8Array): Uint8Array {
  let i = 0;
  while (i < v.length - 1 && v[i] === 0) i++;
  const t = v.subarray(i);
  return sshString(t[0] & 0x80 ? concat(Uint8Array.of(0), t) : t);
}

/** An SSH signature blob by `key` over `data`; a FIDO key's with `flags` and `counter`. */
async function sshSignature(key: TestKey, data: Uint8Array, flags = 0x01, counter = 7): Promise<Uint8Array> {
  // Without `alg`: Node writes "Ed25519" there, workerd wants "EdDSA"; the curve says it all.
  const { alg: _alg, ...jwk } = key.privateJwk;
  const priv = await crypto.subtle.importKey('jwk', jwk, algOf(key.type), false, ['sign']);
  const fido = key.application !== null ? concat(Uint8Array.of(flags), Uint8Array.of(0, 0, 0, counter)) : new Uint8Array();
  const message = key.application !== null
    ? concat(await sha256(enc.encode(key.application)), fido, await sha256(data))
    : data;
  const raw = new Uint8Array(key.type.includes('ed25519')
    ? await crypto.subtle.sign({ name: 'Ed25519' }, priv, view(message))
    : await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, view(message)));
  const body = key.type.includes('ed25519') ? raw : concat(mpint(raw.subarray(0, 32)), mpint(raw.subarray(32)));
  return concat(sshString(key.type), sshString(body), fido);
}

/** An SSHSIG blob by `key` over `message` in `namespace`. */
export async function sshsig(key: TestKey, message: Uint8Array, namespace = 'baton-request', hashAlg: 'sha256' | 'sha512' = 'sha512', fido?: { flags: number }): Promise<Uint8Array> {
  const blob = Uint8Array.from(atob(key.publicKey.split(' ')[1]), (c) => c.charCodeAt(0));
  const sig = await sshSignature(key, await sshsigSignedData(namespace, hashAlg, message), fido?.flags);
  return concat(enc.encode('SSHSIG'), Uint8Array.of(0, 0, 0, 1), sshString(blob), sshString(namespace), sshString(''), sshString(hashAlg), sshString(sig));
}

export interface SignOptions {
  method?: string;
  body?: string;
  /** The `@authority` the signer believes it is talking to; the URL's by default. */
  authority?: string;
  /** Epoch seconds. */
  created?: number;
  nonce?: string;
  namespace?: string;
  keyid?: string;
  tag?: string;
  hashAlg?: 'sha256' | 'sha512';
  fidoFlags?: number;
}

/** A random 128-bit nonce, base64url. */
export const randomNonce = () => b64(crypto.getRandomValues(new Uint8Array(16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A request to `url` signed by `key` (R-BTN-13): Content-Digest, Signature-Input and
 *  Signature, plus whatever `headers` it is given. */
export async function signedRequest(key: TestKey, url: string, o: SignOptions & { headers?: Record<string, string> } = {}): Promise<Request> {
  const u = new URL(url);
  const method = o.method ?? (o.body === undefined ? 'GET' : 'POST');
  const digest = await contentDigest(enc.encode(o.body ?? ''));
  const params = `("@method" "@authority" "@path" "@query" "content-digest");created=${o.created ?? Math.floor(Date.now() / 1000)};nonce="${o.nonce ?? randomNonce()}";keyid="${o.keyid ?? key.fingerprint}";tag="${o.tag ?? 'baton-request'}"`;
  const base = signatureBase({ method, authority: o.authority ?? u.host, path: u.pathname, query: u.search || '?', digest, params });
  const sig = await sshsig(key, enc.encode(base), o.namespace, o.hashAlg, o.fidoFlags === undefined ? undefined : { flags: o.fidoFlags });
  const headers = new Headers(o.headers);
  if (o.body !== undefined) headers.set('Content-Type', 'application/json');
  headers.set('Content-Digest', digest);
  headers.set('Signature-Input', `sig1=${params}`);
  headers.set('Signature', `sig1=:${b64(sig)}:`);
  return new Request(url, { method, headers, body: o.body });
}
