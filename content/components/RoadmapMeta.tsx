import { useBundle, useCurrentEntry } from '@immediately-run/sdk';
import { Link } from '@immediately-run/sdk';
import { isItemMeta } from './roadmapLib';
import type { Meta } from './roadmapLib';
import StatusBadge from './StatusBadge';
import { PrLinks } from './ItemCard';

// `<RoadmapMeta>` — a work item's roadmap header: status badge, PROJECT CHIP, repo
// chips, tags and PR links. Placed by `roadmap/_layout.mdx` so every work item gets it
// with no per-entry markup; also available as an MDX component for explicit placement.
//
// The project chip is the ITEM→PROJECT direction of the bidirectional link (R3-226):
// it deep-links to `projects/<id>.mdx`, and the project page's own `<ProjectItems>`
// query supplies the reverse direction. Neither side is hand-listed.
//
// The project href is built from a BUNDLE-absolute path through the viewer's own
// mapping (`useBundle().toHref`) — never string-joined onto a content root here. A
// content component that knew where the bundle sits in the filesystem would be reading
// host knowledge it has no business holding, and would be wrong under dispatch.
export default function RoadmapMeta() {
  const current = useCurrentEntry<Meta>();
  const { toHref } = useBundle();
  const meta = current?.meta;
  if (!meta || !isItemMeta(meta)) return null;

  const repos: string[] = Array.isArray(meta.repos) ? meta.repos : [];
  const tags: string[] = Array.isArray(meta.tags)
    ? meta.tags.filter((t: string) => t !== 'roadmap-item' && !t.startsWith('ui/'))
    : [];
  const prs: string[] = Array.isArray(meta.prs) ? meta.prs : [];

  return (
    <div className="rm-meta">
      <StatusBadge status={meta.status} />
      {meta.project ? (
        <Link href={toHref(`/projects/${meta.project}.mdx`)} className="rm-chip" data-kind="project" title="Project">
          {meta.project}
        </Link>
      ) : null}
      {repos.map((r) => (
        <span key={r} className="rm-chip" data-kind="repo">{r}</span>
      ))}
      {tags.map((t) => (
        <span key={t} className="rm-chip" data-kind="tag">{t}</span>
      ))}
      <PrLinks prs={prs} />
    </div>
  );
}
