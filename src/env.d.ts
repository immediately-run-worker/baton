// The Worker's bindings (wrangler.toml): the core's Config (src/core/ports.ts), the Durable
// Object namespace, and the secrets only the Cloudflare host reads.
import type { Config } from './core/ports';

declare global {
  interface Env extends Config {
    BATON: DurableObjectNamespace;
    /** R-BTN-57: the administrators' public keys, one per line (R3-1240 reads them). */
    BATON_ADMIN_KEYS?: string;
  }
  // `env` from cloudflare:test is typed as Cloudflare.Env.
  namespace Cloudflare {
    interface Env extends globalThis.Env {}
  }
}
