// Choro background script (a service worker in Chrome, an event page in Firefox).
//
// Connects to the local Choro server (bg/connection.js), receives commands from
// agent sessions and runs them against the user's tabs (bg/commands.js).
//
//   bg/connection.js   the authenticated WebSocket link to the server
//   bg/sessions.js     agent sessions and the tabs each one uses
//   bg/commands.js     one command per MCP tool
//   bg/actions.js      click, type, drag... (simulated or trusted input)
//   bg/inpage.js       running page.js in pages and frames; the page hooks
//   bg/frames.js       cross-origin frames in snapshots and coordinates
//   bg/dialogs.js      alert/confirm/prompt: reporting and answering them
//   bg/activity.js     navigation waits; what an action caused
//   bg/screenshots.js  visible, full-page and element screenshots
//   bg/network.js      the network log
//   bg/cdp.js          Chrome's debugger (trusted input and more); absent in Firefox
//   bg/util.js         shared helpers

import "./bg/compat.js"; // first: Firefox's promise-based API under the chrome name
import { recordBlockedPopup, recordHandledDialog } from "./bg/activity.js";
import { handleCommand } from "./bg/commands.js";
import { connect, getStatus, initConnection, isConnected, reconnect, disconnect } from "./bg/connection.js";
import { onDialogClosed, onDialogOpening } from "./bg/dialogs.js";
import { setPageHooks, setTabHooks } from "./bg/inpage.js";
import { forgetTabLog, onPageReport, setNetworkLogging, startNetworkLog } from "./bg/network.js";
import { isAgentTab, setSessions, watchOwners } from "./bg/sessions.js";

startNetworkLog(isConnected);

initConnection({
  onCommand: handleCommand,
  onSessions: setSessions,
  // Page hooks and the network log exist only while an agent is connected, and
  // the hooks are active only in tabs an agent works in.
  onStatus(status) {
    const on = status === "connected";
    setPageHooks(on);
    setNetworkLogging(on);
    chrome.tabs.query({}).then((tabs) => {
      for (const t of tabs) setTabHooks(t.id, on && isAgentTab(t.id));
    });
  },
});

watchOwners((tabId, owner, before) => {
  setTabHooks(tabId, !!owner && isConnected());
  if (before) forgetTabLog(tabId); // a new session starts with a clean log
});

// Nothing may linger from a previous run (e.g. the browser closed while connected).
setPageHooks(false);
setNetworkLogging(false);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  // From pages, via page-relay.js. Pages can fake these, so they are only claims.
  if (sender.tab) {
    const tabId = sender.tab.id;
    if (msg.type === "hookState") {
      sendResponse({ on: isConnected() && isAgentTab(tabId) });
      return;
    }
    // Claims count only for tabs an agent works in.
    if (!isAgentTab(tabId)) return;
    if (msg.type === "dialogOpening") onDialogOpening(tabId, msg);
    else if (msg.type === "dialogClosed") onDialogClosed(tabId);
    else if (msg.type === "net") onPageReport(tabId, sender.frameId ?? 0, msg.detail);
    else if (msg.type === "dialogHandled") recordHandledDialog(tabId, { type: msg.dialogType, message: msg.message, accept: msg.accept });
    else if (msg.type === "popupBlocked") recordBlockedPopup(tabId, msg.url);
    return;
  }
  // From the extension's own popup.
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === "getStatus") {
    sendResponse(getStatus());
  } else if (msg.type === "reconnect") {
    reconnect();
    sendResponse({ ok: true });
  } else if (msg.type === "disable") {
    disconnect();
    sendResponse({ ok: true });
  }
});

connect();
