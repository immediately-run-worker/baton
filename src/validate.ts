// validate.ts — every rule for untrusted worker and owner input (BATON_SPEC §10.4, §6.8, §6.9,
// §5). One module, called by every endpoint before any write (R3-1211); a value that fails is
// refused with `invalid-params` naming the field, never trimmed into shape.
import { BatonError } from './http';

/** §5: the harness's own session id, the rule `claim.sh --session` already applies. */
export const SESSION_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;
export const HOSTNAME = /^[A-Za-z0-9.-]{1,253}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const ITEM_ID = /^R3-[A-Za-z0-9.-]{1,32}$/;
const ACCOUNT = /^[a-z0-9_]{1,64}$/;
const PREFIX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODEL = /^[A-Za-z0-9._/:-]{1,200}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTIVITY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** §10.4: the PR URLs an activity's detail may carry. */
export const PR_URL = /^https:\/\/github\.com\/immediately-run\/[A-Za-z0-9._-]+\/pull\/\d+$/;
/** §6.8: a transcript path — no `..` segment is checked separately. */
const TRANSCRIPT_PATH = /^[A-Za-z0-9._/-]{1,256}$/;

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
export function freeText(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || /[\u0000-\u001f\u007f<>{}]/.test(v)) {
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
  tier_ceiling: (typeof TIERS)[number];
  lease_timeout_s: number;
  skills_version: number;
  last_activity_at?: number;
  test_harness: boolean;
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
  const tier = b.tier_ceiling ?? 'critical'; // absent ⇒ every tier (§5)
  if (!TIERS.includes(tier as never)) bad('tier_ceiling', `must be one of ${TIERS.join(', ')}`);
  if (!isInt(b.skills_version) || (b.skills_version as number) < 0) bad('skills_version', 'must be a non-negative integer');
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
    tier_ceiling: tier as Heartbeat['tier_ceiling'],
    lease_timeout_s: clampLease(b.lease_timeout_s),
    skills_version: b.skills_version as number,
    last_activity_at: b.last_activity_at as number | undefined,
    test_harness: b.test_harness === true,
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
    if (type === PR && (typeof v !== 'string' || !PR_URL.test(v))) bad(`${field}.${k}`, 'must be an immediately-run pull request URL');
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
  if (!isObj(p)) bad('payload', 'a release names {work_item_id, reason}');
  const x = p as Record<string, unknown>;
  const work_item_id = matches(ITEM_ID, 'payload.work_item_id')(x.work_item_id);
  if (!RELEASE_REASONS.includes(x.reason as never)) bad('payload.reason', `must be one of ${RELEASE_REASONS.join(', ')}`);
  return { to_worker_id: b.to_worker_id as number, kind: 'release', payload: { work_item_id, reason: x.reason } };
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
    work_item_id: matches(ITEM_ID, 'work_item_id')(b.work_item_id),
    status: matches(NAME, 'status')(b.status),
    // `claim.sh claim` writes the nonce; a later `set` may not know it.
    nonce: b.transition === 'claim' ? matches(/^[0-9a-f]{6}$/, 'nonce')(b.nonce) : optional(b.nonce, matches(/^[0-9a-f]{6}$/, 'nonce')),
    at: isTime(b.at) ? (b.at as number) : bad('at', 'must be epoch ms'),
  };
}
