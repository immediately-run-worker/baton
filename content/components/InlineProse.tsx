// R3-531 — the one component that renders a frontmatter prose field: a
// `title`/`description`/`scope` parsed by `@immediately-run/mdx-plugins`'s
// `parseInlineProse` into `code`/`strong`/`em` and text. Every list row, card,
// header, search hit and sidebar label renders its metadata field through this,
// so a backtick in the corpus prints as a code span and never as body-font
// punctuation. Grove's engine component, copied here VERBATIM: a corpus component
// may not path into the viewer's filesystem (`MDX_FROM_MOUNT_SPEC` §2), and this
// file imports nothing viewer-local, which is what makes copying it the whole job.
//
// Links, images, HTML and JSX are not inline prose and never will be: a title
// is not a body. Fields that become attributes, labels or prompt strings use
// the parser's `plainProse` directly instead of this component.

import { Fragment } from 'react';
import { parseInlineProse, type InlineProseNode } from '@immediately-run/mdx-plugins';

function renderNodes(nodes: InlineProseNode[]): React.ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === 'code') return <code key={i}>{n.value}</code>;
    if (n.type === 'strong') return <strong key={i}>{renderNodes(n.children)}</strong>;
    if (n.type === 'emphasis') return <em key={i}>{renderNodes(n.children)}</em>;
    return <Fragment key={i}>{n.value}</Fragment>;
  });
}

export default function InlineProse({
  text,
  trimPeriod = false,
}: {
  text: string;
  /** Trim one trailing period, as the list components always have. */
  trimPeriod?: boolean;
}) {
  // Trim before parsing: the corpus ends titles on a period, and the period
  // sits OUTSIDE any code span, so a raw-string slice is the whole job.
  const src = trimPeriod && text.endsWith('.') ? text.slice(0, -1) : text;
  return <Fragment>{renderNodes(parseInlineProse(src))}</Fragment>;
}
