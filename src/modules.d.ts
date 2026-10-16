// Text modules: wrangler.toml's Text rule bundles them on Cloudflare; the local build and the
// local test project load them as text too (R-BTN-55).
declare module '*.sql' { const text: string; export default text; }
declare module '*.html' { const text: string; export default text; }
declare module '*.css' { const text: string; export default text; }
declare module '*/ui/app.js' { const text: string; export default text; }
declare module '*/shared/baton.mjs';
declare module '*/shared/vocabulary.mjs';
declare module '*/shared/sessionUsage.mjs';
declare module '*/shared/batonSync.mjs';
declare module '*/cli/baton.mjs';
declare module '*/cli/sign.mjs';
declare module '*/scripts/check-traces.mjs';
declare module '*/scripts/check-model-links.mjs';
