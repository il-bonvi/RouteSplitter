import { useState, type ReactNode } from 'react';

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  /** Testo mostrato SOLO quando la sezione è chiusa (es. un promemoria di cosa contiene). */
  collapsedHint?: string;
  children: ReactNode;
  /** Modalità controllata (opzionale): se passati, lo stato aperto/chiuso vive nel genitore
   * invece che qui dentro — utile quando il genitore deve sapere se la sezione è aperta per
   * evitare calcoli inutili mentre è chiusa (es. una griglia fine ricalcolata solo a pannello
   * aperto). Se assenti, la sezione gestisce da sé il proprio stato (caso comune). */
  open?: boolean;
  onToggle?: (open: boolean) => void;
}

/**
 * Striscia cliccabile (titolo + freccia) che mostra/nasconde il contenuto sottostante — usata
 * per rendere OGNI card di questa vista collassabile individualmente, così l'utente può
 * chiudere quello che non gli serve al momento per vedere meglio quello che sta sotto, senza
 * dover scorrere oltre pannelli pesanti (mappa, grafici, tabelle). Non è essa stessa uno
 * `.physics-panel` — i componenti che avvolge hanno già il proprio stile di card; qui si
 * aggiunge solo il controllo di visibilità sopra.
 */
export function CollapsibleSection({ title, defaultOpen = true, collapsedHint, children, open: openProp, onToggle }: CollapsibleSectionProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const toggle = () => (onToggle ? onToggle(!open) : setOpenState(o => !o));
  return (
    <div className="pva-collapsible-section">
      <button type="button" className="pva-collapsible-strip" onClick={toggle}>
        <span className="pva-collapsible-chevron">{open ? '▼' : '▶'}</span>
        <span className="pva-collapsible-strip-title">{title}</span>
      </button>
      {!open && collapsedHint && <p className="pva-collapsible-hint">{collapsedHint}</p>}
      {open && <div className="pva-collapsible-content">{children}</div>}
    </div>
  );
}
