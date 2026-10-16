// gates.ts — what stays a gate (BATON_SPEC §7.2, R-BTN-45): the rules refused at a claim and at an
// advance whatever the worker decides, in one pure function. The matching query (claims.ts) is
// its mirror, and G-BTN-40 checks the two against each other. Everything else Baton says about
// scheduling — the order, the expedite lane's bound, a course's advice — is advice and never
// refuses (`advice-overridden`). No rule reads what a leg, a station or a tag means.
import { capabilitiesOf, fitsTier } from '../shared/vocabulary.mjs';

/** Who asks: the worker as its heartbeat declared it (§5, R-BTN-60). */
export interface GateWorker {
  /** Capability and role names as declared. */
  declared: string[];
  /** Its ceiling in the ticket's repository's ladder, resolved by the caller (R-BTN-66). */
  tier_ceiling: string;
  tags: string[];
  courses: { repository: string; course: string; version: number }[];
  /** R-BTN-58: the key's grants by repository, each with the capabilities it may use there; null
   *  for a key no owner or administrator granted — a bearer token or a BATON_KEYS seed key, which
   *  keep their interim reach until the seed retires (spec-silent, recorded on R3-1240). */
  grants: Record<string, { capabilities: string[] }> | null;
}

/** What is asked for: the ticket's filter fields (R-BTN-33). */
export interface GateTicket {
  repository: string;
  course: string;
  tier: string | null;
  /** The clause's names, null with none (rule 4). */
  requires: string[] | null;
  operator_only: boolean;
  /** Its repository's tier ladder, lowest first (R-BTN-66). */
  tiers: string[];
}

/** The leg: at a claim the ticket's queued leg as posted; at an advance the leg being started. */
export interface GateLeg {
  name: string;
  /** As the latest snapshot posted it; null when no snapshot posts the leg (an advance into a
   *  leg no sync has posted yet is fine, R-BTN-63). */
  state: 'ready' | 'waiting' | null;
  /** The tags the sync posted barred from this leg of the ticket (`ticket_bars`). */
  bars: string[];
}

export interface GateContext {
  now: number;
  /** The ticket's claims; at an advance, without the advancing one. */
  claims: { status: string; confirmed_at: number | null; fence_pending: number }[];
  override: { hold: number; retry_after: number | null } | null;
  /** The ticket's course's (rule 9). */
  minWorkerVersion: number;
  /** §6.7: the repository head's observation, and the newest `end_observation` of the ticket's
   *  claims (-1 with none): claimable only after a sync since the last end. */
  headObservation: number;
  lastEndObservation: number;
  /** At an advance, the tags the holder bars from the new leg itself (R-BTN-63). */
  holderBars?: string[];
}

export type Phase = 'claim' | 'advance';

export type GateVerdict = { ok: true } | { ok: false; rule: number; code: string };

/** The refusal code of each rule (§7.2, §11). */
export const GATE_CODES = {
  1: 'not-ready',
  3: 'claimed',
  7: 'not-granted',
  4: 'missing-capability',
  5: 'above-tier-ceiling',
  6: 'operator-only',
  8: 'barred-tag',
  9: 'stale-skills',
  10: 'backing-off',
} as const;

const refuse = (rule: keyof typeof GATE_CODES, code: string = GATE_CODES[rule]): GateVerdict => ({ ok: false, rule, code });

/** Whether a claim row still holds its ticket (rule 3): active, completed but unconfirmed (§6.7),
 *  or reaped while its worker was alive and not yet fenced (R-BTN-19). */
export function claimHolds(c: { status: string; confirmed_at: number | null; fence_pending: number }): boolean {
  return c.status === 'active' || (c.status === 'completed' && c.confirmed_at == null) || (c.status === 'reaped' && !!c.fence_pending);
}

/**
 * Whether `worker` may take `leg` of `ticket` now, at a claim or at an advance, naming the first
 * rule that refuses. At a claim: the leg is ready and a sync has run since the ticket's last end
 * (rule 1), the lease (3), the grant (7), capabilities (4), tier (5), operator-only (6), the
 * barred tags — posted and owner bars — (8), the course version (9) and the backoff (10). At an
 * advance only the rules that bind a holder (§7.2): the hold (3), 4–7, 8 with the holder's own
 * bars and the owner bars that apply at advances joined, and 10 — rule 1 is the
 * edge and run limit the caller checks against the course file, the lease is the holder's own,
 * and rule 9 is not re-checked, so a course change never strands a claim halfway (R-BTN-22).
 */
export function gatesFor(worker: GateWorker, ticket: GateTicket, leg: GateLeg, phase: Phase, facts: GateContext): GateVerdict {
  if (phase === 'claim') {
    if (leg.state !== 'ready') return refuse(1);
    if (facts.claims.some(claimHolds)) return refuse(3);
  }
  if (facts.override?.hold) return refuse(3, 'held');

  // Rule 7 (R-BTN-58): the key holds a grant for the ticket's repository.
  const grant = worker.grants ? worker.grants[ticket.repository] ?? null : undefined;
  if (grant === null) return refuse(7);

  // Rule 4: what it declared, within what this repository granted it.
  const held = capabilitiesOf(worker.declared);
  const granted = grant ? new Set(grant.capabilities) : null;
  for (const need of capabilitiesOf(ticket.requires)) if (!held.has(need) || (granted && !granted.has(need))) return refuse(4);

  // Rule 5: the caller passes the lower of the declared ceiling and the grant's max_tier.
  if (!fitsTier(ticket.tier, worker.tier_ceiling, ticket.tiers)) return refuse(5);

  // Rule 6: declared, and — for a granted key — granted by an administrator.
  if (ticket.operator_only && (!worker.declared.includes('human-operator') || (granted && !granted.has('human-operator')))) return refuse(6);

  const barred = new Set([...leg.bars, ...(phase === 'advance' ? facts.holderBars ?? [] : [])]);
  if (worker.tags.some((t) => barred.has(t))) return refuse(8);

  if (phase === 'claim') {
    const declared = worker.courses.find((c) => c.repository === ticket.repository && c.course === ticket.course);
    if (!declared || declared.version < facts.minWorkerVersion) return refuse(9);
  }

  if (facts.override?.retry_after != null && facts.override.retry_after > facts.now) return refuse(10);

  // §6.7, checked last so a ticket that fails a gate says which: a ticket is claimable again only
  // after a snapshot observed after its last end, so its next claimant is never offered legs from
  // before the holder's last push.
  if (phase === 'claim' && facts.headObservation <= facts.lastEndObservation) return refuse(1, 'awaiting-sync');

  return { ok: true };
}
