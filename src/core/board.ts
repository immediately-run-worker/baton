// board.ts — what a board snapshot becomes in the `tickets` cache (BATON_SPEC §4, §7.1,
// R-BTN-33/35). Pure: the core does the SQL, on either host. Only filter fields survive — an item's
// body, Status notes, exit criteria and PR list never reach Baton; the dashboard links each
// item to its file on GitHub instead.
import { capabilitiesOf } from '../shared/vocabulary.mjs';
import { parseTranscriptRepo } from './links';
import { BatonError } from './http';
import { checkRegistry, COURSE_ID, type RegistryEntry } from './courses';
import { COURSE_ID as LEG_ID, LOCAL_ID, SESSION_NAME, TAG } from './validate';
import type { Step } from './graph';

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
  /** The ticket's course (R-BTN-48): absent, `roadmap-pr`, so no existing docs item changes. */
  course?: string;
}

/** A ticket's course when its item names none (R-BTN-48). */
export const DEFAULT_COURSE = 'roadmap-pr';

/** A ticket of §7.1's normative post. Only the generic fields are read; `course` (opaque, for the
 *  course's hook, R3-1236), `parent` (R3-1258) and `not_before` (R3-1259) are accepted unread. */
export interface PostedTicket {
  id: string;
  course_id: string;
  path: string;
  title: string;
  tier?: string | null;
  requires: string[];
  operator_only: boolean;
  expedite: boolean;
  depends_on: string[];
  blocked_by: string[];
  repos: string[];
  rank?: number | null;
  /** Shown, never read (§2b). */
  display?: { status?: string; group?: string; project?: string };
}

/** Where the sync places a ticket (R-BTN-70, §7.1 `stations`). */
export interface PostedStation {
  station: string;
  path: Step[];
  next_leg: string | null;
  next_source: 'course' | 'marker' | 'inferred' | 'holder';
  handoff_url: string | null;
  next: { leg: string; state: 'ready' | 'waiting'; waiting_on: string | null }[];
  /** Tags barred from each leg of the course the sync knows them for (`ticket_bars`). */
  bars: Record<string, string[]>;
}

export interface BoardPayload {
  sha: string;
  parent_sha: string | null;
  /** The number `POST /v1/sync/observation` handed out before the sync read anything (R-BTN-62). */
  observation: number;
  force?: boolean;
  /** The interim post (docs until R3-1233): factory-state's items and the `rankReady` order. */
  state?: { items: StateItem[] };
  /** The ready items in `rankReady` order (lib/factoryState.mjs), computed by the sync. */
  ready?: string[];
  /** §7.1's normative post: the tickets, those closed since the parent, and where each is. */
  tickets?: PostedTicket[];
  closed?: { id: string; as: 'done' | 'withdrawn' }[];
  stations?: Record<string, PostedStation>;
  confirmations?: unknown[];
  prices?: { models: { match: string; input?: number; output?: number; cacheRead?: number; cacheWrite5m?: number }[] };
  providers?: ProvidersData;
  reviewers?: Record<string, { reviews_on: string; bills: string[]; models?: Record<string, string> }>;
  matrix?: { families: Record<string, string[]>; agents: Record<string, { reviews_on: string; bills: string[]; models?: Record<string, string> }> };
  /** The course registry (R-BTN-48, §7.1); absent, the courses in force stay. */
  registry?: RegistryEntry[];
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
  course_id: string;
  /** The tier's position in the repository's ladder (R-BTN-66), set by the core, which knows it. */
  tier_position?: number | null;
  requires: string[];
  since: string | null;
  holder: string | null;
  /** As posted (§7.1), or the interim item's expedite queue (R-BTN-12). */
  expedite: 0 | 1;
  /** Shown, never read (§2b): JSON, or null. */
  display: string | null;
}

const SHA = /^[0-9a-f]{40}$/;
const ID = LOCAL_ID; // a local id (R-BTN-47)
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A title comes from git, not from a worker, and the dashboard renders it with textContent
// (§10.4), so it is only bounded and free of control characters.
const TEXT = /^[^\u0000-\u001f\u007f]{1,500}$/;

function list(v: unknown, re: RegExp, what: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && re.test(x))) throw new BatonError('invalid-params', `${what} must be a list of names`);
  return v as string[];
}

/** Validate the snapshot's shape before anything is written; refuses rather than guesses. A post
 *  is the normative shape (`tickets`, `closed`, `stations`, §7.1) or the interim one docs posts
 *  until R3-1233 (`state.items`, `ready`), never both. */
export function checkPayload(body: unknown): BoardPayload {
  const p = body as BoardPayload;
  if (!p || typeof p !== 'object') throw new BatonError('invalid-params', 'a JSON object is required');
  if (typeof p.sha !== 'string' || !SHA.test(p.sha)) throw new BatonError('invalid-params', 'sha must be a 40-hex commit');
  if (p.parent_sha !== null && (typeof p.parent_sha !== 'string' || !SHA.test(p.parent_sha))) throw new BatonError('invalid-params', 'parent_sha must be a 40-hex commit or null');
  if (!Number.isSafeInteger(p.observation) || p.observation < 1) throw new BatonError('invalid-params', 'observation must be the number POST /v1/sync/observation handed out (R-BTN-62)');
  if (p.tickets !== undefined) {
    if (p.state !== undefined || p.ready !== undefined) throw new BatonError('invalid-params', 'a post is either the normative tickets or the interim state.items, not both');
    checkNormative(p);
  } else {
    checkInterim(p);
  }
  if (p.force !== undefined && typeof p.force !== 'boolean') throw new BatonError('invalid-params', 'force must be a boolean');
  // `min_skills_version` is gone (R-BTN-22: each course's version is the skills version); a
  // sync that still sends it is not refused for it, and Baton reads it nowhere.
  checkReference(p);
  return p.registry === undefined ? p : { ...p, registry: checkRegistry(p.registry) };
}

/** A forge path as `repos` carries it (R-BTN-92): `owner/name`, a GitLab `group/…/name`; docs'
 *  interim post still sends short names. */
const REPO = /^[A-Za-z0-9._-]{1,100}(\/[A-Za-z0-9._-]{1,100}){0,3}$/;

function checkInterim(p: BoardPayload) {
  if (!p.state || !Array.isArray(p.state.items)) throw new BatonError('invalid-params', 'state.items is required');
  if (!Array.isArray(p.ready) || !p.ready.every((id) => typeof id === 'string' && ID.test(id))) throw new BatonError('invalid-params', 'ready must be the rankReady id list');
  if (p.closed !== undefined || p.stations !== undefined) throw new BatonError('invalid-params', 'closed and stations come with the normative tickets');
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
    list(it.repos, REPO, `${it.id}: repos`);
    if (it.course !== undefined && (typeof it.course !== 'string' || !COURSE_ID.test(it.course))) throw new BatonError('invalid-params', `${it.id}: course must be a course id`);
  }
  for (const id of p.ready) if (!seen.has(id)) throw new BatonError('invalid-params', `ready names ${id}, which is not in state.items`);
}

/** Posted lists' bounds (spec-silent, recorded on R3-1232): a board of 10 000 tickets, a path of
 *  500 legs, 64 next legs, 64 barred legs of 64 tags each. */
const TICKETS_MAX = 10_000;
const PATH_MAX = 500;
const NEXT_MAX = 64;
const BARS_MAX = 64;
const DEP_MAX = 500;
/** A ticket's file in its repository: segments of names, none `.` or `..`. */
const isTicketPath = (v: unknown) =>
  typeof v === 'string' && v.length <= 256 && v.split('/').every((seg) => /^[A-Za-z0-9._-]+$/.test(seg) && seg !== '.' && seg !== '..');
/** A `waiting_on` label: free, short, compared as a string (R-BTN-69). */
const WAITING_ON = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const isObjArr = (v: unknown, max: number) => Array.isArray(v) && v.length <= max;

function checkNormative(p: BoardPayload) {
  const fail = (field: string, why: string): never => {
    throw new BatonError('invalid-params', `${field}: ${why}`);
  };
  if (!isObjArr(p.tickets, TICKETS_MAX)) fail('tickets', `must be a list of at most ${TICKETS_MAX}`);
  const seen = new Set<string>();
  for (const [i, t] of p.tickets!.entries()) {
    const at = `tickets[${i}]`;
    if (!isObj(t) || typeof t.id !== 'string' || !ID.test(t.id)) fail(`${at}.id`, 'must be a local id');
    if (seen.has(t.id)) fail(`${at}.id`, `${t.id} appears twice`);
    seen.add(t.id);
    if (typeof t.course_id !== 'string' || !COURSE_ID.test(t.course_id)) fail(`${t.id}.course_id`, 'must be a course id');
    if (!isTicketPath(t.path)) fail(`${t.id}.path`, 'must be a relative path, no segment empty, . or ..');
    if (typeof t.title !== 'string' || !TEXT.test(t.title)) fail(`${t.id}.title`, 'must be short plain text');
    if (t.tier != null && !NAME.test(t.tier)) fail(`${t.id}.tier`, 'must be a tier name');
    if (!Array.isArray(t.requires)) fail(`${t.id}.requires`, 'must be a list (`none` and no clause are [])');
    list(t.requires, NAME, `${t.id}: requires`);
    if (typeof t.operator_only !== 'boolean' || typeof t.expedite !== 'boolean') fail(`${t.id}`, 'operator_only and expedite are booleans');
    for (const k of ['depends_on', 'blocked_by'] as const) {
      if (!isObjArr(t[k], DEP_MAX)) fail(`${t.id}.${k}`, `must be a list of at most ${DEP_MAX}`);
      list(t[k], ID, `${t.id}: ${k}`);
    }
    if (!isObjArr(t.repos, 64)) fail(`${t.id}.repos`, 'must be a list of at most 64');
    list(t.repos, REPO, `${t.id}: repos`);
    if (t.rank != null && !(Number.isSafeInteger(t.rank) && t.rank >= 0)) fail(`${t.id}.rank`, 'must be a non-negative integer');
    if (t.display !== undefined) {
      if (!isObj(t.display)) fail(`${t.id}.display`, 'must be an object');
      for (const [k, v] of Object.entries(t.display)) {
        if (!['status', 'group', 'project'].includes(k) || (v != null && (typeof v !== 'string' || !TEXT.test(v) || v.length > 64))) fail(`${t.id}.display.${k}`, 'must be status, group or project, short plain text');
      }
    }
  }
  if (p.closed !== undefined) {
    if (!isObjArr(p.closed, TICKETS_MAX)) fail('closed', `must be a list of at most ${TICKETS_MAX}`);
    for (const [i, c] of p.closed.entries()) {
      if (!isObj(c) || typeof c.id !== 'string' || !ID.test(c.id) || (c.as !== 'done' && c.as !== 'withdrawn')) fail(`closed[${i}]`, "must be {id, as: 'done' | 'withdrawn'}");
      if (seen.has(c.id)) fail(`closed[${i}]`, `${c.id} is also live`);
    }
  }
  if (p.stations !== undefined) {
    if (!isObj(p.stations) || Object.keys(p.stations).length > TICKETS_MAX) fail('stations', 'must be an object of local ids');
    for (const [id, st] of Object.entries(p.stations)) {
      const at = `stations.${id}`;
      if (!seen.has(id)) fail(at, `${id} is not in tickets`);
      if (!isObj(st) || typeof st.station !== 'string' || !LEG_ID.test(st.station)) fail(`${at}.station`, 'must be a station id');
      if (!isObjArr(st.path, PATH_MAX)) fail(`${at}.path`, `must be a list of at most ${PATH_MAX} steps`);
      for (const [j, step] of st.path.entries()) {
        if (!isObj(step) || typeof step.leg !== 'string' || !LEG_ID.test(step.leg) || typeof step.reached !== 'string' || !LEG_ID.test(step.reached)) fail(`${at}.path[${j}]`, 'must be {leg, reached}');
      }
      if (st.next_leg !== null && (typeof st.next_leg !== 'string' || !LEG_ID.test(st.next_leg))) fail(`${at}.next_leg`, 'must be a leg id or null');
      if (!['course', 'marker', 'inferred', 'holder'].includes(st.next_source)) fail(`${at}.next_source`, 'must be course, marker, inferred or holder');
      if (st.handoff_url != null && !(typeof st.handoff_url === 'string' && st.handoff_url.length <= 1000 && st.handoff_url.startsWith('https://') && !/[\s\u0000-\u001f\u007f]/.test(st.handoff_url))) fail(`${at}.handoff_url`, 'must be an https URL of at most 1000 characters');
      if (!isObjArr(st.next, NEXT_MAX)) fail(`${at}.next`, `must be a list of at most ${NEXT_MAX}`);
      const legs = new Set<string>();
      for (const [j, n] of st.next.entries()) {
        if (!isObj(n) || typeof n.leg !== 'string' || !LEG_ID.test(n.leg) || (n.state !== 'ready' && n.state !== 'waiting')) fail(`${at}.next[${j}]`, "must be {leg, state: 'ready' | 'waiting'}");
        if (n.waiting_on != null && (typeof n.waiting_on !== 'string' || !WAITING_ON.test(n.waiting_on))) fail(`${at}.next[${j}].waiting_on`, 'must be a short label');
        if (legs.has(n.leg)) fail(`${at}.next[${j}]`, `${n.leg} appears twice`);
        legs.add(n.leg);
      }
      if (!isObj(st.bars) || Object.keys(st.bars).length > BARS_MAX) fail(`${at}.bars`, `must map at most ${BARS_MAX} legs to tags`);
      for (const [leg, tags] of Object.entries(st.bars)) {
        if (!LEG_ID.test(leg) || !isObjArr(tags, BARS_MAX) || !(tags as unknown[]).every((t) => typeof t === 'string' && TAG.test(t))) fail(`${at}.bars.${leg}`, `must be a list of at most ${BARS_MAX} tags`);
      }
    }
  }
}

/** A posted station as stored: optional fields filled. */
export function stationOf(st: PostedStation): PostedStation {
  return {
    station: st.station,
    path: st.path.map((s) => ({ leg: s.leg, reached: s.reached })),
    next_leg: st.next_leg,
    next_source: st.next_source,
    handoff_url: st.handoff_url ?? null,
    next: st.next.map((n) => ({ leg: n.leg, state: n.state, waiting_on: n.waiting_on ?? null })),
    bars: Object.fromEntries(Object.entries(st.bars).map(([leg, tags]) => [leg, [...new Set(tags)].sort()])),
  };
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
  if (p.transcript_repos !== undefined && !(Array.isArray(p.transcript_repos) && p.transcript_repos.length <= 20 && p.transcript_repos.every((r) => typeof r === 'string' && parseTranscriptRepo(r) !== null))) {
    bad('transcript_repos', 'must be a list of repositories, each a GitHub owner/name or <forge>:<web_base>');
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
    course_id: it.course ?? DEFAULT_COURSE,
    requires: [...capabilitiesOf(names)].sort(),
    since: calendarDate(it.since),
    holder: typeof it.holder === 'string' && SESSION_NAME.test(it.holder) ? it.holder : null,
    expedite: it.queue === 'expedite' ? 1 : 0,
    display: null,
  };
}

/** The row a normative ticket becomes (§7.1, R-BTN-33). Its factory-state fields — status, node,
 *  queue, tags — are docs' interim vocabulary and stay empty: `display` carries what is shown, and
 *  nothing reads it. `requires` arrives expanded; `[]` is no requirement. */
export function rowForTicket(t: PostedTicket): TicketRow {
  const names = [...new Set(t.requires)];
  return {
    id: t.id,
    path: t.path,
    title: t.title,
    project: t.display?.project ?? null,
    status: '',
    node: '',
    queue: '',
    tags: '[]',
    tier: t.tier ?? null,
    requires_clause: names.length ? 'listed' : 'none',
    operator_only: t.operator_only ? 1 : 0,
    depends_on: JSON.stringify(t.depends_on),
    blocked_by: JSON.stringify(t.blocked_by),
    repos: JSON.stringify(t.repos),
    ord: null,
    rank: t.rank ?? null,
    course_id: t.course_id,
    requires: [...capabilitiesOf(names)].sort(),
    since: null,
    holder: null,
    expedite: t.expedite ? 1 : 0,
    display: t.display ? JSON.stringify(t.display) : null,
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
