import { describe, it, expect } from 'vitest';
import { Encoder, Profile } from '@garmin/fitsdk';
import { parseFitFile } from '../../src/activity/parseFitFile.js';

const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

/** Costruisce un file FIT sintetico (via Encoder dello stesso SDK) con N record a
 * intervalli di 10s / 100m, per testare il round-trip encode→decode del parser senza
 * dipendere da un file reale caricato a mano. */
function buildFitFile(records: { lat: number; lon: number; ele: number; power?: number; distM: number; t: Date }[]): File {
  const enc = new Encoder();
  enc.writeMesg({
    mesgNum: Profile.MesgNum.FILE_ID,
    type: 'activity',
    manufacturer: 'garmin',
    timeCreated: records[0]!.t
  } as unknown as Parameters<typeof enc.writeMesg>[0]);
  for (const r of records) {
    const mesg: Record<string, unknown> = {
      mesgNum: Profile.MesgNum.RECORD,
      timestamp: r.t,
      positionLat: Math.round(r.lat * SEMICIRCLES_PER_DEGREE),
      positionLong: Math.round(r.lon * SEMICIRCLES_PER_DEGREE),
      altitude: r.ele,
      distance: r.distM
    };
    if (r.power != null) mesg.power = r.power;
    enc.writeMesg(mesg as unknown as Parameters<typeof enc.writeMesg>[0]);
  }
  const bytes = enc.close();
  return new File([bytes as unknown as BlobPart], 'test.fit', { type: 'application/octet-stream' });
}

describe('parseFitFile', () => {
  it('decodifica un FIT sintetico e converte i semicerchi in gradi', async () => {
    const file = buildFitFile([
      { lat: 45.1, lon: 11.1, ele: 200, power: 210, distM: 0, t: new Date('2026-06-01T08:00:00Z') },
      { lat: 45.1009, lon: 11.1, ele: 205, power: 230, distM: 100, t: new Date('2026-06-01T08:00:10Z') },
      { lat: 45.1018, lon: 11.1, ele: 210, power: 240, distM: 200, t: new Date('2026-06-01T08:00:20Z') }
    ]);

    const result = await parseFitFile(file);

    expect(result.format).toBe('fit');
    expect(result.hasPower).toBe(true);
    expect(result.points).toHaveLength(3);

    const p0 = result.points[0]!;
    expect(p0.lat).toBeCloseTo(45.1, 5);
    expect(p0.lon).toBeCloseTo(11.1, 5);
    expect(p0.ele).toBeCloseTo(200, 3);
    expect(p0.powerW).toBeCloseTo(210, 3);
    expect(p0.distM).toBeCloseTo(0, 3);
    expect(p0.timeSec).toBe(0);

    expect(result.points[2]!.timeSec).toBeCloseTo(20, 3);
  });

  it('espone startTimeIso come istante assoluto del primo record (D55)', async () => {
    const file = buildFitFile([
      { lat: 45.1, lon: 11.1, ele: 200, power: 210, distM: 0, t: new Date('2026-06-01T08:00:00Z') },
      { lat: 45.1009, lon: 11.1, ele: 205, power: 230, distM: 100, t: new Date('2026-06-01T08:00:10Z') }
    ]);
    const result = await parseFitFile(file);
    expect(result.startTimeIso).toBe('2026-06-01T08:00:00.000Z');
  });

  it("lancia un errore chiaro per un file che non è un FIT", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'not.fit');
    await expect(parseFitFile(file)).rejects.toThrow(/non sembra un FIT/i);
  });

  it('hasPower è false se nessun record ha potenza', async () => {
    const file = buildFitFile([
      { lat: 45.1, lon: 11.1, ele: 200, distM: 0, t: new Date('2026-06-01T08:00:00Z') },
      { lat: 45.1009, lon: 11.1, ele: 205, distM: 100, t: new Date('2026-06-01T08:00:10Z') }
    ]);
    const result = await parseFitFile(file);
    expect(result.hasPower).toBe(false);
  });
});
