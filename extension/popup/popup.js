(async () => {
  const $ = (id) => document.getElementById(id);
  const VIEWER_URL = chrome.runtime.getURL('pdf/viewer.html');
  const CONTENT_FILES = ['lib/defaults.js', 'lib/markers.js', 'lib/glossary.js', 'content/content.js'];

  let settings = await globalThis.ptxLoadSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (e) {
    /* ignore */
  }
  let status = null;

  // ------------------------------------------------------------ messaging
  async function send(msg) {
    if (!tab) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return null;
    }
  }

  async function contentType() {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.contentType });
      return res && typeof res.result === 'string' ? res.result : null;
    } catch (e) {
      return null;
    }
  }

  async function inject() {
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
      return true;
    } catch (e) {
      return false;
    }
  }

  function tellViewer(action, extra = {}) {
    chrome.runtime.sendMessage({ type: 'ptx:viewer', action, tabId: tab.id, ...extra }).catch(() => {});
  }

  async function classify() {
    if (!url || url.startsWith(VIEWER_URL)) {
      // Possibly our PDF viewer (its URL is hidden without the "tabs" permission): ask it.
      const r = await chrome.runtime
        .sendMessage({ type: 'ptx:viewer', action: 'ptx:ping', tabId: tab && tab.id })
        .catch(() => null);
      return (r && r.viewer) || url.startsWith(VIEWER_URL) ? 'viewer' : 'unsupported';
    }
    if (!/^(https?|file):/i.test(url)) return 'unsupported';
    const looksPdf = /\.pdf(?:$|[?#])/i.test(url);
    let st = await send({ type: 'ptx:status' });
    if (st && st.isPdf) return 'pdf';
    if (!st) {
      const ct = await contentType();
      if (ct === 'application/pdf' || (ct === null && looksPdf)) return 'pdf';
      if (ct === null) return 'unsupported';
      if (await inject()) st = await send({ type: 'ptx:status' });
      if (!st) return 'unsupported';
    }
    status = st;
    return 'web';
  }

  // ------------------------------------------------------------ settings UI
  for (const [code, name] of globalThis.PTX_LANGUAGES) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = name;
    $('lang').appendChild(o);
  }
  $('lang').value = settings.targetLang;
  $('paperMode').checked = !!settings.paperMode;
  $('host').textContent = host || (url.startsWith(VIEWER_URL) ? 'PDF translator' : '');
  $('autoHost').textContent = host;
  $('autoSite').checked = (settings.autoSites || []).includes(host);

  chrome.commands.getAll((cmds) => {
    const c = cmds.find((x) => x.name === 'toggle-translation');
    $('shortcut').textContent = c && c.shortcut ? c.shortcut : 'not set';
  });

  const kind = await classify();
  if (kind === 'viewer') $('host').textContent = 'PDF translator';
  $('webSection').hidden = kind !== 'web';
  $('pdfSection').hidden = kind !== 'pdf';
  $('viewerSection').hidden = kind !== 'viewer';
  $('unsupportedSection').hidden = kind !== 'unsupported';
  $('autoRow').hidden = kind !== 'web' || !host;

  function render() {
    for (const b of document.querySelectorAll('#modeSeg button')) {
      b.classList.toggle('on', b.dataset.mode === settings.mode);
    }
    if (kind !== 'web') return;
    const active = !!(status && status.active);
    $('mainBtn').textContent = active ? 'Show original' : 'Translate page';
    $('mainBtn').classList.toggle('secondary', active);
    const el = $('status');
    el.classList.remove('err');
    if (!status || !active) {
      el.textContent = '';
    } else if (status.pending > 0 || status.inflight > 0) {
      el.textContent = `Translating… ${status.done} / ${status.total} paragraphs`;
    } else if (status.failed > 0) {
      el.classList.add('err');
      el.textContent = `${status.failed} paragraph(s) failed: ${status.error || 'error'}`;
    } else {
      el.textContent = `Translated ${status.done} paragraph${status.done === 1 ? '' : 's'}.`;
    }
  }
  render();

  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    await chrome.storage.sync.set(patch);
  }

  // ------------------------------------------------------------ actions
  $('mainBtn').addEventListener('click', async () => {
    const st = status && status.active ? await send({ type: 'ptx:stop' }) : await send({ type: 'ptx:start', mode: settings.mode });
    if (st) status = st;
    render();
  });

  $('pdfBtn').addEventListener('click', async () => {
    await chrome.tabs.update(tab.id, { url: `${VIEWER_URL}?file=${encodeURIComponent(url)}&translate=1` });
    window.close();
  });

  $('viewerBtn').addEventListener('click', () => {
    tellViewer('ptx:toggle');
    window.close();
  });

  for (const b of document.querySelectorAll('#modeSeg button')) {
    b.addEventListener('click', async () => {
      const mode = b.dataset.mode;
      await saveSettings({ mode });
      if (kind === 'web' && status && status.active) {
        const st = await send({ type: 'ptx:setMode', mode });
        if (st) status = st;
      } else if (kind === 'viewer') {
        tellViewer('ptx:setMode', { mode });
      }
      render();
    });
  }

  $('lang').addEventListener('change', async () => {
    await saveSettings({ targetLang: $('lang').value });
    if (kind === 'web' && status && status.active) {
      const st = await send({ type: 'ptx:restart' });
      if (st) status = st;
    } else if (kind === 'viewer') {
      tellViewer('ptx:restart');
    }
    render();
  });

  $('paperMode').addEventListener('change', async () => {
    await saveSettings({ paperMode: $('paperMode').checked });
    if (kind === 'web' && status && status.active) {
      const st = await send({ type: 'ptx:restart' });
      if (st) status = st;
    }
    render();
  });

  $('autoSite').addEventListener('change', async () => {
    const list = new Set(settings.autoSites || []);
    if ($('autoSite').checked) list.add(host);
    else list.delete(host);
    await saveSettings({ autoSites: [...list] });
    if ($('autoSite').checked && kind === 'web' && !(status && status.active)) {
      const st = await send({ type: 'ptx:start', mode: settings.mode });
      if (st) status = st;
    }
    render();
  });

  $('openPdfFile').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: VIEWER_URL });
    window.close();
  });

  // Live progress while the popup is open.
  if (kind === 'web') {
    setInterval(async () => {
      const st = await send({ type: 'ptx:status' });
      if (st) {
        status = st;
        render();
      }
    }, 700);
  }
})();
