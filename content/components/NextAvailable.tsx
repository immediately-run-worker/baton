import { useMemo } from 'react';
import { nextAvailable } from './roadmapLib';
import { useBundleReady, useRoadmapRows } from './useRoadmapRows';
import ItemCard from './ItemCard';

// `<NextAvailable>` — `roadmap/next-available.sh` as a live query: the first READY
// `status: available` item (every `depends_on` done — the ready gate in roadmapLib),
// `EXPEDITE`-tagged items ahead of the rest, then execution order: the one an agent may
// claim. A blocked item is never shown here, however low its `order:`.
//
// The script walks the index top-to-bottom and prints the first available item; the
// `order:` field IS that execution order, so sorting by it reproduces the script's
// answer from the same underlying data. Two views of one source, never a second list.
export default function NextAvailable({ limit }: { limit?: string | number }) {
  const rows = useRoadmapRows();
  const ready = useBundleReady();
  const n = Math.max(1, Number(limit) || 1);
  const picks = useMemo(() => nextAvailable(rows, n), [rows, n]);

  if (!ready) return <div className="rm-next" data-loading="1"><div className="sk sk-line" /></div>;

  if (!picks.length) {
    return (
      <div className="rm-next" data-empty="1">
        <span className="rm-next__h">Next available</span>
        <p className="rm-col__empty">Nothing available — every live item is claimed or parked.</p>
      </div>
    );
  }

  return (
    <div className="rm-next">
      <span className="rm-next__h">Next available{picks.length > 1 ? ` (${picks.length})` : ''}</span>
      {picks.map((r) => <ItemCard key={r.path} row={r} />)}
    </div>
  );
}
