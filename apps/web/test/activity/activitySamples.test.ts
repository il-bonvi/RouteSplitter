import { describe, it, expect } from 'vitest';
import { buildCdaSamples } from '../../src/activity/activitySamples.js';
import type { ActivityTrackPoint } from '../../src/activity/parseActivityFile.js';

/** Punto lungo un meridiano (lon fissa): 1° di lat ≈ 111 320 m, comodo per costruire
 * distanze note a mano senza dover invocare haversine nel test stesso. */
function trackPoint(distM: number, opts: Partial<ActivityTrackPoint> & { timeSec: number; powerW: number | null }): ActivityTrackPoint {
  const latDeg = distM / 111320;
  return { lat: latDeg, lon: 11, ele: 100, distM: null, ...opts };
}

describe('buildCdaSamples', () => {
  it('calcola velocità e pendenza da distanza (haversine) e tempo tra punti consecutivi', () => {
    // 10 punti, 100 m e 10 s tra un punto e l'altro → 10 m/s costanti, quota costante → pendenza 0
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 10; i++) {
      points.push(trackPoint(i * 100, { timeSec: i * 10, powerW: 200, ele: 50 }));
    }
    const { samples, totalPoints, pointsWithPower } = buildCdaSamples(points, { smoothingRadiusMeters: 1 });
    expect(totalPoints).toBe(10);
    expect(pointsWithPower).toBe(10);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.speedMS).toBeCloseTo(10, 0);
      expect(s.gradientPct).toBeCloseTo(0, 3);
      expect(s.powerW).toBeCloseTo(200, 0);
    }
  });

  it('calcola la pendenza corretta da un dislivello noto', () => {
    // 5 punti, 100 m orizzontali e 5 m di dislivello ad ogni passo → pendenza 5%
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 5; i++) {
      points.push(trackPoint(i * 100, { timeSec: i * 10, powerW: 220, ele: i * 5 }));
    }
    const { samples } = buildCdaSamples(points, { smoothingRadiusMeters: 1 });
    for (const s of samples) {
      expect(s.gradientPct).toBeCloseTo(5, 1);
    }
  });

  it('scarta i punti sotto la velocità minima (fermate/semafori)', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(0, { timeSec: 0, powerW: 200 }),
      trackPoint(100, { timeSec: 10, powerW: 200 }), // 10 m/s, ok
      trackPoint(100.5, { timeSec: 20, powerW: 5 }), // 0.05 m/s, fermo (semaforo)
      trackPoint(200.5, { timeSec: 30, powerW: 200 }) // 10 m/s, ok
    ];
    const { samples } = buildCdaSamples(points, { smoothingRadiusMeters: 1, minSpeedKmh: 3 });
    expect(samples.every(s => s.speedMS >= 3 / 3.6)).toBe(true);
  });

  it('usa la distanza dichiarata dal device quando presente su ogni punto', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(0, { timeSec: 0, powerW: 200, distM: 0 }),
      trackPoint(999999, { timeSec: 10, powerW: 200, distM: 50 }), // lat "sbagliata" apposta
      trackPoint(999999, { timeSec: 20, powerW: 200, distM: 100 }),
      trackPoint(999999, { timeSec: 30, powerW: 200, distM: 150 }),
      trackPoint(999999, { timeSec: 40, powerW: 200, distM: 200 })
    ];
    const { samples } = buildCdaSamples(points, { smoothingRadiusMeters: 1 });
    // se avesse usato haversine sulle coordinate (molto distanti) la velocità sarebbe enorme;
    // con la distanza di device (50 m ogni 10 s) deve risultare 5 m/s
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]!.speedMS).toBeCloseTo(5, 0);
  });

  it('ignora punti senza potenza valida', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(0, { timeSec: 0, powerW: 200 }),
      trackPoint(100, { timeSec: 10, powerW: null }),
      trackPoint(200, { timeSec: 20, powerW: 200 })
    ];
    const { pointsWithPower } = buildCdaSamples(points, { smoothingRadiusMeters: 1 });
    expect(pointsWithPower).toBe(2);
  });

  it('ritorna array vuoto con meno di 5 punti validi', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(0, { timeSec: 0, powerW: 200 }),
      trackPoint(100, { timeSec: 10, powerW: 200 })
    ];
    const { samples } = buildCdaSamples(points);
    expect(samples).toHaveLength(0);
  });

  it('valorizza distKm coerente con la distanza cumulata', () => {
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 6; i++) {
      points.push(trackPoint(i * 1000, { timeSec: i * 100, powerW: 200, ele: 50 }));
    }
    const { samples } = buildCdaSamples(points, { smoothingRadiusMeters: 1 });
    expect(samples[0]!.distKm).toBeCloseTo(1, 1);
    expect(samples[samples.length - 1]!.distKm).toBeCloseTo(5, 1);
  });
});
