// local-queue.test.ts — the local host's one-at-a-time rule (BATON_SPEC §3, §3a R-BTN-55;
// S-BTN-31): every request and alarm tick queue behind the one running, which lets another in
// only at `outside`; the store's transactions roll back as transactionSync's do; the HTTP
// server answers as the Worker does; a local start refuses the test bindings.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimItem, cutover, hbBody, payload, register, rows, setClock, sha256, syncCall } from '../helpers';
import { current } from '../hosts/local';
import { RequestQueue } from '../../src/local/queue';
import { MAX_BODY, serve } from '../../src/local/server';
import { openStore } from '../../src/local/store';
import { adminKeysFrom, concreteHost, localConfig, main } from '../../src/local/main';
import { SECURITY_HEADERS } from '../../src/core/http';

const board = inject('board');
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the request queue', () => {
  it('runs one at a time, in arrival order', async () => {
    const q = new RequestQueue();
    const log: string[] = [];
    const job = (name: string, ms: number) => q.run(async () => {
      log.push(`${name}+`);
      await later(ms);
      log.push(`${name}-`);
    });
    await Promise.all([job('a', 20), job('b', 1), job('c', 1)]);
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  });

  it('lets the next one in only while the holder awaits outside, and queues the holder again after', async () => {
    const q = new RequestQueue();
    const log: string[] = [];
    const a = q.run(async () => {
      log.push('a+');
      await q.outside(async () => {
        await later(20);
        log.push('a: signature checked');
      });
      log.push('a-');
    });
    const b = q.run(async () => {
      log.push('b+');
      await later(5);
      log.push('b-');
    });
    await Promise.all([a, b]);
    expect(log).toEqual(['a+', 'b+', 'b-', 'a: signature checked', 'a-']);
  });

  it('overlapping outside calls by one holder release once and come back once; later runs still run', async () => {
    const q = new RequestQueue();
    const log: string[] = [];
    const a = q.run(async () => {
      log.push('a+');
      await Promise.all([q.outside(() => later(10)), q.outside(() => later(20))]);
      log.push('a-');
    });
    const b = q.run(async () => {
      log.push('b');
    });
    await Promise.all([a, b]);
    expect(log).toEqual(['a+', 'b', 'a-']);
    expect(await q.run(() => 'next')).toBe('next');
  });

  it('refuses outside from code that does not hold the queue, so nothing runs beside the holder', async () => {
    const q = new RequestQueue();
    await expect(q.outside(async () => 1)).rejects.toThrow(/does not hold/);
    const log: string[] = [];
    let stray: Promise<unknown> | null = null;
    const b = q.run(async () => {
      log.push('b+');
      stray = q.outside(async () => 0).catch((e) => e);
      await later(10);
      log.push('b-');
    });
    await b;
    // b's own call is allowed; once b has settled, a late one is refused and takes no slot.
    await stray;
    await expect(q.run(() => q.outside(async () => 'inner'))).resolves.toBe('inner');
    let late: () => Promise<unknown> = async () => null;
    await q.run(() => {
      late = () => q.outside(async () => 'late');
    });
    await expect(late()).rejects.toThrow(/does not hold/);
    expect(log).toEqual(['b+', 'b-']);
    expect(await q.run(() => 'next')).toBe('next');
  });

  it('releases the queue when the holder throws', async () => {
    const q = new RequestQueue();
    await expect(q.run(() => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await q.run(() => 'next')).toBe('next');
  });
});

describe('the local host', () => {
  beforeEach(async () => {
    await setClock(Date.parse('2026-10-13T12:00:00Z'));
    await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
    await cutover();
  });

  it('two concurrent claims for one ticket: one succeeds (S-BTN-1, through the queue)', async () => {
    const a = await register('vm-a');
    const b = await register('vm-b');
    const both = await Promise.all([claimItem('vm-a', a.secret, { ticket_id: 'docs:R3-9002' }), claimItem('vm-b', b.secret, { ticket_id: 'docs:R3-9002' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await rows(`SELECT count(*) AS n FROM claims WHERE ticket_id = 'docs:R3-9002'`)).toEqual([{ n: 1 }]);
  });

  it('an alarm tick waits for the request in progress', async () => {
    const host = current();
    const log: string[] = [];
    const held = host.queue.run(async () => {
      log.push('request+');
      await later(20);
      log.push('request-');
    });
    const tick = host.tick().then(() => log.push('alarm'));
    await Promise.all([held, tick]);
    expect(log).toEqual(['request+', 'request-', 'alarm']);
  });

  it('serves the same routes over HTTP, with the security headers', async () => {
    const host = current();
    const origin = 'http://127.0.0.1';
    const server = serve(host, 'https://baton.immediately.run');
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (server.address() as AddressInfo).port;
      const refused = await fetch(`${origin}:${port}/v1/runner/heartbeat`, { method: 'POST', body: '{}' });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: 'unauthenticated' });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(refused.headers.get(k)).toBe(v);
      const secret = 'secret-http';
      const ok = await fetch(`${origin}:${port}/v1/runner/heartbeat`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-vm-a', 'Content-Type': 'application/json' },
        body: JSON.stringify(hbBody('vm-a', { secret_hash: await sha256(secret) })),
      });
      expect(ok.status).toBe(200);
      // A target that looks like another authority stays a path, as on the Worker.
      const odd = await fetch(`${origin}:${port}//x/v1/sync/head`);
      expect([odd.status, ((await odd.json()) as { code: string }).code]).toEqual([404, 'not-found']);
      // A body over the limit is refused with the §11 envelope and the security headers.
      const big = await fetch(`${origin}:${port}/v1/runner/heartbeat`, { method: 'POST', body: 'x'.repeat(MAX_BODY + 1) }).catch(() => null);
      expect(big).not.toBeNull();
      if (big) {
        expect(big.status).toBe(400);
        expect(await big.json()).toMatchObject({ ok: false, code: 'invalid-params' });
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(big.headers.get(k)).toBe(v);
      }
      expect(await ok.json()).toMatchObject({ worker_id: 1, mode: { docs: 'cut-over' } });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('the local store', () => {
  it('reads an integer past 2^53 as the nearest number, as the Durable Object does, never a throw', () => {
    const { store } = openStore(':memory:');
    expect(store.exec('SELECT 9007199254740993 AS v').one()).toEqual({ v: 9007199254740992 });
    expect(store.exec('SELECT ? AS v, ? AS w', 2 ** 60, 7).one()).toEqual({ v: 2 ** 60, w: 7 });
  });

  it('holds a database file exclusively: a second open fails clearly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-store-'));
    const file = join(dir, 'baton.db');
    try {
      const first = openStore(file);
      first.store.script('CREATE TABLE t (x INTEGER)');
      expect(() => openStore(file)).toThrow(/in use by another Baton/);
      first.db.close();
      expect(() => openStore(file).db.close()).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls a failed transaction back, nested ones included, as transactionSync does', () => {
    const { store } = openStore(':memory:');
    store.script('CREATE TABLE t (x INTEGER); CREATE TABLE u (y INTEGER)');
    store.transaction(() => {
      store.exec('INSERT INTO t VALUES (1)');
      expect(() => store.transaction(() => {
        store.exec('INSERT INTO t VALUES (2)');
        throw new Error('inner');
      })).toThrow('inner');
    });
    expect(store.exec('SELECT x FROM t').toArray()).toEqual([{ x: 1 }]);
    expect(() => store.exec('SELECT x FROM t').one()).not.toThrow();
    expect(() => store.exec('SELECT x FROM u').one()).toThrow();
  });
});

describe('a local start', () => {
  it('needs --origin where the address clients use cannot be derived', async () => {
    await expect(main(['--db', ':memory:', '--port', '0'])).rejects.toThrow(/--origin is required/);
    for (const host of ['0.0.0.0', '0', '::', '::0', '0:0::0', '[::1]', 'example.test']) {
      await expect(main(['--db', ':memory:', '--port', '8787', '--host', host])).rejects.toThrow(/--origin is required/);
    }
    expect(['127.0.0.1', '::1', 'localhost', '10.0.0.2'].map(concreteHost)).toEqual([true, true, true, true]);
    expect(concreteHost('fe80::1%eth0')).toBe(false);
  });

  it('refuses an --origin that is not an origin', async () => {
    for (const origin of ['baton.local', 'http://x/base', 'ftp//x']) {
      await expect(main(['--db', ':memory:', '--origin', origin])).rejects.toThrow(/must be an origin/);
    }
  });

  it('refuses the test bindings and non-string values', () => {
    expect(() => localConfig({ BATON_TEST_BINDINGS: 'true' }, 'http://127.0.0.1:8787')).toThrow(/test bindings/);
    expect(() => localConfig({ TEST_OIDC_JWKS: '{}' }, 'http://127.0.0.1:8787')).toThrow(/test bindings/);
    expect(() => localConfig({ TOKEN_HASHES: {} }, 'http://127.0.0.1:8787')).toThrow(/string/);
    const c = localConfig({ OWNER_EMAILS: 'a@example.com' }, 'http://127.0.0.1:8787');
    expect(c).toMatchObject({ BATON_ORIGIN: 'http://127.0.0.1:8787', OWNER_EMAILS: 'a@example.com' });
    expect(c.BATON_TEST_BINDINGS).toBeUndefined();
  });
});

describe('--admin-keys (R-BTN-57; round 3, 3-A-4)', () => {
  it('is read on every call: a key taken out of the file is no administrator at the next request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'baton-admin-keys-'));
    try {
      const file = join(dir, 'admins');
      const a = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq4c1kq3OcHmu0dQ1xI8j1bnvJmK2xLqPq0T8cQ3pLs a';
      writeFileSync(file, `${a}\n`);
      const keys = adminKeysFrom(file);
      expect(keys.list()).toHaveLength(1);
      writeFileSync(file, '');
      expect(keys.list()).toEqual([]);
      rmSync(file);
      expect(keys.list()).toEqual([]); // unreadable: no administrator
      expect(adminKeysFrom(undefined).list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
