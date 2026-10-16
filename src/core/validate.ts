// validate.ts — every rule for untrusted worker and owner input (BATON_SPEC §10.4, §6.8, §6.9,
// §5). One module, called by every endpoint before any write (R3-1211); a value that fails is
// refused with `invalid-params` naming the field, never trimmed into shape.
import { BatonError } from './http';
import { FREE_TEXT_MAX, isFreeText } from './text';
import { COURSE_ID } from './course';

/** §5: the harness's own session id, the rule `claim.sh --session` already applies. */
export const SESSION_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
// The id forms of R-BTN-47, each spelled once.
const REPOSITORY_SRC = '[a-z][a-z0-9-]{0,39}';
const LOCAL_SRC = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
/** A registered repository's id: `docs`. No colon, so a qualified id splits at its first. */
export const REPOSITORY_ID = new RegExp(`^${REPOSITORY_SRC}$`);
/** A course id (R-BTN-48), the form course files give their stations and legs (R-BTN-69); a
 *  §6.9 step kind has the same form (R-BTN-50). Spelled once, in the pure course.ts. */
export { COURSE_ID };
/** A GitHub repository, `owner/name` (R-BTN-47), and a branch name as a push names it (§6.3). */
export const GIT_REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
/** What `git check-ref-format --branch` allows, in short: no control, space, `~ ^ : ? * [ \`,
 *  no `..` or `@{`, at most 255 characters. A legal branch the hook asks about is never refused. */
export const GIT_BRANCH = /^(?!.*\.\.)(?!.*@\{)(?![/.])(?!.*[/.]$)[^\u0000-\u0020\u007f~^:?*[\\]{1,255}$/;
/** Repositories one heartbeat may name a tier ceiling for (spec-silent, recorded on R3-1231). */
export const TIER_CEILINGS_MAX = 64;
/** A course's `version` and a worker's declared one: non-negative, at most this. */
export const COURSE_VERSION_MAX = 1_000_000_000;
/** Courses in one registry, and courses one heartbeat declares (spec-silent, recorded on R3-1231). */
export const COURSES_MAX = 64;
/** A ticket's id in its home repository, as git writes it: `R3-1205` (R-BTN-47). */
export const LOCAL_ID = new RegExp(`^${LOCAL_SRC}$`);
/** A ticket's qualified id, `<repository>:<local>`: what Baton's API, events and dashboard use. */
export const TICKET_ID = new RegExp(`^(${REPOSITORY_SRC}):(${LOCAL_SRC})$`);
/** A qualified ticket id and its two halves. Every caller holds an id `TICKET_ID` accepted. */
export const qualify = (repository: string, local: string) => `${repository}:${local}`;
export const repositoryOf = (ticketId: string) => ticketId.slice(0, ticketId.indexOf(':'));
export const localOf = (ticketId: string) => ticketId.slice(ticketId.indexOf(':') + 1);

/** A repository named by a worker or the owner (`?repository=`, a cutover, a held accept). */
export function checkRepositoryId(v: unknown, field = 'repository'): string {
  if (typeof v !== 'string' || !REPOSITORY_ID.test(v)) throw new BatonError('invalid-params', `${field}: must be a repository id`);
  return v;
}
const ACCOUNT = /^[a-z0-9_]{1,64}$/;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL = /^[A-Za-z0-9._/:-]{1,200}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTIVITY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** §6.8: a transcript path — no `..` segment is checked separately. */
const TRANSCRIPT_PATH = /^[A-Za-z0-9._/-]{1,256}$/;

/** R-BTN-60: a tag — a short course-defined string (`family:glm`, `model:opencode-go/qwen3.8-max`)
 *  core compares and never reads; the same form wherever one is posted, declared or barred. */
export const TAG = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** Tags one heartbeat declares, or one advance bars (spec-silent, recorded on R3-1232). */
export const TAGS_MAX = 64;

export const ACTIVITY_KINDS = ['orient', 'implement', 'local-verify', 'open-pr', 'push', 'ci-wait', 'review-round', 'reviewer',
  'fix-findings', 'adjudicate', 'merge', 'reconcile', 'status-write', 'decision-packet', 'other'] as const;
export const OUTCOMES = ['succeeded', 'failed', 'cancelled', 'abandoned'] as const;
export const TIERS = ['routine', 'judgement', 'critical'] as const;

export const bad = (field: string, why: string): never => {
  throw new BatonError('invalid-params', `${field}: ${why}`);
};
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown) => Number.isInteger(v);
const isTime = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

/** §10.4's free text: at most 500 characters, no control characters, none of `< > { }`. */
export function freeText(v: unknown, field: string, max = FREE_TEXT_MAX): string {
  if (!isFreeText(v, max)) {
    bad(field, `must be 1–${max} characters with no control characters and none of < > { }`);
  }
  return v as string;
}

const optional = <T>(v: unknown, check: (v: unknown) => T): T | undefined => (v === undefined || v === null ? undefined : check(v));
const matches = (re: RegExp, field: string) => (v: unknown) => (typeof v === 'string' && re.test(v) ? v : bad(field, `must match ${re}`));

// ── the heartbeat (§11) ──────────────────────────────────────────────────────────────────

export interface Heartbeat {
  hostname: string;
  session_name: string;
  secret_hash?: string;
  rekey?: boolean;
  harness: 'opencode' | 'claude-code';
  kind: 'vm' | 'local' | 'cloud';
  model_id?: string;
  model_provider_id?: string;
  billing: Record<string, string>;
  capabilities: string[];
  /** R-BTN-60: course-defined strings the tag gate matches. */
  tags: string[];
  tier_ceiling: (typeof TIERS)[number];
  /** Per repository (R-BTN-66): `{repository: tier}`, checked against each ladder at the heartbeat. */
  tier_ceilings: Record<string, string>;
  lease_timeout_s: number;
  /** The courses the worker's checkouts run, at their versions (R-BTN-22, R-BTN-48): rule 9. */
  courses: { repository: string; course: string; version: number }[];
  last_activity_at?: number;
  test_harness: boolean;
  fenced?: { claim_id: number };
  transcripts: TranscriptReport[];
  usage: { provider_id: string; model_id: string; hour: number; usd_list: number }[];
  rate_limits: { provider_id: string; model_id?: string; resets_at?: number }[];
  transcript_refusals: { index: number; code: string; message: string }[];
}

export interface TranscriptReport { index?: number; repo: string; path: string; role: 'session' | 'subagent'; activity_id?: string; pushed_at?: number }

/** §6.6 R-BTN-9: the worker declares its lease timeout, clamped to [900, 86400] s, default 900. */
export const clampLease = (s: unknown) => (typeof s === 'number' && Number.isFinite(s) ? Math.min(86400, Math.max(900, Math.round(s))) : 900);

export function checkHeartbeat(body: unknown, transcriptRepos: string[]): Heartbeat {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  const hostname = matches(HOSTNAME, 'hostname')(b.hostname);
  const session_name = matches(SESSION_NAME, 'session_name')(b.session_name);
  const secret_hash = optional(b.secret_hash, matches(SHA256_HEX, 'secret_hash'));
  if (b.rekey !== undefined && typeof b.rekey !== 'boolean') bad('rekey', 'must be a boolean');
  if (b.harness !== 'opencode' && b.harness !== 'claude-code') bad('harness', "must be 'opencode' or 'claude-code'");
  if (b.kind !== 'vm' && b.kind !== 'local' && b.kind !== 'cloud') bad('kind', "must be 'vm', 'local' or 'cloud'");
  const model_id = optional(b.model_id, matches(MODEL, 'model_id'));
  const model_provider_id = optional(b.model_provider_id, matches(ACCOUNT, 'model_provider_id'));
  if (!isObj(b.billing)) bad('billing', 'must map provider prefixes to accounts');
  const billing: Record<string, string> = {};
  for (const [prefix, account] of Object.entries(b.billing as object)) {
    matches(PREFIX, `billing prefix ${prefix}`)(prefix);
    billing[prefix] = matches(ACCOUNT, `billing.${prefix}`)(account);
  }
  if (!Array.isArray(b.capabilities) || !b.capabilities.every((c) => typeof c === 'string' && NAME.test(c))) bad('capabilities', 'must be a list of capability or role names');
  const capabilities = [...new Set(b.capabilities as string[])];
  const rawTags = b.tags ?? [];
  if (!Array.isArray(rawTags) || rawTags.length > TAGS_MAX || !rawTags.every((t) => typeof t === 'string' && TAG.test(t))) bad('tags', `must be a list of at most ${TAGS_MAX} tags`);
  const tags = [...new Set(rawTags as string[])];
  const tier = b.tier_ceiling ?? 'critical'; // absent ⇒ every tier (§5)
  if (!TIERS.includes(tier as never)) bad('tier_ceiling', `must be one of ${TIERS.join(', ')}`);
  // R-BTN-22: the skills version is each course's version, declared per course; a sidecar that
  // still sends `skills_version` is not refused for it.
  const rawCourses = b.courses ?? [];
  if (!Array.isArray(rawCourses) || rawCourses.length > COURSES_MAX) bad('courses', `must be a list of at most ${COURSES_MAX}`);
  const declaredCourses = new Set<string>();
  const courses = (rawCourses as unknown[]).map((c, i) => {
    if (!isObj(c)) bad(`courses[${i}]`, 'must be an object');
    const x = c as Record<string, unknown>;
    const repository = checkRepositoryId(x.repository, `courses[${i}].repository`);
    const course = matches(COURSE_ID, `courses[${i}].course`)(x.course);
    if (!isInt(x.version) || (x.version as number) < 0 || (x.version as number) > COURSE_VERSION_MAX) bad(`courses[${i}].version`, 'must be a non-negative integer');
    if (declaredCourses.has(`${repository}:${course}`)) bad(`courses[${i}]`, `repeats ${repository}:${course}`);
    declaredCourses.add(`${repository}:${course}`);
    return { repository, course, version: x.version as number };
  });
  if (b.last_activity_at !== undefined && !isTime(b.last_activity_at)) bad('last_activity_at', 'must be epoch ms');
  if (b.test_harness !== undefined && typeof b.test_harness !== 'boolean') bad('test_harness', 'must be a boolean');
  const transcripts = (b.transcripts ?? []) as unknown[];
  if (!Array.isArray(transcripts) || transcripts.length > 50) bad('transcripts', 'must be a list of at most 50');
  const usage = (b.usage ?? []) as unknown[];
  if (!Array.isArray(usage) || usage.length > 100) bad('usage', 'must be a list of at most 100');
  const rate_limits = (b.rate_limits ?? []) as unknown[];
  if (!Array.isArray(rate_limits) || rate_limits.length > 50) bad('rate_limits', 'must be a list of at most 50');
  return {
    hostname,
    session_name,
    secret_hash,
    rekey: b.rekey === true,
    harness: b.harness as Heartbeat['harness'],
    kind: b.kind as Heartbeat['kind'],
    model_id,
    model_provider_id,
    billing,
    capabilities,
    tags,
    tier_ceiling: tier as Heartbeat['tier_ceiling'],
    tier_ceilings: checkTierCeilings(b.tier_ceilings),
    lease_timeout_s: clampLease(b.lease_timeout_s),
    courses,
    last_activity_at: b.last_activity_at as number | undefined,
    test_harness: b.test_harness === true,
    fenced: checkFenced(b.fenced),
    // One bad pointer is refused on its own and reported, never the heartbeat (§6.8): a failed
    // heartbeat would stop last_seen_at and get a live worker reaped.
    ...splitTranscripts(transcripts, transcriptRepos),
    usage: usage.map((u, i) => {
      if (!isObj(u)) bad(`usage[${i}]`, 'must be an object');
      const x = u as Record<string, unknown>;
      if (!isTime(x.hour) || (x.hour as number) % 3_600_000 !== 0) bad(`usage[${i}].hour`, 'must be the start of a UTC hour in epoch ms');
      if (typeof x.usd_list !== 'number' || !Number.isFinite(x.usd_list) || x.usd_list < 0) bad(`usage[${i}].usd_list`, 'must be a non-negative number');
      return { provider_id: matches(ACCOUNT, `usage[${i}].provider_id`)(x.provider_id), model_id: matches(MODEL, `usage[${i}].model_id`)(x.model_id), hour: x.hour as number, usd_list: x.usd_list as number };
    }),
    rate_limits: rate_limits.map((r, i) => {
      if (!isObj(r)) bad(`rate_limits[${i}]`, 'must be an object');
      const x = r as Record<string, unknown>;
      if (x.resets_at !== undefined && !isTime(x.resets_at)) bad(`rate_limits[${i}].resets_at`, 'must be epoch ms');
      return { provider_id: matches(ACCOUNT, `rate_limits[${i}].provider_id`)(x.provider_id), model_id: optional(x.model_id, matches(MODEL, `rate_limits[${i}].model_id`)), resets_at: x.resets_at as number | undefined };
    }),
  };
}

/** A tier name, as a repository's ladder spells it (R-BTN-66). */
export const TIER_NAME = /^[a-z][a-z0-9-]{0,39}$/;

function checkTierCeilings(v: unknown): Record<string, string> {
  if (v === undefined) return {};
  if (!isObj(v) || Object.keys(v).length > TIER_CEILINGS_MAX) bad('tier_ceilings', `must map at most ${TIER_CEILINGS_MAX} repositories to a tier`);
  const out: Record<string, string> = {};
  for (const [repo, tier] of Object.entries(v as object)) {
    out[checkRepositoryId(repo, `tier_ceilings key ${repo}`)] = matches(TIER_NAME, `tier_ceilings.${repo}`)(tier);
  }
  return out;
}

function splitTranscripts(list: unknown[], allowed: string[]) {
  const ok: TranscriptReport[] = [];
  const transcript_refusals: { index: number; code: string; message: string }[] = [];
  list.forEach((t, i) => {
    try {
      ok.push({ ...checkTranscript(t, `transcripts[${i}]`, allowed), index: i });
    } catch (e) {
      if (!(e instanceof BatonError)) throw e;
      transcript_refusals.push({ index: i, code: e.code, message: e.message });
    }
  });
  return { transcripts: ok, transcript_refusals };
}

/** §9: an acknowledgement's optional reply — `{text}`, free text (§10.4). */
export function checkAck(body: unknown): { text: string | null } | null {
  if (body === null || body === undefined) return null;
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const reply = (body as Record<string, unknown>).reply;
  if (reply === undefined || reply === null) return null;
  if (!isObj(reply)) bad('reply', 'must be an object');
  const text = (reply as Record<string, unknown>).text;
  return { text: text === undefined || text === null ? null : freeText(text, 'reply.text') };
}

/** §6.8: a transcript pointer — an allow-listed repo and a safe path with no `..` segment. */
export function checkTranscript(t: unknown, field: string, allowed: string[]): TranscriptReport {
  if (!isObj(t)) bad(field, 'must be an object');
  const x = t as Record<string, unknown>;
  if (typeof x.repo !== 'string' || !allowed.includes(x.repo)) bad(`${field}.repo`, `must be one of ${allowed.join(', ')}`);
  if (typeof x.path !== 'string' || !TRANSCRIPT_PATH.test(x.path) || x.path.split('/').some((seg) => seg === '..' || seg === '')) {
    bad(`${field}.path`, 'must be a relative path of [A-Za-z0-9._/-] with no empty or .. segment');
  }
  const role = x.role ?? 'session';
  if (role !== 'session' && role !== 'subagent') bad(`${field}.role`, "must be 'session' or 'subagent'");
  if (x.pushed_at !== undefined && !isTime(x.pushed_at)) bad(`${field}.pushed_at`, 'must be epoch ms');
  return { repo: x.repo as string, path: x.path as string, role: role as TranscriptReport['role'], activity_id: optional(x.activity_id, matches(ACTIVITY_ID, `${field}.activity_id`)), pushed_at: x.pushed_at as number | undefined };
}

// ── activities (§6.9) ────────────────────────────────────────────────────────────────────

export interface ActivityReport {
  id: string;
  claim_id: number | null;
  parent_id?: string;
  call_id?: string;
  kind: (typeof ACTIVITY_KINDS)[number];
  seq?: number;
  label?: string;
  source: 'skill' | 'hook';
  started_at: number;
  ended_at?: number;
  outcome?: (typeof OUTCOMES)[number];
  detail?: Record<string, unknown>;
}

const NUM = 'number';
const BOOL = 'boolean';
const PR = 'pr';
const TEXT = 'text';
type FieldType = typeof NUM | typeof BOOL | typeof PR | typeof TEXT;
const COMMON: Record<string, FieldType> = { pr: PR, exit_code: NUM, note: TEXT };
/** §10.4: per kind, the detail keys allowed and their types; any other key is refused. */
export const DETAIL_SCHEMAS: Record<string, Record<string, FieldType>> = {
  orient: { ...COMMON },
  implement: { ...COMMON },
  'local-verify': { ...COMMON, passed: BOOL },
  'open-pr': { ...COMMON },
  push: { ...COMMON, branch: TEXT, sha: TEXT },
  'ci-wait': { ...COMMON, conclusion: TEXT },
  'review-round': { ...COMMON, findings: NUM, blocking: NUM, should_fix: NUM, nit: NUM },
  reviewer: { ...COMMON, agent: TEXT, model: TEXT, substituted_for: TEXT, findings: NUM, blocking: NUM },
  'fix-findings': { ...COMMON, fixed: NUM, argued: NUM },
  adjudicate: { ...COMMON, reproduced: BOOL },
  merge: { ...COMMON, sha: TEXT },
  reconcile: { ...COMMON, archived: NUM },
  'status-write': { ...COMMON, status: TEXT, item: TEXT },
  'decision-packet': { ...COMMON, item: TEXT },
  other: { ...COMMON },
};

export function checkDetail(kind: string, detail: unknown, field: string): Record<string, unknown> | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (!isObj(detail)) bad(field, 'must be an object');
  if (JSON.stringify(detail).length > 2048) bad(field, 'is over 2 KB');
  const schema = DETAIL_SCHEMAS[kind];
  for (const [k, v] of Object.entries(detail as object)) {
    const type = schema[k];
    if (!type) bad(`${field}.${k}`, `is not a ${kind} detail key (${Object.keys(schema).join(', ')})`);
    if (type === NUM && (typeof v !== 'number' || !Number.isFinite(v))) bad(`${field}.${k}`, 'must be a number');
    if (type === BOOL && typeof v !== 'boolean') bad(`${field}.${k}`, 'must be a boolean');
    // The shape here; whose pull request it is — the claim's home repository or one of its
    // `repos:`, by R-BTN-92's link rule — is checked where the claim is known (WorkerApi).
    if (type === PR && (typeof v !== 'string' || v.length > 1000 || !v.startsWith('https://'))) bad(`${field}.${k}`, 'must be a pull request URL');
    if (type === TEXT) freeText(v, `${field}.${k}`, 200);
  }
  return detail as Record<string, unknown>;
}

export function checkActivity(a: unknown, field: string): ActivityReport {
  if (!isObj(a)) bad(field, 'must be an object');
  const x = a as Record<string, unknown>;
  const id = matches(ACTIVITY_ID, `${field}.id`)(x.id);
  if (!ACTIVITY_KINDS.includes(x.kind as never)) bad(`${field}.kind`, `must be one of ${ACTIVITY_KINDS.join(', ')}`);
  const kind = x.kind as ActivityReport['kind'];
  if (x.source !== 'skill' && x.source !== 'hook') bad(`${field}.source`, "must be 'skill' or 'hook'");
  const claim_id = x.claim_id ?? null;
  if (claim_id !== null && (!isInt(claim_id) || (claim_id as number) <= 0)) bad(`${field}.claim_id`, 'must be a claim id or null');
  if (claim_id === null && kind !== 'orient') bad(`${field}.claim_id`, "is required for every kind but 'orient'");
  if (!isTime(x.started_at)) bad(`${field}.started_at`, 'must be epoch ms');
  if ((x.ended_at === undefined) !== (x.outcome === undefined)) bad(`${field}`, 'ended_at and outcome come together');
  if (x.ended_at !== undefined && !isTime(x.ended_at)) bad(`${field}.ended_at`, 'must be epoch ms');
  if (x.outcome !== undefined && !OUTCOMES.includes(x.outcome as never)) bad(`${field}.outcome`, `must be one of ${OUTCOMES.join(', ')}`);
  if (x.seq !== undefined && (!isInt(x.seq) || (x.seq as number) < 1 || (x.seq as number) > 3)) bad(`${field}.seq`, 'must be 1–3');
  return {
    id,
    claim_id: claim_id as number | null,
    parent_id: optional(x.parent_id, matches(ACTIVITY_ID, `${field}.parent_id`)),
    call_id: optional(x.call_id, matches(/^[A-Za-z0-9._:-]{1,128}$/, `${field}.call_id`)),
    kind,
    seq: x.seq as number | undefined,
    label: optional(x.label, (v) => freeText(v, `${field}.label`)),
    source: x.source as ActivityReport['source'],
    started_at: x.started_at as number,
    ended_at: x.ended_at as number | undefined,
    outcome: x.outcome as ActivityReport['outcome'],
    detail: checkDetail(kind, x.detail, `${field}.detail`),
  };
}

// ── owner input (§9, §7.4) ───────────────────────────────────────────────────────────────

export const RELEASE_REASONS = ['requested', 'owner-cancel', 'provider-suspended'] as const;

export function checkMessage(body: unknown): { to_worker_id: number; kind: 'release' | 'status_request'; payload: Record<string, unknown> | null } {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  if (!isInt(b.to_worker_id) || (b.to_worker_id as number) <= 0) bad('to_worker_id', 'must be a worker id');
  if (b.kind === 'status_request') return { to_worker_id: b.to_worker_id as number, kind: 'status_request', payload: null };
  if (b.kind !== 'release') bad('kind', "must be 'release' or 'status_request'");
  const p = b.payload;
  if (!isObj(p)) bad('payload', 'a release names {ticket_id, reason}');
  const x = p as Record<string, unknown>;
  const ticket_id = matches(TICKET_ID, 'payload.ticket_id')(x.ticket_id);
  if (!RELEASE_REASONS.includes(x.reason as never)) bad('payload.reason', `must be one of ${RELEASE_REASONS.join(', ')}`);
  return { to_worker_id: b.to_worker_id as number, kind: 'release', payload: { ticket_id, reason: x.reason } };
}

export function checkSuspension(body: unknown, now: number) {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  const provider_id = matches(ACCOUNT, 'provider_id')(b.provider_id);
  const model_id = optional(b.model_id, matches(MODEL, 'model_id'));
  const mode = b.mode ?? 'no-new-work';
  if (mode !== 'no-new-work' && mode !== 'stop') bad('mode', "must be 'no-new-work' or 'stop'");
  if (b.starts_at !== undefined && !isTime(b.starts_at)) bad('starts_at', 'must be epoch ms');
  const starts_at = (b.starts_at as number | undefined) ?? now;
  if (b.ends_at !== undefined && b.ends_at !== null && (!isTime(b.ends_at) || (b.ends_at as number) <= Math.max(starts_at, now))) {
    bad('ends_at', 'must be epoch ms after starts_at and after now');
  }
  return {
    provider_id,
    model_id: model_id ?? null,
    mode: mode as 'no-new-work' | 'stop',
    starts_at,
    ends_at: (b.ends_at as number | null | undefined) ?? null,
    reason: optional(b.reason, (v) => freeText(v, 'reason')) ?? null,
  };
}

export function checkShadowReport(body: unknown) {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  if (b.transition !== 'claim' && b.transition !== 'set') bad('transition', "must be 'claim' or 'set'");
  return {
    transition: b.transition as 'claim' | 'set',
    ticket_id: matches(TICKET_ID, 'ticket_id')(b.ticket_id),
    status: matches(NAME, 'status')(b.status),
    // `claim.sh claim` writes the nonce; a later `set` may not know it.
    nonce: b.transition === 'claim' ? matches(/^[0-9a-f]{6}$/, 'nonce')(b.nonce) : optional(b.nonce, matches(/^[0-9a-f]{6}$/, 'nonce')),
    at: isTime(b.at) ? (b.at as number) : bad('at', 'must be epoch ms'),
  };
}

// ── claims (§6.2, §6.5, §6.7; R3-1212) ───────────────────────────────────────────────────

const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;
export const GIT_SHA = /^[0-9a-f]{40}$/;
/** §6.5: the `released:` reasons, exactly. */
export const RELEASE_END_REASONS = ['stale-board', 'cannot-finish:transient', 'cannot-finish:capability', 'cannot-finish:spec',
  'lease-lost', 'requested', 'owner-cancel', 'provider-suspended', 'provider-exhausted', 'course-changed'] as const;

export function checkClaim(body: unknown): { request_id: string; ticket_id: string | null } {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  return {
    request_id: matches(REQUEST_ID, 'request_id')(b.request_id),
    ticket_id: optional(b.ticket_id, matches(TICKET_ID, 'ticket_id')) ?? null,
  };
}

/** A URL a worker or sync points at (a hand-off comment, a review): https, at most 1000
 *  characters, no whitespace or control character. Shown as text and linked only through
 *  `httpsLink` (§10.4). */
export const isHttpsPointer = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 1000 && v.startsWith('https://') && !/[\s\u0000-\u001f\u007f]/.test(v);
/** An evidence pointer (R-BTN-8): a commit sha, or the URL of the comment or review that ended
 *  the leg. */
const isPointer = (v: unknown) => typeof v === 'string' && (GIT_SHA.test(v) || isHttpsPointer(v));

export interface End {
  end_reason: string;
  status: 'completed' | 'released';
  /** `suspended:<station>`'s station. */
  suspended_at: string | null;
  reached: string | null;
  next: string | null;
  detail: string | null;
  ended_at_sha: string | null;
  /** `released:<reason>` naming no §6.5 reason: an owner bar's (R-BTN-67), checked by the claims. */
  owner_bar: boolean;
}

/** §6.5's ends: `done`, `suspended:<station>` and `released:<reason>`, each with an optional
 *  course-defined `detail` (§10.4 free text core stores and shows but never reads); `reached`, the
 *  station the claim rests at (R-BTN-71); `next`, the queued leg (R-BTN-83); and an optional
 *  pointer to the evidence, pushed first (R-BTN-8). */
export function checkEnd(body: unknown): End {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  const r = b.end_reason;
  if (typeof r !== 'string') bad('end_reason', 'must be a string');
  const reason = r as string;
  let status: 'completed' | 'released';
  let suspended_at: string | null = null;
  let ownerBar = false;
  if (reason === 'done') {
    status = 'completed';
  } else if (reason.startsWith('suspended:') && COURSE_ID.test(reason.slice(10))) {
    status = 'completed';
    suspended_at = reason.slice(10);
  } else if (reason.startsWith('released:') && RELEASE_END_REASONS.includes(reason.slice(9) as never)) {
    status = 'released';
  } else if (reason.startsWith('released:') && COURSE_ID.test(reason.slice(9)) && !reason.slice(9).startsWith('cannot-finish')) {
    status = 'released';
    ownerBar = true;
  } else {
    bad('end_reason', 'must be done, suspended:<station> or released:<a §6.5 reason>');
  }
  const reached = optional(b.reached, matches(COURSE_ID, 'reached')) ?? null;
  if (suspended_at && reached && reached !== suspended_at) bad('reached', `a suspended:${suspended_at} end rests at ${suspended_at}`);
  const next = optional(b.next, matches(COURSE_ID, 'next')) ?? null;
  const detail = b.detail === undefined || b.detail === null ? null : isFreeText(b.detail, 200) ? (b.detail as string) : bad('detail', 'must be §10.4 free text of at most 200 characters');
  const ptr = b.ended_at_sha;
  if (ptr !== undefined && ptr !== null && !isPointer(ptr)) bad('ended_at_sha', 'must be a commit sha or an https URL of at most 1000 characters');
  const sha = (ptr as string | undefined | null) ?? null;
  if (status! === 'released' && sha) bad('ended_at_sha', 'only a completed end points at its evidence');
  return { end_reason: reason, status: status!, suspended_at, reached: reached ?? suspended_at, next, detail, ended_at_sha: sha, owner_bar: ownerBar };
}

export interface Advance {
  leg: string;
  reached: string | null;
  evidence: string | null;
  bars: string[];
}

/** `POST /v1/runner/claims/{id}/advance` (R-BTN-63, §11): the leg to start; `reached`, the
 *  outcome the running leg reached; a pointer to its evidence; the tags the holder bars from the
 *  new leg. `course` is opaque data for the course's hook (R3-1236): accepted, bounded, unread. */
export function checkAdvance(body: unknown): Advance {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  const leg = matches(COURSE_ID, 'leg')(b.leg);
  const reached = optional(b.reached, matches(COURSE_ID, 'reached')) ?? null;
  const evidence = b.evidence === undefined || b.evidence === null ? null : isPointer(b.evidence) ? (b.evidence as string) : bad('evidence', 'must be a commit sha or an https URL of at most 1000 characters');
  const raw = b.bars ?? [];
  if (!Array.isArray(raw) || raw.length > TAGS_MAX || !raw.every((t) => typeof t === 'string' && TAG.test(t))) bad('bars', `must be a list of at most ${TAGS_MAX} tags`);
  if (b.course !== undefined && JSON.stringify(b.course).length > 4096) bad('course', 'must be at most 4 KB');
  return { leg, reached, evidence, bars: [...new Set(raw as string[])] };
}

/** §6.7: the sync's confirmations, `[{claim_id, sha}]`. */
export function checkConfirmations(v: unknown): { claim_id: number; sha: string }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 500) bad('confirmations', 'must be a list of at most 500');
  return (v as unknown[]).map((c, i) => {
    if (!isObj(c) || !isInt(c.claim_id)) bad(`confirmations[${i}]`, 'must be {claim_id, sha}');
    return { claim_id: (c as Record<string, unknown>).claim_id as number, sha: matches(GIT_SHA, `confirmations[${i}].sha`)((c as Record<string, unknown>).sha) };
  });
}

/** R-BTN-19: the heartbeat's report that the sidecar has fenced a reaped claim. */
export function checkFenced(v: unknown): { claim_id: number } | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v) || !isInt(v.claim_id) || v.terminated !== true) bad('fenced', 'must be {claim_id, terminated: true}');
  return { claim_id: (v as Record<string, unknown>).claim_id as number };
}

/** An owner action that names its own confirmation (§14: force-reap). */
export function checkConfirm(body: unknown): void {
  if (!isObj(body) || body.confirm !== true) bad('confirm', 'must be true');
}

export function checkAccept(body: unknown): { repository: string; sha: string } {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  return { repository: checkRepositoryId(b.repository), sha: matches(GIT_SHA, 'sha')(b.sha) };
}

/** §6.7: the owner's resolution of an unconfirmed completion. */
export function checkResolve(body: unknown): { action: 'confirm' | 'release' } {
  if (!isObj(body) || (body.action !== 'confirm' && body.action !== 'release') || body.confirm !== true) {
    bad('body', "must be {action: 'confirm' | 'release', confirm: true}");
  }
  return { action: (body as Record<string, unknown>).action as 'confirm' | 'release' };
}

/** §8, §11: `{expedite?, hold?}` — booleans, at least one. */
export function checkOverride(body: unknown): { expedite?: boolean; hold?: boolean } {
  if (!isObj(body)) bad('body', 'must be a JSON object');
  const b = body as Record<string, unknown>;
  for (const k of ['expedite', 'hold']) if (b[k] !== undefined && typeof b[k] !== 'boolean') bad(k, 'must be a boolean');
  if (b.expedite === undefined && b.hold === undefined) bad('body', 'names expedite or hold');
  return { expedite: b.expedite as boolean | undefined, hold: b.hold as boolean | undefined };
}
