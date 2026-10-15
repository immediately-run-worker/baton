// front.ts — what stands in front of Baton's core (BATON_SPEC §3, §10): it verifies the
// principal for the path, applies the R-BTN-16 rules, serves the dashboard's static files, and
// forwards the API to the core — through the Durable Object on Cloudflare, through the request
// queue locally (R-BTN-55). Every response leaves with the security headers.
import { verifyOwner, verifyRequest, verifySyncToken, verifyWorker, checkStateChanging, withBody } from './auth';
import { BatonError, errorResponse, withSecurityHeaders } from './http';
import { pickDelivery, verifyDelivery } from './webhook';
import type { Config } from './ports';
import page from '../ui/index.html';
import style from '../ui/app.css';
import script from '../ui/app.js';

/** How the front reaches the one core (§3): the request carries only the principal headers
 *  the front set. */
export type Forward = (req: Request) => Promise<Response>;

const STATIC: Record<string, [string, string]> = {
  '/': [page, 'text/html; charset=utf-8'],
  '/ui/app.css': [style, 'text/css; charset=utf-8'],
  '/ui/app.js': [script, 'text/javascript; charset=utf-8'],
};

/** The headers that carry a verified principal to the object. A request never brings its own. */
const PRINCIPAL_HEADERS = ['X-Baton-Credential', 'X-Baton-Owner', 'X-Baton-Sync', 'X-Baton-Signed', 'X-Baton-Webhook'];

async function route(req: Request, env: Config, to: Forward): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith('/v1/sync/')) {
    // R-BTN-15: the token is verified here; the core binds its claims to one repository's
    // sync or mirror workflow (Registry.forSync), so the front names no repository.
    const claims = await verifySyncToken(req, env);
    return forward(req, to, { 'X-Baton-Sync': JSON.stringify(claims) });
  }
  if (pathname === '/v1/github/webhook') {
    // R-BTN-73: the GitHub App's delivery — the one route whose credential is GitHub's
    // signature. Verified before anything is read; then only R-BTN-73's fields go on, in a
    // request that carries nothing else of the delivery's.
    if (req.method !== 'POST') throw new BatonError('not-found', 'no such route');
    const body = await verifyDelivery(req, env.BATON_GITHUB_WEBHOOK_SECRET);
    let payload: unknown = null;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      // A form-encoded or broken body is not a delivery Baton reads.
    }
    const d = pickDelivery(req.headers.get('X-GitHub-Event'), req.headers.get('X-GitHub-Delivery'), payload);
    if (!d) return new Response(null, { status: 204 });
    // A header carries bytes only: every character from U+007F up goes as a \u escape, which
    // the core's JSON.parse turns back into the same value (round 3, 3-A-0).
    const ascii = JSON.stringify(d).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return forward(new Request(req.url, { method: 'POST' }), to, { 'X-Baton-Webhook': ascii });
  }
  if (pathname.startsWith('/v1/runner/')) {
    if (req.headers.has('Signature-Input') || req.headers.has('Signature')) {
      // R-BTN-13 as amended: a half-signed, malformed, foreign-@authority or mis-digested
      // request stops here; the core checks the key, the signature, the clock and the nonce.
      // (`created` is the core's: the one clock is its, R-BTN-32.)
      const signed = await verifyRequest(req, null, { origin: env.BATON_ORIGIN });
      return forward(withBody(req, signed.body), to, { 'X-Baton-Signed': signed.keyid });
    }
    // The transition (R3-1239): a bearer token still serves until every worker signs.
    const credential = await verifyWorker(req, env);
    return forward(req, to, { 'X-Baton-Credential': credential });
  }
  if (pathname === '/' || pathname.startsWith('/ui/') || pathname.startsWith('/v1/ui/')) {
    const owner = await verifyOwner(req, env);
    if (pathname.startsWith('/v1/ui/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') checkStateChanging(req, env);
      return forward(req, to, { 'X-Baton-Owner': owner });
    }
    const file = STATIC[pathname];
    if (!file || req.method !== 'GET') throw new BatonError('not-found', 'no such page');
    return new Response(file[0], { headers: { 'Content-Type': file[1], 'Cache-Control': 'no-store' } });
  }
  throw new BatonError('not-found', 'no such route');
}

/** The one core (§3): every request reaches it carrying only the principal the front verified. */
function forward(req: Request, to: Forward, principal: Record<string, string>): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of PRINCIPAL_HEADERS) headers.delete(h);
  for (const [k, v] of Object.entries(principal)) headers.set(k, v);
  return to(new Request(req, { headers }));
}

/** A request from outside, answered: both hosts' entry point. */
export async function front(req: Request, env: Config, to: Forward): Promise<Response> {
  try {
    return withSecurityHeaders(await route(req, env, to));
  } catch (e) {
    // A refused request's body is never read; release it so the runtime does not.
    if (req.body && !req.bodyUsed) req.body.cancel().catch(() => {});
    if (e instanceof BatonError) return withSecurityHeaders(errorResponse(e.code, e.message, e.extra));
    return withSecurityHeaders(errorResponse('internal', 'internal error'));
  }
}
