// S-BTN-32 owners and grants (BATON_SPEC §13a, §10.6 R-BTN-57, R-BTN-58, R-BTN-16; R3-1240): an
// administrator registers `ops` with one owner and gives `docs` (seeded before owners existed) its
// owner; docs' owner grants worker key K. Must hold: K is recommended and claims docs tickets,
// never ops tickets; ops' owner revoking K's docs grant is forbidden; removing the last owner is
// refused; ops' owner granting K under another hostname is conflict, and granting human-operator
// forbidden; capabilities ops grants K never satisfy a docs ticket's requires; an administrator
// key is never a worker key; a login link works once, within 5 minutes, and its session ends when
// its key leaves BATON_ADMIN_KEYS; an administrator's revoke of K stops it at its next call.
// Runs on both hosts.
import { describe, it, expect, beforeEach, inject } from 'vitest';
import { cutover, hbBody, keyCall, ORIGIN, payload, recommended, rows, setAdminKeys, setClock, sha256, syncCall, syncToken, withCore } from '../helpers';
import { makeKey, signedRequest, type TestKey } from '../lib/sshKeys';
import { call as hostCall } from '#host';

const board = inject('board');
const T0 = Date.parse('2026-10-16T12:00:00Z');
const OPS_SHA = 'f'.repeat(40);
let admin: TestKey;
let docsOwner: TestKey;
let opsOwner: TestKey;
let k: TestKey;

/** A worker call signed by `key`, with its secret after the first heartbeat. */
async function workerAs(key: TestKey, path: string, body?: unknown, secret?: string) {
  const created = Math.floor((await withCore((c) => c.now())) / 1000);
  const req = await signedRequest(key, ORIGIN + path, { created, body: body === undefined ? undefined : JSON.stringify(body), headers: secret ? { 'X-Worker-Secret': secret } : {} });
  const res = await hostCall(req);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeEach(async () => {
  await setClock(T0);
  admin = await makeKey('ssh-ed25519', 'admin');
  docsOwner = await makeKey('ecdsa-sha2-nistp256', 'docs-owner');
  opsOwner = await makeKey('ssh-ed25519', 'ops-owner');
  k = await makeKey('ssh-ed25519', 'k');
  await setAdminKeys(admin);
  expect((await keyCall(admin, '/v1/admin/repositories', { id: 'ops', github: 'immediately-run/ops', default_branch: 'main',
    sync_workflow: '.github/workflows/baton-sync.yml', owner_keys: [opsOwner.publicKey] })).status).toBe(200);
  expect((await keyCall(admin, '/v1/admin/repositories', { id: 'docs', owner_keys_add: [docsOwner.publicKey] })).status).toBe(200);
  await syncCall('/v1/sync/board', payload(board.shas.A, null, board.states.A));
  const ops = await syncToken({ repository: 'immediately-run/ops', job_workflow_ref: 'immediately-run/ops/.github/workflows/baton-sync.yml@refs/heads/main' });
  await syncCall('/v1/sync/board', payload(OPS_SHA, null, board.states.A), ops);
  await cutover(1, 'docs');
  await cutover(1, 'ops');
});

describe('S-BTN-32 owners and grants', () => {
  it('a granted key works where it is granted, with what that repository granted', async () => {
    expect((await keyCall(docsOwner, '/v1/owner/docs/grants', { public_key: k.publicKey, hostname: 'k-host', capabilities: ['agent-venue'] })).status).toBe(200);
    const secret = 'secret-k';
    const hb = await workerAs(k, '/v1/runner/heartbeat', hbBody('vm-a', { hostname: 'k-host', session_name: 'k', secret_hash: await sha256(secret),
      courses: [{ repository: 'docs', course: 'roadmap-pr', version: 3 }, { repository: 'ops', course: 'roadmap-pr', version: 3 }] }));
    expect(hb.status).toBe(200);
    // Recommended docs' tickets, never ops' (rule 7: no ops grant).
    const offered = await recommended(hb.json.worker_id as number);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((t) => t.startsWith('docs:'))).toBe(true);
    expect((await workerAs(k, '/v1/runner/claim', { request_id: 'req-k-ops-1', ticket_id: 'ops:R3-9001' }, secret)).json).toMatchObject({ code: 'not-eligible', rule: 7, rule_code: 'not-granted' });
    expect((await workerAs(k, '/v1/runner/claim', { request_id: 'req-k-docs-1' }, secret)).json).toMatchObject({ ticket_id: 'docs:R3-9001' });

    // ops' owner cannot touch docs' grant, nor take K's hostname, nor grant human-operator.
    expect((await keyCall(opsOwner, `/v1/owner/docs/grants/${encodeURIComponent(k.fingerprint)}/revoke`, {})).json.code).toBe('forbidden');
    expect((await keyCall(opsOwner, '/v1/owner/ops/grants', { public_key: k.publicKey, hostname: 'other-host', capabilities: [] })).json.code).toBe('conflict');
    const other = await makeKey('ssh-ed25519', 'other');
    expect((await keyCall(opsOwner, '/v1/owner/ops/grants', { public_key: other.publicKey, hostname: 'op-host', capabilities: ['human-operator'] })).json.code).toBe('forbidden');
    // An administrator may grant it.
    expect((await keyCall(admin, '/v1/admin/grants', { repository: 'ops', public_key: other.publicKey, hostname: 'op-host', capabilities: ['human-operator'] })).status).toBe(200);
    // Removing docs' last owner is refused.
    expect((await keyCall(docsOwner, '/v1/owner/docs/owners', { fingerprint: docsOwner.fingerprint, remove: true })).json.code).toBe('conflict');
    // An administrator's key is never a worker's.
    expect((await keyCall(docsOwner, '/v1/owner/docs/grants', { public_key: admin.publicKey, hostname: 'admin-host', capabilities: [] })).json.code).toBe('conflict');
  });

  it('what ops grants K never satisfies a docs ticket’s requires', async () => {
    await keyCall(docsOwner, '/v1/owner/docs/grants', { public_key: k.publicKey, hostname: 'k-host', capabilities: ['llm-call'] });
    await keyCall(opsOwner, '/v1/owner/ops/grants', { public_key: k.publicKey, capabilities: ['agent-venue'] });
    const secret = 'secret-k';
    const hb = await workerAs(k, '/v1/runner/heartbeat', hbBody('vm-a', { hostname: 'k-host', session_name: 'k', secret_hash: await sha256(secret), capabilities: ['agent-venue'],
      courses: [{ repository: 'docs', course: 'roadmap-pr', version: 3 }, { repository: 'ops', course: 'roadmap-pr', version: 3 }] }));
    expect(hb.status).toBe(200);
    // R3-9002 requires agent-venue: granted on ops, not on docs.
    expect((await workerAs(k, '/v1/runner/claim', { request_id: 'req-k-docs-2', ticket_id: 'docs:R3-9002' }, secret)).json).toMatchObject({ code: 'not-eligible', rule: 4 });
    expect((await workerAs(k, '/v1/runner/claim', { request_id: 'req-k-ops-2', ticket_id: 'ops:R3-9002' }, secret)).json).toMatchObject({ ticket_id: 'ops:R3-9002' });
  });

  it('a grant’s max_tier caps the key in that repository', async () => {
    await keyCall(docsOwner, '/v1/owner/docs/grants', { public_key: k.publicKey, hostname: 'k-host', capabilities: ['agent-venue'], max_tier: 'routine' });
    const secret = 'secret-k';
    const hb = await workerAs(k, '/v1/runner/heartbeat', hbBody('vm-a', { hostname: 'k-host', session_name: 'k', secret_hash: await sha256(secret), tier_ceiling: 'critical' }));
    // R3-9002 is judgement: above the grant's routine.
    expect((await workerAs(k, '/v1/runner/claim', { request_id: 'req-k-docs-3', ticket_id: 'docs:R3-9002' }, secret)).json).toMatchObject({ code: 'not-eligible', rule: 5 });
    expect(await recommended(hb.json.worker_id as number)).toEqual(['docs:R3-9001']);
  });

  it('a login link works once, within 5 minutes; its session ends when its key leaves BATON_ADMIN_KEYS', async () => {
    const login = (token: string) => hostCall(new Request(`${ORIGIN}/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ token }) }));
    const { json: link } = await keyCall(admin, '/v1/admin/login-links', {});
    expect(link.url).toMatch(new RegExp(`^${ORIGIN}/login#[0-9a-f]{64}$`));
    const token = link.url.split('#')[1];
    const res = await login(token);
    expect(res.status).toBe(200);
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/^__Host-baton_session=[0-9a-f]{64}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/);
    expect((await login(token)).status).toBe(401); // single use
    const session = cookie.split(';')[0];
    const state = () => hostCall(new Request(`${ORIGIN}/v1/ui/state`, { headers: { Cookie: session } }));
    expect((await state()).status).toBe(200);
    expect((await hostCall(new Request(`${ORIGIN}/`, { headers: { Cookie: session } }))).status).toBe(200);
    // Another link, used after 5 minutes: refused.
    const late = (await keyCall(admin, '/v1/admin/login-links', {})).json.url.split('#')[1];
    await setClock(T0 + 5 * 60_000);
    expect((await login(late)).status).toBe(401);
    // Login CSRF: no JSON or a foreign Origin is forbidden.
    expect((await hostCall(new Request(`${ORIGIN}/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' }))).status).toBe(403);
    // The key leaves the secret: its session ends at the next request.
    await setAdminKeys(docsOwner === admin ? admin : await makeKey('ssh-ed25519', 'another-admin'));
    expect((await state()).status).toBe(401);
  });

  it('an administrator’s revoke of K stops it at its next call', async () => {
    await keyCall(docsOwner, '/v1/owner/docs/grants', { public_key: k.publicKey, hostname: 'k-host', capabilities: ['agent-venue'] });
    const secret = 'secret-k';
    expect((await workerAs(k, '/v1/runner/heartbeat', hbBody('vm-a', { hostname: 'k-host', session_name: 'k', secret_hash: await sha256(secret) }))).status).toBe(200);
    expect((await keyCall(admin, `/v1/admin/keys/${encodeURIComponent(k.fingerprint)}/revoke`, {})).status).toBe(200);
    expect((await workerAs(k, '/v1/runner/heartbeat', hbBody('vm-a', { hostname: 'k-host', session_name: 'k' }), secret)).status).toBe(401);
    expect(await rows(`SELECT count(*) AS n FROM events WHERE kind = 'admin'`)).toEqual([{ n: 4 }]);
  });
});
