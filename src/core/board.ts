// board.ts — what a board snapshot becomes in the `tickets` cache (BATON_SPEC §4, §7.1,
// R-BTN-33/35). Pure: the core does the SQL, on either host. Only filter fields survive — an item's
// body, Status notes, exit criteria and PR list never reach Baton; the dashboard links each
// item to its file on GitHub instead.
import { capabilitiesOf } from '../shared/vocabulary.mjs';
import { BatonError } from './http';
import { SESSION_NAME } from './validate';

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
  /** Not in factory-state's items today: the sync adds it from each item's `repos:`
   *  frontmatter (R3-1207). Absent, the row stores `[]`. */
  repos?: string[];
  /** factory-state's date the item entered its status (`YYYY-MM-DD`): for an in-progress item,
   *  its claim note's date, which the legacy import's `reap_after` counts from (§13). */
  since?: string;
  /** The claim note's holder session (`holderOf`), when the sync posts it: the legacy worker's
   *  session name, which adoption matches (§13 step 3). */
  holder?: string;
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
  /** §6.8: the transcript repositories from `baton.json`; absent, the defaults stand. */
  transcript_repos?: string[];
}

export interface ProvidersData {
  accounts: { id: string; name: string; billing: 'subscription' | 'api'; window_limits: Record<string, number> | null }[];
  peak_schedules: { id: string; rules: { days: number[]; hoursUtc: [number, number][] }; factor: number }[];
  models: { provider: string; model: string; monthly_limit_usd: number | null; peak_schedule?: string }[];
}

/** A `tickets` row (§4) plus its expanded requirements (`ticket_requires`). */
export interface TicketRow {
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
  since: string | null;
  holder: string | null;
}

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/; // a local id (R-BTN-47)
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
  if (p.force !== undefined && typeof p.force !== 'boolean') throw new BatonError('invalid-params', 'force must be a boolean');
  if (p.min_skills_version !== undefined && !(Number.isInteger(p.min_skills_version) && p.min_skills_version >= 0)) {
    throw new BatonError('invalid-params', 'min_skills_version must be a non-negative integer');
  }
  checkReference(p);
  return p;
}

const ACCOUNT = /^[a-z0-9_]{1,64}$/;
const MODEL = /^[A-Za-z0-9._/:-]{1,200}$/;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (field: string, why: string): never => {
  throw new BatonError('invalid-params', `${field}: ${why}`);
};
function regex(field: string, pattern: unknown) {
  if (typeof pattern !== 'string') bad(field, 'must be a pattern string');
  try {
    new RegExp(pattern as string, 'i');
  } catch {
    bad(field, 'is not a valid pattern');
  }
}
function catalog(field: string, agents: unknown) {
  if (!isObj(agents)) bad(field, 'must be an object of agents');
  for (const [name, a] of Object.entries(agents as Record<string, unknown>)) {
    if (!NAME.test(name) || !isObj(a)) bad(`${field}.${name}`, 'is malformed');
    const agent = a as Record<string, unknown>;
    if (typeof agent.reviews_on !== 'string' || !MODEL.test(agent.reviews_on)) bad(`${field}.${name}.reviews_on`, 'must be a model id');
    if (!Array.isArray(agent.bills) || !agent.bills.every((b) => typeof b === 'string' && NAME.test(b))) bad(`${field}.${name}.bills`, 'must be a list of prefixes');
    if (agent.models !== undefined && !(isObj(agent.models) && Object.entries(agent.models).every(([k, v]) => NAME.test(k) && typeof v === 'string' && MODEL.test(v)))) {
      bad(`${field}.${name}.models`, 'must map prefixes to model ids');
    }
  }
}

/** The reference blocks (§7.3, §7.4) are docs data files: a malformed one is refused, named,
 *  before anything is written, never left to fail a constraint mid-transaction. */
function checkReference(p: BoardPayload) {
  if (p.prices !== undefined) {
    if (!isObj(p.prices) || !Array.isArray(p.prices.models)) bad('prices.models', 'must be a list');
    p.prices.models.forEach((m, i) => {
      if (!isObj(m)) bad(`prices.models[${i}]`, 'must be an object');
      regex(`prices.models[${i}].match`, m.match);
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite5m'] as const) if (m[k] !== undefined && !isNum(m[k])) bad(`prices.models[${i}].${k}`, 'must be a number');
    });
  }
  if (p.providers !== undefined) {
    const pr = p.providers;
    if (!isObj(pr) || !Array.isArray(pr.accounts) || !Array.isArray(pr.peak_schedules) || !Array.isArray(pr.models)) bad('providers', 'needs accounts, peak_schedules and models lists');
    const accounts = new Set<string>();
    pr.accounts.forEach((a, i) => {
      if (!isObj(a) || typeof a.id !== 'string' || !ACCOUNT.test(a.id)) bad(`providers.accounts[${i}].id`, 'is malformed');
      if (accounts.has(a.id)) bad(`providers.accounts[${i}].id`, `repeats ${a.id}`);
      if (typeof a.name !== 'string' || !TEXT.test(a.name)) bad(`providers.accounts[${i}].name`, 'must be short text');
      if (a.billing !== 'subscription' && a.billing !== 'api') bad(`providers.accounts[${i}].billing`, "must be 'subscription' or 'api'");
      if (a.window_limits !== null && !(isObj(a.window_limits) && Object.values(a.window_limits).every(isNum))) bad(`providers.accounts[${i}].window_limits`, 'must be null or numbers by window');
      accounts.add(a.id);
    });
    const schedules = new Set<string>();
    pr.peak_schedules.forEach((sc, i) => {
      const ok = isObj(sc) && typeof sc.id === 'string' && NAME.test(sc.id) && isNum(sc.factor) && isObj(sc.rules) &&
        Array.isArray(sc.rules.days) && sc.rules.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
        Array.isArray(sc.rules.hoursUtc) && sc.rules.hoursUtc.every((h) => Array.isArray(h) && h.length === 2 && Number.isInteger(h[0]) && Number.isInteger(h[1]) && 0 <= h[0] && h[0] < h[1] && h[1] <= 24);
      if (!ok) bad(`providers.peak_schedules[${i}]`, 'needs an id, days 0–6, [start, end) hour pairs and a numeric factor');
      if (schedules.has(sc.id)) bad(`providers.peak_schedules[${i}].id`, `repeats ${sc.id}`);
      schedules.add(sc.id);
    });
    const pairs = new Set<string>();
    pr.models.forEach((m, i) => {
      if (!isObj(m) || !accounts.has(m.provider)) bad(`providers.models[${i}].provider`, 'must name an account in providers.accounts');
      if (typeof m.model !== 'string' || !MODEL.test(m.model)) bad(`providers.models[${i}].model`, 'must be a model id');
      if (m.monthly_limit_usd !== null && !isNum(m.monthly_limit_usd)) bad(`providers.models[${i}].monthly_limit_usd`, 'must be a number or null');
      if (m.peak_schedule !== undefined && !schedules.has(m.peak_schedule)) bad(`providers.models[${i}].peak_schedule`, 'must name a schedule in providers.peak_schedules');
      if (pairs.has(`${m.provider} ${m.model}`)) bad(`providers.models[${i}]`, `repeats ${m.provider} ${m.model}`);
      pairs.add(`${m.provider} ${m.model}`);
    });
  }
  if (p.matrix !== undefined) {
    if (!isObj(p.matrix) || !isObj(p.matrix.families)) bad('matrix.families', 'must be an object');
    for (const [fam, pats] of Object.entries(p.matrix.families)) {
      if (!NAME.test(fam) || !Array.isArray(pats)) bad(`matrix.families.${fam}`, 'must be a list of patterns');
      pats.forEach((pat, i) => regex(`matrix.families.${fam}[${i}]`, pat));
    }
    catalog('matrix.agents', p.matrix.agents);
  }
  if (p.reviewers !== undefined) catalog('reviewers', p.reviewers);
  if (p.transcript_repos !== undefined && !(Array.isArray(p.transcript_repos) && p.transcript_repos.length <= 20 && p.transcript_repos.every((r) => typeof r === 'string' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(r)))) {
    bad('transcript_repos', 'must be a list of owner/name repositories');
  }
}

/** The row an item becomes (R-BTN-33). `rank` is its index in the sync's `ready` list. A
 *  clause is stored expanded (§7.2 rule 4): a role becomes its capabilities, a legacy name
 *  stays itself, `none` stores nothing; `operator_only` carries rule 6. */
export function rowFor(it: StateItem, rankOf: Map<string, number>): TicketRow {
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
    since: calendarDate(it.since),
    holder: typeof it.holder === 'string' && SESSION_NAME.test(it.holder) ? it.holder : null,
  };
}

/** `since` comes from a Status note's date, which git does not check: a value that is not a
 *  real calendar day (`2026-13-01`, `2026-02-31`) is unknown for that item, and never refuses the
 *  whole board. The legacy import then counts from the cutover itself. */
export function calendarDate(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? v : null;
}

/** The row's hash: what decides whether an accepted snapshot rewrites it (§7.1). */
export async function rowHash(row: TicketRow): Promise<string> {
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
