import { describe, it, expect } from 'vitest';
import { parseActivityText } from '../../src/activity/parseActivityFile.js';

const SAMPLE_TCX = `<?xml version="1.0" encoding="UTF-8"?>
<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">
  <Activities>
    <Activity Sport="Biking">
      <Lap StartTime="2026-06-01T08:00:00.000Z">
        <Track>
          <Trackpoint>
            <Time>2026-06-01T08:00:00.000Z</Time>
            <Position>
              <LatitudeDegrees>45.100000</LatitudeDegrees>
              <LongitudeDegrees>11.100000</LongitudeDegrees>
            </Position>
            <AltitudeMeters>200.0</AltitudeMeters>
            <DistanceMeters>0.0</DistanceMeters>
            <Extensions>
              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                <Watts>210</Watts>
              </TPX>
            </Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-06-01T08:00:10.000Z</Time>
            <Position>
              <LatitudeDegrees>45.100900</LatitudeDegrees>
              <LongitudeDegrees>11.100000</LongitudeDegrees>
            </Position>
            <AltitudeMeters>205.0</AltitudeMeters>
            <DistanceMeters>100.0</DistanceMeters>
            <Extensions>
              <TPX xmlns="http://www.garmin.com/xmlschemas/ActivityExtension/v2">
                <Watts>230</Watts>
              </TPX>
            </Extensions>
          </Trackpoint>
          <Trackpoint>
            <Time>2026-06-01T08:00:20.000Z</Time>
            <Position>
              <LatitudeDegrees>45.101800</LatitudeDegrees>
              <LongitudeDegrees>11.100000</LongitudeDegrees>
            </Position>
            <AltitudeMeters>210.0</AltitudeMeters>
            <DistanceMeters>200.0</DistanceMeters>
          </Trackpoint>
        </Track>
      </Lap>
    </Activity>
  </Activities>
</TrainingCenterDatabase>`;

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1">
  <trk>
    <trkseg>
      <trkpt lat="45.1000" lon="11.1000">
        <ele>200.0</ele>
        <time>2026-06-01T08:00:00Z</time>
        <extensions>
          <gpxpx:power>210</gpxpx:power>
        </extensions>
      </trkpt>
      <trkpt lat="45.1009" lon="11.1000">
        <ele>205.0</ele>
        <time>2026-06-01T08:00:10Z</time>
        <extensions>
          <gpxpx:power>230</gpxpx:power>
        </extensions>
      </trkpt>
      <trkpt lat="45.1018" lon="11.1000">
        <ele>210.0</ele>
        <time>2026-06-01T08:00:20Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>`;

describe('parseActivityText — TCX', () => {
  it('rileva il formato TCX ed estrae i trackpoint validi', () => {
    const result = parseActivityText(SAMPLE_TCX);
    expect(result.format).toBe('tcx');
    expect(result.points).toHaveLength(3);
    expect(result.discardedCount).toBe(0);
    expect(result.hasPower).toBe(true);
  });

  it('estrae lat/lon/quota/distanza/potenza corrette dal primo punto', () => {
    const result = parseActivityText(SAMPLE_TCX);
    const p0 = result.points[0]!;
    expect(p0.lat).toBeCloseTo(45.1, 5);
    expect(p0.lon).toBeCloseTo(11.1, 5);
    expect(p0.ele).toBeCloseTo(200, 3);
    expect(p0.distM).toBeCloseTo(0, 3);
    expect(p0.powerW).toBeCloseTo(210, 3);
    expect(p0.timeSec).toBe(0);
  });

  it('rende il tempo relativo al primo punto', () => {
    const result = parseActivityText(SAMPLE_TCX);
    expect(result.points[1]!.timeSec).toBeCloseTo(10, 3);
    expect(result.points[2]!.timeSec).toBeCloseTo(20, 3);
  });

  it('gestisce un trackpoint senza potenza (powerW null)', () => {
    const result = parseActivityText(SAMPLE_TCX);
    expect(result.points[2]!.powerW).toBeNull();
  });
});

describe('parseActivityText — GPX con estensione potenza', () => {
  it('rileva il formato GPX ed estrae i trackpoint validi', () => {
    const result = parseActivityText(SAMPLE_GPX);
    expect(result.format).toBe('gpx');
    expect(result.points).toHaveLength(3);
    expect(result.hasPower).toBe(true);
  });

  it('estrae lat/lon dagli attributi e potenza dall\'estensione gpxpx:power', () => {
    const result = parseActivityText(SAMPLE_GPX);
    const p0 = result.points[0]!;
    expect(p0.lat).toBeCloseTo(45.1, 5);
    expect(p0.lon).toBeCloseTo(11.1, 5);
    expect(p0.powerW).toBeCloseTo(210, 3);
    expect(result.points[1]!.powerW).toBeCloseTo(230, 3);
  });

  it('distM è null per un GPX (nessun campo distanza dichiarata dal device)', () => {
    const result = parseActivityText(SAMPLE_GPX);
    expect(result.points[0]!.distM).toBeNull();
  });
});

describe('parseActivityText — GPX senza potenza', () => {
  it('hasPower è false e i punti restano comunque validi (per errori gestiti a UI)', () => {
    const gpxNoPower = SAMPLE_GPX.replace(/<extensions>[\s\S]*?<\/extensions>/g, '');
    const result = parseActivityText(gpxNoPower);
    expect(result.points).toHaveLength(3);
    expect(result.hasPower).toBe(false);
    expect(result.points.every(p => p.powerW == null)).toBe(true);
  });
});

describe('parseActivityText — file non valido', () => {
  it('lancia un errore chiaro se non trova nessun punto valido', () => {
    expect(() => parseActivityText('<gpx><trk><trkseg></trkseg></trk></gpx>')).toThrow(/nessun/i);
  });

  it('scarta punti senza tempo e li conta in discardedCount', () => {
    const gpxMissingTime = `<gpx><trk><trkseg>
      <trkpt lat="45.1" lon="11.1"><ele>200</ele><time>2026-06-01T08:00:00Z</time></trkpt>
      <trkpt lat="45.2" lon="11.1"><ele>201</ele></trkpt>
    </trkseg></trk></gpx>`;
    const result = parseActivityText(gpxMissingTime);
    expect(result.points).toHaveLength(1);
    expect(result.discardedCount).toBe(1);
  });
});
