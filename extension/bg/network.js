// Network log: the requests made by tabs an agent works in, while it is connected.
// The browser's webRequest API gives each request's URL, method, type, status,
// headers and request body (no debugger needed); page-hooks.js adds the text
// bodies of fetch/XHR responses and WebSocket messages from inside the page.
// Everything stays in memory, within a size budget per tab, and is dropped when
// the tab closes or the agent disconnects. Passwords, tokens and similar values
// are hidden unless the caller asks for them.

import { isAgentTab } from "./sessions.js";

const MAX_ENTRIES = 500; // per tab
const MAX_WS_MESSAGES = 300; // per tab
const MAX_BODY_CHARS = 200_000; // per body
const MAX_WS_CHARS = 10_000; // per WebSocket message
const TAB_BUDGET_CHARS = 20_000_000; // bodies per tab; the oldest bodies go first
const MAX_PENDING = 50; // page-reported bodies waiting for their request
const BODY_MATCH_MS = 30_000;
const SECRET_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization)$|token|api-?key|secret|csrf|xsrf|session/i;
const SECRET_FIELD = /pass(word|wd|phrase)?|pwd|secret|token|otp|pin$|cvv|cvc|card.?num|ssn|api.?key/i;
// webRequest has no separate type for fetch; both are "xmlhttprequest".
const API_TYPES = new Set(["xmlhttprequest"]);

const logs = new Map(); // tabId -> { entries, byRequestId, ws, pendingBodies, seq, lastActionAt, bodyChars }
let connected = () => false;

function logFor(tabId) {
  let log = logs.get(tabId);
  if (!log) {
    log = { entries: [], byRequestId: new Map(), ws: [], pendingBodies: [], seq: 0, lastActionAt: 0, bodyChars: 0 };
    logs.set(tabId, log);
  }
  return log;
}

const recording = (tabId) => tabId >= 0 && connected() && isAgentTab(tabId);

// --- recording from webRequest ---------------------------------------------------

const FILTER = { urls: ["<all_urls>"] };
const entryOf = (d) => (d.tabId < 0 ? null : logs.get(d.tabId)?.byRequestId.get(d.requestId));

function onBeforeRequest(d) {
  if (!recording(d.tabId)) return;
  const log = logFor(d.tabId);
  const entry = {
    id: `r${++log.seq}`,
    requestId: d.requestId,
    method: d.method,
    url: d.url,
    type: d.type,
    frameId: d.frameId,
    initiator: d.initiator ?? d.originUrl,
    start: d.timeStamp,
    requestBody: formatRequestBody(d.requestBody),
  };
  addChars(log, entry.requestBody?.length ?? 0);
  log.byRequestId.set(d.requestId, entry); // a redirect reuses the id: the next hop replaces it
  log.entries.push(entry);
  if (log.entries.length > MAX_ENTRIES) dropEntry(log, log.entries.shift());
}

function onSendHeaders(d) {
  const e = entryOf(d);
  if (e) e.requestHeaders = d.requestHeaders;
}

function onHeadersReceived(d) {
  const e = entryOf(d);
  if (!e) return;
  e.status = d.statusCode;
  e.statusLine = d.statusLine;
  e.responseHeaders = d.responseHeaders;
}

function onBeforeRedirect(d) {
  const e = entryOf(d);
  if (!e) return;
  e.status = d.statusCode;
  e.redirectTo = d.redirectUrl;
  e.end = d.timeStamp;
  logs.get(d.tabId).byRequestId.delete(d.requestId);
}

function onCompleted(d) {
  const e = entryOf(d);
  if (!e) return;
  e.status = d.statusCode;
  e.end = d.timeStamp;
  e.fromCache = d.fromCache;
  const log = logs.get(d.tabId);
  log.byRequestId.delete(d.requestId);
  matchPendingBodies(log);
}

function onErrorOccurred(d) {
  const e = entryOf(d);
  if (!e) return;
  e.error = d.error;
  e.end = d.timeStamp;
  logs.get(d.tabId).byRequestId.delete(d.requestId);
}

// Chrome needs "extraHeaders" to show headers such as Cookie; Firefox shows them
// without it and rejects the option.
function addListener(event, fn, extra) {
  try {
    event.addListener(fn, FILTER, extra);
  } catch {
    event.addListener(fn, FILTER, extra.filter((x) => x !== "extraHeaders"));
  }
}

const LISTENERS = [
  [chrome.webRequest.onBeforeRequest, onBeforeRequest, ["requestBody"]],
  [chrome.webRequest.onSendHeaders, onSendHeaders, ["requestHeaders", "extraHeaders"]],
  [chrome.webRequest.onHeadersReceived, onHeadersReceived, ["responseHeaders", "extraHeaders"]],
  [chrome.webRequest.onBeforeRedirect, onBeforeRedirect, []],
  [chrome.webRequest.onCompleted, onCompleted, []],
  [chrome.webRequest.onErrorOccurred, onErrorOccurred, []],
];

// Listening only while an agent is connected keeps the user's own browsing from
// waking the extension for every request.
export function startNetworkLog(isConnected) {
  connected = isConnected;
}

export function setNetworkLogging(on) {
  for (const [event, fn, extra] of LISTENERS) {
    if (on && !event.hasListener(fn)) addListener(event, fn, extra);
    if (!on) event.removeListener(fn);
  }
  if (!on) logs.clear();
}

chrome.tabs.onRemoved.addListener((tabId) => logs.delete(tabId));

// A tab passing to another session (or none) starts with a clean log.
export const forgetTabLog = (tabId) => logs.delete(tabId);
chrome.tabs.onReplaced?.addListener((added, removed) => logs.delete(removed));

// --- bodies ------------------------------------------------------------------------

const DROPPED = "(dropped to save memory)";

function addChars(log, n) {
  log.bodyChars += n;
  // Over budget: drop the bodies of the oldest requests (their metadata stays).
  for (const e of log.entries) {
    if (log.bodyChars <= TAB_BUDGET_CHARS) break;
    dropBodies(log, e);
  }
}

function dropBodies(log, e) {
  if (e.bodiesDropped) return;
  e.bodiesDropped = true;
  log.bodyChars -= (e.requestBody?.length ?? 0) + (e.responseBody?.length ?? 0);
  if (e.requestBody) e.requestBody = DROPPED;
  if (e.responseBody) e.responseBody = DROPPED;
}

function dropEntry(log, e) {
  dropBodies(log, e);
  log.byRequestId.delete(e.requestId);
}

function formatRequestBody(body) {
  if (!body) return undefined;
  if (body.error) return `(not available: ${body.error})`;
  if (body.formData) {
    return Object.entries(body.formData)
      .map(([k, v]) => `${k}=${v.join(", ")}`)
      .join("\n");
  }
  if (body.raw) {
    const parts = body.raw.map((r) => (r.bytes ? new Uint8Array(r.bytes) : null)).filter(Boolean);
    const total = parts.reduce((n, b) => n + b.length, 0);
    const joined = new Uint8Array(total);
    let at = 0;
    for (const b of parts) {
      joined.set(b, at);
      at += b.length;
    }
    let text = new TextDecoder("utf-8", { fatal: false }).decode(joined.subarray(0, MAX_BODY_CHARS));
    if (/[\u0000-\u0008\u000e-\u001f]/.test(text.slice(0, 2000))) return `(binary, ${total} bytes)`;
    if (total > MAX_BODY_CHARS) text += `\n… (truncated, ${total} bytes in all)`;
    if (body.raw.some((r) => r.file)) text += "\n(plus uploaded file(s))";
    return text;
  }
  return undefined;
}

// Page-reported bodies (page-hooks.js). Any frame of the page can send these, so a
// body only attaches to a request made from the same frame.
export function onPageReport(tabId, frameId, detail) {
  if (!recording(tabId) || typeof detail !== "string" || detail.length > MAX_BODY_CHARS + 10_000) return;
  let d;
  try {
    d = JSON.parse(detail);
  } catch {
    return;
  }
  const log = logFor(tabId);
  if (d.kind === "ws" && typeof d.url === "string") {
    const data = typeof d.data === "string" ? d.data.slice(0, MAX_WS_CHARS) : "";
    log.ws.push({ url: d.url, dir: d.dir, data, at: Date.now() });
    if (log.ws.length > MAX_WS_MESSAGES) log.ws.shift();
  } else if (d.kind === "body" && typeof d.url === "string" && typeof d.body === "string") {
    log.pendingBodies.push({ ...d, frameId, at: Date.now() });
    if (log.pendingBodies.length > MAX_PENDING) log.pendingBodies.shift();
    matchPendingBodies(log);
  }
}

// A body belongs to the oldest finished fetch/XHR from the same frame, with the
// same method, URL and status, that has none yet. Bodies can arrive before the
// request's completion event, so unmatched ones wait a little.
function matchPendingBodies(log) {
  const now = Date.now();
  log.pendingBodies = log.pendingBodies.filter((b) => {
    const entry = log.entries.find(
      (e) =>
        API_TYPES.has(e.type) &&
        e.end &&
        !e.error &&
        e.responseBody == null &&
        e.frameId === b.frameId &&
        e.url === b.url &&
        e.method === b.method &&
        (b.status == null || e.status === b.status) &&
        now - e.start < BODY_MATCH_MS
    );
    if (entry) {
      if (entry.bodiesDropped) return false;
      entry.responseBody = b.body;
      entry.responseBodyTruncated = b.truncated;
      addChars(log, b.body.length);
      return false;
    }
    return now - b.at < 5_000;
  });
}

// --- hiding secrets ----------------------------------------------------------------

// Choro's own notes in place of a body; anything else is page data and gets redacted.
const NOTE = /^\((dropped to save memory|binary, \d+ bytes|not available: [^\n]*)\)$/;

// Query parameters with secret-looking names (?token=, ?api_key=...).
function redactUrl(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_FIELD.test(k)) {
        u.searchParams.set(k, "(hidden)");
        changed = true;
      }
    }
    return changed ? u.href.replace(/%28hidden%29/g, "(hidden)") : url;
  } catch {
    return url;
  }
}

function redactBody(text) {
  if (!text || NOTE.test(text)) return text;
  // Multipart uploads: hide the values of secret-looking fields.
  if (/^--\S+\r?\n/.test(text) && /content-disposition: form-data/i.test(text)) {
    return text.replace(/(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([^\r\n]*)/gi, (all, head, name, value) =>
      SECRET_FIELD.test(name) ? `${head}(hidden)` : all
    );
  }
  // JSON: hide matching keys at any depth.
  try {
    const json = JSON.parse(text);
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELD.test(k) ? "(hidden)" : walk(x)]));
      }
      return v;
    };
    return JSON.stringify(walk(json));
  } catch {
    /* not JSON */
  }
  // Form fields, one per line ("name=value") or URL-encoded ("a=1&b=2").
  return text
    .split("\n")
    .map((line) =>
      line
        .split("&")
        .map((pair) => {
          const i = pair.indexOf("=");
          if (i <= 0) return pair;
          let key = pair.slice(0, i);
          try {
            key = decodeURIComponent(key);
          } catch {
            /* keep raw */
          }
          return SECRET_FIELD.test(key) ? `${pair.slice(0, i)}=(hidden)` : pair;
        })
        .join("&")
    )
    .join("\n");
}

// --- queries ---------------------------------------------------------------------------

export function markAction(tabId, at) {
  if (recording(tabId)) logFor(tabId).lastActionAt = at;
}

const kindOf = (e) => (e.type === "xmlhttprequest" ? "xhr" : e.type);

const shortUrl = (url) => {
  try {
    const u = new URL(url);
    return u.host + u.pathname + (u.search.length > 60 ? u.search.slice(0, 60) + "…" : u.search);
  } catch {
    return url;
  }
};

function statusText(e) {
  if (e.error) return `FAILED (${e.error.replace(/^net::/, "")})`;
  if (e.redirectTo) return `${e.status} → ${shortUrl(e.redirectTo)}`;
  if (e.status != null) return String(e.status);
  return "pending";
}

const failed = (e) => !!e.error || (e.status >= 400 && e.status < 600);

// Validates the filters once, so a typo is an error rather than "everything".
function makeFilter({ url, type, method, status }) {
  if (status && !/^(failed|\dxx|\d{3})$/i.test(status)) {
    throw new Error(`status must be "failed", a class like "4xx", or a code like "404" (got "${status}").`);
  }
  const t = type?.toLowerCase();
  const wantKind = t === "xmlhttprequest" || t === "fetch" ? "xhr" : t;
  return (e) => {
    if (url && !e.url.toLowerCase().includes(url.toLowerCase())) return false;
    if (wantKind && !(wantKind === "api" ? API_TYPES.has(e.type) : kindOf(e) === wantKind)) return false;
    if (method && e.method !== method.toUpperCase()) return false;
    if (status) {
      const s = status.toLowerCase();
      if (s === "failed") return failed(e);
      if (s.endsWith("xx")) return String(e.status ?? "")[0] === s[0];
      return String(e.status) === s;
    }
    return true;
  };
}

function notRecordingMessage(tabId) {
  if (!connected()) return "Choro records network traffic only while an agent is connected.";
  if (!isAgentTab(tabId)) return "Choro records the traffic of tabs an agent works in; this tab isn't one yet.";
  return "No requests recorded for this tab yet.";
}

export function listRequests(tabId, { url, type, method, status, sinceLastAction, limit = 50 } = {}) {
  const log = logs.get(tabId);
  if (!log?.entries.length) return notRecordingMessage(tabId);
  const keep = makeFilter({ url, type, method, status });
  const since = sinceLastAction ? log.lastActionAt || 0 : 0;
  const found = log.entries.filter((e) => e.start >= since && keep(e));
  const shown = found.slice(-Math.max(1, Math.floor(limit)));
  // Long cells (failure reasons, redirects) go last so the columns stay aligned.
  const lines = shown.map((e) => {
    const ms = e.end ? `${Math.round(e.end - e.start)}ms` : "";
    const st = statusText(e);
    const short = e.error ? "FAILED" : e.status != null ? String(e.status) : "pending";
    const extra = st === short ? "" : `  ${st.slice(short.length).trim()}`;
    return `${e.id.padEnd(5)} ${e.method.padEnd(6)} ${short.padEnd(7)} ${kindOf(e).padEnd(10)} ${ms.padStart(7)}  ${shortUrl(redactUrl(e.url))}${extra}`;
  });
  const head =
    `${found.length} request(s)` +
    (found.length > shown.length ? `, showing the last ${shown.length}` : "") +
    `; ${found.filter(failed).length} failed. network_request with an id shows details.`;
  return [head, ...lines].join("\n");
}

function headerLines(headers, showSecrets) {
  if (!headers?.length) return "  (none recorded)";
  return headers
    .map(({ name, value }) =>
      `  ${name}: ${!showSecrets && SECRET_HEADER.test(name) ? `(hidden, ${String(value ?? "").length} chars; showSecrets: true to see)` : value}`
    )
    .join("\n");
}

export function requestDetails(tabId, id, { showSecrets = false, maxLength = 20_000 } = {}) {
  const e = logs.get(tabId)?.entries.find((x) => x.id === id);
  if (!e) throw new Error(`No request ${id} on this tab. network_requests lists them.`);
  const max = Math.max(1, Math.floor(maxLength));
  const cut = (s) => (s.length > max ? `${s.slice(0, max)}\n… [truncated ${s.length - max} characters; raise maxLength]` : s);
  const body = (s) => cut(showSecrets ? s : redactBody(s));
  const parts = [
    `${e.method} ${showSecrets ? e.url : redactUrl(e.url)}`,
    `Status: ${statusText(e)}${e.statusLine ? ` (${e.statusLine})` : ""}${e.fromCache ? ", from cache" : ""}`,
    `Type: ${kindOf(e)}${e.initiator ? `, started by ${e.initiator}` : ""}${e.end ? `, took ${Math.round(e.end - e.start)}ms` : ""}`,
    "",
    "Request headers:",
    headerLines(e.requestHeaders, showSecrets),
  ];
  if (e.requestBody) parts.push("", "Request body:", body(e.requestBody));
  parts.push("", "Response headers:", headerLines(e.responseHeaders, showSecrets));
  if (e.type === "websocket") {
    const msgs = logs.get(tabId).ws.filter((m) => m.url === e.url).slice(-50);
    parts.push("", `WebSocket messages (last ${msgs.length}):`);
    const arrow = { in: "←", out: "→", open: "opened", close: "closed" };
    for (const m of msgs) parts.push(`  ${arrow[m.dir] ?? m.dir} ${showSecrets ? (m.data ?? "") : redactBody(m.data ?? "")}`);
  } else if (e.responseBody != null) {
    parts.push("", `Response body${e.responseBodyTruncated ? " (first 200,000 characters)" : ""}:`, body(e.responseBody));
  } else if (API_TYPES.has(e.type)) {
    parts.push("", "Response body: not captured (not text, still loading, or sent before Choro was watching).");
  } else {
    parts.push("", "Response body: only fetch/XHR bodies are captured; get_source with this URL fetches the file.");
  }
  if (!showSecrets) parts.push("", "(Cookies, tokens and password-like fields are hidden; showSecrets: true shows them.)");
  return parts.join("\n");
}

// Short summary of the requests an action caused, for its result.
export function summarizeSince(tabId, since) {
  const log = logs.get(tabId);
  if (!log) return "";
  const caused = log.entries.filter(
    (e) => e.start >= since && (API_TYPES.has(e.type) || e.type === "main_frame" || e.type === "sub_frame" || e.type === "websocket")
  );
  if (!caused.length) return "";
  const bad = caused.filter(failed);
  const shown = (bad.length ? bad : caused).slice(0, 3).map((e) => `${e.method} ${shortUrl(redactUrl(e.url))} → ${statusText(e)}`);
  return (
    `\nNetwork: ${caused.length} request(s)${bad.length ? `, ${bad.length} failed` : ""}: ${shown.join("; ")}` +
    (caused.length > shown.length ? " …" : "") +
    " (network_requests with sinceLastAction: true lists them)"
  );
}

// Waits for a matching request that finishes after the last action (or after
// this call, if there was none), so "click Save, then wait for the POST" works
// even though the POST started during the click.
export async function waitForRequest(tabId, { includeEarlier, ...filters }, timeoutMs) {
  const keep = makeFilter(filters);
  const start = Date.now();
  const since = includeEarlier ? 0 : logs.get(tabId)?.lastActionAt || start;
  while (Date.now() - start < timeoutMs) {
    const log = logs.get(tabId);
    const hit = log?.entries.findLast((e) => (e.error || (e.end && !e.redirectTo)) && (e.end ?? 0) >= since && keep(e));
    if (hit) {
      return (
        `${hit.id} ${hit.method} ${shortUrl(redactUrl(hit.url))} → ${statusText(hit)}` +
        (hit.responseBody != null ? ` (${hit.responseBody.length} chars of body; network_request ${hit.id} shows it)` : "")
      );
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (!recording(tabId)) throw new Error(notRecordingMessage(tabId));
  throw new Error(`No matching request finished within ${timeoutMs}ms (${JSON.stringify(filters)}).`);
}
