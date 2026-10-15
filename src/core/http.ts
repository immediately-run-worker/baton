// http.ts — responses, errors and the R-BTN-16 headers (BATON_SPEC §10.5, §11).

/** Every response carries these (R-BTN-16): no framing, nothing loaded from elsewhere. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export type ErrorCode =
  | 'unauthenticated' | 'forbidden' | 'invalid-params' | 'not-found'
  | 'head-moved' | 'snapshot-rejected' | 'stale-observation' | 'sync-busy' | 'unavailable' | 'internal'
  | 'session-taken' | 'worker-reaped' | 'claim-ended' | 'not-holder'
  | 'not-eligible' | 'no-eligible-ticket' | 'provider-suspended' | 'stale-skills' | 'backing-off' | 'not-cut-over';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401, forbidden: 403, 'invalid-params': 400, 'not-found': 404,
  'head-moved': 409, 'snapshot-rejected': 409, 'stale-observation': 409, 'sync-busy': 409, unavailable: 503, internal: 500,
  'session-taken': 409, 'worker-reaped': 409, 'claim-ended': 409, 'not-holder': 409,
  'not-eligible': 409, 'no-eligible-ticket': 404, 'provider-suspended': 409, 'stale-skills': 409, 'backing-off': 409,
  'not-cut-over': 409,
};

/** Thrown anywhere below the router; the router turns it into the §11 error body. */
export class BatonError extends Error {
  /** `extra` rides in the error body beside `code` and `message` — `not-eligible` names its `rule` (§11). */
  constructor(readonly code: ErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function errorResponse(code: ErrorCode, message: string, extra: Record<string, unknown> = {}): Response {
  return json({ ...extra, ok: false, code, message }, STATUS[code]);
}

/** A copy of `res` with the security headers set (responses from the object are immutable). */
export function withSecurityHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}
