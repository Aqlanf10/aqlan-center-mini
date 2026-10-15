'use client';
import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createHrHistoryDraftStore } from '@/lib/hr-history-drafts';
import { useSession } from '@/components/SessionProvider';
type Store = ReturnType<typeof createHrHistoryDraftStore>;
const Context = createContext<{ owner: string; username: string; store: Store } | null>(null);
export function HrHistoryDraftProvider({ view, children }: { view: string; children: ReactNode }) {
  const session = useSession(), owner = session ? `${session.username}\u0000${session.role}` : '';
  const [store] = useState(createHrHistoryDraftStore);
  const version = useSyncExternalStore(store.subscribe, store.snapshot, () => 0);
  useLayoutEffect(() => store.enter(owner, view, session?.role === 'admin'), [store, owner, view, session?.role]);
  useEffect(() => {
    if (!store.hasPending()) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [store, version]);
  return <Context.Provider value={{ owner, username: session?.username ?? '', store }}>{children}</Context.Provider>;
}
export function useHrHistoryDrafts() {
  const context = useContext(Context);
  if (!context) throw new Error('History editors require the owner-scoped HR page provider.');
  useSyncExternalStore(context.store.subscribe, context.store.snapshot, () => 0);
  return context;
}
