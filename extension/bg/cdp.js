// Chrome DevTools Protocol through chrome.debugger: trusted (isTrusted) input,
// drag and drop, answering JavaScript dialogs, captures beyond the window and
// evaluate on pages whose CSP blocks eval. Chrome shows a "being debugged" bar
// while attached, so tabs are detached as soon as no command needs them.
// Firefox has no chrome.debugger; callers get a clear error instead.

import { HAS_DEBUGGER, noDebuggerError, sleep } from "./util.js";

const BAR_SETTLE_MS = 200; // the "being debugged" bar resizes the page when it appears

const attached = new Set();
const attaching = new Map(); // tabId -> Promise, so concurrent callers share one attach
const inUse = new Map(); // tabId -> number of commands working in the tab
let keepAttached = () => false; // set by dialogs.js: a tab with a dialog must stay attached

// Commands hold a tab while they run; the debugger is detached only when no
// command holds it (and no dialog needs it).
export function holdTab(tabId) {
  inUse.set(tabId, (inUse.get(tabId) || 0) + 1);
}

export function releaseTab(tabId) {
  const n = (inUse.get(tabId) || 1) - 1;
  if (n > 0) inUse.set(tabId, n);
  else {
    inUse.delete(tabId);
    detachIfIdle(tabId);
  }
}

export const setKeepAttached = (fn) => (keepAttached = fn);

// Chrome's messages for the common failures don't say what they mean for Choro.
function debuggerError(err) {
  const msg = String(err?.message || err);
  if (/URL of different extension/i.test(msg)) {
    return new Error(
      "Choro can't use Chrome's debugger on this tab: the page contains a frame belonging to another extension " +
        "(list_frames shows the frames Choro can see), and Chrome doesn't allow debugging such tabs. Plain clicks " +
        "and typing (without trusted: true) still work, and the dialog option answers dialogs."
    );
  }
  if (/Another debugger is already attached/i.test(msg)) {
    return new Error("Another debugger (DevTools or another extension) is attached to this tab; close it and try again.");
  }
  return err instanceof Error ? err : new Error(msg);
}

// Returns true if this call attached (the page was just resized by the bar).
export async function attachDebugger(tabId, what = "This") {
  if (!HAS_DEBUGGER) throw noDebuggerError(what);
  if (attached.has(tabId)) return false;
  if (!attaching.has(tabId)) {
    attaching.set(
      tabId,
      chrome.debugger
        .attach({ tabId }, "1.3")
        .then(() => attached.add(tabId))
        .catch(async (err) => {
          // Chrome says "another debugger" also when it's Choro's own attachment
          // that outlived a suspended background; adopt that one.
          const targets = await chrome.debugger.getTargets().catch(() => []);
          if (targets.some((t) => t.tabId === tabId && t.attached && t.extensionId === chrome.runtime.id)) {
            attached.add(tabId);
            return;
          }
          throw debuggerError(err);
        })
        .finally(() => attaching.delete(tabId))
    );
    await attaching.get(tabId);
    return true;
  }
  await attaching.get(tabId);
  return false;
}

// Attach before measuring element positions: the bar shifts the page down.
export async function attachForInput(tabId, what) {
  if (await attachDebugger(tabId, what)) await sleep(BAR_SETTLE_MS);
}

export async function cdp(tabId, method, params = {}, what = method) {
  await attachDebugger(tabId, what);
  return chrome.debugger.sendCommand({ tabId }, method, params).catch((err) => {
    throw debuggerError(err);
  });
}

export function detachIfIdle(tabId) {
  if (!attached.has(tabId) || inUse.has(tabId) || keepAttached(tabId)) return;
  attached.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}

if (HAS_DEBUGGER) chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));

// --- input -----------------------------------------------------------------------

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEY_CODES = {
  Enter: [13, "Enter", "\r"],
  Tab: [9, "Tab"],
  Escape: [27, "Escape"],
  Backspace: [8, "Backspace"],
  Delete: [46, "Delete"],
  ArrowLeft: [37, "ArrowLeft"],
  ArrowUp: [38, "ArrowUp"],
  ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"],
  Home: [36, "Home"],
  End: [35, "End"],
  PageUp: [33, "PageUp"],
  PageDown: [34, "PageDown"],
  " ": [32, "Space", " "],
};

export async function cdpKey(tabId, key, modifiers = []) {
  const mod = modifiers.reduce((acc, m) => acc | (MODIFIER_BITS[m] || 0), 0);
  let [keyCode, code, text] = KEY_CODES[key] || [];
  if (!keyCode && key.length === 1) {
    const upper = key.toUpperCase();
    keyCode = upper.charCodeAt(0);
    code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : "";
    text = key;
  }
  // With Control/Meta held the key is a shortcut, not text input.
  if (mod & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) text = undefined;
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers: mod };
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: text ? "keyDown" : "rawKeyDown", text, unmodifiedText: text });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

export async function cdpClick(tabId, x, y, { button = "left", clickCount = 1 } = {}) {
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: i });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: i });
  }
}

// A real mouse drag. Chrome hands HTML5 drags to the debugger (setInterceptDrags),
// which then plays the drop onto the target; plain pointer drags just move and release.
export async function cdpDrag(tabId, a, b) {
  let intercepted = null;
  const onEvent = (src, method, params) => {
    if (src.tabId === tabId && method === "Input.dragIntercepted") intercepted = params.data;
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    await cdp(tabId, "Input.setInterceptDrags", { enabled: true });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      const x = a.x + ((b.x - a.x) * i) / 8;
      const y = a.y + ((b.y - a.y) * i) / 8;
      await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
      if (intercepted) break;
    }
    if (intercepted) {
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await cdp(tabId, "Input.dispatchDragEvent", { type, x: b.x, y: b.y, data: intercepted });
      }
    }
    await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
    return intercepted ? "drag and drop" : "pointer drag";
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    await cdp(tabId, "Input.setInterceptDrags", { enabled: false }).catch(() => {});
  }
}
