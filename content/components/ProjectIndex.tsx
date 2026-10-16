import { useMemo } from 'react';
import { Link, useBundleEntries } from '@immediately-run/sdk';
import { isEntryPath, queueRollup, readyIndex, statusRollup } from './roadmapLib';
import type { Meta } from './roadmapLib';
import { statusLabel } from './roadmapData';
import { useBundleReady, useRoadmapRows } from './useRoadmapRows';
import InlineProse from './InlineProse';
import ItemCard from './ItemCard';
import QueueChips from './QueueChips';

// `<ProjectIndex>` — the project-level view of the work: every Project entity with
// its derived status rollup and queue rollup (`queueRollup`: ready work by queue, work
// the ready gate holds, work in flight), plus the **unclustered** view (live items carrying no
// `project:`, which the projects index explicitly allows).
//
// A live query over both `kind: project` entities and `roadmap-item` entries, so a
// new project file or a re-clustered item shows up with no page edit.
export default function ProjectIndex({ showUnclustered = 'true' }: { showUnclustered?: string }) {
  const entries = useBundleEntries<Meta>();
  const itemRows = useRoadmapRows();
  const ready = useBundleReady();

  const { projects, unclustered, unclusteredQueues } = useMemo(() => {
    // Built over EVERY row, archived included: a member's dependency may be archived or
    // live in another project, and the ready gate has to see it either way.
    const index = readyIndex(itemRows);
    const items = itemRows.filter((r) => !r.archived);
    const byProject = new Map<string, typeof items>();
    for (const r of items) {
      const k = r.project || '';
      const cur = byProject.get(k);
      if (cur) cur.push(r);
      else byProject.set(k, [r]);
    }
    const list = entries
      .filter((e) => isEntryPath(e.path) && e.meta?.kind === 'project')
      .map((e) => {
        const id = String(e.meta.id ?? '');
        const members = byProject.get(id) ?? [];
        return {
          key: e.path,
          href: e.href,
          id,
          title: String(e.meta.title ?? ''),
          status: String(e.meta.status ?? ''),
          description: String(e.meta.description ?? ''),
          count: members.length,
          rollup: statusRollup(members),
          queues: queueRollup(members, index),
        };
      });
    // Most-active first, then alphabetical — an empty project sinks to the bottom.
    list.sort((a, b) => b.count - a.count || (a.title < b.title ? -1 : 1));
    const loose = byProject.get('') ?? [];
    return { projects: list, unclustered: loose, unclusteredQueues: queueRollup(loose, index) };
  }, [entries, itemRows]);

  if (!ready) return <div className="rm-projects" data-loading="1"><div className="sk sk-line" /></div>;

  return (
    <>
      <div className="rm-projects">
        {projects.map((p) => (
          <Link key={p.key} href={p.href} className="rm-project" data-status={p.status}>
            <div className="rm-project__top">
              <span className="rm-project__t">
                <InlineProse text={p.title || p.id} />
              </span>
              <span className="rm-badge" data-status={p.status}>{p.status}</span>
            </div>
            {p.description ? (
              <div className="rm-project__d">
                <InlineProse text={p.description} />
              </div>
            ) : null}
            <div className="rm-card__meta">
              <span className="rm-chip" data-kind="count">{p.count} item{p.count === 1 ? '' : 's'}</span>
              {p.rollup.map((r) => (
                <span key={r.status} className="rm-chip" data-kind="rollup" data-status={r.status}>
                  {r.count} {statusLabel(r.status).toLowerCase()}
                </span>
              ))}
              <QueueChips rollup={p.queues} />
            </div>
          </Link>
        ))}
      </div>
      {showUnclustered !== 'false' ? (
        <section className="rm-unclustered">
          <header className="rm-col__h">
            <span className="rm-col__t">Unclustered</span>
            <span className="rm-col__n">{unclustered.length}</span>
          </header>
          {unclustered.length ? (
            <div className="rm-card__meta">
              <QueueChips rollup={unclusteredQueues} />
            </div>
          ) : null}
          {unclustered.length ? (
            <div className="rm-col__body">
              {unclustered.map((r) => <ItemCard key={r.path} row={r} showStatus />)}
            </div>
          ) : (
            <p className="rm-col__empty">Every live item belongs to a project.</p>
          )}
        </section>
      ) : null}
    </>
  );
}
