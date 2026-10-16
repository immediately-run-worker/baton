// The one query every roadmap surface shares (R3-174).
//
// A hook rather than a helper because it is where the bundle scope is read: the SDK
// hands out entries with BUNDLE-absolute paths and viewer-supplied hrefs, so nothing
// downstream ever sees `/mnt/<hash>/…` or has to know which packaging it is running in.
//
// `useBundleEntries()` keeps its array identity while the store is unchanged, so the
// memo below can depend on it directly. That replaced a join-the-paths-into-a-string
// cache key and its `react-hooks/exhaustive-deps` suppression in every component that
// used to carry one — the stable identity was always the intent, and now it is the
// contract instead of a workaround.

import { useMemo } from 'react';
import { useBundle, useBundleEntries } from '@immediately-run/sdk';
import type { ItemRow, Meta } from './roadmapLib';
import { itemRows } from './roadmapLib';

export function useRoadmapRows(): ItemRow[] {
  const entries = useBundleEntries<Meta>();
  return useMemo(() => itemRows(entries), [entries]);
}

/**
 * Has the bundle arrived? `useBundleEntries()` returns `[]` both before the metadata
 * store loads and when there is no bundle, so a board cannot tell "still loading" from
 * "nothing matches" — and rendering the empty state first makes every board flash "No
 * items match." on the way in.
 *
 * A viewer that has declared a root is rendering an entry OUT OF that bundle, so the
 * bundle holds at least that entry: with a root set, zero entries can only mean the
 * store has not arrived. With no root there is nothing to wait for and the empty state
 * is the honest answer immediately.
 */
export function useBundleReady(): boolean {
  const { root } = useBundle();
  const entries = useBundleEntries<Meta>();
  return root === null || entries.length > 0;
}
