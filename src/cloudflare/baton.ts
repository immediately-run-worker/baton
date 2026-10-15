// baton.ts — the `Baton` Durable Object (BATON_SPEC §3, §3a R-BTN-55): wiring only. It hands
// the core its ports — `ctx.storage` as the Store, the object's alarm as the Scheduler,
// `waitUntil` for dispatches — and passes every request and alarm through. The object's input
// gate is what runs one request at a time between awaits (§3).
import { DurableObject } from 'cloudflare:workers';
import { BatonCore } from '../core/baton';
import { dispatchWorkflow } from '../core/mirror';
import { parseAdminKeys } from '../core/auth';
import type { Cursor, Row, SqlValue, Store } from '../core/ports';

/** `ctx.storage` as the core's Store: the same synchronous SQLite, unchanged. */
export function durableStore(storage: DurableObjectStorage): Store {
  return {
    exec: <T = Row>(query: string, ...params: unknown[]) => storage.sql.exec(query, ...(params as SqlValue[])) as unknown as Cursor<T>,
    script: (sql: string) => void storage.sql.exec(sql),
    transaction: <T>(fn: () => T) => storage.transactionSync(fn),
  };
}

export class Baton extends DurableObject<Env> {
  readonly core: BatonCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.core = new BatonCore({
      store: durableStore(ctx.storage),
      scheduler: { get: () => ctx.storage.getAlarm(), set: (at) => ctx.storage.setAlarm(at) },
      config: env,
      dispatch: { send: (target) => dispatchWorkflow(env.GITHUB_DISPATCH_TOKEN, target), defer: (work) => ctx.waitUntil(work) },
      adminKeys: { list: () => parseAdminKeys(env.BATON_ADMIN_KEYS ?? '') },
    });
    // The object refuses to serve until every migration is applied (§3), and keeps one alarm.
    ctx.blockConcurrencyWhile(() => this.core.start());
  }

  fetch(req: Request): Promise<Response> {
    return this.core.fetch(req);
  }

  alarm(): Promise<void> {
    return this.core.alarm();
  }
}
