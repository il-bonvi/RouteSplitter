import { useEffect, useState } from 'react';

interface NumberFieldProps {
  value: number;
  onCommit: (value: number) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
  placeholder?: string;
}

/**
 * Input numerico "controllato" senza il bug classico dei campi type=number in React:
 * con `value={numero}` e `onChange={e => setNumero(Number(e.target.value))}`, digitare
 * "52." viene subito convertito a 52 → il campo si ridisegna mostrando "52" → il punto
 * appena digitato sparisce, e il carattere successivo si combina in modo scorretto
 * (es. "52.5" diventa "0.5"). Qui invece si tiene il testo grezzo in stato locale
 * finché non serve, sincronizzandolo dall'esterno solo quando il valore cambia per
 * motivi non legati alla digitazione in corso (es. ricalcolo, cambio percorso).
 */
export function NumberField({ value, onCommit, step, min, max, className, placeholder }: NumberFieldProps) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    const parsed = parseFloat(text);
    if (!Number.isNaN(parsed) && parsed === value) return; // l'utente sta ancora scrivendo, non toccare
    setText(String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      type="number"
      // Forza il separatore decimale a "." indipendentemente dalla lingua del sistema: alcuni
      // browser (es. Chrome) mostrano il valore di un input number nel formato numerico della
      // lingua attiva (in italiano userebbero la virgola) pur restando "." nel valore JS
      // sottostante — risultato: due campi con lo stesso valore mostrati in modo diverso
      // (18.5 vs 18,5) a seconda di quale sia stato toccato per ultimo. Qui i dati dell'app
      // sono sempre in formato "." (JS/JSON), quindi anche la visualizzazione resta coerente.
      lang="en-US"
      className={className}
      step={step}
      min={min}
      max={max}
      placeholder={placeholder}
      value={text}
      onChange={e => {
        const raw = e.target.value;
        setText(raw);
        const parsed = parseFloat(raw);
        if (!Number.isNaN(parsed) && Number.isFinite(parsed)) onCommit(parsed);
      }}
      onBlur={() => {
        const parsed = parseFloat(text);
        setText(Number.isFinite(parsed) ? String(parsed) : String(value));
      }}
    />
  );
}
