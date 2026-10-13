// workerApi.ts — the server side of workers (BATON_SPEC §5, §6.8, §6.9, §7.3, §7.4, §9, §10.1–
// 10.2, §11; R3-1211): registration and heartbeats with credential binding and per-worker
// secrets, activities, transcript pointers, messages, provider suspensions, the alarm's share of
// them, and shadow reports. No claim logic lives here (R3-1212): claims are read, and written only
// by the shadow report, whose rows the unique indexes guard.
import { BatonError } from './http';
import { capabilitiesOf } from './shared/vocabulary.mjs';
import {
  checkAck, checkActivity, checkHeartbeat, checkMessage, checkShadowReport, checkSuspension, bad,
  type ActivityReport, type Heartbeat,
} from './validate';

type Row = Record<string, SqlStorageValue>;
/** §6.8: the transcript repositories, until the board sync posts `baton.json`'s list. */
export const DEFAULT_TRANSCRIPT_REPOS = ['immediately-run/claude-sessions', 'immediately-run-worker/session-transcripts'];
const CLOSE_GRACE_MS = 10 * 60_000; // §6.9: closing updates are accepted 10 minutes after a claim ends
const SCHEDULED_WINDOW_MS = 24 * 3_600_000; // §7.4: the heartbeat carries suspensions starting within 24 h

/** FNV-1a (32-bit), hex: a cheap synchronous change detector. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Ctx {
  storage: DurableObjectStorage;
  env: Env;
  now: () => number;
  /** R-BTN-19: a heartbeat's `fenced` report, handed to the claims (R3-1212). */
  fenced?: (workerId: number, incarnation: number, claimId: number) => boolean;
}

export class WorkerApi {
  constructor(private readonly c: Ctx) {}

  private rows<T = Row>(q: string, ...p: unknown[]): T[] {
    return this.c.storage.sql.exec(q, ...(p as SqlStorageValue[])).toArray() as T[];
  }
  private exec(q: string, ...p: unknown[]) {
    return this.c.storage.sql.exec(q, ...(p as SqlStorageValue[]));
  }
  private event(kind: string, actor: string, detail: unknown, workItemId: string | null = null, claimId: number | null = null) {
    this.exec('INSERT INTO events (at, kind, work_item_id, claim_id, actor, detail_json) VALUES (?, ?, ?, ?, ?, ?)',
      this.c.now(), kind, workItemId, claimId, actor, JSON.stringify(detail));
  }
  private setting(key: string): string | null {
    return (this.rows<{ value: string }>('SELECT value FROM baton_settings WHERE key = ?', key)[0]?.value) ?? null;
  }

  // ── credentials (R-BTN-13) ──────────────────────────────────────────────────────────────

  /** Mirror the `CREDENTIALS` secret into `credentials`, and mark revoked a credential whose
   *  token hash is gone. Returns the credential's row, or throws `forbidden`. */
  credential(id: string): { id: string; hostname: string; allowed: string[] } {
    let policy: Record<string, { hostname: string; allowed_capabilities: string[] }> = {};
    let hashes: Record<string, string> = {};
    try {
      policy = JSON.parse(this.c.env.CREDENTIALS ?? '{}');
      hashes = JSON.parse(this.c.env.TOKEN_HASHES ?? '{}');
    } catch {
      throw new BatonError('unavailable', 'the credential tables are unreadable');
    }
    // §3's write budget: mirror only when either secret changed since the last mirror, so a
    // heartbeat writes no credential rows. The marker is a change detector, not a security check.
    const marker = fnv1a(`${this.c.env.CREDENTIALS ?? ''}\u0000${this.c.env.TOKEN_HASHES ?? ''}`);
    const now = this.c.now();
    if (this.setting('credentials_marker') !== marker) this.mirrorCredentials(policy, hashes, marker, now);
    const row = this.rows<{ id: string; hostname: string; allowed_capabilities: string; revoked_at: number | null }>(
      'SELECT id, hostname, allowed_capabilities, revoked_at FROM credentials WHERE id = ?', id)[0];
    if (!row || row.revoked_at != null) throw new BatonError('forbidden', 'this credential is not registered or is revoked');
    return { id: row.id, hostname: row.hostname, allowed: JSON.parse(row.allowed_capabilities) };
  }

  /** The `credentials` table is the secrets' mirror (§4), for the dashboard and the worker rows'
   *  foreign key; a credential whose token hash is gone is marked revoked. */
  private mirrorCredentials(policy: Record<string, { hostname: string; allowed_capabilities: string[] }>, hashes: Record<string, string>, marker: string, now: number) {
    for (const [cid, p] of Object.entries(policy)) {
      const allowed = JSON.stringify([...(p.allowed_capabilities ?? [])].sort());
      this.exec(`INSERT INTO credentials (id, hostname, allowed_capabilities, revoked_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (id) DO UPDATE SET hostname = excluded.hostname, allowed_capabilities = excluded.allowed_capabilities,
                   revoked_at = CASE WHEN excluded.revoked_at IS NULL THEN NULL ELSE COALESCE(credentials.revoked_at, excluded.revoked_at) END`,
        cid, p.hostname, allowed, Object.hasOwn(hashes, cid) ? null : now);
    }
    // A credential dropped from the policy is revoked too.
    const listed = Object.keys(policy);
    this.exec(`UPDATE credentials SET revoked_at = ? WHERE revoked_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))`, now, JSON.stringify(listed));
    this.exec(`INSERT INTO baton_settings (key, value) VALUES ('credentials_marker', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, marker);
  }

  // ── workers (§5, §10.2) ─────────────────────────────────────────────────────────────────

  /** The worker a later call comes from: this credential's worker whose secret hashes to the
   *  presented `X-Worker-Secret` (R-BTN-14). A reaped worker is refused until it re-keys. */
  async authWorker(credentialId: string, secret: string | null) {
    if (!secret) throw new BatonError('unauthenticated', 'X-Worker-Secret is required after the first heartbeat');
    const hash = await sha256Hex(secret);
    return this.c.storage.transactionSync(() => this.authWorkerTx(credentialId, hash));
  }

  private authWorkerTx(credentialId: string, hash: string) {
    this.credential(credentialId);
    const w = this.rows<{ id: number; reaped_at: number | null }>('SELECT id, reaped_at FROM workers WHERE credential_id = ? AND secret_hash = ?', credentialId, hash)[0];
    if (!w) throw new BatonError('unauthenticated', 'no worker holds this secret');
    if (w.reaped_at != null) throw new BatonError('worker-reaped', 'this worker was reaped; re-key with a heartbeat');
    this.exec('UPDATE workers SET last_seen_at = ?, secret_seen = 1 WHERE id = ?', this.c.now(), w.id);
    return w.id;
  }

  transcriptRepos(): string[] {
    const v = this.setting('transcript_repos');
    return v ? JSON.parse(v) : DEFAULT_TRANSCRIPT_REPOS;
  }

  private activeClaim(workerId: number) {
    return this.rows<{ id: number; work_item_id: string; nonce: string; claimed_at: number }>(
      `SELECT id, work_item_id, nonce, claimed_at FROM work_item_claims WHERE worker_id = ? AND status = 'active'`, workerId)[0] ?? null;
  }

  private currentActivity(workerId: number) {
    return this.rows<{ id: string; kind: string; label: string | null; started_at: number; claim_id: number | null }>(
      `SELECT id, kind, label, started_at, claim_id FROM activities WHERE worker_id = ? AND ended_at IS NULL
       ORDER BY started_at DESC, received_at DESC LIMIT 1`, workerId)[0] ?? null;
  }

  /** `POST /v1/worker/heartbeat` (§11): registration on first contact, the secret and re-key
   *  rules (R-BTN-14), the credential's hostname and capability allow-list (R-BTN-13), settings
   *  rewritten only when their hash changes (§3), transcripts, usage and rate limits; the answer
   *  carries the claim, the messages, the suspensions, `min_skills_version` and the mode. */
  async heartbeat(credentialId: string, secretHeader: string | null, body: unknown) {
    const hb = checkHeartbeat(body, this.transcriptRepos());
    // Every hash first; then every read and write in one synchronous transaction (§3).
    const presented = secretHeader ? await sha256Hex(secretHeader) : null;
    const settingsHash = await sha256Hex(JSON.stringify({
      harness: hb.harness, kind: hb.kind, model_id: hb.model_id ?? null, model_provider_id: hb.model_provider_id ?? null,
      billing: Object.entries(hb.billing).sort(), capabilities: [...hb.capabilities].sort(), tier: hb.tier_ceiling,
      lease: hb.lease_timeout_s, skills: hb.skills_version,
    }));
    return this.c.storage.transactionSync(() => this.heartbeatTx(credentialId, presented, settingsHash, hb));
  }

  private heartbeatTx(credentialId: string, presented: string | null, settingsHash: string, hb: Heartbeat) {
    const cred = this.credential(credentialId);
    if (hb.hostname !== cred.hostname) throw new BatonError('forbidden', `this credential may register only ${cred.hostname}`);
    const outside = hb.capabilities.filter((c) => !cred.allowed.includes(c));
    if (outside.length) throw new BatonError('forbidden', `this credential may not declare ${outside.join(', ')}`);
    // R-BTN-32: only the test credential may run a test-harness sidecar.
    if (hb.test_harness && cred.id !== 'test') throw new BatonError('forbidden', 'test_harness is refused from any credential but the test one');

    const now = this.c.now();
    let w = this.rows<{ id: number; secret_hash: string; credential_id: string; reaped_at: number | null; incarnation: number; settings_hash: string; secret_seen: number }>(
      'SELECT id, secret_hash, credential_id, reaped_at, incarnation, settings_hash, secret_seen FROM workers WHERE hostname = ? AND session_name = ?', hb.hostname, hb.session_name)[0];
    const knownAccounts = new Set(this.rows<{ id: string }>('SELECT id FROM model_providers').map((r) => r.id));
    // An account the reference data does not know yet is left out (fail closed, §7.4).
    const modelProvider = hb.model_provider_id && knownAccounts.has(hb.model_provider_id) ? hb.model_provider_id : null;

    let rekeyed = false;
    if (!w) {
      if (!hb.secret_hash) bad('secret_hash', 'the first heartbeat of a session carries its SHA-256');
      this.exec(`INSERT INTO workers (hostname, session_name, secret_hash, credential_id, harness, kind, model_id, model_provider_id,
                   skills_version, tier_ceiling, lease_timeout_ms, settings_hash, first_seen_at, last_seen_at, last_activity_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)`,
        hb.hostname, hb.session_name, hb.secret_hash, cred.id, hb.harness, hb.kind, hb.model_id ?? null, modelProvider,
        hb.skills_version, hb.tier_ceiling, hb.lease_timeout_s * 1000, now, now, hb.last_activity_at ?? null);
      w = this.rows<typeof w>('SELECT id, secret_hash, credential_id, reaped_at, incarnation, settings_hash, secret_seen FROM workers WHERE hostname = ? AND session_name = ?', hb.hostname, hb.session_name)[0];
    } else {
      if (w.credential_id !== cred.id) throw new BatonError('forbidden', 'this session is registered under another credential');
      if (hb.rekey) {
        // R-BTN-14: a re-key replaces the secret when the worker holds no claim or was reaped;
        // it clears reaped_at, bumps the incarnation, and never clears a fence.
        if (!hb.secret_hash) bad('secret_hash', 'a re-key carries the new secret’s SHA-256');
        if (w.reaped_at == null && this.activeClaim(w.id)) throw new BatonError('session-taken', 'a worker holding a claim cannot re-key');
        if (hb.secret_hash === w.secret_hash) {
          // A retried re-key is idempotent — only until the secret is presented, as for a retried
          // first heartbeat; the same hash cannot bring a reaped worker back.
          if (w.reaped_at != null) bad('secret_hash', 'a re-key carries a new secret');
          if (w.secret_seen && presented !== w.secret_hash) throw new BatonError('session-taken', 'a re-key carries a new secret');
        } else {
          this.exec('UPDATE workers SET secret_hash = ?, secret_seen = 0, incarnation = incarnation + 1, reaped_at = NULL WHERE id = ?', hb.secret_hash, w.id);
          this.event('rekeyed', `worker:${w.id}`, { incarnation: w.incarnation + 1 });
          rekeyed = true;
        }
      } else {
        // R-BTN-14: X-Worker-Secret, or — only until the worker has once presented it — the body
        // hash of a retried first heartbeat (idempotent registration).
        const ok = presented ? presented === w.secret_hash : !w.secret_seen && hb.secret_hash === w.secret_hash;
        if (!ok) throw new BatonError('session-taken', 'this session is registered with another secret');
        if (w.reaped_at != null) throw new BatonError('worker-reaped', 'this worker was reaped; re-key to start a new incarnation');
      }
    }

    const current = rekeyed ? hb.secret_hash : w.secret_hash; // the hash stored now
    const secretSeen = presented != null && presented === current ? 1 : 0;
    this.exec(`UPDATE workers SET last_seen_at = ?, secret_seen = MAX(secret_seen, ?), last_activity_at = COALESCE(?, last_activity_at), harness = ?, kind = ?,
                 model_id = ?, model_provider_id = ?, skills_version = ?, tier_ceiling = ?, lease_timeout_ms = ? WHERE id = ?`,
      now, secretSeen, hb.last_activity_at ?? null, hb.harness, hb.kind, hb.model_id ?? null, modelProvider, hb.skills_version, hb.tier_ceiling,
      hb.lease_timeout_s * 1000, w.id);
    // The stored hash also covers which billed accounts the reference data knows, so a prefix
    // skipped while its account was unknown is written once the account arrives (§7.4).
    const known = Object.values(hb.billing).filter((a) => knownAccounts.has(a)).sort().join(',');
    const storedHash = `${settingsHash}:${fnv1a(known)}`;
    if (storedHash !== w.settings_hash || rekeyed) this.rewriteSettings(w.id, hb, knownAccounts, storedHash);
    const refused = hb.transcript_refusals;
    const unlinked = this.recordTranscripts(w.id, hb, now);
    this.recordUsage(w.id, hb, knownAccounts, now);

    const fresh = this.rows<{ incarnation: number; lease_timeout_ms: number }>('SELECT incarnation, lease_timeout_ms FROM workers WHERE id = ?', w.id)[0];
    // R-BTN-19: only a heartbeat with the secret (never the hash path) clears a fence.
    if (hb.fenced && secretSeen) this.c.fenced?.(w.id, fresh.incarnation, hb.fenced.claim_id);
    const claim = this.activeClaim(w.id);
    return {
      worker_id: w.id,
      incarnation: fresh.incarnation,
      lease_timeout_s: fresh.lease_timeout_ms / 1000,
      claim: claim ? { ...claim, activity: this.currentActivity(w.id) } : null,
      messages: this.deliver(w.id, now),
      suspensions: this.suspensionsFor(now),
      min_skills_version: Number(this.setting('min_skills_version') ?? 0),
      mode: this.mode().mode,
      server_time: now,
      ...(refused.length ? { transcripts_refused: refused } : {}),
      ...(unlinked.length ? { transcripts_unlinked: unlinked } : {}),
    };
  }

  /** §3's write budget: capabilities and providers rows change only with the settings hash. */
  private rewriteSettings(workerId: number, hb: Heartbeat, knownAccounts: Set<string>, hash: string) {
    this.exec('DELETE FROM worker_capabilities WHERE worker_id = ?', workerId);
    const seen = new Set<string>();
    for (const declared of hb.capabilities) {
      // A role is stored as its capabilities (§7.2 rule 4), each row naming what was declared;
      // a name that expands to nothing (`none`) stores no row.
      for (const cap of capabilitiesOf([declared])) {
        if (seen.has(cap)) continue;
        seen.add(cap);
        this.exec('INSERT INTO worker_capabilities (worker_id, capability, declared) VALUES (?, ?, ?)', workerId, cap, declared);
      }
      if (declared === 'human-operator' && !seen.has('human-operator')) {
        // Rule 6 reads the declared role itself (§7.2), so it gets a row of its own.
        seen.add('human-operator');
        this.exec('INSERT INTO worker_capabilities (worker_id, capability, declared) VALUES (?, ?, ?)', workerId, 'human-operator', declared);
      }
    }
    this.exec('DELETE FROM worker_providers WHERE worker_id = ?', workerId);
    for (const [prefix, account] of Object.entries(hb.billing)) {
      if (knownAccounts.has(account)) this.exec('INSERT INTO worker_providers (worker_id, prefix, provider_id) VALUES (?, ?, ?)', workerId, prefix, account);
    }
    this.exec('UPDATE workers SET settings_hash = ? WHERE id = ?', hash, workerId);
  }

  /** §6.8: a path reported under a claim is linked to it; one reported with none waits for the
   *  next claim (`Claims.claim` links it). A repeat report moves `last_pushed_at` and fills a
   *  missing `activity_id` once that activity has arrived. */
  private recordTranscripts(workerId: number, hb: Heartbeat, now: number) {
    const unlinked: number[] = [];
    if (!hb.transcripts.length) return unlinked;
    const claim = this.activeClaim(workerId);
    for (const t of hb.transcripts) {
      // An activity not received yet only defers the link: the pointer is stored, and a later
      // report of it, once the activity has arrived, fills the link in.
      if (t.activity_id && !this.rows('SELECT 1 FROM activities WHERE worker_id = ? AND id = ?', workerId, t.activity_id).length) {
        unlinked.push(t.index ?? -1);
        t.activity_id = undefined;
      }
      if (claim) {
        this.exec(`INSERT INTO transcripts (worker_id, claim_id, repo, path, role, activity_id, first_seen_at, last_pushed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (worker_id, repo, path, claim_id) DO UPDATE SET last_pushed_at = COALESCE(excluded.last_pushed_at, transcripts.last_pushed_at),
                     activity_id = COALESCE(transcripts.activity_id, excluded.activity_id)`,
          workerId, claim.id, t.repo, t.path, t.role, t.activity_id ?? null, now, t.pushed_at ?? null);
      } else {
        this.exec(`INSERT INTO pending_transcripts (worker_id, repo, path, role, activity_id, first_seen_at, last_pushed_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (worker_id, repo, path) DO UPDATE SET last_pushed_at = COALESCE(excluded.last_pushed_at, pending_transcripts.last_pushed_at),
                     activity_id = COALESCE(pending_transcripts.activity_id, excluded.activity_id)`,
          workerId, t.repo, t.path, t.role, t.activity_id ?? null, now, t.pushed_at ?? null);
      }
    }
    return unlinked;
  }

  /** §7.3: an hour's running total replaces the row (never added), and rate limits are logged.
   *  An account the reference data does not know is skipped, never refused: it would lock a
   *  live worker out over a lagging data file. */
  private recordUsage(workerId: number, hb: Heartbeat, knownAccounts: Set<string>, now: number) {
    for (const u of hb.usage) {
      if (!knownAccounts.has(u.provider_id)) continue;
      this.exec(`INSERT INTO usage_reports (worker_id, provider_id, model_id, hour, usd_list) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (worker_id, provider_id, model_id, hour) DO UPDATE SET usd_list = excluded.usd_list`,
        workerId, u.provider_id, u.model_id, u.hour, u.usd_list);
    }
    for (const r of hb.rate_limits) {
      if (!knownAccounts.has(r.provider_id)) continue;
      this.exec('INSERT INTO rate_limit_events (provider_id, model_id, worker_id, at, resets_at) VALUES (?, ?, ?, ?, ?)',
        r.provider_id, r.model_id ?? null, workerId, now, r.resets_at ?? null);
    }
  }

  // ── messages (§9) ────────────────────────────────────────────────────────────────────────

  /** Delivery is the heartbeat (§9): pending messages become delivered; delivered ones not yet
   *  acknowledged are sent again, so a lost response loses nothing. */
  private deliver(workerId: number, now: number) {
    const out = this.rows<{ id: number; kind: string; payload_json: string | null; sent_at: number }>(
      `SELECT id, kind, payload_json, sent_at FROM messages WHERE to_worker_id = ? AND status IN ('pending','delivered')
       AND kind IN ('release','status_request') ORDER BY id`, workerId);
    this.exec(`UPDATE messages SET status = 'delivered', delivered_at = ? WHERE to_worker_id = ? AND status = 'pending'`, now, workerId);
    return out.map((m) => ({ id: m.id, kind: m.kind, payload: m.payload_json ? JSON.parse(m.payload_json) : null, sent_at: m.sent_at }));
  }

  /** `POST /v1/ui/messages`: a release (`requested`, `owner-cancel`, `provider-suspended`) or a
   *  status request, from the owner to one worker. */
  sendMessage(owner: string, body: unknown) {
    const m = checkMessage(body);
    if (!this.rows('SELECT 1 FROM workers WHERE id = ?', m.to_worker_id).length) throw new BatonError('not-found', 'no such worker');
    this.exec(`INSERT INTO messages (kind, payload_json, from_principal, to_worker_id, sent_at, status) VALUES (?, ?, ?, ?, ?, 'pending')`,
      m.kind, m.payload ? JSON.stringify(m.payload) : null, `owner:${owner}`, m.to_worker_id, this.c.now());
    return { id: this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id };
  }

  /** `POST /v1/worker/messages/{id}/ack`: the worker acknowledges; a status request's reply is
   *  stored as a `status_report` carrying the current activity (the server attaches it). */
  ack(workerId: number, messageId: number, body: unknown) {
    const reply = checkAck(body); // §10.4: before any write
    const m = this.rows<{ id: number; kind: string; status: string }>('SELECT id, kind, status FROM messages WHERE id = ? AND to_worker_id = ?', messageId, workerId)[0];
    if (!m) throw new BatonError('not-found', 'no such message for this worker');
    if (m.status === 'expired') bad('message', 'has expired');
    if (m.status === 'acknowledged') return { ok: true };
    const now = this.c.now();
    this.exec(`UPDATE messages SET status = 'acknowledged', acknowledged_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?`, now, now, m.id);
    if (m.kind === 'status_request' && reply) {
      // The table needs a recipient; a report is addressed back to its sender and read by the dashboard.
      this.exec(`INSERT INTO messages (kind, payload_json, from_worker_id, to_worker_id, in_reply_to, sent_at, delivered_at, acknowledged_at, status)
                 VALUES ('status_report', ?, ?, ?, ?, ?, ?, ?, 'acknowledged')`,
        JSON.stringify({ activity: this.currentActivity(workerId), text: reply.text }), workerId, workerId, m.id, now, now, now);
    }
    return { ok: true };
  }

  // ── activities (§6.9) ───────────────────────────────────────────────────────────────────

  /** `POST /v1/worker/activities`: each one upserted under `(worker_id, id)`, so a retry is
   *  idempotent and one worker never touches another's rows. Refusals are per activity. */
  activities(workerId: number, body: unknown) {
    const list = (body as { activities?: unknown })?.activities;
    if (!Array.isArray(list) || list.length > 200) bad('activities', 'must be a list of at most 200');
    const refused: { id: string | null; code: string; message: string }[] = [];
    const now = this.c.now();
    for (const [i, raw] of (list as unknown[]).entries()) {
      try {
        this.c.storage.transactionSync(() => this.upsertActivity(workerId, checkActivity(raw, `activities[${i}]`), now));
      } catch (e) {
        if (!(e instanceof BatonError)) throw e;
        refused.push({ id: (raw as { id?: string })?.id ?? null, code: e.code, message: e.message });
      }
    }
    return { ok: true, refused };
  }

  private upsertActivity(workerId: number, a: ActivityReport, now: number) {
    const existing = this.rows<{ kind: string; claim_id: number | null; ended_at: number | null; parent_id: string | null }>(
      'SELECT kind, claim_id, ended_at, parent_id FROM activities WHERE worker_id = ? AND id = ?', workerId, a.id)[0];
    if (existing && (existing.kind !== a.kind || (existing.claim_id ?? null) !== (a.claim_id ?? null))) {
      bad(`activity ${a.id}`, 'kind and claim_id cannot change');
    }
    if (a.claim_id !== null) {
      const claim = this.rows<{ worker_id: number; status: string; ended_at: number | null }>(
        'SELECT worker_id, status, ended_at FROM work_item_claims WHERE id = ?', a.claim_id)[0];
      if (!claim || claim.worker_id !== workerId) throw new BatonError('not-holder', `claim ${a.claim_id} is not this worker's`);
      if (claim.status !== 'active') {
        // §6.9: for 10 minutes after the end, an update that only closes an open activity is
        // accepted; anything else, and every later update, is claim-ended.
        const closesOpen = existing && existing.ended_at == null && a.ended_at !== undefined;
        if (!closesOpen || now - (claim.ended_at ?? 0) > CLOSE_GRACE_MS) throw new BatonError('claim-ended', `claim ${a.claim_id} has ended`);
      }
    }
    let parent = a.parent_id ?? existing?.parent_id ?? null;
    if (a.parent_id) {
      const p = this.rows<{ claim_id: number | null }>('SELECT claim_id FROM activities WHERE worker_id = ? AND id = ?', workerId, a.parent_id)[0];
      if (!p || (p.claim_id ?? null) !== a.claim_id) bad(`activity ${a.id}.parent_id`, 'must name this worker’s activity under the same claim');
    } else if (!existing && a.kind === 'reviewer' && a.claim_id !== null) {
      // §6.9: a reviewer is parented to the newest open review-round on its claim.
      parent = this.rows<{ id: string }>(`SELECT id FROM activities WHERE worker_id = ? AND claim_id = ? AND kind = 'review-round' AND ended_at IS NULL
                                           ORDER BY started_at DESC LIMIT 1`, workerId, a.claim_id)[0]?.id ?? null;
    }
    if (a.call_id) {
      const other = this.rows<{ id: string }>('SELECT id FROM activities WHERE worker_id = ? AND call_id = ?', workerId, a.call_id)[0];
      if (other && other.id !== a.id) bad(`activity ${a.id}.call_id`, `is already activity ${other.id}'s`);
    }
    if (existing) {
      this.exec(`UPDATE activities SET label = COALESCE(?, label), detail_json = COALESCE(?, detail_json), ended_at = COALESCE(?, ended_at),
                   outcome = COALESCE(?, outcome), seq = COALESCE(?, seq), received_at = ? WHERE worker_id = ? AND id = ?`,
        a.label ?? null, a.detail ? JSON.stringify(a.detail) : null, a.ended_at ?? null, a.outcome ?? null, a.seq ?? null, now, workerId, a.id);
      return;
    }
    this.exec(`INSERT INTO activities (worker_id, id, claim_id, parent_id, call_id, kind, seq, label, source, started_at, ended_at, outcome, received_at, detail_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      workerId, a.id, a.claim_id, parent, a.call_id ?? null, a.kind, a.seq ?? null, a.label ?? null, a.source, a.started_at,
      a.ended_at ?? null, a.outcome ?? null, now, a.detail ? JSON.stringify(a.detail) : null);
    if (a.kind === 'reviewer' && typeof a.detail?.substituted_for === 'string') {
      // §6.9: a substitution is derived from the reviewer activity, not reported separately.
      const item = a.claim_id ? this.rows<{ work_item_id: string }>('SELECT work_item_id FROM work_item_claims WHERE id = ?', a.claim_id)[0]?.work_item_id ?? null : null;
      this.event('reviewer-substituted', `worker:${workerId}`, { activity: a.id, agent: a.detail.agent ?? a.label ?? null, substituted_for: a.detail.substituted_for }, item, a.claim_id);
    }
  }

  // ── suspensions (§7.4) ──────────────────────────────────────────────────────────────────

  /** In force now, or starting within 24 hours, and not lifted: what every heartbeat carries. */
  suspensionsFor(now: number) {
    return this.rows(`SELECT id, provider_id, model_id, mode, starts_at, ends_at, reason FROM provider_suspensions
                      WHERE lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?) AND starts_at <= ? ORDER BY id`, now, now + SCHEDULED_WINDOW_MS);
  }

  setSuspension(owner: string, body: unknown) {
    const now = this.c.now();
    const s = checkSuspension(body, now);
    if (!this.rows('SELECT 1 FROM model_providers WHERE id = ?', s.provider_id).length) bad('provider_id', 'is not a known account');
    this.exec(`INSERT INTO provider_suspensions (provider_id, model_id, mode, starts_at, ends_at, reason, set_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      s.provider_id, s.model_id, s.mode, s.starts_at, s.ends_at, s.reason, `owner:${owner}`);
    const id = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
    this.event('suspension', `owner:${owner}`, { action: 'set', id, ...s });
    if (s.starts_at <= now) this.startSuspension(id, `owner:${owner}`);
    return { id };
  }

  liftSuspension(owner: string, id: number) {
    const s = this.rows<{ lifted_at: number | null }>('SELECT lifted_at FROM provider_suspensions WHERE id = ?', id)[0];
    if (!s) throw new BatonError('not-found', 'no such suspension');
    if (s.lifted_at == null) {
      this.exec('UPDATE provider_suspensions SET lifted_at = ?, lifted_by = ? WHERE id = ?', this.c.now(), `owner:${owner}`, id);
      this.event('suspension', `owner:${owner}`, { action: 'lifted', id });
    }
    return { ok: true };
  }

  /** A suspension comes into force: logged once; under `stop`, every holder on the account (or
   *  model) is sent a `release` with reason `provider-suspended` (R-BTN-21). */
  private startSuspension(id: number, actor: string) {
    const s = this.rows<{ provider_id: string; model_id: string | null; mode: string; ends_at: number | null }>('SELECT provider_id, model_id, mode, ends_at FROM provider_suspensions WHERE id = ?', id)[0];
    this.exec('UPDATE provider_suspensions SET start_logged = 1 WHERE id = ?', id);
    this.event('suspension', actor, { action: 'started', id });
    // R-BTN-21: releases only while the suspension is in force; a window that closed before the
    // alarm saw it (the object was down) is logged, never acted on.
    if (s.mode !== 'stop' || (s.ends_at != null && s.ends_at <= this.c.now())) return;
    const holders = this.rows<{ worker_id: number; work_item_id: string }>(
      `SELECT c.worker_id, c.work_item_id FROM work_item_claims c JOIN workers w ON w.id = c.worker_id
       WHERE c.status = 'active' AND w.model_provider_id = ? AND (? IS NULL OR w.model_id = ?)`, s.provider_id, s.model_id, s.model_id);
    for (const h of holders) {
      const already = this.rows(`SELECT 1 FROM messages WHERE to_worker_id = ? AND kind = 'release' AND status IN ('pending','delivered')
                                 AND json_extract(payload_json, '$.work_item_id') = ?`, h.worker_id, h.work_item_id).length;
      if (already) continue;
      this.exec(`INSERT INTO messages (kind, payload_json, from_principal, to_worker_id, sent_at, status) VALUES ('release', ?, ?, ?, ?, 'pending')`,
        JSON.stringify({ work_item_id: h.work_item_id, reason: 'provider-suspended' }), actor.startsWith('owner:') ? actor : 'alarm', h.worker_id, this.c.now());
    }
  }

  // ── the alarm's share (§3) ──────────────────────────────────────────────────────────────

  /** Scheduled starts and timed ends of suspensions (each logged once), and the expiry of a
   *  reaped worker's open messages (§9). R3-1212 adds reaping. */
  alarm() {
    const now = this.c.now();
    for (const { id } of this.rows<{ id: number }>('SELECT id FROM provider_suspensions WHERE start_logged = 0 AND lifted_at IS NULL AND starts_at <= ?', now)) {
      this.startSuspension(id, 'alarm');
    }
    for (const { id } of this.rows<{ id: number }>('SELECT id FROM provider_suspensions WHERE end_logged = 0 AND lifted_at IS NULL AND ends_at IS NOT NULL AND ends_at <= ?', now)) {
      this.exec('UPDATE provider_suspensions SET end_logged = 1 WHERE id = ?', id);
      this.event('suspension', 'alarm', { action: 'ended', id });
    }
    this.exec(`UPDATE messages SET status = 'expired' WHERE status IN ('pending','delivered')
               AND to_worker_id IN (SELECT id FROM workers WHERE reaped_at IS NOT NULL)`);
  }

  // ── mode and shadow reports (R-BTN-28, §13 step 2) ──────────────────────────────────────

  mode() {
    const at = this.setting('cutover_at');
    return at ? { mode: 'cut-over' as const, cutover_at: Number(at) } : { mode: 'shadow' as const };
  }

  /** `POST /v1/worker/shadow-report`: in shadow, `claim.sh` reports each git transition and
   *  Baton records it as a claim row, deciding nothing; a report the claim constraints refuse —
   *  a second active claim on the item or for the worker — is a `shadow-conflict` event. */
  shadowReport(workerId: number, body: unknown) {
    if (this.mode().mode !== 'shadow') throw new BatonError('forbidden', 'shadow reports end at cutover');
    const r = checkShadowReport(body);
    const actor = `worker:${workerId}`;
    const conflict = (reason: string) => {
      this.event('shadow-conflict', actor, { ...r, reason }, r.work_item_id);
      return { ok: true, conflict: reason };
    };
    const holder = this.rows<{ id: number; worker_id: number }>(`SELECT id, worker_id FROM work_item_claims WHERE work_item_id = ? AND status = 'active'`, r.work_item_id)[0];
    if (r.transition === 'claim') {
      if (holder && holder.worker_id === workerId) {
        // A retried report (same nonce) is the same claim; another nonce is a second git claim.
        const same = this.rows('SELECT 1 FROM work_item_claims WHERE id = ? AND nonce = ?', holder.id, r.nonce).length;
        return same ? { ok: true, claim_id: holder.id } : conflict('already-held');
      }
      if (holder) return conflict(`held-by-worker:${holder.worker_id}`);
      const mine = this.activeClaim(workerId);
      if (mine) return conflict(`worker-holds:${mine.work_item_id}`);
      const head = this.rows<{ sha: string }>('SELECT sha FROM board_head WHERE id = 1')[0]?.sha ?? '';
      this.exec(`INSERT INTO work_item_claims (work_item_id, worker_id, request_id, nonce, snapshot_sha, claimed_at, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'active')`, r.work_item_id, workerId, `shadow:${workerId}:${r.work_item_id}:${r.nonce}`, r.nonce!, head, r.at);
      const id = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
      this.event('claimed', actor, { shadow: true, nonce: r.nonce }, r.work_item_id, id);
      return { ok: true, claim_id: id };
    }
    // `set`: in-progress and in-review keep the claim — in-review is an activity of an active
    // claim, which lasts through the gate and the merge (§6.5); any other status ends it.
    const keeps = r.status === 'in-progress' || r.status === 'in-review';
    if (!holder) return keeps ? conflict('no-claim') : { ok: true };
    if (holder.worker_id !== workerId) return conflict(`held-by-worker:${holder.worker_id}`);
    if (keeps) return { ok: true, claim_id: holder.id };
    this.exec(`UPDATE work_item_claims SET status = 'released', ended_at = ?, end_reason = ? WHERE id = ?`, r.at, `shadow:${r.status}`, holder.id);
    this.event('released', actor, { shadow: true, status: r.status }, r.work_item_id, holder.id);
    return { ok: true, claim_id: holder.id };
  }

  // ── the dashboard's Workers view (§14) ──────────────────────────────────────────────────

  workersView(now: number) {
    const workers = this.rows<Row>(`SELECT id, hostname, session_name, harness, kind, model_id, model_provider_id, tier_ceiling, lease_timeout_ms,
                                       skills_version, first_seen_at, last_seen_at, last_activity_at, reaped_at, incarnation FROM workers ORDER BY hostname, id`);
    return workers.map((w) => {
      const id = w.id as number;
      const alive = w.reaped_at == null && now - (w.last_seen_at as number) < (w.lease_timeout_ms as number);
      const transcript = this.rows<{ repo: string; path: string }>(
        `SELECT repo, path FROM (SELECT repo, path, COALESCE(last_pushed_at, first_seen_at) AS t FROM transcripts WHERE worker_id = ?
         UNION ALL SELECT repo, path, COALESCE(last_pushed_at, first_seen_at) FROM pending_transcripts WHERE worker_id = ?) ORDER BY t DESC LIMIT 1`, id, id)[0];
      return {
        ...w,
        alive,
        capabilities: this.rows<{ capability: string; declared: string }>('SELECT capability, declared FROM worker_capabilities WHERE worker_id = ? ORDER BY capability', id),
        providers: this.rows<{ prefix: string; provider_id: string }>('SELECT prefix, provider_id FROM worker_providers WHERE worker_id = ? ORDER BY prefix', id),
        claim: this.activeClaim(id),
        activity: this.currentActivity(id),
        // §6.8: built only as a blob link from validated parts, never a reported URL.
        transcript_url: transcript ? `https://github.com/${transcript.repo}/blob/HEAD/${transcript.path}` : null,
        last_report: this.rows(`SELECT payload_json, sent_at FROM messages WHERE from_worker_id = ? AND kind = 'status_report' ORDER BY id DESC LIMIT 1`, id)[0] ?? null,
      };
    });
  }
}

