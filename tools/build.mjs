#!/usr/bin/env node
// Builds the browser extension for Chrome and Firefox from extension/.
//
//   node tools/build.mjs            -> dist/chrome/, dist/firefox/
//   node tools/build.mjs --zip      -> also dist/choro-chrome-<version>.zip and dist/choro-firefox-<version>.zip
//   node tools/build.mjs --port 8798 --test-key <hex> --out dist-test
//                                   (test builds: another server port, a built-in pairing key)
//
// The two builds share every file; only the manifest differs. Code that needs a
// Chrome-only API (chrome.debugger) checks for it at runtime.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension");

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const zip = args.includes("--zip");
const port = option("--port") ? Number(option("--port")) : null;
if (option("--port") && !(port > 0 && port < 65536)) throw new Error("--port needs a port number");
const testKey = option("--test-key");
if (testKey && !/^[0-9a-f]{64}$/.test(testKey)) throw new Error("--test-key needs a 64-character hex key");
if ((port || testKey) && !option("--out")) throw new Error("--port and --test-key are for test builds: give an --out directory");
if ((port || testKey) && zip) throw new Error("test builds (--port, --test-key) can't be zipped for release");
const DIST = path.resolve(ROOT, option("--out") || "dist");

// Firefox gets Manifest V2. In Firefox's MV3, screenshots are impossible:
// tabs.captureVisibleTab and tabs.captureTab require <all_urls> as an API
// permission, which MV3 extensions can't have (only a temporary pass after the
// user clicks the toolbar button). Firefox fully supports MV2, and every API
// Choro uses (scripting, page-world scripts, storage.session, webRequest) works
// there. Also: no debugger API, an add-on id, the data-collection declaration
// Mozilla now requires (Choro sends nothing anywhere but to the local server),
// and an explicit CSP (Firefox's default for extensions upgrades ws:// to wss://).
function firefoxManifest(m) {
  const out = structuredClone(m);
  out.manifest_version = 2;
  out.background = { scripts: [m.background.service_worker], type: "module" };
  out.permissions = [...m.permissions.filter((p) => p !== "debugger"), ...m.host_permissions];
  delete out.host_permissions;
  out.browser_action = m.action;
  delete out.action;
  out.content_security_policy = m.content_security_policy.extension_pages;
  out.browser_specific_settings = {
    gecko: {
      id: "choro@ivogeorgief",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] },
    },
    // data_collection_permissions needs Firefox 140, or 142 on Android.
    gecko_android: { strict_min_version: "142.0" },
  };
  delete out.minimum_chrome_version;
  return out;
}

function build(target, transform) {
  const dir = path.join(DIST, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SRC, dir, { recursive: true, filter: (p) => !p.endsWith(".svg") || !p.includes(`${path.sep}icons${path.sep}`) });
  const manifest = transform(JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8")));
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const patch = (file, re, replacement) => {
    const p = path.join(dir, file);
    const code = fs.readFileSync(p, "utf8");
    const patched = code.replace(re, replacement);
    if (patched === code) throw new Error(`couldn't patch ${file} (${re})`);
    fs.writeFileSync(p, patched);
  };
  if (port) patch("bg/connection.js", /^const DEFAULT_PORT = \d+;/m, `const DEFAULT_PORT = ${port};`);
  if (testKey) patch("bg/connection.js", /^const BUILT_IN_KEY = null;/m, `const BUILT_IN_KEY = "${testKey}";`);
  if (zip) {
    const file = path.join(DIST, `choro-${target}-${manifest.version}.zip`);
    fs.rmSync(file, { force: true });
    execFileSync("zip", ["-qr", file, "."], { cwd: dir });
    console.log(`  ${path.relative(ROOT, file)}`);
  }
  console.log(`built ${path.relative(ROOT, dir)}${port ? ` (server port ${port})` : ""}${testKey ? " (test key built in)" : ""}`);
}

build("chrome", (m) => m);
build("firefox", firefoxManifest);
