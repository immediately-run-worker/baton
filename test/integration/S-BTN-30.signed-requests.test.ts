// S-BTN-30 signed requests (BATON_SPEC §13a, §10.1 R-BTN-13 as amended; G-BTN-55; R3-1239): a
// worker's request is an RFC 9421 signature whose value is an SSHSIG in the `baton-request`
// namespace, by a registered key of one of the four types. Must hold: a replay within 5 minutes,
// one signed 6 minutes ago and one by a revoked key are refused `unauthenticated`; a request
// signed for the local host and replayed to this one is refused (`@authority`); a commit
// signature presented as a request's is refused (namespace); fresh signed requests by every key
// type pass, with and without a body. Runs on both hosts.
//
// Two clauses wait for the routes they exercise: the probe's out-of-binding reading for
// R3-1251 (probes and instances) and the administrator's key for R3-1240 (`/v1/admin/*`).
import { describe, it, expect, beforeEach } from 'vitest';
import { HOST, ORIGIN, call, hbBody, register, rows, setClock, sha256, signedCall, SSH_KEYS, withCore } from '../helpers';
import { makeKey, signedRequest } from '../lib/sshKeys';
import { WorkerApi } from '../../src/core/workerApi';
import { call as hostCall, config } from '#host';

const T0 = Date.parse('2026-10-15T12:00:00Z');
const NAMES = ['vm-ed', 'vm-p256', 'vm-sk-ed', 'vm-sk-p256'] as const;
const HOLDER = '/v1/runner/branch-holder?repo=immediately-run/docs&branch=main';
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

/** A heartbeat body for test key `name`'s host. */
const keyBeat = async (name: string, secret: string) =>
  hbBody('vm-a', { hostname: name, session_name: `s-${name}`, secret_hash: await sha256(secret) });

beforeEach(async () => {
  await setClock(T0);
});

describe(`S-BTN-30 signed requests (${HOST})`, () => {
  it.each(NAMES)('a fresh request signed by %s passes, with a body and without one', async (name) => {
    const secret = `secret-${name}`;
    const first = await signedCall(name, '/v1/runner/heartbeat', { body: await keyBeat(name, secret) });
    expect(first.res.status, JSON.stringify(await first.res.clone().json())).toBe(200);
    // Without a body: the digest is the empty string's.
    const mode = await signedCall(name, '/v1/runner/mode?repository=docs', { secret });
    expect(mode.res.status).toBe(200);
    const holder = await signedCall(name, HOLDER);
    expect(holder.res.status).toBe(200);
    // The worker is registered under the key's fingerprint, by the one name the key holds.
    expect(await rows('SELECT hostname, credential_id FROM workers')).toEqual([{ hostname: name, credential_id: SSH_KEYS[name].fingerprint }]);
  });

  it('the seed stored each key by its fingerprint, the public key and nothing else', async () => {
    const got = await rows<{ id: string; kind: string; hostname: string; public_key: string }>(
      `SELECT id, kind, hostname, public_key FROM credentials WHERE kind = 'worker' ORDER BY hostname`);
    expect(got.map((r) => r.hostname)).toEqual([...NAMES].sort());
    for (const r of got) {
      expect(r.id).toBe(SSH_KEYS[r.hostname].fingerprint);
      // The comment (a label for people) is not kept.
      expect(r.public_key).toBe(SSH_KEYS[r.hostname].publicKey.split(' ').slice(0, 2).join(' '));
    }
  });

  it('a request replayed within 5 minutes is refused', async () => {
    const { res, replay } = await signedCall('vm-ed', HOLDER);
    expect(res.status).toBe(200);
    await setClock(T0 + 4 * 60_000);
    const again = await hostCall(replay);
    expect(again.status).toBe(401);
    expect(await code(again)).toBe('unauthenticated');
  });

  it('a request signed 6 minutes ago, or 6 minutes ahead, is refused; 4 minutes either way passes', async () => {
    for (const [offset, want] of [[-360, 401], [360, 401], [-240, 200], [240, 200]] as const) {
      const { res } = await signedCall('vm-p256', HOLDER, { created: T0 / 1000 + offset });
      expect([offset, res.status]).toEqual([offset, want]);
    }
  });

  it('a request by a revoked key is refused, and its worker stops at its next call', async () => {
    const secret = 'secret-revoked';
    expect((await signedCall('vm-sk-ed', '/v1/runner/heartbeat', { body: await keyBeat('vm-sk-ed', secret) })).res.status).toBe(200);
    await rows(`UPDATE credentials SET revoked_at = ? WHERE id = ?`, T0, SSH_KEYS['vm-sk-ed'].fingerprint);
    const { res } = await signedCall('vm-sk-ed', '/v1/runner/heartbeat', { secret, body: hbBody('vm-a', { hostname: 'vm-sk-ed', session_name: 's-vm-sk-ed' }) });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthenticated');
  });

  it('a request signed for the local host and replayed here is refused (@authority)', async () => {
    // The local Baton a worker signed for, and this one: the same path, body and fresh clock.
    const { res } = await signedCall('vm-ed', HOLDER, { authority: '127.0.0.1:8787' });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthenticated');
    // Sent to another host than this Baton's, it never reaches the core.
    const elsewhere = await signedRequest(SSH_KEYS['vm-ed'], `http://127.0.0.1:8787${HOLDER}`, { created: T0 / 1000 });
    const moved = await call(HOLDER, { headers: elsewhere.headers });
    expect(moved.status).toBe(401);
  });

  it('a commit signature presented as a request signature is refused (namespace)', async () => {
    const { res } = await signedCall('vm-p256', HOLDER, { namespace: 'git' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', message: expect.stringMatching(/namespace/) });
  });

  it('a heartbeat under another name than the key registered is refused', async () => {
    const { res } = await signedCall('vm-ed', '/v1/runner/heartbeat', { body: await keyBeat('vm-p256', 'x') });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('forbidden');
  });

  it('an unsigned request, a half-signed one and a bearer token under a signature are refused', async () => {
    expect((await call(HOLDER)).status).toBe(401);
    const signed = await signedRequest(SSH_KEYS['vm-ed'], ORIGIN + HOLDER, { created: T0 / 1000 });
    const half = new Headers(signed.headers);
    half.delete('Signature');
    expect((await call(HOLDER, { headers: half })).status).toBe(401);
    // A signature header with a bearer token is judged as a signature: a broken one is refused.
    const mixed = new Headers(signed.headers);
    mixed.set('Signature', 'sig1=:AAAA:');
    mixed.set('Authorization', 'Bearer tok-vm-a');
    expect((await call(HOLDER, { headers: mixed })).status).toBe(401);
  });

  it('the same signed request sent twice at once passes once (round 1, 1-B-2)', async () => {
    const created = T0 / 1000;
    const a = await signedRequest(SSH_KEYS['vm-ed'], ORIGIN + HOLDER, { created, nonce: 'concurrent-nonce-0123456789' });
    const res = await Promise.all([hostCall(a.clone()), hostCall(a.clone()), hostCall(a)]);
    expect(res.map((r) => r.status).sort()).toEqual([200, 401, 401]);
  });

  it('a request that fails verification does not use up its nonce', async () => {
    const created = T0 / 1000;
    const nonce = 'unburnt-nonce-0123456789ab';
    // Signed in another namespace: refused, after the front, before the nonce is written.
    expect((await signedCall('vm-p256', HOLDER, { created, nonce, namespace: 'git' })).res.status).toBe(401);
    expect((await signedCall('vm-p256', HOLDER, { created, nonce })).res.status).toBe(200);
  });

  it('a session registered under a bearer token continues under its machine’s key (round 1, 1-A-3)', async () => {
    const { id, secret } = await register('vm-a');
    const key = await makeKey('ecdsa-sha2-nistp256', 'vm-a');
    await withCore(async (c) => {
      const w = new WorkerApi({ store: c.store, config: { ...config, BATON_KEYS: JSON.stringify([{ key: key.publicKey, name: 'vm-a', allowed_capabilities: ['agent-venue'] }]) } as never, now: () => T0 });
      await w.seedKeys();
    });
    const beat = (k: typeof key, body: unknown) => signedRequest(k, `${ORIGIN}/v1/runner/heartbeat`, { created: T0 / 1000, headers: { 'X-Worker-Secret': secret }, body: JSON.stringify(body) });
    const res = await hostCall(await beat(key, hbBody('vm-a')));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await rows('SELECT id, credential_id FROM workers')).toEqual([{ id, credential_id: key.fingerprint }]);
    // Under the key now; the token's call is no longer this session's.
    expect((await call('/v1/runner/mode?repository=docs', { headers: { Authorization: 'Bearer tok-vm-a', 'X-Worker-Secret': secret } })).status).toBe(401);
  });

  it.todo('a probe reading for an instance outside its binding is refused forbidden (R3-1251)');
  it.todo('an admin request signed by a key not in BATON_ADMIN_KEYS is refused unauthenticated (R3-1240)');
});
