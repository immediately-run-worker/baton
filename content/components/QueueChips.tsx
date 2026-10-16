import type { QueueRollup } from './roadmapLib';

// `<QueueChips>` — a member set's queue rollup (`queueRollup` in roadmapLib) as chips:
// "1 expedite · 3 autonomous · 2 operator · 1 blocked · 2 in flight". Zero counts are
// omitted, so an all-zero rollup renders nothing. The first three count only READY items;
// `blocked` is available work the ready gate holds on an unfinished dependency.
const ORDER: { key: keyof QueueRollup; label: string }[] = [
  { key: 'expedite', label: 'expedite' },
  { key: 'autonomous', label: 'autonomous' },
  { key: 'operator', label: 'operator' },
  { key: 'blocked', label: 'blocked' },
  { key: 'inFlight', label: 'in flight' },
];

export default function QueueChips({ rollup }: { rollup: QueueRollup }) {
  return (
    <>
      {ORDER.filter(({ key }) => rollup[key] > 0).map(({ key, label }) => (
        <span key={key} className="rm-chip" data-kind="queue" data-queue={key}>
          {rollup[key]} {label}
        </span>
      ))}
    </>
  );
}
