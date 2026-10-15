// Waiting for navigations, and describing what an action caused: a new page or
// URL, new tabs, downloads, dialogs, blocked popups and network requests.

import { describeDialog, openDialog } from "./dialogs.js";
import { markAction, summarizeSince } from "./network.js";
import { capitalize, splitHash, sleep } from "./util.js";

const NAV_TIMEOUT_MS = 30_000;
const DOM_READY_GRACE_MS = 500; // after DOMContentLoaded, lets early scripts render before we stop waiting
const LOAD_POLL_MS = 50;
const KEEP = 50; // recent events kept per kind

const domReadyAt = new Map(); // tabId -> when the main frame reached DOMContentLoaded
const navStartedAt = new Map(); // tabId -> when the main frame last started a document-replacing navigation
const openedTabs = []; // {id, openerTabId, at}
const downloads = []; // {id, at}
// What pages claim (popups they say were blocked, dialogs answered by an action's
// `dialog` option), kept per tab so one tab can't crowd out another's.
const pageClaims = new Map(); // tabId -> [{kind, ...}]

const push = (list, item) => {
  list.push(item);
  if (list.length > KEEP) list.shift();
};

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return;
  domReadyAt.delete(tabId); // a stale entry must never end a wait early
  navStartedAt.set(tabId, Date.now());
});
chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, frameId }) => {
  if (frameId === 0) domReadyAt.set(tabId, Date.now());
});
chrome.tabs.onRemoved.addListener((tabId) => {
  domReadyAt.delete(tabId);
  navStartedAt.delete(tabId);
  pageClaims.delete(tabId);
});
chrome.tabs.onCreated.addListener((t) => {
  if (t.openerTabId != null) push(openedTabs, { id: t.id, openerTabId: t.openerTabId, at: Date.now() });
});
chrome.downloads.onCreated.addListener((d) => push(downloads, { id: d.id, at: Date.now() }));

function claim(tabId, item) {
  if (!pageClaims.has(tabId)) pageClaims.set(tabId, []);
  const list = pageClaims.get(tabId);
  list.push({ ...item, at: Date.now() });
  if (list.length > 20) list.shift();
}
const claimsSince = (tabId, kind, since) => (pageClaims.get(tabId) || []).filter((c) => c.kind === kind && c.at >= since);

export const recordBlockedPopup = (tabId, url) => claim(tabId, { kind: "popup", url: String(url ?? "").slice(0, 500) });
export function recordHandledDialog(tabId, { type, message, accept }) {
  if (!["alert", "confirm", "prompt"].includes(type)) return;
  claim(tabId, { kind: "dialog", type, message: String(message ?? "").slice(0, 1000), accept: !!accept });
}
export const openedTabSince = (tabId, since) => openedTabs.some((o) => o.openerTabId === tabId && o.at >= since);

// Resolves with the tab once it has fully loaded, or once its DOM has been ready
// for DOM_READY_GRACE_MS: waiting for the full load event can take seconds on
// pages with many images, ads or trackers even though the page is usable.
export async function waitForLoad(tabId, timeoutMs = NAV_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === "complete") return tab;
    const ready = domReadyAt.get(tabId);
    if (ready && Date.now() - ready >= DOM_READY_GRACE_MS) return tab;
    if (Date.now() > deadline) return tab;
    await sleep(LOAD_POLL_MS);
  }
}

// navigate, go_back, go_forward, reload: start the navigation, wait for it to
// begin (or about 300 ms), then for the page to load, and report side effects
// such as a "leave site?" dialog that stopped it.
export async function navigateAndWait(tab, start) {
  const since = Date.now();
  markAction(tab.id, since);
  domReadyAt.delete(tab.id);
  await start();
  for (let i = 0; i < 6 && !((navStartedAt.get(tab.id) || 0) >= since); i++) await sleep(50);
  const loaded = (await waitForLoad(tab.id)) || tab;
  return { tab: loaded, note: (await describeSideEffects(tab.id, since)).trim() };
}

// After an action that may trigger navigation, give the page a moment to start
// navigating and, if it does, wait for it to finish loading. Reports what changed.
export async function settleAfterAction(tabId, beforeUrl, since = Date.now()) {
  markAction(tabId, since);
  await sleep(350);
  let tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return "\nThe tab was closed.";
  if (tab.status === "loading") tab = (await waitForLoad(tabId)) || tab;
  return describeUrlChange(tab, beforeUrl, since) + (await describeSideEffects(tabId, since, tab));
}

function describeUrlChange(tab, beforeUrl, since) {
  if (tab.url === beforeUrl) return "";
  const [before, beforeHash = ""] = splitHash(beforeUrl);
  const [after, afterHash = ""] = splitHash(tab.url);
  if (before === after && beforeHash !== afterHash) {
    return afterHash ? `\nJumped to #${afterHash} on the same page` : "\nURL fragment cleared (same page)";
  }
  if (!((navStartedAt.get(tab.id) || 0) >= since)) return `\nURL changed to ${tab.url} (same page, no reload)`;
  return `\nPage is now: ${tab.title} — ${tab.url}`;
}

const origin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

async function describeSideEffects(tabId, since, tab = null) {
  let out = "";
  for (const o of openedTabs.filter((o) => o.openerTabId === tabId && o.at >= since)) {
    const t = await chrome.tabs.get(o.id).catch(() => null);
    if (t) out += `\nOpened a new tab [${t.id}]: ${t.pendingUrl || t.url} (select_tab ${t.id} to work in it)`;
  }
  // Downloads don't say which tab started them; match them by the page that referred them.
  tab ??= await chrome.tabs.get(tabId).catch(() => null);
  const tabOrigin = origin(tab?.url);
  for (const dl of downloads.filter((d) => d.at >= since)) {
    const [item] = await chrome.downloads.search({ id: dl.id }).catch(() => []);
    if (!item || (tabOrigin && origin(item.referrer || item.url) !== tabOrigin)) continue;
    const file = item.filename ? item.filename.split(/[\\/]/).pop() : item.url;
    out += `\nStarted a download: ${file} (${item.state === "complete" ? "finished" : item.state})`;
  }
  // Dialogs a standing rule answered between calls are reported with the next action.
  for (const d of (pageClaims.get(tabId) || []).filter((c) => c.kind === "dialog" && (c.at >= since || !c.reported))) {
    d.reported = true;
    const answer = d.type === "alert" ? "closed" : d.accept ? "accepted" : "dismissed";
    out += `\n${capitalize(describeDialog(d))} appeared and was ${answer}.`;
  }
  const open = openDialog(tabId);
  if (open) out += `\nThe page is now showing ${describeDialog(open)}; answer it with handle_dialog before doing anything else.`;
  for (const b of claimsSince(tabId, "popup", since)) {
    out += `\nThe page tried to open a popup${b.url ? ` (${b.url})` : ""}, and the browser blocked it.`;
  }
  return out + summarizeSince(tabId, since);
}
