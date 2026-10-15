// Connection to the local Choro server.
//
// The extension connects to ws://127.0.0.1:<port> and the two sides prove to
// each other that they know the pairing key (a secret the user copies from
// `choro-mcp pair` into the popup once). The server sends a nonce S; the
// extension answers with its own nonce E and HMAC(key, "extension:S:E:port");
// the server answers with HMAC(key, "server:S:E:port"). Both proofs cover both
// nonces and the port, so they can't be replayed, reflected or relayed to a
// server on another port, and the key itself never crosses the wire. Until both
// check out, nothing the socket says is acted on.

import { sleep } from "./util.js";

const DEFAULT_PORT = 8765;
const PING_INTERVAL_MS = 20_000; // also keeps the background alive while connected
// While no server runs, retries back off from 2 s to 30 s: every failed attempt
// shows up as an error on the browser's extensions page, which Choro can't suppress.
const RECONNECT_DELAY_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const PROTOCOL = 2;
const BUILT_IN_KEY = null; // test builds only (tools/build.mjs --test-key); real installs pair in the popup

let ws = null;
let status = "disconnected"; // disconnected | connecting | connected | unpaired
let lastError = "";
let reconnectTimer = null;
let connectPromise = null;
let wasConnected = false;
let handlers = { onCommand: async () => {}, onSessions: () => {}, onStatus: () => {} };

export const isConnected = () => status === "connected";
export const getStatus = () => ({ status, lastError });

export function initConnection(h) {
  handlers = { ...handlers, ...h };
}

async function getPort() {
  const { port } = await chrome.storage.local.get("port");
  const p = Number(port);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : DEFAULT_PORT;
}

async function isEnabled() {
  const { enabled } = await chrome.storage.local.get("enabled");
  return enabled !== false;
}

async function getKey() {
  const { pairingKey = BUILT_IN_KEY } = await chrome.storage.local.get("pairingKey");
  return /^[0-9a-f]{64}$/.test(pairingKey || "") ? pairingKey : null;
}

// --- HMAC (Web Crypto) ---------------------------------------------------------

const hexToBytes = (hex) => new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
const bytesToHex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n = 32) => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));

async function hmac(keyHex, message) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

// Constant-time comparison of two hex strings.
function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- status ------------------------------------------------------------------------

function setStatus(next, error = "") {
  status = next;
  lastError = error;
  const action = chrome.action ?? chrome.browserAction; // Firefox's build is Manifest V2
  action.setBadgeText({ text: next === "connected" ? "ON" : next === "unpaired" ? "!" : "" });
  action.setBadgeBackgroundColor({ color: next === "unpaired" ? "#b71c1c" : "#2e7d32" });
  chrome.runtime.sendMessage({ type: "status", status, lastError }).catch(() => {}); // the popup, if open
  // The rest of Choro only cares whether an agent is connected; retries flip
  // between connecting and disconnected and must not reach every tab each time.
  if ((next === "connected") !== wasConnected) {
    wasConnected = next === "connected";
    handlers.onStatus(status);
  }
}

// --- retry pacing ----------------------------------------------------------------------
// Kept in storage.session: the background is suspended and woken often (any
// navigation can wake it), and must not retry on every wake.

async function retryState() {
  const { retry } = await chrome.storage.session.get("retry");
  return retry || { delay: RECONNECT_DELAY_MS, nextAt: 0 };
}

async function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  if (!(await isEnabled())) return;
  const { delay } = await retryState();
  await chrome.storage.session.set({ retry: { delay: Math.min(delay * 2, RECONNECT_MAX_MS), nextAt: Date.now() + delay } });
  reconnectTimer = setTimeout(connect, delay);
}

const resetRetry = () => chrome.storage.session.set({ retry: { delay: RECONNECT_DELAY_MS, nextAt: 0 } });

// --- connecting ----------------------------------------------------------------------

// Several triggers (startup, install, alarm, wake-ups, popup) may call this at once.
export function connect() {
  connectPromise ??= openSocket().finally(() => (connectPromise = null));
  return connectPromise;
}

async function openSocket() {
  if (!(await isEnabled())) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // Not before the next retry is due (this may be a wake-up from some unrelated event).
  const { nextAt } = await retryState();
  if (Date.now() < nextAt) {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, nextAt - Date.now());
    return;
  }
  clearTimeout(reconnectTimer);

  const port = await getPort();
  if (status !== "unpaired") setStatus("connecting");
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch (err) {
    setStatus("disconnected", `Can't connect to port ${port}: ${err.message}`);
    scheduleReconnect();
    return;
  }
  ws = socket;
  let authed = false;
  let serverNonce = null;
  let myNonce = null;
  let key = null;
  let closeReason = "";
  let pingTimer = null;

  // Messages are handled strictly in order: checking the server's proof takes a
  // moment, and what the server sends right after its welcome must wait for it.
  let queue = Promise.resolve();
  socket.onmessage = (event) => {
    queue = queue.then(() => handleMessage(event)).catch(() => {});
  };

  const handleMessage = async (event) => {
    if (ws !== socket) return; // a connection Choro already gave up on
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (!authed) {
      if (msg.type === "challenge" && typeof msg.nonce === "string") {
        if (msg.protocol !== PROTOCOL) {
          closeReason = msg.protocol > PROTOCOL ? "extension-old" : "server-old";
          socket.close(4004, "protocol mismatch");
          return;
        }
        key = await getKey();
        if (!key) {
          closeReason = "unpaired";
          socket.send(JSON.stringify({ type: "auth", role: "extension", proof: null }));
          return;
        }
        serverNonce = msg.nonce;
        myNonce = randomHex();
        const proof = await hmac(key, `extension:${serverNonce}:${myNonce}:${port}`);
        socket.send(
          JSON.stringify({ type: "auth", role: "extension", proof, nonce: myNonce, protocol: PROTOCOL, version: chrome.runtime.getManifest().version })
        );
      } else if (msg.type === "welcome" && key && myNonce) {
        if (!sameHex(msg.proof, await hmac(key, `server:${serverNonce}:${myNonce}:${port}`))) {
          closeReason = "badserver";
          socket.close(4003, "server failed the pairing check");
          return;
        }
        if (ws !== socket) return;
        authed = true;
        await resetRetry();
        setStatus("connected");
        pingTimer = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
        }, PING_INTERVAL_MS);
      }
      return; // nothing else counts before both sides are authenticated
    }

    if (msg.type === "sessions" && Array.isArray(msg.ids)) {
      await Promise.resolve(handlers.onSessions(msg.ids)).catch(() => {});
      return;
    }
    if (msg.id == null || typeof msg.method !== "string") return;
    // Not awaited: a long command must not hold up the ones after it.
    handlers.onCommand(msg.method, msg.params || {}).then(
      (result) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ id: msg.id, result })),
      (err) =>
        socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ id: msg.id, error: String(err?.message || err) }))
    );
  };

  socket.onclose = (event) => {
    clearInterval(pingTimer);
    if (ws !== socket) return;
    ws = null;
    if (closeReason === "unpaired" || event.code === 4001) {
      setStatus(
        "unpaired",
        closeReason === "unpaired"
          ? "Not paired yet. Run `npx -y choro-mcp@latest pair` in a terminal and paste the key below."
          : "The server rejected the pairing key. Run `npx -y choro-mcp@latest pair` and paste the key it shows."
      );
    } else if (closeReason === "server-old" || closeReason === "extension-old" || event.code === 4004) {
      setStatus(
        "disconnected",
        closeReason === "server-old"
          ? "The Choro server is older than this extension. Restart the agent session so it runs the latest choro-mcp."
          : "This extension is older than the Choro server. Update it: the browser store does so within a day, or remove and reinstall it."
      );
    } else if (closeReason === "badserver") {
      setStatus("unpaired", `The program on port ${port} doesn't know the pairing key, so Choro didn't trust it.`);
    } else if (event.code === 4002) {
      setStatus("disconnected", "Another browser is connected to this Choro server; Choro will connect when it leaves.");
    } else {
      setStatus("disconnected", authed ? "" : `No Choro server on port ${port}.`);
    }
    scheduleReconnect();
  };
  socket.onerror = () => {}; // onclose follows and handles it
}

export function disconnect() {
  clearTimeout(reconnectTimer);
  const socket = ws;
  ws = null; // its handlers now ignore it; onclose still stops its ping
  socket?.close();
  setStatus("disconnected");
}

// Reconnect now (popup button, new key or port): start the backoff over.
export async function reconnect() {
  await resetRetry();
  disconnect();
  await sleep(50);
  return connect();
}

// The background can be suspended while no server is running; this alarm
// wakes it periodically so it notices when the server comes up.
chrome.alarms.create("choro-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "choro-reconnect") connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
