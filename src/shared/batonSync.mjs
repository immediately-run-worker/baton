// batonSync.mjs — the board sync's decisions (BATON_SPEC §7.1, R3-1207), pure.
//
// `scripts/baton-sync.mjs` runs them for real (git, factory-state, GitHub OIDC, fetch); the
// Baton repository vendors this module (R-BTN-37) so its S-BTN-13 scenario drives the same
// code against the real Worker. Every effect is an injected function, so the module imports
// nothing.

/**
 * §7.1 step 3: what a run that found Baton at `head` does with `next` (the current
 * `origin/main`). `isAncestor(a, b)` is `git merge-base --is-ancestor a b`.
 *   - `advance`: there is no head, or the head is an ancestor of `next` — post the snapshot;
 *   - `confirm-only`: `next` is the head or an ancestor of it — post nothing new;
 *   - `force`: neither descends from the other (a rewritten `main`) — post with `force`.
 */
export async function decide(head, next, isAncestor) {
  if (head == null) return 'advance';
  if (head === next || (await isAncestor(next, head))) return 'confirm-only';
  return (await isAncestor(head, next)) ? 'advance' : 'force';
}

/**
 * §6.7: which unconfirmed completions `next` confirms — the claim's `ended_at_sha` is an
 * ancestor of `next` (or is `next`), and its item is no longer `in-progress` in git (an
 * archived or vanished item counts as moved on). `statusOf(id)` is the item's `status:` at
 * `next`, or `null` when it is not live. A ticket id is qualified (`<repository>:<local id>`,
 * §5.1); this repository's own board knows its items by the local id, so the prefix is dropped.
 */
/** The local id of a qualified ticket id; an unqualified one is already local. */
export const localId = (ticketId) => String(ticketId).slice(String(ticketId).indexOf(':') + 1);

export async function confirmations(unconfirmed, next, { isAncestor, statusOf }) {
  const out = [];
  for (const u of unconfirmed ?? []) {
    if (!u.ended_at_sha) continue;
    const landed = u.ended_at_sha === next || (await isAncestor(u.ended_at_sha, next));
    if (landed && statusOf(localId(u.ticket_id)) !== 'in-progress') out.push({ claim_id: u.claim_id, sha: next });
  }
  return out;
}

/**
 * One sync run (§7.1): take an observation number first (R-BTN-62), read the head, decide,
 * post — and on `head-moved` or `stale-observation` take a new number, re-read the head and
 * decide again, once; on `unavailable` (a key-set outage, §11, which never reached Baton, so
 * the number is still the run's) wait and post again, once. Never a loop: a second failure
 * fails the run. `sync-busy` — another run's reading is in flight — ends this one as `busy`.
 *
 * deps:
 *   observe()           → `{sha, observation, bars}` from `POST /v1/sync/observation`
 *   fetchNext()         → optional: fetches main and returns the commit to post; called after
 *                         each number, so the commit and the payload are read after it (§7.1
 *                         steps 1–2). Absent, `next` as given is posted (a harness's fixed board).
 *   readHead()          → `{sha, unconfirmed}` from `GET /v1/sync/head`
 *   post(body)          → `{ok: true, …}` or `{ok: false, code}` from `POST /v1/sync/board`
 *   isAncestor(a, b)    → boolean
 *   buildPayload()      → `{registry, state: {items}, ready, prices, providers, matrix, reviewers}`
 *   statusOf(id)        → the item's status at `next`, or null
 *   sleep(ms)           → a promise; the backoff before retrying `unavailable`
 *
 * Returns `{outcome, steps, next}` (`next` the commit the run judged): `outcome` is `advanced`, `confirmed`, `held`, `busy` or `failed:<code>`,
 * and `steps` says what happened, for the run's log.
 */
export async function syncOnce(next, deps, { backoffMs = 30_000 } = {}) {
  const steps = [];
  const done = (r) => ({ ...r, next });
  let outages = 0;
  // A head that could not be read is never "no head": that would post a parent-less snapshot
  // and drop the unconfirmed list. `unavailable` waits and reads once more; anything else fails.
  const readHead = async () => {
    for (;;) {
      const h = await deps.readHead();
      if (h.ok !== false) return h;
      steps.push(`head: ${h.code}`);
      if (h.code === 'unavailable' && outages++ === 0) {
        await deps.sleep(backoffMs);
        continue;
      }
      return h;
    }
  };
  // The number first: everything the run reads after it is newer than it (R-BTN-62).
  const take = async () => {
    for (;;) {
      const o = await deps.observe();
      if (o.ok !== false) return o;
      steps.push(`observation: ${o.code}`);
      if (o.code === 'unavailable' && outages++ === 0) {
        await deps.sleep(backoffMs);
        continue;
      }
      return o;
    }
  };
  const ended = (code) => done({ outcome: code === 'sync-busy' ? 'busy' : `failed:${code}`, steps });
  let obs = await take();
  if (obs.ok === false) return ended(obs.code);
  if (deps.fetchNext) next = await deps.fetchNext();
  let head = await readHead();
  if (head.ok === false) return done({ outcome: `failed:${head.code}`, steps });
  let payload = null;
  for (let retries = 0; ;) {
    const d = await decide(head.sha, next, deps.isAncestor);
    steps.push(`${d} over ${head.sha ?? 'no head'}`);
    const confirmed = await confirmations(head.unconfirmed, next, deps);
    // A checkout behind the head posts nothing (§7.1); one at the head posts a refresh even with
    // nothing to confirm, which also uses its number, so the next run is not held off as busy.
    if (d === 'confirm-only' && !confirmed.length && next !== head.sha) return done({ outcome: 'confirmed', steps });
    payload ??= await deps.buildPayload();
    // Confirm-only re-posts the head itself (a no-op for the board, R-BTN-11) carrying the
    // confirmations, so one endpoint and one payload shape serve both; Baton applies them
    // on that path (R3-1212).
    const body = d === 'confirm-only'
      ? { ...payload, sha: head.sha, parent_sha: head.sha, confirmations: confirmed, observation: obs.observation }
      : { ...payload, sha: next, parent_sha: head.sha ?? null, confirmations: confirmed, observation: obs.observation, ...(d === 'force' ? { force: true } : {}) };
    const res = await deps.post(body);
    steps.push(res.ok ? 'accepted' : res.code);
    if (res.ok) return done({ outcome: d === 'confirm-only' ? 'confirmed' : 'advanced', steps });
    if (res.code === 'snapshot-rejected' && d === 'force') return done({ outcome: 'held', steps });
    // Baton used the number refusing it: a new one, then the head again (R-BTN-62).
    if ((res.code === 'head-moved' || res.code === 'stale-observation') && retries++ === 0) {
      obs = await take();
      if (obs.ok === false) return ended(obs.code);
      // Everything posted under the new number is read after it (§7.1 step 2): the commit and
      // the payload too.
      if (deps.fetchNext) next = await deps.fetchNext();
      payload = null;
      head = await readHead();
      if (head.ok === false) return done({ outcome: `failed:${head.code}`, steps });
      continue;
    }
    if (res.code === 'unavailable' && outages++ === 0) {
      await deps.sleep(backoffMs);
      continue;
    }
    return done({ outcome: `failed:${res.code}`, steps });
  }
}

/** The dashboard's Ready order against the local order (`rankReady` per tier — Baton applies
 *  the expedite bound from its own claims), per tier (R3-1209's live check):
 *  `{tier: {baton: [ids], local: [ids], same}}`. */
export function compareReady(readyByTier, localOf, tiers) {
  const out = {};
  for (const t of tiers) {
    const baton = readyByTier?.[t] ?? [];
    const local = localOf(t).map((r) => r.id);
    out[t] = { baton, local, same: baton.length === local.length && baton.every((id, i) => id === local[i]) };
  }
  return out;
}
