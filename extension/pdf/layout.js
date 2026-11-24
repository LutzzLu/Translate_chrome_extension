// PDF text layout analysis: turns PDF.js text items into paragraph blocks that
// can be translated and drawn back over the page.
//
// - lines are built from text items sharing a baseline; smaller raised/lowered
//   items become superscript/subscript atoms (citations like ¹²³, exponents,
//   chemical formulas) that are kept exactly as in the original;
// - lines are grouped into blocks (paragraphs, headings, captions) using
//   column, line spacing, indentation and font changes;
// - a document-level pass classifies blocks and skips the reference list.
import { Util } from '../lib/pdfjs/pdf.min.mjs';

const M = globalThis.PTXMarkers;
const SCRIPT_RATIO = 0.84; // a superscript is at most 84% of the line's font size
const LIST_MARK_RE = /^(?:\[\d{1,3}\]|\(?\d{1,3}[.)]|[•·▪◦‣])$/;

function pushText(toks, v) {
  if (!v) return;
  const last = toks[toks.length - 1];
  if (last && last.t === 'text') last.v += v;
  else toks.push({ t: 'text', v });
}

function scriptKind(itemBase, hostBase, hostFs) {
  const d = itemBase - hostBase;
  if (d < -0.1 * hostFs) return 'sup';
  if (d > 0.1 * hostFs) return 'sub';
  return null;
}

// ------------------------------------------------------------------ lines
function addToLine(L, it) {
  L.items.push(it);
  if (it.x < L.x1) L.x1 = it.x;
  if (it.x2 > L.x2) L.x2 = it.x2;
}

function tryAppend(L, it) {
  const ref = L.fs;
  const dy = it.base - L.base;
  const gap = it.x - L.x2;
  const similar = it.fs >= ref * SCRIPT_RATIO && it.fs * SCRIPT_RATIO <= ref;
  // A list marker ("12.", "[3]", "•") followed, on the same baseline, by the
  // item's text further right (hanging indent): same line.
  if (similar && L.items.length === 1 && LIST_MARK_RE.test(L.items[0].str.trim()) &&
      Math.abs(dy) <= 0.3 * Math.min(ref, it.fs) && gap > 0 && gap < 6 * ref) {
    addToLine(L, it);
    return true;
  }
  if (similar) {
    if (Math.abs(dy) <= 0.3 * Math.min(ref, it.fs) && gap > -0.7 * ref && gap < 1.3 * ref) {
      addToLine(L, it);
      return true;
    }
    return false;
  }
  if (it.fs < ref * SCRIPT_RATIO) {
    // smaller text right next to the line: superscript / subscript
    if (dy > -0.8 * ref && dy < 0.5 * ref && gap > -0.6 * ref && gap < 1.0 * ref) {
      it.script = scriptKind(it.base, L.base, ref);
      addToLine(L, it);
      return true;
    }
    return false;
  }
  // bigger text: the line so far may be a leading superscript (footnote mark)
  if (L.items.every((x) => x.fs < it.fs * SCRIPT_RATIO)) {
    const d = L.base - it.base;
    if (d > -0.8 * it.fs && d < 0.5 * it.fs && gap > -0.6 * it.fs && gap < 1.0 * it.fs) {
      for (const x of L.items) x.script = scriptKind(x.base, it.base, it.fs);
      L.base = it.base;
      L.fs = it.fs;
      L.asc = it.asc;
      L.desc = it.desc;
      addToLine(L, it);
      return true;
    }
  }
  return false;
}

const SCRIPTISH_RE = /^[\s\d,.;:\-–—*†‡§¶#+()[\]a-z]{1,16}$/i;

// Some PDFs draw superscripts after the rest of the line; put them back.
function mergeOrphanScripts(lines) {
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (s.items.length > 6) continue;
    const text = s.items.map((x) => x.str).join('');
    if (!SCRIPTISH_RE.test(text)) continue;
    let host = null;
    for (const h of lines) {
      if (h === s || s.fs >= h.fs * SCRIPT_RATIO) continue;
      const dy = s.base - h.base;
      if (dy > -0.8 * h.fs && dy < 0.5 * h.fs && s.x1 >= h.x1 - 0.5 * h.fs && s.x1 <= h.x2 + 0.6 * h.fs) {
        host = h;
        break;
      }
    }
    if (!host) continue;
    for (const x of s.items) {
      x.script = scriptKind(x.base, host.base, host.fs);
      addToLine(host, x);
    }
    lines.splice(i, 1);
    i--;
  }
}

function finalizeLine(L) {
  L.items.sort((a, b) => a.x - b.x);
  const toks = [];
  const fontChars = new Map();
  let chars = 0;
  let prev = null;
  for (const it of L.items) {
    if (prev) {
      const gap = it.x - prev.x2;
      const space = (prev.spaceAfter || gap > 0.18 * L.fs) && !/\s$/.test(prev.str) && !/^\s/.test(it.str);
      if (space && !it.script) pushText(toks, ' ');
    }
    if (it.script) {
      const last = toks[toks.length - 1];
      if (last && last.t === 'atom' && last.kind === it.script) last.v += it.str;
      else toks.push({ t: 'atom', kind: it.script, v: it.str });
    } else {
      pushText(toks, it.str);
      chars += it.str.length;
      fontChars.set(it.font, (fontChars.get(it.font) || 0) + it.str.length);
    }
    prev = it;
  }
  L.tokens = toks;
  L.chars = chars;
  L.font = [...fontChars.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  L.text = toks.map((t) => t.v).join('');
  L.top = L.base - L.asc * L.fs;
  L.bottom = L.base - L.desc * L.fs;
  for (const it of L.items) {
    L.top = Math.min(L.top, it.base - it.asc * it.fs);
    L.bottom = Math.max(L.bottom, it.base - it.desc * it.fs);
  }
}

function buildLines(items) {
  const lines = [];
  let L = null;
  for (const it of items) {
    if (L && tryAppend(L, it)) continue;
    if (L) lines.push(L);
    L = { items: [it], x1: it.x, x2: it.x2, base: it.base, fs: it.fs, asc: it.asc, desc: it.desc };
  }
  if (L) lines.push(L);
  mergeOrphanScripts(lines);
  for (const l of lines) finalizeLine(l);
  return lines.filter((l) => l.text.trim());
}

// ------------------------------------------------------------------ blocks
const LIST_ITEM_RE = /^\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s*\p{Lu}/u;

function newBlock(L) {
  return { lines: [L], x1: L.x1, x2: L.x2, fs: L.fs, left: L.x1, pitch: 0, font: L.font };
}

function addLineToBlock(B, L) {
  const prev = B.lines[B.lines.length - 1];
  const n = B.lines.length;
  B.pitch = (B.pitch * (n - 1) + (L.base - prev.base)) / n;
  B.left = n === 1 ? L.x1 : Math.min(B.left, L.x1);
  B.lines.push(L);
  B.x1 = Math.min(B.x1, L.x1);
  B.x2 = Math.max(B.x2, L.x2);
}

function canJoin(B, L) {
  const prev = B.lines[B.lines.length - 1];
  const fs = B.fs;
  const r = L.fs / fs;
  if (r < 0.88 || r > 1.14) return false;
  const dy = L.base - prev.base;
  if (dy < 0.45 * fs) return false; // same line again, or moved up (next column)
  const maxGap = B.lines.length >= 2 ? Math.max(B.pitch * 1.35, B.pitch + 0.25 * fs) : 1.9 * fs;
  if (dy > maxGap) return false; // paragraph spacing
  const overlap = Math.min(L.x2, B.x2) - Math.max(L.x1, B.x1);
  if (overlap < 0.3 * Math.min(L.x2 - L.x1, B.x2 - B.x1)) return false; // other column
  const left = B.lines.length >= 2 ? B.left : prev.x1;
  // Hanging indent after a numbered first line can be deep in small fonts.
  const maxIndent = B.lines.length === 1 && LIST_ITEM_RE.test(prev.text) ? 8 * fs : 4 * fs;
  if (L.x1 < left - 3 * fs || L.x1 > left + maxIndent) return false;
  // Outdented line = next item of a hanging-indent list (reference entries).
  if (B.lines.length >= 2 && L.x1 < left - 0.6 * fs) return false;
  const right = Math.max(B.x2, L.x2);
  const prevShort = prev.x2 < right - 2.5 * fs;
  // A new numbered item ("12. Smith, J." / "[12] ...") starts a new block.
  if (LIST_ITEM_RE.test(L.text) && (prevShort || /[.;:)\]]\s*$/.test(prev.text))) return false;
  if (prevShort) {
    if (L.x1 > left + 0.6 * fs) return false; // indented first line of a new paragraph
    if (B.lines.length >= 2 && /[.!?:。！？]["'”’)]?\s*$/.test(prev.text) && /^\s*\p{Lu}/u.test(L.text)) return false;
    if (B.lines.length === 1 && L.font !== prev.font) return false; // heading, then text
  }
  return true;
}

function finalizeBlock(B, pageNum, idx, pageW, pageH) {
  const toks = [];
  B.lines.forEach((L, i) => {
    if (i > 0) {
      const last = toks[toks.length - 1];
      const first = L.tokens[0];
      const lastText = last && last.t === 'text' ? last.v : '';
      const firstText = first && first.t === 'text' ? first.v : '';
      if (/\p{L}[-‐­]$/u.test(lastText) && /^\p{Ll}/u.test(firstText)) {
        last.v = lastText.slice(0, -1); // re-join a hyphenated word
      } else if (/(?:https?:\/\/|www\.)\S*[./\-_]$/i.test(lastText) && /^[\w./\-_~%?#=&]/.test(firstText)) {
        // a URL broken across lines: no space
      } else if (/\p{Script=Han}$/u.test(lastText) && /^\p{Script=Han}/u.test(firstText)) {
        // CJK: no space between lines
      } else if (!/\s$/.test(lastText)) {
        pushText(toks, ' ');
      }
    }
    for (const t of L.tokens) {
      if (t.t === 'text') pushText(toks, t.v);
      else toks.push({ ...t });
    }
  });

  const atoms = [null];
  const kinds = [null];
  let src = '';
  for (const t of toks) {
    if (t.t === 'text') {
      for (const part of M.splitUrls(t.v)) {
        if (part.url) {
          atoms.push({ t: 'atom', kind: 'url', v: part.v }); // URLs are kept verbatim
          kinds.push('atom');
          src += M.atom(atoms.length - 1);
        } else {
          src += M.escapeText(part.v);
        }
      }
    } else {
      atoms.push(t);
      kinds.push('atom');
      src += M.atom(atoms.length - 1);
    }
  }
  const text = toks
    .filter((t) => t.t === 'text')
    .map((t) => t.v)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const full = toks
    .map((t) => t.v)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    id: `${pageNum}:${idx}`,
    page: pageNum,
    x1: B.x1,
    x2: B.x2,
    top: Math.min(...B.lines.map((l) => l.top)),
    bottom: Math.max(...B.lines.map((l) => l.bottom)),
    fs: B.fs,
    pitch: B.pitch || B.fs * 1.2,
    nLines: B.lines.length,
    font: B.font,
    chars: B.lines.reduce((n, l) => n + l.chars, 0),
    src: src.replace(/\s+/g, ' ').trim(),
    kinds,
    atoms,
    text,
    full,
    pageW,
    pageH,
    kind: 'other',
    translate: false,
    tokens: null,
    failed: false,
    el: null,
    bg: null,
    fg: null,
  };
}

/**
 * Analyse one page.
 * @param textContent result of page.getTextContent()
 * @param viewport    page.getViewport({scale: 1})
 */
export function extractBlocks(textContent, viewport, pageNum) {
  const styles = textContent.styles || {};
  const items = [];
  for (const it of textContent.items) {
    if (typeof it.str !== 'string') continue;
    if (!it.str.trim()) {
      // Explicit space item: some PDFs (tight titles) rely on these, not on gaps.
      if (it.str.length && items.length) items[items.length - 1].spaceAfter = true;
      continue;
    }
    if (it.dir === 'ttb') continue;
    const tx = Util.transform(viewport.transform, it.transform);
    const fs = Math.hypot(tx[2], tx[3]);
    if (!(fs > 1) || tx[0] <= 0) continue;
    if (Math.abs(tx[1]) > fs * 0.02 || Math.abs(tx[2]) > fs * 0.02) continue; // rotated text
    const st = styles[it.fontName] || {};
    let asc = typeof st.ascent === 'number' ? st.ascent : 0.8;
    let desc = typeof st.descent === 'number' ? st.descent : -0.2;
    if (!(asc > 0.3 && asc < 1.3)) asc = 0.8;
    if (!(desc < 0 && desc > -0.6)) desc = -0.2;
    const w = Math.abs(it.width) * viewport.scale;
    items.push({ str: it.str, x: tx[4], base: tx[5], fs, w, x2: tx[4] + w, font: it.fontName, asc, desc, script: null });
  }
  const lines = buildLines(items);
  const blocks = [];
  let B = null;
  for (const L of lines) {
    if (B && canJoin(B, L)) addLineToBlock(B, L);
    else {
      if (B) blocks.push(B);
      B = newBlock(L);
    }
  }
  if (B) blocks.push(B);
  return blocks.map((b, i) => finalizeBlock(b, pageNum, i, viewport.width, viewport.height));
}

// ------------------------------------------------------------------ classification
const REF_HEADING_RE =
  /^\s*(?:\d+\.?\s*)?(?:references?(?:\s+and\s+notes)?|notes\s+and\s+references|bibliography|literature\s+cited|works\s+cited|cited\s+literature|reference\s+list)\s*$/i;
const REF_ENTRY_RES = [
  /^\s*(?:\[\d{1,3}\]|\d{1,3}\.)\s+\p{Lu}[\p{L}'’-]+,?\s+(?:\p{Lu}\.|\p{Lu}\p{Ll}+)/u, // "1. Thompson, M. C." / "[3] Smith J"
  /^\s*\d{1,3}\.\s+(?:\p{Lu}\.\s*-?){1,3}\s*\p{Lu}[\p{L}'’-]+/u, // "1. J. Jumper, ..." (Science)
  /^\s*\p{Lu}[\p{L}'’-]+,\s+(?:\p{Lu}\.\s*-?){1,3}(?:,|\s+and\s|\s*&|\s*et\s+al)/u, // "Abadi, M., ..." / "Mitchell, A. L. et al."
];
const looksLikeReference = (t) => /\b(?:19|20)\d{2}\b/.test(t) && REF_ENTRY_RES.some((re) => re.test(t));
// Number of "12. Surname, X." style entries inside a block (several merged references).
const REF_IN_TEXT_RE = /(?:^|[\s.;)])\[?\d{1,3}[.\]]\s*\p{Lu}[\p{L}'’-]+,?\s+(?:\p{Lu}\.|et\s+al)/gu;
const refEntryCount = (t) => (t.match(REF_IN_TEXT_RE) || []).length;
const CAPTION_RE = /^\s*(?:fig(?:ure)?s?\.?|extended\s+data\s+fig|supplementary\s+fig|table)\b/i;
const INSTITUTION_RE =
  /\b(?:Universit(?:y|ät|é|à|at|y's)|Institut(?:e|o|es)?|Department|Dept\.|School|College|Laborator(?:y|ies)|Center|Centre|Hospital|Academy|Faculty|Division|Inc\.|Ltd\.?|GmbH|DeepMind|Clinic)\b/g;

function looksLikeAffiliations(b) {
  if (/\be-?mail\s*:/i.test(b.text) && b.nLines <= 3) return true;
  const inst = (b.text.match(INSTITUTION_RE) || []).length;
  return inst >= 2 && (b.atoms.length > 1 || /^\s*\d/.test(b.full) || inst >= 3);
}

function looksLikeAuthorList(b) {
  if (b.page > 2) return false;
  const words = b.text.match(/\p{L}[\p{L}'’.-]*/gu) || [];
  const nameish = words.filter(
    (w) => /^\p{Lu}/u.test(w) || /^(?:and|de|del|van|von|der|den|da|di|du|le|la|y)$/i.test(w)
  ).length;
  // "John Jumper¹,⁴": a short capitalised name carrying affiliation superscripts
  if (words.length >= 2 && words.length <= 5 && nameish === words.length && b.atoms.length > 1) return true;
  if (words.length < 4) return false;
  const commas = (b.text.match(/,/g) || []).length;
  return nameish / words.length >= 0.8 && (commas >= 2 || b.atoms.length > 2) && !/[.!?]\s+\p{Ll}/u.test(b.text);
}

/** Decide which blocks are translated. `pages` is an array of {blocks}. */
export function classifyDocument(pages) {
  const fsWeight = new Map();
  const fontWeight = new Map();
  for (const p of pages) {
    for (const b of p.blocks) {
      const k = Math.round(b.fs * 4) / 4;
      fsWeight.set(k, (fsWeight.get(k) || 0) + b.chars);
      fontWeight.set(b.font, (fontWeight.get(b.font) || 0) + b.chars);
    }
  }
  const bodyFs = [...fsWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const bodyFont = [...fontWeight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  // Reference lists: a "References" heading, or (Nature-style, no heading)
  // two reference entries in a row, switch on "reference mode" until a
  // heading, a figure caption or a change of font size.
  let inRefs = false;
  let refFs = 0;
  let entryRun = 0;
  for (const p of pages) {
    for (const b of p.blocks) {
      const words = (b.text.match(/\p{L}{2,}/gu) || []).length;
      const letters = (b.text.match(/\p{L}/gu) || []).length;
      const ratio = letters / Math.max(1, b.full.length);
      const short = b.nLines <= 2 && words <= 14 && !/[.;,]$/.test(b.text);
      const big = b.fs >= bodyFs * 1.08;
      const distinctFont = b.font !== bodyFont && b.nLines === 1 && /^[\p{Lu}\d]/u.test(b.text);
      const headingLike = short && words >= 1 && (big || distinctFont);
      const caption = CAPTION_RE.test(b.text);
      const margin = b.nLines === 1 && (b.bottom < b.pageH * 0.06 || b.top > b.pageH * 0.94);
      b.kind = 'other';
      b.translate = false;

      if (REF_HEADING_RE.test(b.text)) {
        inRefs = true;
        refFs = 0;
        entryRun = 0;
        b.kind = 'heading';
        b.translate = true;
        continue;
      }
      if (looksLikeReference(b.full) || refEntryCount(b.full) >= 2) {
        b.kind = 'ref';
        if (++entryRun >= 2) inRefs = true;
        if (!refFs) refFs = b.fs;
        continue;
      }
      if (words === 0) {
        // stray numbers/symbols (e.g. a reference number on its own) keep the current state
        if (inRefs) b.kind = 'ref';
        continue;
      }
      entryRun = 0;
      if (inRefs) {
        const biggerHeading = headingLike && !LIST_ITEM_RE.test(b.text) && (big || (refFs && b.fs > refFs * 1.08));
        const ends = biggerHeading || caption || (refFs && Math.abs(b.fs - refFs) > 0.08 * refFs);
        if (!ends) {
          b.kind = 'ref';
          continue;
        }
        inRefs = false;
        refFs = 0;
      }
      if (margin) {
        b.kind = 'margin';
        continue;
      }
      if (looksLikeAffiliations(b) || looksLikeAuthorList(b)) {
        b.kind = 'meta'; // authors / affiliations stay in the original language
        continue;
      }
      if (headingLike && letters >= 3) {
        b.kind = 'heading';
        b.translate = true;
        continue;
      }
      if (b.fs < bodyFs * 0.9 && b.nLines <= 3 && words < 12 && !caption) {
        b.kind = 'label'; // text inside figures: part of the graphic
        continue;
      }
      if (words >= 3 && letters >= 12 && ratio > 0.45) {
        b.kind = 'para';
        b.translate = true;
      }
    }
  }
  return { bodyFs, bodyFont };
}
