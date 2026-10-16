// Pure helpers for the roadmap surfaces — no React, no components (the Fast-Refresh
// rule: a module exporting a component exports only components). The board, dependency
// graph, next-available card, item header and project views all read the SAME projection
// from here, so "what is a roadmap item" is defined once.
//
// **What changed when this moved out of the Grove fork and into the corpus (R3-174).**
// Two things, and both are the point rather than incidental damage:
//
//  1. **Rows are built from `useBundleEntries()`, not from the raw metadata store.** The
//     store is keyed by ABSOLUTE module path, which under dispatch means
//     `/mnt/<hash>/roadmap/R3-174.mdx` — a host-minted chroot that is not stable across
//     loads and that content must never publish. The bundle scope hands out
//     bundle-absolute paths (`/roadmap/R3-174.mdx`) instead, identical under fork,
//     library and dispatch composition (`PLATFORM_LAYERING_SPEC` §1.1).
//  2. **A row carries its own `href`.** Bundle-path→URL is the VIEWER's policy and the
//     packagings genuinely disagree about it, so the viewer supplies the mapping and
//     nothing here computes a URL. That is what lets these components render correctly in
//     a viewer this corpus has never heard of.

import type { BundleEntry } from '@immediately-run/sdk';
import { byStatusOrder } from './roadmapData';

/** One roadmap entry, projected out of the frontmatter index. */
export type ItemRow = {
  /** Bundle-absolute path (`/roadmap/R3-174.mdx`) — never the mount path. */
  path: string;
  /** Where to navigate for this item, per the viewer's mapping. */
  href: string;
  id: string;
  title: string;
  status: string;
  project: string;
  repos: string[];
  tags: string[];
  order: number;
  prs: string[];
  dependsOn: string[];
  /** The resources the item's `Requires:` clause names, in clause order. Empty when the
   *  item carries no clause — an absent clause means "not recorded", which is a different
   *  fact from the explicit `['none']` that means "checked, nothing needed" (R3-646). */
  requires: string[];
  archived: boolean;
};

/**
 * The resources a `description:`'s `Requires:` clause names, or `[]` when there is none.
 *
 * SECOND COPY, DELIBERATELY. The first is `requiredResources` in
 * `scripts/check-roadmap-requires.mjs`, which gates the board in `verify`. Neither can
 * import the other: that one is node ESM outside the bundle, this one ships INSIDE the
 * corpus bundle and must not path into the viewer's filesystem (`MDX_FROM_MOUNT_SPEC` §2).
 * The divergence that would matter — one accepting a clause the other rejects — is pinned
 * by the same fixture strings asserted on both sides (`src/test/roadmap.test.ts` here,
 * the script's `--self-test` there). Change one, change both.
 *
 * The LAST occurrence wins, not the first: a description may legitimately discuss the
 * mechanism before carrying its own clause, and matching the first hit reads that prose as
 * a resource list.
 */
export function requiredResources(description: unknown): string[] {
  if (typeof description !== 'string') return [];
  const all = [...description.matchAll(/Requires:\s*([^.]*)\./g)];
  if (all.length === 0) return [];
  return all[all.length - 1][1]
    .split(',')
    .map((r) => r.trim().replace(/^`|`$/g, ''))
    .filter(Boolean);
}

// The frontmatter index is untyped by nature; each field is narrowed at use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Meta = Record<string, any>;

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : [];

/**
 * Is this bundle path a readable entry?
 *
 * The engine applies the same rule to decide what to route and list; it is restated here
 * (rather than imported) because a content component must not path into the viewer's
 * filesystem — that is the two-filesystem rule in `MDX_FROM_MOUNT_SPEC` §2, and it is what
 * keeps this corpus renderable by a viewer that never heard of it. The rule itself is
 * three lines and is pinned by this corpus's own checker.
 */
export function isEntryPath(path: string): boolean {
  if (!/\.mdx?$/.test(path)) return false;
  return !(path.split('/').pop() || '').startsWith('_');
}

/**
 * Is this a bundle path under the frozen archive?
 *
 * Archiving moved the file; `reconcile-merged-items.mjs` never sets a tag. The
 * `archived` flag is derived from the one fact archiving actually changes — the path —
 * so nothing has to remember a second step. The substring answers both path shapes
 * (the bundle tree hands out `/roadmap/archive/R3-174.mdx`; the docs viewer keys on
 * `/app/content/roadmap/archive/R3-174.mdx`).
 */
export function isArchivedPath(path: string): boolean {
  return path.includes('/roadmap/archive/');
}

/** Is this metadata entry a roadmap work item (live or archived)? */
export function isItemMeta(meta: Meta | undefined): boolean {
  return Array.isArray(meta?.tags) && meta.tags.includes('roadmap-item');
}

/** The project id an entry DESCRIBES: its own `id` when it is a `kind: project` page,
 *  else `''`. The empty string is the gate every project surface reads — a page that
 *  is not a project entity has no members to show, so its chrome renders nothing. */
export function projectIdOf(meta: Meta | undefined): string {
  return meta?.kind === 'project' ? String(meta.id ?? '') : '';
}

/** Project one bundle entry as a row. Lists stay lists — frontmatter carries any JSON
 *  value, so nothing is encoded and nothing has to be decoded. */
export function toRow(entry: BundleEntry<Meta>): ItemRow {
  const meta = entry.meta;
  const tags = list(meta.tags);
  return {
    path: entry.path,
    href: entry.href,
    id: meta.id ?? '',
    title: meta.title ?? '',
    status: meta.status ?? '',
    project: meta.project ?? '',
    repos: list(meta.repos),
    tags,
    order: Number(meta.order ?? 9999) || 9999,
    prs: list(meta.prs),
    dependsOn: list(meta.depends_on),
    requires: requiredResources(meta.description),
    archived: isArchivedPath(entry.path),
  };
}

/** Every roadmap work item in the bundle, as rows in path order. */
export function itemRows(entries: BundleEntry<Meta>[]): ItemRow[] {
  return entries.filter((e) => isEntryPath(e.path) && isItemMeta(e.meta)).map(toRow);
}

/** Reading-order sort: by `order`, then by id, so a board column is stable. */
export function byOrder(a: ItemRow, b: ItemRow): number {
  return a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Bucket rows by a field, returning groups in lifecycle order for `status` and
 *  alphabetically otherwise. An item with N values for the field (repos, tags)
 *  appears in N buckets. */
export function groupRows(rows: ItemRow[], groupBy: string): { key: string; rows: ItemRow[] }[] {
  const buckets = new Map<string, ItemRow[]>();
  const push = (k: string, r: ItemRow) => {
    const cur = buckets.get(k);
    if (cur) cur.push(r);
    else buckets.set(k, [r]);
  };
  for (const r of rows) {
    if (groupBy === 'repo') {
      if (!r.repos.length) push('—', r);
      else for (const repo of r.repos) push(repo, r);
    } else if (groupBy === 'tag') {
      const own = r.tags.filter((t) => t !== 'roadmap-item');
      if (!own.length) push('—', r);
      else for (const t of own) push(t, r);
    } else if (groupBy === 'project') {
      push(r.project || 'unclustered', r);
    } else {
      push(r.status || 'unknown', r);
    }
  }
  const keys = [...buckets.keys()];
  keys.sort(groupBy === 'status' ? byStatusOrder : (a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => ({ key, rows: [...(buckets.get(key) ?? [])].sort(byOrder) }));
}

// ─── Work queues and the ready gate ─────────────────────────────────────────────────────
//
// COPY, DELIBERATELY. The canonical rule is `queueOf` / `AGENT_HOLDS` in
// `scripts/lib/workQueues.mjs` (node ESM, outside the bundle), plus the ready gate the
// claim tooling applies over `depends_on`. Neither side can import the other — this module
// ships INSIDE the corpus bundle and must not path into the viewer's filesystem
// (`MDX_FROM_MOUNT_SPEC` §2) — so the two copies are held to one rule by the shared fixture
// `scripts/lib/__fixtures__/queue-rule.json`, run through this copy by
// `src/test/roadmap.test.ts` and through the node copy by the scripts' own test. Change one,
// change both, and add the case to the fixture.

/** What the autonomous line HOLDS — the capabilities an agent session has, the standing
 *  agent venue and the legacy names it fulfills. A `Requires:` name outside this set means
 *  the item waits on the operator. Mirrors `AGENT_HOLDS` in `scripts/lib/workQueues.mjs`. */
export const AGENT_HOLDS: readonly string[] = [
  'authentication',
  'llm-call',
  'create-pr',
  'drivable-browser',
  'agent-venue',
  'mcp-chrome',
  'local-host',
  'npm-publish',
  'none',
];

export type Queue = 'expedite' | 'operator' | 'autonomous';

/** Which queue an item waits in: the `EXPEDITE` tag jumps both lines; the `OP` tag, or any
 *  required resource the agent line does not hold, means the operator; else autonomous. */
export function queueOf(row: { tags?: string[] | null; requires?: string[] | null }): Queue {
  const tags = row.tags ?? [];
  if (tags.includes('EXPEDITE')) return 'expedite';
  if (tags.includes('OP')) return 'operator';
  if ((row.requires ?? []).some((r) => !AGENT_HOLDS.includes(r))) return 'operator';
  return 'autonomous';
}

/** What the ready gate needs to know about every other item: the status of each LIVE item
 *  and the ids of the archived ones. Built once per row set by `readyIndex`. */
export type ReadyIndex = { live: ReadonlyMap<string, string>; archived: ReadonlySet<string> };

/** The ready gate's lookup table over a full row set (live and archived). An id that is
 *  archived counts as archived even if a stray live copy exists — the archive is terminal. */
export function readyIndex(rows: ItemRow[]): ReadyIndex {
  const live = new Map<string, string>();
  const archived = new Set<string>();
  for (const r of rows) {
    if (!r.id) continue;
    if (r.archived) archived.add(r.id);
    else live.set(r.id, r.status);
  }
  return { live, archived };
}

/** Is dependency `id` done: archived, or live with status `done` / `superseded`? A live
 *  dependency in any other status, or one that cannot be found at all, is not. */
function depDone(id: string, index: ReadyIndex): boolean {
  if (index.archived.has(id)) return true;
  const status = index.live.get(id);
  return status === 'done' || status === 'superseded';
}

/** The ready gate: an `available` item is READY when every `depends_on` id (its own id
 *  ignored) is done. Anything not `available` is never ready. */
export function isReady(row: Pick<ItemRow, 'id' | 'status' | 'dependsOn'>, index: ReadyIndex): boolean {
  if (row.status !== 'available') return false;
  return row.dependsOn.every((d) => d === row.id || depDone(d, index));
}

export type QueueRollup = { autonomous: number; operator: number; expedite: number; blocked: number; inFlight: number };

/** The queue view of a member set (a project's items, the unclustered items):
 *  READY available items counted by queue, available items the ready gate holds as
 *  `blocked`, and `in-progress` + `in-review` as `inFlight`. Archived members are skipped.
 *  `index` must be built over the FULL row set — a dependency may live in another project. */
export function queueRollup(members: ItemRow[], index: ReadyIndex): QueueRollup {
  const out: QueueRollup = { autonomous: 0, operator: 0, expedite: 0, blocked: 0, inFlight: 0 };
  for (const r of members) {
    if (r.archived) continue;
    if (r.status === 'in-progress' || r.status === 'in-review') out.inFlight++;
    else if (r.status === 'available') {
      if (isReady(r, index)) out[queueOf(r)]++;
      else out.blocked++;
    }
  }
  return out;
}

/** The next claimable items — the live equivalent of `roadmap/next-available.sh`. Only
 *  READY available items (the ready gate above); `EXPEDITE`-tagged items first, then
 *  execution order. Archived entries are never claimable. */
export function nextAvailable(rows: ItemRow[], limit = 1): ItemRow[] {
  const index = readyIndex(rows);
  const expedite = (r: ItemRow) => (r.tags.includes('EXPEDITE') ? 0 : 1);
  return rows
    .filter((r) => !r.archived && isReady(r, index))
    .sort((a, b) => expedite(a) - expedite(b) || byOrder(a, b))
    .slice(0, limit);
}

/** The reverse dependency edge: items whose `depends_on` names `id`. */
export function blockedByThis(rows: ItemRow[], id: string): ItemRow[] {
  return rows.filter((r) => r.dependsOn.includes(id)).sort(byOrder);
}

/** A count-by-status rollup, in lifecycle order — `<ProjectMeta>`'s informational
 *  summary. Deliberately NOT a project's own status (which is author-set). */
export function statusRollup(rows: ItemRow[]): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => byStatusOrder(a[0], b[0]))
    .map(([status, count]) => ({ status, count }));
}

/** A GitHub URL for a `owner/repo#123` PR reference, or null if it isn't one. */
export function prUrl(ref: string): string | null {
  const m = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (m) return `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`;
  return /^https?:\/\//.test(ref) ? ref : null;
}

/** A short label for a PR reference (`owner/repo#12` → `repo#12`). */
export function prLabel(ref: string): string {
  const m = ref.match(/^[\w.-]+\/([\w.-]+)#(\d+)$/);
  if (m) return `${m[1]}#${m[2]}`;
  const n = ref.match(/\/pull\/(\d+)/);
  return n ? `#${n[1]}` : ref;
}
