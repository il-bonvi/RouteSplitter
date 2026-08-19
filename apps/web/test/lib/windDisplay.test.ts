import { describe, it, expect } from 'vitest';
import { cardinalName } from '../../src/lib/windDisplay.js';

describe('cardinalName', () => {
  it('mappa gli 8 punti cardinali principali', () => {
    expect(cardinalName(0)).toBe('N');
    expect(cardinalName(45)).toBe('NE');
    expect(cardinalName(90)).toBe('E');
    expect(cardinalName(135)).toBe('SE');
    expect(cardinalName(180)).toBe('S');
    expect(cardinalName(225)).toBe('SO');
    expect(cardinalName(270)).toBe('O');
    expect(cardinalName(315)).toBe('NO');
  });

  it('gestisce il wraparound vicino a 360°', () => {
    expect(cardinalName(359)).toBe('N');
    expect(cardinalName(360)).toBe('N');
    expect(cardinalName(-1)).toBe('N');
  });
});
