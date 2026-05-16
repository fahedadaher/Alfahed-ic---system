// =====================================================================
// useLiveQuery — React wrapper around Dexie's liveQuery.
//
// Keeps components reactive without React Query: any time the underlying
// IndexedDB rows change (from realtime, from sync engine, from user
// writes), the hook re-runs the query and re-renders.
// =====================================================================

import { useEffect, useState } from 'react';
import { liveQuery, type Subscription } from 'dexie';
import { syncEngine, type SyncState } from '../lib/sync/sync-engine';

export function useLiveQuery<T>(querier: () => Promise<T> | T, deps: unknown[] = []): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);

  useEffect(() => {
    let sub: Subscription | null = null;
    sub = liveQuery(() => Promise.resolve(querier())).subscribe({
      next: v => setValue(v as T),
      // eslint-disable-next-line no-console
      error: e => console.error('[useLiveQuery]', e),
    });
    return () => { sub?.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}

export function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>({
    online: true, pending: 0, in_flight: 0, failed: 0,
  });
  useEffect(() => syncEngine.subscribe(setState), []);
  return state;
}
