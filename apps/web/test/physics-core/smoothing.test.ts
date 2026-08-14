import { describe, it, expect } from 'vitest';
import { smoothByDistance, lttb } from '../../src/physics-core/smoothing.js';

describe('smoothByDistance', () => {
  it('con raggio 0 (o non positivo) restituisce i valori invariati', () => {
    const values = [1, 5, 2, 8, 3];
    const distances = [0, 10, 20, 30, 40];
    expect(smoothByDistance(values, distances, 0)).toEqual(values);
  });

  it('smussa un picco isolato circondato da valori costanti', () => {
    const values = [10, 10, 10, 100, 10, 10, 10];
    const distances = [0, 10, 20, 30, 40, 50, 60];
    const smoothed = smoothByDistance(values, distances, 25);
    // il picco centrale deve risultare abbassato dalla media della finestra
    expect(smoothed[3]!).toBeLessThan(100);
    expect(smoothed[3]!).toBeGreaterThan(10);
  });

  it('la larghezza della finestra è fisica (metri), non un numero fisso di punti: un raggio più ampio include più vicinato indipendentemente da quanti punti ci sono in mezzo', () => {
    const values = [0, 0, 0, 0, 100, 0, 0, 0, 0];
    const distances = [0, 10, 20, 30, 40, 50, 60, 70, 80];
    const narrow = smoothByDistance(values, distances, 5); // include solo il punto stesso (40..40)
    const wide = smoothByDistance(values, distances, 35); // include quasi tutta la serie
    // Con finestra stretta il picco resta quasi intatto; con finestra larga viene diluito molto di più
    expect(narrow[4]!).toBeGreaterThan(wide[4]!);
    expect(narrow[4]!).toBeCloseTo(100, 0);
  });

  it('non include mai punti oltre il raggio fisico dichiarato', () => {
    const values = [0, 0, 0, 100, 0, 0, 0];
    const distances = [0, 100, 200, 300, 400, 500, 600];
    const smoothed = smoothByDistance(values, distances, 50); // raggio 50m: alla distanza 300 include solo se stesso
    expect(smoothed[3]!).toBeCloseTo(100, 6); // nessun vicino entro 50m in questa serie rada
  });
});

describe('lttb', () => {
  const makeSeries = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ dist: i, ele: Math.sin(i / 10) * 100 }));

  it('non altera serie già più corte della soglia', () => {
    const data = makeSeries(50);
    expect(lttb(data, 1800)).toHaveLength(50);
  });

  it('riduce correttamente serie più lunghe della soglia, preservando primo e ultimo punto', () => {
    const data = makeSeries(5000);
    const reduced = lttb(data, 1000);
    expect(reduced).toHaveLength(1000);
    expect(reduced[0]).toEqual(data[0]);
    expect(reduced[reduced.length - 1]).toEqual(data[data.length - 1]);
  });
});
