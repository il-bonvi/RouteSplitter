import { describe, it, expect, beforeEach } from 'vitest';
import { createIndexedDbDataStore } from '../../src/data-store/indexedDbDataStore.js';
import type { DataStore } from '../../src/data-store/types.js';
import { DEFAULT_PHYSICS_PARAMS } from '../../src/shared-schema/physicsParams.js';

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

  it('salva CP/W\' su un atleta e li ritrova invariati dopo un update parziale', async () => {
    const athlete = await store.athletes.create({
      coachId: null,
      name: 'Andrea',
      weightKg: 70,
      criticalPowerW: 245,
      wPrimeJ: 22000
    });
    // Un update che tocca solo il peso non deve far sparire CP/W' già salvati.
    const updated = await store.athletes.update(athlete.id, { weightKg: 71 });
    expect(updated.weightKg).toBe(71);
    expect(updated.criticalPowerW).toBe(245);
    expect(updated.wPrimeJ).toBe(22000);
  });

  it('crea pneumatici per un atleta e li ritrova con listByAthlete', async () => {
    const athlete = await store.athletes.create({ coachId: null, name: 'Andrea' });
    await store.tires.create({ athleteId: athlete.id, name: 'GP5000 asciutto', crr: 0.004 });
    await store.tires.create({ athleteId: athlete.id, name: 'GP5000 bagnato', crr: 0.005 });
    const tires = await store.tires.listByAthlete(athlete.id);
    expect(tires).toHaveLength(2);
    expect(tires.map(t => t.name).sort()).toEqual(['GP5000 asciutto', 'GP5000 bagnato']);
  });

  it('cancella un pneumatico senza toccare gli altri', async () => {
    const athlete = await store.athletes.create({ coachId: null, name: 'Andrea' });
    const t1 = await store.tires.create({ athleteId: athlete.id, name: 'Tire 1', crr: 0.004 });
    await store.tires.create({ athleteId: athlete.id, name: 'Tire 2', crr: 0.005 });
    await store.tires.delete(t1.id);
    const remaining = await store.tires.listByAthlete(athlete.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.name).toBe('Tire 2');
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

  it('salva un\'attività con i suoi punti grezzi e li ritrova entrambi (D55)', async () => {
    const athlete = await store.athletes.create({ coachId: null, name: 'Andrea' });
    const points = [
      { lat: 45.1, lon: 11.1, ele: 200, timeSec: 0, powerW: 200, distM: 0 },
      { lat: 45.1009, lon: 11.1, ele: 205, timeSec: 10, powerW: 220, distM: 100 },
      { lat: 45.1018, lon: 11.1, ele: 210, timeSec: 20, powerW: 240, distM: 200 }
    ];
    const activity = await store.activities.create(
      {
        athleteId: athlete.id,
        routeId: null,
        powerPlanId: null,
        sourceFileName: 'trevigiana.fit',
        activityDate: '2026-06-01T08:00:00.000Z',
        summary: { durationHours: 1.2, distanceKm: 40 },
        physicsParamsSnapshot: DEFAULT_PHYSICS_PARAMS,
        windSpeedKmh: 10,
        windDirectionDeg: 90,
        sectionBreakpointsKm: [10, 25]
      },
      points
    );

    const found = await store.activities.get(activity.id);
    expect(found?.sourceFileName).toBe('trevigiana.fit');
    expect(found?.sectionBreakpointsKm).toEqual([10, 25]);

    const foundPoints = await store.activities.getPoints(activity.id);
    expect(foundPoints).toHaveLength(3);
    expect(foundPoints?.[1]?.powerW).toBe(220);
  });

  it('listByAthlete ritrova le attività salvate per un atleta', async () => {
    const athlete = await store.athletes.create({ coachId: null, name: 'Andrea' });
    const points = [
      { lat: 45.1, lon: 11.1, ele: 200, timeSec: 0, powerW: 200, distM: 0 },
      { lat: 45.1009, lon: 11.1, ele: 205, timeSec: 10, powerW: 220, distM: 100 }
    ];
    const makeInput = (sourceFileName: string) => ({
      athleteId: athlete.id,
      routeId: null,
      powerPlanId: null,
      sourceFileName,
      activityDate: '2026-06-01T08:00:00.000Z',
      summary: { durationHours: 1, distanceKm: 30 },
      physicsParamsSnapshot: DEFAULT_PHYSICS_PARAMS
    });
    await store.activities.create(makeInput('uscita1.fit'), points);
    await store.activities.create(makeInput('uscita2.fit'), points);

    const list = await store.activities.listByAthlete(athlete.id);
    expect(list).toHaveLength(2);
  });

  it('cancellare un\'attività cancella anche i suoi punti (nessun orfano)', async () => {
    const athlete = await store.athletes.create({ coachId: null, name: 'Andrea' });
    const points = [
      { lat: 45.1, lon: 11.1, ele: 200, timeSec: 0, powerW: 200, distM: 0 },
      { lat: 45.1009, lon: 11.1, ele: 205, timeSec: 10, powerW: 220, distM: 100 }
    ];
    const activity = await store.activities.create(
      {
        athleteId: athlete.id,
        routeId: null,
        powerPlanId: null,
        sourceFileName: 'uscita.fit',
        activityDate: '2026-06-01T08:00:00.000Z',
        summary: { durationHours: 1, distanceKm: 30 },
        physicsParamsSnapshot: DEFAULT_PHYSICS_PARAMS
      },
      points
    );

    await store.activities.delete(activity.id);

    expect(await store.activities.get(activity.id)).toBeNull();
    expect(await store.activities.getPoints(activity.id)).toBeNull();
  });
});
