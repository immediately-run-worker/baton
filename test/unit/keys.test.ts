// R3-1239 — worker keys seeded from BATON_KEYS (BATON_SPEC §4 `credentials`, §10.1 R-BTN-13 as
// amended): by fingerprint, one key per name, revoked for good; the replay cache by fingerprint.
// S-BTN-30.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { WorkerApi } from '../../src/core/workerApi';
import { makeKey } from '../lib/sshKeys';
import { rows, SSH_KEYS, withCore } from '../helpers';

const entry = (k: { publicKey: string }, name: string) => ({ key: k.publicKey, name, allowed_capabilities: ['none'] });
const api = (c: { store: never }, keys: unknown, now = 1_000) =>
  new WorkerApi({ store: c.store, config: { ...env, BATON_KEYS: JSON.stringify(keys) }, now: () => now });

describe('BATON_KEYS (R3-1239)', () => {
  it('a key the list no longer names is revoked, and listing it again does not bring it back', async () => {
    const [a, b] = [SSH_KEYS['vm-ed'], SSH_KEYS['vm-p256']];
    await withCore(async (c) => {
      expect(await api(c as never, [entry(a, 'vm-ed')], 5_000).seedKeys()).toBe(1);
      expect(c.workers.publicKey(b.fingerprint)).toBeNull();
      expect(await api(c as never, [entry(a, 'vm-ed'), entry(b, 'vm-p256')], 6_000).seedKeys()).toBe(2);
      expect(c.workers.publicKey(b.fingerprint)).toBeNull();
    });
    expect(await rows(`SELECT hostname, revoked_at FROM credentials WHERE kind = 'worker' ORDER BY hostname`)).toEqual([
      { hostname: 'vm-ed', revoked_at: null }, { hostname: 'vm-p256', revoked_at: 5_000 },
      { hostname: 'vm-sk-ed', revoked_at: 5_000 }, { hostname: 'vm-sk-p256', revoked_at: 5_000 }]);
  });

  it('a name whose key changed takes its new key; the old one is revoked', async () => {
    const fresh = await makeKey('ssh-ed25519', 'vm-ed');
    await withCore(async (c) => {
      await api(c as never, [entry(fresh, 'vm-ed')]).seedKeys();
      expect(c.workers.publicKey(SSH_KEYS['vm-ed'].fingerprint)).toBeNull();
      expect(c.workers.publicKey(fresh.fingerprint)).toBe(fresh.publicKey.split(' ').slice(0, 2).join(' '));
    });
  });

  it.each([
    ['two keys for one name', async () => [entry(SSH_KEYS['vm-ed'], 'same'), entry(SSH_KEYS['vm-p256'], 'same')], /one key per name/],
    ['a key twice', async () => [entry(SSH_KEYS['vm-ed'], 'a'), entry(SSH_KEYS['vm-ed'], 'b')], /listed twice/],
    ['a key of another type', async () => [{ key: 'ssh-rsa AAAAB3NzaC1yc2E x', name: 'a', allowed_capabilities: [] }], /R-BTN-13 type/],
    ['a name that is no hostname', async () => [entry(SSH_KEYS['vm-ed'], 'a b')], /hostname/],
    ['an object, not a list', async () => ({}), /array/],
  ])('refuses %s, and writes nothing', async (_what, list, why) => {
    const keys = await list();
    await withCore(async (c) => {
      await expect(api(c as never, keys).seedKeys()).rejects.toThrow(why);
    });
    expect(await rows(`SELECT count(*) AS n FROM credentials WHERE kind = 'worker' AND revoked_at IS NULL`)).toEqual([{ n: 4 }]);
  });

  it('the bearer mirror leaves the keys alone', async () => {
    await withCore((c) => {
      // A changed CREDENTIALS secret re-mirrors and revokes every token credential it no longer
      // lists, and no key.
      const w = new WorkerApi({ store: c.store, config: { ...env, CREDENTIALS: '{}' }, now: () => 1 });
      expect(() => w.credential('vm-a')).toThrow(/revoked/);
    });
    expect(await rows(`SELECT count(*) AS n FROM credentials WHERE kind = 'worker' AND revoked_at IS NULL`)).toEqual([{ n: 4 }]);
  });
});

describe('the replay cache (R-BTN-13)', () => {
  it('a nonce is refused again for the same key, not for another, and is pruned after 10 minutes', async () => {
    await withCore((c) => {
      const at = (now: number) => new WorkerApi({ store: c.store, config: env, now: () => now });
      at(0).acceptNonce('SHA256:a', 'n1');
      expect(() => at(1).acceptNonce('SHA256:a', 'n1')).toThrow(/replayed/);
      at(1).acceptNonce('SHA256:b', 'n1');
      at(10 * 60_000 + 1).acceptNonce('SHA256:c', 'n2');
    });
    expect(await rows(`SELECT key_fingerprint, nonce FROM request_nonces ORDER BY key_fingerprint`)).toEqual([
      { key_fingerprint: 'SHA256:b', nonce: 'n1' }, { key_fingerprint: 'SHA256:c', nonce: 'n2' }]);
  });
});
