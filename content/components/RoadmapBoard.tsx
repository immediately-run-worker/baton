import { useMemo } from 'react';
import { groupRows } from './roadmapLib';
import { statusLabel } from './roadmapData';
import { useBundleReady, useRoadmapRows } from './useRoadmapRows';
import ItemCard from './ItemCard';

interface Props {
  groupBy?: 'status' | 'project' | 'repo' | 'tag';
  /** Extra tag AND-filter, e.g. `SEC`. */
  filterTag?: string;
  /** Comma-separated subset/order override for the groups shown. */
  statuses?: string;
  /** `live` (default) hides archived entries; `archive` shows only them; `all` both. */
  scope?: 'live' | 'archive' | 'all';
}

// `<RoadmapBoard>` — the whole replacement for a hand-maintained roadmap index: a
// live, grouped board over every `roadmap-item` entry. Nothing here is listed by
// hand, so an item added under `roadmap/` appears with no page edit — the anti-drift
// rule that keeps the board a query, not a list (ways_of_working §9).
export default function RoadmapBoard({ groupBy = 'status', filterTag, statuses, scope = 'live' }: Props) {
  const rows = useRoadmapRows();
  const ready = useBundleReady();

  const groups = useMemo(() => {
    let scoped = rows;
    if (scope === 'live') scoped = scoped.filter((r) => !r.archived);
    else if (scope === 'archive') scoped = scoped.filter((r) => r.archived);
    if (filterTag) scoped = scoped.filter((r) => r.tags.includes(filterTag));
    const grouped = groupRows(scoped, groupBy);
    if (!statuses) return grouped;
    // An explicit subset also fixes the order — the author's list wins.
    const wanted = statuses.split(',').map((s) => s.trim()).filter(Boolean);
    return wanted.map((k) => grouped.find((g) => g.key === k) ?? { key: k, rows: [] });
  }, [rows, groupBy, filterTag, statuses, scope]);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  if (!ready) {
    return (
      <div className="rm-board" data-loading="1">
        {[0, 1, 2].map((i) => (
          <div className="rm-col" key={i}>
            <div className="sk sk-line" />
            <div className="sk sk-line" />
          </div>
        ))}
      </div>
    );
  }

  if (!total) return <p className="grove-search__empty">No items match.</p>;

  return (
    <div className="rm-board" data-group={groupBy}>
      {groups.map((g) => (
        <section className="rm-col" key={g.key} data-status={groupBy === 'status' ? g.key : undefined}>
          <header className="rm-col__h">
            <span className="rm-col__t">{groupBy === 'status' ? statusLabel(g.key) : g.key}</span>
            <span className="rm-col__n">{g.rows.length}</span>
          </header>
          <div className="rm-col__body">
            {g.rows.map((r) => (
              <ItemCard key={r.path} row={r} showStatus={groupBy !== 'status'} />
            ))}
            {g.rows.length === 0 ? <p className="rm-col__empty">None</p> : null}
          </div>
        </section>
      ))}
    </div>
  );
}
