import { useMemo } from 'react';
import { useCurrentEntry } from '@immediately-run/sdk';
import { statusRollup } from './roadmapLib';
import type { Meta } from './roadmapLib';
import { statusLabel } from './roadmapData';
import './roadmap.css';
import { useRoadmapRows } from './useRoadmapRows';
import { useProjectId } from './useProjectId';

// `<ProjectMeta>` — a project header's INFORMATIONAL rollup: how many member items
// sit in each status.
//
// This is deliberately **not** the project's own `status`. A project's lifecycle
// (`active` / `proposed` / `paused` / `complete` / `superseded`) is author-set and
// says what the team intends; the rollup is derived and says where the work stands.
// Conflating them would make one of the two silently wrong, so both are shown, and
// the author-set value is labelled as such (`projects/index.mdx`).
export default function ProjectMeta({ project }: { project?: string }) {
  const current = useCurrentEntry<Meta>();
  const id = useProjectId(project);
  const rows = useRoadmapRows();

  const { rollup, total } = useMemo(() => {
    const members = rows.filter((r) => r.project === id);
    return { rollup: statusRollup(members), total: members.length };
  }, [rows, id]);

  if (!id) return null;
  const ownStatus = current?.meta?.status;

  return (
    <div className="rm-projectmeta">
      {ownStatus ? (
        <span className="rm-badge" data-status={ownStatus} title="the project's own author-set lifecycle">
          {ownStatus}
        </span>
      ) : null}
      <span className="rm-projectmeta__rollup" title="rollup of member item statuses (derived)">
        {total} item{total === 1 ? '' : 's'}
        {rollup.map((r) => (
          <span key={r.status} className="rm-chip" data-kind="rollup" data-status={r.status}>
            {r.count} {statusLabel(r.status).toLowerCase()}
          </span>
        ))}
      </span>
    </div>
  );
}
