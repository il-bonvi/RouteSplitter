import Dexie, { type Table } from 'dexie';
import type {
  Athlete,
  Bike,
  Tire,
  Route,
  RoutePointsPayload,
  SectionPlan,
  PowerPlan,
  Activity,
  ActivityPointsPayload
} from '@shared-schema';

/**
 * Database locale (IndexedDB via Dexie). Un solo database per dispositivo in v1
 * (nessun backend/multi-utente — vedi stato_rs.md, decisioni D2/D3/D5).
 *
 * `routePoints`/`activityPoints` sono tabelle separate dai rispettivi metadati: i punti
 * grezzi di un GPX o di un'attività registrata possono essere migliaia, e non devono
 * appesantire ogni lettura dei soli metadati (stessa scelta di modellazione già presa in
 * shared-schema, decisione D10, estesa alle attività in D55).
 */
export class RouteSplitterDB extends Dexie {
  athletes!: Table<Athlete, string>;
  bikes!: Table<Bike, string>;
  tires!: Table<Tire, string>;
  routes!: Table<Route, string>;
  routePoints!: Table<RoutePointsPayload, string>;
  sectionPlans!: Table<SectionPlan, string>;
  powerPlans!: Table<PowerPlan, string>;
  activities!: Table<Activity, string>;
  activityPoints!: Table<ActivityPointsPayload, string>;

  constructor(databaseName = 'routesplitter') {
    super(databaseName);
    this.version(1).stores({
      athletes: 'id, coachId',
      bikes: 'id, athleteId',
      tires: 'id, athleteId',
      routes: 'id, athleteId',
      // routePoints/activityPoints hanno chiave primaria sull'id del "genitore" (un payload
      // punti per percorso/attività)
      routePoints: 'routeId',
      sectionPlans: 'id, routeId',
      powerPlans: 'id, sectionPlanId',
      activities: 'id, athleteId, routeId',
      activityPoints: 'activityId'
    });
  }
}
