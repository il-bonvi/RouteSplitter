import { RouteSplitterDB } from './db.js';
import { createAthleteRepository } from './repositories/athleteRepository.js';
import { createBikeRepository } from './repositories/bikeRepository.js';
import { createRouteRepository } from './repositories/routeRepository.js';
import { createSectionPlanRepository } from './repositories/sectionPlanRepository.js';
import { createPowerPlanRepository } from './repositories/powerPlanRepository.js';
import { createActivityRepository } from './repositories/activityRepository.js';
import type { DataStore } from './types.js';

/**
 * Crea un DataStore basato su IndexedDB (locale al browser/dispositivo). Prima e unica
 * implementazione per ora (vedi stato_rs.md, decisione D5): la UI dipende sempre e solo
 * dall'interfaccia DataStore, mai da questa funzione/da Dexie direttamente — quando in
 * futuro servirà un backend condiviso, basterà scrivere createSupabaseDataStore() (o
 * simile) con la stessa forma e scambiarla qui, senza toccare i componenti.
 */
export function createIndexedDbDataStore(databaseName = 'routesplitter'): DataStore {
  const db = new RouteSplitterDB(databaseName);
  return {
    athletes: createAthleteRepository(db.athletes),
    bikes: createBikeRepository(db.bikes),
    routes: createRouteRepository(db.routes, db.routePoints),
    sectionPlans: createSectionPlanRepository(db.sectionPlans),
    powerPlans: createPowerPlanRepository(db.powerPlans),
    activities: createActivityRepository(db.activities)
  };
}

export { RouteSplitterDB } from './db.js';
