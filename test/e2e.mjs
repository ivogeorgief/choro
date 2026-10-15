#!/usr/bin/env node
// End-to-end test in real browsers, separate from the ones you use: builds the
// extension with a throwaway pairing key, starts a Choro server on a spare port,
// launches Chromium and/or Firefox with a temporary profile and the extension,
// and drives the test pages (test/*.html) through the MCP tools.
//
//   node test/e2e.mjs                 both browsers
//   node test/e2e.mjs chromium        or: firefox
//   node test/e2e.mjs --headed        watch it (default: headless)
//
// Needs: Node 18+, `npm install` in server/, python3 (for test/serve.py), and
// chromium and/or firefox on the PATH (CHROMIUM / FIREFOX override the binaries).
// Firefox is driven through Mozilla's web-ext, fetched with npx on first use.

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sdk = (p) => import(pathToFileURL(path.join(ROOT, "server/node_modules/@modelcontextprotocol/sdk/dist/esm", p)).href);
const { Client } = await sdk("client/index.js");
const { StdioClientTransport } = await sdk("client/stdio.js");

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const browsers = args.filter((a) => !a.startsWith("--"));
const which = browsers.length ? browsers : ["chromium", "firefox"];
const SITE = "http://127.0.0.1:8701";
const WORK = path.join(ROOT, "dist-test"); // inside the repo: snap-packaged browsers can't read /tmp
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

const isListening = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });

function which_(cmd) {
  try {
    return execFileSync("which", [cmd], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// --- one browser run -------------------------------------------------------------------

async function run(browser) {
  const results = [];
  const check = async (name, fn) => {
    try {
      const note = await fn();
      results.push(`PASS  ${name}${note ? `  (${note})` : ""}`);
    } catch (err) {
      results.push(`FAIL  ${name}: ${String(err.message).split("\n")[0].slice(0, 300)}`);
    }
  };

  const port = await freePort();
  const key = randomBytes(32).toString("hex");
  const dir = path.join(WORK, browser);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "pairing-key"), key + "\n", { mode: 0o600 });
  execFileSync(process.execPath, [path.join(ROOT, "tools/build.mjs"), "--port", String(port), "--test-key", key, "--out", path.join(dir, "ext")], { stdio: "ignore" });

  // An agent session: its own choro-mcp process (the first becomes the hub, later ones join it).
  const serverLog = [];
  async function startSession(label) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "server/index.js")],
      env: { ...process.env, CHORO_PORT: String(port), CHORO_CONFIG_DIR: path.join(dir, "config") },
      stderr: "pipe",
    });
    transport.stderr.on("data", (d) => serverLog.push(`[${label}] ${d}`));
    const client = new Client({ name: `choro-e2e-${label}`, version: "0" });
    await client.connect(transport);
    const tool = async (name, a = {}) => {
      const res = await client.callTool({ name, arguments: a }, undefined, { timeout: 130_000 });
      const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (res.isError) throw new Error(text);
      return { text, images: res.content.filter((c) => c.type === "image") };
    };
    const text = async (name, a) => (await tool(name, a)).text;
    // evaluate returns strings as they are; JSON.stringify in the page makes every value one.
    const evaluate = async (expression, tabId) =>
      JSON.parse(await text("evaluate", { expression: `JSON.stringify(${expression})`, ...(tabId != null && { tabId }) }));
    return { transport, tool, text, evaluate };
  }
  const sessionA = await startSession("A");
  const { transport, tool, text, evaluate } = sessionA;
  let sessionB = null;

  let proc;
  const start = `${SITE}/torture.html?nologin`;
  if (browser === "chromium") {
    const bin = process.env.CHROMIUM || which_("chromium") || which_("chromium-browser");
    if (!bin) return [`SKIP  chromium: not installed`];
    proc = spawn(
      bin,
      [
        `--user-data-dir=${path.join(dir, "profile")}`,
        `--load-extension=${path.join(dir, "ext/chrome")}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-first-run",
        "--no-default-browser-check",
        "--window-size=1280,900",
        ...(process.env.CI ? ["--no-sandbox"] : []), // CI runners (Ubuntu 24.04) restrict the sandbox's user namespaces
        ...(headed ? [] : ["--headless=new"]),
        start,
      ],
      { stdio: "ignore" }
    );
  } else {
    const bin = process.env.FIREFOX || which_("firefox");
    if (!bin) return [`SKIP  firefox: not installed`];
    proc = spawn(
      "npx",
      [
        "-y",
        "web-ext@8",
        "run",
        "--source-dir",
        path.join(dir, "ext/firefox"),
        "--firefox",
        bin,
        "--firefox-profile",
        path.join(dir, "profile"),
        "--profile-create-if-missing",
        "--no-reload",
        "--no-input",
        "--start-url",
        start,
        ...(headed ? [] : ["--arg=-headless"]),
      ],
      { stdio: "ignore", detached: true }
    );
  }

  try {
    await check(`${browser}: extension pairs and connects`, async () => {
      for (let i = 0; i < 60; i++) {
        try {
          await text("list_tabs");
          return;
        } catch (err) {
          if (i === 59) throw err;
          await sleep(1000);
        }
      }
    });
    if (results.at(-1).startsWith("FAIL")) return results;

    // Find the test tab and make it this session's.
    const tabs = JSON.parse(await text("list_tabs"));
    const tab = tabs.find((t) => t.url?.startsWith(SITE)) ?? JSON.parse(await text("open_tab", { url: start })).opened;
    await text("select_tab", { tabId: tab.id });

    // --- torture.html: frames, shadow DOM, dialogs -------------------------------------
    await check("snapshot reaches shadow DOM, same-origin and cross-origin frames", async () => {
      const snap = await text("snapshot", { interactiveOnly: true });
      for (const s of ["Shadow closed", "Deep button", "Cross button", "Send now"]) if (!snap.includes(s)) throw new Error(`missing "${s}"`);
      if (snap.includes("Hidden ad link")) throw new Error("hidden 0x0 frame leaked into the snapshot");
      return null;
    });
    await check("a cross-origin frame added just before the snapshot still shows", async () => {
      await evaluate(`(() => { const f = document.createElement("iframe"); f.id = "late"; f.width = 300; f.height = 60;
        f.src = document.getElementById("cross").src + "?late"; document.body.append(f); return true; })()`);
      const snap = await text("snapshot", { interactiveOnly: true });
      await evaluate(`(document.getElementById("late").remove(), true)`);
      const n = (snap.match(/button "Cross button" \[f\d+:e\d+\]/g) || []).length;
      if (n !== 2) throw new Error(`${n} cross-origin frames in the snapshot, expected 2`);
    });
    await check("click by name, through shadow DOM and frames", async () => {
      for (const n of ["Shadow closed", "Deep button", "Send now", "Row two"]) await text("click", { name: n });
      const t = await evaluate("window.__t");
      if (!(t.shadow_closed && t.deep && t.split && t.row === "2")) throw new Error(JSON.stringify(t));
    });
    await check("click inside the cross-origin frame (simulated)", async () => {
      const snap = await text("snapshot", { interactiveOnly: true });
      const ref = /button "Cross button" \[(f\d+:e\d+)\]/.exec(snap)?.[1];
      if (!ref) throw new Error("no frame ref");
      await text("click", { ref });
      if ((await evaluate("window.__t.cross_click")) !== "synthetic") throw new Error("not recorded");
    });
    await check("dialog option answers confirm and prompt in the page", async () => {
      const r1 = await text("click", { name: "Confirm", dialog: "accept" });
      const r2 = await text("click", { name: "Prompt", dialog: "accept", promptText: "e2e" });
      if (!/was accepted/.test(r1 + r2)) throw new Error(r1 + r2);
      const t = await evaluate("window.__t");
      if (t.confirm !== true || t.prompt !== "e2e") throw new Error(JSON.stringify(t));
    });
    if (browser === "chromium") {
      await check("an unexpected dialog is reported and answered with handle_dialog", async () => {
        let err = "";
        try {
          await text("click", { name: "Two dialogs" });
        } catch (e) {
          err = e.message;
        }
        if (!/blocked by a confirm dialog saying "First\?"/.test(err)) throw new Error(`no report: ${err}`);
        await text("handle_dialog", { accept: true });
        await sleep(600);
        await text("handle_dialog", { accept: false });
        const two = await evaluate("window.__t.two");
        if (JSON.stringify(two) !== "[true,false]") throw new Error(JSON.stringify(two));
      });
      await check("trusted click inside the cross-origin frame", async () => {
        const snap = await text("snapshot", { interactiveOnly: true });
        const ref = /button "Cross button" \[(f\d+:e\d+)\]/.exec(snap)?.[1];
        await text("click", { ref, trusted: true });
        if ((await evaluate("window.__t.cross_click")) !== "trusted") throw new Error("not trusted");
      });
    } else {
      await check("Firefox explains that trusted input isn't available", async () => {
        try {
          await text("click", { name: "Trusted only", trusted: true });
        } catch (e) {
          if (/Firefox doesn't have/.test(e.message)) return;
          throw e;
        }
        throw new Error("no error");
      });
    }
    await check("full-page screenshot", async () => {
      const { images } = await tool("screenshot", { fullPage: true, format: "png" });
      if (!images.length || images[0].data.length < 10_000) throw new Error("no image");
      return `${Math.round(images[0].data.length / 1024)} KB`;
    });

    // --- torture2.html: controls, widgets, refusals ----------------------------------------
    await text("navigate", { url: `${SITE}/torture2.html` });
    await check("form controls and widgets", async () => {
      await text("type", { selector: "#date", text: "2026-10-07" });
      await text("type", { selector: "#time", text: "14:30" });
      await text("fill_form", { fields: [{ selector: "#color", value: "#ff0000" }, { selector: "#range", value: "70" }, { selector: "#number", value: "25" }] });
      await text("set_checked", { name: "Medium", checked: true });
      await text("select_option", { selector: "#multi", value: ["Ham", "Olives"] });
      await text("type", { selector: "#maxlen", text: "abcdefgh" });
      await text("type", { selector: "#combo", text: "ban" });
      await text("click", { name: "Banana" });
      await text("click", { name: "Choose a city ▾" });
      await text("click", { name: "Varna" });
      await text("type", { name: "Model editor", text: "hello model" });
      await text("click", { name: "Open modal" });
      await text("click", { name: "Modal OK" });
      await text("click", { selector: "#canvas", offsetX: 250, offsetY: 30 });
      await text("drag", { name: "Drag me", to: { selector: "#drop" } });
      await text("type", { selector: "#unicode", text: "Здравей 🎉 日本語" });
      await text("type", { name: "Shadow email", text: "shadow@x.bg" });
      await text("click", { name: "Shadow submit" });
      const s = await evaluate("window.__summary");
      if (s.FAIL.length) throw new Error(`failed: ${s.FAIL.join(", ")}`);
      return `${s.PASS.length} page checks passed`;
    });
    await check("upload_file: file input, hidden input behind a button, drop zone", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "choro-e2e-upload-"));
      const a = path.join(dir, "notes.txt");
      const b = path.join(dir, "data.json");
      const bin = path.join(dir, "pixel.png");
      fs.writeFileSync(a, "héllo upload");
      fs.writeFileSync(b, '{"x":1}');
      fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]));
      try {
        await text("upload_file", { name: "Attachments", paths: [a, b] });
        await text("upload_file", { name: "Choose a file…", paths: [a] });
        await text("upload_file", { selector: "#dropzone", paths: [bin] });
        const t = await evaluate("window.__t");
        const want = {
          file_plain: ["notes.txt:13:text/plain:héllo upload", 'data.json:7:application/json:{"x":1}'],
          file_hidden: ["notes.txt:13:text/plain:héllo upload"],
        };
        for (const [k, v] of Object.entries(want)) if (JSON.stringify(t[k]) !== JSON.stringify(v)) throw new Error(`${k}: ${JSON.stringify(t[k])}`);
        if (!/^pixel\.png:8:image\/png:/.test(t.dropped?.[0] || "")) throw new Error(`dropped: ${JSON.stringify(t.dropped)}`);
        const refused = await tool("upload_file", { selector: "#file-hidden", paths: [a, b] }).then(() => null, (e) => e.message);
        if (!/takes one file/.test(refused || "")) throw new Error(`two files on a single-file input: ${refused}`);
        const relative = await tool("upload_file", { selector: "#file-plain", paths: ["notes.txt"] }).then(() => null, (e) => e.message);
        if (!/absolute path/.test(relative || "")) throw new Error(`relative path: ${relative}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    await check("refuses what a person couldn't do", async () => {
      const errors = [];
      for (const [name, a] of [["type", { selector: "#readonly", text: "x" }], ["click", { name: "Log out" }]]) {
        try {
          await text(name, a);
          errors.push(`${name} went through`);
        } catch (e) {
          if (!/read-only|hidden/.test(e.message)) errors.push(e.message);
        }
      }
      if (errors.length) throw new Error(errors.join("; "));
    });

    // --- network.html: traffic and source ------------------------------------------------------
    await text("navigate", { url: `${SITE}/network.html` });
    await check("actions report the requests they cause", async () => {
      const r = await text("click", { name: "Fetch 500" });
      if (!/Network: 1 request\(s\), 1 failed/.test(r)) throw new Error(r);
    });
    await check("request and response bodies, with secrets hidden", async () => {
      await text("click", { name: "Fetch POST JSON" });
      await text("click", { name: "XHR login form" });
      await text("wait_for_request", { url: "/api/login", includeEarlier: true });
      const list = await text("network_requests", { method: "POST" });
      const ids = [...list.matchAll(/^(r\d+)\s+POST/gm)].map((m) => m[1]);
      const details = await Promise.all(ids.map((id) => text("network_request", { id })));
      const json = details.find((d) => d.includes("/api/echo"));
      const login = details.find((d) => d.includes("/api/login"));
      if (!json?.includes('"city":"Sofia"') || !json.includes("Response body")) throw new Error("JSON POST details missing");
      if (!login || login.includes("hunter2") || !login.includes("password=(hidden)")) throw new Error(`password not hidden: ${login}`);
    });
    await check("WebSocket messages", async () => {
      await text("click", { name: "WebSocket hello" });
      await sleep(800);
      const id = /^(r\d+)/m.exec(await text("network_requests", { type: "websocket" }))?.[1];
      const d = await text("network_request", { id });
      if (!/→ hello from the page/.test(d) || !/← echo: hello from the page/.test(d)) throw new Error(d);
    });
    await check("get_source reads the page and its script", async () => {
      const page = await text("get_source");
      const script = await text("get_source", { url: "network-app.js" });
      if (!page.includes("<title>Choro network test</title>") || !script.includes("XMLHttpRequest")) throw new Error("source missing");
    });

    // --- two agent sessions at once -----------------------------------------------------------
    sessionB = await startSession("B");
    const b = sessionB;
    let tabA, tabB;
    await check("a second session joins and gets its own tab", async () => {
      for (let i = 0; ; i++) {
        try {
          await b.text("list_tabs");
          break;
        } catch (err) {
          if (i === 30) throw err;
          await sleep(500);
        }
      }
      tabA = JSON.parse(await text("open_tab", { url: `${SITE}/torture2.html` })).opened.id;
      tabB = JSON.parse(await b.text("open_tab", { url: `${SITE}/network.html` })).opened.id;
      const seenByB = JSON.parse(await b.text("list_tabs"));
      const usage = (id) => seenByB.find((t) => t.id === id)?.usedBy;
      if (usage(tabB) !== "you" || usage(tabA) !== "another session") throw new Error(JSON.stringify(seenByB.map((t) => [t.id, t.usedBy])));
    });
    await check("a session can't take another session's tab", async () => {
      for (const [name, a] of [["select_tab", { tabId: tabA }], ["snapshot", { tabId: tabA }], ["close_tab", { tabId: tabA }]]) {
        try {
          await b.text(name, a);
          throw new Error(`${name} on the other session's tab went through`);
        } catch (err) {
          if (!/in use by another agent session/.test(err.message)) throw err;
        }
      }
    });
    await check("both sessions work in their tabs at the same time", async () => {
      const long = "parallel ".repeat(300); // keeps session A busy while B works
      const t0 = Date.now();
      const [typed, clicked, snapB] = await Promise.all([
        text("type", { selector: "#long", text: long }),
        b.text("click", { name: "Fetch POST JSON" }),
        b.text("snapshot", { interactiveOnly: true }),
      ]);
      const took = Date.now() - t0;
      if (!/value is now "parallel/.test(typed)) throw new Error(`A: ${typed}`);
      if (!/Network: 1 request\(s\): POST/.test(clicked)) throw new Error(`B: ${clicked}`);
      if (!snapB.includes("Fetch POST JSON") || snapB.includes("Choose a city")) throw new Error("B's snapshot isn't of B's tab");
      // Each tab got only its own session's input.
      const aLong = await evaluate("window.__t.long", tabA);
      const bPost = (await b.text("network_requests", { method: "POST", tabId: tabB })).includes("/api/echo");
      const aPost = await text("network_requests", { method: "POST", tabId: tabA });
      if (aLong !== long.length || !bPost || aPost.includes("/api/echo")) throw new Error(`crossed over: ${aLong} ${bPost} ${aPost}`);
      return `${took} ms for both`;
    });
    await check("simultaneous screenshots each show their own tab", async () => {
      const [shotA, shotB] = await Promise.all([tool("screenshot", { tabId: tabA }), b.tool("screenshot", { tabId: tabB })]);
      if (!shotA.images.length || !shotB.images.length) throw new Error("missing image");
      if (!/Choro torture test 2/.test(shotA.text) || !/Choro network test/.test(shotB.text)) throw new Error(`${shotA.text} / ${shotB.text}`);
      if (shotA.images[0].data === shotB.images[0].data) throw new Error("both sessions got the same picture");
    });
    await check("when the first session ends, the second carries on and its tabs are freed", async () => {
      await transport.close();
      for (let i = 0; ; i++) {
        try {
          await b.text("snapshot", { interactiveOnly: true, tabId: tabB });
          break;
        } catch (err) {
          if (i === 40) throw err;
          await sleep(500);
        }
      }
      await b.text("select_tab", { tabId: tabA }); // A's tab is free now
    });
  } catch (err) {
    results.push(`FAIL  ${browser}: ${err.message}`);
  } finally {
    await transport.close().catch(() => {});
    await sessionB?.transport.close().catch(() => {});
    if (browser === "firefox") {
      try {
        process.kill(-proc.pid, "SIGTERM"); // web-ext and the Firefox it started
      } catch {}
    } else {
      proc.kill("SIGTERM");
    }
    await sleep(1000);
  }
  if (results.some((r) => r.startsWith("FAIL"))) results.push(`--- server log (${browser}) ---\n${serverLog.join("").slice(-3000)}`);
  return results;
}

// --- main ---------------------------------------------------------------------------------------

let site = null;
if (!(await isListening(8701))) {
  site = spawn("python3", [path.join(ROOT, "test/serve.py")], { stdio: "ignore" });
  for (let i = 0; i < 50 && !(await isListening(8701)); i++) await sleep(100);
}
const all = [];
for (const b of which) {
  console.log(`\n== ${b}`);
  const r = await run(b);
  console.log(r.join("\n"));
  all.push(...r);
}
site?.kill();
// In CI a missing browser is a failure, not a skip: otherwise CI passes without testing it.
const failed = all.filter((r) => r.startsWith("FAIL") || (process.env.CI && r.startsWith("SKIP"))).length;
console.log(`\n${all.filter((r) => r.startsWith("PASS")).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
