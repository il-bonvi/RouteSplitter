/**
 * Integrazione Open-Meteo (D56) — nessuna API key richiesta, endpoint pubblici e gratuiti
 * per uso non commerciale. Solo l'API storica (`archive-api`) per ora: recupera
 * temperatura/pressione/vento REALI per la data e il luogo di un'attività già registrata
 * (Tab 2), per calcolare una densità dell'aria corretta invece di lasciarla al default
 * globale, e per avere un terzo punto di confronto sul vento accanto a "bussola" (manuale)
 * e "fisica" (D54, stimato dai dati di potenza). L'API di PREVISIONE (per pianificare una
 * gara futura in Tab 1/3) è un'estensione naturale ma volutamente rimandata — stesso
 * endpoint concettuale (`hourly=temperature_2m,surface_pressure,wind_speed_10m,
 * wind_direction_10m`), design da confermare quando si affronta quel caso d'uso.
 *
 * Deliberatamente NON in physics-core: richiede I/O di rete, physics-core resta pure-function.
 */

export interface OpenMeteoHourlyPoint {
  /** ISO 8601 SENZA offset (l'API lo restituisce così quando si chiede timezone=UTC) — va
   * trattato come UTC esplicitamente, mai lasciato al parsing "locale" di default di
   * `Date.parse` su una stringa senza zona. */
  timeIso: string;
  temperatureC: number | null;
  /** Pressione ALLA QUOTA DEL PUNTO (surface_pressure), non ridotta al livello del mare —
   * quella sbagliata per calcolare la densità dell'aria su un percorso in quota. */
  surfacePressureHPa: number | null;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
}

export interface WeatherAverageWindow {
  temperatureC: number | null;
  surfacePressureHPa: number | null;
  windSpeedKmh: number | null;
  windDirectionDeg: number | null;
  /** Quante ore della finestra richiesta avevano effettivamente un dato disponibile — se
   * basso rispetto alla durata attesa, la media è meno affidabile (mostralo all'utente). */
  hoursUsed: number;
}

/**
 * Interroga l'Historical Weather API di Open-Meteo per un singolo giorno (UTC) e luogo.
 * Lancia un errore con un messaggio leggibile in caso di risposta non-ok o di rete assente
 * — chi chiama decide come mostrarlo (mai un fallimento silenzioso: un numero di densità
 * aria sbagliato per un errore di rete ignorato sarebbe peggio di nessun numero).
 */
export async function fetchHistoricalWeather(latitude: number, longitude: number, dateIso: string): Promise<OpenMeteoHourlyPoint[]> {
  const date = dateIso.slice(0, 10); // yyyy-mm-dd
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}` +
    `&start_date=${date}&end_date=${date}` +
    `&hourly=temperature_2m,surface_pressure,wind_speed_10m,wind_direction_10m&timezone=UTC`;

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Impossibile contattare Open-Meteo (rete assente o richiesta bloccata).');
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.reason ?? `Richiesta meteo fallita (HTTP ${response.status}).`);
  }
  const data = await response.json();
  const times: string[] = data?.hourly?.time ?? [];
  const temps: Array<number | null> = data?.hourly?.temperature_2m ?? [];
  const pressures: Array<number | null> = data?.hourly?.surface_pressure ?? [];
  const windSpeeds: Array<number | null> = data?.hourly?.wind_speed_10m ?? [];
  const windDirs: Array<number | null> = data?.hourly?.wind_direction_10m ?? [];

  return times.map((t, i) => ({
    timeIso: t,
    temperatureC: temps[i] ?? null,
    surfacePressureHPa: pressures[i] ?? null,
    windSpeedKmh: windSpeeds[i] ?? null,
    windDirectionDeg: windDirs[i] ?? null
  }));
}

/**
 * Converte la serie oraria in campioni pronti per `WindTimeSample` (physics-core/wind.ts,
 * shared-schema/sectionPlan.ts) — D61: il vento storico va inserito come vento REALE nel
 * modello a zone già esistente (editabile, visibile, correggibile), non come uno scalare
 * isolato buttato dentro un calcolo interno. `minuteOfDay` è estratto dall'orario del
 * campione stesso (HH:mm, coerente con `timezone=UTC` richiesto in `fetchHistoricalWeather`)
 * — non dipende da `startTimeIso`, che qui serve solo per delimitare la FINESTRA di ore
 * rilevanti (stesso margine di un'ora di `averageWeatherOverWindow`). Scarta le ore senza
 * vento valido (velocità o direzione null).
 */
export function hourlyToWindTimeSamples(
  hourly: OpenMeteoHourlyPoint[],
  startTimeIso: string,
  durationHours: number
): Array<{ minuteOfDay: number; speedKmh: number; directionDeg: number }> {
  const startMs = Date.parse(startTimeIso);
  const endMs = startMs + durationHours * 3600_000;
  const marginMs = 3600_000;

  const result: Array<{ minuteOfDay: number; speedKmh: number; directionDeg: number }> = [];
  for (const h of hourly) {
    if (h.windSpeedKmh == null || h.windDirectionDeg == null) continue;
    const t = Date.parse(h.timeIso.endsWith('Z') ? h.timeIso : `${h.timeIso}Z`);
    if (!Number.isFinite(t) || t < startMs - marginMs || t > endMs + marginMs) continue;
    const match = /T(\d{2}):(\d{2})/.exec(h.timeIso);
    if (!match) continue;
    const minuteOfDay = Number(match[1]) * 60 + Number(match[2]);
    result.push({ minuteOfDay, speedKmh: h.windSpeedKmh, directionDeg: h.windDirectionDeg });
  }
  return result;
}

function meanIgnoringNulls(values: Array<number | null>): number | null {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

/**
 * Media circolare di angoli in gradi (0-360) — una media aritmetica ingenua è SBAGLIATA per
 * le direzioni: 350° e 10° (praticamente la stessa direzione, nord) darebbero una media
 * aritmetica di 180° (sud, l'esatto OPPOSTO). Si media il vettore unitario (seno/coseno) di
 * ogni angolo e si riconverte in gradi con atan2 — tecnica standard per medie circolari.
 */
export function circularMeanDeg(anglesDeg: number[]): number | null {
  if (anglesDeg.length === 0) return null;
  let sumSin = 0;
  let sumCos = 0;
  for (const a of anglesDeg) {
    const rad = (a * Math.PI) / 180;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  const meanRad = Math.atan2(sumSin / anglesDeg.length, sumCos / anglesDeg.length);
  const deg = (meanRad * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * Media dei valori orari che cadono nella finestra temporale dell'attività (con un margine
 * di un'ora ai due estremi, per non perdere l'ora di partenza/arrivo per un arrotondamento).
 * `startTimeIso` deve essere UTC (stesso formato di `ParsedActivity.startTimeIso`, D55).
 */
export function averageWeatherOverWindow(
  hourly: OpenMeteoHourlyPoint[],
  startTimeIso: string,
  durationHours: number
): WeatherAverageWindow {
  const startMs = Date.parse(startTimeIso);
  const endMs = startMs + durationHours * 3600_000;
  const marginMs = 3600_000;
  const inWindow = hourly.filter(h => {
    const t = Date.parse(h.timeIso.endsWith('Z') ? h.timeIso : `${h.timeIso}Z`);
    return Number.isFinite(t) && t >= startMs - marginMs && t <= endMs + marginMs;
  });
  return {
    temperatureC: meanIgnoringNulls(inWindow.map(h => h.temperatureC)),
    surfacePressureHPa: meanIgnoringNulls(inWindow.map(h => h.surfacePressureHPa)),
    windSpeedKmh: meanIgnoringNulls(inWindow.map(h => h.windSpeedKmh)),
    windDirectionDeg: circularMeanDeg(inWindow.map(h => h.windDirectionDeg).filter((v): v is number => v != null)),
    hoursUsed: inWindow.length
  };
}
