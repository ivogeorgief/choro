// The link between agent sessions and the browser extension.
//
// The extension, in one or more browsers, connects to one local port. The first
// Choro server to start owns it (the hub); servers of later agent sessions connect
// to the hub as peers, and
// their calls are forwarded, tagged with a session id the hub assigns, so the
// extension can keep each session's tabs apart. When the hub's session ends, the
// peers race to take the port over and the extension reconnects to the winner.
//
// Everyone proves knowledge of the pairing key (see key.js) before anything else
// happens. The hub sends a nonce S; the other side answers with its own nonce C
// and HMAC(key, "<role>:S:C:port"); the hub answers with HMAC(key, "server:S:C:port").
// Each proof covers both nonces, the role and the port, so none can be replayed,
// reflected or relayed to a hub on another port; the key never crosses the wire.
// So the extension and peers only talk to a real Choro hub, and the hub only
// accepts them.
// Web pages can't take part at all: browsers mark their connections with an
// http(s) Origin, which the hub refuses.

import http from "node:http";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { ensureKey, readKey } from "./key.js";

const HOST = "127.0.0.1";
// Raised only for changes the other side can't handle. Extension and server update
// separately (browser stores, npm), so a mismatch must say which one is behind.
const PROTOCOL = 2;
const DEFAULT_TIMEOUT_MS = 60_000;
const AUTH_TIMEOUT_MS = 5_000;
const MAX_UNAUTHENTICATED = 4; // connections waiting to pair; more are dropped at once
const PEER_HEARTBEAT_MS = 15_000;
const HEARTBEAT_MS = 20_000;
const MAX_PAYLOAD = 64 * 1024 * 1024; // screenshots of long pages are big
const EXTENSION_ORIGIN = /^(chrome-extension|moz-extension):\/\//;
const MAX_BROWSERS = 4;
const ROUTE_TIMEOUT_MS = 5_000; // asking each browser whether it has a tab

const log = (...args) => console.error("[choro]", ...args); // stdout is the MCP channel

const hmac = (key, message) => createHmac("sha256", Buffer.from(key, "hex")).update(message).digest("hex");
const nonce = () => randomBytes(32).toString("hex");

function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function parse(raw) {
  try {
    const msg = JSON.parse(raw.toString());
    return msg && typeof msg === "object" ? msg : null;
  } catch {
    return null;
  }
}

const send = (ws, msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

export function createBridge({ port }) {
  const startKey = ensureKey();
  // Re-read on every handshake, so `choro-mcp pair --new` takes effect without restarts.
  const currentKey = () => readKey() ?? startKey;
  const session = randomUUID(); // this server's own session (when it is the hub)
  let role = null; // "hub" | "peer" | null while finding its place
  let closing = false;

  // Hub state
  let wss = null;
  let httpHub = null;
  // The authenticated extensions, one per browser (or browser profile), in the
  // order they connected: socket -> { name, instance }.
  const browsers = new Map();
  const sessionBrowser = new Map(); // session id -> the socket its calls without a tab go to
  let pairingFailedAt = 0; // an extension tried to connect with no or a wrong key
  let extensionProtocol = null; // {protocol, at} of an extension turned away for its version
  const peers = new Map(); // peer socket -> session id
  const inFlight = new Map(); // extension request id -> { done, timer, socket }
  let nextExtId = 1;

  // Peer state
  let hub = null;
  const calls = new Map(); // call id -> { resolve, reject, timer }
  let nextCallId = 1;

  // --- hub -----------------------------------------------------------------------

  function startHub() {
    return new Promise((resolve) => {
      // Plain HTTP requests get an empty answer: the extension checks with one
      // whether a server is up before opening a WebSocket, because a failed
      // WebSocket shows up as an error on the browser's extensions page.
      const httpServer = http.createServer((req, res) => {
        res.writeHead(204, { "Cache-Control": "no-store" });
        res.end();
      });
      const server = new WebSocketServer({
        server: httpServer,
        maxPayload: MAX_PAYLOAD,
        // Browser pages always send their own http(s) Origin; only the extension
        // (its extension origin) and local processes (no Origin) get further.
        verifyClient: ({ origin }) => !origin || EXTENSION_ORIGIN.test(origin),
      });
      const onStartError = (err) => {
        if (err.code !== "EADDRINUSE") log("websocket server error:", err.message);
        server.close();
        httpServer.close();
        resolve(false);
      };
      // The WebSocket server passes on the HTTP server's errors and "listening".
      server.once("error", onStartError);
      server.once("listening", () => {
        server.off("error", onStartError);
        server.on("error", (err) => log("websocket server error:", err.message));
        server.on("connection", authenticate);
        wss = server;
        httpHub = httpServer;
        role = "hub";
        log(`hub: waiting for the browser extension on ws://${HOST}:${port}`);
        resolve(true);
      });
      httpServer.listen(port, HOST);
    });
  }

  // Every connection starts with the challenge; nothing else is accepted until
  // the answer checks out. Only a few connections may wait at once, so local
  // programs can't pile up unauthenticated connections (and large messages).
  let unauthenticated = 0;
  function authenticate(ws, req) {
    ws.on("error", (err) => log("connection error:", err.message));
    if (unauthenticated >= MAX_UNAUTHENTICATED) return ws.terminate();
    unauthenticated++;
    let waiting = true;
    const done = () => {
      if (waiting) unauthenticated--;
      waiting = false;
    };
    ws.once("close", done);
    const origin = req.headers.origin;
    const challenge = nonce();
    const key = currentKey();
    const timer = setTimeout(() => ws.close(4001, "no pairing answer"), AUTH_TIMEOUT_MS);
    send(ws, { type: "challenge", nonce: challenge, protocol: PROTOCOL });
    ws.once("message", (raw) => {
      clearTimeout(timer);
      done();
      const msg = parse(raw);
      const asExtension = msg?.role === "extension" && !!origin;
      const asPeer = msg?.role === "peer" && !origin;
      const valid =
        msg?.type === "auth" &&
        (asExtension || asPeer) &&
        typeof msg.nonce === "string" &&
        sameHex(msg.proof, hmac(key, `${msg.role}:${challenge}:${msg.nonce}:${port}`));
      if (!valid) {
        if (asExtension) pairingFailedAt = Date.now(); // an extension (by its origin) without the right key
        ws.close(4001, msg?.proof ? "wrong pairing key" : "not paired");
        return;
      }
      if (msg.protocol !== PROTOCOL) {
        if (asExtension) extensionProtocol = { protocol: msg.protocol, at: Date.now() };
        ws.close(4004, `protocol ${PROTOCOL} required`);
        return;
      }
      const welcome = { type: "welcome", proof: hmac(key, `server:${challenge}:${msg.nonce}:${port}`), protocol: PROTOCOL };
      if (asExtension) acceptExtension(ws, msg, welcome);
      else acceptPeer(ws, msg, welcome);
    });
  }

  function acceptExtension(ws, msg, welcome) {
    // The same extension reconnecting (its old socket not closed yet) replaces itself.
    const instance = typeof msg.instance === "string" ? msg.instance.slice(0, 64) : null;
    for (const [other, b] of browsers) if (instance && b.instance === instance) other.terminate();
    if (openBrowsers().length >= MAX_BROWSERS) {
      ws.close(4002, "too many browsers are connected");
      return;
    }
    send(ws, welcome);
    const base = typeof msg.browser === "string" && /^[\w .-]{1,32}$/.test(msg.browser) ? msg.browser : "Browser";
    const names = new Set(openBrowsers().map((o) => browsers.get(o).name));
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
    browsers.set(ws, { name, instance });
    pairingFailedAt = 0;
    log(`${name} connected (extension version ${msg.version ?? "?"}; ${browsers.size} browser${browsers.size > 1 ? "s" : ""})`);
    sendSessions();

    // A browser that vanished without closing the socket must not hold its place.
    let alive = true;
    ws.on("pong", () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);

    ws.on("message", (raw) => {
      const m = parse(raw);
      if (!m) return;
      if (m.type === "ping") return send(ws, { type: "pong" });
      const call = inFlight.get(m.id);
      if (!call || call.socket !== ws) return;
      inFlight.delete(m.id);
      clearTimeout(call.timer);
      call.done(m.error ? new Error(String(m.error)) : null, m.result);
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      if (browsers.delete(ws)) log(`${name} disconnected`);
      for (const [id, b] of sessionBrowser) if (b === ws) sessionBrowser.delete(id);
      for (const [id, call] of inFlight) {
        if (call.socket !== ws) continue;
        inFlight.delete(id);
        clearTimeout(call.timer);
        call.done(new Error(`${name} (the browser extension) disconnected while handling the request.`));
      }
    });
  }

  // A peer keeps the session id it had (its tabs survive the hub handing over),
  // unless that id is taken by a live session; then the hub assigns a new one.
  function acceptPeer(ws, msg, welcome) {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const taken = (id) => id === session || [...peers.values()].includes(id);
    const id = UUID.test(msg.session) && !taken(msg.session) ? msg.session : randomUUID();
    send(ws, welcome);
    peers.set(ws, id);
    log(`session ${id.slice(0, 8)} joined (${peers.size + 1} sessions)`);
    sendSessions();
    ws.on("message", (raw) => {
      const m = parse(raw);
      if (m?.type !== "call" || typeof m.method !== "string") return;
      const params = m.params && typeof m.params === "object" ? m.params : {};
      routeCall(m.method, { ...params, _session: id }, Number(m.timeoutMs) || DEFAULT_TIMEOUT_MS, (err, result) =>
        send(ws, { type: "result", id: m.id, result, error: err?.message })
      );
    });
    ws.on("close", () => {
      peers.delete(ws);
      sessionBrowser.delete(id);
      log(`session ${id.slice(0, 8)} left (${peers.size + 1} sessions)`);
      sendSessions();
    });
  }

  // Tells the extension which sessions exist, so tabs held by sessions that ended become free.
  function sendSessions() {
    for (const b of browsers.keys()) send(b, { type: "sessions", ids: [session, ...peers.values()] });
  }

  function notConnected() {
    if (extensionProtocol && Date.now() - extensionProtocol.at < 120_000) {
      const older = !(extensionProtocol.protocol > PROTOCOL);
      return new Error(
        older
          ? "The Choro browser extension is older than this server and can't talk to it. Update the extension " +
              "(the browser store updates it within a day; to update now, remove and reinstall it)."
          : "The Choro browser extension is newer than this server. Update the server: restart the agent session " +
              "(it runs `npx -y choro-mcp@latest`), or update choro-mcp if you installed it."
      );
    }
    if (pairingFailedAt && Date.now() - pairingFailedAt < 120_000) {
      return new Error(
        "The Choro browser extension tried to connect but isn't paired with this computer's key. Run " +
          "`npx -y choro-mcp@latest pair` in a terminal and paste the key into the extension's popup."
      );
    }
    return new Error(
      "The Choro browser extension is not connected. Make sure the browser is open, the extension is installed, " +
        `enabled and paired (\`npx -y choro-mcp@latest pair\`), and set to port ${port} (click its icon to check).`
    );
  }

  const openBrowsers = () => [...browsers.keys()].filter((b) => b.readyState === WebSocket.OPEN);

  function sendTo(ws, method, params, timeoutMs, done) {
    const id = nextExtId++;
    const timer = setTimeout(() => {
      inFlight.delete(id);
      done(new Error(`Timed out after ${timeoutMs}ms waiting for the browser to run "${method}".`));
    }, timeoutMs);
    inFlight.set(id, { done, timer, socket: ws });
    ws.send(JSON.stringify({ id, method, params }));
  }

  const ask = (ws, method, params, timeoutMs) =>
    new Promise((resolve, reject) => sendTo(ws, method, params, timeoutMs, (err, result) => (err ? reject(err) : resolve(result))));

  // With several browsers connected, each call goes to one of them: the one named
  // by `browser`, else the one holding `tabId`, else the session's browser (the one
  // it last worked in, at first the one connected longest). list_tabs asks them all.
  function routeCall(method, { browser: wanted, ...params }, timeoutMs, done) {
    const open = openBrowsers();
    if (!open.length) return done(notConnected());
    const nameOf = (ws) => browsers.get(ws).name;
    const sid = params._session;
    let target = null;
    if (typeof wanted === "string" && wanted) {
      target = open.find((ws) => nameOf(ws).toLowerCase() === wanted.toLowerCase().trim());
      if (!target) return done(new Error(`No browser named "${wanted}" is connected. Connected: ${open.map(nameOf).join(", ")}.`));
    }
    const mine = () => (open.includes(sessionBrowser.get(sid)) ? sessionBrowser.get(sid) : open[0]);
    const go = (ws) => {
      if (target || params.tabId != null || method === "open_tab") sessionBrowser.set(sid, ws);
      sendTo(ws, method, params, timeoutMs, done);
    };
    if (target || open.length === 1) return go(target ?? open[0]);

    if (method === "list_tabs") {
      const current = mine();
      return Promise.all(
        open.map((ws) =>
          ask(ws, "list_tabs", params, ROUTE_TIMEOUT_MS).then(
            (tabs) => (Array.isArray(tabs) ? tabs : []).map((t) => ({ browser: nameOf(ws), ...t, current: ws === current && t.current })),
            (err) => [{ browser: nameOf(ws), error: err.message }]
          )
        )
      ).then((lists) => done(null, lists.flat()), done);
    }
    if (params.tabId == null) return go(mine());

    // Tab ids are only unique within one browser: find the ones that have it.
    Promise.all(
      open.map((ws) =>
        ask(ws, "list_tabs", { _session: sid }, ROUTE_TIMEOUT_MS).then(
          (tabs) => Array.isArray(tabs) && tabs.some((t) => t.id === params.tabId),
          () => false
        )
      )
    ).then((has) => {
      const holders = open.filter((_, i) => has[i]);
      if (holders.length > 1 && !holders.includes(sessionBrowser.get(sid))) {
        return done(
          new Error(
            `Tab ${params.tabId} exists in ${holders.map(nameOf).join(" and ")}. Pass browser to say which one ` +
              "(select_tab with browser makes it this session's browser)."
          )
        );
      }
      go(holders.length > 1 ? sessionBrowser.get(sid) : (holders[0] ?? mine()));
    }, done);
  }

  // --- peer ------------------------------------------------------------------------

  let warnedProtocol = false;
  let peerProtocol = null; // the hub's protocol, when it differs from ours

  function connectAsPeer() {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://${HOST}:${port}`, { maxPayload: MAX_PAYLOAD });
      const myNonce = nonce();
      const key = currentKey();
      let challenge = null;
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) ws.terminate();
        resolve(ok);
      };
      // Something that isn't a Choro hub (or has another key) never completes this.
      const timer = setTimeout(() => finish(false), AUTH_TIMEOUT_MS);
      ws.on("error", () => finish(false));
      ws.on("unexpected-response", () => finish(false));
      ws.on("message", (raw) => {
        const msg = parse(raw);
        if (!msg) return;
        if (!settled) {
          if (msg.type === "challenge" && typeof msg.nonce === "string") {
            if (msg.protocol !== PROTOCOL) {
              if (!warnedProtocol) {
                warnedProtocol = true;
                log(
                  `another agent session runs a ${msg.protocol > PROTOCOL ? "newer" : "older"} choro-mcp (protocol ` +
                    `${msg.protocol}, this one ${PROTOCOL}); restart one of the sessions so both use the same version`
                );
              }
              peerProtocol = msg.protocol;
              return finish(false);
            }
            challenge = msg.nonce;
            send(ws, {
              type: "auth",
              role: "peer",
              proof: hmac(key, `peer:${challenge}:${myNonce}:${port}`),
              nonce: myNonce,
              session, // keep this session's id, and so its tabs, across hand-offs
              protocol: PROTOCOL,
            });
          } else if (msg.type === "welcome") {
            if (!challenge || !sameHex(msg.proof, hmac(key, `server:${challenge}:${myNonce}:${port}`))) return finish(false);
            hub = ws;
            role = "peer";
            peerProtocol = null;
            log(`peer: sharing the browser connection through the hub on port ${port}`);
            // A hub that hangs (rather than exits) must not leave this session stuck.
            let alive = true;
            ws.on("pong", () => (alive = true));
            const beat = setInterval(() => {
              if (!alive) return ws.terminate();
              alive = false;
              ws.ping();
            }, PEER_HEARTBEAT_MS);
            ws.once("close", () => clearInterval(beat));
            finish(true);
          }
          return;
        }
        const call = calls.get(msg.id);
        if (msg.type !== "result" || !call) return;
        calls.delete(msg.id);
        clearTimeout(call.timer);
        if (msg.error) call.reject(new Error(String(msg.error)));
        else call.resolve(msg.result);
      });
      ws.on("close", () => {
        finish(false);
        if (hub !== ws) return;
        hub = null;
        role = null;
        for (const [id, call] of calls) {
          clearTimeout(call.timer);
          call.reject(
            new Error(
              "The browser connection moved to another session while this ran, so it may or may not have happened. " +
                "Check (e.g. take a snapshot) before trying again."
            )
          );
          calls.delete(id);
        }
        if (!closing) {
          log("the hub went away; taking over or finding the new hub");
          findPlace();
        }
      });
    });
  }

  // --- finding our place ------------------------------------------------------------

  let finding = null;
  function findPlace() {
    finding ??= (async () => {
      let attempts = 0;
      while (!role && !closing) {
        if (await startHub()) break;
        if (await connectAsPeer()) break;
        // Right after a hand-off the winner may still be starting; only persistent failure is worth a word.
        if (++attempts === 5) {
          log(`port ${port} is held by a program that isn't a Choro server with this computer's pairing key; still trying`);
        }
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
      }
    })().finally(() => (finding = null));
    return finding;
  }

  // --- calls from this session -------------------------------------------------------

  function call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (role === "hub") {
      return new Promise((resolve, reject) =>
        routeCall(method, { ...params, _session: session }, timeoutMs, (err, result) => (err ? reject(err) : resolve(result)))
      );
    }
    if (role === "peer" && hub?.readyState === WebSocket.OPEN) {
      const id = nextCallId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for the browser to run "${method}".`));
        }, timeoutMs + 1000); // the hub's own timeout answers first
        calls.set(id, { resolve, reject, timer });
        send(hub, { type: "call", id, method, params, timeoutMs });
      });
    }
    if (peerProtocol != null) {
      return Promise.reject(
        new Error(
          `Another agent session runs a ${peerProtocol > PROTOCOL ? "newer" : "older"} choro-mcp, and the two can't share ` +
            "the browser. Restart that session (or this one) so both run the same version."
        )
      );
    }
    return Promise.reject(
      new Error("Choro is still connecting to the browser (or taking over from a session that just ended). Try again in a moment.")
    );
  }

  function close() {
    closing = true;
    wss?.close();
    httpHub?.close();
    hub?.close();
  }

  return { findPlace, call, close };
}
