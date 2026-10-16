// vitest.config.ts — Baton under test on both hosts (BATON_SPEC §13a R-BTN-29, S-BTN-31): the
// `cloudflare` project runs every test in the Workers runtime; the `local` project runs every
// integration scenario again against the local Node host (R-BTN-55), plus the tests only Node
// can run. The test signing keys are made here, per run, and exist only in these bindings:
// wrangler.toml has no BATON_TEST_BINDINGS, so no deployed Worker — baton-staging included —
// ever trusts them, and a local start refuses them (src/local/main.ts).
import { defineConfig, type Plugin } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makeKey } from './test/lib/sshKeys.ts';

/** The test credentials (R-BTN-13): tokens, their hashes and their policy — the shapes the
 *  TOKEN_HASHES and CREDENTIALS Worker secrets take in production (R3-1208). The `test`
 *  credential exists only here, and only it may send test_harness (R-BTN-32). */
export const TEST_TOKENS = { 'vm-a': 'tok-vm-a', mac: 'tok-mac', test: 'tok-test', 'vm-b': 'tok-vm-b' };
const VENUE = ['agent-venue', 'authentication', 'llm-call', 'create-pr', 'drivable-browser', 'mcp-chrome', 'none'];
const CREDENTIALS = {
  'vm-a': { hostname: 'vm-a', allowed_capabilities: VENUE },
  'vm-b': { hostname: 'vm-b', allowed_capabilities: VENUE },
  mac: { hostname: 'owner-mac', allowed_capabilities: [...VENUE, 'human-operator'] },
  test: { hostname: 'harness', allowed_capabilities: [...VENUE, 'human-operator'] },
  // A credential whose token hash was removed: revoked.
  gone: { hostname: 'vm-gone', allowed_capabilities: VENUE },
};
const sha = (t: string) => createHash('sha256').update(t).digest('hex');

async function testKeys() {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), kid: 'baton-test', alg: 'ES256', use: 'sig' };
  const priv = { ...(await exportJWK(privateKey)), kid: 'baton-test', alg: 'ES256' };
  return { jwks: JSON.stringify({ keys: [pub] }), priv: JSON.stringify(priv) };
}

/** wrangler.toml's top-level `[vars]`: the production Worker's settings, which the local
 *  project's host takes too, so both hosts run with the same values. */
function wranglerVars(): Record<string, string> {
  const toml = readFileSync(resolve(import.meta.dirname, 'wrangler.toml'), 'utf8');
  const block = /^\[vars\]\n([\s\S]*?)(?=^\[)/m.exec(toml)?.[1] ?? '';
  // Basic strings ("…") and TOML literal strings ('…', for JSON values).
  return Object.fromEntries([...block.matchAll(/^([A-Z_]+) = (?:"([^"]*)"|'([^']*)')$/gm)].map((m) => [m[1], m[2] ?? m[3]]));
}

/** Schema migrations and the dashboard load as text, as wrangler's Text rule bundles them. */
const textModules: Plugin = {
  name: 'baton-text-modules',
  enforce: 'pre',
  load(id) {
    const file = id.split('?')[0];
    if (/\.(sql|html|css)$/.test(file) || /[\\/]ui[\\/]app\.js$/.test(file)) return `export default ${JSON.stringify(readFileSync(file, 'utf8'))};`;
    return null;
  },
};

/** The tests only the local project runs: they need Node (the request queue, the file scan).
 *  It also runs every integration scenario and the mirror's unit tests (S-BTN-14's server half). */
const NODE_ONLY = ['test/unit/local-queue.test.ts', 'test/unit/boundary-host.test.ts'];
const host = (name: string) => ({ '#host': resolve(import.meta.dirname, `test/hosts/${name}.ts`) });

/** The test SSH keys (R-BTN-13 as amended, R3-1239): one of each type, made per run, seeded
 *  through BATON_KEYS as production seeds its own; their private halves exist only in the
 *  TEST_SSH_KEYS binding the harness signs with. */
const sshKeys = await Promise.all([
  makeKey('ssh-ed25519', 'vm-ed'),
  makeKey('ecdsa-sha2-nistp256', 'vm-p256'),
  makeKey('sk-ssh-ed25519@openssh.com', 'vm-sk-ed'),
  makeKey('sk-ecdsa-sha2-nistp256@openssh.com', 'vm-sk-p256'),
]);

const keys = await testKeys();
const bindings = {
  BATON_TEST_BINDINGS: 'true',
  TEST_OIDC_JWKS: keys.jwks,
  TEST_ACCESS_JWKS: keys.jwks,
  TEST_SIGNING_JWK: keys.priv,
  ACCESS_TEAM_DOMAIN: 'baton-test.cloudflareaccess.com',
  ACCESS_AUD: 'baton-test-aud',
  OWNER_EMAILS: 'owner@example.com',
  TOKEN_HASHES: JSON.stringify(Object.fromEntries(Object.entries(TEST_TOKENS).map(([id, t]) => [id, sha(t)]))),
  CREDENTIALS: JSON.stringify(CREDENTIALS),
  BATON_KEYS: JSON.stringify(sshKeys.map((k) => ({ key: k.publicKey, name: k.name, allowed_capabilities: VENUE }))),
  TEST_SSH_KEYS: JSON.stringify(sshKeys),
  // R-BTN-73: the GitHub App's webhook secret, the run's own.
  // R-BTN-93/94 (R3-1262): the GitLab issuer the deployment trusts, and its key set under the test bindings.
  BATON_FORGE_SECRETS: JSON.stringify({ lab: { forge: 'gitlab', gitlab_issuer: 'https://gitlab.test' } }),
  TEST_GITLAB_JWKS: keys.jwks,
  BATON_GITHUB_WEBHOOK_SECRET: `test-webhook-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 16)}`,
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest(async () => ({ wrangler: { configPath: './wrangler.toml' }, miniflare: { bindings } }))],
        resolve: { alias: host('cloudflare') },
        test: {
          name: 'cloudflare',
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.ts'],
          include: ['test/**/*.test.ts'],
          exclude: NODE_ONLY,
        },
      },
      {
        plugins: [textModules],
        resolve: { alias: host('local') },
        test: {
          name: 'local',
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup.ts'],
          include: ['test/integration/**/*.test.ts', 'test/unit/mirror.test.ts', ...NODE_ONLY],
          provide: { localConfig: { ...wranglerVars(), ...bindings } },
        },
      },
    ],
  },
});
