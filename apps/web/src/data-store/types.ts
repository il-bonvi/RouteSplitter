import type {
  Athlete,
  CreateAthleteInput,
  Bike,
  CreateBikeInput,
  Route,
  CreateRouteInput,
  RawTrackPoint,
  SectionPlan,
  CreateSectionPlanInput,
  PowerPlan,
  CreatePowerPlanInput,
  Activity,
  Id
} from '@shared-schema';

export interface AthleteRepository {
  create(input: CreateAthleteInput): Promise<Athlete>;
  get(id: Id): Promise<Athlete | null>;
  list(): Promise<Athlete[]>;
  update(id: Id, patch: Partial<CreateAthleteInput>): Promise<Athlete>;
  delete(id: Id): Promise<void>;
}

export interface BikeRepository {
  create(input: CreateBikeInput): Promise<Bike>;
  get(id: Id): Promise<Bike | null>;
  listByAthlete(athleteId: Id): Promise<Bike[]>;
  update(id: Id, patch: Partial<CreateBikeInput>): Promise<Bike>;
  delete(id: Id): Promise<void>;
}

export interface RouteRepository {
  /** Crea il percorso E il payload dei punti grezzi in un'unica operazione logica. */
  create(input: CreateRouteInput, points: RawTrackPoint[]): Promise<Route>;
  get(id: Id): Promise<Route | null>;
  getPoints(id: Id): Promise<RawTrackPoint[] | null>;
  /** athleteId = null → percorsi non ancora assegnati a un atleta specifico. */
  listByAthlete(athleteId: Id | null): Promise<Route[]>;
  update(id: Id, patch: Partial<CreateRouteInput>): Promise<Route>;
  /** Cancella anche il payload dei punti associato — mai lasciare punti orfani. */
  delete(id: Id): Promise<void>;
}

export interface SectionPlanRepository {
  create(input: CreateSectionPlanInput): Promise<SectionPlan>;
  get(id: Id): Promise<SectionPlan | null>;
  listByRoute(routeId: Id): Promise<SectionPlan[]>;
  update(id: Id, patch: Partial<CreateSectionPlanInput>): Promise<SectionPlan>;
  delete(id: Id): Promise<void>;
}

export interface PowerPlanRepository {
  create(input: CreatePowerPlanInput): Promise<PowerPlan>;
  get(id: Id): Promise<PowerPlan | null>;
  listBySectionPlan(sectionPlanId: Id): Promise<PowerPlan[]>;
  delete(id: Id): Promise<void>;
}

export type CreateActivityInput = Omit<Activity, 'id' | 'schemaVersion' | 'createdAt' | 'updatedAt'>;

export interface ActivityRepository {
  create(input: CreateActivityInput): Promise<Activity>;
  get(id: Id): Promise<Activity | null>;
  listByAthlete(athleteId: Id): Promise<Activity[]>;
  listByRoute(routeId: Id): Promise<Activity[]>;
  delete(id: Id): Promise<void>;
}

/**
 * Contratto completo di persistenza dell'app. La UI (apps/web) dipende SOLO da questa
 * interfaccia, mai da Dexie/IndexedDB direttamente — così in futuro si potrà scrivere
 * una implementazione alternativa (es. Supabase) e scambiarla senza toccare i componenti.
 */
export interface DataStore {
  athletes: AthleteRepository;
  bikes: BikeRepository;
  routes: RouteRepository;
  sectionPlans: SectionPlanRepository;
  powerPlans: PowerPlanRepository;
  activities: ActivityRepository;
}
