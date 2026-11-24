// Placeholder markers used to keep citations / formatting out of the text that
// is sent to the translation engine.
//
//   ⟦3⟧            atom: an element kept exactly as-is (citation, superscript,
//                  math, code...). It is moved back to where ⟦3⟧ ends up.
//   ⟦4⟧ text ⟦/4⟧  pair: an inline element (italic, link...) whose text is
//                  translated in context; the element is re-wrapped around it.
//
// Google Translate keeps these tokens intact and next to the word they belong
// to (tested on full Nature articles), unlike real HTML tags, which it tends
// to drop or move.
//
// Classic script: assigns globalThis.PTXMarkers.
(() => {
  const OPEN = '⟦'; // ⟦
  const CLOSE = '⟧'; // ⟧
  const TOKEN_RE = /⟦\s*(\/?)\s*(\d{1,4})\s*⟧/g;
  const STRAY_RE = /[⟦⟧]/g;

  const CJK_CLASS =
    '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303F\\uFF00-\\uFFEF';
  const SPACE_BEFORE_MARK = new RegExp(`([${CJK_CLASS}])[ \\t\\u00A0]+(?=\\u27E6)`, 'gu');
  const SPACE_AFTER_MARK = new RegExp(`(\\u27E7)[ \\t\\u00A0]+(?=[${CJK_CLASS}])`, 'gu');

  // A run of atom markers wrapped in full-width brackets, e.g. "（⟦1⟧，⟦2⟧）".
  // Google converts "(1, 2)"-style citation brackets to full-width punctuation;
  // we put the original ASCII punctuation back so citations look unchanged.
  const MARK = '\\u27E6\\d+\\u27E7';
  const SEP = '\\s*[，,、；;–—\\-]\\s*';
  const CLUSTER = `\\s*${MARK}(?:${SEP}${MARK})*\\s*`;
  const PAREN_CLUSTER = new RegExp(`（(${CLUSTER})）`, 'g');
  const BRACKET_CLUSTER = new RegExp(`[【［\\[](${CLUSTER})[】］\\]]`, 'g');

  const atom = (k) => `${OPEN}${k}${CLOSE}`;
  const open = (k) => `${OPEN}${k}${CLOSE}`;
  const close = (k) => `${OPEN}/${k}${CLOSE}`;

  // Keep marker characters that happen to be in the source text from being
  // mistaken for markers.
  const escapeText = (s) => s.replace(STRAY_RE, (c) => (c === OPEN ? '[' : ']'));

  function asciiSeparators(inner) {
    return inner
      .replace(/\s*[，、]\s*/g, ', ')
      .replace(/\s*；\s*/g, '; ')
      .trim();
  }

  // Clean up the raw translation before parsing.
  function prepare(str, targetLang) {
    let s = String(str ?? '');
    s = s.replace(PAREN_CLUSTER, (_, inner) => `(${asciiSeparators(inner)})`);
    s = s.replace(BRACKET_CLUSTER, (_, inner) => `[${asciiSeparators(inner)}]`);
    if (/^(zh|ja|ko)/i.test(targetLang || '')) {
      s = s.replace(SPACE_BEFORE_MARK, '$1').replace(SPACE_AFTER_MARK, '$1');
    }
    return s;
  }

  function pushText(tokens, v) {
    v = v.replace(STRAY_RE, '');
    if (!v) return;
    const last = tokens[tokens.length - 1];
    if (last && last.t === 'text') last.v += v;
    else tokens.push({ t: 'text', v });
  }

  // Parse a translated string. `kinds[k]` is 'atom' or 'pair' for marker k
  // (index 0 unused). Returns {ok, tokens}. With {repair:true} a usable token
  // list is always returned: unknown/duplicate markers are dropped, pair
  // formatting is dropped if it is broken, and missing atoms are appended at
  // the end of the sentence so no citation is ever lost.
  function parse(str, kinds, opts = {}) {
    const tokens = [];
    const problems = [];
    const seenAtom = new Set();
    const opened = new Set();
    const closed = new Set();
    const stack = [];
    let last = 0;
    for (const m of String(str).matchAll(TOKEN_RE)) {
      if (m.index > last) pushText(tokens, str.slice(last, m.index));
      last = m.index + m[0].length;
      const k = Number(m[2]);
      const kind = kinds[k];
      const isClose = m[1] === '/';
      if (!kind) {
        problems.push('unknown');
        continue;
      }
      if (kind === 'atom') {
        if (isClose || seenAtom.has(k)) {
          problems.push('dup-atom');
          continue;
        }
        seenAtom.add(k);
        tokens.push({ t: 'atom', k });
      } else if (!isClose) {
        if (opened.has(k)) {
          problems.push('dup-open');
          continue;
        }
        opened.add(k);
        stack.push(k);
        tokens.push({ t: 'open', k });
      } else {
        if (stack[stack.length - 1] !== k) {
          problems.push('misnest');
          continue;
        }
        stack.pop();
        closed.add(k);
        tokens.push({ t: 'close', k });
      }
    }
    if (last < str.length) pushText(tokens, str.slice(last));
    if (stack.length) problems.push('unclosed');

    const missing = [];
    for (let k = 1; k < kinds.length; k++) {
      if (kinds[k] === 'atom' && !seenAtom.has(k)) missing.push(k);
      if (kinds[k] === 'pair' && !(opened.has(k) && closed.has(k))) problems.push('pair-missing');
    }
    if (missing.length) problems.push('atom-missing');

    const ok = problems.length === 0;
    // Is the italic/link structure intact (only citation atoms are wrong)?
    const pairsOk = !problems.some((p) => p === 'misnest' || p === 'unclosed' || p === 'pair-missing' || p === 'dup-open');
    if (ok || !opts.repair) return { ok, tokens, problems, pairsOk };
    return { ok: false, repaired: true, tokens: repairTokens(tokens, missing, pairsOk), problems, pairsOk };
  }

  // Always produces usable tokens: keeps formatting if its structure is
  // intact (drops it otherwise, keeping the text), and puts every missing
  // atom back next to its neighbour from the source, so no citation is lost.
  function repairTokens(tokens, missing, keepPairs) {
    const out = [];
    for (const t of tokens) {
      if (t.t === 'text') pushText(out, t.v);
      else if (t.t === 'atom' || keepPairs) out.push(t);
    }
    for (const k of missing) insertMissingAtom(out, k);
    return out;
  }

  function insertMissingAtom(out, k) {
    const atom = { t: 'atom', k };
    // after the nearest earlier marker (after the end of it, for a pair)...
    for (let j = k - 1; j >= 1; j--) {
      let pos = -1;
      for (let i = 0; i < out.length; i++) {
        const t = out[i];
        if (t.k === j && (t.t === 'atom' || t.t === 'close')) pos = i;
      }
      if (pos >= 0) {
        out.splice(pos + 1, 0, atom);
        return;
      }
    }
    // ...or before the nearest later one...
    for (let i = 0; i < out.length; i++) {
      const t = out[i];
      if ((t.t === 'atom' || t.t === 'open') && t.k > k) {
        out.splice(i, 0, atom);
        return;
      }
    }
    // ...or at the end of the sentence.
    const lastTok = out[out.length - 1];
    const m = lastTok && lastTok.t === 'text' ? lastTok.v.match(/[\s。．.!！?？;；:：]+$/) : null;
    if (m) {
      lastTok.v = lastTok.v.slice(0, lastTok.v.length - m[0].length);
      if (!lastTok.v) out.pop();
      out.push(atom, { t: 'text', v: m[0] });
    } else {
      out.push(atom);
    }
  }

  // Bare URLs in running text are kept out of translation (Google "translates"
  // parts of them, e.g. "oldid" -> "oldage"). Returns [{url: bool, v}].
  const URL_RE = /(?:https?:\/\/|www\.)[^\s"'<>　-〿＀-￯]+/gi;
  function splitUrls(text) {
    const parts = [];
    let last = 0;
    for (const m of String(text).matchAll(URL_RE)) {
      let url = m[0];
      const trail = url.match(/[.,;:!?)\]]+$/);
      if (trail) url = url.slice(0, url.length - trail[0].length);
      if (!url) continue;
      if (m.index > last) parts.push({ url: false, v: text.slice(last, m.index) });
      parts.push({ url: true, v: url });
      last = m.index + url.length;
    }
    if (last < text.length) parts.push({ url: false, v: text.slice(last) });
    return parts;
  }
  const isUrlText = (s) => /^\s*(?:https?:\/\/|www\.)\S+\s*$/i.test(s || '');

  // True if the text contains something worth translating (a word of 2+
  // letters, or CJK). Numbers, "1a", "S3", "et al.", single letters (variables
  // such as n or P) and punctuation are not.
  function hasWords(text) {
    if (!text) return false;
    const t = String(text)
      .replace(/et\s+al\.?/gi, ' ')
      .replace(/(^|[^\p{L}\p{N}])\p{L}?\d+\p{L}?(?=$|[^\p{L}\p{N}])/gu, '$1 ');
    return /\p{L}{2,}/u.test(t) || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t);
  }

  globalThis.PTXMarkers = Object.freeze({
    OPEN,
    CLOSE,
    atom,
    open,
    close,
    escapeText,
    prepare,
    parse,
    hasWords,
    splitUrls,
    isUrlText,
  });
})();
