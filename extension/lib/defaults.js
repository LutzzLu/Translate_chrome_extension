// Shared defaults. Loaded as a classic script (content scripts, extension pages)
// and imported for side effects by ES modules (service worker), so it only
// assigns globals.
(() => {
  const g = globalThis;

  g.PTX_DEFAULTS = Object.freeze({
    targetLang: 'zh-CN',
    // 'replace'  : translation replaces the original text (citations kept in place)
    // 'bilingual': translation is shown under each original paragraph
    mode: 'replace',
    // Paper mode: on publisher sites translate only the article, and keep the
    // reference list, author names and affiliations in the original language.
    paperMode: true,
    // Hostnames that are translated automatically when a page loads.
    autoSites: [],
  });

  g.PTX_LANGUAGES = Object.freeze([
    ['zh-CN', '简体中文 (Chinese, Simplified)'],
    ['zh-TW', '繁體中文 (Chinese, Traditional)'],
    ['en', 'English'],
    ['ja', '日本語 (Japanese)'],
    ['ko', '한국어 (Korean)'],
    ['es', 'Español (Spanish)'],
    ['fr', 'Français (French)'],
    ['de', 'Deutsch (German)'],
    ['pt', 'Português (Portuguese)'],
    ['it', 'Italiano (Italian)'],
    ['ru', 'Русский (Russian)'],
    ['vi', 'Tiếng Việt (Vietnamese)'],
    ['ar', 'العربية (Arabic)'],
    ['hi', 'हिन्दी (Hindi)'],
  ]);

  g.ptxLoadSettings = async function ptxLoadSettings() {
    try {
      const stored = await chrome.storage.sync.get(null);
      return { ...g.PTX_DEFAULTS, ...stored };
    } catch (e) {
      return { ...g.PTX_DEFAULTS };
    }
  };
})();
