# choro-mcp

The MCP server for Choro: it lets coding agents (Claude Code or any MCP
client) drive your real Chrome or Firefox (your open tabs, with your logins) through the Choro browser extension.

```sh
claude mcp add choro -- npx -y choro-mcp@latest   # add it to Claude Code
npx -y choro-mcp@latest pair                         # show the key to paste into the extension's popup (once)
```

Other MCP clients: run `npx -y choro-mcp@latest` as a stdio server.

You also need the Choro browser extension; see the [project's README](https://github.com/ivogeorgief/choro#readme) for installing it, the tools agents get, and
the security model. In short: the server listens on 127.0.0.1 (port `CHORO_PORT`, default 8765), the extension
connects to it, and both prove they know the pairing key before anything else happens. Several agent sessions can
share one browser, and several browsers can be connected at once; the first server to start relays for the others.

```
choro-mcp              run the MCP server (MCP clients start this)
choro-mcp pair         show the pairing key
choro-mcp pair --new   make a new pairing key
choro-mcp --version
```

Environment: `CHORO_PORT` (default 8765), `CHORO_CONFIG_DIR` (where the pairing key is kept; default
`$XDG_CONFIG_HOME/choro` or `~/.config/choro`, `%APPDATA%\choro` on Windows). Needs Node.js 20 or newer.

MIT © Ivo Georgief
