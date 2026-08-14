import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Alias verso i "moduli interni" (ex pacchetti separati, ora cartelle sotto src/ —
// vedi stato_rs.md, decisione D16). Ogni alias punta all'index.ts del modulo: i
// consumatori esterni al modulo devono sempre importare dall'API pubblica, mai
// pescare direttamente un file interno.
const alias = {
  '@physics-core': fileURLToPath(new URL('./src/physics-core/index.ts', import.meta.url)),
  '@shared-schema': fileURLToPath(new URL('./src/shared-schema/index.ts', import.meta.url)),
  '@data-store': fileURLToPath(new URL('./src/data-store/index.ts', import.meta.url))
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // IndexedDB non esiste in Node: fake-indexeddb lo polyfilla per i test di data-store.
    // Innocuo per gli altri test (physics-core, shared-schema) che non lo usano.
    setupFiles: ['./test/setup.ts']
  }
});
