// front.ts — what stands in front of Baton's core (BATON_SPEC §3, §10): it verifies the
// principal for the path, applies the R-BTN-16 rules, serves the dashboard's static files, and
// forwards the API to the core — through the Durable Object on Cloudflare, through the request
// queue locally (R-BTN-55). Every response leaves with the security headers.
import { verifyOwner, verifyRequest, verifySyncCredential, verifyWorker, checkStateChanging, withBody } from './auth';
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
  '/login': [page, 'text/html; charset=utf-8'],
  '/ui/app.css': [style, 'text/css; charset=utf-8'],
  '/ui/app.js': [script, 'text/javascript; charset=utf-8'],
};
/** What anyone may fetch: the login page and the code it runs, which hold no data (R-BTN-57's
 *  one-time link is opened before any session exists). The dashboard and its API need a principal. */
const PUBLIC = new Set(['/login', '/ui/app.css', '/ui/app.js']);
/** R-BTN-16: the one cookie Baton reads — its own dashboard session. */
const SESSION_COOKIE = '__Host-baton_session';

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get('Cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The dashboard's principal (R-BTN-57, R-BTN-16): Cloudflare Access when the operator put it in
 *  front and the request carries its assertion — optional hardening — else Baton's own session
 *  cookie, which the core checks against its SQLite and BATON_ADMIN_KEYS on every request. */
async function dashboardPrincipal(req: Request, env: Config): Promise<Record<string, string>> {
  if (req.headers.has('Cf-Access-Jwt-Assertion')) return { 'X-Baton-Owner': await verifyOwner(req, env) };
  const session = cookie(req, SESSION_COOKIE);
  if (!session) throw new BatonError('unauthenticated', 'a dashboard session is required: `baton admin open` mints a link');
  return { 'X-Baton-Session': session };
}

/** The headers that carry a verified principal to the object. A request never brings its own. */
const PRINCIPAL_HEADERS = ['X-Baton-Credential', 'X-Baton-Owner', 'X-Baton-Sync', 'X-Baton-Signed', 'X-Baton-Webhook', 'X-Baton-Session'];

async function route(req: Request, env: Config, to: Forward): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith('/v1/sync/')) {
    // R-BTN-93: a sync key's signature is pre-checked here like every signed request, and its key
    // checked in the core; a CI identity token is verified here, and the core binds its claims to
    // one repository and role (Registry.forSync, forGitlab), so the front names no repository.
    if (req.headers.has('Signature-Input') || req.headers.has('Signature')) {
      const signed = await verifyRequest(req, null, { origin: env.BATON_ORIGIN });
      return forward(withBody(req, signed.body), to, { 'X-Baton-Signed': signed.keyid });
    }
    const claims = await verifySyncCredential(req, env);
    // A header carries bytes only: characters from U+007F up go as \u escapes (round 3, 3-A-1).
    const ascii = JSON.stringify(claims).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return forward(req, to, { 'X-Baton-Sync': ascii });
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
  if (pathname.startsWith('/v1/admin/') || pathname.startsWith('/v1/owner/')) {
    // R-BTN-57, R-BTN-58: an administrator's or an owner's key signs every request; the core
    // checks which, and for which repository.
    if (!req.headers.has('Signature-Input') && !req.headers.has('Signature')) throw new BatonError('unauthenticated', 'sign with an administrator or owner key (R-BTN-13)');
    const signed = await verifyRequest(req, null, { origin: env.BATON_ORIGIN });
    return forward(withBody(req, signed.body), to, { 'X-Baton-Signed': signed.keyid });
  }
  if (pathname === '/v1/login') {
    // R-BTN-16: against login CSRF, the token comes as JSON from this Baton's own page.
    if (req.method !== 'POST') throw new BatonError('not-found', 'no such route');
    checkStateChanging(req, env);
    return forward(req, to, {});
  }
  if (pathname === '/' || pathname.startsWith('/ui/') || pathname.startsWith('/v1/ui/') || PUBLIC.has(pathname)) {
    if (PUBLIC.has(pathname)) return serve(pathname, req);
    const principal = await dashboardPrincipal(req, env);
    if (pathname.startsWith('/v1/ui/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') checkStateChanging(req, env);
      return forward(req, to, principal);
    }
    // The dashboard page: a session is checked by the core, which keeps them.
    if (principal['X-Baton-Session']) {
      const ok = await forward(new Request(new URL('/v1/ui/session', req.url)), to, principal);
      if (!ok.ok) return ok;
    }
    return serve(pathname, req);
  }
  throw new BatonError('not-found', 'no such route');
}

function serve(pathname: string, req: Request): Response {
  const file = STATIC[pathname];
  if (!file || req.method !== 'GET') throw new BatonError('not-found', 'no such page');
  return new Response(file[0], { headers: { 'Content-Type': file[1], 'Cache-Control': 'no-store' } });
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
