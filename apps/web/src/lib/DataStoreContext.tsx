import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createIndexedDbDataStore, type DataStore } from '@data-store';

const DataStoreContext = createContext<DataStore | null>(null);

export function DataStoreProvider({ children }: { children: ReactNode }) {
  // Un solo DataStore per tutta la sessione dell'app. Se in futuro cambierà
  // l'implementazione (es. Supabase), questo è l'UNICO punto da toccare.
  const store = useMemo(() => createIndexedDbDataStore(), []);
  return <DataStoreContext.Provider value={store}>{children}</DataStoreContext.Provider>;
}

export function useDataStore(): DataStore {
  const store = useContext(DataStoreContext);
  if (!store) {
    throw new Error('useDataStore() deve essere chiamato dentro <DataStoreProvider>.');
  }
  return store;
}
