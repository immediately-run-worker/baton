// baton.ts — Baton's core (BATON_SPEC §3, §3a R-BTN-55): every table, every write, the routing
// of the API behind the front (front.ts), and the alarm. It names no platform: a host hands it
// the ports (ports.ts) — the Durable Object on Cloudflare (src/cloudflare/), a Node process
// locally (src/local/) — and runs one request at a time between awaits, as §3 requires. Each
// request's writes are one transaction, so the compare-and-set below needs no lock. Requests
// reach it only through the front, which has verified the principal — all but a signed
// request's key, signature, clock and nonce, which only the core can check (verifySigned).
import { MIGRATIONS } from '../migrations';
import { BatonError, errorResponse, json } from './http';
import { checkPayload, inPeak, nextPeakChange, rowFor, rowHash, type BoardPayload } from './board';
import { priceFor } from '../shared/sessionUsage.mjs';
import { familyOf } from '../shared/baton.mjs';
import { fitsTier, TIERS } from '../shared/vocabulary.mjs';
import { WorkerApi } from './workerApi';
import { parseSshKey, verifyRequest, withBody, type SyncCredential } from './auth';
import { Claims } from './claims';
import { Cutover } from './cutover';
import { Mirror } from './mirror';
import { checkConfirmations, checkRepositoryId, GIT_BRANCH, GIT_REPO } from './validate';
import { Courses } from './courses';
import { Observations } from './observations';
import { Webhooks, type Delivery } from './webhook';
import { fileUrl } from './links';
import { Registry, TICKET_ID, qualify, repositoryOf, tierPosition, type Repository, type SyncClaims } from './registry';
import type { Ports, Row, SqlValue, Store, Workflow } from './ports';

const HELD_AUTO_ACCEPT_MS = 24 * 3_600_000; // §7.1: a held history is accepted after 24 h (R3-1212)
const ALARM_EVERY_MS = 60_000; // §3: one alarm, every 60 seconds

export class BatonCore {
  /** The clock (R-BTN-32). Tests replace it; nothing else here reads the time. */
  now: () => number;

  readonly workers: WorkerApi;
  readonly claims: Claims;
  readonly cutover: Cutover;
  readonly mirror: Mirror;
  readonly registry: Registry;
  readonly courses: Courses;
  readonly observations: Observations;
  readonly webhooks: Webhooks;
  readonly store: Store;
  /** §12: workflows to dispatch once the current request or alarm has committed, one per
   *  repository and kind. */
  private pendingDispatch = new Map<string, Workflow>();
  /** The dispatch call; tests replace it (as they replace `now`) to see what would be sent. */
  dispatcher: (workflow: Workflow) => Promise<unknown>;
  /** §3: a signature check (R3-1239) or a hook call (R3-1236) is awaited through this, so
   *  another request may run meanwhile on both hosts alike (R-BTN-55). */
  readonly outside: <T>(work: () => Promise<T>) => Promise<T>;

  constructor(private readonly ports: Ports) {
    this.now = ports.clock ?? (() => Date.now());
    this.store = ports.store;
    this.dispatcher = (wf) => this.sendDispatch(wf);
    this.outside = ports.gate ? (work) => ports.gate!.outside(work) : (work) => work();
    const store = ports.store;
    this.registry = new Registry({ store, now: () => this.now() });
    this.courses = new Courses({ store });
    this.observations = new Observations({ store, now: () => this.now() });
    this.webhooks = new Webhooks({ store, now: () => this.now() });
    const want = (wf: Workflow) => this.pendingDispatch.set(`${wf.repository}:${wf.kind}`, wf);
    this.claims = new Claims({ store, now: () => this.now(), dispatch: (kind, ticketId) => want({ repository: repositoryOf(ticketId), kind }) });
    this.cutover = new Cutover({ store, now: () => this.now() });
    this.mirror = new Mirror({ store, now: () => this.now() });
    this.workers = new WorkerApi({ store, config: ports.config, now: () => this.now(), fenced: (w, inc, id) => this.claims.fenced(w, inc, id) });
  }

  /** Before the first request (§3): every migration applied — the core refuses to serve until
   *  they are — and the one alarm armed. The host runs this before it lets a request in. */
  async start(): Promise<void> {
    this.migrate();
    this.store.transaction(() => this.registry.seed(this.ports.config));
    await this.registry.seedSyncKeys(this.ports.config, this.ports.adminKeys.list());
    await this.seedKeys();
    if ((await this.ports.scheduler.get()) == null) await this.ports.scheduler.set(this.now() + ALARM_EVERY_MS);
    // A trailing webhook dispatch owed from before a restart keeps its time (round 1, 1-A-4).
    await this.armBy(this.webhooks.nextTrailing());
  }

  /** The worker keys from BATON_KEYS (R3-1239). A list that cannot be seeded changes nothing
   *  and stops nothing — the keys in force stay, and the sync, the dashboard and every other
   *  principal serve on — but goes to Needs you, as does a revoked key the list names again. */
  private async seedKeys(): Promise<void> {
    const before = this.keysNotice();
    // What the list in force last reported stands until another list seeds.
    let notice: { refused?: string; revoked_listed?: string[] } | null = before?.revoked_listed ? { revoked_listed: before.revoked_listed } : null;
    try {
      const r = await this.workers.seedKeys();
      if (r.unchanged) {
        // The list that last seeded is back (a refused one never seeds): its refusal is over.
        if (!before?.refused) return;
      } else notice = r.revoked.length ? { revoked_listed: r.revoked } : null;
    } catch (e) {
      notice = { ...notice, refused: (e instanceof Error ? e.message : String(e)).slice(0, 500) };
    }
    this.store.exec(`INSERT INTO baton_settings (key, value) VALUES ('keys_notice', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(notice));
  }

  /** Send the dispatches a committed transaction asked for — only for a repository after its
   *  cutover, when the mirror writes git; before it, claim.sh does. Never awaited by the
   *  caller's response. */
  private flushDispatch() {
    const due = [...this.pendingDispatch.values()].filter((wf) => this.cutover.cutoverAt(wf.repository) != null);
    this.pendingDispatch.clear();
    if (!due.length) return;
    this.ports.dispatch.defer(Promise.all(due.map((wf) => this.dispatcher(wf).catch(() => false))));
  }

  /** §10.3: a repository's sync or mirror workflow, on its default branch. A repository with no
   *  mirror has nothing to dispatch for it. */
  private sendDispatch(wf: Workflow): Promise<unknown> {
    const repo = this.registry.get(wf.repository);
    const path = wf.kind === 'sync' ? repo?.sync_workflow : repo?.mirror_workflow;
    if (!repo || !path) return Promise.resolve(false);
    return this.ports.dispatch.send({ github: repo.github, workflow: path.slice(path.lastIndexOf('/') + 1), ref: repo.default_branch });
  }

  /** R-BTN-93's one verifier: the repository a sync credential acts for in `role` — a sync key
   *  (signed; its signature, clock and nonce checked here, as every key's are), or a CI identity
   *  token the front verified (GitHub Actions OIDC, GitLab CI `id_tokens`). Anything else is
   *  refused. Returns the request with a signed body put back. */
  private async verifySync(req: Request, role: 'sync' | 'mirror'): Promise<{ repo: Repository; req: Request }> {
    if (req.headers.has('X-Baton-Signed')) {
      // Every key Baton knows verifies here, so a key in another role is told `forbidden`, not
      // `unauthenticated` — an administrator's included (round 1, 1-A-9).
      const admins = new Map<string, string>();
      for (const line of this.ports.adminKeys.list()) {
        try {
          admins.set((await parseSshKey(line)).fingerprint, line);
        } catch {
          // an unreadable line is no key
        }
      }
      const { req: signed, cred } = await this.verifySigned(req, (fp) => this.registry.syncKey(fp)?.public_key ?? this.workers.publicKey(fp) ?? admins.get(fp) ?? null);
      // An administrator key is never a sync's, even one added to BATON_ADMIN_KEYS after it was
      // registered as a sync key (round 3, 3-A-2).
      if (admins.has(cred)) throw new BatonError('forbidden', 'an administrator key holds no other role (R-BTN-57)');
      const key = this.registry.syncKey(cred);
      // A worker, probe, courier or administrator key is never a sync's (R-BTN-57, R-BTN-93).
      if (!key) throw new BatonError('forbidden', 'only a sync key may act as a sync');
      if (key.role !== role) throw new BatonError('forbidden', `this sync key serves its repository's ${key.role}, not its ${role}`);
      return { repo: this.registry.get(key.repository)!, req: signed };
    }
    const raw = req.headers.get('X-Baton-Sync');
    if (!raw) throw new BatonError('unauthenticated', 'no sync principal');
    const claims = JSON.parse(raw) as SyncCredential;
    const repo = claims.kind === 'gitlab' ? this.registry.forGitlab(claims, role) : this.registry.forSync(claims, role);
    return { repo, req };
  }

  /** R-BTN-73: a verified delivery's fields, from the front. Its syncs go after the response;
   *  a suppressed one waits for its window's trailing dispatch, which the alarm sends, armed
   *  early for it. */
  private async delivery(req: Request) {
    const raw = req.headers.get('X-Baton-Webhook');
    if (!raw) throw new BatonError('unauthenticated', 'no webhook principal');
    const out = this.store.transaction(() => this.webhooks.receive(JSON.parse(raw) as Delivery));
    if (out.outcome === 'dispatched') {
      this.syncNow(out.now);
      if (out.trailing.length) await this.armBy(this.webhooks.nextTrailing());
    }
    return out;
  }

  /** Dispatch these repositories' syncs after the response; a failure waits for the next
   *  trigger or the schedule (R-BTN-73: never retried more than once). */
  private syncNow(repositories: string[]) {
    if (repositories.length) this.ports.dispatch.defer(Promise.all(repositories.map((repository) => this.dispatcher({ repository, kind: 'sync' }).catch(() => false))));
  }

  /** The alarm fires by `at` (§3: one alarm; set earlier, never later). */
  private async armBy(at: number | null) {
    if (at == null) return;
    const current = await this.ports.scheduler.get();
    if (current == null || at < current) await this.ports.scheduler.set(at);
  }

  /** §3: the one alarm, every 60 seconds — earlier when a webhook's trailing dispatch is due. */
  async alarm(): Promise<void> {
    // Re-armed first, so one failing tick never ends the cycle.
    await this.ports.scheduler.set(this.now() + ALARM_EVERY_MS);
    this.syncNow(this.store.transaction(() => this.webhooks.dueTrailing()));
    await this.armBy(this.webhooks.nextTrailing());
    // Claims first, so a worker reaped this tick has its messages expired in the same tick.
    try {
      this.store.transaction(() => {
        this.claims.alarm();
        this.workers.alarm();
      });
    } catch (e) {
      this.pendingDispatch.clear(); // rolled back: nothing to tell the mirror
      throw e;
    }
    this.flushDispatch();
  }

  private sql<T = Row>(query: string, ...params: unknown[]): T[] {
    return this.store.exec<T>(query, ...params).toArray();
  }

  /** Apply the numbered migrations not yet applied, each in its own transaction. */
  migrate(): void {
    this.store.exec('CREATE TABLE IF NOT EXISTS _baton_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const done = new Set(this.sql<{ id: number }>('SELECT id FROM _baton_migrations').map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      this.store.transaction(() => {
        this.store.script(m.sql);
        this.store.exec('INSERT INTO _baton_migrations (id, applied_at) VALUES (?, ?)', m.id, this.now());
      });
    }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.pendingDispatch.clear();
    try {
      const res = await this.route(req, url);
      // An error answer means its transaction rolled back: nothing changed to mirror.
      if (res.ok) this.flushDispatch();
      else this.pendingDispatch.clear();
      return res;
    } catch (e) {
      this.pendingDispatch.clear(); // the transaction rolled back: nothing changed to mirror
      throw e;
    }
  }

  private async route(req: Request, url: URL): Promise<Response> {
    try {
      if (url.pathname.startsWith('/v1/sync/')) {
        // R-BTN-15: the board's routes take only the repository's sync workflow, the feed's only
        // its mirror workflow; each touches that repository alone.
        if (req.method === 'GET' && url.pathname === '/v1/sync/head') return json(this.head((await this.verifySync(req, 'sync')).repo.id));
        // R-BTN-62: the next number of the repository's counter, before the sync reads anything.
        if (req.method === 'POST' && url.pathname === '/v1/sync/observation') return json(this.observations.observe((await this.verifySync(req, 'sync')).repo.id));
        if (req.method === 'POST' && url.pathname === '/v1/sync/board') {
          const { repo, req: signed } = await this.verifySync(req, 'sync');
          const body = await readJson(signed);
          let p: BoardPayload;
          try {
            p = checkPayload(body);
          } catch (e) {
            // A refused post uses its number too (R-BTN-62), malformed or not, so the sync's
            // next run is not held off as busy for ten minutes.
            const n = (body as { observation?: unknown } | null)?.observation;
            if (Number.isSafeInteger(n)) this.observations.release(repo.id, n as number);
            throw e;
          }
          return json(await this.board(repo, p));
        }
        if (req.method === 'GET' && url.pathname === '/v1/sync/events') {
          const { repo } = await this.verifySync(req, 'mirror');
          const after = Number(url.searchParams.get('after') ?? 0);
          const limit = Number(url.searchParams.get('limit') ?? 200);
          if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit)) throw new BatonError('invalid-params', 'after and limit must be integers');
          return json(this.mirror.events(repo.id, after, limit));
        }
        if (req.method === 'POST' && url.pathname === '/v1/sync/foreign-claim') {
          const { repo, req: signed } = await this.verifySync(req, 'mirror');
          const body = await readJson(signed);
          return json(this.store.transaction(() => this.mirror.foreignClaim(repo.id, body)));
        }
      }
      if (req.method === 'POST' && url.pathname === '/v1/github/webhook') {
        // §11: 204, and nothing of Baton's in the App's delivery log (round 1, 1-A-0).
        await this.delivery(req);
        return new Response(null, { status: 204 });
      }
      if (req.method === 'GET' && url.pathname === '/v1/ui/state') return json(this.uiState());
      const routed = await this.workerRoute(req, url);
      if (routed) return routed;
      throw new BatonError('not-found', `no route ${req.method} ${url.pathname}`);
    } catch (e) {
      // Drain an unread body so the forwarded stream completes before the response does.
      if (req.body && !req.bodyUsed) await req.arrayBuffer().catch(() => {});
      if (e instanceof BatonError) return errorResponse(e.code, e.message, e.extra);
      throw e;
    }
  }

  /** Needs you: a BATON_KEYS list that was refused, or that names a revoked key (R3-1239). */
  private keysNotice(): { refused?: string; revoked_listed?: string[] } | null {
    const raw = this.sql<{ value: string }>(`SELECT value FROM baton_settings WHERE key = 'keys_notice'`)[0]?.value;
    return raw ? JSON.parse(raw) : null;
  }

  /** A signed request (R3-1239), verified whole by the one verifier: the key its keyid names
   *  among the keys in force, the SSHSIG in the `baton-request` namespace, `created` within 5
   *  minutes of this clock — then its nonce, unseen for that key. The crypto runs outside the
   *  turn (§3); the nonce is checked and written after it. Returns the request with its body
   *  put back and the credential: the key's fingerprint. */
  private async verifySigned(req: Request, lookup: (fp: string) => string | null = (fp) => this.workers.publicKey(fp)): Promise<{ req: Request; cred: string }> {
    const now = this.now();
    const v = await this.outside(() => verifyRequest(req, lookup, { origin: this.ports.config.BATON_ORIGIN, now }));
    // Another request ran meanwhile: the key may have been revoked since it was read.
    if (!lookup(v.keyid)) throw new BatonError('unauthenticated', 'the key is not registered or is revoked');
    this.workers.acceptNonce(v.keyid, v.nonce, now);
    return { req: withBody(req, v.body), cred: v.keyid };
  }

  /** The worker and owner routes of R3-1211. The front passes the principal in
   *  `X-Baton-Credential` (a bearer token's credential, verified), `X-Baton-Signed` (a signed
   *  request's keyid, pre-checked; verifySigned finishes it here) or `X-Baton-Owner` (the Access
   *  email); it strips all of them from every incoming request first. */
  private async workerRoute(req: Request, url: URL): Promise<Response | null> {
    const p = url.pathname;
    const m = req.method;
    const owner = req.headers.get('X-Baton-Owner');
    let cred = req.headers.get('X-Baton-Credential');
    const secret = req.headers.get('X-Worker-Secret');
    if (req.headers.has('X-Baton-Signed')) {
      // R-BTN-13 as amended: the front checked the request's shape, @authority and digest; the
      // key, the signature and the clock are checked here, and the nonce in this turn.
      ({ req, cred } = await this.verifySigned(req));
    }
    const tx = <T>(f: () => T): T => this.store.transaction(f);
    if (p.startsWith('/v1/runner/')) {
      if (!cred) throw new BatonError('unauthenticated', 'no worker principal');
      if (m === 'POST' && p === '/v1/runner/heartbeat') {
        const body = await readJson(req);
        // The hashing is async; the writes happen in one transaction after it (§3: atomic).
        return json(await this.workers.heartbeat(cred, secret, body));
      }
      if (m === 'GET' && p === '/v1/runner/mode') {
        await this.workers.authWorker(cred, secret);
        // §11: `?repository=` — each repository cuts over on its own (R-BTN-28).
        const repo = checkRepositoryId(url.searchParams.get('repository'));
        if (!this.registry.get(repo)) throw new BatonError('invalid-params', 'repository: must be a registered repository id');
        return json(this.workers.mode(repo));
      }
      if (m === 'GET' && p === '/v1/runner/branch-holder') {
        // §6.3: a push to an item branch asks who holds the tickets it maps to; machine key alone,
        // or with a secret so the caller's own claim is not "another".
        // A pre-push hook has git's spellings: refs/heads/<branch> and owner/name.git.
        const gitRepo = (url.searchParams.get('repo') ?? '').replace(/\.git$/, '');
        const branch = (url.searchParams.get('branch') ?? '').replace(/^refs\/heads\//, '');
        if (!GIT_REPO.test(gitRepo)) throw new BatonError('invalid-params', 'repo: must be owner/name');
        if (!GIT_BRANCH.test(branch)) throw new BatonError('invalid-params', 'branch: must be a branch name');
        const caller = secret ? await this.workers.authWorker(cred, secret) : null;
        return json(this.claims.branchHolder(caller, gitRepo, branch));
      }
      const holder = /^\/v1\/runner\/tickets\/([^/]+)\/holder$/.exec(p);
      if (m === 'GET' && holder) {
        // R-BTN-7: callable with the token alone (the witness has no sidecar); with a secret, the
        // caller's own claim is not "another".
        const item = this.ticketParam(holder[1]);
        const caller = secret ? await this.workers.authWorker(cred, secret) : null;
        return json(this.claims.holder(caller, item));
      }
      const workerId = await this.workers.authWorker(cred, secret);
      if (m === 'POST' && p === '/v1/runner/claim') {
        const body = await readJson(req);
        return json(tx(() => this.claims.claim(workerId, body)));
      }
      if (m === 'GET' && p === '/v1/runner/next') return json(this.claims.next(workerId));
      if (m === 'POST' && p === '/v1/runner/adopt') {
        const body = await readJson(req);
        return json(tx(() => this.cutover.adopt(workerId, body)));
      }
      const end = /^\/v1\/runner\/claims\/(\d+)\/end$/.exec(p);
      if (m === 'POST' && end) {
        const body = await readJson(req);
        return json(tx(() => this.claims.end(workerId, Number(end[1]), body)));
      }
      if (m === 'POST' && p === '/v1/runner/activities') {
        const body = await readJson(req);
        return json(this.workers.activities(workerId, body));
      }
      const ack = /^\/v1\/runner\/messages\/(\d+)\/ack$/.exec(p);
      if (m === 'POST' && ack) {
        // An absent body is an acknowledgement with no reply; a malformed one is refused.
        const body = req.headers.get('Content-Length') === '0' || !req.body ? null : await readJson(req);
        return json(tx(() => this.workers.ack(workerId, Number(ack[1]), body)));
      }
      if (m === 'POST' && p === '/v1/runner/shadow-report') {
        const body = await readJson(req);
        return json(tx(() => this.workers.shadowReport(workerId, body)));
      }
      return null;
    }
    if (p.startsWith('/v1/ui/') && m === 'POST') {
      if (!owner) throw new BatonError('unauthenticated', 'no owner principal');
      if (p === '/v1/ui/messages') {
        const body = await readJson(req);
        return json(tx(() => this.workers.sendMessage(owner, body)));
      }
      if (p === '/v1/ui/suspensions') {
        const body = await readJson(req);
        return json(tx(() => this.workers.setSuspension(owner, body)));
      }
      const lift = /^\/v1\/ui\/suspensions\/(\d+)\/lift$/.exec(p);
      if (lift) return json(tx(() => this.workers.liftSuspension(owner, Number(lift[1]))));
      const reap = /^\/v1\/ui\/claims\/(\d+)\/reap$/.exec(p);
      if (reap) {
        const body = await readJson(req);
        return json(tx(() => this.claims.forceReap(owner, Number(reap[1]), body)));
      }
      const resolve = /^\/v1\/ui\/claims\/(\d+)\/resolve$/.exec(p);
      if (resolve) {
        const body = await readJson(req);
        return json(tx(() => this.claims.resolve(owner, Number(resolve[1]), body)));
      }
      if (p === '/v1/ui/cutover') {
        const body = await readJson(req);
        return json(tx(() => this.cutover.cutover(owner, body)));
      }
      const adoption = /^\/v1\/ui\/adoptions\/([^/]+)\/confirm$/.exec(p);
      if (adoption) {
        const ticket = this.ticketParam(adoption[1]);
        const body = await readJson(req);
        return json(tx(() => this.cutover.confirmAdoption(owner, ticket, body)));
      }
      const override = /^\/v1\/ui\/overrides\/([^/]+)$/.exec(p);
      if (override) {
        const ticket = this.ticketParam(override[1]);
        const body = await readJson(req);
        return json(tx(() => this.claims.setOverride(owner, ticket, body)));
      }
      if (p === '/v1/ui/board/accept') {
        const body = await readJson(req);
        return json(tx(() => this.claims.acceptHeld(owner, body)));
      }
    }
    return null;
  }

  /** A ticket in a path: a qualified id (R-BTN-47) of a registered repository. A malformed
   *  escape is the caller's error, never a 500. */
  private ticketParam(raw: string): string {
    let id = '';
    try {
      id = decodeURIComponent(raw);
    } catch {
      // falls through to the refusal
    }
    const m = TICKET_ID.exec(id);
    if (!m || !this.registry.get(m[1])) throw new BatonError('invalid-params', 'ticket: must be a ticket id, <repository>:<id>, of a registered repository');
    return id;
  }

  // ── sync (§7.1) ───────────────────────────────────────────────────────────────────────

  /** A repository's head snapshot (R-BTN-11, per repository), or null before its first. */
  private headOf(repo: string): string | null {
    return this.sql<{ sha: string | null }>('SELECT sha FROM board_head WHERE repository_id = ?', repo)[0]?.sha ?? null;
  }

  /** `GET /v1/sync/head`: the repository's head snapshot and its completions waiting for
   *  confirmation. */
  head(repo: string) {
    const unconfirmed = this.sql(
      `SELECT c.id AS claim_id, c.ticket_id, c.end_reason, c.ended_at_sha FROM claims c
       WHERE c.status = 'completed' AND c.confirmed_at IS NULL AND substr(c.ticket_id, 1, length(?) + 1) = ? || ':' ORDER BY c.id`, repo, repo);
    return { sha: this.headOf(repo), unconfirmed };
  }

  /**
   * `POST /v1/sync/board` (R-BTN-11): accepted only when `parent_sha` is the current head (or
   * null while there is none); a lost race is `head-moved`. `force` — a rewritten `main` — is
   * held for the owner as a `snapshot-rejected` event and moves nothing else; accepting it
   * is the alarm's and the dashboard's job (R3-1212). A repeat of the head is a no-op.
   *
   * `held_snapshots` holds one row per hold, against the current head (R3-1223): rows held
   * against a head are deleted when the head moves, so a later force post of the same sha —
   * a rewind to a once-accepted history included — is a fresh hold with a fresh row. The 0001
   * schema's "written once" and "the first force post" describe that one hold.
   */
  async board(repo: Repository, p: BoardPayload) {
    const r = repo.id;
    // R-BTN-62: the post's number is used first, whatever becomes of the post; an older reading
    // than the last accepted one, or a void or used number, is refused whole here.
    const n = p.observation;
    this.observations.use(r, n);
    const head = this.headOf(r);
    const at = this.now();
    // A sync confirms only its own repository's completions (R-BTN-47).
    const confirmations = this.claims.ownConfirmations(r, checkConfirmations(p.confirmations));
    // A held history the owner (or the 24-hour clock) accepted becomes the head on its next post.
    const accepted = !!p.force && this.claims.acceptedLine(r, head);
    if (p.force && !accepted) {
      // A held post still carries the sync's confirmations: git carries those completions
      // whichever history the owner keeps, and dropping them would leave their items blocked.
      // R-BTN-62: what it saw is a refresh against the current head, its number being newer.
      this.store.transaction(() => {
        this.observations.accept(r, n);
        this.claims.confirm(confirmations, n);
        // …and judges claims as a refresh would, so staleness does not stall for the hold's 24 hours.
        this.claims.staleBoard(r, n);
        this.store.exec('UPDATE held_snapshots SET observation = ? WHERE repository_id = ? AND sha = ?', n, r, p.sha);
      });
      // Held once per sha: a repeat (the sync re-posts every 15 minutes) changes nothing, so
      // the first deadline stands and the dashboard lists it once. Every row is a hold against
      // the current head (rows held against a head are deleted when it moves, below), so a row
      // for this sha is this hold; with none, this is a new one — including a rewind to a sha
      // the owner once accepted, whose old row went when its line became the head (R3-1223).
      const known = this.sql<{ auto_accept_at: number }>('SELECT auto_accept_at FROM held_snapshots WHERE repository_id = ? AND sha = ?', r, p.sha)[0];
      const deadline = known?.auto_accept_at ?? at + HELD_AUTO_ACCEPT_MS;
      if (!known) {
        this.store.transaction(() => {
          this.store.exec('INSERT INTO held_snapshots (repository_id, sha, parent_sha, head_sha, ticket_count, received_at, auto_accept_at, observation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            r, p.sha, p.parent_sha, head, p.state.items.length, at, deadline, n);
          this.event(r, 'snapshot-rejected', { sha: p.sha, parent_sha: p.parent_sha, head, ticket_count: p.state.items.length, auto_accept_at: deadline }, at);
        });
      }
      throw new BatonError('snapshot-rejected', `a rewritten history is held for the owner until ${new Date(deadline).toISOString()}; claims continue on the current head`);
    }
    if (p.sha === head) {
      // §6.7: the sync's confirm-only post re-sends the head with its confirmations. Its registry
      // is not applied: the sync builds that body at the commit it fetched, which may be an
      // ancestor of the head, and an older registry would roll a course back. A head that
      // predates the registry (migration 0007) gets its courses with the next new head; until
      // then its tickets fit no worker (rule 9), failing closed.
      // A refresh is a reading like any other: it confirms ends and judges claims made before its
      // number (R-BTN-62, R-BTN-35), not only the post that moved the head.
      return this.store.transaction(() => {
        this.observations.accept(r, n);
        const confirmed = this.claims.confirm(confirmations, n);
        return { ok: true, unchanged: true, confirmed, stale_released: this.claims.staleBoard(r, n) };
      });
    }
    if (!accepted && p.parent_sha !== head) throw new BatonError('head-moved', `the head is ${head ?? 'unset'}; re-read it and retry`);

    // Hash every row before the transaction: the digest is async, the transaction is not.
    const rankOf = new Map(p.ready.map((id, i) => [id, i]));
    const rows = await Promise.all(p.state.items.map(async (it) => {
      // R-BTN-66: tiers arrive by name and are matched as positions in this repository's ladder.
      const row = { ...rowFor(it, rankOf), tier_position: tierPosition(repo.tiers, it.tier ?? null) };
      return { row, hash: await rowHash(row) };
    }));
    const changed: { upserted: number; deleted: number; confirmed?: number; stale_released?: number; courses_refused?: string[]; fleet_ignored?: boolean } = { upserted: 0, deleted: 0 };
    this.store.transaction(() => {
      // The row hashes were awaited after the number was used, so another run may have posted
      // meanwhile: this reading must still be the newest, over the head it was judged against.
      if (!this.observations.newest(r, n)) throw new BatonError('stale-observation', `a newer reading than ${n} was accepted while this post was judged; take a new number and retry (R-BTN-62)`);
      if (this.headOf(r) !== head) throw new BatonError('head-moved', `the head moved to ${this.headOf(r) ?? 'unset'} while this post was judged; re-read it and retry`);
      // The course registry first (R-BTN-48, R-BTN-69): every ticket must name a course in
      // force, and a refused file with none to keep refuses the whole post.
      const refused = this.applyRegistry(r, p, rows.map(({ row }) => row.course_id), at);
      if (refused.length) changed.courses_refused = refused;
      // The repository's own tickets only, keyed by their local ids (R-BTN-47).
      const have = new Map(this.sql<{ local_id: string; row_hash: string }>('SELECT local_id, row_hash FROM tickets WHERE repository_id = ?', r).map((x) => [x.local_id, x.row_hash]));
      for (const { row, hash } of rows) {
        const before = have.get(row.id);
        have.delete(row.id);
        if (before === hash) continue;
        const id = qualify(r, row.id);
        this.store.exec(
          `INSERT INTO tickets (id, repository_id, local_id, path, title, project, status, node, queue, tags, tier, requires_clause, operator_only,
             depends_on, blocked_by, repos, ord, rank, snapshot_sha, row_hash, since, holder, course_id, tier_position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET path = excluded.path, title = excluded.title, project = excluded.project,
             status = excluded.status, node = excluded.node, queue = excluded.queue, tags = excluded.tags,
             tier = excluded.tier, requires_clause = excluded.requires_clause, operator_only = excluded.operator_only,
             depends_on = excluded.depends_on, blocked_by = excluded.blocked_by, repos = excluded.repos,
             ord = excluded.ord, rank = excluded.rank, snapshot_sha = excluded.snapshot_sha, row_hash = excluded.row_hash,
             since = excluded.since, holder = excluded.holder, course_id = excluded.course_id, tier_position = excluded.tier_position`,
          id, r, row.id, row.path, row.title, row.project, row.status, row.node, row.queue, row.tags, row.tier,
          row.requires_clause, row.operator_only, row.depends_on, row.blocked_by, row.repos, row.ord, row.rank, p.sha, hash, row.since, row.holder, row.course_id, row.tier_position);
        this.store.exec('DELETE FROM ticket_requires WHERE ticket_id = ?', id);
        for (const name of row.requires) this.store.exec('INSERT INTO ticket_requires (ticket_id, name) VALUES (?, ?)', id, name);
        changed.upserted++;
      }
      // Tickets no longer live leave the cache (R-BTN-35); their claims and events stay.
      for (const gone of have.keys()) {
        this.store.exec('DELETE FROM ticket_requires WHERE ticket_id = ?', qualify(r, gone));
        this.store.exec('DELETE FROM tickets WHERE id = ?', qualify(r, gone));
        changed.deleted++;
      }
      // A non-fleet repository's fleet fields are ignored, and its answer says so.
      if (this.reference(r, p)) changed.fleet_ignored = true;
      this.store.exec('INSERT INTO board_snapshots (repository_id, sha, parent_sha, received_at, ticket_count) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repository_id, sha) DO NOTHING', r, p.sha, p.parent_sha, at, p.state.items.length);
      this.store.exec('INSERT INTO board_head (repository_id, sha) VALUES (?, ?) ON CONFLICT (repository_id) DO UPDATE SET sha = excluded.sha', r, p.sha);
      // A hold is against one head (R3-1223): when the head moves — an accepted rewrite or a
      // plain fast-forward — every row held against the head it leaves is retired, answered or
      // not. Left in place, an accepted row would accept a NEW rewrite silently whenever the
      // head came back to that sha; an unanswered one is moot (main moved on), and a re-post of
      // its sha is held afresh. So every row left is a hold against the current head. Their
      // history stays in the events.
      this.store.exec('DELETE FROM held_snapshots WHERE repository_id = ? AND head_sha IS ?', r, head);
      this.event(r, 'snapshot-accepted', { sha: p.sha, parent_sha: p.parent_sha, ticket_count: p.state.items.length, ...changed, ...(accepted ? { held: true } : {}) }, at);
      this.observations.accept(r, n);
      changed.confirmed = this.claims.confirm(confirmations, n);
      // R-BTN-35: git wins over a claim it has overtaken.
      changed.stale_released = this.claims.staleBoard(r, n);
    });
    return { ok: true, ...changed };
  }

  /** The registry of a post (R-BTN-48, R-BTN-69), inside its transaction: applied whole, then
   *  every course the post's tickets name must be in force — a refused file with none to keep,
   *  or a course the registry dropped while a ticket still names it, refuses the post. */
  private applyRegistry(r: string, p: BoardPayload, ticketCourses: string[], at: number): string[] {
    const refused = p.registry ? this.courses.apply(r, p.registry, p.sha, at) : [];
    for (const c of new Set(ticketCourses)) {
      if (!this.courses.get(r, c)) throw new BatonError('invalid-params', `a ticket's course ${c} is not in ${r}'s registry`);
    }
    return refused;
  }

  /** The reference data the sync posts with every snapshot (§7.3, §7.4): providers, peak
   *  schedules, per-model prices and limits, the reviewer catalog. Each
   *  table is a copy of a docs file, never edited here, so it is rewritten whole: an account
   *  the file no longer lists is deleted. (Nothing references `model_providers` yet; when
   *  workers and suspensions do, R3-1211 decides what retiring a referenced account means.)
   *  Returns whether the payload carried fleet data this repository may not write. */
  private reference(repo: string, p: BoardPayload): boolean {
    const exec = (q: string, ...a: unknown[]) => this.store.exec(q, ...a);
    // §6.8: the repository's transcript repositories, from its baton.json until its owners set
    // them (R-BTN-66, R3-1240).
    if (p.transcript_repos) exec('UPDATE repositories SET transcript_repos = ? WHERE id = ?', JSON.stringify(p.transcript_repos), repo);
    // The rest is the instance's: only the fleet repository writes it (interim, R3-1231 2b).
    const carries = p.providers != null || p.matrix != null || p.reviewers != null;
    if (this.registry.fleetRepository() !== repo) return carries;
    if (p.providers) {
      exec('DELETE FROM provider_models');
      const ids = p.providers.accounts.map((a) => a.id);
      exec(`DELETE FROM model_providers WHERE id NOT IN (${ids.map(() => '?').join(', ') || "''"})`, ...ids);
      for (const a of p.providers.accounts) {
        exec(`INSERT INTO model_providers (id, name, billing, window_limits_json) VALUES (?, ?, ?, ?)
              ON CONFLICT (id) DO UPDATE SET name = excluded.name, billing = excluded.billing, window_limits_json = excluded.window_limits_json`,
          a.id, a.name, a.billing, a.window_limits ? JSON.stringify(a.window_limits) : null);
      }
      exec('DELETE FROM peak_schedules');
      for (const s of p.providers.peak_schedules) exec('INSERT INTO peak_schedules (id, rules_json, factor) VALUES (?, ?, ?)', s.id, JSON.stringify(s.rules), s.factor);
      for (const m of p.providers.models) {
        const price = priceFor(m.model, p.prices);
        exec(`INSERT INTO provider_models (provider_id, model_id, input_per_m, output_per_m, cache_read_per_m, cache_write_per_m, monthly_limit_usd, peak_schedule_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          m.provider, m.model, price?.input ?? null, price?.output ?? null, price?.cacheRead ?? null, price?.cacheWrite5m ?? null, m.monthly_limit_usd, m.peak_schedule ?? null);
      }
    }
    const catalog = p.reviewers ?? p.matrix?.agents;
    if (catalog && p.matrix) {
      exec('DELETE FROM reviewer_agents');
      for (const [name, a] of Object.entries(catalog)) {
        exec('INSERT INTO reviewer_agents (name, reviews_on, family, bills, models) VALUES (?, ?, ?, ?, ?)',
          name, a.reviews_on, familyOf(a.reviews_on, p.matrix) ?? 'unknown', JSON.stringify(a.bills), a.models ? JSON.stringify(a.models) : null);
      }
    }
    // Rule 8 (R-BTN-27) reads the whole matrix (rows, seats, costs) and the posted catalog.
    if (p.matrix) exec(`INSERT INTO baton_settings (key, value) VALUES ('reviewer_matrix', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(p.matrix));
    if (p.reviewers) exec(`INSERT INTO baton_settings (key, value) VALUES ('reviewer_catalog', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(p.reviewers));
    return false;
  }

  private event(repo: string, kind: string, detail: unknown, at: number) {
    this.store.exec('INSERT INTO events (at, kind, actor, detail_json, repository_id) VALUES (?, ?, ?, ?, ?)', at, kind, 'sync', JSON.stringify(detail), repo);
  }

  // ── the dashboard's state (§14: Ready and Providers in rollout step 1) ─────────────────

  uiState() {
    const now = this.now();
    // Each registered repository: its own head and its own mode (R-BTN-47, R-BTN-28).
    const repositories = this.registry.all().map((repo) => {
      const sha = this.headOf(repo.id);
      const head = sha ? this.sql('SELECT sha, parent_sha, received_at, ticket_count FROM board_snapshots WHERE repository_id = ? AND sha = ?', repo.id, sha)[0] ?? null : null;
      const courses = this.courses.all().filter((c) => c.repository_id === repo.id).map(({ id, version, min_worker_version, skill }) => ({ id, version, min_worker_version, skill }));
      return { id: repo.id, github: repo.github, forge: repo.forge, web_base: repo.web_base, default_branch: repo.default_branch, weight: repo.weight, head, mode: this.workers.mode(repo.id), courses };
    });
    const where = new Map(repositories.map((r) => [r.id, r]));
    const items = this.sql<Record<string, SqlValue>>(
      `SELECT t.id, t.repository_id, t.local_id, t.path, t.title, t.project, t.status, t.node, t.queue, t.tags, t.tier, t.requires_clause, t.operator_only, t.ord, t.rank
       FROM tickets t JOIN repositories p ON p.id = t.repository_id
       WHERE t.node LIKE 'ready-%' AND t.rank IS NOT NULL AND p.retired_at IS NULL ORDER BY p.weight DESC, t.rank, t.repository_id`);
    const requires = new Map<string, string[]>();
    for (const r of this.sql<{ ticket_id: string; name: string }>('SELECT ticket_id, name FROM ticket_requires ORDER BY name')) {
      requires.set(r.ticket_id, [...(requires.get(r.ticket_id) ?? []), r.name]);
    }
    const ready = items.map((r) => ({
      id: r.id,
      repository_id: r.repository_id,
      local_id: r.local_id,
      title: r.title,
      url: ((w) => fileUrl(w.forge, w.web_base, w.default_branch, r.path as string))(where.get(r.repository_id as string)!),
      project: r.project,
      tier: r.tier,
      queue: r.queue,
      node: r.node,
      rank: r.rank,
      rank_reason: r.node === 'ready-expedite' ? 'expedite lane' : `${r.queue} queue · order ${r.ord ?? '—'}`,
      requires_clause: r.requires_clause,
      requires: requires.get(r.id as string) ?? [],
      operator_only: r.operator_only === 1,
    }));
    // Per tier ceiling, the order a worker under it would be offered (§13 step 1's exit).
    // Each tier name of any ladder, lowest first; a ticket appears under the names of its own
    // repository's ladder that it fits (R-BTN-66).
    const names = [...new Set(this.registry.all().flatMap((x) => x.tiers))];
    const byTier = Object.fromEntries(names.map((t) => [t, ready.filter((r) => {
      const ladder = this.registry.get(r.repository_id as string)?.tiers ?? [...TIERS];
      return ladder.includes(t) && fitsTier((r.tier as string | null) ?? null, t, ladder);
    }).map((r) => r.id)]));

    const schedules = new Map(this.sql<{ id: string; rules_json: string; factor: number }>('SELECT id, rules_json, factor FROM peak_schedules').map((s) => [s.id, s]));
    const providers = this.sql<{ id: string; name: string; billing: string; window_limits_json: string | null }>('SELECT id, name, billing, window_limits_json FROM model_providers ORDER BY id').map((a) => {
      const models = this.sql<{ model_id: string; monthly_limit_usd: number | null; peak_schedule_id: string | null }>(
        'SELECT model_id, monthly_limit_usd, peak_schedule_id FROM provider_models WHERE provider_id = ? ORDER BY model_id', a.id);
      const peaks = [...new Set(models.map((m) => m.peak_schedule_id).filter((x): x is string => !!x))].map((id) => {
        const s = schedules.get(id);
        if (!s) return { schedule: id, in_peak: null, next_change: null, factor: null };
        const rules = JSON.parse(s.rules_json);
        return { schedule: id, in_peak: inPeak(rules, now), next_change: nextPeakChange(rules, now), factor: s.factor, models: models.filter((m) => m.peak_schedule_id === id).map((m) => m.model_id) };
      });
      return { id: a.id, name: a.name, billing: a.billing, window_limits: a.window_limits_json ? JSON.parse(a.window_limits_json) : null, models, peaks };
    });

    const held = this.sql(
      `SELECT repository_id, sha, parent_sha, head_sha, ticket_count, received_at, auto_accept_at FROM held_snapshots
       WHERE accepted_at IS NULL ORDER BY received_at`);
    const suspensions = this.sql(`SELECT id, provider_id, model_id, mode, starts_at, ends_at, reason, set_by, lifted_at FROM provider_suspensions
                                  WHERE lifted_at IS NULL AND (ends_at IS NULL OR ends_at > ?) ORDER BY starts_at`, now);
    return {
      server_time: now, repositories, ready, ready_by_tier: byTier, providers, held, workers: this.workers.workersView(now), suspensions,
      running: this.claims.running(now), timeline: this.claims.timeline(now),
      // R-BTN-69: a refused course file, the previous one staying in force.
      needs_you: { ...this.claims.needsYou(now), adoptions: this.cutover.adoptions(), courses_refused: this.courses.refusals(), keys: this.keysNotice() },
    };
  }
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BatonError('invalid-params', 'the body is not JSON');
  }
}
