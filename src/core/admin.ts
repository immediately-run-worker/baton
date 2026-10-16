// admin.ts — Baton's administration, the one set of validated functions behind `/v1/admin/*`,
// `/v1/owner/{repository}/*` and `POST /v1/login`, which `baton admin` and `baton owner` call on
// either host (BATON_SPEC §10.6 R-BTN-57/-58, R-BTN-66/-67, R-BTN-16). Every limit the owners
// need to hold against agents lives here, in SQLite, set by an administrator's or an owner's key:
// grants, owners, owner bars and the settings — never read from a board post. Administrators are
// BATON_ADMIN_KEYS alone. One key holds one role: administrator, owner, worker, probe, courier or
// sync key. Each act is an `admin` event; a bar change also dispatches the repository's sync.
import { BatonError, SESSION_COOKIE } from './http';
import { logEvent, randomHex } from './db';
import { KEY_FINGERPRINT, parseSshKey, type SshKey } from './auth';
import { capabilitiesOf } from '../shared/vocabulary.mjs';
import { COURSE_ID, HOSTNAME, TAG, checkRepositoryId } from './validate';
import { parseTranscriptRepo } from './links';
import { checkRegistration, tierPosition, type Registration, type Registry } from './registry';
import { graphOf, resolveLeg, type Graph } from './graph';
import type { Store } from './ports';
import { sha256Hex } from './workerApi';

/** A one-time link lives 5 minutes; a session 12 hours (R-BTN-57). */
export const LOGIN_LINK_MS = 5 * 60_000;
export const SESSION_MS = 12 * 3_600_000;
/** R-BTN-16: the one cookie Baton sets. */
export { SESSION_COOKIE };
/** Spec-silent bounds (recorded on R3-1240): owner bars in force per repository, required bars,
 *  legs per bar, owners per repository, capabilities per grant, backoffs per retry policy. */
const BARS_MAX = 200;
const REQUIRED_BARS_MAX = 32;
const LEGS_MAX = 64;
const OWNERS_MAX = 16;
const CAPABILITIES_MAX = 64;
const BACKOFFS_MAX = 8;
/** A registered repository's fields §11's change form may set besides weight, tiers and keys. */
const LINK_FIELDS = ['remote', 'web_base', 'ci_identity', 'sync_workflow', 'mirror_workflow'] as const;
/** A capability or role name, as a heartbeat declares one. */
const CAPABILITY = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A login link's token and a session's value: 32 random bytes, hex. */
const TOKEN = /^[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._:@/-]{0,99}$/;

export interface RequiredBar {
  course: string;
  leg: string;
  except?: string[];
  tag_prefix: string;
}

export interface RetryPolicy {
  backoff_ms: number[];
  max_failed: number;
}

export interface OwnerBar {
  id: number;
  repository_id: string;
  course: string;
  tag: string;
  legs: string[];
  applies: 'claim' | 'claim+advance';
  starts_at: number;
  ends_at: number | null;
  release_holders: boolean;
  reason: string;
}

const bad = (field: string, why: string): never => {
  throw new BatonError('invalid-params', `${field}: ${why}`);
};
/** A key's fingerprint as a path or body names it, checked before any SQL (§10.4; round 2, 2-A-3). */
const fingerprintOf = (v: unknown, field: string): string => (typeof v === 'string' && KEY_FINGERPRINT.test(v) ? v : bad(field, 'must be a key fingerprint, SHA256:…'));
/** A bearer-token credential's id (CREDENTIALS' keys). */
const TOKEN_CREDENTIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (b: Record<string, unknown>, keys: string[], at: string) => {
  for (const k of Object.keys(b)) if (!keys.includes(k)) bad(`${at}.${k}`, 'unknown field');
};
/** A key's stored line: its type and base64 only — a comment is for people, never stored. */
const lineOf = (key: SshKey, text: string) => `${key.type} ${text.trim().split(/\s+/)[1]}`;

/** R-BTN-67: an owner bar's reason becomes `released:<reason>`; never one of §6.5's closed
 *  reasons, so an owner bar's release is never counted as a failed attempt (§6.10). */
export function isOwnerBarReason(r: unknown): r is string {
  return typeof r === 'string' && COURSE_ID.test(r) && !(CLOSED_RELEASE_REASONS as readonly string[]).includes(r) && !r.startsWith('cannot-finish');
}
/** §6.5's closed release reasons, which an owner bar's never is. `provider-suspended` is not one:
 *  R-BTN-67 gives it as an owner bar's own reason (round 2, 2-A-0). */
const CLOSED_RELEASE_REASONS = ['done', 'stale-board', 'cannot-finish', 'lease-lost', 'requested', 'owner-cancel', 'course-changed', 'leg-timeout', 'awaiting-review-capacity', 'provider-exhausted'] as const;

/** Whether `tags` meet a required bar: one of them starts with its prefix (R-BTN-67). */
export const meetsRequiredBar = (bar: RequiredBar, tags: string[]) => tags.some((t) => t.startsWith(bar.tag_prefix));

/** A required bar covers a leg of a course (R-BTN-67): its course, or `*`; its named leg —
 *  followed through `renamed_from` in the course's file — or every leg but those in `except`. */
export function requiredBarCovers(bar: RequiredBar, course: string, leg: string, g: Graph | null): boolean {
  if (bar.course !== '*' && bar.course !== course) return false;
  const name = (n: string) => (g ? resolveLeg(g, n) ?? n : n);
  if (bar.leg !== '*') return name(bar.leg) === leg;
  return !(bar.except ?? []).some((e) => name(e) === leg);
}

export class Admin {
  constructor(private readonly c: {
    store: Store;
    now: () => number;
    registry: Registry;
    /** BATON_ADMIN_KEYS' lines, read on every call (a key that leaves ends its sessions). */
    adminKeys: () => string[];
    origin: string;
    /** R-BTN-67: a bar change dispatches the repository's sync, after commit. */
    dispatchSync: (repository: string) => void;
  }) {}

  private rows<T = Record<string, unknown>>(q: string, ...p: unknown[]): T[] {
    return this.c.store.exec<T>(q, ...p).toArray();
  }
  private exec(q: string, ...p: unknown[]) {
    return this.c.store.exec(q, ...p);
  }
  /** Rows the last statement changed (SQLite's `changes()`, the same on both hosts). */
  private changed(): number {
    return this.rows<{ n: number }>('SELECT changes() AS n')[0].n;
  }
  private event(actor: string, detail: Record<string, unknown>, repository: string | null) {
    logEvent(this.c.store, this.c.now(), 'admin', actor, detail, null, null, repository);
  }

  // ── principals ──────────────────────────────────────────────────────────────────────────

  /** The administrators' keys by fingerprint (R-BTN-57). An unparsable line is no key. */
  async adminFingerprints(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const line of this.c.adminKeys()) {
      try {
        const k = await parseSshKey(line);
        out.set(k.fingerprint, lineOf(k, line));
      } catch {
        // A line that is no key admits nobody.
      }
    }
    return out;
  }

  /** An owner key's line by fingerprint, if it owns any repository (R-BTN-58). */
  ownerKey(fingerprint: string): string | null {
    return this.rows<{ public_key: string }>('SELECT public_key FROM repository_owners WHERE fingerprint = ? AND removed_at IS NULL LIMIT 1', fingerprint)[0]?.public_key ?? null;
  }

  /** Whether `fingerprint` owns `repository` now. */
  owns(fingerprint: string, repository: string): boolean {
    return this.rows('SELECT 1 FROM repository_owners WHERE fingerprint = ? AND repository_id = ? AND removed_at IS NULL', fingerprint, repository).length > 0;
  }

  /** R-BTN-57: the role a key already holds, if any — one role per key. */
  private roleOf(fingerprint: string, admins: Map<string, string>): string | null {
    if (admins.has(fingerprint)) return 'administrator';
    if (this.rows('SELECT 1 FROM repository_owners WHERE fingerprint = ? AND removed_at IS NULL', fingerprint).length) return 'owner';
    if (this.rows('SELECT 1 FROM sync_keys WHERE fingerprint = ?', fingerprint).length) return 'sync';
    const c = this.rows<{ kind: string }>('SELECT kind FROM credentials WHERE id = ?', fingerprint)[0];
    return c ? c.kind : null;
  }

  /** Whether `fingerprint` may become an owner of `repository` (null: a new one): no other role
   *  (R-BTN-57), and not an owner key an administrator revoked — another owner never brings it
   *  back (round 1, 1-A-3). Throws `conflict`. */
  private mayOwn(fingerprint: string, admins: Map<string, string>) {
    if (this.rows('SELECT 1 FROM repository_owners WHERE fingerprint = ? AND revoked_at IS NOT NULL', fingerprint).length) {
      throw new BatonError('conflict', 'this owner key was revoked; its holder needs a new key');
    }
    const role = this.roleOf(fingerprint, admins);
    if (role && role !== 'owner') throw new BatonError('conflict', `this key is already a ${role} key (R-BTN-57: one role per key)`);
  }

  // ── administrators (R-BTN-57) ───────────────────────────────────────────────────────────

  /** `POST /v1/admin/repositories`: register one with its first owner keys, change one (never its
   *  forge or forge path, R-BTN-92), or retire one. */
  async repositories(actor: string, body: unknown) {
    if (!isObj(body)) bad('body', 'must be a JSON object');
    const b = body as Record<string, unknown>;
    const id = checkRepositoryId(b.id, 'id');
    const known = this.c.registry.get(id);
    if (b.retire === true) {
      only(b, ['id', 'retire'], 'body');
      if (!known) throw new BatonError('not-found', `${id} is not registered`);
      this.c.store.transaction(() => {
        this.exec('UPDATE repositories SET retired_at = ? WHERE id = ? AND retired_at IS NULL', this.c.now(), id);
        this.event(actor, { act: 'repository-retired', repository: id }, id);
      });
      return { ok: true };
    }
    if (!known) {
      const owners = await this.ownerKeys(b.owner_keys, 'owner_keys');
      if (!owners.length) bad('owner_keys', 'a repository is registered with at least one owner key');
      const { owner_keys: _o, ...registration } = b;
      const admins = await this.adminFingerprints();
      for (const o of owners) this.mayOwn(o.fingerprint, admins);
      // One role per key (R-BTN-57): a key named both as owner and as sync key is refused before
      // either is written — registerWithKeys commits the sync keys in a transaction of its own.
      const syncKeys = Array.isArray(registration.sync_keys) ? registration.sync_keys : [];
      for (const k of syncKeys) {
        const line = isObj(k) && typeof k.public_key === 'string' ? k.public_key : null;
        const fp = line ? (await parseSshKey(line).catch(() => null))?.fingerprint : null;
        if (fp && owners.some((o) => o.fingerprint === fp)) throw new BatonError('conflict', 'a key is named both as an owner key and as a sync key (R-BTN-57)');
      }
      // registerWithKeys runs its own transaction; the owners follow in another, after it.
      await this.c.registry.registerWithKeys(registration, actor, this.c.adminKeys());
      this.c.store.transaction(() => {
        for (const o of owners) {
          this.mayOwn(o.fingerprint, admins);
          this.insertOwner(id, o, actor);
        }
        this.event(actor, { act: 'repository-registered', repository: id, owners: owners.map((o) => o.fingerprint) }, id);
      });
      return { ok: true };
    }
    return this.changeRepository(actor, id, b);
  }

  /** A change to a registered repository: its weight and tiers (the tickets' positions follow),
   *  its sync keys, and — for a repository registered before owners existed (BATON_REPOSITORIES'
   *  seed; spec-silent, recorded on R3-1240) — owner keys. Everything else is its registration's. */
  private async changeRepository(actor: string, id: string, b: Record<string, unknown>) {
    only(b, ['id', 'weight', 'tiers', 'sync_keys_add', 'sync_keys_remove', 'owner_keys_add', ...LINK_FIELDS], 'body');
    // A change names something to change; an empty one is a caller's mistake (round 3, 3-A-1).
    if (Object.keys(b).length === 1) bad('body', 'a change names at least one field besides id');
    const newOwners = b.owner_keys_add === undefined ? [] : await this.ownerKeys(b.owner_keys_add, 'owner_keys_add');
    const weight = b.weight === undefined ? undefined
      : Number.isInteger(b.weight) && (b.weight as number) >= 0 && (b.weight as number) <= 10_000 ? (b.weight as number) : bad('weight', 'must be an integer from 0 to 10000');
    const tiers = b.tiers === undefined ? undefined
      : Array.isArray(b.tiers) && b.tiers.length >= 1 && b.tiers.length <= 16 && b.tiers.every((t) => typeof t === 'string' && COURSE_ID.test(t)) && new Set(b.tiers).size === b.tiers.length
        ? (b.tiers as string[]) : bad('tiers', 'must be 1–16 distinct tier names, lowest first');
    const add = b.sync_keys_add === undefined ? [] : Array.isArray(b.sync_keys_add) && b.sync_keys_add.length <= 4 && b.sync_keys_add.every((k) => isObj(k) && typeof k.public_key === 'string' && ['sync', 'mirror'].includes(k.role as string))
      ? (b.sync_keys_add as { public_key: string; role: 'sync' | 'mirror' }[]) : bad('sync_keys_add', 'must be at most 4 {public_key, role: sync|mirror}');
    const remove = b.sync_keys_remove === undefined ? [] : Array.isArray(b.sync_keys_remove) && b.sync_keys_remove.length <= 4
      ? b.sync_keys_remove.map((f, i) => fingerprintOf(f, `sync_keys_remove[${i}]`)) : bad('sync_keys_remove', 'must be at most 4 fingerprints');
    // §11's remote, web_base, ci_identity and workflows: the whole registration they leave behind is
    // checked as a registration is — never the forge or forge path (R-BTN-92; round 2, 2-A-4).
    let linked: Registration | null = null;
    if (LINK_FIELDS.some((k) => b[k] !== undefined)) {
      const cur = this.c.registry.get(id)!;
      const keys = [
        ...this.rows<{ fingerprint: string; public_key: string; role: 'sync' | 'mirror' }>('SELECT fingerprint, public_key, role FROM sync_keys WHERE repository_id = ? AND revoked_at IS NULL', id)
          .filter((k) => !remove.includes(k.fingerprint)).map(({ public_key, role }) => ({ public_key, role })),
        ...add,
      ];
      const current = { id, github: cur.github, forge: cur.forge, remote: cur.remote, ...(cur.web_base != null ? { web_base: cur.web_base } : {}), ci_identity: cur.ci_identity,
        default_branch: cur.default_branch, sync_workflow: cur.sync_workflow || null, mirror_workflow: cur.mirror_workflow, sync_keys: keys };
      linked = checkRegistration({ ...current, ...Object.fromEntries(LINK_FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, b[k]])) }, 'body');
    }
    // Every check before any write: the sync keys commit in transactions of their own, so a
    // refusal after them would leave the change half applied.
    const admins = await this.adminFingerprints();
    for (const o of newOwners) this.mayOwn(o.fingerprint, admins);
    const addKeys = await Promise.all(add.map((k) => parseSshKey(k.public_key)));
    for (const key of addKeys) {
      if (this.roleOf(key.fingerprint, admins)) throw new BatonError('conflict', `${key.fingerprint} already holds a role (R-BTN-57)`);
      if (newOwners.some((o) => o.fingerprint === key.fingerprint)) throw new BatonError('conflict', 'a key is named both as an owner key and as a sync key (R-BTN-57)');
    }
    for (const k of add) await this.c.registry.addSyncKey(id, k.public_key, k.role, actor, this.c.adminKeys());
    // The ladder a grant's max_tier was a position in, read before the new one is written.
    const old = this.c.registry.get(id)!.tiers;
    this.c.store.transaction(() => {
      for (const o of newOwners) {
        if (this.owns(o.fingerprint, id)) continue;
        this.mayOwn(o.fingerprint, admins);
        this.insertOwner(id, o, actor);
      }
      if (weight !== undefined) this.exec('UPDATE repositories SET weight = ? WHERE id = ?', weight, id);
      if (tiers) {
        this.exec('UPDATE repositories SET tiers = ? WHERE id = ?', JSON.stringify(tiers), id);
        // A ticket's tier is matched as its position in the ladder (R-BTN-66): recompute them.
        for (const t of this.rows<{ id: string; tier: string | null }>('SELECT id, tier FROM tickets WHERE repository_id = ?', id)) {
          this.exec('UPDATE tickets SET tier_position = ? WHERE id = ?', tierPosition(tiers, t.tier), t.id);
        }
        // A grant's max_tier was a position in the old ladder: kept by name where the new one has it.
        for (const g of this.rows<{ credential_id: string; max_tier: number | null }>('SELECT credential_id, max_tier FROM worker_grants WHERE repository_id = ? AND max_tier IS NOT NULL', id)) {
          const name = old[g.max_tier!];
          this.exec('UPDATE worker_grants SET max_tier = ? WHERE credential_id = ? AND repository_id = ?', name && tiers.includes(name) ? tiers.indexOf(name) : 0, g.credential_id, id);
        }
      }
      for (const fp of remove) this.exec('UPDATE sync_keys SET revoked_at = ? WHERE fingerprint = ? AND repository_id = ? AND revoked_at IS NULL', this.c.now(), fp, id);
      if (linked) {
        this.exec('UPDATE repositories SET remote = ?, web_base = ?, ci_identity = ?, sync_workflow = ?, mirror_workflow = ?, dispatch = ? WHERE id = ?',
          linked.remote, linked.web_base, linked.ci_identity ? JSON.stringify(linked.ci_identity) : null, linked.sync_workflow, linked.mirror_workflow,
          // The App serves github.com alone, as at registration.
          linked.forge === 'github' && linked.web_base?.toLowerCase() === `https://github.com/${linked.github.toLowerCase()}` ? '{"kind":"github-app"}' : null, id);
      }
      this.event(actor, { act: 'repository-changed', repository: id, ...(weight !== undefined ? { weight } : {}), ...(tiers ? { tiers } : {}),
        ...(add.length ? { sync_keys_added: add.length } : {}), ...(remove.length ? { sync_keys_removed: remove } : {}),
        ...(newOwners.length ? { owners_added: newOwners.map((o) => o.fingerprint) } : {}),
        ...(linked ? Object.fromEntries(LINK_FIELDS.filter((k) => b[k] !== undefined).map((k) => [k, (linked as unknown as Record<string, unknown>)[k]])) : {}) }, id);
    });
    return { ok: true };
  }

  /** `POST /v1/admin/probes`: a probe key with its label and the instances it may report on
   *  (R-BTN-53; the instances are R3-1251's to read). */
  async addProbe(actor: string, body: unknown) {
    if (!isObj(body)) bad('body', 'must be a JSON object');
    const b = body as Record<string, unknown>;
    only(b, ['public_key', 'label', 'instances'], 'body');
    const key = await this.parseKey(b.public_key, 'public_key');
    const label = typeof b.label === 'string' && LABEL.test(b.label) ? b.label : bad('label', 'must be a short label');
    const instances = Array.isArray(b.instances) && b.instances.length <= 64 && b.instances.every((i) => typeof i === 'string' && /^[a-z][a-z0-9:._/-]{0,79}$/.test(i))
      ? (b.instances as string[]) : bad('instances', 'must be at most 64 instance names');
    const admins = await this.adminFingerprints();
    this.c.store.transaction(() => {
      const role = this.roleOf(key.fingerprint, admins);
      if (role) throw new BatonError('conflict', `this key is already a ${role} key (R-BTN-57: one role per key)`);
      this.exec(`INSERT INTO credentials (id, hostname, allowed_capabilities, kind, public_key, created_by, label, allowed_instances) VALUES (?, ?, '[]', 'probe', ?, ?, ?, ?)`,
        key.fingerprint, `probe:${key.fingerprint}`, key.line, actor, label, JSON.stringify(instances));
      this.event(actor, { act: 'probe-added', key: key.fingerprint, label }, null);
    });
    return { ok: true };
  }

  /** `POST /v1/admin/keys/{fingerprint}/revoke`: any key, at once — a worker, probe or courier
   *  credential, a sync key, or an owner key on every repository it owns. A worker's grants go
   *  with it, so its next call is refused. An administrator key is revoked by editing the secret. */
  revokeKey(actor: string, raw: string) {
    // A key's fingerprint, or a bearer-token credential's id while tokens serve (R3-1239).
    const fingerprint = KEY_FINGERPRINT.test(raw) || TOKEN_CREDENTIAL.test(raw) ? raw : bad('fingerprint', 'must be a key fingerprint, SHA256:…, or a token credential’s id');
    return this.c.store.transaction(() => {
      const now = this.c.now();
      // `revoked_by` keeps an administrator's revoke through a later CREDENTIALS/TOKEN_HASHES edit (round 2, 2-A-2).
      this.exec('UPDATE credentials SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', now, actor, fingerprint);
      let changed = this.changed();
      this.exec('UPDATE worker_grants SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL', now, fingerprint);
      this.exec('UPDATE sync_keys SET revoked_at = ? WHERE fingerprint = ? AND revoked_at IS NULL', now, fingerprint);
      changed += this.changed();
      this.exec('UPDATE repository_owners SET removed_at = coalesce(removed_at, ?), revoked_at = ? WHERE fingerprint = ? AND revoked_at IS NULL', now, now, fingerprint);
      changed += this.changed();
      if (!changed && !this.rows('SELECT 1 FROM credentials WHERE id = ? UNION SELECT 1 FROM sync_keys WHERE fingerprint = ? UNION SELECT 1 FROM repository_owners WHERE fingerprint = ?', fingerprint, fingerprint, fingerprint).length) {
        throw new BatonError('not-found', 'no key with that fingerprint');
      }
      this.event(actor, { act: 'key-revoked', key: fingerprint }, null);
      return { ok: true };
    });
  }

  /** `POST /v1/admin/login-links`: a one-time dashboard link, its token in the fragment so it never
   *  reaches a log; valid 5 minutes, single use. */
  async loginLink(adminFingerprint: string) {
    const token = randomHex(32);
    const hash = await sha256Hex(token);
    this.c.store.transaction(() => {
      this.exec('DELETE FROM login_links WHERE expires_at < ?', this.c.now() - LOGIN_LINK_MS);
      this.exec('INSERT INTO login_links (token_hash, admin_key, expires_at) VALUES (?, ?, ?)', hash, adminFingerprint, this.c.now() + LOGIN_LINK_MS);
      this.event(`admin:${adminFingerprint}`, { act: 'login-link' }, null);
    });
    return { url: `${this.c.origin}/login#${token}` };
  }

  /** `POST /v1/login {token}`: marks the link used and opens a session, returning the cookie's
   *  value — only while the key that minted the link is still an administrator. */
  async login(body: unknown): Promise<string> {
    const token = isObj(body) && typeof body.token === 'string' && TOKEN.test(body.token) ? body.token : bad('token', 'must be the link’s token');
    const hash = await sha256Hex(token);
    const admins = await this.adminFingerprints();
    const value = randomHex(32);
    const id = await sha256Hex(value);
    return this.c.store.transaction(() => {
      const now = this.c.now();
      const link = this.rows<{ admin_key: string; expires_at: number; used_at: number | null }>('SELECT admin_key, expires_at, used_at FROM login_links WHERE token_hash = ?', hash)[0];
      if (!link || link.used_at != null || link.expires_at <= now || !admins.has(link.admin_key)) throw new BatonError('unauthenticated', 'the link is used, expired or unknown');
      this.exec('UPDATE login_links SET used_at = ? WHERE token_hash = ?', now, hash);
      this.exec('DELETE FROM dashboard_sessions WHERE expires_at < ?', now - SESSION_MS);
      this.exec('INSERT INTO dashboard_sessions (id_hash, admin_key, created_at, expires_at) VALUES (?, ?, ?, ?)', id, link.admin_key, now, now + SESSION_MS);
      return value;
    });
  }

  /** The administrator a dashboard session cookie stands for, or null: a live, unrevoked session
   *  whose key is still in BATON_ADMIN_KEYS — checked on every request. */
  async session(value: string | null): Promise<string | null> {
    if (!value || !TOKEN.test(value)) return null;
    const id = await sha256Hex(value);
    const s = this.rows<{ admin_key: string; expires_at: number; revoked_at: number | null }>('SELECT admin_key, expires_at, revoked_at FROM dashboard_sessions WHERE id_hash = ?', id)[0];
    if (!s || s.revoked_at != null || s.expires_at <= this.c.now()) return null;
    return (await this.adminFingerprints()).has(s.admin_key) ? s.admin_key : null;
  }

  // ── grants (R-BTN-58) ───────────────────────────────────────────────────────────────────

  /** `POST /v1/owner/{repository}/grants` and `POST /v1/admin/grants`: grant a worker key access to
   *  one repository, with the capabilities it may use there and its `max_tier`. The first grant of
   *  an unknown key names its hostname, unique among keys in force; a later one naming another is
   *  `conflict` — only an administrator changes it. `human-operator` only from an administrator. */
  async grant(actor: string, repository: string, body: unknown, by: 'owner' | 'admin') {
    if (!isObj(body)) bad('body', 'must be a JSON object');
    const b = body as Record<string, unknown>;
    only(b, by === 'admin' ? ['repository', 'public_key', 'hostname', 'label', 'capabilities', 'max_tier'] : ['public_key', 'hostname', 'label', 'capabilities', 'max_tier'], 'body');
    const repo = this.c.registry.get(repository);
    if (!repo || repo.retired_at != null) throw new BatonError('not-found', `${repository} is not registered`);
    const key = await this.parseKey(b.public_key, 'public_key');
    const hostname = b.hostname === undefined ? null : typeof b.hostname === 'string' && HOSTNAME.test(b.hostname) ? b.hostname : bad('hostname', 'must be a hostname');
    const label = b.label === undefined ? null : typeof b.label === 'string' && LABEL.test(b.label) ? b.label : bad('label', 'must be a short label');
    const raw = Array.isArray(b.capabilities) && b.capabilities.length <= CAPABILITIES_MAX && b.capabilities.every((x) => typeof x === 'string' && CAPABILITY.test(x))
      ? (b.capabilities as string[]) : bad('capabilities', `must be at most ${CAPABILITIES_MAX} capability names`);
    // Stored expanded (§4): a role as its capabilities; human-operator as itself, rule 6's own.
    const expanded = [...new Set([...capabilitiesOf(raw), ...(raw.includes('human-operator') ? ['human-operator'] : [])])].sort();
    if (expanded.includes('human-operator') && by !== 'admin') throw new BatonError('forbidden', 'only an administrator grants human-operator (R-BTN-58)');
    const maxTier = b.max_tier == null ? null : typeof b.max_tier === 'string' && repo.tiers.includes(b.max_tier) ? repo.tiers.indexOf(b.max_tier) : bad('max_tier', `must be one of ${repo.tiers.join(', ')}`);
    const admins = await this.adminFingerprints();
    return this.c.store.transaction(() => {
      const role = this.roleOf(key.fingerprint, admins);
      if (role && role !== 'worker') throw new BatonError('conflict', `this key is already a ${role} key (R-BTN-57: one role per key)`);
      const cred = this.rows<{ hostname: string; revoked_at: number | null }>('SELECT hostname, revoked_at FROM credentials WHERE id = ?', key.fingerprint)[0];
      if (cred?.revoked_at != null) throw new BatonError('conflict', 'this key was revoked; the machine needs a new key');
      if (!cred) {
        if (!hostname) bad('hostname', 'the first grant of a key names its hostname');
        if (this.rows(`SELECT 1 FROM credentials WHERE hostname = ? AND revoked_at IS NULL AND kind IN ('worker','token')`, hostname).length) {
          throw new BatonError('conflict', `${hostname} already has a key in force`);
        }
        this.exec(`INSERT INTO credentials (id, hostname, allowed_capabilities, kind, public_key, created_by, label) VALUES (?, ?, '[]', 'worker', ?, ?, ?)`,
          key.fingerprint, hostname, key.line, actor, label);
      } else if (this.rows(`SELECT 1 FROM credentials WHERE id = ? AND created_by = 'seed'`, key.fingerprint).length) {
        // A BATON_KEYS key reaches every repository until grants bind it; binding it would cut it
        // off from the others, which owning one repository never may (R-BTN-58; round 1, 1-B-0).
        // Only an administrator takes it over — its grants bind it from then on, and the seed never
        // revokes it.
        if (by !== 'admin') throw new BatonError('conflict', 'this key is seeded from BATON_KEYS and reaches every repository; an administrator grants it');
        this.exec('UPDATE credentials SET created_by = ? WHERE id = ?', actor, key.fingerprint);
      }
      if (cred && hostname && hostname !== cred.hostname) {
        if (by !== 'admin') throw new BatonError('conflict', `this key's hostname is ${cred.hostname}; only an administrator changes it (R-BTN-58)`);
        if (this.rows(`SELECT 1 FROM credentials WHERE hostname = ? AND revoked_at IS NULL AND id != ?`, hostname, key.fingerprint).length) throw new BatonError('conflict', `${hostname} already has a key in force`);
        this.exec('UPDATE credentials SET hostname = ? WHERE id = ?', hostname, key.fingerprint);
      }
      // An owner's re-grant keeps an administrator's human-operator: only an administrator takes it away.
      const prior = this.rows<{ capabilities: string; revoked_at: number | null }>('SELECT capabilities, revoked_at FROM worker_grants WHERE credential_id = ? AND repository_id = ?', key.fingerprint, repository)[0];
      const keepOp = by === 'owner' && prior && prior.revoked_at == null && (JSON.parse(prior.capabilities) as string[]).includes('human-operator');
      const caps = keepOp ? [...new Set([...expanded, 'human-operator'])].sort() : expanded;
      this.exec(`INSERT INTO worker_grants (credential_id, repository_id, capabilities, max_tier, granted_by, granted_at) VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT (credential_id, repository_id) DO UPDATE SET capabilities = excluded.capabilities, max_tier = excluded.max_tier,
                   granted_by = excluded.granted_by, granted_at = excluded.granted_at, revoked_at = NULL`,
        key.fingerprint, repository, JSON.stringify(caps), maxTier, actor, this.c.now());
      this.event(actor, { act: 'grant', key: key.fingerprint, repository, capabilities: caps, max_tier: maxTier }, repository);
      return { ok: true, fingerprint: key.fingerprint };
    });
  }

  /** `POST /v1/owner/{repository}/grants/{fingerprint}/revoke`: this repository's grant only. */
  revokeGrant(actor: string, repository: string, raw: string) {
    const fingerprint = fingerprintOf(raw, 'fingerprint');
    return this.c.store.transaction(() => {
      this.exec('UPDATE worker_grants SET revoked_at = ? WHERE credential_id = ? AND repository_id = ? AND revoked_at IS NULL', this.c.now(), fingerprint, repository);
      if (!this.changed()) throw new BatonError('not-found', `no grant of ${fingerprint} on ${repository}`);
      this.event(actor, { act: 'grant-revoked', key: fingerprint, repository }, repository);
      return { ok: true };
    });
  }

  // ── owners (R-BTN-58) ───────────────────────────────────────────────────────────────────

  /** `POST /v1/owner/{repository}/owners`: `{public_key}` adds an owner, `{fingerprint, remove:
   *  true}` removes one — never the last. */
  async owners(actor: string, repository: string, body: unknown) {
    if (!isObj(body)) bad('body', 'must be a JSON object');
    const b = body as Record<string, unknown>;
    if (b.remove === true) {
      only(b, ['fingerprint', 'remove'], 'body');
      const fp = fingerprintOf(b.fingerprint, 'fingerprint');
      return this.c.store.transaction(() => {
        const left = this.rows<{ fingerprint: string }>('SELECT fingerprint FROM repository_owners WHERE repository_id = ? AND removed_at IS NULL', repository);
        if (!left.some((o) => o.fingerprint === fp)) throw new BatonError('not-found', `${fp} does not own ${repository}`);
        if (left.length === 1) throw new BatonError('conflict', 'a repository keeps at least one owner (R-BTN-58)');
        this.exec('UPDATE repository_owners SET removed_at = ? WHERE repository_id = ? AND fingerprint = ? AND removed_at IS NULL', this.c.now(), repository, fp);
        this.event(actor, { act: 'owner-removed', key: fp, repository }, repository);
        return { ok: true };
      });
    }
    only(b, ['public_key'], 'body');
    const [key] = await this.ownerKeys([b.public_key], 'public_key');
    const admins = await this.adminFingerprints();
    return this.c.store.transaction(() => {
      if (this.owns(key.fingerprint, repository)) return { ok: true };
      this.mayOwn(key.fingerprint, admins);
      if (this.rows('SELECT 1 FROM repository_owners WHERE repository_id = ? AND removed_at IS NULL', repository).length >= OWNERS_MAX) bad('public_key', `a repository has at most ${OWNERS_MAX} owners`);
      this.insertOwner(repository, key, actor);
      this.event(actor, { act: 'owner-added', key: key.fingerprint, repository }, repository);
      return { ok: true };
    });
  }

  private insertOwner(repository: string, key: { fingerprint: string; line: string }, actor: string) {
    this.exec(`INSERT INTO repository_owners (repository_id, public_key, fingerprint, added_by, added_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (repository_id, public_key) DO UPDATE SET removed_at = NULL, added_by = excluded.added_by, added_at = excluded.added_at`,
      repository, key.line, key.fingerprint, actor, this.c.now());
  }

  // ── owner bars and settings (R-BTN-66, R-BTN-67) ────────────────────────────────────────

  /** `POST /v1/owner/{repository}/bars`: an owner bar `{course, tag, legs?, applies, starts_at?,
   *  ends_at?, release_holders?, reason}`; named legs need a named course. */
  setBar(actor: string, repository: string, body: unknown) {
    if (!isObj(body)) bad('body', 'must be a JSON object');
    const b = body as Record<string, unknown>;
    only(b, ['course', 'tag', 'legs', 'applies', 'starts_at', 'ends_at', 'release_holders', 'reason'], 'body');
    const now = this.c.now();
    const course = b.course === '*' ? '*' : typeof b.course === 'string' && COURSE_ID.test(b.course) ? b.course : bad('course', "must be a course id or '*'");
    const tag = typeof b.tag === 'string' && TAG.test(b.tag) ? b.tag : bad('tag', 'must be a tag');
    const legs = b.legs === undefined ? [] : Array.isArray(b.legs) && b.legs.length <= LEGS_MAX && b.legs.every((l) => typeof l === 'string' && COURSE_ID.test(l))
      ? [...new Set(b.legs as string[])] : bad('legs', `must be at most ${LEGS_MAX} leg names`);
    if (legs.length && course === '*') bad('legs', "named legs need a named course, not '*'");
    // A named course is one the repository registers, and each named leg resolves in its file —
    // a typo would bar nothing (round 1, 1-A-4).
    if (course !== '*') {
      const file = this.rows<{ course_json: string }>('SELECT course_json FROM courses WHERE repository_id = ? AND id = ?', repository, course)[0]?.course_json;
      if (!file) bad('course', `${repository} registers no course ${course}`);
      const g = graphOf(JSON.parse(file!));
      for (const l of legs) if (!resolveLeg(g, l)) bad('legs', `${course}'s course file has no leg ${l}`);
    }
    const applies = b.applies === 'claim' || b.applies === 'claim+advance' ? b.applies : bad('applies', "must be 'claim' or 'claim+advance'");
    const startsAt = b.starts_at === undefined ? now : Number.isSafeInteger(b.starts_at) && (b.starts_at as number) >= 0 ? (b.starts_at as number) : bad('starts_at', 'must be epoch ms');
    const endsAt = b.ends_at == null ? null : Number.isSafeInteger(b.ends_at) && (b.ends_at as number) > Math.max(startsAt, now) ? (b.ends_at as number) : bad('ends_at', 'must be epoch ms after starts_at and now');
    if (b.release_holders !== undefined && typeof b.release_holders !== 'boolean') bad('release_holders', 'must be true or false');
    const reason = isOwnerBarReason(b.reason) ? b.reason : bad('reason', 'must be a short id, never one of §6.5’s closed reasons');
    return this.c.store.transaction(() => {
      if (this.rows('SELECT 1 FROM owner_bars WHERE repository_id = ? AND lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?)', repository, now).length >= BARS_MAX) {
        bad('body', `a repository has at most ${BARS_MAX} bars in force or scheduled`);
      }
      this.exec(`INSERT INTO owner_bars (repository_id, course, tag, legs, applies, starts_at, ends_at, release_holders, reason, set_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        repository, course, tag, JSON.stringify(legs), applies, startsAt, endsAt, b.release_holders === true ? 1 : 0, reason, actor);
      const id = this.rows<{ id: number }>('SELECT last_insert_rowid() AS id')[0].id;
      this.event(actor, { act: 'bar-set', id, repository, course, tag, legs, applies, starts_at: startsAt, ends_at: endsAt, release_holders: b.release_holders === true, reason }, repository);
      this.c.dispatchSync(repository);
      return { id };
    });
  }

  /** `POST /v1/owner/{repository}/bars/{id}/lift`. */
  liftBar(actor: string, repository: string, id: number) {
    return this.c.store.transaction(() => {
      this.exec('UPDATE owner_bars SET lifted_at = ? WHERE id = ? AND repository_id = ? AND lifted_at IS NULL', this.c.now(), id, repository);
      if (!this.changed()) throw new BatonError('not-found', `no bar ${id} in force on ${repository}`);
      this.event(actor, { act: 'bar-lifted', id, repository }, repository);
      this.c.dispatchSync(repository);
      return { ok: true };
    });
  }

  /** `PUT /v1/owner/{repository}/settings`: `required_bars`, `retry`, `transcript_repos`,
   *  `unblocked_trigger` — each given replaces that setting whole. */
  setSettings(actor: string, repository: string, body: unknown) {
    if (!isObj(body)) bad('body', 'must be a JSON object');
    const b = body as Record<string, unknown>;
    only(b, ['required_bars', 'retry', 'transcript_repos', 'unblocked_trigger'], 'body');
    if (!Object.keys(b).length) bad('body', 'names at least one setting');
    const sets: [string, string | null][] = [];
    if (b.required_bars !== undefined) sets.push(['required_bars', JSON.stringify(this.checkRequiredBars(repository, b.required_bars))]);
    if (b.retry !== undefined) sets.push(['retry', b.retry === null ? null : JSON.stringify(checkRetry(b.retry))]);
    if (b.transcript_repos !== undefined) {
      const t = Array.isArray(b.transcript_repos) && b.transcript_repos.length <= 20 && b.transcript_repos.every((x) => typeof x === 'string' && parseTranscriptRepo(x) !== null)
        ? b.transcript_repos : bad('transcript_repos', 'must be at most 20 repositories, each a GitHub owner/name or <forge>:<web_base>');
      sets.push(['transcript_repos', JSON.stringify(t)]);
    }
    if (b.unblocked_trigger !== undefined) sets.push(['unblocked_trigger', b.unblocked_trigger === null ? null : JSON.stringify(checkTrigger(b.unblocked_trigger))]);
    return this.c.store.transaction(() => {
      for (const [k, v] of sets) this.exec(`UPDATE repositories SET ${k} = ? WHERE id = ?`, v, repository);
      this.event(actor, { act: 'settings', repository, ...Object.fromEntries(sets.map(([k, v]) => [k, v == null ? null : JSON.parse(v)])) }, repository);
      // Required bars are applied as a snapshot's legs are stored: the next sync re-stores them
      // now rather than at the schedule (round 1, 1-A-8).
      if (b.required_bars !== undefined) this.c.dispatchSync(repository);
      return { ok: true };
    });
  }

  /** R-BTN-67's required bars: `{course | *, leg | *, except?, tag_prefix}`, a named `leg` only
   *  under a named course — and, while that course's file is in force, a leg it has. */
  private checkRequiredBars(repository: string, v: unknown): RequiredBar[] {
    if (!Array.isArray(v) || v.length > REQUIRED_BARS_MAX) bad('required_bars', `must be a list of at most ${REQUIRED_BARS_MAX}`);
    return (v as unknown[]).map((raw, i) => {
      const at = `required_bars[${i}]`;
      if (!isObj(raw)) bad(at, 'must be an object');
      const x = raw as Record<string, unknown>;
      only(x, ['course', 'leg', 'except', 'tag_prefix'], at);
      const course = x.course === '*' ? '*' : typeof x.course === 'string' && COURSE_ID.test(x.course) ? x.course : bad(`${at}.course`, "must be a course id or '*'");
      const leg = x.leg === '*' ? '*' : typeof x.leg === 'string' && COURSE_ID.test(x.leg) ? x.leg : bad(`${at}.leg`, "must be a leg name or '*'");
      if (leg !== '*' && course === '*') bad(`${at}.leg`, "a named leg needs a named course, not '*'");
      const except = x.except === undefined ? undefined : Array.isArray(x.except) && x.except.length <= LEGS_MAX && x.except.every((e) => typeof e === 'string' && COURSE_ID.test(e))
        ? [...new Set(x.except as string[])] : bad(`${at}.except`, `must be at most ${LEGS_MAX} leg names`);
      if (except && leg !== '*') bad(`${at}.except`, "only with leg '*'");
      const prefix = typeof x.tag_prefix === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/.test(x.tag_prefix) ? x.tag_prefix : bad(`${at}.tag_prefix`, 'must be a tag prefix');
      // A named course is one the repository registers, as an owner bar's is (round 2, 2-A-1).
      if (course !== '*') {
        const file = this.rows<{ course_json: string }>('SELECT course_json FROM courses WHERE repository_id = ? AND id = ?', repository, course)[0]?.course_json;
        if (!file) bad(`${at}.course`, `${repository} registers no course ${course}`);
        if (leg !== '*' && !resolveLeg(graphOf(JSON.parse(file!)), leg)) bad(`${at}.leg`, `${course}'s course file has no leg ${leg}`);
      }
      return { course, leg, ...(except ? { except } : {}), tag_prefix: prefix };
    });
  }

  // ── reads ───────────────────────────────────────────────────────────────────────────────

  /** The owner bars of `repositories` in force at `now` — and, with `scheduled`, those not yet
   *  started — for the heartbeat, the observation and the gates (R-BTN-67). */
  bars(repositories: string[] | null, now: number, scheduled = false): OwnerBar[] {
    return this.rows<Omit<OwnerBar, 'legs' | 'release_holders'> & { legs: string; release_holders: number }>(
      `SELECT id, repository_id, course, tag, legs, applies, starts_at, ends_at, release_holders, reason FROM owner_bars
       WHERE lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?) AND (? OR starts_at <= ?)
         AND (? IS NULL OR repository_id IN (SELECT value FROM json_each(?))) ORDER BY id`,
      now, scheduled ? 1 : 0, now, repositories ? 1 : null, JSON.stringify(repositories ?? []))
      .map((b) => ({ ...b, legs: JSON.parse(b.legs) as string[], release_holders: !!b.release_holders }));
  }

  /** A repository's required bars (R-BTN-67). */
  requiredBars(repository: string): RequiredBar[] {
    return JSON.parse(this.rows<{ required_bars: string }>('SELECT required_bars FROM repositories WHERE id = ?', repository)[0]?.required_bars ?? '[]');
  }

  /** A repository's retry policy (R-BTN-23), or null for the default. */
  retry(repository: string): RetryPolicy | null {
    const r = this.rows<{ retry: string | null }>('SELECT retry FROM repositories WHERE id = ?', repository)[0]?.retry;
    return r ? JSON.parse(r) : null;
  }

  /** The dashboard's read-only view (R-BTN-66: no management path but the CLI). */
  view(now: number) {
    return {
      owners: this.rows('SELECT repository_id, fingerprint, added_by, added_at FROM repository_owners WHERE removed_at IS NULL ORDER BY repository_id, added_at'),
      // max_tier as its name in the repository's ladder (stored as a position, R-BTN-66).
      grants: this.rows<{ repository_id: string; max_tier: number | null }>(`SELECT g.credential_id, c.hostname, c.label, g.repository_id, g.capabilities, g.max_tier, g.granted_by, g.granted_at
                         FROM worker_grants g JOIN credentials c ON c.id = g.credential_id WHERE g.revoked_at IS NULL ORDER BY g.repository_id, c.hostname`)
        .map((g) => ({ ...g, max_tier: g.max_tier == null ? null : this.c.registry.get(g.repository_id)?.tiers[g.max_tier] ?? null })),
      // §14: probes too, with the instances each may report on (round 3, 3-A-3).
      probes: this.rows(`SELECT id AS fingerprint, label, allowed_instances, created_by FROM credentials WHERE kind = 'probe' AND revoked_at IS NULL ORDER BY label`),
      bars: this.bars(null, now, true),
      settings: this.rows('SELECT id AS repository_id, required_bars, retry, transcript_repos, unblocked_trigger FROM repositories WHERE retired_at IS NULL ORDER BY id'),
    };
  }

  // ── keys ────────────────────────────────────────────────────────────────────────────────

  private async parseKey(v: unknown, field: string): Promise<{ fingerprint: string; line: string }> {
    if (typeof v !== 'string') bad(field, 'must be an OpenSSH public key line');
    const key = await parseSshKey(v as string);
    return { fingerprint: key.fingerprint, line: lineOf(key, v as string) };
  }

  private async ownerKeys(v: unknown, field: string): Promise<{ fingerprint: string; line: string }[]> {
    if (!Array.isArray(v) || v.length > OWNERS_MAX) bad(field, `must be a list of at most ${OWNERS_MAX} public keys`);
    const keys = await Promise.all((v as unknown[]).map((k, i) => this.parseKey(k, `${field}[${i}]`)));
    if (new Set(keys.map((k) => k.fingerprint)).size !== keys.length) bad(field, 'names a key twice');
    return keys;
  }
}

/** R-BTN-23's policy as owners set it: 1–8 backoffs, each 1 minute to 30 days, and the failed
 *  attempt that holds the ticket, 1–10. */
export function checkRetry(v: unknown): RetryPolicy {
  if (!isObj(v)) bad('retry', 'must be {backoff_ms: [..], max_failed}');
  const b = v as Record<string, unknown>;
  only(b, ['backoff_ms', 'max_failed'], 'retry');
  const backoff = Array.isArray(b.backoff_ms) && b.backoff_ms.length >= 1 && b.backoff_ms.length <= BACKOFFS_MAX && b.backoff_ms.every((n) => Number.isSafeInteger(n) && (n as number) >= 60_000 && (n as number) <= 30 * 86_400_000)
    ? (b.backoff_ms as number[]) : bad('retry.backoff_ms', `must be 1 to ${BACKOFFS_MAX} backoffs of 1 minute to 30 days`);
  const max = Number.isInteger(b.max_failed) && (b.max_failed as number) >= 1 && (b.max_failed as number) <= 10 ? (b.max_failed as number) : bad('retry.max_failed', 'must be an integer from 1 to 10');
  return { backoff_ms: backoff, max_failed: max };
}

/** R-BTN-94's dispatch shape for `unblocked_trigger` (R-BTN-77): on GitHub a workflow path. */
function checkTrigger(v: unknown): Record<string, unknown> {
  if (!isObj(v) || typeof v.kind !== 'string') bad('unblocked_trigger', 'must be a dispatch {kind, …}');
  const t = v as Record<string, unknown>;
  if (t.kind === 'github-app') {
    only(t, ['kind', 'workflow'], 'unblocked_trigger');
    if (typeof t.workflow !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/.test(t.workflow)) bad('unblocked_trigger.workflow', 'must be a path under .github/workflows/');
  } else if (t.kind === 'gitlab-trigger') {
    only(t, ['kind', 'project_id', 'ref'], 'unblocked_trigger');
    if (!Number.isSafeInteger(t.project_id) || typeof t.ref !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(t.ref)) bad('unblocked_trigger', 'needs project_id and ref');
  } else if (t.kind === 'gitea') {
    only(t, ['kind', 'workflow', 'ref'], 'unblocked_trigger');
    if (typeof t.workflow !== 'string' || !/^[A-Za-z0-9._/-]{1,200}$/.test(t.workflow) || typeof t.ref !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(t.ref)) bad('unblocked_trigger', 'needs workflow and ref');
  } else {
    bad('unblocked_trigger.kind', 'must be github-app, gitlab-trigger or gitea');
  }
  return t;
}
