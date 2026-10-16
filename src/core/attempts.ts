// attempts.ts — the retry policy (BATON_SPEC §6.10 R-BTN-23; R3-1217). Pure: Claims reads the rows
// and applies the answer.

export const HOUR = 3_600_000;
/** R-BTN-23: the backoff after the first and the second failed attempt. */
export const BACKOFF_MS = [1 * HOUR, 4 * HOUR] as const;
/** R-BTN-23: the failed attempt that holds the item `attempts-exhausted`. */
export const ATTEMPTS_HOLD_AT = 3;

/**
 * §6.10: whether an end counts as a failed attempt. A reap by the alarm for silence, any
 * `cannot-finish`, and `lease-lost` once per distinct worker (`leaseLostBefore`: this worker
 * already has a counted lease-lost on the item since the last hold-lift). Nothing else — not an
 * owner's force-reap, the unacknowledged-release reap, a legacy reap, nor stale-board,
 * requested, owner-cancel, provider-suspended, provider-exhausted, course-changed or any
 * completion, suspensions included.
 */
export function countsAsFailed(endReason: string, leaseLostBefore = false): boolean {
  if (endReason === 'reaped:silent') return true;
  if (endReason.startsWith('released:cannot-finish:')) return true;
  if (endReason === 'released:lease-lost') return !leaseLostBefore;
  return false;
}

/** §6.10: `capability` and `spec` are non-retryable — another claimant would hit the same wall. */
export function nonRetryableClass(endReason: string): 'capability' | 'spec' | null {
  if (endReason === 'released:cannot-finish:capability') return 'capability';
  if (endReason === 'released:cannot-finish:spec') return 'spec';
  return null;
}

/** R-BTN-23: what follows the `count`-th failed attempt since the last hold-lift — by the
 *  repository's owners' `retry` setting where they set one (R-BTN-66), else 1 h, 4 h and a hold at
 *  the third. Past the listed backoffs the last one repeats until the hold. */
export function afterFailure(count: number, policy: { backoff_ms: number[]; max_failed: number } | null = null): { hold: 'attempts-exhausted' } | { retryAfterMs: number } | null {
  const holdAt = policy?.max_failed ?? ATTEMPTS_HOLD_AT;
  const backoff = policy?.backoff_ms ?? BACKOFF_MS;
  if (count >= holdAt) return { hold: 'attempts-exhausted' };
  if (count >= 1) return backoff.length ? { retryAfterMs: backoff[Math.min(count, backoff.length) - 1] } : null;
  return null;
}

export interface ResumeActivity {
  kind: string;
  seq: number | null;
  label: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  detail_json: string | null;
}

/**
 * R-BTN-24: the resume record of a claim that ended other than completed, from its activities —
 * the branches and PRs its `push` and `open-pr` activities recorded, the review rounds reached
 * with their open-finding counts, the last activity and its outcome, the end reason, and the
 * transcript pointers. Nothing is taken from the item's body (R-BTN-33).
 */
export function resumeRecord(endReason: string, endedAt: number, activities: ResumeActivity[], transcripts: { repo: string; path: string; role: string }[]) {
  const detail = (a: ResumeActivity): Record<string, unknown> => {
    try {
      return a.detail_json ? JSON.parse(a.detail_json) : {};
    } catch {
      return {};
    }
  };
  const branches = new Set<string>();
  const prs = new Set<string>();
  const rounds: { seq: number | null; findings: unknown; blocking: unknown; should_fix: unknown; nit: unknown; outcome: string | null }[] = [];
  for (const a of activities) {
    const d = detail(a);
    if (a.kind === 'push' && typeof d.branch === 'string') branches.add(d.branch);
    if (typeof d.pr === 'string') prs.add(d.pr);
    if (a.kind === 'review-round') {
      rounds.push({ seq: a.seq, findings: d.findings ?? null, blocking: d.blocking ?? null, should_fix: d.should_fix ?? null, nit: d.nit ?? null, outcome: a.outcome });
    }
  }
  const last = [...activities].sort((x, y) => x.started_at - y.started_at).at(-1) ?? null;
  return {
    end_reason: endReason,
    ended_at: endedAt,
    branches: [...branches],
    prs: [...prs],
    review_rounds: rounds,
    last_activity: last ? { kind: last.kind, label: last.label, outcome: last.outcome, started_at: last.started_at, ended_at: last.ended_at } : null,
    transcripts,
  };
}
