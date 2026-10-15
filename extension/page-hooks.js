// Runs in the page's own JavaScript world, from document_start, while an agent is
// connected (registered then, and injected into pages that were already open).
// It starts switched off; page-relay.js switches it on ("__choro_status") only in
// tabs an agent works in. While on, it wraps a few browser functions to report
// what extensions can't otherwise see:
//
// - alert/confirm/prompt: each dialog is reported before it opens (and when it
//   closes) and, in Chrome, held for a moment so the debugger can attach and
//   answer it; while an action's `dialog` option is in force ("__choro_policy"),
//   dialogs are answered here and never shown.
// - window.open: popups the browser blocks are reported.
// - fetch, XMLHttpRequest, WebSocket: text response bodies and messages are
//   copied for the network log.
//
// Reports go out as CustomEvents to page-relay.js. Switched off, everything here
// passes calls straight through. The browser functions used here are saved at
// document_start, so page scripts can't tamper with them.

(() => {
  const GUARD = Symbol.for("choro.hooks");
  if (window[GUARD]) return;
  Object.defineProperty(window, GUARD, { value: true });

  const { stringify, parse } = JSON;
  const now = Date.now;
  const NativeCustomEvent = window.CustomEvent;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;

  let connected = false; // on only in tabs an agent works in
  listen.call(window, "__choro_status", (e) => (connected = e.detail === "on"));

  // While an action's `dialog` option is in force, or the tab has a standing
  // rule (set_dialog_rule), dialogs are answered here. The action's comes first.
  let policy = null;
  let rule = null;
  const parsed = (e) => {
    try {
      return parse(e.detail);
    } catch {
      return null;
    }
  };
  listen.call(window, "__choro_policy", (e) => (policy = parsed(e)));
  listen.call(window, "__choro_rule", (e) => (rule = parsed(e)));
  const dialogPolicy = () => (policy && now() < policy.until ? policy : rule);

  const emit = (type, detail) => {
    try {
      dispatch.call(window, new NativeCustomEvent(type, { detail: typeof detail === "string" ? detail : stringify(detail) }));
    } catch {
      /* not serializable */
    }
  };

  // Replaces obj[name] with wrap(original), keeping the name and length the page expects.
  function replace(obj, name, wrap) {
    const original = obj?.[name];
    if (typeof original !== "function") return;
    const wrapped = wrap(original);
    Object.defineProperty(wrapped, "name", { value: original.name, configurable: true });
    Object.defineProperty(wrapped, "length", { value: original.length, configurable: true });
    obj[name] = wrapped;
  }

  // --- dialogs ------------------------------------------------------------------------

  // Chrome's debugger can take a dialog over if it attaches before the dialog opens.
  // Firefox has no such debugger, so there holding the dialog would only delay it.
  const HOLD_MS = /Firefox\//.test(navigator.userAgent) ? 0 : 400;

  for (const type of ["alert", "confirm", "prompt"]) {
    replace(window, type, (original) => ({
      [type](...args) {
        if (connected) {
          const message = String(args[0] ?? "");
          const policy = dialogPolicy();
          if (policy) {
            emit("__choro_dialog_handled", { type, message, accept: policy.accept });
            if (type === "confirm") return policy.accept;
            if (type === "prompt") return policy.accept ? String(policy.promptText ?? args[1] ?? "") : null;
            return undefined;
          }
          emit("__choro_dialog", { type, message });
          // Nothing else can run while a dialog is pending anyway.
          for (const until = now() + HOLD_MS; now() < until; );
          try {
            return original.apply(this, args);
          } finally {
            emit("__choro_dialog_closed", "");
          }
        }
        return original.apply(this, args);
      },
    })[type]);
  }

  replace(window, "open", (original) => ({
    open(...args) {
      const win = original.apply(this, args);
      // With noopener/noreferrer, window.open returns null even when the popup opened.
      if (!win && connected && !/noopener|noreferrer/i.test(String(args[2] ?? ""))) {
        emit("__choro_popup_blocked", String(args[0] ?? ""));
      }
      return win;
    },
  }).open);

  // --- network bodies ------------------------------------------------------------------

  const MAX_BODY = 200_000; // characters per body
  const MAX_READ_MS = 30_000; // give up on bodies that stream longer than this
  const TEXTUAL = /json|text|xml|javascript|x-www-form-urlencoded|graphql|csv|yaml/i;
  const STREAMING = /event-stream|ndjson|stream/i;
  const absolute = (url) => {
    try {
      return new URL(url, location.href).href;
    } catch {
      return String(url);
    }
  };

  // Reads at most MAX_BODY characters (and for at most MAX_READ_MS) from a copy of
  // the response, so streams and huge downloads are never buffered whole.
  async function readText(res) {
    const reader = res.body?.getReader();
    if (!reader) return { body: "", truncated: false };
    const decoder = new TextDecoder();
    const deadline = now() + MAX_READ_MS;
    let body = "";
    try {
      while (body.length < MAX_BODY && now() < deadline) {
        const { done, value } = await reader.read();
        if (done) return { body: body + decoder.decode(), truncated: false };
        body += decoder.decode(value, { stream: true });
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return { body: body.slice(0, MAX_BODY), truncated: true };
  }

  replace(window, "fetch", (original) => ({
    fetch(input, init) {
      const promise = original.apply(this, arguments);
      if (!connected) return promise;
      const method = String(init?.method || input?.method || "GET").toUpperCase();
      promise.then(
        (res) => {
          const type = res.headers.get("content-type") || "";
          if (!TEXTUAL.test(type) || STREAMING.test(type) || Number(res.headers.get("content-length")) > 5_000_000) return;
          readText(res.clone()).then(
            ({ body, truncated }) =>
              connected && emit("__choro_net", { kind: "body", url: res.url || absolute(input?.url ?? input), method, status: res.status, body, truncated }),
            () => {}
          );
        },
        () => {}
      );
      return promise;
    },
  }).fetch);

  const XHR = window.XMLHttpRequest?.prototype;
  if (XHR) {
    const meta = new WeakMap(); // xhr -> {method, url} of its current request
    replace(XHR, "open", (original) => ({
      open(method, url) {
        meta.set(this, { method: String(method || "GET").toUpperCase(), url: absolute(url) });
        return original.apply(this, arguments);
      },
    }).open);
    replace(XHR, "send", (original) => ({
      send(body) {
        if (connected && meta.has(this)) {
          // Once per request; details are read when it ends (an XHR can be reused).
          listen.call(this, "loadend", () => {
            const m = meta.get(this);
            if (!connected || !m || this.status === 0) return; // aborted or failed
            const type = this.getResponseHeader("content-type") || "";
            if (!TEXTUAL.test(type)) return;
            let text = null;
            try {
              if (this.responseType === "" || this.responseType === "text") text = this.responseText;
              else if (this.responseType === "json") text = stringify(this.response);
            } catch {
              /* not readable */
            }
            if (text == null) return;
            emit("__choro_net", {
              kind: "body",
              url: this.responseURL || m.url,
              method: m.method,
              status: this.status,
              body: text.slice(0, MAX_BODY),
              truncated: text.length > MAX_BODY,
            });
          }, { once: true });
        }
        return original.apply(this, arguments);
      },
    }).send);
  }

  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    const describe = (data) => (typeof data === "string" ? data.slice(0, 10_000) : `(binary, ${data?.byteLength ?? data?.size ?? "?"} bytes)`);
    class WebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        if (!connected) return;
        const url = this.url;
        emit("__choro_net", { kind: "ws", url, dir: "open" });
        listen.call(this, "message", (e) => connected && emit("__choro_net", { kind: "ws", url, dir: "in", data: describe(e.data) }));
        listen.call(this, "close", (e) => connected && emit("__choro_net", { kind: "ws", url, dir: "close", data: `code ${e.code}${e.reason ? `: ${e.reason}` : ""}` }));
      }
      send(data) {
        if (connected) emit("__choro_net", { kind: "ws", url: this.url, dir: "out", data: describe(data) });
        return super.send(data);
      }
    }
    Object.defineProperty(WebSocket, "length", { value: NativeWebSocket.length });
    window.WebSocket = WebSocket;
  }
})();
