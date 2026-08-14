import { describe, it, expect } from 'vitest';
import { RawTrackPointSchema, RoutePointsPayloadSchema, RouteSchema } from '../../src/shared-schema/route.js';
import { nowIso } from '../../src/shared-schema/common.js';

describe('RawTrackPointSchema', () => {
  it('accetta un punto valido', () => {
    expect(() => RawTrackPointSchema.parse({ lat: 45.07, lon: 11.12, ele: 120 })).not.toThrow();
  });

  it('rifiuta lat/lon non finiti (NaN/Infinity) — il bug segnalato in review si propagava silenziosamente', () => {
    expect(() => RawTrackPointSchema.parse({ lat: NaN, lon: 11.12, ele: 120 })).toThrow();
    expect(() => RawTrackPointSchema.parse({ lat: 45.07, lon: Infinity, ele: 120 })).toThrow();
  });

  it('rifiuta coordinate fuori range geografico', () => {
    expect(() => RawTrackPointSchema.parse({ lat: 200, lon: 11.12, ele: 120 })).toThrow();
  });
});

describe('RoutePointsPayloadSchema', () => {
  it('richiede almeno 2 punti', () => {
    expect(() =>
      RoutePointsPayloadSchema.parse({
        routeId: 'r1',
        schemaVersion: 1,
        points: [{ lat: 45.0, lon: 11.0, ele: 100 }]
      })
    ).toThrow();
  });

  it('accetta un payload valido con 2+ punti', () => {
    expect(() =>
      RoutePointsPayloadSchema.parse({
        routeId: 'r1',
        schemaVersion: 1,
        points: [
          { lat: 45.0, lon: 11.0, ele: 100 },
          { lat: 45.001, lon: 11.0, ele: 105 }
        ]
      })
    ).not.toThrow();
  });
});

describe('RouteSchema', () => {
  it('accetta metadati validi', () => {
    const now = nowIso();
    expect(() =>
      RouteSchema.parse({
        id: 'route-1',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        athleteId: null,
        name: 'Giro del Colle',
        distanceKm: 42.5,
        elevationGain: 850,
        elevationLoss: 850,
        maxElevation: 1200,
        minElevation: 350
      })
    ).not.toThrow();
  });

  it('rifiuta distanza negativa', () => {
    const now = nowIso();
    expect(() =>
      RouteSchema.parse({
        id: 'route-1',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
        athleteId: null,
        name: 'Percorso',
        distanceKm: -5,
        elevationGain: 0,
        elevationLoss: 0,
        maxElevation: 100,
        minElevation: 100
      })
    ).toThrow();
  });
});
