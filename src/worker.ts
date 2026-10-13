// worker.ts — the Worker in front of Baton (BATON_SPEC §3, §10). It verifies the principal for
// the path, applies the R-BTN-16 rules, serves the dashboard's static files, and forwards the
// API to the one Durable Object. Every response leaves with the security headers.
import { verifyOwner, verifySync, checkStateChanging } from './auth';
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

async function route(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname.startsWith('/v1/sync/')) {
    await verifySync(req, env);
    return forward(req, env);
  }
  if (pathname === '/' || pathname.startsWith('/ui/') || pathname.startsWith('/v1/ui/')) {
    await verifyOwner(req, env);
    if (pathname.startsWith('/v1/ui/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') checkStateChanging(req, env);
      return forward(req, env);
    }
    const file = STATIC[pathname];
    if (!file || req.method !== 'GET') throw new BatonError('not-found', 'no such page');
    return new Response(file[0], { headers: { 'Content-Type': file[1], 'Cache-Control': 'no-store' } });
  }
  throw new BatonError('not-found', 'no such route');
}

/** The fixed object (§3): every request reaches the same `Baton`. */
function forward(req: Request, env: Env): Promise<Response> {
  return env.BATON.get(env.BATON.idFromName('baton')).fetch(req);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return withSecurityHeaders(await route(req, env));
    } catch (e) {
      // A refused request's body is never read; release it so the runtime does not.
      if (req.body && !req.bodyUsed) req.body.cancel().catch(() => {});
      if (e instanceof BatonError) return withSecurityHeaders(errorResponse(e.code, e.message));
      return withSecurityHeaders(errorResponse('internal', 'internal error'));
    }
  },
} satisfies ExportedHandler<Env>;
