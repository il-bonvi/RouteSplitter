import { DataStoreProvider } from './lib/DataStoreContext.js';
import { RouteSplitterApp } from './components/RouteSplitterApp.js';

export default function App() {
  return (
    <DataStoreProvider>
      <RouteSplitterApp />
    </DataStoreProvider>
  );
}
