import { describe, it, expect } from 'vitest';
import { formatTime, formatDeltaTime } from '../../src/lib/formatTime.js';

describe('formatTime', () => {
  it('formatta ore/minuti/secondi', () => {
    expect(formatTime(1.5)).toBe('1h 30m 00s');
    expect(formatTime(0.5)).toBe('30m 00s');
    expect(formatTime(1 / 3600)).toBe('1s');
  });
  it('— per valori non validi o non positivi', () => {
    expect(formatTime(0)).toBe('—');
    expect(formatTime(-1)).toBe('—');
    expect(formatTime(NaN)).toBe('—');
  });
});

describe('formatDeltaTime', () => {
  it('zero è un delta valido, non "—"', () => {
    expect(formatDeltaTime(0)).toBe('±0s');
  });
  it('formatta un ritardo (positivo) in h/m/s, non minuti decimali', () => {
    expect(formatDeltaTime(90 / 3600)).toBe('+1m 30s');
    expect(formatDeltaTime(5 / 3600)).toBe('+5s');
    expect(formatDeltaTime(1.5)).toBe('+1h 30m 00s');
  });
  it('formatta un anticipo (negativo) col segno meno', () => {
    expect(formatDeltaTime(-90 / 3600)).toBe('−1m 30s');
    expect(formatDeltaTime(-5 / 3600)).toBe('−5s');
  });
  it('— per valori non finiti', () => {
    expect(formatDeltaTime(NaN)).toBe('—');
  });
});
