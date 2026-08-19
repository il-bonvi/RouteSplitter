const CARDINAL_NAMES = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

/** Nome cardinale italiano più vicino per una direzione in gradi bussola [0,360). */
export function cardinalName(directionDeg: number): string {
  const normalized = ((directionDeg % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return CARDINAL_NAMES[index]!;
}
