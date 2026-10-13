// board.ts — what a board snapshot becomes in the `work_items` cache (BATON_SPEC §4, §7.1,
// R-BTN-33/35). Pure: the Durable Object does the SQL. Only filter fields survive — an item's
// body, Status notes, exit criteria and PR list never reach Baton; the dashboard links each
// item to its file on GitHub instead.
import { capabilitiesOf } from './shared/vocabulary.mjs';
import { BatonError } from './http';

/** One factory-state item, as the sync posts it (`docs/scripts/factory-state.mjs`). Only the
 *  keys named here are read; anything else in the item is ignored. */
export interface StateItem {
  id: string;
  title: string;
  status: string;
  project?: string | null;
  order?: number | null;
  tags?: string[];
  requires?: string[] | null;
  tier?: string | null;
  queue: string;
  node: string;
  dependsOn?: string[];
  blockedBy?: string[];
  repos?: string[];
}

export interface BoardPayload {
  sha: string;
  parent_sha: string | null;
  force?: boolean;
  state: { items: StateItem[] };
  /** The ready items in `rankReady` order (lib/factoryState.mjs), computed by the sync. */
  ready: string[];
  confirmations?: unknown[];
  prices?: { models: { match: string; input?: number; output?: number; cacheRead?: number; cacheWrite5m?: number }[] };
  providers?: ProvidersData;
  reviewers?: Record<string, { reviews_on: string; bills: string[]; models?: Record<string, string> }>;
  matrix?: { families: Record<string, string[]>; agents: Record<string, { reviews_on: string; bills: string[]; models?: Record<string, string> }> };
  min_skills_version?: number;
}

export interface ProvidersData {
  accounts: { id: string; name: string; billing: 'subscription' | 'api'; window_limits: Record<string, number> | null }[];
  peak_schedules: { id: string; rules: { days: number[]; hoursUtc: [number, number][] }; factor: number }[];
  models: { provider: string; model: string; monthly_limit_usd: number | null; peak_schedule?: string }[];
}

/** A `work_items` row (§4) plus its expanded requirements (`work_item_requires`). */
export interface WorkItemRow {
  id: string;
  path: string;
  title: string;
  project: string | null;
  status: string;
  node: string;
  queue: string;
  tags: string;
  tier: string | null;
  requires_clause: 'absent' | 'none' | 'listed';
  operator_only: 0 | 1;
  depends_on: string;
  blocked_by: string;
  repos: string;
  ord: string | null;
  rank: number | null;
  requires: string[];
}

const SHA = /^[0-9a-f]{40}$/;
const ID = /^R3-[A-Za-z0-9.-]{1,32}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A title comes from git, not from a worker, and the dashboard renders it with textContent
// (§10.4), so it is only bounded and free of control characters.
const TEXT = /^[^\u0000-\u001f\u007f]{1,500}$/;

function list(v: unknown, re: RegExp, what: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && re.test(x))) throw new BatonError('invalid-params', `${what} must be a list of names`);
  return v as string[];
}

/** Validate the snapshot's shape before anything is written; refuses rather than guesses. */
export function checkPayload(body: unknown): BoardPayload {
  const p = body as BoardPayload;
  if (!p || typeof p !== 'object') throw new BatonError('invalid-params', 'a JSON object is required');
  if (typeof p.sha !== 'string' || !SHA.test(p.sha)) throw new BatonError('invalid-params', 'sha must be a 40-hex commit');
  if (p.parent_sha !== null && (typeof p.parent_sha !== 'string' || !SHA.test(p.parent_sha))) throw new BatonError('invalid-params', 'parent_sha must be a 40-hex commit or null');
  if (!p.state || !Array.isArray(p.state.items)) throw new BatonError('invalid-params', 'state.items is required');
  if (!Array.isArray(p.ready) || !p.ready.every((id) => typeof id === 'string' && ID.test(id))) throw new BatonError('invalid-params', 'ready must be the rankReady id list');
  const seen = new Set<string>();
  for (const it of p.state.items) {
    if (!it || typeof it.id !== 'string' || !ID.test(it.id)) throw new BatonError('invalid-params', 'an item id is malformed');
    if (seen.has(it.id)) throw new BatonError('invalid-params', `${it.id} appears twice`);
    seen.add(it.id);
    if (typeof it.title !== 'string' || !TEXT.test(it.title)) throw new BatonError('invalid-params', `${it.id}: title must be short plain text`);
    for (const [k, v] of [['status', it.status], ['queue', it.queue], ['node', it.node]] as const) {
      if (typeof v !== 'string' || !NAME.test(v)) throw new BatonError('invalid-params', `${it.id}: ${k} is malformed`);
    }
    if (it.tier != null && !NAME.test(it.tier)) throw new BatonError('invalid-params', `${it.id}: tier is malformed`);
    if (it.project != null && !NAME.test(it.project)) throw new BatonError('invalid-params', `${it.id}: project is malformed`);
    if (it.order != null && !Number.isFinite(it.order)) throw new BatonError('invalid-params', `${it.id}: order must be a number`);
    list(it.tags, /^[A-Za-z0-9-]{1,64}$/, `${it.id}: tags`);
    list(it.requires, NAME, `${it.id}: requires`);
    list(it.dependsOn, ID, `${it.id}: dependsOn`);
    list(it.blockedBy, ID, `${it.id}: blockedBy`);
    list(it.repos, /^[A-Za-z0-9._-]{1,100}$/, `${it.id}: repos`);
  }
  for (const id of p.ready) if (!seen.has(id)) throw new BatonError('invalid-params', `ready names ${id}, which is not in state.items`);
  return p;
}

/** The row an item becomes (R-BTN-33). `rank` is its index in the sync's `ready` list. A
 *  clause is stored expanded (§7.2 rule 4): a role becomes its capabilities, a legacy name
 *  stays itself, `none` stores nothing; `operator_only` carries rule 6. */
export function rowFor(it: StateItem, rankOf: Map<string, number>): WorkItemRow {
  const tags = it.tags ?? [];
  const names = it.requires ?? null;
  const clause = names == null ? 'absent' : names.every((n) => n === 'none') ? 'none' : 'listed';
  return {
    id: it.id,
    path: `content/roadmap/${it.id}.mdx`,
    title: it.title,
    project: it.project ?? null,
    status: it.status,
    node: it.node,
    queue: it.queue,
    tags: JSON.stringify(tags),
    tier: it.tier ?? null,
    requires_clause: clause,
    operator_only: tags.includes('OP') || (names ?? []).includes('human-operator') ? 1 : 0,
    depends_on: JSON.stringify(it.dependsOn ?? []),
    blocked_by: JSON.stringify(it.blockedBy ?? []),
    repos: JSON.stringify(it.repos ?? []),
    ord: it.order == null ? null : String(it.order),
    rank: rankOf.get(it.id) ?? null,
    requires: [...capabilitiesOf(names)].sort(),
  };
}

/** The row's hash: what decides whether an accepted snapshot rewrites it (§7.1). */
export async function rowHash(row: WorkItemRow): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(row));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── peaks (§7.3, the Providers view) ────────────────────────────────────────────────────

const HOUR = 3_600_000;

/** Whether `ms` falls in a schedule's peak (UTC weekday in `days`, hour in a [start, end) pair). */
export function inPeak(rules: { days: number[]; hoursUtc: [number, number][] }, ms: number): boolean {
  const d = new Date(ms);
  const h = d.getUTCHours();
  return rules.days.includes(d.getUTCDay()) && rules.hoursUtc.some(([a, b]) => a <= h && h < b);
}

/** The next hour boundary at which `inPeak` flips, within 8 days, or null. */
export function nextPeakChange(rules: { days: number[]; hoursUtc: [number, number][] }, ms: number): number | null {
  const now = inPeak(rules, ms);
  let t = Math.floor(ms / HOUR) * HOUR + HOUR;
  for (let i = 0; i < 24 * 8; i++, t += HOUR) if (inPeak(rules, t) !== now) return t;
  return null;
}

/** The list price for a model id: the first `prices.models` entry whose `match` regex
 *  (case-insensitive) matches, as model-prices.json is read by sessionUsage.mjs. */
export function priceFor(prices: BoardPayload['prices'], modelId: string) {
  for (const m of prices?.models ?? []) {
    try {
      if (new RegExp(m.match, 'i').test(modelId)) return m;
    } catch {
      /* a malformed pattern matches nothing */
    }
  }
  return null;
}
