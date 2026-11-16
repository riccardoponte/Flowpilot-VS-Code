🌐 **Lingua / Language:** [🇮🇹 Italiano](#italiano) · [🇬🇧 English](#english)

---

<a id="italiano"></a>

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

---

<a id="english"></a>

# Flowpilot

A **Visual Studio Code** extension that records user actions in **Microsoft Edge** or **Google Chrome** and prompts **GitHub Copilot Agent** to replay them in the browser using **Playwright MCP** tools, producing a technical report (Markdown) and an executive report (Word) where the agent also flags site changes (renamed buttons, new popups, unexpected redirects, etc.).

Designed for QA / Operations teams that need to verify whether a web flow (login, navigation, form submission, internal portal procedures, etc.) continues to work over time, without writing any test code.

---

## What It Does

1. **Record** once what a real user does (clicks, typing, navigation, scrolling, etc.).
2. **Replay** the exact same sequence at any time, as often as needed, completely automatically.
3. **Compare** the replay outcome with the original recording and generate a **Word report** explaining in plain language whether the flow still works and what has changed.

The final document is designed to be read in **30 seconds** by a non-technical manager, while full technical details (selectors, errors, screenshots, click coordinates) remain available for developers in an attached Markdown file.

---

## Requirements

- **Visual Studio Code** ≥ 1.102 (required by the MCP server auto-registration API).
- **Microsoft Edge** *or* **Google Chrome** installed (`stable`, `beta`, or `dev` channel). The extension uses the system browser: **it does not download browsers**. By default (`edgeRecorder.browser` = `auto`), it automatically detects which browser is available; you can force a choice by setting `msedge` or `chrome`.
- **GitHub Copilot Chat** active in VS Code, with access to MCP tools (required for AI replay and automated Word report generation).
- **Windows 10/11** recommended and tested. macOS/Linux: recording and replay work, but forced process termination and certain details are optimized for Windows.

> **Node.js is not required.** Internal scripts and the Playwright MCP server run using the Node runtime bundled with VS Code (`ELECTRON_RUN_AS_NODE`). The MCP server (`@playwright/mcp`) is included in the package: no `npx`, no external installations.

---

## Installation

### From Marketplace
Search for **"Flowpilot"** in the VS Code *Extensions* view and click **Install**. On first launch, the extension automatically registers the **Playwright MCP server** so Copilot Agent immediately has access to `mcp_playwright_browser_*` tools.

### From a `.vsix` File
Download the `.vsix` file from releases and install it using:

```powershell
code --install-extension edge-action-recorder-<versione>.vsix
```

---

## Building from Source (for Developers)

```powershell
npm install            # install runtime dependencies (including @playwright/mcp)
npm run icon           # (re)generate media/icon.png
npm run package        # build .vsix with @vscode/vsce
```

Publishing to the Marketplace requires a registered **publisher** on Azure DevOps:

1. Create a publisher on https://marketplace.visualstudio.com/manage and set its ID in the `publisher` field of `package.json`.
2. Publish with `npm run publish` (you will be prompted for a Personal Access Token), or manually upload the `.vsix` file from the publisher page using **New extension**.

---

## How to Use

### 1. Open the Panel

From the VS Code command palette (`Ctrl+Shift+P`): **`Flowpilot: apri pannello`**. Alternatively, click the **Flowpilot** icon in the activity bar on the left.

### 2. Record a Session

1. Enter the starting URL in the top field (e.g., `https://en.wikipedia.org/wiki/Microsoft`).
2. Click **● Registra** (Record): the browser (Microsoft Edge or Google Chrome) opens, controlled by Playwright.
3. Click **● Start** in the browser overlay to start capturing actions.
4. Perform the workflow you want to test as normal.
5. Click **■ Stop** in the VS Code panel (or close the browser): the browser closes cleanly and all artifacts are saved.

Captured events: click, double click, right click, typing, hover, scroll, drag & drop, tab navigation, dialogs, downloads, network requests, console errors, screenshots for every relevant action, full session video, and Playwright trace.

### 3. Replay (AI Replay)

1. Select the recorded session from the list.
2. Click **🤖 Replay (AI)**.

The extension generates an `ai-replay-instructions.md` file with the complete list of actions and opens **Copilot Chat** with the prompt pre-loaded. Copilot Agent:

- opens the browser using **Playwright MCP** tools (`mcp_playwright_browser_navigate`, `_click`, `_type`, `_snapshot`, etc.),
- repeats **all** recorded actions, one by one, in order, without skipping any,
- before each click, uses the accessibility snapshot to locate the correct element even if the UI has changed,
- logs failures but continues through to the end,
- upon completion, writes `ai-replay-report.md` with technical details and an executive Word `.docx` report for the manager.

### 4. Automated Report

**Upon completing the AI replay**, Copilot automatically produces:

1. An `ai-replay-report.md` file in the session's `ai-replay-<timestamp>/` folder, with step-by-step results and a *"Changes detected on site"* section.
2. A **1-page executive Word document** with: header (flow, date, duration, outcome `FUNZIONANTE` / `DEGRADATO` / `ROTTO`), result in one sentence, table of site changes, table of action differences, and reference to the technical Markdown file.

### 5. "Prompt-based" Automations (Without Recording)

You don't always need to record a flow: sometimes describing the objective is enough. In the **Automazioni** (Automations) section of the panel:

1. Enter the starting **URL**.
2. Write in natural language **what the AI should do** on the site (e.g., *"log in, go to Invoices, open the latest one and tell me the total"*).
3. Click **✨ Avvia automazione** (Start automation).

The extension generates `ai-navigation-instructions.md` and opens Copilot Chat: the agent navigates the site with Playwright MCP tools, reaches the goal by interpreting the page (text / role / aria-label), and upon completion writes an `ai-navigation-report.md` and an executive Word report. AI navigations are saved under `ai-navigations/nav-<timestamp>/` in `globalStorage`.

### 6. Skills (Reusable Links / Tasks)

To avoid retyping recurring URLs and prompts, the **Skills** section allows you to:

- **💾 Save** the current URL (and optional prompt) under a name.
- **▶ Run** a saved task directly with AI.
- **⤴ Use** an entry to prefill fields (recording URL + AI navigation).
- **✎ Edit** / **🗑 delete** an entry.
- **Select multiple entries** and click **▶ Esegui selezionati** (Run selected): AI executes all chosen tasks in sequence within a single conversation, with an aggregated report.

The Skills library is persistent (`library.json` in `globalStorage`) and survives extension updates.

---

## Generated File Structure

Recordings are saved in the extension's `globalStorage` (or configured directory, see below). Each session produces:

```
session-<timestamp>/
├── original flow/                  ← original flow artifacts
│   ├── events.json                 ← full list of all captured events
│   ├── session.spec.js             ← reproducible Playwright test
│   ├── trace.zip                   ← inspectable trace with `npx playwright show-trace`
│   ├── network.har                 ← complete HTTP traffic
│   ├── video/                      ← session video
│   └── screenshots/                ← screenshots for every relevant action
└── ai-replay-<timestamp>/          ← one folder per executed AI replay
    ├── ai-replay-instructions.md   ← prompt sent to Copilot
    └── ai-replay-report.md         ← technical report written by Copilot
```

Prompt-based AI navigations (not tied to a recording) and Skills are saved separately in `globalStorage`:

```
ai-navigations/
└── nav-<timestamp>/
    ├── ai-navigation-instructions.md   ← prompt sent to Copilot
    └── ai-navigation-report.md         ← report written by Copilot
library.json                            ← links / tasks saved as Skills
```

---

## Configuration

Open VS Code settings (`File → Preferences → Settings`) and search for **Flowpilot**:

| Setting | Description |
|---|---|
| `edgeRecorder.recordingsPath` | Directory where recordings are saved. If empty: extension `globalStorage`. |
| `edgeRecorder.wordOutputPath` | Directory where Word `.docx` reports are saved. If empty: `globalStorage/reports/`. |
| `edgeRecorder.edgeProfileDir` | Edge profile used by the recorder (to preserve logins across sessions). **Do not point to your personal Edge profile** to avoid locks and corruption: leave empty or use a dedicated directory. |

---

## Privacy and Security

Recordings capture **everything** happening on the page, including **values typed into input fields**, network traffic (HAR), video, and screenshots. If you record a login flow, **credentials and sensitive data can end up in plain text** within session artifacts (`events.json`, `network.har`, `video/`, `screenshots/`) and in the prompt sent to Copilot.

- Keep recording folders in a protected location.
- Avoid recording real secrets whenever possible (use test accounts).
- Delete sessions you no longer need (`🗑` in the panel or by deleting the folder).

---

## Uninstallation

From VS Code: `Extensions` → search for **Flowpilot** → `Uninstall`. To also delete recordings: delete the directory specified in `edgeRecorder.recordingsPath` (or the extension's global storage).

---

## Troubleshooting

- **Edge closes immediately without errors**: occurs if another personal Edge instance is already open. The extension tries `msedge-beta` and `msedge-dev` channels; if none can be started, it displays a clear error. To prevent this, close all Edge instances before starting a recording.
- **Copilot Chat does not open automatically**: the prompt is still copied to the clipboard. Press `Ctrl+Alt+I` to open Copilot Chat and `Ctrl+V` to paste.
- **Playwright MCP server does not appear**: ensure you are using VS Code ≥ 1.102 and that GitHub Copilot Chat is active. The server is automatically registered as *"Playwright (Flowpilot)"*.

---

## License

MIT — see the `LICENSE` file included in the package.
