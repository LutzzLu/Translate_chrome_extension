// Paper Translator: service worker.
import './lib/defaults.js';
import { translateTexts } from './lib/engine.js';

const VIEWER_URL = chrome.runtime.getURL('pdf/viewer.html');
const CONTENT_FILES = ['lib/defaults.js', 'lib/markers.js', 'lib/glossary.js', 'content/content.js'];

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...globalThis.PTX_DEFAULTS, ...current });
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'ptx-toggle-page',
      title: 'Translate page / show original',
      contexts: ['page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
    });
    chrome.contextMenus.create({
      id: 'ptx-open-pdf-link',
      title: 'Open link as PDF in Paper Translator',
      contexts: ['link'],
    });
  });
});

// ------------------------------------------------------------------ helpers
const isViewerUrl = (url) => typeof url === 'string' && url.startsWith(VIEWER_URL);
const isWebUrl = (url) => /^(https?|file):/i.test(url || '');

function viewerUrlFor(fileUrl) {
  return `${VIEWER_URL}?file=${encodeURIComponent(fileUrl)}&translate=1`;
}

async function openViewer(fileUrl, tab, inNewTab) {
  const url = viewerUrlFor(fileUrl);
  if (inNewTab || !tab) {
    await chrome.tabs.create({ url, index: tab ? tab.index + 1 : undefined, openerTabId: tab ? tab.id : undefined });
  } else {
    await chrome.tabs.update(tab.id, { url });
  }
}

async function isPdfTab(tab) {
  if (!tab || !isWebUrl(tab.url)) return false;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.contentType,
    });
    if (res && typeof res.result === 'string') return res.result === 'application/pdf';
  } catch (e) {
    /* cannot script this tab */
  }
  return /\.pdf(?:$|[?#])/i.test(tab.url);
}

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    return null;
  }
}

async function injectContent(tabId) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
    return true;
  } catch (e) {
    return false;
  }
}

async function commandForTab(tab, type) {
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const url = tab.url || tab.pendingUrl || '';
  if (!url || isViewerUrl(url)) {
    // Our own PDF viewer. (Chrome hides the URL of extension pages from
    // tabs.query without the "tabs" permission, so it is addressed by tab id.)
    chrome.runtime.sendMessage({ type: 'ptx:viewer', action: type, tabId: tab.id }).catch(() => {});
    return;
  }
  if (!isWebUrl(tab.url)) return;
  if (await isPdfTab(tab)) {
    await openViewer(tab.url, tab, false);
    return;
  }
  let resp = await sendToTab(tab.id, { type });
  if (!resp && (await injectContent(tab.id))) resp = await sendToTab(tab.id, { type });
}

// ------------------------------------------------------------------ events
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'ptx:translate') {
    translateTexts(Array.isArray(msg.texts) ? msg.texts : [], { sl: msg.sl || 'auto', tl: msg.tl || 'zh-CN' })
      .then(sendResponse)
      .catch((e) => sendResponse({ translations: null, error: String((e && e.message) || e) }));
    return true; // async response
  }
  if (msg.type === 'ptx:openPdf' && msg.url) {
    openViewer(msg.url, sender.tab, !!msg.newTab).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-translation') commandForTab(tab, 'ptx:toggle');
  else if (command === 'toggle-mode') commandForTab(tab, 'ptx:toggleMode');
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ptx-toggle-page') commandForTab(tab, 'ptx:toggle');
  else if (info.menuItemId === 'ptx-open-pdf-link' && info.linkUrl) openViewer(info.linkUrl, tab, true);
});
