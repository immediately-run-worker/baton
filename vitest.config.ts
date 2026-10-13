// vitest.config.ts — the Workers runtime under test (BATON_SPEC §13a R-BTN-29). The test
// signing keys are made here, per run, and exist only in these bindings: wrangler.toml has no
// BATON_TEST_BINDINGS, so no deployed Worker — baton-staging included — ever trusts them.
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { exportJWK, generateKeyPair } from 'jose';

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
