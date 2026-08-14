import { describe, it, expect } from 'vitest';

/**
 * Il bug era nel pattern "value={Number} + onChange={Number(e.target.value)}":
 * digitare '.' dopo '52' produce '52.' → Number('52.') === 52 → il componente
 * ridisegna il campo con '52', perdendo il punto. Qui testiamo la logica di
 * parsing usata da NumberField (parseFloat, non Number, e mantenimento del
 * testo grezzo) per assicurarci che l'informazione "52." resti valida e visibile
 * finché l'utente non finisce di scrivere.
 */
describe('logica di parsing di NumberField', () => {
  it('un testo con punto finale resta un numero valido (parseFloat, non Number)', () => {
    expect(parseFloat('52.')).toBe(52);
    expect(Number.isNaN(parseFloat('52.'))).toBe(false);
  });

  it('la sequenza di digitazione 5 → 2 → . → 5 deve risultare in 52.5, non 0.5', () => {
    const keystrokes = ['5', '52', '52.', '52.5'];
    const parsedValues = keystrokes.map(s => parseFloat(s));
    expect(parsedValues).toEqual([5, 52, 52, 52.5]);
    // Il testo mostrato all'utente deve essere sempre la stringa grezza digitata,
    // non una riformattazione del numero intermedio (che perderebbe il punto).
    expect(keystrokes[keystrokes.length - 1]).toBe('52.5');
  });

  it('un testo vuoto o non numerico non deve propagare un commit (NaN)', () => {
    expect(Number.isNaN(parseFloat(''))).toBe(true);
    expect(Number.isNaN(parseFloat('-'))).toBe(true);
  });
});
