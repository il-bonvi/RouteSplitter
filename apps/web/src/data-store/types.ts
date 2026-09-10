import type {
  Athlete,
  CreateAthleteInput,
  Bike,
  CreateBikeInput,
  Tire,
  CreateTireInput,
  Route,
  CreateRouteInput,
  RawTrackPoint,
  SectionPlan,
  CreateSectionPlanInput,
  PowerPlan,
  CreatePowerPlanInput,
  Activity,
  CreateActivityInput,
  ActivityTrackPointRecord,
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

export interface TireRepository {
  create(input: CreateTireInput): Promise<Tire>;
  get(id: Id): Promise<Tire | null>;
  listByAthlete(athleteId: Id): Promise<Tire[]>;
  update(id: Id, patch: Partial<CreateTireInput>): Promise<Tire>;
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

export interface ActivityRepository {
  /** Crea l'attività E il payload dei punti grezzi in un'unica operazione logica (stesso
   * pattern di `RouteRepository.create`). */
  create(input: CreateActivityInput, points: ActivityTrackPointRecord[]): Promise<Activity>;
  get(id: Id): Promise<Activity | null>;
  getPoints(id: Id): Promise<ActivityTrackPointRecord[] | null>;
  listByAthlete(athleteId: Id): Promise<Activity[]>;
  listByRoute(routeId: Id): Promise<Activity[]>;
  /** Cancella anche il payload dei punti associato — mai lasciare punti orfani. */
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
  tires: TireRepository;
  routes: RouteRepository;
  sectionPlans: SectionPlanRepository;
  powerPlans: PowerPlanRepository;
  activities: ActivityRepository;
}
