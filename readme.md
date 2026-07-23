# Flowpilot

Estensione di **Visual Studio Code** che registra le azioni di un utente in **Microsoft Edge** o **Google Chrome** e poi chiede a **GitHub Copilot Agent** di rieseguirle nel browser usando i tool **Playwright MCP**, producendo un report tecnico (Markdown) e un report executive (Word) in cui l'agente segnala anche i cambiamenti del sito (bottoni rinominati, popup nuovi, redirect inattesi, ecc.).

È pensata per i team di QA / Operations che devono verificare se un flusso web (login, navigazione, compilazione di form, esecuzione di una procedura su un portale interno, ecc.) continua a funzionare nel tempo, senza scrivere codice di test.

---

## A cosa serve

1. **Registrare** una volta ciò che fa un utente reale (click, digitazione, navigazione, scorrimento, ecc.).
2. **Riprodurre** la stessa sequenza in qualsiasi momento, tutte le volte che serve, in modo automatico.
3. **Confrontare** l'esito del replay con la registrazione originale e ottenere un **report Word** che spiega in linguaggio naturale se il flusso funziona ancora e cosa è cambiato.

Il documento finale è pensato per essere letto in **30 secondi** da un manager non tecnico, mentre il dettaglio tecnico (selettori, errori, screenshot, coordinate dei click) resta disponibile per gli sviluppatori in un file Markdown allegato.

---

## Requisiti

- **Visual Studio Code** ≥ 1.102 (richiesto dall'API di registrazione automatica del server MCP).
- **Microsoft Edge** *oppure* **Google Chrome** installato (canale `stable`, `beta` o `dev`). L'estensione usa il browser di sistema: **non scarica browser**. Per impostazione predefinita (`edgeRecorder.browser` = `auto`) rileva automaticamente quale browser è disponibile; puoi forzare la scelta impostando `msedge` o `chrome`.
- **GitHub Copilot Chat** attivo in VS Code, con accesso ai tool MCP (necessario per l'AI replay e la generazione automatica del report Word).
- **Windows 10/11** consigliato e testato. macOS/Linux: la registrazione/replay funzionano, ma il kill forzato del processo e alcuni dettagli sono ottimizzati per Windows.

> **Node.js non è richiesto.** Gli script interni e il server Playwright MCP girano con il runtime Node incluso in VS Code (`ELECTRON_RUN_AS_NODE`). Il server MCP (`@playwright/mcp`) è incluso nel pacchetto: nessun `npx`, nessuna installazione esterna.

---

## Installazione

### Dal Marketplace
Cerca **"Flowpilot"** nella vista *Extensions* di VS Code e premi **Install**. Al primo avvio l'estensione registra automaticamente il **Playwright MCP server** così che Copilot Agent abbia subito a disposizione i tool `mcp_playwright_browser_*`.

### Da file `.vsix`
Scarica il `.vsix` dalle release e installalo con:

```powershell
code --install-extension edge-action-recorder-<versione>.vsix
```

---

## Build dai sorgenti (per sviluppatori)

```powershell
npm install            # installa le dipendenze runtime (incluso @playwright/mcp)
npm run icon           # (ri)genera media/icon.png
npm run package        # produce il .vsix con @vscode/vsce
```

Per pubblicare sul Marketplace serve un **publisher** registrato su Azure DevOps:

1. Crea il publisher su https://marketplace.visualstudio.com/manage e impostane l'ID nel campo `publisher` di `package.json`.
2. Pubblica con `npm run publish` (ti verrà chiesto un Personal Access Token), oppure carica manualmente il file `.vsix` dalla pagina del publisher con **New extension**.

---

## Come si usa

### 1. Aprire il pannello

Dalla command palette di VS Code (`Ctrl+Shift+P`): **`Flowpilot: apri pannello`**. In alternativa, cliccare l'icona **Flowpilot** nella activity bar a sinistra.

### 2. Registrare una sessione

1. Inserire l'URL di partenza nel campo in alto (es. `https://en.wikipedia.org/wiki/Microsoft`).
2. Premere **● Registra**: si apre il browser (Microsoft Edge o Google Chrome) controllato da Playwright.
3. Premere **● Start** nell'overlay del browser per iniziare a catturare le azioni.
4. Eseguire normalmente il flusso che si vuole testare.
5. Premere **■ Stop** nel pannello di VS Code (o chiudere il browser): il browser si chiude pulito e tutti gli artefatti vengono salvati.

Vengono catturati: click, doppio click, tasto destro, digitazione, hover, scroll, drag & drop, navigazione tra tab, dialog, download, richieste di rete, errori della console, screenshot per ogni azione rilevante, video completo della sessione e Playwright trace.

### 3. Rieseguire (Replay AI)

1. Selezionare la sessione registrata dalla lista.
2. Premere **🤖 Replay (AI)**.

L'estensione genera un file `ai-replay-instructions.md` con la lista completa delle azioni e apre **Copilot Chat** con il prompt già caricato. Copilot Agent:

- apre il browser usando i tool **Playwright MCP** (`mcp_playwright_browser_navigate`, `_click`, `_type`, `_snapshot`, ecc.),
- ripete **tutte** le azioni registrate, una per una, in ordine, senza saltarne nessuna,
- prima di ogni click usa lo snapshot accessibility per trovare l'elemento corretto anche se la UI è cambiata,
- registra i fallimenti ma prosegue fino in fondo,
- al termine scrive `ai-replay-report.md` con il dettaglio tecnico e un report Word executive `.docx` per il manager.

### 4. Report automatico

**Al termine dell'AI replay**, Copilot produce automaticamente:

1. Un file `ai-replay-report.md` nella cartella `ai-replay-<timestamp>/` della sessione, con esito step-by-step e una sezione *"Cambiamenti rilevati sul sito"*.
2. Un documento Word **executive da 1 pagina** con: intestazione (flusso, data, durata, esito `FUNZIONANTE` / `DEGRADATO` / `ROTTO`), risultato in una frase, tabella dei cambiamenti del sito, tabella delle differenze nelle azioni, e riferimento al file Markdown tecnico.

### 5. Automazioni "da prompt" (senza registrazione)

Non sempre serve registrare un flusso: a volte basta descrivere l'obiettivo. Nella sezione **Automazioni** del pannello:

1. Inserire l'**URL** di partenza.
2. Scrivere in linguaggio naturale **cosa deve fare l'AI** sul sito (es. *"accedi, vai in Fatture, apri l'ultima e dimmi l'importo"*).
3. Premere **✨ Avvia automazione**.

L'estensione genera `ai-navigation-instructions.md` e apre Copilot Chat: l'agente apre il sito con i tool Playwright MCP, raggiunge l'obiettivo interpretando la pagina (testo / ruolo / aria-label), e al termine scrive un `ai-navigation-report.md` e un report Word executive. Le navigazioni AI vengono salvate in `ai-navigations/nav-<timestamp>/` nel `globalStorage`.

### 6. Skills (link / task riutilizzabili)

Per non riscrivere ogni volta URL e prompt ricorrenti, la sezione **Skills** permette di:

- **💾 Salvare** l'URL (e l'eventuale prompt) corrente con un nome.
- **▶ Avviare** un task salvato direttamente con l'AI.
- **⤴ Usare** una voce per precompilare i campi (URL di registrazione + navigazione AI).
- **✎ Modificare** / **🗑 eliminare** una voce.
- **Selezionare più voci** e premere **▶ Esegui selezionati**: l'AI esegue in sequenza tutti i task scelti in un'unica conversazione, con un report complessivo.

La libreria delle Skills è persistente (`library.json` nel `globalStorage`) e sopravvive agli aggiornamenti dell'estensione.

---

## Struttura dei file generati

Le registrazioni vengono salvate nel `globalStorage` dell'estensione (o nella cartella configurata, vedi sotto). Ogni sessione produce:

```
session-<timestamp>/
├── original flow/                  ← artefatti del flusso originale
│   ├── events.json                 ← elenco completo di tutti gli eventi catturati
│   ├── session.spec.js             ← test Playwright riproducibile
│   ├── trace.zip                   ← trace ispezionabile con `npx playwright show-trace`
│   ├── network.har                 ← traffico HTTP completo
│   ├── video/                      ← video della sessione
│   └── screenshots/                ← screenshot per ogni azione rilevante
└── ai-replay-<timestamp>/          ← una cartella per ogni AI replay eseguito
    ├── ai-replay-instructions.md   ← prompt inviato a Copilot
    └── ai-replay-report.md         ← report tecnico scritto da Copilot
```

Le navigazioni AI "da prompt" (non legate a una registrazione) e le Skills vengono salvate a parte nel `globalStorage`:

```
ai-navigations/
└── nav-<timestamp>/
    ├── ai-navigation-instructions.md   ← prompt inviato a Copilot
    └── ai-navigation-report.md         ← report scritto da Copilot
library.json                            ← link / task salvati come Skill
```

---

## Configurazione

Aprire le impostazioni di VS Code (`File → Preferences → Settings`) e cercare **Flowpilot**:

| Impostazione | Descrizione |
|---|---|
| `edgeRecorder.recordingsPath` | Cartella dove salvare le registrazioni. Se vuota: `globalStorage` dell'estensione. |
| `edgeRecorder.wordOutputPath` | Cartella dove salvare i report Word `.docx`. Se vuota: `globalStorage/reports/`. |
| `edgeRecorder.edgeProfileDir` | Profilo Edge usato dal recorder (per mantenere i login tra sessioni). **Non puntare al profilo personale di Edge** per evitare lock e corruzione: lasciare vuoto o usare una cartella dedicata. |

---

## Privacy e sicurezza

Le registrazioni catturano **tutto** ciò che accade nella pagina, inclusi i **valori digitati nei campi** e il traffico di rete (HAR), il video e gli screenshot. Se registri un flusso di login, **credenziali e dati sensibili possono finire in chiaro** negli artefatti della sessione (`events.json`, `network.har`, `video/`, `screenshots/`) e nel prompt inviato a Copilot.

- Tieni le cartelle delle registrazioni in un percorso protetto.
- Evita di registrare segreti reali quando possibile (usa account di test).
- Elimina le sessioni che non ti servono più (`🗑` nel pannello o cancellando la cartella).

---

## Disinstallazione

Da VS Code: `Extensions` → cercare **Flowpilot** → `Uninstall`. Per cancellare anche le registrazioni: eliminare la cartella indicata in `edgeRecorder.recordingsPath` (o lo storage globale dell'estensione).

---

## Risoluzione problemi

- **Edge si chiude subito senza errori**: capita se è già aperta un'altra istanza di Edge personale. L'estensione tenta i canali `msedge-beta` e `msedge-dev`; se nessuno è avviabile mostra un errore chiaro. Per evitarlo, chiudere tutte le istanze di Edge prima di avviare la registrazione.
- **Copilot Chat non si apre automaticamente**: il prompt viene comunque copiato negli appunti. Premere `Ctrl+Alt+I` per aprire Copilot Chat e `Ctrl+V` per incollare.
- **Il server Playwright MCP non compare**: assicurati di usare VS Code ≥ 1.102 e che GitHub Copilot Chat sia attivo. Il server è registrato automaticamente come *"Playwright (Flowpilot)"*.

---

## Licenza

MIT — vedi il file `LICENSE` incluso nel pacchetto.
