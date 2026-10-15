// JavaScript dialogs (alert, confirm, prompt).
//
// An open dialog freezes its page: scripts and captures wait until it closes,
// and extensions can't see it. page-hooks.js reports each dialog just before it
// opens and holds it for a moment, so Chrome's debugger can attach and take it
// over; handle_dialog then answers it. Without the debugger (Firefox, or tabs
// Chrome won't debug) a dialog can still be reported and, in Chrome, dismissed.
// The `dialog` option on actions avoids all this by answering in the page.

import { attachDebugger, cdp, detachIfIdle, setKeepAttached } from "./cdp.js";
import { isAgentTab } from "./sessions.js";
import { HAS_DEBUGGER, sleep, withTimeout } from "./util.js";

const PAGE_TIMEOUT_MS = 10_000; // page work this slow usually means a dialog is blocking the page
const CONFIRM_MS = 1_500; // a reported dialog the page isn't actually blocked by is dropped after this

const dialogs = new Map(); // tabId -> {type, message, intercepted}
setKeepAttached((tabId) => dialogs.has(tabId));

export const openDialog = (tabId) => dialogs.get(tabId);

// A page's report is only a claim (any frame can dispatch the event): it counts
// for tabs an agent works in, never replaces a dialog the debugger confirmed, and
// is dropped unless the page turns out to be blocked.
export async function onDialogOpening(tabId, { dialogType, message }) {
  if (!["alert", "confirm", "prompt"].includes(dialogType) || !isAgentTab(tabId)) return;
  if (dialogs.get(tabId)?.intercepted) return;
  const entry = { type: dialogType, message: String(message ?? "").slice(0, 1000), intercepted: false };
  dialogs.set(tabId, entry);
  if (HAS_DEBUGGER) {
    try {
      await attachDebugger(tabId);
      chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {}); // may not answer while the page is frozen
    } catch {
      /* the dialog can still be reported and dismissed, just not answered */
    }
  }
  // Chrome freezes the page while a dialog is open, so a page that still runs
  // scripts sent a false report. (Firefox keeps running page scripts under a
  // dialog; there the report stands until page-hooks.js says the dialog closed.)
  await sleep(CONFIRM_MS);
  if (HAS_DEBUGGER && dialogs.get(tabId) === entry && !(await pageIsBlocked(tabId))) {
    dialogs.delete(tabId);
    detachIfIdle(tabId);
  }
}

// page-hooks.js: a dialog it reported was answered (by the user, or by the debugger).
export function onDialogClosed(tabId) {
  const d = dialogs.get(tabId);
  if (d && !d.intercepted) dialogs.delete(tabId);
}

if (HAS_DEBUGGER) {
  chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
    if (method === "Page.javascriptDialogOpening") {
      dialogs.set(tabId, { type: params.type, message: params.message, intercepted: true });
    } else if (method === "Page.javascriptDialogClosed") {
      dialogs.delete(tabId);
      detachIfIdle(tabId);
    }
  });
  // Detaching hands the dialog back to Chrome, out of reach.
  chrome.debugger.onDetach.addListener(({ tabId }) => {
    const d = dialogs.get(tabId);
    if (d) d.intercepted = false;
  });
}

chrome.tabs.onRemoved.addListener((tabId) => dialogs.delete(tabId));

// Asks the debugger whether a dialog is open: enabling the Page domain makes
// Chrome report a dialog that is already showing. The enable call itself may not
// answer while the page is frozen, so listen for the report instead.
async function findDialog(tabId) {
  if (dialogs.has(tabId) || !HAS_DEBUGGER) return dialogs.get(tabId) || null;
  try {
    await attachDebugger(tabId);
  } catch {
    return null;
  }
  chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  for (let i = 0; i < 30 && !dialogs.has(tabId); i++) await sleep(50);
  return dialogs.get(tabId) || null;
}

export function describeDialog(d) {
  const kind = d.type === "beforeunload" ? '"leave site?"' : d.type === "unknown" ? "JavaScript" : d.type;
  return `${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} dialog${d.message ? ` saying ${JSON.stringify(d.message)}` : ""}`;
}

function dialogError(d) {
  let how;
  if (d.intercepted) how = "Answer it with handle_dialog (accept: true or false) before doing anything else on this tab.";
  else if (!HAS_DEBUGGER) how = "Firefox doesn't let Choro answer it; the user has to. (Next time, pass dialog to the action that opens it.)";
  else how = "It opened before Choro could take it over, so Choro can only dismiss it (handle_dialog with accept: false).";
  return new Error(`The page is blocked by ${describeDialog(d)}. ${how}`);
}

// Is the page frozen? A page that still runs scripts isn't. Only a timeout
// counts: other errors (a page Choro can't script, a discarded tab) mean
// something else, not a dialog.
async function pageIsBlocked(tabId) {
  try {
    await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func: () => 1 }), 800, () => new Error("blocked"));
    return false;
  } catch (err) {
    return err?.message === "blocked";
  }
}

// A recorded dialog may be gone (the user answered it while the debugger wasn't
// watching); trust only a confirmed one, or a page that is still frozen.
async function stillBlocked(tabId) {
  const d = dialogs.get(tabId);
  if (d?.intercepted) return true;
  if (await pageIsBlocked(tabId)) return true;
  dialogs.delete(tabId);
  return false;
}

// Runs page work. Never queues it behind an open dialog (it would run later,
// unseen). If a dialog opens meanwhile (often the action itself opened it),
// reports it right away; if the work takes suspiciously long, finds out whether
// a dialog is the reason instead of hanging until the call times out.
export async function pageWork(tabId, promiseOrFn, timeoutMs = PAGE_TIMEOUT_MS) {
  if (dialogs.has(tabId) && (await stillBlocked(tabId))) throw dialogError(dialogs.get(tabId));
  const promise = typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
  let watching = true;
  const dialogOpened = (async () => {
    while (watching && !dialogs.has(tabId)) await sleep(100);
    if (!watching) return new Promise(() => {});
    // Give the debugger a moment to take the dialog over, so the report says whether it can be answered.
    for (let i = 0; i < 10 && !dialogs.get(tabId)?.intercepted; i++) await sleep(100);
    if (!dialogs.has(tabId)) return new Promise(() => {}); // it was a false report
    throw dialogError(dialogs.get(tabId));
  })();
  dialogOpened.catch(() => {}); // may settle after the race is over
  try {
    return await Promise.race([withTimeout(promise, timeoutMs, () => new Error("page-timeout")), dialogOpened]);
  } catch (err) {
    if (err?.message !== "page-timeout") throw err;
    const d = await findDialog(tabId);
    if (d) throw dialogError(d);
    throw new Error(
      `The page did not respond within ${Math.round(timeoutMs / 1000)}s. It may be busy, or blocked by a dialog Choro ` +
        "could not read; handle_dialog can try to dismiss one."
    );
  } finally {
    watching = false;
  }
}

// Chrome cancels a tab's dialog when the user switches away from the tab.
// (Firefox keeps it, so this only helps in Chrome.) The tab the user had
// selected is selected again afterwards.
async function dismissBySwitchingTabs(tab) {
  if (!HAS_DEBUGGER) return false;
  const inWindow = await chrome.tabs.query({ windowId: tab.windowId });
  const wasActive = inWindow.find((t) => t.active);
  let other = inWindow.find((t) => t.id !== tab.id);
  let temp = null;
  if (!other) other = temp = await chrome.tabs.create({ windowId: tab.windowId, url: "about:blank", active: false });
  await chrome.tabs.update(other.id, { active: true });
  await sleep(150);
  await chrome.tabs.update((wasActive && wasActive.id !== other.id ? wasActive : tab).id, { active: true });
  if (temp) await chrome.tabs.remove(temp.id).catch(() => {});
  return !(await stillBlocked(tab.id));
}

// handle_dialog.
export async function answerDialog(tab, accept, promptText) {
  let d = await findDialog(tab.id);
  // A frozen page with no dialog on record still has one (e.g. it opened before
  // Choro was listening); it can at least be dismissed.
  if (!d && (await pageIsBlocked(tab.id))) d = { type: "unknown", intercepted: false };
  if (!d) return { answered: false, text: "No dialog is open on this tab." };
  if (d.intercepted) {
    await withTimeout(
      cdp(tab.id, "Page.handleJavaScriptDialog", { accept, ...(promptText != null && { promptText }) }),
      5_000,
      () => new Error("Answering the dialog timed out.")
    );
    dialogs.delete(tab.id);
    return { answered: true, text: `${accept ? "Accepted" : "Dismissed"} ${describeDialog(d)}` };
  }
  if (!accept && (await dismissBySwitchingTabs(tab))) {
    dialogs.delete(tab.id);
    return { answered: true, text: `Dismissed ${describeDialog(d)} (by briefly switching tabs)` };
  }
  throw new Error(
    HAS_DEBUGGER
      ? `There is ${describeDialog(d)}, but it opened before Choro could take it over, so only the user can accept it. ` +
          "Choro can dismiss it with accept: false."
      : `There is ${describeDialog(d)}. Firefox doesn't let Choro answer it; the user has to. Next time, pass the ` +
          "dialog option to the action that opens it."
  );
}
