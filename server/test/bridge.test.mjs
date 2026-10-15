// Tests the server's bridge without a browser: real Choro servers on a free port,
// MCP clients for them, and a fake extension that pairs like the real one.
// Run: npm test (from server/)

import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket, WebSocketServer } from "ws";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (key, msg) => createHmac("sha256", Buffer.from(key, "hex")).update(msg).digest("hex");

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "choro-test-"));
const env = { ...process.env, CHORO_CONFIG_DIR: configDir };
let port;
let key;
const sessions = [];

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function startSession(label) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...env, CHORO_PORT: String(port) },
    stderr: "pipe",
  });
  const logs = [];
  transport.stderr.on("data", (d) => logs.push(String(d)));
  const client = new Client({ name: `test-${label}`, version: "0" });
  await client.connect(transport);
  const s = { label, client, transport, logs, role: () => (logs.join("").match(/(hub|peer): /g) || []).at(-1)?.slice(0, -2) };
  sessions.push(s);
  return s;
}

async function eventually(fn, what, ms = 8000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      return await fn();
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`${what}: ${last?.message}`);
}

async function call(session, name = "list_tabs") {
  const res = await session.client.callTool({ name, arguments: {} });
  if (res.isError) throw new Error(res.content[0].text);
  return JSON.parse(res.content[0].text);
}

// A fake extension: pairs with `withKey`, answers every call with what it got.
function fakeExtension({ withKey = key, origin = "chrome-extension://fake", reconnect = true, protocol = 2 } = {}) {
  const ext = { seen: [], up: false, closes: [], stop: false };
  const open = () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    const myNonce = randomBytes(32).toString("hex");
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "challenge") {
        ext.challenge = msg.nonce;
        ws.send(
          JSON.stringify({ type: "auth", role: "extension", proof: withKey ? hmac(withKey, `extension:${msg.nonce}:${myNonce}:${port}`) : null, nonce: myNonce, protocol })
        );
      } else if (msg.type === "welcome") {
        ext.serverProved = msg.proof === hmac(key, `server:${ext.challenge}:${myNonce}:${port}`);
        ext.up = true;
        ext.ws = ws;
      } else if (msg.type === "sessions") {
        ext.sessions = msg.ids;
      } else if (msg.id != null) {
        ext.seen.push(msg);
        ws.send(JSON.stringify({ id: msg.id, result: { method: msg.method, session: msg.params._session } }));
      }
    });
    ws.on("close", (code) => {
      ext.up = false;
      ext.closes.push(code);
      if (reconnect && !ext.stop) setTimeout(open, 200);
    });
    ws.on("error", () => {});
  };
  open();
  ext.close = () => {
    ext.stop = true;
    ext.ws?.close();
  };
  return ext;
}

// Raw connection attempt: what does the hub answer to `auth`?
function rawAttempt({ origin, auth, sendRaw }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    const got = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      got.push(msg);
      if (msg.type === "challenge") ws.send(sendRaw ?? JSON.stringify(auth(msg.nonce)));
    });
    ws.on("unexpected-response", (_, res) => resolve({ rejectedHandshake: res.statusCode, got }));
    ws.on("close", (code) => resolve({ code, got }));
    ws.on("error", () => {});
    setTimeout(() => {
      ws.terminate();
      resolve({ timeout: true, got });
    }, 6000);
  });
}

before(async () => {
  port = await freePort();
});

after(async () => {
  for (const s of sessions) await s.transport.close().catch(() => {});
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("pairing and sharing", () => {
  let a, b, ext, sessionB;

  test("the first server becomes the hub and creates a private key", async () => {
    a = await startSession("A");
    await eventually(async () => assert.equal(a.role(), "hub"), "A becomes hub");
    const file = path.join(configDir, "pairing-key");
    key = fs.readFileSync(file, "utf8").trim();
    assert.match(key, /^[0-9a-f]{64}$/);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
  });

  test("a paired extension connects, and the server proves itself too", async () => {
    ext = fakeExtension();
    await eventually(async () => assert.ok(ext.up), "extension connects");
    assert.equal(ext.serverProved, true);
  });

  test("a second server joins as a peer, and both reach the extension as different sessions", async () => {
    b = await startSession("B");
    await eventually(async () => assert.equal(b.role(), "peer"), "B becomes peer");
    const ra = await eventually(() => call(a), "A's call");
    const rb = await eventually(() => call(b), "B's call");
    sessionB = rb.session;
    assert.ok(ra.session && rb.session);
    assert.notEqual(ra.session, rb.session);
    await eventually(async () => assert.deepEqual([...ext.sessions].sort(), [ra.session, rb.session].sort()), "sessions list");
  });

  test("an extension without the key is turned away, and tools say so", async () => {
    const r = await rawAttempt({ origin: "chrome-extension://other", auth: () => ({ type: "auth", role: "extension", proof: null }) });
    assert.equal(r.code, 4001);
  });

  test("an extension with a wrong key is turned away", async () => {
    const wrong = randomBytes(32).toString("hex");
    const r = await rawAttempt({
      origin: "chrome-extension://other",
      auth: (n) => ({ type: "auth", role: "extension", proof: hmac(wrong, `extension:${n}:x:${port}`), nonce: "x", protocol: 2 }),
    });
    assert.equal(r.code, 4001);
    assert.ok(!r.got.some((m) => m.type === "welcome"));
  });

  test("a local process can't pose as the extension even with an extension origin and the peer path", async () => {
    const r = await rawAttempt({ origin: "chrome-extension://evil", auth: (n) => ({ type: "auth", role: "peer", proof: hmac(key, `peer:${n}:x:${port}`), nonce: "x", protocol: 2 }) });
    assert.equal(r.code, 4001); // peers must not send an Origin; extensions must prove the key
  });

  test("web pages can't connect at all", async () => {
    const r = await rawAttempt({ origin: "https://evil.example", auth: () => ({}) });
    assert.ok(r.rejectedHandshake);
  });

  test("garbage and null messages don't crash the hub", async () => {
    for (const sendRaw of ["null", "42", "not json", "{}", '{"type":"auth"}']) {
      await rawAttempt({ origin: undefined, sendRaw, auth: () => ({}) });
    }
    await eventually(() => call(a), "hub still answers");
  });

  test("an extension with another protocol version is turned away", async () => {
    const r = await rawAttempt({
      origin: "chrome-extension://future",
      auth: (n) => ({ type: "auth", role: "extension", proof: hmac(key, `extension:${n}:x:${port}`), nonce: "x", protocol: 99 }),
    });
    assert.equal(r.code, 4004);
  });

  test("a proof made for another port (a relayed handshake) is refused", async () => {
    const r = await rawAttempt({
      origin: "chrome-extension://relay",
      auth: (n) => ({ type: "auth", role: "extension", proof: hmac(key, `extension:${n}:x:${port + 1}`), nonce: "x", protocol: 2 }),
    });
    assert.equal(r.code, 4001);
  });

  test("a second browser waits instead of taking over", async () => {
    const second = fakeExtension({ origin: "chrome-extension://second", reconnect: false });
    await eventually(async () => assert.deepEqual(second.closes, [4002]), "second browser refused");
    assert.ok(ext.up);
  });

  test("when the hub's session ends, the peer takes over (keeping its session id) and the extension follows", async () => {
    await a.transport.close();
    await eventually(async () => assert.equal(b.role(), "hub"), "B takes over", 10000);
    const r = await eventually(() => call(b), "B's call after hand-off", 10000);
    assert.equal(r.session, sessionB, "B keeps its session id, and so its tabs, across the hand-off");
    await eventually(async () => assert.deepEqual(ext.sessions, [r.session]), "sessions update");
  });

  test("two peers racing for a dead hub end with exactly one hub", async () => {
    const c = await startSession("C");
    const d = await startSession("D");
    await eventually(async () => assert.ok(c.role() === "peer" && d.role() === "peer"), "C and D join");
    await b.transport.close();
    await eventually(async () => {
      const roles = [c.role(), d.role()].sort();
      assert.deepEqual(roles, ["hub", "peer"]);
    }, "one hub, one peer", 10000);
    await eventually(() => call(c), "C works");
    await eventually(() => call(d), "D works");
    ext.close();
    for (const s of [c, d]) await s.transport.close();
  });
});

describe("lifecycle", () => {
  test("a server whose input ends exits and frees the port", async () => {
    const { spawn } = await import("node:child_process");
    const p = await freePort();
    const child = spawn(process.execPath, [SERVER], { env: { ...env, CHORO_PORT: String(p) }, stdio: ["ignore", "ignore", "ignore"] });
    const exited = await new Promise((resolve) => {
      child.on("exit", () => resolve(true));
      setTimeout(() => resolve(false), 5000);
    });
    if (!exited) child.kill();
    assert.ok(exited, "server still running after its input ended");
  });
});

describe("something else on the port", () => {
  test("a server that isn't Choro is never mistaken for the hub", async () => {
    const squatter = new WebSocketServer({ host: "127.0.0.1", port });
    squatter.on("connection", (ws) => ws.send(JSON.stringify({ type: "welcome", proof: "0".repeat(64) })));
    try {
      const s = await startSession("E");
      await sleep(3000);
      assert.equal(s.role(), undefined);
      const res = await s.client.callTool({ name: "list_tabs", arguments: {} });
      assert.ok(res.isError);
      assert.match(res.content[0].text, /still connecting/);
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  });
});
