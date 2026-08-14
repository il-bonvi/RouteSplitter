import { describe, it, expect, beforeEach } from 'vitest';
import { createIndexedDbDataStore } from '../../src/data-store/indexedDbDataStore.js';
import type { DataStore } from '../../src/data-store/types.js';

// Nome DB diverso per test, per evitare collisioni tra run
let dbCounter = 0;
function freshStore(): DataStore {
  dbCounter += 1;
  return createIndexedDbDataStore(`test-db-${dbCounter}-${Date.now()}`);
}

describe('DataStore — flusso end-to-end', () => {
  let store: DataStore;

  beforeEach(() => {
    store = freshStore();
  });

  it('crea e recupera un atleta', async () => {
    const athlete = await store.athletes.create({ coachId: null, name: 'Andrea', weightKg: 70 });
    expect(athlete.id).toBeTruthy();
    const found = await store.athletes.get(athlete.id);
    expect(found?.name).toBe('Andrea');
  });

  it('crea una bici associata a un atleta e la ritrova con listByAthlete', async () => {
    const athlete = await store.athletes.create({ coachId: null, name: 'Andrea' });
    await store.bikes.create({ athleteId: athlete.id, name: 'Aero bike', weightKg: 8 });
    await store.bikes.create({ athleteId: athlete.id, name: 'Gravel bike', weightKg: 10 });
    const bikes = await store.bikes.listByAthlete(athlete.id);
    expect(bikes).toHaveLength(2);
  });

  it('crea un percorso con i punti, e li ritrova separatamente', async () => {
    const points = [
      { lat: 45.0, lon: 11.0, ele: 100 },
      { lat: 45.001, lon: 11.0, ele: 120 },
      { lat: 45.002, lon: 11.0, ele: 110 }
    ];
    const route = await store.routes.create(
      {
        athleteId: null,
        name: 'Giro del Colle',
        distanceKm: 5,
        elevationGain: 20,
        elevationLoss: 10,
        maxElevation: 120,
        minElevation: 100
      },
      points
    );
    expect(route.id).toBeTruthy();
    const storedPoints = await store.routes.getPoints(route.id);
    expect(storedPoints).toHaveLength(3);
    expect(storedPoints?.[0]?.ele).toBe(100);
  });

  it('cancellare un percorso cancella anche i punti associati (nessun orfano)', async () => {
    const points = [
      { lat: 45.0, lon: 11.0, ele: 100 },
      { lat: 45.001, lon: 11.0, ele: 120 }
    ];
    const route = await store.routes.create(
      { athleteId: null, name: 'Test', distanceKm: 1, elevationGain: 0, elevationLoss: 0, maxElevation: 120, minElevation: 100 },
      points
    );
    await store.routes.delete(route.id);
    expect(await store.routes.get(route.id)).toBeNull();
    expect(await store.routes.getPoints(route.id)).toBeNull();
  });

  it('crea un SectionPlan collegato a un percorso e lo ritrova con listByRoute', async () => {
    const route = await store.routes.create(
      { athleteId: null, name: 'Test', distanceKm: 10, elevationGain: 0, elevationLoss: 0, maxElevation: 100, minElevation: 100 },
      [
        { lat: 45.0, lon: 11.0, ele: 100 },
        { lat: 45.01, lon: 11.0, ele: 100 }
      ]
    );
    const plan = await store.sectionPlans.create({
      routeId: route.id,
      name: 'Piano gara',
      calcMode: 'power',
      defaultSpeedKmh: 40,
      breakpoints: [
        { id: 'bp1', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
        { id: 'bp2', distKm: 10, fixed: 'finish', sectionLabel: 'S1', speedKmh: null, powerWatts: 220 }
      ]
    });
    const plans = await store.sectionPlans.listByRoute(route.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe(plan.id);
  });

  it('crea più PowerPlan per lo stesso SectionPlan (storico dei tentativi, nessun update)', async () => {
    const route = await store.routes.create(
      { athleteId: null, name: 'Test', distanceKm: 10, elevationGain: 0, elevationLoss: 0, maxElevation: 100, minElevation: 100 },
      [
        { lat: 45.0, lon: 11.0, ele: 100 },
        { lat: 45.01, lon: 11.0, ele: 100 }
      ]
    );
    const sectionPlan = await store.sectionPlans.create({
      routeId: route.id,
      calcMode: 'power',
      defaultSpeedKmh: 40,
      breakpoints: [
        { id: 'bp1', distKm: 0, fixed: 'start', sectionLabel: null, speedKmh: null, powerWatts: null },
        { id: 'bp2', distKm: 10, fixed: 'finish', sectionLabel: 'S1', speedKmh: null, powerWatts: 220 }
      ]
    });

    const basePlan = {
      sectionPlanId: sectionPlan.id,
      stepMeters: 250,
      targetAvgPowerWatts: 220,
      targetNormalizedPowerWatts: null,
      minPowerWatts: 100,
      maxPowerWatts: 400,
      segments: [{ d0Km: 0, d1Km: 10, distanceKm: 10, gradient: 0, powerWatts: 220, timeHours: 0.25 }],
      resultTimeWeightedAvgPowerWatts: 220,
      resultNormalizedPowerWatts: 220,
      resultTotalTimeHours: 0.25
    };
    await store.powerPlans.create(basePlan);
    await store.powerPlans.create({ ...basePlan, targetAvgPowerWatts: 250 });

    const plans = await store.powerPlans.listBySectionPlan(sectionPlan.id);
    expect(plans).toHaveLength(2);
  });
});
