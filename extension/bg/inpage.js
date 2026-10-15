// Running code inside pages.
//
// page.js (isolated world, every frame) does the DOM work: snapshots, refs,
// synthetic input. page-hooks.js (the page's own world) and page-relay.js report
// dialogs, blocked popups and network bodies. They are registered only while an
// agent is connected, start switched off, and are switched on only in tabs an
// agent works in (setTabHooks). Pages loaded while connected keep the (inactive)
// wrappers until they reload.

import { dialogRule, pageWork } from "./dialogs.js";
import { isScriptable } from "./util.js";

// Refs of elements inside cross-origin frames carry the frame: "f12:e5".
export const FRAME_REF = /^f(\d+):(e\d+)$/;

// Refs a frame's own page script reports ("e5") become "f12:e5" for the caller.
function withFrameRefs(value, frameId) {
  const fix = (s) => s.replace(/\[e(\d+)\]/g, `[f${frameId}:e$1]`);
  if (typeof value === "string") return fix(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const copy = { ...value };
    for (const k of ["text", "description"]) if (typeof copy[k] === "string") copy[k] = fix(copy[k]);
    return copy;
  }
  return value;
}

export async function runInPage(tab, method, args = {}, frameId = 0, { timeoutMs } = {}) {
  const m = FRAME_REF.exec(args.ref || "");
  if (m) {
    frameId = Number(m[1]);
    args = { ...args, ref: m[2] };
  }
  if (!isScriptable(tab.url)) {
    throw new Error(`The browser doesn't let extensions access ${tab.url}. Navigate to a regular web page first.`);
  }
  const target = { tabId: tab.id, frameIds: [frameId] };
  try {
    const [res] = await pageWork(
      tab.id,
      () =>
        ensurePageHooks(tab.id)
          .then(() => chrome.scripting.executeScript({ target, files: ["page.js"] }))
          .then(() => chrome.scripting.executeScript({ target, func: (m, a) => window.__choro.run(m, a), args: [method, args] })),
      timeoutMs
    );
    const out = res?.result;
    if (!out) throw new Error("The page did not return a result (it may have navigated away).");
    if (!out.ok) throw new Error(out.error);
    return frameId ? withFrameRefs(out.value, frameId) : out.value;
  } catch (err) {
    const msg = String(err?.message || err);
    if (/Cannot access|cannot be scripted|Missing host permission/i.test(msg)) {
      throw new Error(`Cannot access this page (${tab.url}): ${msg}`);
    }
    throw err;
  }
}

// --- page hooks ------------------------------------------------------------------

const HOOKS = [
  { id: "choro-relay", js: ["page-relay.js"] },
  { id: "choro-hooks", js: ["page-hooks.js"], world: "MAIN" },
].map((s) => ({ matches: ["<all_urls>"], runAt: "document_start", allFrames: true, persistAcrossSessions: false, ...s }));

let hooksWanted = false;
let hooksChange = Promise.resolve();
const hookedTabs = new Set(); // tabs whose current documents have the hooks

// Registers the hooks for pages loaded from now on (or removes them). Calls are
// chained so quick connect/disconnect sequences end in the last requested state.
export function setPageHooks(on) {
  hooksWanted = on;
  hookedTabs.clear();
  hooksChange = hooksChange
    .catch(() => {})
    .then(async () => {
      const want = hooksWanted;
      const ids = HOOKS.map((h) => h.id);
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids }).catch(() => []);
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) }).catch(() => {});
      if (!want) return;
      // matchOriginAsFallback also covers about:blank, srcdoc, blob: and data: frames; not every browser has it.
      try {
        await chrome.scripting.registerContentScripts(HOOKS.map((h) => ({ ...h, matchOriginAsFallback: true })));
      } catch {
        await chrome.scripting.registerContentScripts(HOOKS).catch(() => {});
      }
    });
  return hooksChange;
}

// Pages that were open before the agent connected get the hooks on first use.
// The relay's marker is the extension version (a page element with that id
// can't fake it, and an older copy left by an update doesn't count).
export async function ensurePageHooks(tabId) {
  if (!hooksWanted || hookedTabs.has(tabId)) return;
  const version = chrome.runtime.getManifest().version;
  let probe;
  try {
    probe = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (v) => globalThis.__choroRelay === v,
      args: [version],
    });
  } catch {
    return; // not scriptable right now; try again next time
  }
  const missing = probe.filter((r) => !r.result).map((r) => r.frameId);
  if (missing.length) {
    const target = { tabId, frameIds: missing };
    await chrome.scripting.executeScript({ target, files: ["page-hooks.js"], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ["page-relay.js"] }).catch(() => {});
  }
  hookedTabs.add(tabId);
}

// Switches a tab's hooks on (an agent works in it) or off, and passes on the
// tab's standing dialog rule.
export async function setTabHooks(tabId, on) {
  const rule = on ? await dialogRule(tabId) : null;
  chrome.tabs.sendMessage(tabId, { type: "hooks", on, rule }).catch(() => {});
}

// A new document in any frame needs checking again.
chrome.webNavigation.onCommitted.addListener(({ tabId }) => hookedTabs.delete(tabId));
chrome.tabs.onRemoved.addListener((tabId) => hookedTabs.delete(tabId));

// --- evaluate --------------------------------------------------------------------

// Runs in the page's main world (so it sees page globals, like the debugger's
// Runtime.evaluate). Must be self-contained: it is serialized into the page.
// Whether the page allows eval at all is tested first, so the expression itself
// never runs twice.
export async function evaluateInPage(expression) {
  try {
    (0, eval)("0");
  } catch {
    return { blocked: true }; // CSP or Trusted Types
  }
  let value;
  try {
    value = await (0, eval)(expression);
  } catch (err) {
    return { error: String(err?.stack || err) };
  }
  const type = typeof value;
  if (value === undefined || type === "function" || type === "symbol") return { type };
  try {
    return { value: JSON.parse(JSON.stringify(value)) ?? null, type };
  } catch {
    return { value: String(value), type };
  }
}
