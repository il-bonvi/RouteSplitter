# RouteSplitter — Stato del progetto

> **Questo file è il riferimento completo del progetto.** Viene aggiornato ad ogni modifica
> significativa (decisione architetturale, fix, nuovo modulo, cambio di rotta), anche senza
> che venga chiesto esplicitamente. Se una nuova sessione riparte da zero (nuova chat), questo
> documento deve bastare da solo a ricostruire tutto il contesto: cosa esiste, perché è stato
> deciso così, cosa manca, cosa fare dopo.

**Ultimo aggiornamento:** 2026-08-14
**Fase attuale:** 5 bug/regressioni segnalati dall'utente dopo il primo test in browser reale, tutti corretti: input decimali, hover grafico che spariva, funzioni aggiungi-punto-a-km/ogni-N-km mancanti, export CSV al posto di export/import JSON originali, pulsante ricentra mappa mancante. 87 test verdi, typecheck/build puliti.

---

## 1. Visione di prodotto

RouteSplitter è uno strumento per ciclisti seri / coach ciclistici che copre il flusso
**percorso → calibrazione → piano → esecuzione → verifica**:

- segmentare e visualizzare percorsi GPX (mappa, altimetria, sezioni editabili);
- predire velocità e tempo a partire da potenza (o il contrario) con un modello fisico di equilibrio delle forze;
- ottimizzare la distribuzione di potenza lungo il percorso a media (e NP) target;
- stimare CdA da dati di campo;
- visualizzare ed esportare il piano potenza previsto (con medie mobili).

Riferimenti di mercato: Best Bike Split, myWindsock. Non si punta a replicare un competitor,
ma a offrire trasparenza totale delle ipotesi/formule e controllo pieno da parte di atleta e coach.

**Traiettoria di prodotto**: oggi tool personale mono-utente; in futuro (non v1) piattaforma
multi-dispositivo per un coach con più atleti, con login e dati condivisi. Questa evoluzione
è la ragione del cambio di stack tecnologico deciso in questa fase (vedi §3, decisione D1).

---

## 2. Stato attuale — riassunto rapido

| Cosa | Stato |
|---|---|
| Prototipo originale (`index(8).html`, monolite HTML/CSS/JS + Leaflet + D3) | Superato architetturalmente, mantenuto come riferimento storico |
| Review tecnica/scientifica/performance completa | Fatta, vedi `RouteSplitter_Review.md` |
| Struttura progetto | **Un solo pacchetto npm** (`apps/web`), non più monorepo multi-pacchetto (vedi D16 — la separazione in pacchetti `physics-core`/`shared-schema`/`data-store` è stata provata e poi consolidata in cartelle dentro `src/`, perché con un solo consumatore reale il costo del multi-pacchetto superava il beneficio) |
| Fisica (`src/physics-core/`) | **Completo**: bilancio forze, velocità↔potenza, stima CdA (fix segno vento), NP standard, ottimizzatore pacing unificato |
| Schema dati (`src/shared-schema/`) | **Completo**: Athlete, Bike, Route, SectionPlan, PowerPlan, Activity (stub) — Zod, versionati, con bound di validazione |
| Persistenza (`src/data-store/`) | **Completo**: interfaccia astratta `DataStore` + implementazione IndexedDB (Dexie) |
| UI (`src/components/`, ecc.) | **Flusso completo**: upload → mappa/grafico colorati per pendenza con hover sincronizzato → editor sezioni (click su mappa/grafico per aggiungere, click su marker per rimuovere) → tabella sezioni editabile → pannello parametri fisici → stima CdA da campo → ottimizzatore di pacing (per sezioni o griglia fine) → export CSV. Mancano: grafico piano potenza, persistenza PowerPlan, report PDF, gestione atleti/bici |
| Test | 60 test Vitest, tutti verdi, in un solo comando (`npm test`) |
| Build/typecheck | Puliti (`npm run build`, `npm run typecheck`) |
| **UI in un browser reale** | ⚠️ Non verificata in questa sessione (nessun ambiente browser disponibile) |
| Backend/auth/multi-atleta | Rimandato di proposito (vedi D2, D3) |

---

## 3. Decisioni architetturali (log, in ordine cronologico)

| ID | Decisione | Motivazione |
|---|---|---|
| D1 | Cambio di stack tecnologico, riscrittura completa (non incrementale) | Il prototipo monolitico non può sostenere l'obiettivo futuro di multi-dispositivo/multi-atleta con backend+auth. Scelta esplicita dell'utente: "riscrittura completa" invece di migrazione incrementale |
| D2 | Nessun login/autenticazione nella v1 | L'utente vuole prima costruire ed usare uno strumento solido per sé, aggiungere coach/atleti/login dopo averlo validato sul campo |
| D3 | Nessun backend/Supabase per ora | L'utente ha già 2 progetti Supabase attivi, preferisce non aprirne un terzo finché non serve davvero. Decisione di infrastruttura (Supabase vs self-hosted) esplicitamente rimandata |
| D4 | **Vite + React + TypeScript come SPA statica**, non Next.js | Next.js era stato proposto quando si pensava a backend+auth integrati da subito (D2/D3 hanno reso quel vantaggio non rilevante ora). Vite dà avvio di sviluppo più semplice, build statica, nessun server richiesto. Il codice React/TS scritto ora non si butta via se in futuro si aggiunge un backend (Next.js o altro) |
| D5 | Livello dati dietro un'interfaccia astratta `DataStore`, prima implementazione **IndexedDB** locale (via Dexie.js, non ancora implementata) | Permette di aggiungere in futuro una seconda implementazione (Supabase o altro) senza toccare il resto dell'app. Sostituisce sia `localStorage` sia la dipendenza totale da export/import manuale del prototipo |
| D6 | Lo schema dati è modellato **già pensando al multi-atleta** (coach→athlete→bike→route→plan), anche se oggi l'utente è semplicemente "atleta #1" gestito in locale | Evita una migrazione di schema dolorosa quando in futuro si aggiungerà login/multi-utente |
| D7 | ~~Monorepo con workspace npm (`"workspaces"`)~~ — **superata da D16**, vedi sotto | pnpm→npm per zero installazioni extra. Poi l'intera struttura multi-pacchetto è stata smontata (D16) |
| D16 | **Consolidamento in un solo pacchetto npm** (`apps/web`): `physics-core`/`shared-schema`/`data-store` non sono più pacchetti npm separati (con build/dist propri), ma cartelle sotto `src/` con alias TS/Vite (`@physics-core`, `@shared-schema`, `@data-store`) che puntano direttamente ai file `.ts` sorgente | Motivo tecnico concreto trovato durante la discussione: i pacchetti separati avevano `"main": "./dist/index.js"`, quindi `apps/web` leggeva la build compilata, non i sorgenti — modificare `physics-core` senza rilanciare `build` non si vedeva in dev. Con un solo consumatore reale (nessun backend ancora), il vantaggio della separazione in pacchetti pubblicabili era solo teorico, mentre il costo (4 `package.json`, rebuild manuale, più concetti da capire) era reale. Se in futuro nascerà un secondo consumatore (es. backend), si potrà re-estrarre un pacchetto in quel momento — refactor noto e a basso rischio. Non è stata persa organizzazione logica: le cartelle restano separate con confini chiari, si è persa solo l'infrastruttura di pubblicazione/build indipendente |
| D8 | **Nucleo fisico unificato**: un'unica funzione `optimizePacing()` sostituisce le due funzioni quasi duplicate del prototipo (`optimizePacing`/`optimizePacingFull`), parametrizzata sulla granularità dei segmenti | Elimina la duplicazione segnalata nella review (rischio: bug fixato in una copia e non nell'altra — successo realmente con il bug NP nel prototipo) |
| D9 | Versioning dello schema dati: campo `schemaVersion` esplicito su ogni entità persistita | I file "sezioni_*.json" già esportati dal prototipo devono restare leggibili/migrabili. **Fatto** in `shared-schema` (`EntityBaseSchema`, `CURRENT_SCHEMA_VERSION`) |
| D10 | Entità **non annidate**: Route (metadati) / RoutePointsPayload (punti grezzi) / SectionPlan / PowerPlan / Activity sono record separati collegati per id, non oggetti innestati l'uno nell'altro | Un percorso può avere più piani di sezionamento nel tempo, e un piano più PowerPlan (es. what-if della Fase 1, F1.3); i punti grezzi (migliaia) non devono appesantire ogni lettura dei soli metadati percorso |
| D11 | Bound di validazione espliciti sui parametri fisici (Zod, `PhysicsParamsSchema`) | Chiude un gap segnalato nella review originale: il prototipo non aveva alcun limite di sanità sui campi fisici, un refuso tipo "CdA=2.8" passava silenzioso |
| D12 | `DataStore` come interfaccia astratta (repository per entità), `createIndexedDbDataStore()` come unica implementazione per ora | La UI dipenderà sempre dall'interfaccia, mai da Dexie direttamente — quando servirà un backend condiviso si scriverà una seconda implementazione con la stessa forma, coerente con D5 |
| D13 | `PowerPlan` non ha `update()`, solo `create()`/`delete()`: un ricalcolo genera un nuovo record invece di sovrascrivere | Permette di confrontare tentativi diversi di ottimizzazione (what-if, F1.3) senza perdere lo storico; nessuna decisione ancora presa su un'eventuale UI per "pulire" i vecchi tentativi |
| D14 | `apps/web` costruita a **fette verticali funzionanti**, non per "layer" (prima tutta la UI, poi collegarla) | Ogni fetta (oggi: upload→salvataggio→mappa) è verificabile end-to-end (build+typecheck) prima di passare alla successiva, invece di scrivere tanto codice non testabile fino alla fine |
| D15 | I componenti dipendono **solo** da `useDataStore()` (l'interfaccia astratta) e dalle funzioni pure di `physics-core`, mai da Dexie/IndexedDB direttamente | Coerente con D12: quando arriverà un'eventuale implementazione backend del DataStore, i componenti non cambiano |
| D16 | **Consolidamento in un solo pacchetto npm** (`apps/web`): `physics-core`/`shared-schema`/`data-store` non sono più pacchetti npm separati (con build/dist propri), ma cartelle sotto `src/` con alias TS/Vite (`@physics-core`, `@shared-schema`, `@data-store`) che puntano direttamente ai file `.ts` sorgente | Motivo tecnico concreto trovato durante la discussione: i pacchetti separati avevano `"main": "./dist/index.js"`, quindi `apps/web` leggeva la build compilata, non i sorgenti — modificare `physics-core` senza rilanciare `build` non si vedeva in dev. Con un solo consumatore reale (nessun backend ancora), il vantaggio della separazione in pacchetti pubblicabili era solo teorico, mentre il costo (4 `package.json`, rebuild manuale, più concetti da capire) era reale. Se in futuro nascerà un secondo consumatore (es. backend), si potrà re-estrarre un pacchetto in quel momento — refactor noto e a basso rischio. Non è stata persa organizzazione logica: le cartelle restano separate con confini chiari, si è persa solo l'infrastruttura di pubblicazione/build indipendente |
| D17 | `computeSections()` vive in `physics-core` (non nella UI) | È logica pura (derivare statistiche di sezione da breakpoint + percorso + parametri fisici), riusabile da UI, futuro export/report, eventuale backend — stesso ragionamento già applicato a `optimizePacing`/NP |
| D18 | Un solo `SectionPlan` per percorso creato automaticamente al primo caricamento (non un flusso esplicito "crea piano") | Riduce l'attrito: l'utente non deve pensare alla differenza tra percorso e piano finché non gli servirà davvero avere più piani per lo stesso percorso (feature non ancora costruita — lo schema già lo permette, vedi D10) |
| D19 | Gli aggiornamenti massivi di potenza dall'ottimizzatore passano da un metodo dedicato (`applyPowerUpdates`, un solo salvataggio) invece di N chiamate sequenziali a `updateBreakpoint` | N chiamate sequenziali senza await tra loro catturerebbero ognuna uno stato `plan` non ancora sincronizzato con la precedente, perdendo aggiornamenti — bug di concorrenza tipico di React che si evita strutturalmente invece di scoprirlo in produzione |
| D20 | ~~Sistema di design con colore unico ember, tipografia Space Grotesk/IBM Plex~~ — **RESPINTA dall'utente**, vedi D21 | Cambiare lo stile senza che fosse richiesto è stato un errore: l'utente ha riportato il prototipo originale esatto chiedendo di ripartire da quello. Lezione: non toccare stile/layout se non esplicitamente richiesto, specialmente quando l'obiettivo dichiarato è "ampliare lo strumento", non cambiarlo |
| D21 | **Stile e layout ripristinati fedelmente all'originale**: stessi token colore (`--bg`, `--surface`, `--accent`/`--accent2`/`--accent3`/`--accent4`/`--accent5`), stessi font (Outfit/JetBrains Mono/Inter via @import), stesso schema colore per-metrica su stat-card e tabella sezioni, pannelli mappa/grafico chiari (`.panel`, Inter) dentro shell scura come nell'originale | Fedeltà esplicitamente richiesta dall'utente |
| D22 | **Rimossa la sidebar fissa a sinistra** per upload/lista percorsi (introdotta nello scaffolding iniziale, mai presente nell'originale) — sostituita con vista singola: schermata di caricamento (upload + eventuali percorsi recenti in lista, non fissa) che si trasforma nella vista percorso attivo (identico schema originale: nessuna vista, un `uploadSection`/`appContent` in mutua esclusione) | L'utente ha segnalato esplicitamente che una sidebar fissa per il caricamento file "non ha senso" — corretto: l'originale non l'aveva, e la persistenza multi-percorso (novità di questo stack) non richiede una sidebar sempre visibile, basta mostrare i percorsi salvati quando si è nella schermata di selezione |
| D23 | Creato `NumberField`: input numerico con testo grezzo in stato locale, sincronizzato dall'esterno solo quando il valore cambia per motivi non legati alla digitazione | Bug reale segnalato dall'utente: `<input type="number" value={numero} onChange={e => setNumero(Number(e.target.value))}>` perde il punto decimale mentre si scrive (digitare "52." viene convertito subito a 52, il campo si ridisegna "52", il carattere appena scritto sparisce) — pattern noto dei number input controllati in React, corretto una volta per tutte in un componente condiviso invece che nei singoli punti |
| D24 | Nei callback passati a `ElevationChart` (`onHoverPoint`, `onAddBreakpoint`, `onRemoveBreakpoint`) si usa un ref aggiornato via `useEffect`, non le funzioni direttamente nelle dipendenze dell'effetto D3 | Bug reale segnalato dall'utente: l'hover sul grafico appariva muovendo il mouse e spariva fermandosi. Causa: i callback erano funzioni inline ricreate ad ogni render del genitore; essendo nelle dipendenze dell'effetto D3, ogni hover triggerava un ricalcolo di stato nel genitore → nuova identità della funzione → l'intero effetto ripartiva (`container.innerHTML=''`) → il grafico veniva ridisegnato da zero, con l'hover sempre resettato a invisibile. Effetto collaterale positivo: risolve anche un problema di performance (rebuild completo SVG ad ogni evento mouse) segnalato nella review originale |
| D25 | `computeSections()` (physics-core) ora alimenta anche le card riassuntive per sezione disegnate sopra il grafico altimetria (indice/distanza/tempo/potenza/velocità), passate come prop `sections` a `ElevationChart` invece di essere ricalcolate lì dentro | Evita una seconda implementazione della stessa logica dentro il componente grafico; il grafico riceve dati già pronti, resta un consumatore puro |
| D26 | Ripristinate le funzioni "aggiungi punto a un km preciso" e "sezioni ogni N km" perse nella riscrittura, quest'ultima con un solo salvataggio per tutti i punti aggiunti (non N salvataggi sequenziali) | Stessa cautela già applicata a `applyPowerUpdates` (D19): salvataggi sequenziali su stato React non ancora sincronizzato rischiano di perdersi a vicenda |
| D27 | Ripristinato l'export/import **JSON** delle sezioni (stesso formato del prototipo: chiavi `speed`/`power`, struttura `routesplitter-sections`), l'export **CSV** introdotto nella sessione precedente resta come aggiunta ulteriore, non sostituisce l'originale | L'utente ha segnalato che l'export CSV non esisteva nel prototipo — corretto, esistevano export/import JSON delle sezioni (persistenza portabile tra browser/dispositivi, utile anche ora che c'è IndexedDB perché permette di condividere un piano con altri) |

### Stack tecnico concordato

| Livello | Scelta |
|---|---|
| Build/dev | Vite + React + TypeScript |
| Nucleo fisico | `@routesplitter/physics-core` — TS puro, zero dipendenze da DOM/framework, testato con Vitest |
| Dati locali | IndexedDB (Dexie.js) dietro interfaccia `DataStore` — **da fare** |
| Backup/portabilità | Export/import JSON (come nel prototipo), da riportare nella nuova app |
| Mappa | `react-leaflet` — **da fare** |
| Grafico altimetria/potenza | D3 imperativo dentro componente React (`useRef`+`useEffect`) — **da fare**, troppo custom (brush zoom, gradient fill, hover sincronizzato mappa↔grafico) per una libreria a scatola chiusa |
| Test unità | Vitest — impostato su `physics-core`, da estendere agli altri pacchetti |
| Test E2E | Playwright — **da fare**, non ancora impostato |
| Backend/auth/DB | Nessuno per ora. Quando servirà: Supabase (Postgres+Auth+Storage+RLS) probabile prima scelta, ma da confermare — vedi §6 decisioni aperte |

---

## 4. Nucleo fisico — problemi trovati in review e stato di risoluzione

Dalla review tecnica completa (`RouteSplitter_Review.md`, §5):

| # | Problema | Stato | Dove |
|---|---|---|---|
| 1 | D+/D− calcolato su elevazione grezza mentre il grafico usa quella smussata | **Non è un bug** — verificato che il codice originale già usa sempre dati grezzi per le statistiche; lo smoothing è (correttamente) solo grafico. Nessuna modifica necessaria. Principio confermato esplicitamente dall'utente e applicato in `physics-core` (vedi commenti in `geo.ts`) | `packages/physics-core/src/geo.ts` |
| 2 | Normalized Power calcolata in modo non standard (pesata per numero di segmenti/celle, niente finestra mobile 30s) | **Corretto** — sia nel prototipo HTML sia (in modo pulito, testato) in `physics-core` | `RouteSplitter_fix_NP_aero.html` + `packages/physics-core/src/normalizedPower.ts` |
| 3 | Drag aerodinamico non firmato rispetto al vento relativo (`rel*rel` invece di `rel*|rel|`) | **Corretto** — sia nel prototipo HTML sia in `physics-core`, con test dedicato al caso limite (vento in coda più forte della velocità di marcia) | `RouteSplitter_fix_NP_aero.html` + `packages/physics-core/src/physics.ts` |
| 4 | Stima CdA a singolo punto medio, bias da disuguaglianza di Jensen su tratti misti | **Deliberatamente rimandato** — da affrontare quando si amplierà la gestione del vento (Fase 3 roadmap, stima CdA multi-punto/da file attività). Commento esplicito lasciato nel codice (`physics.ts`, `estimateCda`) | Roadmap Fase 3 (F3.1/F3.2) |
| — | Pendenza rumorosa sui segmenti fini dell'ottimizzatore completo (griglia a step piccoli, es. 100m) | **Non è un problema da correggere**: lo step è configurabile dall'utente, quindi il trade-off rumore/risoluzione è già sotto il suo controllo diretto. Nessuna azione richiesta | — |

### Altri problemi noti dalla review, non ancora affrontati (tracciati per fasi future)

Dalla sezione "Roadmap prioritizzata" della review originale — priorità media/bassa, non ancora iniziati:

- Densità aria variabile con la quota (formula barometrica) — Fase 1 roadmap (F1.2)
- Vento vettoriale per bearing del segmento — Fase 1 roadmap (F1.1)
- Modello di affaticamento (CP/W′) e vincoli di rampa nell'ottimizzatore — Fase 5 roadmap (F5.6), Fase 2 (F2.3)
- Refactor ottimizzatore verso vincolo di energia totale (kJ) invece di potenza media — non ancora in roadmap esplicita, da valutare quando si rivede l'ottimizzatore
- Override locale di Crr per superfici miste — Fase 5 roadmap (F5.3)
- Performance mappa (migliaia di polilinee Leaflet separate, una per punto) — **Risolto** in `buildColorSegments.ts`: segmenti consecutivi con lo stesso colore (dopo quantizzazione del gradiente) vengono uniti in un'unica polyline, testato esplicitamente (vedi `test/lib/buildColorSegments.test.ts`)
- Performance: rebuild completo SVG ad ogni edit — **probabilmente non più un problema** con React (il grafico si ri-renderizza solo quando cambiano `points`/`smoothingRadiusMeters`, non ad ogni interazione UI non correlata), ma da tenere d'occhio quando arriverà la tabella sezioni (ogni edit di una cella non deve ri-renderizzare il grafico)
- O(n·m) nel calcolo dislivelli (`computeGainLossBetween` per sezione) — non ancora rilevante, l'editor sezioni non esiste ancora; da tenere presente quando arriva
- Rischio CORS/export mappa statica, uso intensivo tile OSM — da riconsiderare quando si costruisce l'export report nella nuova app
- **Nuovo**: bundle di produzione a 532 KB (164 KB gzip), sopra la soglia di warning di Vite (500 KB) — dovuto principalmente a Leaflet+D3+React insieme. Non urgente con un solo utente, ma da tenere presente se la UI cresce ancora molto: soluzione standard è code-splitting (`import()` dinamico per i pannelli meno usati, es. export/report)
- Validazione input GPX (coordinate NaN, elevazione mancante) — **Risolto strutturalmente** da `RawTrackPointSchema` in `shared-schema` (blocca lat/lon/ele non finiti o fuori range fisico alla validazione, prima che entrino nella catena di calcolo). Resta da collegare al parsing GPX vero e proprio quando si scrive quel modulo in `apps/web`
- Assenza di bound di sanità sui parametri fisici in input (es. refuso CdA "2.8" invece di "0.28") — **Risolto** da `PhysicsParamsSchema` in `shared-schema` (range plausibili per ciclismo su strada, con test dedicati)
- Autosave — assorbito dal passaggio a IndexedDB (D5), non serve più un meccanismo separato

---

## 5. File prodotti finora (tutti in `/mnt/user-data/outputs/`)

| File | Contenuto |
|---|---|
| `RouteSplitter_Review.md` | Review tecnica/scientifica/performance completa del prototipo originale |
| `RouteSplitter_fix_NP_aero.html` | Prototipo HTML originale con i fix di NP e segno aerodinamico applicati (snapshot storico, precedente alla decisione di riscrittura) |
| `routesplitter-web.zip` | **Progetto attuale** (singolo pacchetto npm, ex-monorepo consolidato — vedi D16): sorgenti, test, config. Sostituisce tutti gli zip precedenti (`routesplitter-physics-core.zip`, `routesplitter-monorepo.zip`, ormai superati) |
| `stato_rs.md` | Questo documento |
| `COME_INIZIARE.md` | Istruzioni per avviare l'ambiente di sviluppo da zero |

---

## 6. Struttura repository attuale

```
routesplitter/
├── stato_rs.md              ← questo file
├── COME_INIZIARE.md
├── .gitignore
└── apps/
    └── web/                  ← TUTTO IL PROGETTO VIVE QUI (nessun altro pacchetto)
        ├── package.json       un solo package.json, tutte le dipendenze
        ├── vite.config.ts     build + alias (@physics-core, @shared-schema, @data-store) + config Vitest
        ├── tsconfig.json / tsconfig.app.json / tsconfig.node.json
        ├── index.html
        ├── src/
        │   ├── main.tsx, App.tsx, index.css
        │   ├── physics-core/        ex pacchetto, ora cartella — fisica pura, ZERO dipendenze da React/DOM
        │   │   ├── types.ts          PhysicsParams, PowerSegment, OptimizableSegment
        │   │   ├── physics.ts        wheelPowerAtSpeed, speedFromPower, powerFromSpeed, estimateCda
        │   │   ├── geo.ts             haversine, processRoute, getInterpolatedPoint, computeGainLossBetween
        │   │   ├── smoothing.ts       smoothByDistance, lttb (solo uso grafico)
        │   │   ├── normalizedPower.ts NP standard (media mobile 30s pesata sul tempo)
        │   │   ├── pacingOptimizer.ts optimizePacing (UNIFICATO sezioni/griglia fine)
        │   │   └── index.ts           API pubblica del modulo — importare SEMPRE da qui (alias @physics-core)
        │   ├── shared-schema/        ex pacchetto, ora cartella — tipi Zod versionati
        │   │   ├── common.ts, physicsParams.ts, athlete.ts, bike.ts, route.ts,
        │   │   │   sectionPlan.ts, powerPlan.ts, activity.ts
        │   │   └── index.ts           alias @shared-schema
        │   ├── data-store/           ex pacchetto, ora cartella — persistenza IndexedDB
        │   │   ├── common.ts, db.ts, types.ts, indexedDbDataStore.ts
        │   │   ├── repositories/      un file per entità
        │   │   └── index.ts           alias @data-store
        │   ├── physics-core/         ex pacchetto, ora cartella — fisica pura, ZERO dipendenze da React/DOM
        │   │   ├── types.ts          PhysicsParams, PowerSegment, OptimizableSegment
        │   │   ├── physics.ts        wheelPowerAtSpeed, speedFromPower, powerFromSpeed, estimateCda
        │   │   ├── geo.ts             haversine, processRoute, getInterpolatedPoint, computeGainLossBetween
        │   │   ├── smoothing.ts       smoothByDistance, lttb (solo uso grafico)
        │   │   ├── normalizedPower.ts NP standard (media mobile 30s pesata sul tempo)
        │   │   ├── pacingOptimizer.ts optimizePacing (UNIFICATO sezioni/griglia fine)
        │   │   ├── sections.ts        computeSections — statistiche per sezione da breakpoint+percorso+fisica
        │   │   └── index.ts           API pubblica del modulo — importare SEMPRE da qui (alias @physics-core)
        │   ├── shared-schema/        ex pacchetto, ora cartella — tipi Zod versionati
        │   │   ├── common.ts, physicsParams.ts, athlete.ts, bike.ts, route.ts,
        │   │   │   sectionPlan.ts, powerPlan.ts, activity.ts
        │   │   └── index.ts           alias @shared-schema
        │   ├── data-store/           ex pacchetto, ora cartella — persistenza IndexedDB
        │   │   ├── common.ts, db.ts, types.ts, indexedDbDataStore.ts
        │   │   ├── repositories/      un file per entità
        │   │   └── index.ts           alias @data-store
        │   ├── hooks/
        │   │   └── useSectionPlan.ts  + addBreakpointsEvery, replaceBreakpoints (import JSON) — RIPRISTINATI
        │   ├── lib/
        │   │   ├── DataStoreContext.tsx   useDataStore() — unico punto di accesso al DataStore in React
        │   │   ├── gradientColor.ts       scala colori per pendenza (porting dal prototipo)
        │   │   ├── buildColorSegments.ts  raggruppa punti consecutivi stesso colore → poche polyline, non una per punto
        │   │   ├── pacingActions.ts       breakpoint→segmenti, griglia fine, mappatura risultati sulle sezioni
        │   │   ├── exportCsv.ts           export CSV tabella sezioni (aggiunta, non nel prototipo originale)
        │   │   ├── exportImportSections.ts  export/import JSON sezioni — RIPRISTINATO (formato originale)
        │   │   └── formatTime.ts          condiviso (prima duplicato in 3 componenti)
        │   ├── gpx/
        │   │   └── parseGpx.ts        parsing GPX browser (DOMParser) + validazione Zod dei punti
        │   └── components/
        │       ├── RouteSplitterApp.tsx   orchestratore principale
        │       ├── UploadZone.tsx, RouteList.tsx, StatsRow.tsx
        │       ├── RouteMap.tsx           mappa colorata per pendenza, marker sezioni, click add/remove, + RecenterControl (⌖) RIPRISTINATO
        │       ├── ElevationChart.tsx     grafico D3 — fix bug hover (ref invece di deps), scala Y identica all'originale, card sezioni, barra selezione RIPRISTINATE
        │       ├── SectionsTable.tsx      tabella sezioni editabile + totali
        │       ├── PhysicsParamsPanel.tsx pannello parametri fisici + toggle velocità/potenza
        │       ├── CdaEstimator.tsx       stima CdA da campo
        │       ├── PacingOptimizerPanel.tsx  "Ottimizza sezioni" / "Ottimizza completo"
        │       ├── SmoothingControl.tsx   ora montato DENTRO ElevationChart (era standalone)
        │       └── NumberField.tsx        NUOVO — fix bug perdita del punto decimale in digitazione
        └── test/                      87 test, 17 file, tutti verdi (`npm test`)
            ├── setup.ts                polyfill IndexedDB (fake-indexeddb) per i test di data-store
            ├── physics-core/           35 test (incluso sections.ts)
            ├── shared-schema/          19 test
            ├── data-store/             10 test
            └── lib/                    14 test (gradientColor, buildColorSegments, pacingActions, exportCsv)
```

**Regola di importazione**: da fuori un modulo (`physics-core`/`shared-schema`/`data-store`), si importa sempre e solo dall'`index.ts` di quel modulo, tramite l'alias configurato in `vite.config.ts` e `tsconfig.app.json` (`@physics-core`, `@shared-schema`, `@data-store`) — mai un file interno diretto. Dentro lo stesso modulo, import relativi tra i file (`./physics.js`, ecc.).

---

## 7. Roadmap funzionale

Basata sul documento roadmap fornito dall'utente (2026-08-10), con l'aggiunta di una Fase 0
tecnica emersa durante la discussione (assente nel documento originale).

### Fase 0 — Fondamenta tecniche *(nuova, proposta durante la migrazione di stack)*

| ID | Iniziativa | Stato |
|---|---|---|
| F0.1 | Progetto npm + TypeScript strict configurato | ✅ Fatto (pnpm workspaces → npm workspaces → consolidato in singolo pacchetto, vedi D7/D16) |
| F0.2 | `physics-core`: porting fisica/ottimizzatore/geometria/smoothing/NP, con test | ✅ Fatto |
| F0.3 | `shared-schema`: tipi Zod (Route, Section, PowerPlan, Athlete, Bike) + `schemaVersion` | ✅ Fatto |
| F0.4 | `data-store`: interfaccia astratta + implementazione IndexedDB | ✅ Fatto |
| F0.5 | `apps/web`: scaffolding Vite+React, parità funzionale UI col prototipo (mappa, grafico, tabella, pannello fisica/pacing) | 🟡 In corso — prima fetta verticale fatta (vedi sotto), parità completa non ancora raggiunta |

**Dettaglio F0.5 — cosa esiste e cosa manca ancora in `apps/web`:**

| Funzionalità | Stato |
|---|---|
| Upload GPX (drag&drop o click), parsing con validazione | ✅ Fatto |
| Salvataggio percorso in IndexedDB (`data-store`) | ✅ Fatto |
| Lista percorsi salvati, selezione, cancellazione | ✅ Fatto |
| Statistiche riassuntive (distanza, D+/D-, quota min/max) | ✅ Fatto |
| Mappa con tracciato | ✅ Fatto: colorata per pendenza, segmenti consecutivi dello stesso colore raggruppati (non una polyline per punto — evita l'anti-pattern di performance segnalato in review), marker sincronizzato con l'hover del grafico |
| Grafico altimetria interattivo (D3: brush zoom, hover, colore pendenza) | ✅ Fatto: area+linea colorate per pendenza (dato smussato SOLO qui, mai nelle statistiche), hover con tooltip e marker sincronizzato sulla mappa, drag-to-zoom, doppio clic reset, downsampling LTTB oltre 2000 punti. **Non ancora fatto**: pannello statistiche sulla selezione brushed (distanza/D+/D-/pendenza media del tratto selezionato — presente nel prototipo, qui omesso per ora) |
| Editor sezioni/breakpoint (aggiungi/rimuovi punti, sulla mappa e sul grafico) | ✅ Fatto: modalità "aggiungi punto" con toggle, click su mappa o grafico per aggiungere, click su marker per rimuovere (mai sui punti fissi start/finish), rinumerazione automatica etichette S1/S2/..., **più aggiunta a un km preciso e "sezioni ogni N km"** (ripristinate, erano andate perse in una riscrittura). Persistito via `SectionPlan`. **Non fatto**: trascinamento (drag) per spostare un punto esistente — oggi si rimuove e si riaggiunge |
| Tabella sezioni (distanza/D+/D-/pendenza/VAM/potenza/velocità/tempo per sezione) | ✅ Fatto: nome editabile, velocità o potenza editabile a seconda della modalità, resto calcolato e sola lettura, riga totali |
| Pannello parametri fisici (peso, CdA, Crr, vento...) collegato a `physics-core` | ✅ Fatto: 7 campi (massa ciclista/bici, CdA, Crr, densità aria, drivetrain loss, vento) + toggle velocità↔potenza. **Non persistito**: oggi è solo stato React locale (si perde ricaricando la pagina) — andrà collegato a un profilo Athlete/Bike quando esisterà quella UI |
| Modalità velocità↔potenza, stima CdA da campo | ✅ Fatto: toggle nel pannello fisica; stimatore CdA da singolo campione (velocità/potenza/pendenza) con pulsante "Applica" — stesso limite già noto (bias su tratti non uniformi, vedi §4) |
| Pacing optimizer (UI che chiama `optimizePacing` da `physics-core`) | ✅ Fatto: "Ottimizza sezioni" (lavora sulle sezioni utente) e "Ottimizza completo" (griglia fine configurabile, poi mappata sulle sezioni per media pesata sulla distanza di sovrapposizione — stessa logica del prototipo originale, testata). **Non fatto**: la griglia fine calcolata da "Ottimizza completo" non viene persistita come `PowerPlan` (lo schema/repository esistono già e sono pronti, manca solo il collegamento) — quindi oggi non c'è ancora uno storico dei piani provati, né il grafico "piano potenza" che lo visualizzerebbe |
| Grafico piano potenza (medie mobili configurabili) | ⬜ Da fare — dipende dal punto sopra (serve prima persistere/tenere in memoria il risultato della griglia fine) |
| Export/import sezioni (JSON, formato originale) | ✅ Fatto: ripristinati dopo essere stati sostituiti per errore da un semplice CSV nella sessione precedente (l'export CSV resta comunque disponibile come aggiunta) |
| Export CSV | ✅ Fatto (aggiunta rispetto all'originale, non lo sostituisce) |
| Pulsante "ricentra sul percorso" in mappa | ✅ Fatto: ripristinato (⌖ nella barra di zoom Leaflet) |
| Export/report PDF | ⬜ Da fare (Fase 4 roadmap, F4.3) — nel prototipo aveva anche un rischio CORS noto sull'export mappa statica, da tenere presente |
| Gestione profili Athlete/Bike (creazione, associazione percorsi) | ⬜ Da fare — oggi tutti i percorsi hanno `athleteId: null`, lo schema/data-store sono già pronti (vedi D6) |

### ⚠️ Da verificare tu (nessun browser disponibile in questa sessione)

Ho verificato **build di produzione** (`vite build`, riuscita), **typecheck strict** (pulito) e che il
server di **preview** risponda HTTP 200 servendo il bundle corretto. Non ho potuto verificare
visivamente né interattivamente l'app in un vero browser (drag&drop di un file reale, resa
della mappa Leaflet, eventuali errori console solo a runtime). Al prossimo avvio con `npm run dev`,
verifica in particolare:
- che la mappa Leaflet si veda correttamente (a volte richiede un tweak di CSS/altezza del container che in dev è diverso da build);
- che il drag&drop funzioni con un vero file `.gpx`;
- la console del browser per eventuali warning/errori non catturati dal typecheck.
| F0.6 | Test E2E (Playwright) sui flussi principali | ⬜ Da fare |

### Fase 1 — Ambiente e realismo sul tracciato

| ID | Iniziativa | Stato |
|---|---|---|
| F1.1 | Vento vettoriale (direzione/intensità, proiezione sul bearing del micro-segmento) | ⬜ Non iniziato |
| F1.2 | Densità aria variabile (ρ da quota GPX, opzionale T/pressione/umidità) | ⬜ Non iniziato |
| F1.3 | What-if rapido (Δ CdA/peso/watt medi → Δ tempo) | ⬜ Non iniziato |
| F1.4 | Report sensibilità (card automatica −1kg / −0.01 CdA / +5W / −1m/s vento) | ⬜ Non iniziato |

### Fase 2 — Vincoli di gara e ottimizzatore

| ID | Iniziativa | Stato |
|---|---|---|
| F2.1 | Goal time (tempo obiettivo → media/NP minima necessaria) | ⬜ Non iniziato |
| F2.2 | Limiti potenza (cap assoluto, %FTP, durata sopra soglia) | ⬜ Non iniziato |
| F2.3 | Limite di rampa (ΔP nel tempo sulla griglia fine) | ⬜ Non iniziato |
| F2.4 | NP/TSS stabili (raffinamento vincolo NP, TSS su durata gara) | ⬜ Non iniziato (base NP corretta già in `physics-core`, manca TSS e goal time) |
| F2.5 | Policy per tipo tratto (salita/piano/discesa, rilevamento automatico) | ⬜ Non iniziato |

### Fase 3 — Calibrazione e apprendimento da file

| ID | Iniziativa | Stato |
|---|---|---|
| F3.1 | CdA da attività (import FIT/GPX+power, stima multi-punto) — **risolve il problema §4.4** | ⬜ Non iniziato |
| F3.2 | CdA duale (aero/climbing con soglia pendenza/velocità) | ⬜ Non iniziato |
| F3.3 | Plan vs actual (richiede persistenza — dipende da F0.4/F0.3) | ⬜ Non iniziato |
| F3.4 | Wizard calibrazione (protocollo guidato) | ⬜ Non iniziato |

### Fase 4 — Esecuzione e interoperabilità

| ID | Iniziativa | Stato |
|---|---|---|
| F4.1 | Export CSV piano | ✅ Fatto |
| F4.2 | Export workout (ZWO) | ⬜ Non iniziato |
| F4.3 | Report gara PDF/PNG unico | ⬜ Non iniziato (prototipo aveva già una versione — da riportare e rivedere il rischio CORS export mappa, vedi §4) |
| F4.4 | Profili salvati (atleta/bici riusabili) — **richiede multi-utente/backend, dipende da D2/D3** | ⬜ Non iniziato, bloccato da decisioni future su backend |

### Fase 5 — Approfondimenti (ricerca/differenziazione)

| ID | Iniziativa | Stato |
|---|---|---|
| F5.1 | Inerzia (termine accelerazione griglia fine) | ⬜ Backlog |
| F5.2 | Frenata e v_max in discesa | ⬜ Backlog |
| F5.3 | Crr per superficie | ⬜ Backlog |
| F5.4 | CdA(yaw), vento laterale | ⬜ Backlog |
| F5.5 | Monte-carlo meteo | ⬜ Backlog |
| F5.6 | Proxy di fatica (CP/W′) | ⬜ Backlog |
| F5.7 | Heatmap "secondi per watt" | ⬜ Backlog |
| F5.8 | Frontiera Pareto tempo/NP | ⬜ Backlog |

### Login/multi-atleta/backend (fuori dalle 5 fasi, esplicitamente rimandato — D2/D3)

Da riprendere quando l'app v1 (Fase 0-2 circa) sarà stata usata e validata sul campo dall'utente.

---

## 8. Decisioni ancora aperte

- **Supabase vs self-hosted/infrastruttura propria** per il futuro backend — rimandato (D3), da riprendere quando si affronta F4.4/login
- **tRPC vs REST** per l'eventuale API — dipende dalla decisione precedente, non ancora rilevante senza backend
- **Login atleta**: dopo l'auth coach, o insieme? — da decidere quando si arriva a quel punto
- **Provider tile mappa** per il futuro export report (rischio CORS/policy OSM già segnalato in review) — da decidere in Fase 4 (F4.3)
- **Provider dati meteo/vento** per F1.1 — da valutare (serve comunque un proxy server-side per nascondere eventuale API key, quindi la prima vera necessità di un minimo di backend/serverless potrebbe arrivare già in Fase 1, non solo con login/multi-atleta — da tenere presente)

---

## 9. Prossimi passi immediati

**Prima di tutto**: testa in un browser vero che lo stile sia effettivamente tornato quello del prototipo originale, e che il nuovo flusso senza sidebar (upload → percorso attivo, con "📂 Nuovo GPX" per tornare indietro) funzioni bene. Il nome del percorso ora è modificabile in cima (si salva su blur del campo).

---

## 10. Changelog

- **2026-08-13** — Review tecnica/scientifica/performance completa del prototipo (`RouteSplitter_Review.md`).
- **2026-08-13** — Fix su prototipo HTML: segno drag aerodinamico (`rel*|rel|`), Normalized Power standard (media mobile 30s pesata sul tempo). File: `RouteSplitter_fix_NP_aero.html`.
- **2026-08-13** — Chiarito che D+/D− è già indipendente dallo smoothing grafico (non serviva fix). Chiarito che la sensibilità al rumore nella griglia fine dell'ottimizzatore non è un problema (step configurabile dall'utente).
- **2026-08-13** — Discussione roadmap tecnologica: decisione di riscrittura completa multi-dispositivo/multi-atleta (D1), poi ridimensionata a "solo io per ora, niente login/backend" (D2, D3) con conseguente revisione stack da Next.js+Supabase a Vite+React+TS SPA con IndexedDB (D4, D5).
- **2026-08-13** — Creato monorepo pnpm, package `physics-core` completo: fisica, geometria, smoothing, Normalized Power, ottimizzatore di pacing unificato (D8). 31 test Vitest, tutti verdi. Un bug reale trovato e corretto durante lo sviluppo dei test (clamping mancante in `projectToTimeWeightedAverage`). File: `routesplitter-physics-core.zip`.
- **2026-08-13** — Creato questo documento di stato (`stato_rs.md`).
- **2026-08-14** — Creato package `shared-schema`: tipi Zod versionati per Athlete, Bike, Route (+ RoutePointsPayload separato dai metadati), SectionPlan (+ Breakpoint, con vincolo start/finish), PowerPlan (+ FineGridSegment), Activity (stub Fase 3). Aggiunti bound di validazione sui parametri fisici (`PhysicsParamsSchema`) e sulle coordinate GPX (`RawTrackPointSchema`), chiudendo due gap segnalati nella review originale. 19 test Vitest, tutti verdi. Verificata assenza di regressioni su `physics-core` (31 test ancora verdi). File aggiornato: `routesplitter-monorepo.zip`.
- **2026-08-14** — Creato package `data-store`: interfaccia astratta `DataStore` (repository per Athlete/Bike/Route/SectionPlan/PowerPlan/Activity) + prima implementazione `createIndexedDbDataStore()` via Dexie. Validazione Zod applicata anche allo strato di persistenza, non solo in UI. Cancellazione a cascata Route→RoutePoints. `PowerPlan` senza `update()` per design (nuovo record per ogni ricalcolo, storico dei tentativi). 10 test (IndexedDB polyfillato con fake-indexeddb per girare in Vitest/Node), tutti verdi. Nessuna regressione sugli altri pacchetti (60 test totali nel monorepo). Creato anche `COME_INIZIARE.md` con le istruzioni di setup per chi lavora la prima volta su questo stack. File aggiornato: `routesplitter-monorepo.zip`.
- **2026-08-14** — Scaffolding `apps/web` (Vite+React+TypeScript) con prima fetta verticale funzionante: upload GPX → `processRoute` → salvataggio → mappa → statistiche. Build/typecheck verificati; UI non testata in browser reale.
- **2026-08-14** — Aggiunto grafico altimetria interattivo (D3: area/linea colorate per pendenza, hover con tooltip, drag-to-zoom, doppio clic reset) e mappa colorata per pendenza con segmenti raggruppati per colore (evita l'anti-pattern "una polyline per punto" segnalato in review). Hover sincronizzato tra grafico e mappa. 68/68 test verdi.
- **2026-08-14** — Chiuso il flusso principale: editor sezioni, tabella sezioni editabile, pannello parametri fisici, stimatore CdA da campo, ottimizzatore di pacing (per sezioni e a griglia fine), export CSV. Aggiunto `computeSections()` a `physics-core` (D17) e `applyPowerUpdates` per gli aggiornamenti massivi dell'ottimizzatore in un solo salvataggio (D19). 78/78 test verdi. Non ancora fatto: persistenza `PowerPlan`/grafico piano potenza, gestione profili atleta/bici, export PDF.
- **2026-08-14** — Convertito da pnpm a npm workspaces (D7), poi consolidato l'intero monorepo in un solo pacchetto npm `apps/web` (D16): `physics-core`/`shared-schema`/`data-store` da pacchetti separati (con build/dist propri, causa di un problema concreto di attrito in sviluppo) a cartelle sotto `src/` con alias TS/Vite. Nessuna regressione.
- **2026-08-14** — Primo passaggio di uniformazione visiva (D20): sistema di design con token colore/tipografia, un solo accento (ember), superfici mappa/grafico coerenti, legenda scala-pendenza come elemento firma. Nessuna modifica funzionale.
- **2026-08-14** — **Respinto dall'utente** il redesign del punto precedente: caricato il file originale come riferimento e richiesto il ripristino fedele di stile/layout, più la rimozione della sidebar fissa (mai presente nell'originale, giudicata senza senso per un upload). Ripristinati token colore/font esatti dell'originale (D21), rimossa la sidebar in favore di una vista singola upload↔percorso con percorsi salvati mostrati solo in fase di selezione (D22). Aggiunto anche nome percorso modificabile in cima e footer con link, entrambi presenti nell'originale ma persi nello scaffolding iniziale. 78/78 test ancora verdi, typecheck pulito, build OK. File: `routesplitter-web.zip`.
- **2026-08-14** — Primo test reale in browser da parte dell'utente: 5 bug/regressioni segnalati, tutti corretti. (1) Input numerici perdevano il punto decimale in digitazione (bug classico dei number input controllati in React) → creato `NumberField` condiviso (D23), sostituito ovunque. (2) Hover sul grafico altimetria appariva muovendo il mouse, spariva fermandosi → causa reale: callback inline nelle dipendenze dell'effetto D3 causavano un rebuild completo del grafico ad ogni evento hover → fix con ref (D24), risolve anche un problema di performance già segnalato in review. Ripristinate anche le card riassuntive per sezione sul grafico (D25) e la barra con statistiche di selezione live durante il brush, entrambe perse nella riscrittura. (3) Ripristinate le funzioni "aggiungi punto a un km preciso" e "sezioni ogni N km" (quest'ultima con un solo salvataggio, non N sequenziali — D26). (4) Ripristinato l'export/import JSON delle sezioni (formato originale), l'export CSV introdotto prima resta come aggiunta (D27). (5) Ripristinato il pulsante "ricentra sul percorso" nella barra di zoom della mappa. 87/87 test verdi (9 nuovi), typecheck pulito, build OK. File: `routesplitter-web.zip`.
- **2026-08-17** — Secondo giro di correzioni post-test in browser (6 richieste dell'utente, tutte chiuse). (1) **Grafico piano potenza previsto** (era completamente assente, non solo un bug): creato `PowerPlanModal.tsx`, porting fedele del modale del prototipo (area altimetria + step-line potenza istantanea + due medie mobili configurabili con preset e override custom in secondi, tooltip hover, export PNG con legenda/stat). `PacingOptimizerPanel` ora conserva il risultato della griglia fine (`finePlan`) dopo "Ottimizza completo" e mostra il pulsante "📈 Grafico potenza prevista" per aprirlo. (2) **Rimosso l'export CSV dalla UI** (pulsante e import in `RouteSplitterApp`); il modulo `lib/exportCsv.ts` resta nel codice (usato solo per `downloadTextFile`, condiviso con l'export JSON) ma non più esposto come funzionalità. (3) **Fix stile colonna "Tempo cum."**: nella tabella sezioni usava lo stesso stile ambra/grassetto di "Tempo" (per-sezione); nel prototipo originale i cumulativi avevano uno stile neutro (`.calc.cum`) distinto da quello del tempo di sezione — aggiunta la classe `.cum` in CSS e applicata alle celle cumulative (tempo, ma anche potenza/velocità media cum., vedi punto 5). (4) **Potenza/velocità default nuove sezioni**: prima era un campo fisso "Potenza default (W)" dentro il pannello parametri fisici, visibile solo in modalità potenza e con valore solo in stato React locale (mai persistito, mai usato per la velocità). Aggiunto `defaultPowerWatts` a `SectionPlanSchema` (persistito come `defaultSpeedKmh`), nuove funzioni `setDefaultSpeedKmh`/`setDefaultPowerWatts` in `useSectionPlan`, e il controllo è stato spostato nella barra di controllo dove si creano le sezioni (accanto ad "aggiungi punto"/"sezioni ogni N km"), con etichetta e campo che cambiano automaticamente tra "Velocità default nuove sezioni" e "Potenza default nuove sezioni" a seconda della modalità di calcolo attiva. (5) **Tabella sezioni**: aggiunte le colonne mancanti "Pot. media cum." e "Vel. media cum." (quest'ultima esisteva già nel modello dati `SectionResult.cumAvgSpeedKmh` ma non era mai stata renderizzata; la prima richiedeva un nuovo campo `cumAvgPowerWatts` aggiunto a `computeSections()` in `physics-core/sections.ts`, media pesata sul tempo come le altre medie cumulate). Allargato `.wrapper` da 1300px a 1760px (valore del prototipo originale) per dare più margine alla tabella e al resto della UI. (6) **Smoothing a rotellina**: lo slider di smoothing del grafico altimetria ora risponde anche allo scroll della rotella del mouse (±10m per tick), non solo al trascinamento, come nel prototipo originale. 87/87 test verdi (un test esistente aggiornato per il nuovo campo schema obbligatorio, nessun nuovo test aggiunto in questo giro), typecheck pulito, build OK. File: `routesplitter-web.zip`.
- **2026-08-17** — Terzo giro di correzioni post-test (3 richieste, tutte chiuse). (1) **Card "Tempo previsto" senza secondi**: `StatsRow.tsx` aveva una copia locale di `formatTime()` troncata (mostrava solo `Xh MMm`, mai i secondi) invece di riusare `lib/formatTime.ts` condiviso — rimossa la duplicazione, ora usa la funzione condivisa. In più, la stessa `lib/formatTime.ts` ometteva i secondi anche nel caso con ore (`Xh MMm` invece di `Xh MMm SSs` come nel prototipo originale) — corretto per includerli sempre. (2) **Rimosso il sottotitolo** "percorso → calibrazione → piano → esecuzione → verifica" sotto il titolo (mai presente nell'originale, giudicato superfluo). (3) Nessun'altra modifica richiesta, utente soddisfatto del resto. 87/87 test verdi, typecheck pulito, build OK. File: `routesplitter-web.zip`.
- **2026-08-17** — Ripristinato l'**export report PDF**, che mancava del tutto nella riscrittura React (non un bug: la funzionalità non era mai stata portata). Porting fedele del prototipo originale: (1) `lib/staticMapImage.ts` — mappa statica renderizzata su `<canvas>` (tile OSM disegnate a mano + tracciato colorato per pendenza + marker numerati), stessa tecnica dell'originale (non si tenta di "fotografare" la mappa Leaflet interattiva, fragile per via di animazioni/timing dei tile — si ridisegna tutto da zero a una risoluzione scelta da noi, 3x per una stampa nitida). (2) `components/ReportElevationChart.tsx` — versione statica, non interattiva, del grafico altimetria (area+linea colorate per pendenza, marker sezioni numerati), sempre sull'intero percorso anche se il grafico principale è zoomato (stesso comportamento dell'originale: il report resetta sempre alla vista completa). (3) `components/ReportView.tsx` — assembla header (nome percorso, data, ora di partenza opzionale con orari di arrivo calcolati per sezione), barra statistiche, mappa, grafico e tabella sezioni completa; usa un React portal per montarsi come figlio diretto di `<body>` (necessario perché il CSS di stampa nasconde tutto tranne `.report-view` con un selettore su figli diretti del body — nell'app React il contenuto normale vive dentro `#root`, quindi senza portal la regola di stampa non avrebbe funzionato). Il rendering avviene temporaneamente fuori schermo (stessa tecnica dell'originale: `position:fixed; left:-10000px`) per permettere a canvas/SVG di calcolare le dimensioni prima di chiamare `window.print()` — altrimenti un elemento con `display:none` non viene mai disegnato. (4) Aggiunto il pulsante "🖨️ Esporta report PDF" e il campo "Ora partenza (opz.)" nella barra in alto, come nell'originale. 87/87 test verdi, typecheck pulito, build OK. File: `routesplitter-web.zip`.
- **2026-08-17** — Fix bug critico export report PDF: **il PDF salvato risultava completamente bianco**. Causa: per permettere a canvas/SVG di calcolare le dimensioni prima di stampare, `ReportView` viene temporaneamente mostrato fuori schermo (classe `.exporting`: `position:fixed; left:-10000px`), la stessa tecnica del prototipo originale — ma quella regola CSS non è scoped a `@media screen`, quindi restava attiva anche durante la stampa vera e propria: il contenuto continuava a trovarsi a -10000px dal bordo pagina, fuori dall'area stampabile → PDF bianco. Nel prototipo originale questo veniva evitato rimuovendo esplicitamente la classe `exporting` subito prima di chiamare `window.print()`; questo passaggio non era stato portato nella riscrittura React. Fix: aggiunto un ref diretto al nodo DOM del report e rimozione imperativa della classe (`classList.remove('exporting')`, non via `setState`, per garantire che il cambiamento sia effettivo PRIMA della chiamata sincrona a `print()`, senza dipendere dal timing di un giro di render React) immediatamente prima di `window.print()`. Aggiunta anche una regola di sicurezza `@media print { body { background: #fff !important; } }` per evitare che lo sfondo scuro del tema dell'app filtri nella stampa su browser con "Grafica di sfondo" attiva. 87/87 test verdi, typecheck pulito, build OK. Nota: non è stato possibile verificare visivamente un vero salvataggio PDF in questo ambiente (nessun browser/rete disponibile per un test end-to-end) — la causa individuata è però inequivocabile a lettura di codice e il fix rispecchia esattamente la sequenza dell'originale funzionante; da riconfermare con un test reale in browser. File: `routesplitter-web.zip`.
- **2026-08-17** — Nuova funzionalità: **strumento vento interattivo con direzione**. Prima c'era un solo campo scalare "Vento km/h (+testa)" applicato uniformemente a tutto il percorso — impreciso su tracciati che curvano, perché un vento reale costante in direzione diventa in testa su un tratto e in coda su un altro a seconda di dove punta la strada. Discusso con l'utente (3 domande di chiarimento) prima di implementare: vento variabile a zone lungo il percorso (di default uniforme, personalizzabile), bussola interattiva trascinabile per la direzione, visualizzazione sia grafica che tabellare dell'effetto sezione per sezione. **Modello fisico** (`physics-core/wind.ts`, nuovo): dato un vettore vento (intensità + direzione da cui soffia, convenzione meteo) e la rotta locale del tracciato (calcolata dalle coordinate GPX, nuova `bearingDeg()` in `geo.ts`), si proietta il vento sulla direzione di marcia per ottenere la componente efficace in testa/coda — stesso segno del vecchio parametro scalare (positivo=testa), verificato con 11 test unitari sui casi limite (vento in faccia, in coda, laterale, nullo). **Modello dati**: `WindZoneBoundary` in `shared-schema/sectionPlan.ts`, strutturalmente identico ai breakpoint di sezione (start/finish fissi + confini interni ordinabili) per coerenza col resto dell'app — ogni confine porta il vento della zona che finisce lì. Nuovo campo `windZones` sul `SectionPlan` (default `[]` = vento non configurato = 0, pienamente retrocompatibile). `computeSections()` accetta ora un parametro opzionale `windZones`: per ogni sezione trova la zona attiva e la rotta media del tratto, e sovrascrive `params.windKmh` con la componente efficace calcolata — esposta come nuovo campo `windHeadwindKmh` su `SectionResult`. **Interfaccia**: `WindCompass.tsx` — quadrante SVG trascinabile (si trascina la freccia nella direzione in cui soffia il vento, più intuitivo del "da dove viene"; internamente si converte alla convenzione meteo per il calcolo fisico). `WindZonesPanel.tsx` — card per ogni zona (bussola + intensità + range km), pulsante "Dividi qui" per aggiungere un confine (eredita il vento della zona che divide, non riparte da zero), pulsante "Vento uniforme" per tornare a una singola zona. `WindRibbon.tsx` — la parte "grafica": una fascia colorata sopra il grafico altimetria (rosso=vento in testa, verde=in coda, grigio=laterale), campionata ogni ~180 punti lungo il percorso. La parte "dati": nuova colonna "Vento" sia nella tabella sezioni sia nel report PDF stampabile, con badge colorato (↑ rosso in testa, ↓ verde in coda). **Vento per la stima CdA**: rimosso il campo "Vento km/h" dal pannello parametri fisici principale (ora gestito dalle zone vento) e spostato come campo locale dedicato dentro lo stimatore CdA (`CdaEstimator.tsx`), che resta un calcolo puntuale non legato al percorso e quindi ha senso resti un valore manuale a parte. **Export/import**: le zone vento vengono salvate ed importate nel file JSON delle sezioni (campo aggiuntivo `windZones`, opzionale — un file esportato prima di questa modifica importa comunque correttamente, semplicemente senza toccare il vento già impostato). **Limite noto, segnalato esplicitamente**: l'ottimizzatore di pacing ("Ottimizza sezioni/completo") non tiene ancora conto del vento — usa ancora un `physicsParams.windKmh` fisso a 0 per i calcoli di ottimizzazione, quindi la distribuzione ottimale di watt calcolata non si adatta ancora a tratti in testa/coda. Prossimo passo naturale se richiesto. 102/102 test verdi (11 nuovi per la fisica del vento, 2 per i nomi cardinali, 2 per il round-trip export/import), typecheck pulito, build OK. File: `routesplitter-web.zip`.
- **2026-08-18** — Su richiesta dell'utente, la bussola vento si è spostata **dentro la mappa** invece di stare in un pannello a parte: una bussola isolata in un form è "context-free" (un cerchio N-in-alto senza alcun riferimento), mentre sulla mappa il coach vede subito come la direzione impostata si relaziona alla direzione reale della strada in quel punto, che è tutto il senso dello strumento. Implementazione: `WindMapControl` in `RouteMap.tsx`, un controllo Leaflet custom (`L.Control` posizionato in basso a destra) che monta la stessa `WindCompass.tsx` via React portal dentro il proprio contenitore DOM — con `L.DomEvent.disableClickPropagation` / `disableScrollPropagation` per evitare che trascinare la bussola faccia anche pan/zoom della mappa sotto. `WindZonesPanel.tsx` non ospita più una bussola per ogni zona (ridondante e motivo della richiesta): ora è un elenco compatto di "chip" cliccabili (range km + vento in sintesi), la selezione di una chip determina quale zona la bussola sulla mappa sta modificando in quel momento (evidenziata otticamente); se non c'è selezione esplicita, la bussola edita di default l'ultima zona (quella che copre l'arrivo). 102/102 test verdi, typecheck pulito, build OK. File: `routesplitter-web.zip`.
