// The roadmap vocabulary — data, not components.
//
// CORPUS FURNITURE (R3-174): this file and its neighbours live in the CONTENT repo, not
// in the Grove engine, because every one of them encodes THIS corpus's frontmatter
// conventions — `status:`, `project:`, `prs:`, `depends_on:` mean something only to an
// engineering roadmap (`grove/docs/ENGINE_BOUNDARY.md` §3). They are declared in
// `content/immediately.run.json` and registered by whichever viewer renders this corpus,
// so `<RoadmapBoard/>` works with no engine fork.
//
// Kept out of the component files deliberately: a module that exports a React
// component must export ONLY components or Fast Refresh stops working. `<RoadmapBoard>`,
// `<StatusBadge>`, `<NextAvailable>`, `<Dependencies>`, `<RoadmapMeta>` and
// `<ProjectItems>` all read their ordering and labels from here.
//
// The status enum itself is owned by `context/ways_of_working.md` §9 and enforced by
// `scripts/check-docs-wiki.mjs`; this module is the RENDERING view of it (order +
// human label), never a second source of truth for which values are legal.

/** A work item's lifecycle state. `done` is the archive's frozen terminal value. */
export type ItemStatus =
  | 'available'
  | 'in-progress'
  | 'in-review'
  /** @deprecated 2026-08-27 — the protocol no longer produces this; see check-docs-wiki.mjs. */
  | 'done'
  | 'deferred'
  | 'deprioritized'
  | 'superseded';

/** Board column order: the lifecycle left-to-right, parked states last. */
export const STATUS_ORDER: ItemStatus[] = [
  'available',
  'in-progress',
  'in-review',
  // Deprecated inbound alias — kept in the order so the handful of items still carrying
  // it render in the right column during the transition window rather than falling to the
  // unknown-status tail.
  'done',
  'deferred',
  'deprioritized',
  'superseded',
];

export const STATUS_LABEL: Record<ItemStatus, string> = {
  available: 'Available',
  'in-progress': 'In progress',
  'in-review': 'In review',
  done: 'Done',
  deferred: 'Deferred',
  deprioritized: 'Deprioritized',
  superseded: 'Superseded',
};

/** The one claimable state — what `roadmap/next-available.sh` looks for. */
export const CLAIMABLE: ItemStatus = 'available';

/** A project's own author-set lifecycle (NOT a rollup of its items' statuses). */
export const PROJECT_STATUS_ORDER = ['active', 'proposed', 'paused', 'complete', 'superseded'] as const;

/** Order an arbitrary status list by the lifecycle, unknown values last (stable). */
export function byStatusOrder(a: string, b: string): number {
  const ia = STATUS_ORDER.indexOf(a as ItemStatus);
  const ib = STATUS_ORDER.indexOf(b as ItemStatus);
  return (ia === -1 ? STATUS_ORDER.length : ia) - (ib === -1 ? STATUS_ORDER.length : ib);
}

/** A human label for a status, falling back to the raw value. */
export function statusLabel(status: string): string {
  return STATUS_LABEL[status as ItemStatus] ?? status;
}
