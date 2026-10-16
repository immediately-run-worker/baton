// Which project a project surface is describing (R3-174).
//
// The explicit prop wins; otherwise the CURRENT ENTRY's own `id`, when that entry is a
// `kind: project` page. `useCurrentEntry()` is what makes the fallback possible from
// content: it names the entry being READ, which is not the same as the file this
// component sits in — a `_layout.mdx` wrapping the entry would otherwise identify
// itself, and the header would describe the layout instead of the page.

import { useCurrentEntry } from '@immediately-run/sdk';
import { projectIdOf } from './roadmapLib';
import type { Meta } from './roadmapLib';

export function useProjectId(explicit?: string): string {
  const current = useCurrentEntry<Meta>();
  return explicit || projectIdOf(current?.meta);
}
