import { useMemo, useState } from 'react';
import { Link, useBundleEntries } from '@immediately-run/sdk';
import { useBundleReady } from './useRoadmapRows';
import InlineProse from './InlineProse';
import { isEntryPath } from './roadmapLib';
import './roadmap.css';
import type { Meta } from './roadmapLib';

type Doc = {
  path: string;
  href: string;
  title: string;
  status: string;
  scope: string;
  topics: string[];
  owns: string[];
};

// `<TopicIndex>` — the answer to "which spec governs X?", as a page.
//
// This is the discoverability payload the whole migration exists for: the corpus is
// ~2.5 MB, too large to hold in an agent's context, so the question has to be
// answerable WITHOUT reading it. A topic resolves to at most three documents by
// construction (the generator prunes any topic broader than that), and each row
// deep-links straight into the document.
export default function TopicIndex({ filter = '' }: { filter?: string }) {
  const [q, setQ] = useState(filter);
  const entries = useBundleEntries<Meta>();
  const ready = useBundleReady();

  const { docs, byTopic } = useMemo(() => {
    const parsed: Doc[] = entries
      .filter((e) => isEntryPath(e.path) && e.meta?.kind === 'doc')
      .map((e) => ({
        path: e.path,
        href: e.href,
        title: e.meta.title ?? '',
        status: e.meta.status ?? '',
        scope: e.meta.scope ?? '',
        topics: e.meta.topics ?? [],
        owns: [...(e.meta.owns?.capabilities ?? []), ...(e.meta.owns?.concepts ?? [])],
      }));
    const map = new Map<string, Doc[]>();
    for (const d of parsed) {
      for (const t of d.topics) {
        const cur = map.get(t);
        if (cur) cur.push(d);
        else map.set(t, [d]);
      }
    }
    return { docs: parsed, byTopic: map };
  }, [entries]);

  const needle = q.trim().toLowerCase();
  const topics = useMemo(
    () =>
      [...byTopic.keys()]
        .filter((t) => !needle || t.includes(needle))
        .sort()
        .slice(0, needle ? 60 : 400),
    [byTopic, needle],
  );

  if (!ready) return <div className="ti" data-loading="1"><div className="sk sk-line" /></div>;

  return (
    <div className="ti">
      <div className="ti__bar">
        <input
          className="ti__input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter topics — e.g. secrets, mobile, provenance"
          aria-label="Filter topics"
        />
        <span className="ti__count">
          {docs.length} documents · {byTopic.size} topics
        </span>
      </div>
      <dl className="ti__list">
        {topics.map((t) => (
          <div className="ti__row" key={t}>
            <dt className="ti__topic">{t}</dt>
            <dd className="ti__docs">
              {(byTopic.get(t) ?? []).map((d) => (
                <Link key={d.path} href={d.href} className="ti__doc" title={d.scope}>
                  <InlineProse text={d.title.split('—')[0].trim()} />
                  <span className="rm-badge" data-status={d.status}>{d.status}</span>
                </Link>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      {topics.length === 0 ? <p className="grove-search__empty">No topic matches “{q}”.</p> : null}
    </div>
  );
}
