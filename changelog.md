# Changelog

Tutte le modifiche rilevanti a questa estensione sono documentate qui.

## [2.19.0] - 2026-07-22

### Aggiunto
- **L'AI Replay usa i frame originali a schermo intero**: il prompt passato a Copilot ora indica, per ogni azione, il **fotogramma originale a schermo intero** corrispondente (ricavato dai frame estratti da ffmpeg, cadenza 1/sec, mappato per timestamp dell'azione). Copilot usa quei frame in due modi: come **riferimento visivo per riprodurre il flusso** con Playwright (vede anche ciò che accade fuori dal browser: dialoghi di sistema, selettori file, popup) e come base per **scrivere le differenze visive** nel report.

### Modificato
- La sezione "Differenze visive" del report ora combina i **numeri** del diff pixel per-azione con il **contesto** dei frame originali a schermo intero. La tabella di mappatura del diff visivo include una colonna con il frame originale corrispondente a ciascuna azione.

## [2.18.0] - 2026-07-22

### Aggiunto
- **ffmpeg incluso nell'estensione**: la cattura a schermo intero non dipende più da un ffmpeg installato sul sistema. Un build completo (con `gdigrab` + `libx264`) è ora incluso in `bin/ffmpeg.exe` e viene usato automaticamente. La registrazione unica di tutto lo schermo con i relativi fotogrammi a 1/sec funziona quindi su qualsiasi PC Windows senza configurazione.

### Modificato
- Ordine di ricerca di ffmpeg: prima il percorso esplicito in `edgeRecorder.ffmpegPath`, poi il **binario incluso** nell'estensione, infine il `PATH` di sistema. Il fallback a screenshot resta solo come ultima rete di sicurezza.

### Note
- Il pacchetto è più grande (~230 MB) perché include il binario ffmpeg completo per Windows.

## [2.17.0] - 2026-07-22

### Aggiunto
- **Registrazione unica a schermo intero durante il record**: quando premi Start, oltre al video del solo browser parte ora **un'unica cattura continua di tutto lo schermo** (tutti i monitor), come uno strumento di cattura, che va avanti fino allo Stop. Da questa registrazione vengono ricavati **fotogrammi a 1 al secondo**. Così viene ripreso l'intero desktop (dialoghi di sistema, selettori file, altre finestre, notifiche), non solo la finestra del browser. Gli artefatti sono in `original flow/video/screen.mp4` e `original flow/frames/`. Il diff visivo e il report possono ora fare riferimento anche a questa timeline completa.
- **Impostazioni dedicate**: `edgeRecorder.screenCapture` (attiva/disattiva la cattura a schermo intero), `edgeRecorder.screenCaptureFps` (fps del video, i frame restano a 1 fps) e `edgeRecorder.ffmpegPath` (percorso a ffmpeg).

### Note
- La cattura del **video** usa **ffmpeg** (build con `gdigrab`, es. gyan.dev/BtbN): se `ffmpeg` non è nel `PATH` puoi indicarlo in `edgeRecorder.ffmpegPath`. Senza ffmpeg la registrazione ricade su uno **screenshot al secondo** (solo frame, niente video), così la funzione resta utilizzabile ovunque su Windows.

## [2.16.0] - 2026-06-15

### Aggiunto
- **Diff visivo nel report dell'AI replay**: oltre a rieseguire i passaggi registrati, l'estensione ora confronta **come appariva ogni schermata** nel flusso originale con come appare durante il replay. Per ogni azione chiave viene catturato uno screenshot del replay e confrontato pixel per pixel con quello originale: le differenze vengono evidenziate in rosso e affiancate (**originale | replay | diff**). Il report Word guadagna una nuova sezione **"Differenze visive"** che elenca, momento per momento, cosa è cambiato rispetto a ciò che si vede nel video originale (colori, valori/numeri, testo, immagini/grafici/icone diversi o mancanti, elementi spostati), con la percentuale di pixel cambiati.
- **Motore di confronto immagini incluso** (`lib/visual-diff.js`): decodifica e confronto PNG senza dipendenze esterne (usa solo `zlib` di Node). Genera per ogni checkpoint le immagini `diff-*.png` e `sidebyside-*.png` più i file riepilogativi `visual-diff.md`, `visual-diff.html` e `visual-diff-report.json` (percentuali, bounding box, zone con più differenze). Le risoluzioni diverse vengono riscalate automaticamente prima del confronto.

## [2.15.0] - 2026-06-15

### Corretto
- **Report Word nella cartella sbagliata**: il documento `.docx` generato dall'AI replay veniva salvato in una cartella nascosta dell'estensione, separata dal report `.md`. Ora, quando non è impostata una cartella di output Word specifica, il `.docx` viene salvato nella **stessa cartella del `.md` della sessione**, così i due file restano insieme. Stesso comportamento per i report delle Automazioni e di Video → Automazione.

### Aggiunto
- **Apertura dei report dalla sezione “Sessioni”**: ogni sessione elenca ora i report generati (Markdown e Word) con un pulsante per aprirli direttamente. I file `.md` si aprono nell'editor di VS Code, i `.docx` con l'applicazione predefinita di sistema (Word). Se è configurata una cartella di output Word esterna, i `.docx` relativi alla sessione vengono comunque elencati.

## [2.14.1] - 2026-06-12

### Corretto
- **Nome sullo Store**: il titolo dell'estensione sul Marketplace ora mostra correttamente **Flowpilot** (il manifest del pacchetto riportava ancora il vecchio nome “Edge Action Recorder”). Aggiornata anche la descrizione breve.

## [2.14.0] - 2026-06-12

### Aggiunto
- **Sezione “Guida / Come funziona”**: nuova voce nel menu laterale con una spiegazione in parole semplici di cosa fa l'estensione, delle varie sezioni, di **come lavora l'AI e cosa sono gli MCP**, da dove arriva il **Playwright MCP** (già incluso nell'estensione, avviato con il Node integrato di VS Code) e delle garanzie di privacy. Disponibile in italiano e inglese.
- **Fotogrammi raggruppati in immagini composte (contact sheet)** nella funzione Video → Automazione: ora puoi estrarre fino a **48** fotogrammi e vengono inviati **tutti** all'AI. Se superano 20, vengono automaticamente disposti in poche immagini a griglia (ogni cella etichettata con numero e istante), così si resta entro il limite di immagini del modello senza scartarne nessuno.

### Modificato
- Lo slider dei fotogrammi torna a salire fino a 48 (prima era limitato a 20). Il prompt inviato a Copilot spiega come leggere le immagini a griglia in ordine.

## [2.13.0] - 2026-06-12

### Corretto
- **Video → Automazione (beta)**: ora il **video caricato viene mostrato** con un lettore (play/pausa/scorrimento) sotto l'area di caricamento.
- I **fotogrammi estratti sono cliccabili e navigabili**: aprono un visualizzatore ingrandito con frecce avanti/indietro (anche con i tasti ← →) e chiusura con Esc; selezionando un fotogramma il lettore si posiziona sull'istante corrispondente.
- Risolto l'errore *"Too many images in request"*: il numero di fotogrammi inviati all'AI è ora **limitato a 20** (massimo supportato dal modello). Lo slider arriva al massimo a 20 e, per sicurezza, eventuali set più grandi vengono campionati in modo uniforme sia nel pannello sia lato estensione.

## [2.12.0] - 2026-06-12

### Aggiunto
- **Video → Automazione (beta)**: nuova sezione nel menu laterale (contrassegnata **beta** e con un colore distinto teal→blu). Permette di **caricare un video** (screen recording), estrarne i fotogrammi e far sì che l'AI li **analizzi, ricostruisca i passaggi e li riproduca** sul sito con i tool Playwright MCP, generando come sempre report Markdown e Word.
  - L'estrazione dei fotogrammi avviene **interamente in locale** nel pannello (elemento `<video>` + canvas): il video non lascia il computer, vengono salvate e inviate a Copilot solo le immagini dei fotogrammi.
  - Controlli: caricamento via drag&drop o selezione file, URL di partenza, contesto/obiettivo opzionale e numero di fotogrammi da estrarre (8–48), con anteprima a griglia.
  - Funzione sperimentale: la ricostruzione da fotogrammi è inferenziale, va sempre rivista.

## [2.11.0] - 2026-06-12

### Aggiunto
- **Tour guidato sezione per sezione**: l'introduzione di benvenuto è ora un vero tour interattivo che **apre automaticamente ogni menu** (Home, Registra, Automazioni, Skills, Sessioni, Impostazioni), evidenzia la voce corrispondente nella barra laterale e spiega a cosa serve con un fumetto passo-passo (Avanti / Indietro / Salta).
- **Cambio lingua dentro l'onboarding**: un pulsante a globo nella schermata di benvenuto e nel fumetto del tour permette di passare **Italiano ⇄ English** senza uscire dall'introduzione.
- **Skill predefinita di sola lettura**: in cima alla sezione **Skills** compare ora il **prompt originale** inviato automaticamente a GitHub Copilot dopo ogni registrazione (le istruzioni complete per l'AI Replay). È contrassegnata come "predefinita", non è modificabile né eliminabile, e può essere espansa e copiata negli appunti.

### Corretto
- **Lente di ricerca sovrapposta al testo**: in alcune caselle di ricerca (Skills, Sessioni) l'icona della lente si accavallava con il segnaposto "Cerca/Search". Il padding del campo è stato corretto così l'icona resta sempre distinta dal testo.
- **Pulsanti delle Skill non reattivi**: dopo l'aggiunta della skill predefinita, i pulsanti Avvia / ✎ / 🗑 delle Skill salvate potevano non rispondere. Il problema è stato risolto.

## [2.10.0] - 2026-06-12

### Aggiunto
- **Schermata di introduzione (onboarding)**: una panoramica di benvenuto all'avvio che presenta Registra, Automazioni e Skills. Nuova impostazione `edgeRecorder.showOnboarding` con interruttore in **Impostazioni** e pulsante per rivederla quando si vuole.
- **Modifica dell'obiettivo della Skill da Automazioni**: quando si carica una Skill salvata è ora possibile aggiornarne il prompt direttamente dalla sezione **Automazioni**.

### Modificato
- **Pulizia dell'interfaccia**: rimosso il pulsante ridondante "Usa" dalle card delle Skill, lasciando le azioni essenziali (Avvia, modifica, elimina).

## [2.9.0] - 2026-06-12

### Aggiunto
- **Interfaccia bilingue Italiano / English**: un pulsante in alto a destra (icona globo) permette di **cambiare lingua al volo**; la stessa scelta è disponibile come **Lingua predefinita** nella sezione **Impostazioni**. Tutta l'app — menu, titoli, descrizioni, pulsanti, messaggi e finestre di dialogo — viene tradotta. Nuova impostazione `edgeRecorder.language`.
- **Editor di Skill integrato**: il pulsante ✎ apre un modulo **dentro l'app** per modificare **nome, URL e obiettivo** della Skill, senza più passare dalle finestre di input di VS Code.
- **Ricerca rapida** nelle sezioni **Skills** e **Sessioni**: una casella di ricerca filtra le voci per nome, URL e obiettivo.

## [2.8.0] - 2026-06-12

### Aggiunto
- **Selettore rapido di Skill** nelle sezioni **Registra** e **Automazioni**: un menù "⚡ Carica una Skill salvata…" precompila URL (e obiettivo, in Automazioni) attingendo alle Skill salvate. Compare solo quando esiste almeno una Skill.

### Modificato
- **Identità visiva Flowpilot dentro l'app**: nuova palette d'accento **arancio→magenta** coerente con il logo, al posto del blu di default di VS Code. Titolo e numeri chiave con testo sfumato, barra superiore con accento brand, voce di menù attiva e badge in gradiente, icone delle azioni rapide colorate per categoria, card con leggera ombreggiatura e pulsanti primari con gradiente. Resta la piena compatibilità con tema chiaro e scuro.

## [2.7.0] - 2026-06-12

### Modificato
- **Nuova identità: l'estensione si chiama ora "Flowpilot"** (al posto di "Edge Action Recorder"). Nuovo **logo a vortice arancio→magenta** per estensione e app, nuova tagline *Registra · Replay · Automazioni*.
- La sezione **"Libreria" è stata rinominata in "Skills"** (i task salvati sono automazioni riutilizzabili). Aggiornati menu, titoli, pulsanti e messaggi relativi.
- Aggiornati di conseguenza nome del pannello, titoli dei comandi, label del server Playwright MCP e documentazione.

> Nota: l'identificatore interno dell'estensione resta `edge-action-recorder`, quindi l'aggiornamento avviene senza reinstallazione e le impostazioni esistenti sono preservate.

## [2.6.0] - 2026-06-13

### Aggiunto
- **Sezione Impostazioni**: permette di scegliere la **schermata iniziale** mostrata all'avvio dell'app e di impostare la **cartella di output** (registrazioni, replay e report), con pulsante “Sfoglia” e ripristino della posizione predefinita. Nuova impostazione `edgeRecorder.startupView`.

### Modificato
- Rimosso l'indicatore “idle” in alto a destra; le notifiche brevi compaiono ora come toast non invasivo nella barra superiore (lo stato resta visibile nella Home).
- Voce di menu e titoli **“Navigazione AI” rinominati in “Automazioni”**.
- Il **Log live** è stato spostato all'interno della sezione **Registra** (rimossa la voce di menu dedicata).

## [2.5.0] - 2026-06-13

### Modificato
- **Apertura diretta dell'app**: cliccando l'icona nella activity bar non si apre più un pannello laterale, ma direttamente l'applicazione massimizzata nell'editor (la barra laterale viene richiusa automaticamente).
- **Nome delle sessioni = nome del sito**: le registrazioni vengono salvate con il nome del sito di partenza (es. `en.wikipedia.org`) invece di `session-<timestamp>`. In caso di nomi uguali viene aggiunto un suffisso progressivo (` (2)`, ` (3)`, …).

### Aggiunto
- **Replay rapido nella sezione Registra**: al termine di una registrazione compare una card “Ultima registrazione” con i pulsanti **Replay (AI)** e **Apri cartella**, senza dover passare dalla sezione Sessioni.

## [2.4.0] - 2026-06-13

### Modificato
- **Interfaccia ridisegnata in stile Microsoft Fluent**: nuova barra di navigazione laterale (NavigationView) con sezioni distinte — **Home**, **Registra**, **Navigazione AI**, **Libreria**, **Sessioni**, **Log** — al posto del pannello unico. Tipografia Segoe UI, accento blu Microsoft, card con angoli arrotondati, pulsanti e campi in stile Fluent.
- **Home con panoramica**: contatori di sessioni e voci in libreria, indicatore di stato corrente e “Azioni rapide” per saltare alle sezioni principali.
- I contatori di **Sessioni** e **Libreria** e un indicatore di nuova attività sul **Log** sono ora mostrati come badge nella navigazione.
- Nessuna modifica funzionale: registrazione, replay AI, navigazione AI da prompt e libreria funzionano esattamente come prima.

## [2.3.0] - 2026-06-13

### Aggiunto
- **Navigazione AI “da prompt”**: nuova sezione nel pannello dove inserire un URL e un obiettivo in linguaggio naturale (es. “accedi e scarica l'ultima fattura”). L'estensione genera le istruzioni e le invia a Copilot Chat, che svolge il compito sul sito tramite Playwright MCP e produce un report Markdown + Word. **Non serve registrare** nulla.
- **Libreria di link / task riutilizzabili**: salva URL e prompt ricorrenti, con nome. Ogni voce può essere avviata, usata per precompilare i campi, modificata o eliminata. La libreria è persistente (`library.json` in globalStorage) e sopravvive agli aggiornamenti.
- **Selezione multipla** nella libreria con **“Esegui selezionati”**: l'AI esegue in sequenza tutti i task scelti, in un'unica conversazione, con un report complessivo.

## [2.2.0] - 2026-06-12

### Aggiunto
- **Supporto a Google Chrome** oltre a Microsoft Edge. L'estensione ora funziona anche per chi ha installato solo Chrome: registrazione, replay e AI replay (Playwright MCP) usano automaticamente il browser disponibile.
- Nuova impostazione **`edgeRecorder.browser`** (`auto` | `msedge` | `chrome`): `auto` (predefinito) rileva il browser installato; `msedge`/`chrome` forzano la scelta. In tutti i casi è previsto un **fallback automatico** sull'altro browser se quello scelto non è avviabile.
- Helper condiviso `lib/browser.js` con rilevamento dei canali (stable/beta/dev) e degli eseguibili installati su Windows/macOS/Linux.

### Modificato
- L'avvio del browser prova ora in sequenza i canali Edge **e** Chrome (stable → beta → dev), proseguendo al successivo non solo in caso di hand-off ma anche quando un browser non è installato.
- Il server **Playwright MCP** seleziona automaticamente il canale (`msedge`/`chrome`) in base al browser installato e all'impostazione `edgeRecorder.browser`; la definizione si aggiorna al cambio dell'impostazione.
- Per non entrare in conflitto con il profilo di Edge, **Google Chrome usa una cartella profilo dedicata** (`<profilo>-chrome`).
- Messaggi di errore e testi della UI aggiornati per riflettere il supporto a entrambi i browser.

## [2.1.0] - 2026-06-11

### Aggiunto
- Registrazione automatica del **Playwright MCP server** tramite l'API ufficiale di VS Code (`mcpServerDefinitionProviders` + `vscode.lm.registerMcpServerDefinitionProvider`): non serve più lo script `code --add-mcp`, funziona all'installazione dal Marketplace.
- Server MCP **incluso nel pacchetto** (`@playwright/mcp`) ed eseguito con il Node di VS Code: nessuna dipendenza da `npx` o da Node installato sul sistema.

### Modificato
- Gli script figli (recorder/replay) vengono avviati con l'eseguibile di VS Code in modalità `ELECTRON_RUN_AS_NODE`: **non serve più `node` nel PATH** dell'utente.
- Migrazione da `playwright` a **`playwright-core`** (usa Microsoft Edge di sistema): pacchetto più leggero, nessun download di browser.
- Kill dell'albero processi reso **cross-platform** (taskkill su Windows, `SIGKILL` altrove).
- `engines.vscode` allineato a `^1.102.0` (richiesto dall'API MCP).

### Rimosso
- Fallback silenzioso su Chromium bundled: ora, se Edge non è avviabile, viene mostrato un errore chiaro.

## [2.0.0]
- AI replay tramite Copilot Chat + Playwright MCP; report tecnico Markdown + report Word executive.
