/** Colore associato a una pendenza (in %), stessa scala del prototipo originale. */
export function getGradientColor(gradient: number): string {
  const g = Math.max(-20, Math.min(20, Number.isFinite(gradient) ? gradient : 0));
  if (g < -15) return interpolateColor('#0f172a', '#1e3a8a', (g + 20) / 5);
  if (g < -10) return interpolateColor('#1e3a8a', '#3b82f6', (g + 15) / 5);
  if (g < -5) return interpolateColor('#3b82f6', '#60a5fa', (g + 10) / 5);
  if (g < 0) return interpolateColor('#60a5fa', '#22c55e', (g + 5) / 5);
  if (g < 5) return interpolateColor('#22c55e', '#fbbf24', g / 5);
  if (g < 8) return interpolateColor('#fbbf24', '#f97316', (g - 5) / 3);
  if (g < 11) return interpolateColor('#f97316', '#dc2626', (g - 8) / 3);
  if (g < 15) return interpolateColor('#dc2626', '#991b1b', (g - 11) / 4);
  return interpolateColor('#991b1b', '#450a0a', (g - 15) / 5);
}

export function interpolateColor(color1: string, color2: string, t: number): string {
  const c1 = hexToRgb(color1);
  const c2 = hexToRgb(color2);
  const r = Math.round(c1.r + (c2.r - c1.r) * t);
  const g = Math.round(c1.g + (c2.g - c1.g) * t);
  const b = Math.round(c1.b + (c2.b - c1.b) * t);
  return rgbToHex(r, g, b);
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return { r: 0, g: 0, b: 0 };
  return {
    r: parseInt(result[1]!, 16),
    g: parseInt(result[2]!, 16),
    b: parseInt(result[3]!, 16)
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
