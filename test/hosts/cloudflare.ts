// cloudflare.ts — the integration harness's Cloudflare host (BATON_SPEC §13a S-BTN-31): the
// Worker and its Durable Object in workerd, through @cloudflare/vitest-plugin.
import { env, reset as resetStorage, runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import type { Baton } from '../../src/cloudflare/baton';
import type { BatonCore } from '../../src/core/baton';
import type { Config } from '../../src/core/ports';

export const HOST = 'cloudflare';
export const config: Config = env;

/** The fixed object. */
export function stub() {
  return env.BATON.get(env.BATON.idFromName('baton'));
}

/** A request to the Worker. */
export function call(req: Request): Promise<Response> {
  return (exports as unknown as { default: { fetch: (r: Request) => Promise<Response> } }).default.fetch(req);
}

/** Run `fn` with the object's core, inside the object. */
export function withCore<T>(fn: (core: BatonCore) => T | Promise<T>): Promise<T> {
  return runInDurableObject(stub(), (o: Baton) => fn(o.core));
}

/** One alarm tick, run directly. Not `runDurableObjectAlarm`: the fake clock sits behind the
 *  real one, so every alarm the object arms is already overdue and workerd may be running it in
 *  the background — when it is, nothing is scheduled and `runDurableObjectAlarm` runs nothing. */
export function tick(): Promise<void> {
  return withCore((c) => c.alarm());
}

/** Every test starts from an empty Baton. */
export function reset(): Promise<void> {
  return resetStorage();
}
