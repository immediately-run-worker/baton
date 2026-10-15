// baton.mjs — Baton's decisions as pure functions (BATON_SPEC §5, §7.2, §7.4; R3-1205).
//
// The Worker (R3-1206) and the Node tooling (`baton-seats.mjs`, the review gate, claim.sh)
// must make the same decisions — who may review, which account a model bills, whether a
// worker can take an item — so they share this module. It imports only `vocabulary.mjs`:
// no `node:` module, no `process.env`, no direct `Date.now()`. Every input (the matrix, the
// providers, the suspensions, the clock) is an argument, so the Worker bundles it as is.

import { capabilitiesOf, fitsTier, TIERS } from './vocabulary.mjs';

// ── the clock (R-BTN-32) ────────────────────────────────────────────────────────────────

let testClock = null;

/** Now, in epoch ms: `Date.now()` unless a test clock is injected. It never reads
 *  `process.env` — a deployed Worker or a fleet session can never be steered onto a fake
 *  clock by an environment variable (G-BTN-38). */
export function batonNow() {
  return testClock ? testClock() : Date.now();
}

/** Inject a clock (`() => epochMs`) for tests; `null` restores the real one. */
export function setTestClock(fn) {
  testClock = typeof fn === 'function' ? fn : null;
}

// ── families and seats ──────────────────────────────────────────────────────────────────

const patternCache = new WeakMap();

/** The family a model id belongs to — `claude`, `glm`, … — by the matrix's `families`
 *  patterns (case-insensitive, first match in key order), or `null` for a model no family
 *  covers (`ember-1`): the matrix's `default` row applies to it. */
export function familyOf(modelId, matrix) {
  if (!modelId) return null;
  let compiled = patternCache.get(matrix);
  if (!compiled) {
    compiled = Object.entries(matrix.families).map(([family, patterns]) => [family, patterns.map((p) => new RegExp(p, 'i'))]);
    patternCache.set(matrix, compiled);
  }
  for (const [family, regexes] of compiled) if (regexes.some((r) => r.test(modelId))) return family;
  return null;
}

/** `YYYY-MM-DD` (UTC) and epoch ms for a date given as either. A bare date is its 00:00 UTC. */
function dayAndMs(date) {
  const ms = typeof date === 'number' ? date : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date);
  if (!Number.isFinite(ms)) throw new Error(`baton: unreadable date "${date}"`);
  return { day: new Date(ms).toISOString().slice(0, 10), ms };
}

/** The agent a seat list puts in the seat on `day`, or `null`. `from`/`until` are inclusive. */
export function seatOn(seat, day) {
  const hit = (seat ?? []).find((s) => (s.from == null || s.from <= day) && (s.until == null || day <= s.until));
  return hit ? hit.agent : null;
}

/** The family an `--authors`-style name stands for: a family key (any case), `default`, or a
 *  model id `familyOf` maps. Anything else is `undefined`, so a typo or an unmapped model can
 *  never silently read the default row and exclude nothing. */
export function resolveFamily(name, matrix) {
  const n = String(name ?? '').trim();
  const lower = n.toLowerCase();
  if (Object.hasOwn(matrix.families, lower)) return lower;
  if (lower === 'default') return null;
  return familyOf(n, matrix) ?? undefined;
}

/** The matrix row for an author family; a family with no row (or none) gets `default`. */
export function rowFor(family, matrix) {
  return matrix.rows.find((r) => r.author === family) ?? matrix.rows.find((r) => r.author === 'default');
}

/** Every agent some row seats on `day` — the pool substitutes come from (§7.4). */
export function seatedOn(day, matrix) {
  const out = new Set();
  for (const row of matrix.rows) for (const seat of [row.a, row.b]) {
    const agent = seatOn(seat, day);
    if (agent) out.add(agent);
  }
  return out;
}

// ── suspensions ─────────────────────────────────────────────────────────────────────────

/** Whether `providerId` (or `modelId` on it) is suspended at `now` (R-BTN-21): a suspension
 *  in force (`starts_at ≤ now < ends_at`, not lifted) on the whole account or on that model.
 *  A missing `providerId` is a prefix the worker could not resolve to an account, which
 *  counts as suspended — fail closed (§7.4). */
export function suspended(suspensions, providerId, modelId, now) {
  if (!providerId) return true;
  for (const s of suspensions ?? []) checkSuspensionTimes(s);
  return (suspensions ?? []).some((s) =>
    s.provider_id === providerId &&
    (s.model_id == null || s.model_id === modelId) &&
    s.lifted_at == null &&
    s.starts_at <= now &&
    (s.ends_at == null || now < s.ends_at));
}

/** A suspension's times are epoch ms (§4); a string compared with a number is always false,
 *  which would let a malformed row fail open, so it throws instead. */
function checkSuspensionTimes(s) {
  const ok = (v, nullable) => (nullable && v == null) || (typeof v === 'number' && Number.isFinite(v));
  if (!ok(s.starts_at, false) || !ok(s.ends_at, true) || !ok(s.lifted_at, true)) {
    throw new TypeError(`baton: suspension ${s.id ?? ''} on ${s.provider_id}: starts_at, ends_at and lifted_at must be epoch milliseconds`);
  }
}

/** Whether `agent` may run for a worker with `billing` (`{prefix: accountId}`): every prefix
 *  it bills resolves to an account, and none of them is suspended for it. */
function billable(agent, workerBilling, suspensions, now) {
  // The model each prefix bills: `models[prefix]` where the agent spends a second line (review-pr-claude's
  // orchestrator runs on Z.AI while its review runs on Claude), else the model it reviews on.
  return agent.bills.every((prefix) => !suspended(suspensions, workerBilling?.[prefix], agent.models?.[prefix] ?? agent.reviews_on, now));
}

/**
 * The two seats of a review gate (§7.4, R-BTN-27): the author's row's seats when they
 * qualify, else substitutes, else `null`.
 *
 * `authorFamilies` is every family that wrote code on the item's PRs — the first is the
 * original author, whose row is read (a family with no row, or `null`, reads `default`). A
 * seat qualifies when its agent's family is in none of them, differs from the other seat's,
 * and nothing it bills is suspended for `workerBilling`. A seat that does not qualify takes
 * the cheapest agent (`cost`, then name) that some row seats on `date` and that would
 * qualify in it — so an agent in no row (Kimi), or one whose dated seat has ended, never
 * comes back through a suspension. `catalog` is the agents table (`matrix.agents` unless the
 * board sync posts its own).
 *
 * Returns `{a, b, substituted}` — `substituted` names each replaced seat as
 * `{seat, for, agent}` — or `null` when either seat has no qualifying agent.
 */
export function qualifyingPair(authorFamilies, workerBilling, suspensions, date, catalog, matrix) {
  const { day, ms } = dayAndMs(date);
  const authors = new Set((authorFamilies ?? []).filter(Boolean));
  const row = rowFor((authorFamilies ?? [])[0] ?? null, matrix);
  const fam = (name) => familyOf(catalog[name]?.reviews_on, matrix);
  const fits = (name, otherName) =>
    !!catalog[name] &&
    !authors.has(fam(name)) &&
    (otherName == null || (name !== otherName && fam(name) !== fam(otherName))) &&
    billable(catalog[name], workerBilling, suspensions, ms);

  const pool = [...seatedOn(day, matrix)]
    .filter((n) => catalog[n])
    .sort((x, y) => catalog[x].cost - catalog[y].cost || x.localeCompare(y));
  const substituted = [];
  const pick = (seat, rowAgent, otherName) => {
    if (rowAgent && fits(rowAgent, otherName)) return rowAgent;
    const sub = pool.find((n) => fits(n, otherName));
    if (sub) substituted.push({ seat, for: rowAgent, agent: sub });
    return sub ?? null;
  };

  const rowA = seatOn(row.a, day);
  const rowB = seatOn(row.b, day);
  // Seat A first, against B's row agent only when that agent will keep its seat; then B
  // against whatever A became. Seat A is the one that runs every round, so it is filled first.
  const keepB = rowB && fits(rowB, null) ? rowB : null;
  const a = pick('a', rowA, keepB);
  if (!a) return null;
  const b = pick('b', rowB, a);
  if (!b) return null;
  return { a, b, substituted };
}

// ── matching (§7.2) ─────────────────────────────────────────────────────────────────────

/** The refusal codes, by rule number. Rule 1 (being in the claim order) is the ranked list's
 *  job — `rankReady`/`claimOrder` in `lib/factoryState.mjs` — not this function's. */
export const RULE_CODES = {
  2: 'expedite-lane-full',
  3: 'claimed',
  4: 'missing-capability',
  5: 'above-tier-ceiling',
  6: 'operator-only',
  7: 'provider-suspended',
  8: 'awaiting-review-capacity',
  9: 'stale-skills',
  10: 'backing-off',
};

const refuse = (rule) => ({ ok: false, rule, code: RULE_CODES[rule] });

/** Whether a claim row still blocks its item (rule 3): active, completed but unconfirmed
 *  (§6.7), or reaped while its worker was alive and not yet fenced (§6.6). */
export function claimBlocks(claim) {
  return claim.status === 'active' ||
    (claim.status === 'completed' && claim.confirmed_at == null) ||
    (claim.status === 'reaped' && !!claim.fence_pending);
}

/**
 * Whether `worker` may take `item` now (§7.2 rules 2–10), as `{ok: true}` or
 * `{ok: false, rule, code}` naming the first rule that refuses. The reference for every
 * rule: the server's candidate query is tested against it (G-BTN-40).
 *
 * - `worker`: `{tier_ceiling, declared, model_id, model_provider_id, billing, courses}`
 *   — `declared` the capability/role names as the heartbeat sent them, `billing`
 *   `{prefix: accountId}`, `courses` the `{repository, course, version}` its checkouts run.
 * - `item`: `{id, repository, course, tier, tags, requires, expedite}` — `requires` the
 *   clause's names, `null` when it has none; `expedite` true for the expedite lane or an
 *   expedite override.
 * - `ctx`: `{now, claims, override, suspensions, minWorkerVersion, expediteActive,
 *   expediteBound, lastEndReason, authorFamilies, catalog, matrix, tiers}` — `tiers` the item's
 *   repository's ladder (R-BTN-66), `minWorkerVersion` the
 *   item's course's (R-BTN-65), `claims` the item's
 *   claim rows, `override` its `ticket_overrides` row or `null`, `expediteActive` the active
 *   Baton claims on expedited items, `lastEndReason` its most recent claim's end.
 */
export function isEligible(worker, item, ctx) {
  const now = ctx.now ?? batonNow();
  const override = ctx.override ?? null;

  if (item.expedite && (ctx.expediteActive ?? 0) >= (ctx.expediteBound ?? 2)) return refuse(2);

  if ((ctx.claims ?? []).some(claimBlocks) || override?.hold) return refuse(3);

  const held = capabilitiesOf(worker.declared);
  for (const need of capabilitiesOf(item.requires)) if (!held.has(need)) return refuse(4);

  // Rule 5 in the item's repository's ladder (R-BTN-66); the caller resolves the worker's
  // ceiling for that repository. No ladder given: docs' three tiers.
  const ladder = ctx.tiers ?? TIERS;
  if (!fitsTier(item.tier ?? null, worker.tier_ceiling ?? ladder.at(-1), ladder)) return refuse(5);

  const operatorOnly = (item.tags ?? []).includes('OP') || (item.requires ?? []).includes('human-operator');
  if (operatorOnly && !(worker.declared ?? []).includes('human-operator')) return refuse(6);

  if (suspended(ctx.suspensions, worker.model_provider_id, worker.model_id, now)) return refuse(7);

  if (ctx.lastEndReason === 'released:awaiting-review-capacity') {
    const families = [...(ctx.authorFamilies ?? []), familyOf(worker.model_id, ctx.matrix)];
    const catalog = ctx.catalog ?? ctx.matrix.agents;
    if (!qualifyingPair(families, worker.billing, ctx.suspensions, now, catalog, ctx.matrix)) return refuse(8);
  }

  // Rule 9 (R-BTN-22, R-BTN-48, R-BTN-65): the worker declares the item's course at its
  // `min_worker_version` or later; a worker that declares the course not at all is stale too.
  const declared = (worker.courses ?? []).find((c) => c.repository === item.repository && c.course === item.course);
  if (!declared || declared.version < (ctx.minWorkerVersion ?? 0)) return refuse(9);

  if (override?.retry_after != null && override.retry_after > now) return refuse(10);

  return { ok: true };
}

/** The first item of a ranked list `worker` may take, with the refusals before it:
 *  `{item, refusals: [{id, rule, code}]}`; `item` is `null` when none qualifies.
 *  `ctxFor(item)` supplies each item's `isEligible` context. */
export function firstEligible(worker, ranked, ctxFor) {
  const refusals = [];
  for (const item of ranked) {
    const verdict = isEligible(worker, item, ctxFor(item));
    if (verdict.ok) return { item, refusals };
    refusals.push({ id: item.id, rule: verdict.rule, code: verdict.code });
  }
  return { item: null, refusals };
}
