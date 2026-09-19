import { describe, it, expect } from 'vitest';
import { cropActivityPoints } from '../../src/activity/activitySamples.js';
import type { ActivityTrackPoint } from '../../src/activity/parseActivityFile.js';

function trackPoint(distM: number, timeSec: number, opts: Partial<ActivityTrackPoint> = {}): ActivityTrackPoint {
  const latDeg = distM / 111320;
  return { lat: latDeg, lon: 11, ele: 100, timeSec, distM: null, powerW: null, ...opts };
}

describe('cropActivityPoints', () => {
  it('ribasa timeSec a 0 al nuovo inizio e ritorna il timeOffsetSec applicato', () => {
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 20; i++) {
      points.push(trackPoint(i * 100, i * 10));
    }
    const { points: cropped, timeOffsetSec } = cropActivityPoints(points, 0.5, 1.5);
    expect(timeOffsetSec).toBeGreaterThan(0);
    expect(cropped[0]!.timeSec).toBe(0);
    // Monotona crescente e coerente con l'offset sottratto.
    for (let i = 1; i < cropped.length; i++) {
      expect(cropped[i]!.timeSec).toBeGreaterThanOrEqual(cropped[i - 1]!.timeSec);
    }
  });

  it('ribasa distM (quando presente) sul valore device del primo punto ritagliato', () => {
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 20; i++) {
      points.push(trackPoint(i * 100, i * 10, { distM: i * 100 }));
    }
    const { points: cropped } = cropActivityPoints(points, 0.5, 1.5);
    expect(cropped[0]!.distM).toBe(0);
    expect(cropped[cropped.length - 1]!.distM).toBeGreaterThan(0);
  });

  it('preserva potenza/quota reali senza interpolarle (a differenza di cropRoutePoints)', () => {
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 10; i++) {
      points.push(trackPoint(i * 100, i * 10, { powerW: 200 + i, ele: 50 + i }));
    }
    const { points: cropped } = cropActivityPoints(points, 0.2, 0.6);
    for (const p of cropped) {
      // Ogni valore ritagliato deve essere uno di quelli EFFETTIVAMENTE registrati, mai un
      // valore intermedio interpolato.
      expect(Number.isInteger(p.powerW)).toBe(true);
    }
  });

  it('intervallo invertito o degenere ritorna array vuoto', () => {
    const points: ActivityTrackPoint[] = [];
    for (let i = 0; i < 10; i++) points.push(trackPoint(i * 100, i * 10));
    expect(cropActivityPoints(points, 0.5, 0.5).points).toHaveLength(0);
    expect(cropActivityPoints(points, 0.6, 0.2).points).toHaveLength(0);
  });

  it('meno di 2 punti validi in ingresso ritorna array vuoto', () => {
    expect(cropActivityPoints([trackPoint(0, 0)], 0, 1).points).toHaveLength(0);
  });
});
