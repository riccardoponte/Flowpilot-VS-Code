/**
 * lib/selectors.js — euristiche di selezione condivise e testabili.
 *
 * Estratte da replay.js per poterle coprire con unit test (vedi
 * test/selectors.test.js) ed evitare che la logica resti chiusa dentro main().
 *
 * Funzioni pure (nessuna dipendenza da Playwright a parte gli oggetti `scope`
 * passati a buildLocators, che vengono solo interrogati):
 *   - isHashedClassName(c)            → true se la classe sembra CSS-in-JS hashata
 *   - stripHashedClassesFromSelector  → ripulisce un selettore CSS dalle classi hashate
 *   - cssEscape(s)                    → escape per #id in un selettore CSS
 *   - buildLocators(scope, target, opts) → cascata di strategie di locator
 */

function cssEscape(s) { return String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1'); }

// Riconosce le classi CSS-in-JS hashate dei principali runtime: Griffel
// (Fluent UI, SharePoint moderno), emotion, jss, styled-components, Stylex,
// piu' un'euristica per pattern pseudo-random misti maiuscole/minuscole/cifre.
function isHashedClassName(c) {
  if (!c) return true;
  if (c.length > 24) return true;
  if (/[=+/]/.test(c)) return true;
  if (/^_{2,}/.test(c)) return true;                   // Griffel: ___xxxxx
  if (/^css-[a-z0-9]{4,}$/.test(c)) return true;       // emotion
  if (/^jss[0-9]+$/.test(c)) return true;              // jss
  if (/^sc-[a-zA-Z0-9]{4,}$/.test(c)) return true;     // styled-components
  if (/^x[a-z0-9]{6,}$/.test(c)) return true;          // Stylex / Meta
  if (/^[a-z][a-z0-9]{5,}$/.test(c) && /[0-9]/.test(c) && !/-/.test(c)) return true;
  if (/^[a-zA-Z0-9_-]{8,}$/.test(c) && /[A-Z]/.test(c) && /[a-z]/.test(c) && /[0-9_-]/.test(c)) return true;
  return false;
}

// Riscrive un selettore CSS combinato (es. "div.A.B:nth-of-type(2) > button.C")
// rimuovendo le classi che sembrano hash. Mantiene tag, id, attributi e
// pseudo-classi strutturali. Se un segmento perde tutte le classi e non ha
// tag, ripiega su "*".
function stripHashedClassesFromSelector(selector) {
  if (!selector || typeof selector !== 'string') return selector;
  // Split sui combinator preservandoli.
  const parts = selector.split(/(\s*[>+~]\s*|\s+)/);
  const out = parts.map(seg => {
    if (/^\s*[>+~]?\s*$/.test(seg)) return seg;
    // Estrai le classi (.foo) senza toccare il resto del segmento.
    return seg.replace(/\.((?:\\.|[^.\s:[#>+~])+)/g, (m, name) => {
      // Rimuovi eventuali backslash di escape per la valutazione.
      const plain = name.replace(/\\(.)/g, '$1');
      return isHashedClassName(plain) ? '' : m;
    });
  });
  let s = out.join('').replace(/\s+/g, ' ').trim();
  // Se un segmento rimane vuoto (tutte le classi rimosse, niente tag), evita ".".
  s = s.replace(/(^|[\s>+~])\.(?=[\s>+~]|$)/g, '$1*');
  return s;
}

/**
 * Costruisce, in ordine di priorità, le strategie con cui ritrovare un elemento
 * dopo settimane (la UI può essere cambiata):
 *   data-id (d365) → data-automationid → href(<a>) → data-testid → data-icon →
 *   role+name → aria-label → title → placeholder → testo → #id → name →
 *   href → data-id → css → css ripulito → xpath
 *
 * `scope` è una Page/Frame/Locator Playwright (viene solo interrogata).
 * `opts` può contenere `profile` (es. 'd365') per modulare le priorità.
 * Ritorna un array di `{ kind, loc }`.
 */
function buildLocators(scope, target, opts = {}) {
  if (!target) return [];
  const tries = [];
  // 0) data-id PRIMA di tutto su Dynamics 365: è lo "stable id" più affidabile
  // della UCI (campi, command bar, tabs, subgrid). In altri contesti resta
  // come strategia successiva (vedi punto 12).
  if (opts.profile === 'd365' && target.dataId) {
    tries.push({ kind: 'd365-dataid', loc: scope.locator(`[data-id=${JSON.stringify(target.dataId)}]`) });
  }
  // 1) data-automationid (Fluent UI / SharePoint / OfficeUI) — molto stabile
  if (target.automationId) {
    tries.push({ kind: 'automationid',
      loc: scope.locator(`[data-automationid=${JSON.stringify(target.automationId)}], [data-automation-id=${JSON.stringify(target.automationId)}]`) });
  }
  // 1b) link by href (anticipato): per <a> su SharePoint/Fluent l'href e'
  //     spesso piu' stabile di classi hashate o nth-of-type posizionali.
  if (target.href && target.tag === 'a' && target.href.length < 512 && !/^javascript:/i.test(target.href)) {
    tries.push({ kind: 'href-early', loc: scope.locator(`a[href=${JSON.stringify(target.href)}]`) });
  }
  // 2) data-testid
  if (target.testId) tries.push({ kind: 'testid', loc: scope.getByTestId(target.testId) });
  // 3) data-icon-name (Fluent UI icons in menu/toolbar)
  if (target.dataIcon) {
    tries.push({ kind: 'dataicon', loc: scope.locator(`[data-icon-name=${JSON.stringify(target.dataIcon)}]`) });
  }
  // 4) role + accessible name
  if (target.role && (target.ariaLabel || target.text || target.richText)) {
    const name = target.ariaLabel || target.text || target.richText;
    tries.push({ kind: 'role', loc: scope.getByRole(target.role, { name, exact: false }) });
  }
  // 5) aria-label
  if (target.ariaLabel) {
    tries.push({ kind: 'aria', loc: scope.locator(`[aria-label=${JSON.stringify(target.ariaLabel)}]`) });
  }
  // 6) title attribute (tooltip)
  if (target.title) {
    tries.push({ kind: 'title', loc: scope.locator(`[title=${JSON.stringify(target.title)}]`) });
  }
  // 7) placeholder (input)
  if (target.tag === 'input' && target.placeholder) {
    tries.push({ kind: 'placeholder', loc: scope.getByPlaceholder(target.placeholder) });
  }
  // 8) testo visibile (filtrato per tag se sensato)
  const tagsForText = ['a','button','span','div','li','td','th','label','strong','em','h1','h2','h3','h4','option'];
  const t = (target.text || target.richText || '').trim();
  if (t && t.length >= 2 && t.length <= 80 && target.tag && tagsForText.includes(target.tag)) {
    tries.push({ kind: 'text', loc: scope.getByText(t, { exact: false }) });
    // testo dentro un antenato con aria-label/role specifici (per disambiguare i menu)
    if (target.ancestorLabel) {
      tries.push({ kind: 'text-in-ancestor',
        loc: scope.locator(`[aria-label=${JSON.stringify(target.ancestorLabel)}]`).getByText(t, { exact: false }) });
    }
  }
  // 9) #id (ignora id numerici o troppo lunghi/hashati)
  if (target.id && !/^[0-9]/.test(target.id) && target.id.length < 64 && !/^[a-zA-Z0-9_-]{20,}$/.test(target.id)) {
    tries.push({ kind: 'id', loc: scope.locator('#' + cssEscape(target.id)) });
  }
  // 10) input by name
  if (target.name && target.tag === 'input') {
    tries.push({ kind: 'name', loc: scope.locator(`${target.tag}[name=${JSON.stringify(target.name)}]`) });
  }
  // 11) link by href
  if (target.href && target.tag === 'a') {
    tries.push({ kind: 'href', loc: scope.locator(`a[href=${JSON.stringify(target.href)}]`) });
  }
  // 12) data-id
  if (target.dataId) {
    tries.push({ kind: 'dataid', loc: scope.locator(`[data-id=${JSON.stringify(target.dataId)}]`) });
  }
  // 13) selettore CSS originale (fragile, ultima risorsa)
  if (target.selector) tries.push({ kind: 'css', loc: scope.locator(target.selector) });
  // 13b) selettore CSS "ripulito": rimuove le classi hashate (Griffel/emotion/
  //      Stylex/jss/styled-components) lasciando tag, classi stabili e :nth-of-type.
  //      Utile su SharePoint/Fluent/D365 dove le classi cambiano a ogni build.
  if (target.selector) {
    const stable = stripHashedClassesFromSelector(target.selector);
    if (stable && stable !== target.selector) {
      tries.push({ kind: 'css-stable', loc: scope.locator(stable) });
    }
  }
  // 14) XPath
  if (target.xpath) tries.push({ kind: 'xpath', loc: scope.locator('xpath=' + target.xpath) });
  return tries;
}

module.exports = { cssEscape, isHashedClassName, stripHashedClassesFromSelector, buildLocators };
