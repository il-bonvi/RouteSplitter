import Dexie, { type Table } from 'dexie';
import type { Athlete, Bike, Route, RoutePointsPayload, SectionPlan, PowerPlan, Activity } from '@shared-schema';

/**
 * Database locale (IndexedDB via Dexie). Un solo database per dispositivo in v1
 * (nessun backend/multi-utente — vedi stato_rs.md, decisioni D2/D3/D5).
 *
 * `routePoints` è una tabella separata da `routes`: i punti grezzi di un GPX possono
 * essere migliaia, e non devono appesantire ogni lettura dei soli metadati percorso
 * (stessa scelta di modellazione già presa in shared-schema, decisione D10).
 */
export class RouteSplitterDB extends Dexie {
  athletes!: Table<Athlete, string>;
  bikes!: Table<Bike, string>;
  routes!: Table<Route, string>;
  routePoints!: Table<RoutePointsPayload, string>;
  sectionPlans!: Table<SectionPlan, string>;
  powerPlans!: Table<PowerPlan, string>;
  activities!: Table<Activity, string>;

  constructor(databaseName = 'routesplitter') {
    super(databaseName);
    this.version(1).stores({
      athletes: 'id, coachId',
      bikes: 'id, athleteId',
      routes: 'id, athleteId',
      // routePoints è chiave primaria su routeId (un payload punti per percorso)
      routePoints: 'routeId',
      sectionPlans: 'id, routeId',
      powerPlans: 'id, sectionPlanId',
      activities: 'id, athleteId, routeId'
    });
  }
}
