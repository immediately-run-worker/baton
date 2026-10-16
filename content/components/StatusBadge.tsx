import { statusLabel } from './roadmapData';
import './roadmap.css';

// A status pill. The colour is CSS-only — the element carries `data-status` and the
// stylesheet maps it to `--rm-status`, so re-skinning the board is a CSS change, not
// a TypeScript one. Shared by the board, the dependency graph, the item header and the
// project rollup.
export default function StatusBadge({ status = '', title }: { status?: string; title?: string }) {
  if (!status) return null;
  return (
    <span className="rm-badge" data-status={status} title={title ?? `status: ${status}`}>
      {statusLabel(status)}
    </span>
  );
}
