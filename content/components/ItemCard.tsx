import { Link } from '@immediately-run/sdk';
import './roadmap.css';
import type { ItemRow } from './roadmapLib';
import { prLabel, prUrl } from './roadmapLib';
import InlineProse from './InlineProse';
import StatusBadge from './StatusBadge';

// One work item as a card — the shared cell of `<RoadmapBoard>`, `<ProjectItems>`
// and `<NextAvailable>`, so a board card and a project card can never drift apart.
// Pure presentation over an already-projected row; no queries of its own.
//
// The href comes off the ROW, not from a path helper here (R3-174): corpus-path→URL is
// the viewer's policy, and a content component that computed its own would be right in
// exactly one packaging.
export default function ItemCard({ row, showStatus = false }: { row: ItemRow; showStatus?: boolean }) {
  // The generated title is `R3-217 — <headline>`; the id is its own chip, so drop the
  // duplicated prefix rather than printing the id twice on every card.
  const headline = row.title.replace(new RegExp(`^${row.id}\\s*[—-]\\s*`), '') || row.title;
  const chips = row.tags.filter((t) => t !== 'roadmap-item');
  return (
    <Link href={row.href} className="rm-card" data-status={row.status}>
      <div className="rm-card__top">
        <span className="rm-card__id">{row.id}</span>
        {showStatus ? <StatusBadge status={row.status} /> : null}
      </div>
      <div className="rm-card__t">
        {/* R3-531 — the title is frontmatter prose: code spans render as code. */}
        <InlineProse text={headline} />
      </div>
      <div className="rm-card__meta">
        {row.repos.map((r) => (
          <span key={r} className="rm-chip" data-kind="repo">{r}</span>
        ))}
        {chips.map((t) => (
          <span key={t} className="rm-chip" data-kind="tag">{t}</span>
        ))}
        {/* R3-649 — what a resource chip answers while SCANNING is "does this need
            something I do not have", so an explicit `none` draws nothing: it is a record
            for whoever opens the file, not a thing to scan past on sixty cards. An item
            with no clause at all also draws nothing — the card cannot distinguish
            "checked, needs nothing" from "not recorded", and inventing a chip for the
            second would be the [OP]-style label R3-646 argues against. */}
        {row.requires.filter((r) => r !== 'none').map((r) => (
          <span key={r} className="rm-chip" data-kind="requires">{r}</span>
        ))}
        {row.prs.length ? (
          <span className="rm-chip" data-kind="pr" title={row.prs.map(prLabel).join(', ')}>
            {row.prs.length} PR{row.prs.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

/** The PR chips for an item, as external GitHub links. Used by `<RoadmapMeta>`,
 *  where the header is not itself a link so anchors are safe to nest. */
export function PrLinks({ prs }: { prs: string[] }) {
  if (!prs.length) return null;
  return (
    <span className="rm-prs">
      {prs.map((p) => {
        const href = prUrl(p);
        return href ? (
          <a key={p} className="rm-chip" data-kind="pr" href={href} target="_blank" rel="noreferrer">
            {prLabel(p)}
          </a>
        ) : (
          <span key={p} className="rm-chip" data-kind="pr">{prLabel(p)}</span>
        );
      })}
    </span>
  );
}
