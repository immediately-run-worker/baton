// R3-1247 — GitHub App deliveries (BATON_SPEC §7.1 R-BTN-73): the signature before anything is
// read, the one field parser, the self-filter, the repository map and the trailing dispatch.
// S-BTN-42.
import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { deliverySignature, pickDelivery, verifyDelivery, Webhooks } from '../../src/core/webhook';
import { front } from '../../src/core/front';
import { ORIGIN, withCore } from '../helpers';

const SECRET = env.BATON_GITHUB_WEBHOOK_SECRET!;
const enc = new TextEncoder();
const delivery = async (body: string, sig?: string) =>
  new Request(`${ORIGIN}/v1/github/webhook`, { method: 'POST', headers: { 'X-Hub-Signature-256': sig ?? (await deliverySignature(SECRET, enc.encode(body))) }, body });
const reason = (p: Promise<unknown>) => p.then(() => 'passed', (e: { code: string }) => e.code);

/** A payload that records every property path read from it. */
function recording(value: unknown, reads: Set<string>, path = ''): unknown {
  if (value === null || typeof value !== 'object') return value;
  return new Proxy(value as object, {
    get(t, k) {
      if (typeof k !== 'string') return Reflect.get(t, k);
      const p = path ? `${path}.${k}` : k;
      reads.add(p);
      return recording((t as Record<string, unknown>)[k], reads, p);
    },
  });
}

describe('the signature comes first (R-BTN-73)', () => {
  it('verifies X-Hub-Signature-256 under the secret; a wrong, missing or malformed one is unauthenticated; no secret, forbidden', async () => {
    const body = '{"repository":{"full_name":"a/b"}}';
    expect(new TextDecoder().decode(await verifyDelivery(await delivery(body), SECRET))).toBe(body);
    expect(await reason(verifyDelivery(await delivery(body, await deliverySignature('other', enc.encode(body))), SECRET))).toBe('unauthenticated');
    expect(await reason(verifyDelivery(await delivery(body, 'sha1=abc'), SECRET))).toBe('unauthenticated');
    expect(await reason(verifyDelivery(new Request(`${ORIGIN}/v1/github/webhook`, { method: 'POST', body }), SECRET))).toBe('unauthenticated');
    expect(await reason(verifyDelivery(await delivery(body), undefined))).toBe('forbidden');
  });

  it('the front reads nothing of a forged delivery and forwards only R-BTN-73’s fields', async () => {
    const seen: (string | null)[] = [];
    const to = async (r: Request) => (seen.push(r.headers.get('X-Baton-Webhook')), new Response('{}'));
    const body = JSON.stringify({ repository: { full_name: 'immediately-run/sandbox' }, comment: { body: 'secret' } });
    const forged = await delivery(body, await deliverySignature('other', enc.encode(body)));
    forged.headers.set('X-GitHub-Event', 'issue_comment');
    expect((await front(forged, env, to)).status).toBe(401);
    expect(seen).toEqual([]);
    const good = await delivery(body);
    good.headers.set('X-GitHub-Event', 'issue_comment');
    good.headers.set('X-GitHub-Delivery', 'abc-1');
    good.headers.set('X-Baton-Webhook', '{"forged":true}');
    expect((await front(good, env, to)).status).toBe(200);
    expect(seen.map((s) => JSON.parse(s!))).toEqual([{ event: 'issue_comment', id: 'abc-1', repository: 'immediately-run/sandbox' }]);
  });
});

describe('the one parser (R-BTN-73)', () => {
  const ALLOWED = new Set(['repository', 'repository.full_name', 'workflow_run', 'workflow_run.path', 'pusher', 'pusher.name', 'head_commit', 'head_commit.author', 'head_commit.author.email']);

  it.each([
    ['pull_request_review', { repository: { full_name: 'o/r', owner: { login: 'o' } }, review: { body: 'b' }, sender: { login: 's' } }, { repository: 'o/r' }],
    ['workflow_run', { repository: { full_name: 'o/r' }, workflow_run: { path: '.github/workflows/ci.yml', head_sha: 'x', name: 'ci' } }, { repository: 'o/r', workflow_path: '.github/workflows/ci.yml' }],
    ['push', { repository: { full_name: 'o/r' }, pusher: { name: 'p', email: 'e' }, head_commit: { author: { email: 'a@x', name: 'n' }, message: 'm' }, commits: [{}] }, { repository: 'o/r', pusher: 'p', author_email: 'a@x' }],
    ['push', { repository: { full_name: 'o/r' }, pusher: { name: 'p' }, head_commit: null }, { repository: 'o/r', pusher: 'p', author_email: null }],
  ])('%s: returns its fields and reads nothing else', (event, payload, want) => {
    const reads = new Set<string>();
    expect(pickDelivery(event, 'id-1', recording(payload, reads))).toEqual({ event, id: 'id-1', ...want });
    expect([...reads].filter((r) => !ALLOWED.has(r))).toEqual([]);
  });

  it.each([
    ['an event outside the five', 'check_suite', { repository: { full_name: 'o/r' } }],
    ['ping', 'ping', { repository: { full_name: 'o/r' } }],
    ['no repository', 'pull_request', {}],
    ['a full_name that is no owner/name', 'pull_request', { repository: { full_name: 'x' } }],
    ['a workflow_run with no path', 'workflow_run', { repository: { full_name: 'o/r' }, workflow_run: {} }],
    ['a push with no pusher', 'push', { repository: { full_name: 'o/r' }, head_commit: null }],
    ['a payload that is an array', 'pull_request', [{ repository: { full_name: 'o/r' } }]],
  ])('drops %s', (_what, event, payload) => {
    expect(pickDelivery(event, 'id-1', payload)).toBeNull();
  });

  it('drops a delivery with no id or a malformed one', () => {
    expect(pickDelivery('pull_request', null, { repository: { full_name: 'o/r' } })).toBeNull();
    expect(pickDelivery('pull_request', 'a b', { repository: { full_name: 'o/r' } })).toBeNull();
  });
});

describe('the core: self-filter, repository map, window (R-BTN-73)', () => {
  const d = (over: Record<string, unknown>) => ({ event: 'pull_request', id: `d-${Math.random()}`, repository: 'immediately-run/docs', ...over }) as never;

  it('Baton’s own work is dropped; anything else in a registered repository is a trigger', async () => {
    await withCore((c) => {
      const w = new Webhooks({ store: c.store, now: () => 1_000_000 });
      expect(w.receive(d({ event: 'workflow_run', workflow_path: '.github/workflows/baton-mirror.yml' }))).toEqual({ outcome: 'own-work' });
      expect(w.receive(d({ event: 'workflow_run', repository: 'Immediately-Run/Docs', workflow_path: '.github/workflows/baton-sync.yml' }))).toEqual({ outcome: 'own-work' });
      expect(w.receive(d({ event: 'push', pusher: 'github-actions[bot]', author_email: 'baton-mirror@immediately.run' }))).toEqual({ outcome: 'own-work' });
      // A push by the bot as anyone else, or by anyone as the mirror, is a trigger.
      expect(w.receive(d({ event: 'push', pusher: 'github-actions[bot]', author_email: 'x@y' }))).toMatchObject({ now: ['docs'] });
    });
  });

  it('maps a code repository to the repositories whose tickets list it, by owner/name or by short name', async () => {
    await withCore((c) => {
      c.store.exec(`INSERT INTO tickets (id, repository_id, local_id, path, title, status, node, queue, tags, requires_clause, depends_on, blocked_by, repos, snapshot_sha, row_hash)
                    SELECT 'docs:X-1', 'docs', 'X-1', 'p', 't', 'available', 'ready', 'ready-autonomous', '[]', 'listed', '[]', '[]', '["baton","immediately-run/sandbox"]', 'a', 'h'`);
      const w = new Webhooks({ store: c.store, now: () => 5_000_000 });
      expect(w.receive(d({ repository: 'immediately-run/baton' }))).toEqual({ outcome: 'dispatched', now: ['docs'], trailing: [] });
      const later = new Webhooks({ store: c.store, now: () => 6_000_000 });
      expect(later.receive(d({ repository: 'IMMEDIATELY-RUN/Sandbox' }))).toEqual({ outcome: 'dispatched', now: ['docs'], trailing: [] });
      expect(later.receive(d({ repository: 'immediately-run/other' }))).toEqual({ outcome: 'dispatched', now: [], trailing: [] });
    });
  });

  it('one dispatch per 30 seconds, then one trailing when the window that suppressed one closes', async () => {
    await withCore((c) => {
      const at = (now: number) => new Webhooks({ store: c.store, now: () => now });
      expect(at(0).receive(d({}))).toMatchObject({ now: ['docs'], trailing: [] });
      expect(at(0).nextTrailing()).toBeNull();
      expect(at(10_000).receive(d({}))).toMatchObject({ now: [], trailing: ['docs'] });
      expect(at(20_000).receive(d({}))).toMatchObject({ now: [], trailing: ['docs'] });
      expect(at(0).nextTrailing()).toBe(30_000);
      expect(at(29_999).dueTrailing()).toEqual([]);
      expect(at(30_000).dueTrailing()).toEqual(['docs']);
      expect(at(30_001).dueTrailing()).toEqual([]);
      // The trailing dispatch opened a window: a delivery inside it waits again.
      expect(at(45_000).receive(d({}))).toMatchObject({ now: [], trailing: ['docs'] });
      expect(at(0).nextTrailing()).toBe(60_000);
      expect(at(60_000).receive(d({}))).toMatchObject({ now: ['docs'], trailing: [] });
      expect(at(0).nextTrailing()).toBeNull();
    });
  });

  it('a delivery id is remembered for 24 hours', async () => {
    await withCore((c) => {
      const at = (now: number) => new Webhooks({ store: c.store, now: () => now });
      const one = d({ id: 'same' });
      expect(at(0).receive(one)).toMatchObject({ outcome: 'dispatched' });
      expect(at(24 * 3_600_000).receive(one)).toEqual({ outcome: 'duplicate' });
      expect(at(24 * 3_600_000 + 1).receive(one)).toMatchObject({ outcome: 'dispatched' });
    });
  });
});
