import { describe, it, expect } from 'vitest';
import { buildActivityDisplay } from '../../src/activity/buildActivityDisplay.js';
import type { ActivityTrackPoint } from '../../src/activity/parseActivityFile.js';

function trackPoint(latDeg: number, opts: Partial<ActivityTrackPoint> & { timeSec: number }): ActivityTrackPoint {
  return { lat: latDeg, lon: 11, ele: 100, powerW: null, distM: null, ...opts };
}

describe('buildActivityDisplay', () => {
  it('ritorna null con meno di 2 punti validi', () => {
    expect(buildActivityDisplay([])).toBeNull();
    expect(buildActivityDisplay([trackPoint(45, { timeSec: 0 })])).toBeNull();
  });

  it('calcola distanza, dislivello e durata coerenti con processRoute', () => {
    // 5 punti, ~111 m per 0.001° di lat, 10 m di dislivello ad ogni passo, 10s fra un punto e l'altro
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 5; i++) {
      points.push(trackPoint(45 + i * 0.001, { timeSec: i * 10, ele: 100 + i * 10, powerW: 200 + i * 10 }));
    }
    const display = buildActivityDisplay(points)!;
    expect(display).not.toBeNull();
    expect(display.distanceKm).toBeGreaterThan(0);
    expect(display.elevationGain).toBeCloseTo(40, 0);
    expect(display.elevationLoss).toBeCloseTo(0, 0);
    expect(display.durationSec).toBe(40);
    expect(display.points).toHaveLength(5);
  });

  it('calcola potenza media/max ignorando i punti senza potenza', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(45.0, { timeSec: 0, powerW: 200 }),
      trackPoint(45.001, { timeSec: 10, powerW: null }),
      trackPoint(45.002, { timeSec: 20, powerW: 300 })
    ];
    const display = buildActivityDisplay(points)!;
    expect(display.avgPowerW).toBeCloseTo(250, 3);
    expect(display.maxPowerW).toBe(300);
    expect(display.points[1]!.powerW).toBeNull();
  });

  it('avgPowerW è null se nessun punto ha potenza', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(45.0, { timeSec: 0 }),
      trackPoint(45.001, { timeSec: 10 })
    ];
    const display = buildActivityDisplay(points)!;
    expect(display.avgPowerW).toBeNull();
    expect(display.maxPowerW).toBeNull();
  });

  it('calcola velocità istantanea coerente e velocità media sull\'intera durata', () => {
    // 100 m ogni 10s costanti → 36 km/h punto-punto e come media
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 6; i++) {
      points.push(trackPoint(45 + i * (0.1 / 111.32), { timeSec: i * 10, powerW: 200 }));
    }
    const display = buildActivityDisplay(points)!;
    expect(display.points[0]!.speedKmh).toBeNull();
    for (let i = 1; i < display.points.length; i++) {
      expect(display.points[i]!.speedKmh).toBeCloseTo(36, 0);
    }
    expect(display.avgSpeedKmh).toBeCloseTo(36, 0);
    expect(display.maxSpeedKmh).toBeGreaterThan(0);
  });

  it('riempie in avanti la quota mancante senza interrompere il calcolo', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(45.0, { timeSec: 0, ele: 100 }),
      trackPoint(45.001, { timeSec: 10, ele: null }),
      trackPoint(45.002, { timeSec: 20, ele: 120 })
    ];
    const display = buildActivityDisplay(points)!;
    expect(display.points[1]!.ele).toBe(100); // riempito con l'ultima quota nota
    expect(display.points[2]!.ele).toBe(120);
  });
});
