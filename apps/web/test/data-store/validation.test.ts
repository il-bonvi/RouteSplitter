import { describe, it, expect } from 'vitest';
import { createIndexedDbDataStore } from '../../src/data-store/indexedDbDataStore.js';

describe('DataStore — validazione applicata anche allo strato di persistenza', () => {
  it('rifiuta la creazione di un atleta con peso implausibile', async () => {
    const store = createIndexedDbDataStore(`validation-test-${Date.now()}`);
    await expect(store.athletes.create({ coachId: null, name: 'Test', weightKg: 5 })).rejects.toThrow();
  });

  it('rifiuta un update che porta un override fisico fuori range (es. CdA assurdo su una bici)', async () => {
    const store = createIndexedDbDataStore(`validation-test-${Date.now()}-2`);
    const athlete = await store.athletes.create({ coachId: null, name: 'Test' });
    const bike = await store.bikes.create({ athleteId: athlete.id, name: 'Bici', weightKg: 8 });
    await expect(store.bikes.update(bike.id, { physicsOverride: { cda: 9 } })).rejects.toThrow();
  });

  it('rifiuta la creazione di un percorso con meno di 2 punti', async () => {
    const store = createIndexedDbDataStore(`validation-test-${Date.now()}-3`);
    await expect(
      store.routes.create(
        { athleteId: null, name: 'Test', distanceKm: 1, elevationGain: 0, elevationLoss: 0, maxElevation: 100, minElevation: 100 },
        [{ lat: 45.0, lon: 11.0, ele: 100 }]
      )
    ).rejects.toThrow();
  });

  it("update() lancia un errore chiaro se l'entità non esiste", async () => {
    const store = createIndexedDbDataStore(`validation-test-${Date.now()}-4`);
    await expect(store.athletes.update('id-inesistente', { name: 'X' })).rejects.toThrow(/non trovato/i);
  });
});
