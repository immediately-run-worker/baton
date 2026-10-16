#!/usr/bin/env node
// baton.mjs — `baton admin …` and `baton owner …` (BATON_SPEC §10.6 R-BTN-57/-58, R-BTN-66/-67):
// the one management path. Each command builds one request — `plan`, pure, so it is tested on its
// own — and signs it with the key `-i` names; Baton validates it with the functions of
// src/core/admin.ts on either host. Nothing here holds a rule of its own: a refusal is Baton's,
// printed as it came. `baton run` (§6.13 R-BTN-72) is the worker loop: it lives in src/runner
// (TypeScript, node-only), so scripts/baton-run.mjs bundles it first, the way start-local does.
//
//   baton admin -i KEY repo add <forge path> --owner-key PUB[,PUB…] [--id ID (default: the path's last segment)]
//                [--forge github|gitlab|gitea|git] [--remote URL] [--web-base URL] [--default-branch main]
//                [--sync-workflow PATH] [--mirror-workflow PATH] [--ci-identity none|github-actions|gitlab:<issuer>|gitlab-mirror:<issuer>]
//                [--sync-key PUB[,…]] [--mirror-key PUB[,…]] [--weight N] [--tiers a,b,c] [--cut-over]
//   baton admin -i KEY repo set ID [--weight N] [--tiers a,b,c] [--remote URL] [--web-base URL]
//                [--sync-workflow PATH|none] [--mirror-workflow PATH|none] [--ci-identity …]
//                [--add-owner-key PUB[,…]] [--add-sync-key PUB[,…]] [--add-mirror-key PUB[,…]] [--remove-sync-key FP[,…]]
//   baton admin -i KEY repo retire ID
//   baton admin -i KEY grant REPO --key PUB [--hostname H] --capabilities a,b [--max-tier T]
//   baton admin -i KEY probe add --key PUB --label L [--instances a,b]
//   baton admin -i KEY revoke FINGERPRINT                          baton admin -i KEY open
//   baton owner -i KEY grant REPO --key PUB [--hostname H] --capabilities a,b [--label L] [--max-tier T]
//   baton owner -i KEY revoke REPO FINGERPRINT
//   baton owner -i KEY owners REPO (--add PUB | --remove FINGERPRINT)
//   baton owner -i KEY bar REPO --course C|'*' --tag T [--legs a,b] --applies claim|claim+advance
//                [--starts-at ISO] [--ends-at ISO] [--release-holders] --reason R
//   baton owner -i KEY bar lift REPO ID
//   baton owner -i KEY settings REPO [--required-bar LEG|'*' --course C|'*' [--except a,b] --tag-prefix P]… | --no-required-bars
//                [--retry 1h,4h --max-failed 3 | --retry default] [--transcript-repos a,b]
//                [--unblocked-workflow .github/workflows/F.yml | --unblocked-workflow none]
//
// The URL is `--url`, else BATON_URL, else https://baton.immediately.run.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { signHeaders, signingKey } from './sign.mjs';

export const DEFAULT_URL = 'https://baton.immediately.run';
const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** argv after the command: flags (each `--name value`, or a bare boolean) and positionals. The
 *  `--required-bar` groups keep their order, so each takes the flags that follow it. With
 *  `allowed`, a flag the command does not take is refused — never silently dropped (round 3, 3-A-1). */
export function parseArgs(argv, booleans = [], allowed = null, positionals = Infinity) {
  const flags = {};
  const positional = [];
  const groups = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--') && a !== '-i') {
      // A command's own flags are refused misspelled with one dash or a typographic dash, and a
      // positional it does not take is refused — never silently dropped (round 3, 3-A-1, adjudicated).
      if (allowed && /^[-\u2010-\u2015\u2212]/.test(a)) throw new Error(`${a}: not a flag of this command (flags are --name)`);
      if (positional.length >= positionals) throw new Error(`${a}: this command takes no further argument`);
      positional.push(a);
      continue;
    }
    const name = a === '-i' ? 'identity' : a.slice(2);
    if (allowed && !allowed.includes(name) && !booleans.includes(name)) throw new Error(`${a}: not a flag of this command`);
    if (booleans.includes(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${a} needs a value`);
    if (name === 'required-bar') groups.push({ leg: value });
    else if (groups.length && ['course', 'except', 'tag-prefix'].includes(name) && flags['required-bar-mode']) groups.at(-1)[name] = value;
    else flags[name] = value;
    if (name === 'required-bar') flags['required-bar-mode'] = true;
  }
  delete flags['required-bar-mode'];
  return { flags, positional, groups };
}

const list = (v) => (v == null ? undefined : String(v).split(',').map((x) => x.trim()).filter(Boolean));
const need = (v, what) => {
  if (v == null || v === '') throw new Error(`${what} is required`);
  return v;
};
const time = (v, what) => {
  if (v == null) return undefined;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new Error(`${what}: not a date (${v})`);
  return t;
};
export function duration(v) {
  const m = /^(\d+)([mhd])$/.exec(v);
  if (!m) throw new Error(`a duration is like 30m, 1h or 2d, not ${v}`);
  return Number(m[1]) * UNITS[m[2]];
}

/**
 * The request a command makes: `{method, path, body}`. `readKey(path)` reads a public key file
 * (or returns the argument when it is a key line itself). Pure: no network, no signing.
 */
export function plan(role, argv, readKey = (p) => (/^(ssh|sk|ecdsa)-/.test(p) ? p : readFileSync(p, 'utf8').trim())) {
  const [cmd, ...rest] = argv;
  if (role === 'admin') {
    if (cmd === 'repo') {
      const [sub, target, ...more] = rest;
      if (sub === 'add') {
        const { flags } = parseArgs(more, ['cut-over'], ['id', 'forge', 'remote', 'web-base', 'default-branch', 'sync-workflow', 'mirror-workflow', 'ci-identity',
          'sync-key', 'mirror-key', 'weight', 'tiers', 'owner-key'], 0);
        const path = need(target, 'the repository (its forge path, owner/name)');
        const keys = [...(list(flags['sync-key']) ?? []).map((k) => ({ public_key: readKey(k), role: 'sync' })), ...(list(flags['mirror-key']) ?? []).map((k) => ({ public_key: readKey(k), role: 'mirror' }))];
        return { method: 'POST', path: '/v1/admin/repositories', body: {
          id: flags.id ?? path.split('/').at(-1).toLowerCase(), github: path, default_branch: flags['default-branch'] ?? 'main',
          ...(flags.forge ? { forge: flags.forge } : {}), ...(flags.remote ? { remote: flags.remote } : {}), ...(flags['web-base'] ? { web_base: flags['web-base'] } : {}),
          ...(flags['sync-workflow'] ? { sync_workflow: flags['sync-workflow'] } : {}), ...(flags['mirror-workflow'] ? { mirror_workflow: flags['mirror-workflow'] } : {}),
          ...(flags['ci-identity'] ? { ci_identity: ciIdentity(flags['ci-identity']) } : {}), ...(keys.length ? { sync_keys: keys } : {}),
          ...(flags.weight ? { weight: Number(flags.weight) } : {}), ...(flags.tiers ? { tiers: list(flags.tiers) } : {}), ...(flags['cut-over'] ? { cut_over: true } : {}),
          owner_keys: need(list(flags['owner-key']), '--owner-key').map(readKey),
        } };
      }
      if (sub === 'set') {
        const { flags } = parseArgs(more, [], ['weight', 'tiers', 'remote', 'web-base', 'sync-workflow', 'mirror-workflow', 'ci-identity',
          'add-owner-key', 'add-sync-key', 'add-mirror-key', 'remove-sync-key'], 0);
        const add = [...(list(flags['add-sync-key']) ?? []).map((k) => ({ public_key: readKey(k), role: 'sync' })), ...(list(flags['add-mirror-key']) ?? []).map((k) => ({ public_key: readKey(k), role: 'mirror' }))];
        const workflow = (v) => (v === 'none' ? null : v);
        const body = {
          id: need(target, 'the repository id'), ...(flags.weight ? { weight: Number(flags.weight) } : {}), ...(flags.tiers ? { tiers: list(flags.tiers) } : {}),
          ...(flags.remote ? { remote: flags.remote } : {}), ...(flags['web-base'] ? { web_base: flags['web-base'] } : {}),
          ...(flags['sync-workflow'] ? { sync_workflow: workflow(flags['sync-workflow']) } : {}), ...(flags['mirror-workflow'] ? { mirror_workflow: workflow(flags['mirror-workflow']) } : {}),
          ...(flags['ci-identity'] ? { ci_identity: ciIdentity(flags['ci-identity']) } : {}),
          ...(flags['add-owner-key'] ? { owner_keys_add: list(flags['add-owner-key']).map(readKey) } : {}), ...(add.length ? { sync_keys_add: add } : {}),
          ...(flags['remove-sync-key'] ? { sync_keys_remove: list(flags['remove-sync-key']) } : {}),
        };
        if (Object.keys(body).length === 1) throw new Error('baton admin repo set ID names at least one change');
        return { method: 'POST', path: '/v1/admin/repositories', body };
      }
      if (sub === 'retire') {
        parseArgs(more, [], [], 0);
        return { method: 'POST', path: '/v1/admin/repositories', body: { id: need(target, 'the repository id'), retire: true } };
      }
      throw new Error('baton admin repo add|set|retire');
    }
    if (cmd === 'grant') {
      const { flags, positional } = parseArgs(rest, [], GRANT_FLAGS, 1);
      return { method: 'POST', path: '/v1/admin/grants', body: grantBody(flags, readKey, { repository: need(positional[0], 'the repository id') }) };
    }
    if (cmd === 'probe' && rest[0] === 'add') {
      const { flags } = parseArgs(rest.slice(1), [], ['key', 'label', 'instances'], 0);
      return { method: 'POST', path: '/v1/admin/probes', body: { public_key: readKey(need(flags.key, '--key')), label: need(flags.label, '--label'), instances: list(flags.instances) ?? [] } };
    }
    if (cmd === 'revoke') {
      parseArgs(rest.slice(1), [], [], 0);
      return { method: 'POST', path: `/v1/admin/keys/${encodeURIComponent(need(rest[0], 'the key fingerprint'))}/revoke`, body: {} };
    }
    if (cmd === 'open') {
      parseArgs(rest, [], [], 0);
      return { method: 'POST', path: '/v1/admin/login-links', body: {} };
    }
    throw new Error('baton admin repo|grant|probe|revoke|open');
  }
  if (role === 'owner') {
    if (cmd === 'grant') {
      const { flags, positional } = parseArgs(rest, [], GRANT_FLAGS, 1);
      return { method: 'POST', path: `/v1/owner/${need(positional[0], 'the repository id')}/grants`, body: grantBody(flags, readKey, {}) };
    }
    if (cmd === 'revoke') {
      parseArgs(rest.slice(2), [], [], 0);
      return { method: 'POST', path: `/v1/owner/${need(rest[0], 'the repository id')}/grants/${encodeURIComponent(need(rest[1], 'the key fingerprint'))}/revoke`, body: {} };
    }
    if (cmd === 'owners') {
      const { flags, positional } = parseArgs(rest, [], ['add', 'remove'], 1);
      const repo = need(positional[0], 'the repository id');
      if (flags.add) return { method: 'POST', path: `/v1/owner/${repo}/owners`, body: { public_key: readKey(flags.add) } };
      if (flags.remove) return { method: 'POST', path: `/v1/owner/${repo}/owners`, body: { fingerprint: flags.remove, remove: true } };
      throw new Error('baton owner owners REPO --add PUB | --remove FINGERPRINT');
    }
    if (cmd === 'bar' && rest[0] === 'lift') {
      parseArgs(rest.slice(3), [], [], 0);
      return { method: 'POST', path: `/v1/owner/${need(rest[1], 'the repository id')}/bars/${need(rest[2], 'the bar id')}/lift`, body: {} };
    }
    if (cmd === 'bar') {
      const { flags, positional } = parseArgs(rest, ['release-holders'], ['course', 'tag', 'legs', 'applies', 'starts-at', 'ends-at', 'reason'], 1);
      return { method: 'POST', path: `/v1/owner/${need(positional[0], 'the repository id')}/bars`, body: {
        course: need(flags.course, '--course'), tag: need(flags.tag, '--tag'), ...(flags.legs ? { legs: list(flags.legs) } : {}),
        applies: need(flags.applies, '--applies'), ...(flags['starts-at'] ? { starts_at: time(flags['starts-at'], '--starts-at') } : {}),
        ...(flags['ends-at'] ? { ends_at: time(flags['ends-at'], '--ends-at') } : {}), ...(flags['release-holders'] ? { release_holders: true } : {}),
        reason: need(flags.reason, '--reason'),
      } };
    }
    if (cmd === 'settings') {
      const { flags, positional, groups } = parseArgs(rest, ['no-required-bars'], ['required-bar', 'course', 'except', 'tag-prefix', 'retry', 'max-failed', 'transcript-repos', 'unblocked-workflow'], 1);
      const body = {};
      if (flags['no-required-bars']) {
        if (groups.length) throw new Error('--no-required-bars clears them: name no --required-bar beside it');
        body.required_bars = [];
      }
      if (groups.length) {
        body.required_bars = groups.map((g) => ({ course: need(g.course, '--course (after --required-bar)'), leg: g.leg, ...(g.except ? { except: list(g.except) } : {}), tag_prefix: need(g['tag-prefix'], '--tag-prefix (after --required-bar)') }));
      }
      // `--retry default` returns to Baton's default policy (R-BTN-23).
      if (flags.retry === 'default') body.retry = null;
      else if (flags.retry) body.retry = { backoff_ms: list(flags.retry).map(duration), max_failed: Number(need(flags['max-failed'], '--max-failed (with --retry)')) };
      if (flags['transcript-repos']) body.transcript_repos = list(flags['transcript-repos']);
      // R-BTN-77's trigger: a workflow path on GitHub, or `none` to clear it.
      if (flags['unblocked-workflow'] === 'none') body.unblocked_trigger = null;
      else if (flags['unblocked-workflow']) body.unblocked_trigger = { kind: 'github-app', workflow: flags['unblocked-workflow'] };
      if (!Object.keys(body).length) throw new Error('baton owner settings REPO names at least one setting');
      return { method: 'PUT', path: `/v1/owner/${need(positional[0], 'the repository id')}/settings`, body };
    }
    throw new Error('baton owner grant|revoke|owners|bar|settings');
  }
  throw new Error('baton admin … | baton owner …');
}

const GRANT_FLAGS = ['key', 'hostname', 'label', 'capabilities', 'max-tier'];

/** `--ci-identity` (R-BTN-93): none, github-actions, or a GitLab issuer (`gitlab-mirror:` when its
 *  mirror posts with the same identity). */
function ciIdentity(v) {
  if (v === 'none') return null;
  if (v === 'github-actions') return { kind: 'github-actions' };
  const m = /^gitlab(-mirror)?:(https:\/\/.+)$/.exec(v);
  if (m) return { kind: 'gitlab-ci', issuer: m[2], mirror: !!m[1] };
  throw new Error(`--ci-identity: none, github-actions, gitlab:<issuer> or gitlab-mirror:<issuer>, not ${v}`);
}

function grantBody(flags, readKey, extra) {
  return {
    ...extra, public_key: readKey(need(flags.key, '--key')), ...(flags.hostname ? { hostname: flags.hostname } : {}), ...(flags.label ? { label: flags.label } : {}),
    capabilities: list(flags.capabilities) ?? [], ...(flags['max-tier'] ? { max_tier: flags['max-tier'] } : {}),
  };
}

/** Send a planned request, signed with `keyFile`. Returns `{status, json}`. */
export async function send(url, p, keyFile, fetchImpl = fetch) {
  const key = signingKey(keyFile);
  const target = new URL(p.path, url).toString();
  const body = JSON.stringify(p.body ?? {});
  const headers = { 'Content-Type': 'application/json', ...signHeaders({ method: p.method, url: target, body, key }) };
  // A Baton that does not answer in 30 seconds is reported, never waited on for ever (round 3, 3-A-5).
  const res = await fetchImpl(target, { method: p.method, headers, body, signal: AbortSignal.timeout(30_000) });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function main(argv) {
  if (argv[0] === 'run') {
    // §6.13: the runner is TypeScript under src/runner; bundle it (a checkout runs the CLI with
    // its devDependencies), then run it in this process's stead.
    const { runMain } = await import('../scripts/baton-run.mjs');
    return runMain(argv.slice(1));
  }
  const [role, ...rest] = argv;
  const { flags } = parseArgs(rest.filter((_, i, a) => a[i] === '-i' || a[i - 1] === '-i' || a[i] === '--url' || a[i - 1] === '--url'));
  const args = rest.filter((_, i, a) => !(a[i] === '-i' || a[i - 1] === '-i' || a[i] === '--url' || a[i - 1] === '--url'));
  const p = plan(role, args);
  const { status, json } = await send(flags.url ?? process.env.BATON_URL ?? DEFAULT_URL, p, need(flags.identity, '-i KEY (the administrator or owner key file)'));
  if (role === 'admin' && args[0] === 'open' && json?.url) process.stdout.write(`${json.url}\n`);
  else process.stdout.write(`${JSON.stringify(json)}\n`);
  return status >= 200 && status < 300 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    process.stderr.write(`baton: ${e.message}\n`);
    process.exit(2);
  });
}
