// main.ts — `npm run start:local -- --db <path> --port <n>` (BATON_SPEC §3a R-BTN-55, R-BTN-57).
// Options, never a `.dev.vars` file: `--origin` (default `http://127.0.0.1:<port>`), `--admin-keys
// <file>` (one OpenSSH public key per line) and `--config <file>`, a JSON object of the
// Worker's other variables and secrets (OIDC_*, ACCESS_*, OWNER_EMAILS, TOKEN_HASHES,
// CREDENTIALS, GITHUB_DISPATCH_TOKEN). The test bindings are refused: only the test harness,
// in-process, may set them.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { parseArgs } from 'node:util';
import { parseAdminKeys } from '../core/auth';
import type { Config } from '../core/ports';
import { LocalHost } from './host';
import { serve } from './server';
import { openStore } from './store';

const TEST_ONLY = /^(BATON_TEST_BINDINGS|TEST_.*)$/;

/** Whether `--host` names one address clients can use, so the default origin can be built
 *  from it: an IP address that is not the unspecified one (in any spelling), or `localhost`. */
export function concreteHost(host: string): boolean {
  if (host === 'localhost') return true;
  if (isIP(host) === 4) return !host.split('.').every((o) => Number(o) === 0);
  if (isIP(host) === 6) return new URL(`http://[${host}]`).hostname !== '[::]';
  return false;
}

/** The instance's Config from the `--config` object and the origin; refuses test bindings and
 *  anything that is not a string. */
export function localConfig(file: Record<string, unknown>, origin: string): Config {
  for (const [k, v] of Object.entries(file)) {
    if (TEST_ONLY.test(k)) throw new Error(`${k}: test bindings are never accepted by a local start`);
    if (typeof v !== 'string') throw new Error(`${k}: must be a string`);
  }
  const s = (k: string, d = '') => (typeof file[k] === 'string' ? (file[k] as string) : d);
  const opt = (k: string) => (typeof file[k] === 'string' ? (file[k] as string) : undefined);
  return {
    BATON_ORIGIN: origin,
    OIDC_ISSUER: s('OIDC_ISSUER', 'https://token.actions.githubusercontent.com'),
    OIDC_JWKS_URL: s('OIDC_JWKS_URL', 'https://token.actions.githubusercontent.com/.well-known/jwks'),
    OIDC_REPOSITORY: s('OIDC_REPOSITORY'),
    OIDC_REF: s('OIDC_REF', 'refs/heads/main'),
    SYNC_WORKFLOW_REF: s('SYNC_WORKFLOW_REF'),
    MIRROR_WORKFLOW_REF: s('MIRROR_WORKFLOW_REF'),
    ACCESS_TEAM_DOMAIN: s('ACCESS_TEAM_DOMAIN'),
    ACCESS_AUD: s('ACCESS_AUD'),
    OWNER_EMAILS: s('OWNER_EMAILS'),
    TOKEN_HASHES: opt('TOKEN_HASHES'),
    CREDENTIALS: opt('CREDENTIALS'),
    GITHUB_DISPATCH_TOKEN: opt('GITHUB_DISPATCH_TOKEN'),
  };
}

export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      port: { type: 'string', default: '8787' },
      host: { type: 'string', default: '127.0.0.1' },
      origin: { type: 'string' },
      'admin-keys': { type: 'string' },
      config: { type: 'string' },
    },
  });
  if (!values.db) throw new Error('--db <path> is required (the SQLite file; created if absent)');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a port number');
  // The origin is the OIDC audience and the dashboard's Origin (R-BTN-56): it must be the
  // address clients use, so it is derived only from a concrete host and port.
  if (!values.origin && (port === 0 || !concreteHost(values.host!))) {
    throw new Error('--origin is required with --port 0, or a --host that is not one IP address or localhost: the origin must be the address clients use');
  }
  const bind = values.host!.includes(':') ? `[${values.host}]` : values.host;
  const origin = (values.origin ?? `http://${bind}:${port}`).replace(/\/+$/, '');
  const file = values.config ? JSON.parse(readFileSync(values.config, 'utf8')) : {};
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('--config must hold a JSON object');
  const keys = parseAdminKeys(values['admin-keys'] ? readFileSync(values['admin-keys'], 'utf8') : '');

  const { store } = openStore(values.db);
  const host = new LocalHost({ store, config: localConfig(file, origin), adminKeys: { list: () => keys } });
  await host.start();
  const server = serve(host, origin);
  server.listen(port, values.host, () => console.log(`baton: serving ${origin} from ${values.db}`));
  const stop = () => server.close(() => host.stop().then(() => process.exit(0)));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
