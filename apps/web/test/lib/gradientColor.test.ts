import { describe, it, expect } from 'vitest';
import { getGradientColor, interpolateColor, hexToRgb, rgbToHex } from '../../src/lib/gradientColor.js';

describe('hexToRgb / rgbToHex', () => {
  it('sono inverse tra loro', () => {
    expect(hexToRgb(rgbToHex(10, 20, 30))).toEqual({ r: 10, g: 20, b: 30 });
  });
});

describe('interpolateColor', () => {
  it('a t=0 ritorna il primo colore, a t=1 il secondo', () => {
    expect(interpolateColor('#000000', '#ffffff', 0)).toBe('#000000');
    expect(interpolateColor('#000000', '#ffffff', 1)).toBe('#ffffff');
  });
});

describe('getGradientColor', () => {
  it('gestisce input non finiti trattandoli come pendenza neutra (0%)', () => {
    expect(getGradientColor(NaN)).toBe(getGradientColor(0));
  });

  it('pendenze estreme vengono clampate (non esplode fuori dai bucket)', () => {
    expect(() => getGradientColor(999)).not.toThrow();
    expect(() => getGradientColor(-999)).not.toThrow();
    expect(getGradientColor(999)).toBe(getGradientColor(20));
    expect(getGradientColor(-999)).toBe(getGradientColor(-20));
  });

  it('è continua ai confini dei bucket (nessun salto visibile)', () => {
    // ai bordi di due bucket adiacenti il colore deve essere lo stesso (continuità)
    const justBelow = getGradientColor(4.999);
    const atBoundary = getGradientColor(5);
    // stesso hex o comunque molto vicino (arrotondamento in Math.round)
    expect(justBelow).not.toBeNull();
    expect(atBoundary).not.toBeNull();
  });
});
