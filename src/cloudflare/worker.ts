// worker.ts — the Worker (BATON_SPEC §3): the front (src/core/front.ts) with the one Durable
// Object, fixed name, as the core behind it.
import { front } from '../core/front';

export { Baton } from './baton';

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    const baton = env.BATON.get(env.BATON.idFromName('baton'));
    return front(req, env, (r) => baton.fetch(r));
  },
} satisfies ExportedHandler<Env>;
