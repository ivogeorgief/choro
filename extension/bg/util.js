// Small helpers shared by the background modules.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const withTimeout = (promise, ms, onTimeout) =>
  Promise.race([promise, sleep(ms).then(() => Promise.reject(onTimeout()))]);

export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// "https://a/b#c" -> ["https://a/b", "c"]
export function splitHash(url = "") {
  const i = url.indexOf("#");
  return i === -1 ? [url] : [url.slice(0, i), url.slice(i + 1)];
}

// Adds a scheme to bare addresses. "localhost:3000" looks like a scheme to a
// naive check, so only "scheme://..." and the known schemeless forms are kept.
export function normalizeUrl(url) {
  const u = String(url).trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u) || /^(about|data|blob|javascript|view-source|mailto):/i.test(u)) return u;
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)(?=[:/]|$)/i.test(u);
  return `${local ? "http" : "https"}://${u}`;
}

// Pages extensions may not script (browser UI, other extensions, the stores).
// Each browser keeps extensions off its own add-on store (and only its own).
const IS_FIREFOX = typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent);
const STORE = IS_FIREFOX
  ? /^https:\/\/addons\.mozilla\.org\//
  : /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/;

// The name agents see when several browsers are connected.
export function browserName() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (IS_FIREFOX) return "Firefox";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (navigator.brave) return "Brave";
  return "Chrome";
}

export function isScriptable(url = "") {
  return !/^(chrome|edge|about|devtools|chrome-extension|moz-extension|view-source|resource):/.test(url) && !STORE.test(url);
}

export function describeTab(tab) {
  return { id: tab.id, windowId: tab.windowId, active: tab.active, title: tab.title, url: tab.url, status: tab.status };
}

// Chrome has chrome.debugger; Firefox doesn't, so the features built on it
// (trusted input, answering dialogs, captures beyond the window) aren't there.
export const HAS_DEBUGGER = typeof chrome.debugger?.attach === "function";


export function noDebuggerError(what) {
  return new Error(
    `${what} needs Chrome's debugger API, which Firefox doesn't have. Use simulated input (leave out trusted), ` +
      'and answer dialogs with the dialog option ("accept" or "dismiss") on the action that opens them.'
  );
}
