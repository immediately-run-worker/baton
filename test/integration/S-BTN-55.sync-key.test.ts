// S-BTN-55 the sync key (BATON_SPEC §13a, §2k R-BTN-93; G-BTN-82; R3-1262): a repository's sync
// and mirror may sign with a sync key — one repository, one role — instead of a CI identity token.
// Must hold: the sync key's post is accepted; registering a key that already serves a repository is
// `conflict`; a worker key's and the mirror key's posts are `forbidden`; a revoked key's post and a
// replay are `unauthenticated`; a worker key cannot become a sync key. Runs on both hosts.
import { describe, it, expect, beforeEach } from 'vitest';
import { HOST, ORIGIN, payload, rows, setClock, SSH_KEYS, withCore } from '../helpers';
import { makeKey, signedRequest, type TestKey } from '../lib/sshKeys';
import { call as hostCall } from '#host';

const T0 = Date.parse('2026-10-16T12:00:00Z');
const PLAIN = { id: 'plain', github: 'server/plain', forge: 'git', remote: 'ssh://git@git.example/plain.git', default_branch: 'main' };
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

let sync: TestKey;
let mirror: TestKey;

/** A request to a sync route, signed by `key`, at the core's clock. */
const signed = (key: TestKey, path: string, body?: unknown, o: { nonce?: string } = {}) =>
  signedRequest(key, ORIGIN + path, { created: T0 / 1000, body: body === undefined ? undefined : JSON.stringify(body), nonce: o.nonce });

beforeEach(async () => {
  await setClock(T0);
  sync = await makeKey('ssh-ed25519', 'plain-sync');
  mirror = await makeKey('ecdsa-sha2-nistp256', 'plain-mirror');
  await withCore(async (c) => {
    await c.registry.registerWithKeys({ ...PLAIN, sync_keys: [{ public_key: sync.publicKey, role: 'sync' }] }, 'admin:test', []);
    await c.registry.addSyncKey('plain', mirror.publicKey, 'mirror', 'admin:test', []);
  });
});

/** An observation number for `plain`, taken with its sync key. */
async function observe(): Promise<number> {
  const res = await hostCall(await signed(sync, '/v1/sync/observation', {}));
  expect(res.status).toBe(200);
  return ((await res.json()) as { observation: number }).observation;
}

describe(`S-BTN-55 the sync key (${HOST})`, () => {
  it('a post signed by the repository’s sync key is accepted, for that repository alone', async () => {
    const observation = await observe();
    const res = await hostCall(await signed(sync, '/v1/sync/board', payload('a'.repeat(40), null, { items: [], ready: [] }, { observation })));
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(await rows(`SELECT repository_id, sha FROM board_head WHERE repository_id IN ('plain', 'docs') ORDER BY repository_id`)).toEqual([
      { repository_id: 'docs', sha: null }, { repository_id: 'plain', sha: 'a'.repeat(40) }]);
  });

  it('a key that already serves a repository, a worker key and an administrator key cannot be added: conflict', async () => {
    const docsKey = await makeKey('ssh-ed25519', 'docs-sync');
    await withCore(async (c) => {
      await c.registry.addSyncKey('docs', docsKey.publicKey, 'sync', 'admin:test', []);
      for (const [key, admins] of [[docsKey.publicKey, []], [SSH_KEYS['vm-ed'].publicKey, []], [(await makeKey('ssh-ed25519', 'a')).publicKey, null]] as const) {
        const admin = admins ?? [key];
        await expect(c.registry.addSyncKey('plain', key, 'sync', 'admin:test', [...admin])).rejects.toMatchObject({ code: 'conflict' });
      }
    });
  });

  it('a worker key’s and the mirror key’s posts are forbidden; the mirror key reads the events', async () => {
    const worker = await hostCall(await signed(SSH_KEYS['vm-ed'], '/v1/sync/observation', {}));
    expect([worker.status, await code(worker)]).toEqual([403, 'forbidden']);
    const asMirror = await hostCall(await signed(mirror, '/v1/sync/observation', {}));
    expect([asMirror.status, await code(asMirror)]).toEqual([403, 'forbidden']);
    const events = await hostCall(await signed(mirror, '/v1/sync/events?after=0'));
    expect(events.status).toBe(200);
  });

  it('an administrator key at /v1/sync/* is forbidden, not unauthenticated (round 1, 1-A-9)', async () => {
    const admin = await makeKey('ssh-ed25519', 'admin');
    await withCore((c) => {
      (c as unknown as { ports: { adminKeys: { list: () => string[] } } }).ports.adminKeys = { list: () => [admin.publicKey] };
    });
    const res = await hostCall(await signed(admin, '/v1/sync/head'));
    expect([res.status, await code(res)]).toEqual([403, 'forbidden']);
  });

  it('a revoked key’s post and a replay are unauthenticated', async () => {
    const first = await signed(sync, '/v1/sync/head', undefined, { nonce: 'replayed-nonce-0123456789' });
    expect((await hostCall(first.clone())).status).toBe(200);
    const again = await hostCall(first);
    expect([again.status, await code(again)]).toEqual([401, 'unauthenticated']);
    await rows(`UPDATE sync_keys SET revoked_at = ? WHERE repository_id = 'plain' AND role = 'sync'`, T0);
    const revoked = await hostCall(await signed(sync, '/v1/sync/head'));
    expect([revoked.status, await code(revoked)]).toEqual([401, 'unauthenticated']);
  });

  it('a sync key is never a worker’s: BATON_KEYS refuses it, and the runner API does not know it', async () => {
    await withCore(async (c) => {
      const { WorkerApi } = await import('../../src/core/workerApi');
      const config = (c as unknown as { ports: { config: object } }).ports.config;
      const w = new WorkerApi({ store: c.store, config: { ...config, BATON_KEYS: JSON.stringify([{ key: sync.publicKey, name: 'x', allowed_capabilities: [] }]) } as never, now: () => T0 });
      await expect(w.seedKeys()).rejects.toThrow(/sync key/);
    });
    const res = await hostCall(await signedRequest(sync, `${ORIGIN}/v1/runner/branch-holder?repo=server/plain&branch=main`, { created: T0 / 1000 }));
    expect(res.status).toBe(401);
  });
});
