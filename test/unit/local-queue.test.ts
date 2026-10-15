// local-queue.test.ts — the local host's one-at-a-time rule (BATON_SPEC §3, §3a R-BTN-55;
// S-BTN-31): every request and alarm tick queue behind the one running, which lets another in
// only at `outside`; the store's transactions roll back as transactionSync's do; the HTTP
// server answers as the Worker does; a local start refuses the test bindings.
import { describe, it, expect, inject, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { claimItem, cutover, hbBody, payload, register, rows, setClock, sha256, syncCall } from '../helpers';
import { current } from '../hosts/local';
import { RequestQueue } from '../../src/local/queue';
import { serve } from '../../src/local/server';
import { openStore } from '../../src/local/store';
import { localConfig } from '../../src/local/main';
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
    const both = await Promise.all([claimItem('vm-a', a.secret, { ticket_id: 'R3-9002' }), claimItem('vm-b', b.secret, { ticket_id: 'R3-9002' })]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await rows(`SELECT count(*) AS n FROM claims WHERE ticket_id = 'R3-9002'`)).toEqual([{ n: 1 }]);
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
      const refused = await fetch(`${origin}:${port}/v1/worker/heartbeat`, { method: 'POST', body: '{}' });
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ code: 'unauthenticated' });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) expect(refused.headers.get(k)).toBe(v);
      const secret = 'secret-http';
      const ok = await fetch(`${origin}:${port}/v1/worker/heartbeat`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tok-vm-a', 'Content-Type': 'application/json' },
        body: JSON.stringify(hbBody('vm-a', { secret_hash: await sha256(secret) })),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ worker_id: 1, mode: 'cut-over' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('the local store', () => {
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
  it('refuses the test bindings and non-string values', () => {
    expect(() => localConfig({ BATON_TEST_BINDINGS: 'true' }, 'http://127.0.0.1:8787')).toThrow(/test bindings/);
    expect(() => localConfig({ TEST_OIDC_JWKS: '{}' }, 'http://127.0.0.1:8787')).toThrow(/test bindings/);
    expect(() => localConfig({ TOKEN_HASHES: {} }, 'http://127.0.0.1:8787')).toThrow(/string/);
    const c = localConfig({ OWNER_EMAILS: 'a@example.com' }, 'http://127.0.0.1:8787');
    expect(c).toMatchObject({ BATON_ORIGIN: 'http://127.0.0.1:8787', OWNER_EMAILS: 'a@example.com' });
    expect(c.BATON_TEST_BINDINGS).toBeUndefined();
  });
});
