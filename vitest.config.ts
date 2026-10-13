// vitest.config.ts — the Workers runtime under test (BATON_SPEC §13a R-BTN-29). The test
// signing keys are made here, per run, and exist only in these bindings: wrangler.toml has no
// BATON_TEST_BINDINGS, so no deployed Worker — baton-staging included — ever trusts them.
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { exportJWK, generateKeyPair } from 'jose';
import { createHash } from 'node:crypto';

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

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const k = await testKeys();
      return {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          bindings: {
            BATON_TEST_BINDINGS: 'true',
            TEST_OIDC_JWKS: k.jwks,
            TEST_ACCESS_JWKS: k.jwks,
            TEST_SIGNING_JWK: k.priv,
            ACCESS_TEAM_DOMAIN: 'baton-test.cloudflareaccess.com',
            ACCESS_AUD: 'baton-test-aud',
            OWNER_EMAILS: 'owner@example.com',
            TOKEN_HASHES: JSON.stringify(Object.fromEntries(Object.entries(TEST_TOKENS).map(([id, t]) => [id, sha(t)]))),
            CREDENTIALS: JSON.stringify(CREDENTIALS),
          },
        },
      };
    }),
  ],
  test: {
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
  },
});
