import { describe, it, expect } from 'vitest';
import { buildMotionSamples } from '../../src/activity/activitySamples.js';
import type { ActivityTrackPoint } from '../../src/activity/parseActivityFile.js';

function trackPoint(distM: number, opts: Partial<ActivityTrackPoint> & { timeSec: number }): ActivityTrackPoint {
  const latDeg = distM / 111320;
  return { lat: latDeg, lon: 11, ele: 100, distM: null, powerW: null, ...opts };
}

describe('buildMotionSamples', () => {
  it('funziona anche senza alcun canale di potenza (a differenza di buildCdaSamples)', () => {
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 10; i++) {
      points.push(trackPoint(i * 100, { timeSec: i * 10, ele: 50 }));
    }
    const { samples, totalPoints } = buildMotionSamples(points, { smoothingRadiusMeters: 1 });
    expect(totalPoints).toBe(10);
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.speedMS).toBeCloseTo(10, 0);
      expect(s.gradientPct).toBeCloseTo(0, 3);
    }
  });

  it('valorizza timeSec (serve al termine cinetico in estimateTheoreticalPower)', () => {
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 6; i++) {
      points.push(trackPoint(i * 100, { timeSec: i * 10 }));
    }
    const { samples } = buildMotionSamples(points, { smoothingRadiusMeters: 1 });
    expect(samples.every(s => Number.isFinite(s.timeSec))).toBe(true);
    expect(samples[0]!.timeSec).toBeGreaterThan(0);
  });

  it('scarta i punti sotto la velocità minima, coerente con buildCdaSamples', () => {
    const points: ActivityTrackPoint[] = [
      trackPoint(0, { timeSec: 0 }),
      trackPoint(100, { timeSec: 10 }),
      trackPoint(100.5, { timeSec: 20 }), // fermo
      trackPoint(200.5, { timeSec: 30 })
    ];
    const { samples } = buildMotionSamples(points, { smoothingRadiusMeters: 1, minSpeedKmh: 3 });
    expect(samples.every(s => s.speedMS >= 3 / 3.6)).toBe(true);
  });

  it('ritorna array vuoto con meno di 5 punti validi', () => {
    const points: ActivityTrackPoint[] = [trackPoint(0, { timeSec: 0 }), trackPoint(100, { timeSec: 10 })];
    const { samples } = buildMotionSamples(points);
    expect(samples).toHaveLength(0);
  });
});
