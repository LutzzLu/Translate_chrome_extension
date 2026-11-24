// Paper Translator: PDF viewer with translation.
//
// Chrome's built-in PDF viewer cannot be modified by extensions, so PDFs are
// opened here (PDF.js). Pages are rendered to canvas; translated paragraphs
// are drawn on top of the original ones ("Translated" view), or the original
// and translated pages are shown next to each other ("Side by side").
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { translateTexts } from '../lib/engine.js';
import { extractBlocks, classifyDocument } from './layout.js';

const M = globalThis.PTXMarkers;
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.mjs');

const LAYOUT_SCALE = 2; // overlay text is laid out at 2x, then CSS-scaled
const MAX_INFLIGHT = 3;
const BATCH_CHARS = 3500;
const BATCH_ITEMS = 40;
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;

const $ = (id) => document.getElementById(id);
const els = {
  viewer: $('viewer'),
  pages: $('pages'),
  drop: $('drop'),
  message: $('message'),
  messageText: $('messageText'),
  messageActions: $('messageActions'),
  measure: $('measure'),
  docTitle: $('docTitle'),
  pageInfo: $('pageInfo'),
  zoomLabel: $('zoomLabel'),
  progress: $('progress'),
  origLink: $('origLink'),
  fileInput: $('fileInput'),
  langSelect: $('langSelect'),
};

const state = {
  settings: { ...globalThis.PTX_DEFAULTS },
  tabId: null,
  doc: null,
  pages: [],
  scale: 1,
  fitWidth: true,
  view: 'original',
  tl: 'zh-CN',
  analysis: null,
  analyzed: false,
  started: false,
  generation: 0,
  queue: [],
  inflight: 0,
  error: null,
  io: null,
  laidOut: false,
};
globalThis.__ptxViewer = state; // read-only hook for debugging from DevTools

// ------------------------------------------------------------------ messages
function showMessage(text, actions = []) {
  els.messageText.textContent = text;
  els.messageActions.replaceChildren();
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = a.primary ? 'primary' : 'secondary';
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    els.messageActions.appendChild(b);
  }
  els.message.hidden = false;
}
const hideMessage = () => {
  els.message.hidden = true;
};
const showDrop = (on) => {
  els.drop.hidden = !on;
};

// ------------------------------------------------------------------ loading
function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return last || u.hostname;
  } catch (e) {
    return 'document.pdf';
  }
}

function looksLikePdf(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes('%PDF');
}

async function openUrl(url, autoTranslate) {
  els.origLink.href = url;
  els.origLink.hidden = false;
  showMessage('Loading PDF…');
  let bytes;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`the server returned HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    if (url.startsWith('file:')) {
      showMessage(
        'Chrome blocked access to this local file.\n\nTo translate PDFs from your computer, open the extension settings and turn on “Allow access to file URLs”, then reload this tab. Or use “Choose a PDF file”.',
        [
          {
            label: 'Open extension settings',
            primary: true,
            onClick: () => chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` }),
          },
          { label: 'Choose a PDF file', onClick: () => els.fileInput.click() },
        ]
      );
    } else {
      showMessage(`Could not download the PDF (${e.message}).`, [
        { label: 'Try again', primary: true, onClick: () => openUrl(url, autoTranslate) },
        { label: 'Choose a PDF file', onClick: () => els.fileInput.click() },
      ]);
    }
    return;
  }
  if (!looksLikePdf(bytes)) {
    showMessage(
      'This link did not return a PDF file. The site may need you to be signed in, or it showed a web page instead.\n\nDownload the PDF, then open it here with “Choose a PDF file”.',
      [{ label: 'Choose a PDF file', primary: true, onClick: () => els.fileInput.click() }]
    );
    return;
  }
  await openData(bytes, fileNameFromUrl(url), autoTranslate);
}

async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  els.origLink.hidden = true;
  history.replaceState(null, '', location.pathname);
  await openData(bytes, file.name, true);
}

function resetDocument() {
  state.generation++;
  state.started = false;
  state.analyzed = false;
  state.analysis = null;
  state.queue = [];
  state.error = null;
  if (state.io) state.io.disconnect();
  for (const p of state.pages) {
    try {
      p.proxy.cleanup();
    } catch (e) {
      /* ignore */
    }
  }
  if (state.doc) state.doc.destroy();
  state.doc = null;
  state.pages = [];
  state.laidOut = false;
  els.pages.replaceChildren();
  updateProgress();
}

async function openData(bytes, name, autoTranslate) {
  resetDocument();
  showDrop(false);
  showMessage('Opening PDF…');
  let doc;
  try {
    doc = await pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: chrome.runtime.getURL('lib/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: chrome.runtime.getURL('lib/pdfjs/standard_fonts/'),
      wasmUrl: chrome.runtime.getURL('lib/pdfjs/wasm/'),
      iccUrl: chrome.runtime.getURL('lib/pdfjs/iccs/'),
    }).promise;
  } catch (e) {
    showMessage(`Could not open this PDF: ${e.message}`, [
      { label: 'Choose another file', primary: true, onClick: () => els.fileInput.click() },
    ]);
    return;
  }
  state.doc = doc;
  let title = name;
  try {
    const meta = await doc.getMetadata();
    const t = meta && meta.info && meta.info.Title;
    if (t && t.trim().length > 3 && !/^untitled|\.(docx?|tex|indd)$/i.test(t.trim())) title = t.trim();
  } catch (e) {
    /* ignore */
  }
  els.docTitle.textContent = title;
  els.docTitle.title = title;
  document.title = title;

  for (let i = 1; i <= doc.numPages; i++) {
    const proxy = await doc.getPage(i);
    state.pages.push(makePage(i, proxy, proxy.getViewport({ scale: 1 })));
  }
  hideMessage();
  state.fitWidth = true;
  setView(autoTranslate ? (state.settings.mode === 'bilingual' ? 'side' : 'translated') : 'original', true);
  observePages();
  state.analysis = analyze(state.generation);
  if (state.view !== 'original') startTranslation();
}

function makePage(num, proxy, vp) {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.page = String(num);
  const orig = document.createElement('div');
  orig.className = 'pg orig';
  const canvas = document.createElement('canvas');
  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  orig.append(canvas, textLayer);
  const tr = document.createElement('div');
  tr.className = 'pg tr';
  const canvas2 = document.createElement('canvas');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  tr.append(canvas2, overlay);
  row.append(orig, tr);
  els.pages.appendChild(row);
  return {
    num,
    proxy,
    w: vp.width,
    h: vp.height,
    row,
    orig,
    tr,
    canvas,
    canvas2,
    textLayer,
    overlay,
    visible: false,
    renderedScale: 0,
    renderedDpr: 0,
    task: null,
    copied: false,
    textContent: null,
    blocks: null,
    colored: false,
  };
}

// ------------------------------------------------------------------ analysis
async function analyze(gen) {
  for (const p of state.pages) {
    if (gen !== state.generation) return;
    try {
      if (!p.textContent) p.textContent = await p.proxy.getTextContent();
      p.blocks = extractBlocks(p.textContent, p.proxy.getViewport({ scale: 1 }), p.num);
    } catch (e) {
      p.blocks = [];
    }
    if (state.started && p.num % 4 === 0) updateProgress(`Analyzing ${p.num}/${state.pages.length}…`);
  }
  if (gen !== state.generation) return;
  classifyDocument(state.pages);
  state.analyzed = true;
  for (const p of state.pages) if (p.renderedScale && !p.colored) colorBlocks(p);
}

// ------------------------------------------------------------------ translation
function currentPageNum() {
  const top = els.viewer.scrollTop + els.viewer.clientHeight * 0.3;
  for (const p of state.pages) {
    if (p.row.offsetTop + p.row.offsetHeight > top) return p.num;
  }
  return state.pages.length || 1;
}

async function startTranslation() {
  if (state.started || !state.doc) return;
  state.started = true;
  const gen = state.generation;
  updateProgress('Analyzing…');
  await state.analysis;
  if (gen !== state.generation) return;
  state.queue = [];
  for (const p of state.pages) {
    for (const b of p.blocks) {
      if (!b.translate || b.tokens) continue;
      const fixed = b.kinds.length === 1 && globalThis.ptxGlossary ? globalThis.ptxGlossary(b.src, state.tl) : null;
      if (fixed) b.tokens = [{ t: 'text', v: fixed }];
      else state.queue.push(b);
    }
    if (p.colored) syncOverlay(p);
  }
  if (!state.queue.length && !countBlocks().total) {
    updateProgress('No text to translate');
    showMessage(
      'This PDF has no selectable text (it is probably a scanned image), so there is nothing to translate.',
      [{ label: 'OK', primary: true, onClick: hideMessage }]
    );
    return;
  }
  pump();
}

function pump() {
  const gen = state.generation;
  while (state.inflight < MAX_INFLIGHT && state.queue.length) {
    const cur = currentPageNum();
    const dist = (n) => (n >= cur ? n - cur : (cur - n) * 1.5 + 0.5);
    state.queue.sort((a, b) => dist(a.page) - dist(b.page));
    const batch = [];
    let chars = 0;
    while (state.queue.length && batch.length < BATCH_ITEMS) {
      const b = state.queue[0];
      if (batch.length && chars + b.src.length > BATCH_CHARS) break;
      state.queue.shift();
      batch.push(b);
      chars += b.src.length;
    }
    state.inflight++;
    translateTexts(
      batch.map((b) => b.src),
      { sl: 'auto', tl: state.tl }
    )
      .then(({ translations, error }) => {
        if (gen !== state.generation) return;
        batch.forEach((b, i) => {
          const tr = translations[i];
          if (typeof tr !== 'string') {
            b.failed = true;
            state.error = error || 'Translation failed';
            return;
          }
          const res = M.parse(M.prepare(tr, state.tl), b.kinds, { repair: true });
          b.tokens = res.tokens;
          b.failed = false;
          const p = state.pages[b.page - 1];
          if (p && p.colored) syncOverlay(p);
        });
      })
      .catch((e) => {
        if (gen !== state.generation) return;
        for (const b of batch) b.failed = true;
        state.error = (e && e.message) || String(e);
      })
      .finally(() => {
        if (gen !== state.generation) return;
        state.inflight--;
        updateProgress();
        pump();
      });
  }
  updateProgress();
}

function countBlocks() {
  let total = 0;
  let done = 0;
  let failed = 0;
  for (const p of state.pages) {
    if (!p.blocks) continue;
    for (const b of p.blocks) {
      if (!b.translate) continue;
      total++;
      if (b.tokens) done++;
      else if (b.failed) failed++;
    }
  }
  return { total, done, failed };
}

function updateProgress(text) {
  const el = els.progress;
  el.classList.remove('ok', 'err');
  el.title = '';
  if (text) {
    el.textContent = text;
    return;
  }
  if (!state.started) {
    el.textContent = '';
    return;
  }
  const c = countBlocks();
  if (state.queue.length || state.inflight) {
    el.textContent = `Translating ${c.done}/${c.total}`;
  } else if (c.failed) {
    el.textContent = `${c.failed} failed · Retry`;
    el.title = state.error || '';
    el.classList.add('err');
  } else if (c.total) {
    el.textContent = '✓ Translated';
    el.classList.add('ok');
  }
}

function retryFailed() {
  for (const p of state.pages) {
    for (const b of p.blocks || []) {
      if (b.translate && b.failed && !b.tokens) {
        b.failed = false;
        state.queue.push(b);
      }
    }
  }
  state.error = null;
  pump();
}

function retranslate() {
  state.generation++;
  state.started = false;
  state.queue = [];
  state.inflight = 0;
  state.error = null;
  for (const p of state.pages) {
    p.overlay.replaceChildren();
    for (const b of p.blocks || []) {
      b.tokens = null;
      b.failed = false;
      b.el = null;
    }
  }
  updateProgress();
  if (state.view !== 'original') startTranslation();
}

// ------------------------------------------------------------------ overlay
function sampleColors(img, b, k) {
  const { width: W, height: H, data } = img;
  const get = (x, y) => {
    const xi = Math.min(W - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(H - 1, Math.max(0, Math.round(y)));
    const i = (yi * W + xi) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const pad = 0.35 * b.fs;
  const X1 = (b.x1 - pad) * k;
  const X2 = (b.x2 + pad) * k;
  const Y1 = (b.top - pad * 0.5) * k;
  const Y2 = (b.bottom + pad * 0.5) * k;
  const border = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    border.push(get(X1 + (X2 - X1) * t, Y1), get(X1 + (X2 - X1) * t, Y2));
  }
  for (let i = 1; i < 12; i++) {
    const t = i / 12;
    border.push(get(X1, Y1 + (Y2 - Y1) * t), get(X2, Y1 + (Y2 - Y1) * t));
  }
  const bins = new Map();
  for (const c of border) {
    const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
    const e = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += c[0];
    e.g += c[1];
    e.b += c[2];
    bins.set(key, e);
  }
  const top = [...bins.values()].sort((a, c) => c.n - a.n)[0];
  const bg = [top.r / top.n, top.g / top.n, top.b / top.n].map(Math.round);

  const ink = [];
  const x1 = b.x1 * k;
  const x2 = b.x2 * k;
  const y1 = b.top * k;
  const y2 = b.bottom * k;
  const step = Math.max(1, Math.sqrt(((x2 - x1) * (y2 - y1)) / 6000));
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const c = get(x, y);
      const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (d > 120) ink.push([d, c]);
    }
  }
  let fg;
  if (ink.length) {
    ink.sort((a, c) => c[0] - a[0]);
    const n = Math.max(1, Math.floor(ink.length * 0.3));
    const s = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) s[j] += ink[i][1][j];
    fg = s.map((v) => Math.round(v / n));
  } else {
    const lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
    fg = lum > 128 ? [0, 0, 0] : [255, 255, 255];
  }
  return { bg: `rgb(${bg.join(',')})`, fg: `rgb(${fg.join(',')})` };
}

function colorBlocks(p) {
  if (!p.blocks || !p.renderedScale || !p.canvas.width) return;
  let img;
  try {
    img = p.canvas.getContext('2d').getImageData(0, 0, p.canvas.width, p.canvas.height);
  } catch (e) {
    return;
  }
  const k = p.canvas.width / p.w;
  for (const b of p.blocks) {
    if (b.translate && !b.bg) Object.assign(b, sampleColors(img, b, k));
  }
  p.colored = true;
  syncOverlay(p);
}

// URLs may break anywhere, so a long link doesn't leave a stretched,
// half-empty justified line before it.
const URL_RE = /(?:https?:\/\/|www\.|doi\.org\/)\S+/gi;
function appendTextWithUrls(el, text) {
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
    const s = document.createElement('span');
    s.className = 'url';
    s.textContent = m[0];
    el.appendChild(s);
    last = m.index + m[0].length;
  }
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function buildBlockEl(b) {
  const S = LAYOUT_SCALE;
  const el = document.createElement('div');
  el.className = b.kind === 'heading' ? 'tb h' : 'tb';
  el.lang = state.tl;
  const padX = 0.25 * b.fs;
  const padY = 0.12 * b.fs;
  const width = b.x2 - b.x1 + 2 * padX;
  const height = b.bottom - b.top + 2 * padY;
  Object.assign(el.style, {
    left: `${(b.x1 - padX) * S}px`,
    top: `${(b.top - padY) * S}px`,
    width: `${width * S}px`,
    padding: `${padY * S}px ${padX * S}px`,
    background: b.bg,
    color: b.fg,
    lineHeight: String(b.nLines > 1 ? Math.min(1.75, Math.max(1.15, b.pitch / b.fs)) : 1.2),
    textAlign: b.nLines > 2 && b.kind === 'para' ? 'justify' : 'left',
  });
  for (const t of b.tokens) {
    if (t.t === 'text') appendTextWithUrls(el, t.v);
    else if (t.t === 'atom') {
      const a = b.atoms[t.k];
      const s = document.createElement(a.kind === 'sub' ? 'sub' : a.kind === 'sup' ? 'sup' : 'span');
      if (a.kind === 'url') s.className = 'url';
      s.textContent = a.v;
      el.appendChild(s);
    }
  }
  // Shrink the font until the translation fits in the original paragraph box.
  const boxH = height * S;
  els.measure.appendChild(el);
  el.style.height = 'auto';
  const fits = (f) => {
    el.style.fontSize = `${b.fs * S * f}px`;
    return el.offsetHeight <= boxH + 0.5;
  };
  if (!fits(1)) {
    let lo = 0.4;
    let hi = 1;
    let best = lo;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) {
        best = mid;
        lo = mid;
      } else hi = mid;
    }
    fits(best);
  }
  if (el.offsetHeight > boxH + 0.5) {
    el.style.minHeight = `${boxH}px`;
    el.classList.add('overflow');
  } else {
    el.style.height = `${boxH}px`;
  }
  el.remove();
  return el;
}

function syncOverlay(p) {
  if (!p.blocks || !p.colored) return;
  for (const b of p.blocks) {
    if (b.tokens && !b.el && b.bg) {
      b.el = buildBlockEl(b);
      p.overlay.appendChild(b.el);
    }
  }
}

// ------------------------------------------------------------------ rendering
function needsTranslatedCanvas() {
  return state.view === 'translated' || state.view === 'side';
}

function ensureCopy(p) {
  if (p.copied || !p.renderedScale || !needsTranslatedCanvas()) return;
  p.canvas2.width = p.canvas.width;
  p.canvas2.height = p.canvas.height;
  p.canvas2.getContext('2d').drawImage(p.canvas, 0, 0);
  p.copied = true;
}

async function renderTextLayer(p) {
  try {
    if (!p.textContent) p.textContent = await p.proxy.getTextContent();
    p.textLayer.replaceChildren();
    const layer = new pdfjsLib.TextLayer({
      textContentSource: p.textContent,
      container: p.textLayer,
      viewport: p.proxy.getViewport({ scale: state.scale }),
    });
    await layer.render();
  } catch (e) {
    /* text selection is a nice-to-have */
  }
}

async function renderPage(p) {
  const scale = state.scale;
  const dpr = window.devicePixelRatio || 1;
  if (p.renderedScale === scale && p.renderedDpr === dpr) {
    ensureCopy(p);
    return;
  }
  if (p.task) {
    try {
      p.task.cancel();
    } catch (e) {
      /* ignore */
    }
  }
  const vp = p.proxy.getViewport({ scale: scale * dpr });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const task = p.proxy.render({ canvas, viewport: vp });
  p.task = task;
  try {
    await task.promise;
  } catch (e) {
    return; // cancelled or failed
  }
  if (p.task !== task) return;
  p.task = null;
  if (!p.visible) return;
  p.orig.replaceChild(canvas, p.canvas);
  p.canvas = canvas;
  p.renderedScale = scale;
  p.renderedDpr = dpr;
  p.copied = false;
  ensureCopy(p);
  if (p.blocks && state.analyzed && !p.colored) colorBlocks(p);
  await renderTextLayer(p);
}

function releasePage(p) {
  if (p.task) {
    try {
      p.task.cancel();
    } catch (e) {
      /* ignore */
    }
    p.task = null;
  }
  if (!p.renderedScale) return;
  p.canvas.width = 0;
  p.canvas.height = 0;
  p.canvas2.width = 0;
  p.canvas2.height = 0;
  p.textLayer.replaceChildren();
  p.renderedScale = 0;
  p.copied = false;
}

function observePages() {
  if (state.io) state.io.disconnect();
  state.io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = state.pages[Number(e.target.dataset.page) - 1];
        if (!p) continue;
        p.visible = e.isIntersecting;
        if (p.visible) renderPage(p);
        else releasePage(p);
      }
    },
    { root: els.viewer, rootMargin: '1200px 0px' }
  );
  for (const p of state.pages) state.io.observe(p.row);
}

let renderTimer = 0;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    for (const p of state.pages) if (p.visible) renderPage(p);
  }, 80);
}

// ------------------------------------------------------------------ zoom & views
function fitScale() {
  if (!state.pages.length) return 1;
  const maxW = Math.max(...state.pages.map((p) => p.w));
  const avail = els.viewer.clientWidth - 32 - 16;
  const s = state.view === 'side' ? (avail - 16) / (2 * maxW) : Math.min(avail / maxW, 1.8);
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function applyScale() {
  const s = state.scale;
  for (const p of state.pages) {
    const w = `${Math.floor(p.w * s)}px`;
    const h = `${Math.floor(p.h * s)}px`;
    for (const box of [p.orig, p.tr]) {
      box.style.width = w;
      box.style.height = h;
    }
    p.orig.style.setProperty('--total-scale-factor', String(s));
    p.overlay.style.width = `${p.w * LAYOUT_SCALE}px`;
    p.overlay.style.height = `${p.h * LAYOUT_SCALE}px`;
    p.overlay.style.transform = `scale(${s / LAYOUT_SCALE})`;
  }
  els.zoomLabel.textContent = `${Math.round(s * 100)}%`;
  scheduleRender();
}

function setScale(s, keepFit = false) {
  const v = els.viewer;
  const first = !state.laidOut; // pages have no size yet: start at the top
  const rel = v.scrollHeight ? (v.scrollTop + v.clientHeight / 2) / v.scrollHeight : 0;
  state.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  state.fitWidth = keepFit;
  applyScale();
  if (first) {
    v.scrollTop = 0;
    state.laidOut = true;
  } else {
    v.scrollTop = rel * v.scrollHeight - v.clientHeight / 2;
  }
}

function setView(view, initial = false) {
  state.view = view;
  document.body.classList.remove('view-original', 'view-translated', 'view-side');
  document.body.classList.add(`view-${view}`);
  for (const b of document.querySelectorAll('#viewSeg button')) b.classList.toggle('on', b.dataset.view === view);
  if (state.fitWidth || !state.laidOut) setScale(state.fitWidth ? fitScale() : state.scale, state.fitWidth);
  else if (initial) applyScale();
  for (const p of state.pages) ensureCopy(p);
  if (view !== 'original' && state.doc && !initial) startTranslation();
}

function updatePageInfo() {
  if (!state.pages.length) {
    els.pageInfo.textContent = '';
    return;
  }
  els.pageInfo.textContent = `${currentPageNum()} / ${state.pages.length}`;
}

// ------------------------------------------------------------------ UI wiring
function bindUI() {
  for (const [code, name] of globalThis.PTX_LANGUAGES) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = name;
    els.langSelect.appendChild(o);
  }
  els.langSelect.value = state.tl;
  els.langSelect.addEventListener('change', async () => {
    state.tl = els.langSelect.value;
    await chrome.storage.sync.set({ targetLang: state.tl });
    retranslate();
  });

  for (const b of document.querySelectorAll('#viewSeg button')) {
    b.addEventListener('click', () => {
      setView(b.dataset.view);
      if (b.dataset.view !== 'original') {
        const mode = b.dataset.view === 'side' ? 'bilingual' : 'replace';
        state.settings.mode = mode;
        chrome.storage.sync.set({ mode });
      }
    });
  }

  $('openBtn').addEventListener('click', () => els.fileInput.click());
  $('chooseBtn').addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const f = els.fileInput.files && els.fileInput.files[0];
    if (f) openFile(f);
    els.fileInput.value = '';
  });
  els.progress.addEventListener('click', () => {
    if (els.progress.classList.contains('err')) retryFailed();
  });

  $('zoomIn').addEventListener('click', () => setScale(state.scale * 1.15));
  $('zoomOut').addEventListener('click', () => setScale(state.scale / 1.15));
  els.zoomLabel.addEventListener('click', () => setScale(fitScale(), true));

  els.viewer.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey) || !state.doc) return;
      e.preventDefault();
      setScale(state.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    },
    { passive: false }
  );
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || !state.doc) return;
    if (e.key === '+' || e.key === '=') setScale(state.scale * 1.15);
    else if (e.key === '-') setScale(state.scale / 1.15);
    else if (e.key === '0') setScale(fitScale(), true);
    else return;
    e.preventDefault();
  });

  let scrollRaf = 0;
  els.viewer.addEventListener('scroll', () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      updatePageInfo();
    });
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.fitWidth) setScale(fitScale(), true);
      else scheduleRender();
    }, 150);
  });

  // Drag & drop a PDF anywhere.
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    els.drop.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => els.drop.classList.remove('dragging'));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    els.drop.classList.remove('dragging');
    const f = [...(e.dataTransfer ? e.dataTransfer.files : [])].find(
      (x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name)
    );
    if (f) openFile(f);
  });

  // Commands from the toolbar popup / keyboard shortcut.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'ptx:viewer' || msg.tabId == null || msg.tabId !== state.tabId) return false;
    sendResponse({ viewer: true, view: state.view });
    if (msg.action === 'ptx:ping') return false;
    const translatedView = () => (state.settings.mode === 'bilingual' ? 'side' : 'translated');
    if (msg.action === 'ptx:toggle') setView(state.view === 'original' ? translatedView() : 'original');
    else if (msg.action === 'ptx:toggleMode') setView(state.view === 'side' ? 'translated' : 'side');
    else if (msg.action === 'ptx:setMode') {
      state.settings.mode = msg.mode;
      if (state.view !== 'original') setView(translatedView());
    } else if (msg.action === 'ptx:restart') {
      globalThis.ptxLoadSettings().then((s) => {
        state.settings = s;
        if (s.targetLang !== state.tl) {
          state.tl = s.targetLang;
          els.langSelect.value = state.tl;
          retranslate();
        }
      });
    }
  });
}

async function init() {
  state.settings = await globalThis.ptxLoadSettings();
  state.tl = state.settings.targetLang;
  bindUI();
  try {
    const t = await chrome.tabs.getCurrent();
    state.tabId = t ? t.id : null;
  } catch (e) {
    /* ignore */
  }
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  if (file) await openUrl(file, params.get('translate') === '1');
  else showDrop(true);
}

init();
