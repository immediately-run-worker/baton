// sign.mjs — a request signed by an SSH key, as Baton's one verifier checks it (BATON_SPEC §10.1
// R-BTN-13 as amended; §10.6): an RFC 9421 `Signature-Input` and `Signature` over `@method`,
// `@authority`, `@path`, `@query` and `content-digest`, whose value is an SSHSIG in the namespace
// `baton-request`, made by `ssh-keygen -Y sign`. The key is the file `-i` names — an administrator's
// or an owner's key, kept out of every agent's ssh-agent (R-BTN-57) — or a public key whose private
// half ssh-agent holds. The private key never reaches stdout, stderr or an argument list.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';

export const NAMESPACE = 'baton-request';

/** The key at `file`: `{file, fingerprint}`, or throws. */
export function signingKey(file) {
  const r = spawnSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', file], { encoding: 'utf8' });
  const fingerprint = r.status === 0 ? /\b(SHA256:[A-Za-z0-9+/]{43})\b/.exec(r.stdout)?.[1] : null;
  if (!fingerprint) throw new Error(`${file} is not an SSH key ssh-keygen can read${r.error ? ` (${r.error.code})` : ''}`);
  return { file, fingerprint };
}

/** `Content-Digest` (RFC 9530): sha-256 of the body. */
export function contentDigest(body = '') {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

/** The RFC 9421 signature base Baton rebuilds. */
export function signatureBase({ method, url, digest, params }) {
  const u = new URL(url);
  return [
    `"@method": ${method.toUpperCase()}`,
    `"@authority": ${u.host.toLowerCase()}`,
    `"@path": ${u.pathname}`,
    `"@query": ${u.search || '?'}`,
    `"content-digest": ${digest}`,
    `"@signature-params": ${params}`,
  ].join('\n');
}

/** The headers that sign one request with `key`. `now` is epoch milliseconds. */
export function signHeaders({ method, url, body, key, now = Date.now() }) {
  const digest = contentDigest(body ?? '');
  const nonce = randomBytes(16).toString('base64url');
  const params = `("@method" "@authority" "@path" "@query" "content-digest");created=${Math.floor(now / 1000)};nonce="${nonce}";keyid="${key.fingerprint}";tag="${NAMESPACE}"`;
  const base = signatureBase({ method, url, digest, params });
  const r = spawnSync('ssh-keygen', ['-Y', 'sign', '-f', key.file, '-n', NAMESPACE, '-q'], { input: base, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ssh-keygen -Y sign failed (${(r.stderr || r.error?.code || '').trim().split('\n')[0]})`);
  const blob = r.stdout.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
  return { 'Content-Digest': digest, 'Signature-Input': `sig1=${params}`, Signature: `sig1=:${blob}:` };
}
