import type { SectionResult } from '@physics-core';

function csvCell(value: string | number): string {
  const s = String(value);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

export function sectionsToCsv(sections: SectionResult[]): string {
  const header = [
    '#',
    'Nome',
    'Da (km)',
    'A (km)',
    'Distanza (km)',
    'D+ (m)',
    'D- (m)',
    'Pendenza (%)',
    'VAM (m/h)',
    'Potenza (W)',
    'Velocità (km/h)',
    'Tempo (s)',
    'Tempo cumulato (s)'
  ];
  const rows = sections.map(s => [
    s.index,
    s.to.sectionLabel ?? '',
    s.from.distKm.toFixed(3),
    s.to.distKm.toFixed(3),
    s.distanceKm.toFixed(3),
    Math.round(s.gain),
    Math.round(s.loss),
    s.gradient.toFixed(2),
    Math.round(s.vam),
    Math.round(s.powerWatts),
    s.speedKmh.toFixed(1),
    Math.round(s.timeHours * 3600),
    Math.round(s.cumTimeHours * 3600)
  ]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: `${mimeType};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
