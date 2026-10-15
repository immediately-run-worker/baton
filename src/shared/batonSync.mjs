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
 * `next`, or `null` when it is not live.
 */
export async function confirmations(unconfirmed, next, { isAncestor, statusOf }) {
  const out = [];
  for (const u of unconfirmed ?? []) {
    if (!u.ended_at_sha) continue;
    const landed = u.ended_at_sha === next || (await isAncestor(u.ended_at_sha, next));
    if (landed && statusOf(u.ticket_id) !== 'in-progress') out.push({ claim_id: u.claim_id, sha: next });
  }
  return out;
}

/**
 * One sync run (§7.1): read the head, decide, post — and on `head-moved` re-read the head and
 * decide again, once; on `unavailable` (a key-set outage, §11) wait and post again, once.
 * Never a loop: a second failure fails the run.
 *
 * deps:
 *   readHead()          → `{sha, unconfirmed}` from `GET /v1/sync/head`
 *   post(body)          → `{ok: true, …}` or `{ok: false, code}` from `POST /v1/sync/board`
 *   isAncestor(a, b)    → boolean
 *   buildPayload()      → `{state: {items}, ready, prices, providers, matrix, reviewers, min_skills_version}`
 *   statusOf(id)        → the item's status at `next`, or null
 *   sleep(ms)           → a promise; the backoff before retrying `unavailable`
 *
 * Returns `{outcome, steps}`: `outcome` is `advanced`, `confirmed`, `held` or `failed:<code>`,
 * and `steps` says what happened, for the run's log.
 */
export async function syncOnce(next, deps, { backoffMs = 30_000 } = {}) {
  const steps = [];
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
  let head = await readHead();
  if (head.ok === false) return { outcome: `failed:${head.code}`, steps };
  let payload = null;
  for (let headMoves = 0; ;) {
    const d = await decide(head.sha, next, deps.isAncestor);
    steps.push(`${d} over ${head.sha ?? 'no head'}`);
    const confirmed = await confirmations(head.unconfirmed, next, deps);
    if (d === 'confirm-only' && !confirmed.length) return { outcome: 'confirmed', steps };
    payload ??= await deps.buildPayload();
    // Confirm-only re-posts the head itself (a no-op for the board, R-BTN-11) carrying the
    // confirmations, so one endpoint and one payload shape serve both; Baton applies them
    // on that path (R3-1212).
    const body = d === 'confirm-only'
      ? { ...payload, sha: head.sha, parent_sha: head.sha, confirmations: confirmed }
      : { ...payload, sha: next, parent_sha: head.sha ?? null, confirmations: confirmed, ...(d === 'force' ? { force: true } : {}) };
    const res = await deps.post(body);
    steps.push(res.ok ? 'accepted' : res.code);
    if (res.ok) return { outcome: d === 'confirm-only' ? 'confirmed' : 'advanced', steps };
    if (res.code === 'snapshot-rejected' && d === 'force') return { outcome: 'held', steps };
    if (res.code === 'head-moved' && headMoves++ === 0) {
      head = await readHead();
      if (head.ok === false) return { outcome: `failed:${head.code}`, steps };
      continue;
    }
    if (res.code === 'unavailable' && outages++ === 0) {
      await deps.sleep(backoffMs);
      continue;
    }
    return { outcome: `failed:${res.code}`, steps };
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
