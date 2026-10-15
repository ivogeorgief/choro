// Isolated-world partner of page-hooks.js: passes the hooks' reports (dialogs,
// blocked popups, network bodies) to the background, and switches the hooks on
// in tabs an agent works in and off everywhere else. Registered only while an
// agent is connected.

(() => {
  // Firefox's chrome.* uses callbacks in Manifest V2; its browser.* returns promises.
  const chrome = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
  // The marker is the extension version: a page element with this id can't fake
  // it, and a copy left behind by an older version is replaced.
  const VERSION = chrome.runtime.getManifest().version;
  if (globalThis.__choroRelay === VERSION) return;
  globalThis.__choroRelay = VERSION;

  // When the extension is reloaded or updated, this copy stays behind in open
  // tabs, and calling chrome.runtime then throws "Extension context invalidated"
  // synchronously. The first such failure unhooks this copy for good.
  const listeners = [];
  const on = (type, fn) => {
    listeners.push([type, fn]);
    window.addEventListener(type, fn);
  };
  function retire() {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn);
    listeners.length = 0;
  }
  function send(msg) {
    try {
      if (!chrome.runtime?.id) throw new Error("extension gone");
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch {
      retire();
      return Promise.resolve(null);
    }
  }

  // Pages can fire these events themselves: a budget per second keeps a hostile
  // page from flooding the background.
  const budget = { net: 100, dialog: 5 };
  const left = { ...budget };
  setInterval(() => Object.assign(left, budget), 1000);
  const allow = (kind) => left[kind]-- > 0;

  const parse = (e) => {
    try {
      return typeof e.detail === "string" ? JSON.parse(e.detail) : null;
    } catch {
      return null;
    }
  };

  on("__choro_dialog", (e) => {
    const d = parse(e);
    if (d && allow("dialog")) send({ type: "dialogOpening", dialogType: d.type, message: d.message });
  });
  on("__choro_dialog_closed", () => allow("dialog") && send({ type: "dialogClosed" }));
  on("__choro_dialog_handled", (e) => {
    const d = parse(e);
    if (d && allow("dialog")) send({ type: "dialogHandled", dialogType: d.type, message: d.message, accept: d.accept });
  });
  on("__choro_net", (e) => {
    if (typeof e.detail === "string" && allow("net")) send({ type: "net", detail: e.detail });
  });
  on("__choro_popup_blocked", (e) => {
    if (!allow("dialog")) return;
    let url = typeof e.detail === "string" ? e.detail : "";
    try {
      url = url && new URL(url, location.href).href;
    } catch {
      /* keep as given */
    }
    send({ type: "popupBlocked", url });
  });

  // The hooks in the page's world start switched off; the background says
  // whether this tab is one an agent works in, now and whenever that changes.
  const setHooks = (enabled) => window.dispatchEvent(new CustomEvent("__choro_status", { detail: enabled ? "on" : "off" }));
  send({ type: "hookState" }).then((r) => setHooks(!!r?.on));
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "hooks") setHooks(!!msg.on);
  });
})();
