// vocabulary.mjs — the claim vocabulary as pure data (R3-1205, BATON_SPEC §3).
//
// The names an item's `Requires:` clause may carry, what a role expands to, the routing
// tiers and what the autonomous line holds. They lived in `check-roadmap-requires.mjs` and
// `lib/workQueues.mjs`, which both reach `node:fs`; Baton's Worker bundles this module and
// `lib/baton.mjs`, so neither may import `node:` anything. Both old modules re-export these
// same objects, so every existing import keeps working.

/** The CAPABILITY vocabulary (2026-09-22, the owner's model): what an item NEEDS,
 * mechanism-free. Roles (below) FULFILL capabilities; an item's clause names
 * capabilities, never the venue that happens to provide them — so a second
 * provider (AV-5's emulator venue, AV-7's MCP chrome) needs no re-sweep. */
export const CAPABILITIES = [
  'authentication', // a signed-in product session (the OAuth round-trip is done)
  'llm-call', // a working provider round (key + transport, relayed or browser-direct)
  'create-pr', // a GitHub write identity (fork/branch/PR)
  'drivable-browser', // an agent-driven Chromium with network/console observation
];

/** The ROLE vocabulary: what an agent may HOLD. A role's expansion is the
 * capability set it fulfills; the claim rule is item.requires ⊆ capabilities(roles). */
export const ROLES = {
  'agent-venue': ['authentication', 'llm-call', 'create-pr', 'drivable-browser'],
  'human-operator': ['authentication', 'llm-call', 'create-pr', 'drivable-browser'],
};

/** The LEGACY resource vocabulary — valid in clauses through the R3-673
 * translation sweep, retired when the last live item carries capabilities. */
export const RESOURCES = [
  'none',
  'terraform',
  'npm-publish',
  // A NEW package's first publish: the trusted-publisher binding on npmjs.com is set by a
  // scope admin by hand. A version bump of an existing package is `npm-publish`, which the
  // agent line holds (bump + merge; CI publishes through OIDC after the release approval).
  'npm-scope-admin',
  'mcp-chrome',
  'local-host',
  'real-iphone',
  'gcloud-admin',
  'github-admin',
  // BATON_SPEC (2026-10-13): authority on the Cloudflare account behind
  // baton.immediately.run — Workers, Durable Objects, DNS routes, Access, the plan.
  'cloudflare-admin',
  // BATON_SPEC: a session registered with Baton — a worker token for its host and a
  // running sidecar. Agent-held once the fleet is provisioned (AGENT_HOLDS).
  'baton-worker',
  'human-operator',
  // R3-671/672: the standing venue — a ROLE per the 2026-09-22 model; clause-valid
  // during the sweep (items still naming it translate to capabilities).
  'agent-venue',
];

/** Every name a clause may carry during the transition: capabilities, roles
 * (legacy-shaped), and resources. */
export const CLAUSE_NAMES = [...new Set([...CAPABILITIES, ...Object.keys(ROLES), ...RESOURCES])];

/** What the autonomous line HOLDS: the four capabilities, the standing agent venue, and the
 *  legacy names the venue fulfills. An item that needs anything else (`human-operator`,
 *  `real-iphone`, `npm-scope-admin`, `github-admin`, `gcloud-admin`, `terraform`) cannot be
 *  finished by an agent today, so it waits on the operator. Moving a name INTO this set is
 *  how the operator queue shrinks for good.
 *
 *  `npm-publish` moved in on 2026-09-27 (process-control/03 §7): a version bump is an agent's
 *  bump-and-merge, CI publishes through OIDC, and the one human act, approving the run's
 *  `production` environment, is the `awaiting-release-approval` delivery buffer (lib/workQueues.mjs), not a
 *  work item. A new package's first publish still needs a person (`npm-scope-admin`). */
export const AGENT_HOLDS = new Set([...CAPABILITIES, 'agent-venue', 'mcp-chrome', 'local-host', 'npm-publish', 'baton-worker', 'none']);

/** The routing tiers, in rank order: what a claimant on a cheaper model line may take
 *  (R3-1193). `routine` is one repo with every symbol named; `judgement` spans repos, adds
 *  module-level state or leaves a decision open; `critical` touches a security boundary, a
 *  protocol or a stated invariant. The rule that sets it is step 10 of the
 *  draft-roadmap-item skill. This is the one home of the list: the two schemas carry the
 *  same enum, and a test pins them to it. */
export const TIERS = ['routine', 'judgement', 'critical'];

/** Whether an item of `itemTier` may be claimed under the ceiling `ceiling`, in `ladder` — a
 *  repository's tiers, lowest first (BATON_SPEC R-BTN-66; docs' is TIERS). An item with no
 *  tier counts as the top: an unlabelled item handed to a cheap line is the failure the tier
 *  exists to prevent. An unknown item tier fits nothing; an unknown ceiling throws — never
 *  "no filter". */
export function fitsTier(itemTier, ceiling, ladder = TIERS) {
  const c = ladder.indexOf(ceiling);
  if (c < 0) throw new Error(`unknown tier ceiling "${ceiling}" — one of ${ladder.join(', ')}`);
  const t = itemTier == null ? ladder.length - 1 : ladder.indexOf(itemTier);
  return t >= 0 && t <= c;
}

/**
 * The capabilities a set of declared names fulfils (BATON_SPEC §7.2 rule 4). A role expands
 * through `ROLES`; any other name (a capability, or a legacy resource such as `mcp-chrome`)
 * matches only itself; `none` contributes nothing, since every worker satisfies it. Used on
 * both sides of the claim rule: `requires ⊆ capabilitiesOf(declared)` compares the item's
 * expanded clause with the worker's expanded declaration.
 */
export function capabilitiesOf(declared) {
  const out = new Set();
  for (const name of declared ?? []) {
    if (name === 'none') continue;
    if (Object.hasOwn(ROLES, name)) for (const c of ROLES[name]) out.add(c);
    else out.add(name);
  }
  return out;
}
