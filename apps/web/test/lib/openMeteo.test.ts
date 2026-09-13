import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchHistoricalWeather, circularMeanDeg, averageWeatherOverWindow, hourlyToWindTimeSamples, type OpenMeteoHourlyPoint } from '../../src/lib/openMeteo.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchHistoricalWeather', () => {
  it('costruisce l\'URL con le coordinate/data corrette e mappa la risposta oraria', async () => {
    const mockResponse = {
      hourly: {
        time: ['2026-06-01T08:00', '2026-06-01T09:00'],
        temperature_2m: [18.5, 19.2],
        surface_pressure: [1008.1, 1008.3],
        wind_speed_10m: [12, 14],
        wind_direction_10m: [270, 275]
      }
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchHistoricalWeather(45.1, 11.1, '2026-06-01T08:00:00.000Z');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0]![0] as string;
    expect(calledUrl).toContain('latitude=45.1');
    expect(calledUrl).toContain('longitude=11.1');
    expect(calledUrl).toContain('start_date=2026-06-01');
    expect(calledUrl).toContain('end_date=2026-06-01');
    expect(calledUrl).toContain('hourly=temperature_2m,surface_pressure,wind_speed_10m,wind_direction_10m');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      timeIso: '2026-06-01T08:00',
      temperatureC: 18.5,
      surfacePressureHPa: 1008.1,
      windSpeedKmh: 12,
      windDirectionDeg: 270
    });
  });

  it('lancia un errore leggibile su risposta non-ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: true, reason: 'Parametro non valido' })
      })
    );
    await expect(fetchHistoricalWeather(45.1, 11.1, '2026-06-01T08:00:00.000Z')).rejects.toThrow('Parametro non valido');
  });

  it('lancia un errore leggibile se la rete non risponde', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('network down'))
    );
    await expect(fetchHistoricalWeather(45.1, 11.1, '2026-06-01T08:00:00.000Z')).rejects.toThrow('Impossibile contattare Open-Meteo');
  });
});

describe('circularMeanDeg', () => {
  it('media correttamente due angoli vicini a nord (350° e 10° ⇒ vicino a 0°, non 180°)', () => {
    const mean = circularMeanDeg([350, 10]);
    expect(mean).not.toBeNull();
    // Accetta sia poco sopra 0 che poco sotto 360 (equivalenti)
    const normalized = mean! > 180 ? mean! - 360 : mean!;
    expect(normalized).toBeCloseTo(0, 0);
  });

  it('media banale di angoli lontani da un salto 0/360', () => {
    expect(circularMeanDeg([80, 100])).toBeCloseTo(90, 0);
  });

  it('null su array vuoto', () => {
    expect(circularMeanDeg([])).toBeNull();
  });
});

describe('averageWeatherOverWindow', () => {
  const hourly: OpenMeteoHourlyPoint[] = [
    { timeIso: '2026-06-01T07:00', temperatureC: 15, surfacePressureHPa: 1010, windSpeedKmh: 10, windDirectionDeg: 350 },
    { timeIso: '2026-06-01T08:00', temperatureC: 17, surfacePressureHPa: 1009, windSpeedKmh: 12, windDirectionDeg: 10 },
    { timeIso: '2026-06-01T09:00', temperatureC: 19, surfacePressureHPa: 1008, windSpeedKmh: 14, windDirectionDeg: 20 },
    { timeIso: '2026-06-01T14:00', temperatureC: 25, surfacePressureHPa: 1005, windSpeedKmh: 20, windDirectionDeg: 200 }
  ];

  it('include solo le ore nella finestra (con un margine di un\'ora) e le media', () => {
    // Uscita di 1h a partire dalle 08:00 ⇒ finestra utile 07:00-10:00 con il margine.
    const result = averageWeatherOverWindow(hourly, '2026-06-01T08:00:00.000Z', 1);
    expect(result.hoursUsed).toBe(3); // 07:00, 08:00, 09:00 — non le 14:00
    expect(result.temperatureC).toBeCloseTo((15 + 17 + 19) / 3, 5);
  });

  it('esclude le ore fuori dalla finestra anche se nello stesso giorno', () => {
    const result = averageWeatherOverWindow(hourly, '2026-06-01T08:00:00.000Z', 1);
    // Le 14:00 non devono influenzare la media di un'uscita delle 08:00-09:00.
    expect(result.temperatureC).toBeLessThan(25);
  });

  it('hoursUsed è 0 se nessuna ora ricade nella finestra', () => {
    const result = averageWeatherOverWindow(hourly, '2026-06-02T08:00:00.000Z', 1);
    expect(result.hoursUsed).toBe(0);
    expect(result.temperatureC).toBeNull();
  });
});

describe('hourlyToWindTimeSamples', () => {
  const hourly: OpenMeteoHourlyPoint[] = [
    { timeIso: '2026-06-01T07:00', temperatureC: 15, surfacePressureHPa: 1010, windSpeedKmh: 10, windDirectionDeg: 350 },
    { timeIso: '2026-06-01T08:00', temperatureC: 17, surfacePressureHPa: 1009, windSpeedKmh: 12, windDirectionDeg: 10 },
    { timeIso: '2026-06-01T09:00', temperatureC: 19, surfacePressureHPa: 1008, windSpeedKmh: 14, windDirectionDeg: 20 },
    { timeIso: '2026-06-01T14:00', temperatureC: 25, surfacePressureHPa: 1005, windSpeedKmh: 20, windDirectionDeg: 200 }
  ];

  it('estrae minuteOfDay dall\'orario del campione, non da startTimeIso', () => {
    const samples = hourlyToWindTimeSamples(hourly, '2026-06-01T08:00:00.000Z', 1);
    expect(samples.map(s => s.minuteOfDay)).toEqual([420, 480, 540]); // 07:00, 08:00, 09:00 in minuti
  });

  it('esclude le ore fuori dalla finestra dell\'attività (con margine di un\'ora)', () => {
    const samples = hourlyToWindTimeSamples(hourly, '2026-06-01T08:00:00.000Z', 1);
    expect(samples.some(s => s.minuteOfDay === 840)).toBe(false); // 14:00 esclusa
  });

  it('scarta le ore senza vento valido (null)', () => {
    const withNull: OpenMeteoHourlyPoint[] = [
      ...hourly.slice(0, 2),
      { timeIso: '2026-06-01T09:00', temperatureC: 19, surfacePressureHPa: 1008, windSpeedKmh: null, windDirectionDeg: null }
    ];
    const samples = hourlyToWindTimeSamples(withNull, '2026-06-01T08:00:00.000Z', 1);
    expect(samples).toHaveLength(2);
  });

  it('array vuoto se nessuna ora ricade nella finestra', () => {
    expect(hourlyToWindTimeSamples(hourly, '2026-06-02T08:00:00.000Z', 1)).toEqual([]);
  });
});
