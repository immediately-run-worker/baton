import { useMemo } from 'react';
import { Link, useCurrentEntry } from '@immediately-run/sdk';
import { blockedByThis } from './roadmapLib';
import type { ItemRow, Meta } from './roadmapLib';
import { useRoadmapRows } from './useRoadmapRows';
import StatusBadge from './StatusBadge';

function Edge({ row }: { row: ItemRow }) {
  return (
    <Link href={row.href} className="rm-dep">
      <span className="rm-dep__id">{row.id}</span>
      <StatusBadge status={row.status} />
    </Link>
  );
}

// `<Dependencies>` — the DIRECTIONAL dependency graph for the current entry, the
// complement to `<Backlinks>` ("who mentions this", undirected).
//
//   • Blocked by — this item's own `depends_on`, each badged so you can see at a
//     glance whether a blocker has landed.
//   • Blocks     — the reverse edge, COMPUTED by querying items whose `depends_on`
//     names this id. Never stored, so the two directions cannot disagree.
//
// `depends_on` is seeded by the generator from the corpus's own prose convention
// ("Depends on R3-188 + R3-189") — see `scripts/lib/wiki.mjs` `seedDependsOn` — so the
// graph is real today rather than waiting for anyone to hand-annotate 260 entries.
// Renders nothing when the item has no edges in either direction.
export default function Dependencies({ id }: { id?: string }) {
  const current = useCurrentEntry<Meta>();
  const currentPath = current?.path ?? null;
  const rows = useRoadmapRows();

  const { blockedBy, blocks } = useMemo(() => {
    const self = id ? rows.find((r) => r.id === id) : rows.find((r) => r.path === currentPath);
    if (!self) return { blockedBy: [] as ItemRow[], blocks: [] as ItemRow[] };
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      blockedBy: self.dependsOn.map((d) => byId.get(d)).filter((r): r is ItemRow => Boolean(r)),
      blocks: blockedByThis(rows, self.id),
    };
  }, [rows, currentPath, id]);

  if (!blockedBy.length && !blocks.length) return null;

  return (
    <aside className="rm-deps">
      {blockedBy.length ? (
        <div className="rm-deps__group" data-dir="blocked-by">
          <span className="rm-deps__h">Blocked by</span>
          {blockedBy.map((r) => <Edge key={r.path} row={r} />)}
        </div>
      ) : null}
      {blocks.length ? (
        <div className="rm-deps__group" data-dir="blocks">
          <span className="rm-deps__h">Blocks</span>
          {blocks.map((r) => <Edge key={r.path} row={r} />)}
        </div>
      ) : null}
    </aside>
  );
}
