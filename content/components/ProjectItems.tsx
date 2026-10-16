import { useMemo } from 'react';
import { groupRows } from './roadmapLib';
import { statusLabel } from './roadmapData';
import { useBundleReady, useRoadmapRows } from './useRoadmapRows';
import { useProjectId } from './useProjectId';
import ItemCard from './ItemCard';

interface Props {
  /** The project id. Defaults to the current page's own `id` when it is a project. */
  project?: string;
  groupBy?: 'status' | 'repo' | 'tag';
  /** `live` (default) hides archived members; `archive` only them; `all` both. */
  scope?: 'live' | 'archive' | 'all';
}

// `<ProjectItems>` — a Project's members, live.
//
// **Membership is the ITEM's own `project:` field — the single source of truth.** This
// component is the query over it, so a project page NEVER hand-lists its items: add
// `project: <id>` to a new item and it appears here with no page edit. That is the
// same anti-drift rule that makes the roadmap board a query rather than a list
// (`projects/index.mdx`, ways_of_working §9).
export default function ProjectItems({ project, groupBy = 'status', scope = 'live' }: Props) {
  const id = useProjectId(project);
  const rows = useRoadmapRows();
  const ready = useBundleReady();

  const groups = useMemo(() => {
    if (!id) return [];
    let members = rows.filter((r) => r.project === id);
    if (scope === 'live') members = members.filter((r) => !r.archived);
    else if (scope === 'archive') members = members.filter((r) => r.archived);
    return groupRows(members, groupBy);
  }, [rows, id, groupBy, scope]);

  const total = groups.reduce((n, g) => n + g.rows.length, 0);

  if (!id) return <p className="grove-search__empty">No project named — pass <code>project="…"</code>.</p>;
  if (!ready) return <div className="rm-board" data-loading="1"><div className="sk sk-line" /></div>;
  if (!total) {
    return (
      <p className="grove-search__empty">
        No items carry <code>project: {id}</code> yet.
      </p>
    );
  }

  return (
    <div className="rm-board" data-group={groupBy} data-project={id}>
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
          </div>
        </section>
      ))}
    </div>
  );
}
