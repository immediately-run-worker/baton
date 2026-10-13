// worker.ts — the Worker in front of Baton (BATON_SPEC §3, §10). It verifies the principal for
// the path, applies the R-BTN-16 rules, serves the dashboard's static files, and forwards the
// API to the one Durable Object. Every response leaves with the security headers.
import { verifyOwner, verifySync, verifyWorker, checkStateChanging } from './auth';
import { BatonError, errorResponse, withSecurityHeaders } from './http';
import page from './ui/index.html';
import style from './ui/app.css';
import script from './ui/app.js';

export { Baton } from './baton';

const STATIC: Record<string, [string, string]> = {
  '/': [page, 'text/html; charset=utf-8'],
  '/ui/app.css': [style, 'text/css; charset=utf-8'],
  '/ui/app.js': [script, 'text/javascript; charset=utf-8'],
};

/** The headers that carry a verified principal to the object. A request never brings its own. */
const PRINCIPAL_HEADERS = ['X-Baton-Credential', 'X-Baton-Owner'];

async function route(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith('/v1/sync/')) {
    // §10.3: the mirror's routes take only baton-mirror.yml's token; the board's only baton-sync.yml's.
    const mirror = pathname === '/v1/sync/events' || pathname === '/v1/sync/foreign-claim';
    await verifySync(req, env, mirror ? env.MIRROR_WORKFLOW_REF : env.SYNC_WORKFLOW_REF);
    return forward(req, env, {});
  }
  if (pathname.startsWith('/v1/worker/')) {
    const credential = await verifyWorker(req, env);
    return forward(req, env, { 'X-Baton-Credential': credential });
  }
  if (pathname === '/' || pathname.startsWith('/ui/') || pathname.startsWith('/v1/ui/')) {
    const owner = await verifyOwner(req, env);
    if (pathname.startsWith('/v1/ui/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') checkStateChanging(req, env);
      return forward(req, env, { 'X-Baton-Owner': owner });
    }
    const file = STATIC[pathname];
    if (!file || req.method !== 'GET') throw new BatonError('not-found', 'no such page');
    return new Response(file[0], { headers: { 'Content-Type': file[1], 'Cache-Control': 'no-store' } });
  }
  throw new BatonError('not-found', 'no such route');
}

/** The fixed object (§3): every request reaches the same `Baton`, carrying only the principal
 *  this Worker verified. */
function forward(req: Request, env: Env, principal: Record<string, string>): Promise<Response> {
  const headers = new Headers(req.headers);
  for (const h of PRINCIPAL_HEADERS) headers.delete(h);
  for (const [k, v] of Object.entries(principal)) headers.set(k, v);
  return env.BATON.get(env.BATON.idFromName('baton')).fetch(new Request(req, { headers }));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await route(req, env));
    } catch (e) {
      // A refused request's body is never read; release it so the runtime does not.
      if (req.body && !req.bodyUsed) req.body.cancel().catch(() => {});
      if (e instanceof BatonError) return withSecurityHeaders(errorResponse(e.code, e.message, e.extra));
      return withSecurityHeaders(errorResponse('internal', 'internal error'));
    }
  },
} satisfies ExportedHandler<Env>;
