#!/usr/bin/env node
// Choro: lets coding agents (Claude Code or any MCP client) drive your real
// browser through the Choro extension.
//
//   choro-mcp            run the MCP server (stdio); this is what MCP clients start
//   choro-mcp pair       show the pairing key to paste into the extension
//   choro-mcp pair --new make a new key (paired browsers need the new one)
//
// Environment: CHORO_PORT (default 8765) is the local port the extension
// connects to; CHORO_CONFIG_DIR overrides where the pairing key is kept.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { createBridge } from "./src/bridge.js";
import { ensureKey, keyFile } from "./src/key.js";
import { PREPARE, TOOLS, toContent } from "./src/tools.js";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const PORT = Number(process.env.CHORO_PORT || 8765);
const log = (...args) => console.error("[choro]", ...args); // stdout is the MCP channel

const [command, ...flags] = process.argv.slice(2);
const KNOWN = { undefined: [], "--version": [], "-v": [], "--help": [], "-h": [], help: [], pair: ["--new"] };

if (!Object.hasOwn(KNOWN, String(command)) || flags.some((f) => !KNOWN[command].includes(f))) {
  // Anything unexpected must not quietly start a server on the real port.
  console.error(`Unknown ${Object.hasOwn(KNOWN, String(command)) ? "option" : "command"}: ${process.argv.slice(2).join(" ")}. Run choro-mcp --help.`);
  process.exitCode = 2;
} else if (command === "--version" || command === "-v") {
  console.log(version);
} else if (command === "--help" || command === "-h" || command === "help") {
  console.log(`choro-mcp ${version}: browser control for coding agents (MCP server)

Usage:
  choro-mcp              run the MCP server (MCP clients start this; it speaks MCP on stdin/stdout)
  choro-mcp pair         show the pairing key to paste into the Choro extension's popup
  choro-mcp pair --new   make a new pairing key (browsers paired with the old one need the new one)

Environment:
  CHORO_PORT             local port the extension connects to (default 8765)
  CHORO_CONFIG_DIR       where the pairing key is kept (default: $XDG_CONFIG_HOME/choro or
                         ~/.config/choro; %APPDATA%\\choro on Windows)

Set it up in Claude Code with:
  claude mcp add choro -- npx -y choro-mcp@latest`);
} else if (command === "pair") {
  const key = ensureKey({ replace: flags.includes("--new") });
  console.log(`Pairing key (kept in ${keyFile()}):

  ${key}

Click the Choro icon in your browser's toolbar, paste the key into "Pairing key" and click Pair.
Anyone with this key can control your browser through Choro, so keep it private.${
    flags.includes("--new") ? "\nRunning Choro servers switch to the new key by themselves; browsers need it pasted in again." : ""
  }`);
} else {
  await runServer();
}

async function runServer() {
  if (!(PORT > 0 && PORT < 65536 && Number.isInteger(PORT))) throw new Error(`CHORO_PORT must be a port number, not "${process.env.CHORO_PORT}".`);
  const bridge = createBridge({ port: PORT });
  const server = new McpServer({ name: "choro", version });

  for (const [name, description, inputSchema, timeoutMs] of TOOLS) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const params = PREPARE[name] ? await PREPARE[name](args) : args;
        return { content: toContent(name, await bridge.call(name, params, timeoutMs)) };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    });
  }

  bridge.findPlace(); // tools say "still connecting" until this server has its place
  await server.connect(new StdioServerTransport());
  log(`MCP server ${version} ready on stdio`);

  // Exit with the agent session, so the port is never held by a leftover process.
  const shutdown = (code = 0) => {
    bridge.close();
    process.exit(code);
  };
  // stdin ends (or closes) when the agent session goes away; a parent that died
  // without closing it (e.g. an npx wrapper killed) is caught by watching the parent.
  process.stdin.once("end", () => shutdown());
  process.stdin.once("close", () => shutdown());
  const parent = process.ppid;
  setInterval(() => process.ppid !== parent && shutdown(), 2000).unref();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => shutdown());
  process.on("uncaughtException", (err) => {
    log("fatal:", err.stack || err.message);
    shutdown(1);
  });
}
