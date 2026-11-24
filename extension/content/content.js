// Paper Translator: web page translator (content script).
//
// How it avoids the "<sup>" / wrong-font problem of Chrome's built-in
// translate: each paragraph is sent to the engine as plain text in which
// citations, superscripts, math, code, etc. are replaced by markers (⟦1⟧) and
// inline formatting (italic, links...) is wrapped in paired markers
// (⟦2⟧...⟦/2⟧). The translated text is then rebuilt with the ORIGINAL
// elements put back where their markers ended up, so citations keep their
// exact original markup, style and behaviour, and translated text always sits
// in the paragraph itself (normal font), never inside a citation link.
(() => {
  if (globalThis.__ptxContentLoaded) return;
  globalThis.__ptxContentLoaded = true;

  const M = globalThis.PTXMarkers;
  const DEFAULTS = globalThis.PTX_DEFAULTS;
  const OWN_ATTR = 'data-ptx';
  const MAX_INFLIGHT = 3;
  const BATCH_CHARS = 3500;
  const BATCH_ITEMS = 40;

  // ---------------------------------------------------------------- tags
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'CAPTION', 'CENTER', 'DD', 'DETAILS', 'DIALOG', 'DIR', 'DIV',
    'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
    'HGROUP', 'HR', 'HTML', 'LEGEND', 'LI', 'MAIN', 'MENU', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
    'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ]);
  const BLOCK_SELECTOR = [...BLOCK_TAGS]
    .filter((t) => t !== 'BODY' && t !== 'HTML')
    .map((t) => t.toLowerCase())
    .join(',');
  // Elements whose content is never translated. Inline ones are kept in place
  // as atoms; block-level ones are skipped entirely.
  const OPAQUE_TAGS = new Set([
    'SUP', 'SUB', 'BR', 'WBR', 'HR', 'IMG', 'PICTURE', 'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'FRAME',
    'OBJECT', 'EMBED', 'CODE', 'KBD', 'SAMP', 'VAR', 'TT', 'PRE', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA',
    'INPUT', 'SELECT', 'OPTION', 'OPTGROUP', 'BUTTON', 'DATALIST', 'OUTPUT', 'PROGRESS', 'METER', 'MJX-CONTAINER',
    'MJX-ASSISTIVE-MML', 'HEAD', 'TITLE', 'META', 'LINK', 'BASE', 'SLOT', 'PTX-TOAST',
  ]);
  // Block elements that get a translated sibling copy in bilingual mode.
  const PARA_LIKE = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGCAPTION', 'DD', 'DT', 'ADDRESS', 'DIV']);
  const MATH_CLASS_RE = /(mathjax|katex|^mjx-|^math$|ltx_math|mwe-math|^tex$|latex|equation)/i;
  const CITE_CLASS_RE = /(^|[-_])(xref|cite|citation|citations|bibr|biblioref|ref-?link|ref-?anchor|reference-?link|footnote-?ref|fn-?ref|dropblock)([-_]|$)/i;

  // ---------------------------------------------------------------- paper mode
  // Where the article lives on common publisher sites, and what to keep in the
  // original language (references, authors, affiliations, metadata).
  const PROFILES = [
    {
      // Nature, Springer, BioMed Central (Springer Nature platform)
      host: /(^|\.)(nature\.com|springer\.com|springeropen\.com|biomedcentral\.com)$/i,
      roots: ['article', 'main'],
      exclude: [
        'section[aria-labelledby="Bib1"]', 'section[data-title="References"]', '.c-article-references',
        '.c-article-author-list', 'section[aria-labelledby="author-information"]', '.c-article-author-affiliation',
        '.c-article-info-details', 'section[aria-labelledby="article-info"]', '.c-article-identifiers',
        '.c-article-recommendations', '.app-explore-related-subjects', 'section[data-title="Comments"]',
        '.c-pdf-button__container', '.c-article-share-box', '.c-bibliographic-information',
        '.c-article-metrics-bar__wrapper', '.c-article-metrics-bar',
      ],
    },
    {
      // Science family and PNAS (Atypon "core" templates)
      host: /(^|\.)(science\.org|pnas\.org)$/i,
      roots: ['article', 'main'],
      exclude: [
        '#bibliography', '[role="doc-bibliography"]', '.core-authors', '[property="author"]', '.affiliations',
        '.core-self-citation', '.core-published', '.core-container .citations',
      ],
    },
    {
      // Cell Press
      host: /(^|\.)cell\.com$/i,
      roots: ['article', 'main'],
      exclude: ['#references', '.references', '.article__references', '.loa', '.author-group', '.affiliations', '.article-header__info'],
    },
    {
      // Elsevier ScienceDirect
      host: /(^|\.)sciencedirect\.com$/i,
      roots: ['article', 'main'],
      exclude: ['.bibliography', '#references', '.author-group', '.affiliation', '#banner', '.related-content-links'],
    },
    {
      // PubMed Central / PubMed
      host: /(^|\.)ncbi\.nlm\.nih\.gov$/i,
      roots: ['article', 'main', '#maincontent'],
      exclude: ['.ref-list', '[id^="ref-list"]', '.contrib-group', '.fm-author', '.fm-affl', '.affiliations', '.authors-list', '#references'],
    },
    {
      // bioRxiv / medRxiv
      host: /(^|\.)(biorxiv\.org|medrxiv\.org)$/i,
      roots: ['.article.fulltext-view', 'article', 'main'],
      exclude: ['.ref-list', '.highwire-cite-authors', '.affiliation-list', '.contributors'],
    },
    {
      // arXiv HTML papers
      host: /(^|\.)arxiv\.org$/i,
      roots: ['article.ltx_document', '.ltx_page_content', 'main', 'article'],
      exclude: ['.ltx_bibliography', '.ltx_authors', '.ltx_role_affiliation', '.ltx_role_address'],
    },
    {
      host: /(^|\.)plos\.org$/i,
      roots: ['.article-content', 'article', 'main'],
      exclude: ['.references', '#references', '.author-list', '#author-list'],
    },
    {
      host: /(^|\.)elifesciences\.org$/i,
      roots: ['main', 'article'],
      exclude: ['#references', '.reference-list', '.author-list', '.content-header__authors', '.content-header__institution_list'],
    },
    {
      host: /(^|\.)wiley\.com$/i,
      roots: ['article', 'main'],
      exclude: ['.article-section__references', '#references-section', '.loa-wrapper', '.author-info'],
    },
  ];
  const GENERIC_EXCLUDE = [
    '[role="doc-bibliography"]', '[role="doc-endnotes"]', '[itemprop="author"]', '[rel="author"]', '[property="author"]',
  ];
  const REF_TOKEN_RE =
    /^(?:.*[-_])?(?:references?|reference-?list|refs|ref-?list|reflist|bibliography|biblio|bib-?list|citation-?list|cit-?list|literature-?cited)$/i;
  const REF_ID_RE = /^(?:.*[-_])?(?:references?|bibliography|biblio|ref-?list\d*|reflist)$/i;
  const AUTHOR_TOKEN_RE =
    /^(?:.*[-_])?(?:authors?|author-?list|authors-?list|author-?names?|author-?group|author-?info(?:rmation)?|contrib-?group|affiliations?|affs?|loa)$/i;
  const REF_HEADING_RE =
    /^\s*(?:\d+(?:\.\d+)*\.?\s*)?(?:references?(?:\s+and\s+notes)?|notes\s+and\s+references|bibliography|literature\s+cited|works\s+cited|cited\s+literature|reference\s+list|参考文献)\s*$/i;
  const AUTHOR_HEADING_RE = /^\s*(?:author\s+information|authors?\s+and\s+affiliations|affiliations)\s*$/i;

  const profileFor = (host) => PROFILES.find((p) => p.host.test(host)) || null;

  // ---------------------------------------------------------------- state
  let settings = { ...DEFAULTS };
  const state = {
    active: false,
    mode: 'replace',
    tl: 'zh-CN',
    paperMode: true,
    session: 0,
    units: [],
    queue: [],
    inflight: 0,
    error: null,
    roots: [],
    rootTextLen: 0,
    excluded: new Set(),
    observer: null,
    pending: new Set(),
    pendingTimer: 0,
    savedLang: undefined,
    savedTranslate: undefined,
    configKey: null,
  };
  let nodeUnit = new WeakMap(); // node -> unit currently laying it out
  const ownNodes = new WeakSet(); // nodes created by this script
  let displayCache = new WeakMap();
  let blockCache = new WeakMap();
  let unitSeq = 0;

  // ---------------------------------------------------------------- DOM helpers
  function display(el) {
    let d = displayCache.get(el);
    if (d === undefined) {
      try {
        d = getComputedStyle(el).display || 'inline';
      } catch (e) {
        d = 'inline';
      }
      displayCache.set(el, d);
    }
    return d;
  }

  const isInlineDisplay = (d) => d.startsWith('inline') || d === 'contents' || d.startsWith('ruby');

  function hiddenBetween(node, ancestor) {
    for (let p = node; p && p !== ancestor; p = p.parentElement) if (display(p) === 'none') return true;
    return false;
  }

  function hasBlockDescendant(el) {
    for (const d of el.querySelectorAll(BLOCK_SELECTOR)) {
      const dd = display(d);
      if (dd !== 'none' && !isInlineDisplay(dd) && !hiddenBetween(d, el)) return true;
    }
    return false;
  }

  // Does this element start a new block (paragraph boundary)?
  function isBlock(el) {
    let v = blockCache.get(el);
    if (v !== undefined) return v;
    const d = display(el);
    if (d === 'none') v = BLOCK_TAGS.has(el.tagName);
    else if (isInlineDisplay(d)) v = hasBlockDescendant(el);
    else v = true;
    blockCache.set(el, v);
    return v;
  }

  function isInlineLevel(el) {
    const d = display(el);
    if (d === 'none') return !BLOCK_TAGS.has(el.tagName);
    return isInlineDisplay(d);
  }

  function isOwn(node) {
    return ownNodes.has(node) || (node.nodeType === 1 && node.hasAttribute(OWN_ATTR));
  }

  // Never translate the content of these elements.
  function isOpaque(el) {
    if (!(el instanceof HTMLElement)) return true; // SVG, MathML
    if (OPAQUE_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(OWN_ATTR)) return true;
    const tr = el.getAttribute('translate');
    if (tr && tr.toLowerCase() === 'no') return true;
    if (el.isContentEditable) return true;
    for (const c of el.classList) if (c === 'notranslate' || MATH_CLASS_RE.test(c)) return true;
    const role = el.getAttribute('role');
    if (role && /^(math|img|doc-biblioref|doc-noteref|doc-backlink|doc-glossref)$/.test(role)) return true;
    return false;
  }

  function isInPageLink(href) {
    if (!href) return false;
    if (href.startsWith('#')) return true;
    try {
      const u = new URL(href, location.href);
      return !!u.hash && u.origin === location.origin && u.pathname === location.pathname;
    } catch (e) {
      return false;
    }
  }

  // Citation / cross-reference elements are kept as-is.
  function isCitation(el) {
    const role = el.getAttribute('role');
    if (role && /^doc-(biblio|note|endnote|footnote)ref$/.test(role)) return true;
    if (el.hasAttribute('data-xml-rid') || el.hasAttribute('data-db-target-for')) return true;
    if (el.getAttribute('data-test') === 'citation-ref') return true;
    for (const c of el.classList) {
      if (CITE_CLASS_RE.test(c) && (el.innerText || el.textContent).trim().length <= 120) return true;
    }
    if (el.tagName === 'A' && isInPageLink(el.getAttribute('href'))) {
      const txt = el.textContent.trim();
      if (txt.length <= 80 && (/\d/.test(txt) || /\bet\s+al\b/i.test(txt))) return true;
    }
    return false;
  }

  // How an inline element is represented in the text sent for translation.
  //  'atom'    kept exactly as-is (citations, math, code, superscripts...)
  //  'pair'    translated in context, element re-wrapped around the result
  //  'flatten' plain wrapper without meaning; its text is merged in
  function classifyInline(el, flat) {
    if (isOpaque(el) || state.excluded.has(el)) return 'atom';
    const d = display(el);
    if (d === 'none' || !isInlineDisplay(d)) return 'atom';
    if (!M.hasWords(el.textContent)) return 'atom';
    if (M.isUrlText(el.textContent)) return 'atom'; // a link showing a URL
    if (isCitation(el)) return 'atom';
    if (flat) return 'flatten';
    if ((el.tagName === 'SPAN' || el.tagName === 'FONT') && el.attributes.length === 0) return 'flatten';
    return 'pair';
  }

  // ---------------------------------------------------------------- roots & exclusions
  function computeRoots() {
    if (state.paperMode) {
      const prof = profileFor(location.hostname);
      if (prof) {
        for (const sel of prof.roots) {
          let best = null;
          let bestLen = 1500;
          for (const el of document.querySelectorAll(sel)) {
            const len = el.textContent.length;
            if (len > bestLen) {
              best = el;
              bestLen = len;
            }
          }
          if (best) return [best];
        }
      }
    }
    return [document.body];
  }

  function safeQueryAll(scope, selectors) {
    const out = [];
    for (const sel of selectors) {
      try {
        if (scope.matches && scope.matches(sel)) out.push(scope);
        out.push(...scope.querySelectorAll(sel));
      } catch (e) {
        /* invalid selector: ignore */
      }
    }
    return out;
  }

  function computeExclusions(scope) {
    if (!state.paperMode || !scope || scope.nodeType !== 1) return;
    const limit = Math.max(2000, state.rootTextLen * 0.6);
    const add = (el) => {
      if (!el || el === document.body || el === document.documentElement) return;
      if (state.roots.some((r) => el.contains(r))) return; // never exclude the article itself
      if (el.textContent.length < limit) state.excluded.add(el);
    };
    const prof = profileFor(location.hostname);
    for (const el of safeQueryAll(scope, [...GENERIC_EXCLUDE, ...(prof ? prof.exclude : [])])) add(el);

    const tokenMatch = (el) => {
      for (const c of el.classList) if (REF_TOKEN_RE.test(c) || AUTHOR_TOKEN_RE.test(c)) return true;
      const id = el.id;
      return !!id && (REF_ID_RE.test(id) || AUTHOR_TOKEN_RE.test(id));
    };
    if (tokenMatch(scope)) add(scope);
    for (const el of scope.querySelectorAll('[class],[id]')) if (tokenMatch(el)) add(el);

    for (const h of scope.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
      const txt = h.textContent.replace(/\s+/g, ' ').trim();
      if (!REF_HEADING_RE.test(txt) && !AUTHOR_HEADING_RE.test(txt)) continue;
      const sec = h.closest('section');
      if (sec && !state.roots.includes(sec) && sec.querySelector('h1,h2,h3,h4,h5,h6') === h) {
        add(sec);
        continue;
      }
      const level = Number(h.tagName[1]);
      let start = h;
      while (start.parentElement && start.parentElement.children.length === 1 && !state.roots.includes(start.parentElement)) {
        start = start.parentElement;
      }
      for (let sib = start.nextElementSibling; sib; sib = sib.nextElementSibling) {
        if (/^H[1-6]$/.test(sib.tagName) && Number(sib.tagName[1]) <= level) break;
        const inner = sib.querySelector('h1,h2,h3,h4,h5,h6');
        if (inner && Number(inner.tagName[1]) <= level) break;
        add(sib);
      }
    }
  }

  function isInsideSkipped(node) {
    for (let el = node.nodeType === 1 ? node : node.parentElement; el; el = el.parentElement) {
      if (el.hasAttribute(OWN_ATTR) || state.excluded.has(el)) return true;
      if (isOpaque(el) && el !== document.body && el !== document.documentElement) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- units
  // A unit is a run of consecutive inline nodes inside one block element
  // (normally: the whole content of a <p>, <li>, <h2>, <figcaption>...).
  function walk(el, out) {
    let run = [];
    const flush = () => {
      if (run.length) addRun(el, run, out);
      run = [];
    };
    for (const child of Array.from(el.childNodes)) {
      if (nodeUnit.has(child) || isOwn(child)) {
        flush();
        continue;
      }
      if (child.nodeType !== 1) {
        run.push(child); // text, comments
        continue;
      }
      if (state.excluded.has(child) || isOpaque(child)) {
        if (isInlineLevel(child)) run.push(child);
        else flush();
        continue;
      }
      if (isBlock(child)) {
        flush();
        walk(child, out);
        continue;
      }
      run.push(child);
    }
    flush();
  }

  function looksLikeTarget(text) {
    if (!/^(zh|ja|ko)/i.test(state.tl)) return false;
    const cjk = (text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || []).length;
    const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
    return cjk > 0 && cjk * 2 >= latin;
  }

  function addRun(block, run, out) {
    let txt = '';
    for (const n of run) txt += n.textContent || '';
    if (!M.hasWords(txt)) return;
    const parent = run[0].parentNode;
    let meaningful = 0;
    for (const c of parent.childNodes) if (!isOwn(c)) meaningful++;
    const unit = {
      id: ++unitSeq,
      block,
      parent,
      nodes: run.slice(),
      whole: run.length === meaningful,
      flat: false,
      status: 'new',
      applied: null,
      tokens: null,
      top: 0,
    };
    encodeUnit(unit);
    const plain = unit.src.replace(/⟦\/?\d+⟧/g, ' ');
    if (!M.hasWords(plain) || looksLikeTarget(plain)) return;
    // Standard section headings ("Abstract", "Main", "Methods"...) come from
    // a glossary: Google translates them badly in isolation.
    const fixed = unit.kinds.length === 1 && globalThis.ptxGlossary ? globalThis.ptxGlossary(unit.src, state.tl) : null;
    if (fixed) {
      unit.tokens = [{ t: 'text', v: fixed }];
      unit.status = 'done';
    }
    for (const n of unit.nodes) nodeUnit.set(n, unit);
    out.push(unit);
  }

  function encodeUnit(unit) {
    const reg = [null];
    const kinds = [null];
    const snap = new Map();
    let s = '';
    const visit = (node) => {
      if (node.nodeType === 3) {
        for (const part of M.splitUrls(node.nodeValue.replace(/\s+/g, ' '))) {
          if (part.url) {
            reg.push(part.v); // a URL in running text: kept verbatim (string atom)
            kinds.push('atom');
            s += M.atom(reg.length - 1);
          } else {
            s += M.escapeText(part.v);
          }
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const kind = classifyInline(node, unit.flat);
      if (kind === 'atom') {
        reg.push(node);
        kinds.push('atom');
        s += M.atom(reg.length - 1);
        return;
      }
      snap.set(node, Array.from(node.childNodes));
      if (kind === 'pair') {
        reg.push(node);
        kinds.push('pair');
        const k = reg.length - 1;
        s += M.open(k);
        node.childNodes.forEach(visit);
        s += M.close(k);
      } else {
        node.childNodes.forEach(visit);
      }
    };
    unit.nodes.forEach(visit);
    unit.src = s.replace(/\s+/g, ' ').trim();
    unit.reg = reg;
    unit.kinds = kinds;
    unit.snap = snap;
  }

  // ---------------------------------------------------------------- applying
  function cleanClone(node, deep) {
    const c = node.cloneNode(deep);
    if (c.nodeType === 1) {
      c.removeAttribute('id');
      if (deep) for (const e of c.querySelectorAll('[id]')) e.removeAttribute('id');
    }
    return c;
  }

  // Build the translated content. In replace mode the original elements are
  // reused (moved); in bilingual mode they are cloned.
  function buildContent(unit, clone) {
    const frag = document.createDocumentFragment();
    const stack = [frag];
    const reused = new Set();
    for (const tok of unit.tokens) {
      const top = stack[stack.length - 1];
      if (tok.t === 'text') {
        const tn = document.createTextNode(tok.v);
        ownNodes.add(tn);
        top.appendChild(tn);
      } else if (tok.t === 'atom') {
        const n = unit.reg[tok.k];
        if (typeof n === 'string') {
          const tn = document.createTextNode(n);
          ownNodes.add(tn);
          top.appendChild(tn);
        } else if (clone) top.appendChild(cleanClone(n, true));
        else {
          reused.add(n);
          top.appendChild(n);
        }
      } else if (tok.t === 'open') {
        const n = unit.reg[tok.k];
        let el;
        if (clone) el = cleanClone(n, false);
        else {
          el = n;
          reused.add(n);
          el.replaceChildren();
        }
        top.appendChild(el);
        stack.push(el);
      } else if (tok.t === 'close' && stack.length > 1) {
        stack.pop();
      }
    }
    return { frag, reused };
  }

  function applyReplace(unit) {
    const parent = unit.parent;
    if (!parent.isConnected || !unit.nodes.every((n) => n.parentNode === parent)) return false;
    const marker = document.createComment('ptx');
    ownNodes.add(marker);
    parent.insertBefore(marker, unit.nodes[0]);
    const { frag, reused } = buildContent(unit, false);
    const top = Array.from(frag.childNodes);
    parent.insertBefore(frag, marker);
    for (const n of unit.nodes) if (!reused.has(n) && n.parentNode === parent) parent.removeChild(n);
    unit.marker = marker;
    unit.newNodes = top;
    for (const n of top) nodeUnit.set(n, unit);
    return true;
  }

  function flowParent(el) {
    const p = el.parentElement;
    if (!p) return false;
    const d = display(p);
    return !(d.includes('flex') || d.includes('grid'));
  }

  function applyBilingual(unit) {
    const p = unit.parent;
    if (!p.isConnected) return false;
    const { frag } = buildContent(unit, true);
    let host;
    if (unit.whole && p.nodeType === 1 && PARA_LIKE.has(p.tagName) && p.parentNode && flowParent(p) && !state.roots.includes(p)) {
      host = p.cloneNode(false);
      host.removeAttribute('id');
      host.classList.add('ptx-bi');
      unit.hadClass = p.hasAttribute('class');
      p.classList.add('ptx-bi-src');
      unit.markedSrc = true;
      host.appendChild(frag);
      p.after(host);
    } else {
      host = document.createElement('span');
      host.className = 'ptx-bi-block';
      host.appendChild(frag);
      unit.nodes[unit.nodes.length - 1].after(host);
    }
    host.setAttribute(OWN_ATTR, 'bi');
    ownNodes.add(host);
    unit.biNode = host;
    return true;
  }

  function applyUnit(unit) {
    if (!unit.tokens || unit.applied === state.mode) return;
    if (unit.applied) unapplyUnit(unit);
    const ok = state.mode === 'replace' ? applyReplace(unit) : applyBilingual(unit);
    if (ok) unit.applied = state.mode;
    else unit.status = 'gone';
  }

  function unapplyUnit(unit) {
    if (unit.applied === 'replace') {
      const marker = unit.marker;
      const parent = marker && marker.parentNode;
      if (parent) {
        for (const n of unit.newNodes) {
          nodeUnit.delete(n);
          if (n.parentNode) n.parentNode.removeChild(n);
        }
        for (const [el, kids] of unit.snap) el.replaceChildren(...kids);
        for (const n of unit.nodes) parent.insertBefore(n, marker);
        parent.removeChild(marker);
        for (const n of unit.nodes) nodeUnit.set(n, unit);
      }
      unit.marker = null;
      unit.newNodes = null;
    } else if (unit.applied === 'bilingual') {
      if (unit.biNode) unit.biNode.remove();
      unit.biNode = null;
      if (unit.markedSrc) {
        unit.parent.classList.remove('ptx-bi-src');
        if (!unit.hadClass && unit.parent.getAttribute('class') === '') unit.parent.removeAttribute('class');
        unit.markedSrc = false;
      }
    }
    unit.applied = null;
  }

  function handleTranslation(unit, raw) {
    const prepared = M.prepare(raw, state.tl);
    let res = M.parse(prepared, unit.kinds);
    if (!res.ok) {
      console.debug('[Paper Translator] markers changed by the engine', res.problems, { src: unit.src, out: raw });
    }
    if (!res.ok && !res.pairsOk && !unit.flat && unit.kinds.includes('pair')) {
      // Italic/link markers came back scrambled: retry once without them.
      // (If only citation atoms are off, repair below keeps the formatting.)
      unit.flat = true;
      encodeUnit(unit);
      unit.status = 'queued';
      state.queue.push(unit);
      return;
    }
    if (!res.ok) res = M.parse(prepared, unit.kinds, { repair: true });
    unit.tokens = res.tokens;
    unit.status = 'done';
    if (state.active) applyUnit(unit);
  }

  // ---------------------------------------------------------------- queue
  function measure(unit) {
    try {
      const r = unit.block.getBoundingClientRect();
      unit.top = r.width === 0 && r.height === 0 ? Infinity : r.top + window.scrollY;
    } catch (e) {
      unit.top = Infinity;
    }
  }

  function enqueue(unit) {
    if (unit.status !== 'new' && unit.status !== 'failed') return;
    unit.status = 'queued';
    measure(unit);
    state.queue.push(unit);
  }

  function priority(u) {
    if (u.top === Infinity) return 1e12;
    const vt = window.scrollY - 150;
    return u.top >= vt ? u.top - vt : 1e9 + (vt - u.top);
  }

  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function pump() {
    if (!state.active) return;
    while (state.inflight < MAX_INFLIGHT && state.queue.length) {
      state.queue.sort((a, b) => priority(a) - priority(b));
      const batch = [];
      let chars = 0;
      while (state.queue.length && batch.length < BATCH_ITEMS) {
        const u = state.queue[0];
        if (batch.length && chars + u.src.length > BATCH_CHARS) break;
        state.queue.shift();
        u.status = 'inflight';
        batch.push(u);
        chars += u.src.length;
      }
      state.inflight++;
      sendToBackground({ type: 'ptx:translate', texts: batch.map((u) => u.src), sl: 'auto', tl: state.tl })
        .then((resp) => {
          const list = resp && resp.translations;
          batch.forEach((u, i) => {
            const tr = list ? list[i] : null;
            if (typeof tr !== 'string') {
              u.status = 'failed';
              state.error = (resp && resp.error) || 'Translation failed';
            } else {
              handleTranslation(u, tr);
            }
          });
        })
        .catch((e) => {
          for (const u of batch) u.status = 'failed';
          const m = String((e && e.message) || e);
          state.error = /context invalidated/i.test(m)
            ? 'The extension was reloaded. Refresh this page to translate again.'
            : m;
        })
        .finally(() => {
          state.inflight--;
          if (state.observer) state.observer.takeRecords();
          updateToast();
          pump();
        });
    }
    updateToast();
  }

  function counts() {
    let total = 0;
    let done = 0;
    let failed = 0;
    for (const u of state.units) {
      if (u.status === 'gone') continue;
      total++;
      if (u.status === 'done') done++;
      else if (u.status === 'failed') failed++;
    }
    return { total, done, failed, pending: total - done - failed };
  }

  // ---------------------------------------------------------------- mutations
  function startObserver() {
    if (state.observer) return;
    state.observer = new MutationObserver(onMutations);
    for (const r of state.roots) state.observer.observe(r, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    clearTimeout(state.pendingTimer);
    state.pendingTimer = 0;
    state.pending.clear();
  }

  function onMutations(records) {
    if (!state.active) return;
    for (const rec of records) {
      for (const n of rec.addedNodes) {
        if (isOwn(n) || nodeUnit.has(n)) continue;
        if (n.nodeType === 1 || (n.nodeType === 3 && n.nodeValue.trim())) state.pending.add(n);
      }
    }
    if (state.pending.size && !state.pendingTimer) state.pendingTimer = setTimeout(processPending, 600);
  }

  function processPending() {
    state.pendingTimer = 0;
    const nodes = [...state.pending];
    state.pending.clear();
    if (!state.active) return;
    displayCache = new WeakMap();
    blockCache = new WeakMap();
    const targets = new Set();
    for (const n of nodes) {
      if (!n.isConnected || isInsideSkipped(n)) continue;
      let t = n.nodeType === 1 ? n : n.parentElement;
      while (t && !state.roots.includes(t) && !isBlock(t)) t = t.parentElement;
      if (t) targets.add(t);
    }
    const list = [...targets].filter((t) => ![...targets].some((o) => o !== t && o.contains(t)));
    const fresh = [];
    for (const t of list) {
      computeExclusions(t);
      if (!isInsideSkipped(t)) walk(t, fresh);
    }
    for (const u of fresh) {
      state.units.push(u);
      enqueue(u);
    }
    if (fresh.length) pump();
  }

  // ---------------------------------------------------------------- lifecycle
  function setPageLang(on) {
    const html = document.documentElement;
    if (on) {
      if (state.savedLang === undefined) state.savedLang = html.getAttribute('lang');
      html.setAttribute('lang', state.tl);
    } else if (state.savedLang !== undefined) {
      if (state.savedLang === null) html.removeAttribute('lang');
      else html.setAttribute('lang', state.savedLang);
      state.savedLang = undefined;
    }
  }

  // Stop Chrome's built-in translator from re-translating our output.
  function setNoTranslate(on) {
    const html = document.documentElement;
    if (on) {
      if (state.savedTranslate === undefined) state.savedTranslate = html.getAttribute('translate');
      html.setAttribute('translate', 'no');
    } else if (state.savedTranslate !== undefined) {
      if (state.savedTranslate === null) html.removeAttribute('translate');
      else html.setAttribute('translate', state.savedTranslate);
      state.savedTranslate = undefined;
    }
  }

  function resetUnits() {
    for (const u of state.units) if (u.applied) unapplyUnit(u);
    state.units = [];
    state.queue = [];
    state.excluded = new Set();
    nodeUnit = new WeakMap();
  }

  async function start(mode) {
    settings = await globalThis.ptxLoadSettings();
    const newMode = mode || settings.mode || 'replace';
    const key = `${settings.targetLang}|${settings.paperMode}`;
    if (state.active) {
      if (key !== state.configKey) {
        stop();
      } else {
        setMode(newMode);
        return;
      }
    }
    if (key !== state.configKey) resetUnits();
    state.configKey = key;
    state.tl = settings.targetLang;
    state.paperMode = !!settings.paperMode;
    state.mode = newMode;
    state.active = true;
    state.session++;
    state.error = null;
    displayCache = new WeakMap();
    blockCache = new WeakMap();

    state.roots = computeRoots();
    state.rootTextLen = state.roots.reduce((n, r) => n + r.textContent.length, 0);
    for (const r of state.roots) computeExclusions(r);
    const fresh = [];
    for (const r of state.roots) walk(r, fresh);
    state.units.push(...fresh);

    setNoTranslate(true);
    if (state.mode === 'replace') setPageLang(true);
    for (const u of state.units) {
      if (u.tokens) applyUnit(u);
      else enqueue(u);
    }
    startObserver();
    if (state.observer) state.observer.takeRecords();
    showToast();
    pump();
  }

  function stop() {
    if (!state.active) return;
    state.active = false;
    state.session++;
    stopObserver();
    for (const u of state.queue) u.status = 'new';
    state.queue = [];
    for (const u of state.units) if (u.applied) unapplyUnit(u);
    setPageLang(false);
    setNoTranslate(false);
    hideToast(true);
  }

  function setMode(mode) {
    if (mode !== 'replace' && mode !== 'bilingual') return;
    if (mode === state.mode) return;
    state.mode = mode;
    if (!state.active) return;
    for (const u of state.units) {
      if (u.applied) {
        unapplyUnit(u);
        applyUnit(u);
      }
    }
    setPageLang(mode === 'replace');
    if (state.observer) state.observer.takeRecords();
    updateToast();
  }

  function retryFailed() {
    state.error = null;
    for (const u of state.units) if (u.status === 'failed') enqueue(u);
    showToast();
    pump();
  }

  function status() {
    const c = counts();
    return {
      ok: true,
      active: state.active,
      mode: state.active ? state.mode : settings.mode,
      tl: state.tl,
      ...c,
      inflight: state.inflight,
      error: state.error,
      isPdf: document.contentType === 'application/pdf',
      host: location.hostname,
    };
  }

  // ---------------------------------------------------------------- toast
  let toast = null;
  let toastTimer = 0;
  function ensureToast() {
    if (toast && toast.host.isConnected) return toast;
    const host = document.createElement('ptx-toast');
    host.setAttribute(OWN_ATTR, 'ui');
    host.setAttribute('translate', 'no');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; display: flex; align-items: center;
          gap: 8px; max-width: 360px; padding: 8px 10px 8px 12px; border-radius: 10px; background: rgba(32, 33, 36, .92);
          color: #fff; font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC",
          "Microsoft YaHei", sans-serif; box-shadow: 0 4px 16px rgba(0,0,0,.25); transition: opacity .25s; }
        .box.hidden { opacity: 0; pointer-events: none; }
        .spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35);
          border-top-color: #8ab4f8; animation: s .8s linear infinite; flex: none; }
        .ok { width: 12px; height: 12px; flex: none; color: #81c995; font-weight: 700; line-height: 12px; }
        .err { color: #f28b82; }
        @keyframes s { to { transform: rotate(360deg); } }
        button { all: unset; cursor: pointer; padding: 2px 8px; border-radius: 6px; background: rgba(255,255,255,.14);
          color: #fff; font: inherit; }
        button:hover { background: rgba(255,255,255,.25); }
        button[hidden] { display: none; }
        .x { padding: 0 6px; background: transparent; opacity: .7; }
        .msg { flex: 1; }
      </style>
      <div class="box hidden"><span class="icon"></span><span class="msg"></span>
        <button class="act" hidden></button><button class="x" title="Close">×</button></div>`;
    const box = root.querySelector('.box');
    const els = {
      host,
      box,
      icon: root.querySelector('.icon'),
      msg: root.querySelector('.msg'),
      act: root.querySelector('.act'),
      x: root.querySelector('.x'),
    };
    els.x.addEventListener('click', () => hideToast(true));
    els.act.addEventListener('click', () => {
      if (els.act.dataset.action === 'retry') retryFailed();
    });
    (document.body || document.documentElement).appendChild(host);
    toast = els;
    return els;
  }

  function showToast() {
    ensureToast();
    updateToast();
  }

  function hideToast(immediate) {
    clearTimeout(toastTimer);
    if (!toast) return;
    toast.box.classList.add('hidden');
    if (immediate) {
      toast.host.remove();
      toast = null;
    }
  }

  function updateToast() {
    if (!toast || !state.active) return;
    const c = counts();
    const busy = state.queue.length > 0 || state.inflight > 0;
    clearTimeout(toastTimer);
    toast.box.classList.remove('hidden');
    toast.act.hidden = true;
    toast.msg.classList.remove('err');
    if (busy) {
      toast.icon.className = 'spin';
      toast.icon.textContent = '';
      const pct = c.total ? Math.floor((100 * c.done) / c.total) : 0;
      toast.msg.textContent = `Translating… ${pct}%`;
    } else if (c.failed) {
      toast.icon.className = '';
      toast.icon.textContent = '';
      toast.msg.classList.add('err');
      toast.msg.textContent = `${c.failed} paragraph${c.failed > 1 ? 's' : ''} failed: ${state.error || 'error'}`;
      toast.act.hidden = false;
      toast.act.textContent = 'Retry';
      toast.act.dataset.action = 'retry';
    } else {
      toast.icon.className = 'ok';
      toast.icon.textContent = '✓';
      toast.msg.textContent = state.mode === 'bilingual' ? 'Translated (bilingual)' : 'Translated';
      toastTimer = setTimeout(() => hideToast(false), 2200);
    }
  }

  // ---------------------------------------------------------------- messages
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('ptx:')) return false;
    if (msg.type === 'ptx:translate') return false; // meant for the background
    (async () => {
      try {
        switch (msg.type) {
          case 'ptx:status':
            break;
          case 'ptx:toggle':
            if (state.active) stop();
            else await start(msg.mode);
            break;
          case 'ptx:start':
            await start(msg.mode);
            break;
          case 'ptx:stop':
            stop();
            break;
          case 'ptx:setMode':
            settings.mode = msg.mode;
            setMode(msg.mode);
            break;
          case 'ptx:toggleMode':
            if (!state.active) await start('bilingual');
            else setMode(state.mode === 'replace' ? 'bilingual' : 'replace');
            break;
          case 'ptx:restart':
            if (state.active) {
              const m = state.mode;
              stop();
              await start(m);
            } else {
              settings = await globalThis.ptxLoadSettings();
            }
            break;
          case 'ptx:retry':
            retryFailed();
            break;
          default:
            break;
        }
      } catch (e) {
        state.error = String((e && e.message) || e);
      }
      sendResponse(status());
    })();
    return true;
  });

  // ---------------------------------------------------------------- auto-translate
  (async () => {
    settings = await globalThis.ptxLoadSettings();
    const ct = document.contentType || 'text/html';
    if (!/html|xml/i.test(ct)) return;
    if ((settings.autoSites || []).includes(location.hostname)) {
      setTimeout(() => {
        if (!state.active) start(settings.mode);
      }, 400);
    }
  })();
})();
