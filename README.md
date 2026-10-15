<p align="center"><img src="extension/icons/icon128.png" width="96" height="96" alt=""></p>

# Choro

**Let coding agents use your real browser.** Choro gives Claude Code (or any MCP client) the tabs you already have
open in Chrome or Firefox, with your logins: read pages, click, type, fill forms, take screenshots, follow network
traffic and read source code, on the sites you actually use.

```
agent ──MCP (stdio)──▶ choro-mcp ──WebSocket on 127.0.0.1, paired──▶ Choro extension ──▶ your tabs
```

Unlike headless automation, Choro works in the browser you are looking at. It is built for the pages that make
automation hard: shadow DOM, iframes (cross-origin too), rich text editors, script-driven buttons, popups and
`alert` dialogs, single-page apps, password managers.

## Setup

You need Node.js 20 or newer, and Chrome (or another Chromium browser) 116+ or Firefox 128+.

1. **Install the extension.**
   - Chrome: download `choro-chrome-<version>.zip` from the [releases](../../releases) and unzip it (or build it,
     see [Development](#development)). Open `chrome://extensions`, turn on *Developer mode*, click *Load unpacked*
     and pick the unzipped folder.
   - Firefox: install it from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/choro/) or the
     `choro-firefox-<version>.xpi` (signed by Mozilla) from the [releases](../../releases). For development, build it
     and load `dist/firefox/manifest.json` from `about:debugging` → *This Firefox* → *Load Temporary Add-on*.
2. **Add the server to your agent.** For Claude Code:
   ```sh
   claude mcp add choro -- npx -y choro-mcp@latest
   ```
   Other MCP clients: run `npx -y choro-mcp@latest` as a stdio server, e.g.
   `{"mcpServers": {"choro": {"command": "npx", "args": ["-y", "choro-mcp@latest"]}}}`. On Windows, use
   `cmd /c npx -y choro-mcp@latest` as the command.
3. **Pair them.** Run `npx -y choro-mcp@latest pair`, click the Choro icon in the browser's toolbar, paste the key into
   *Pairing key* and click *Pair*. This is needed once per browser.

The extension's icon shows a green **ON** while an agent is connected (and a red **!** if it isn't paired). Its
popup can pause agent control or change the port. The default is 8765; to use another, set it in the popup and give
the server the same one: `claude mcp add -e CHORO_PORT=9000 choro -- npx -y choro-mcp@latest`.

## What agents can do

| Tool | What it does |
| --- | --- |
| `list_tabs`, `open_tab`, `select_tab`, `close_tab` | Work with your tabs. Without `tabId`, a call targets the tab the session last used, or the active one. |
| `navigate`, `go_back`, `go_forward`, `reload` | Navigate and wait until the page is usable. |
| `snapshot` | A text outline of the page with a ref like `[e12]` on every link, button and field, including script-driven buttons, shadow DOM and the contents of iframes (inside cross-origin ones refs look like `[f3:e12]`). |
| `get_text`, `get_html`, `get_source` | The page's text and live HTML; its source as the server sent it, or any script or stylesheet. |
| `screenshot` | The visible area, the whole page (scrolled and stitched) or one element. |
| `click`, `hover`, `type`, `press_key`, `drag` | Input on an element given by `ref`, CSS `selector` or `name` (its visible text or label). `click` also takes `offsetX`/`offsetY` (canvases). |
| `fill_form`, `select_option`, `set_checked`, `submit_form` | Forms: text, date/time/color/range/number inputs, selects (also multiple), checkboxes, radios and switches, with validation errors reported. |
| `upload_file` | Attach local files to a file input (also a hidden one behind an "Upload" button) or drop them on a drag-and-drop zone; no file dialog opens. Up to 32 MB per call. |
| `scroll`, `wait_for` | Scroll the page, an element into view, or inside a container (feeds, virtual lists); wait for text or an element. |
| `handle_dialog` | Answer an `alert`, `confirm` or `prompt` that blocks the page. |
| `network_requests`, `network_request`, `wait_for_request` | The tab's requests with status and timing, one request's headers and bodies, or waiting for one (e.g. the POST a Save button sends). |
| `list_frames`, `evaluate` | Every frame on the page; run JavaScript in the page. |

Every action reports what it caused: a new page or URL, new tabs, downloads, dialogs, blocked popups and the
network requests it triggered (with failures). Actions a person couldn't take are refused with the reason:
clicking a disabled button or one behind a modal, typing into a read-only field.

**Simulated and trusted input.** By default input is simulated with the full sequence of DOM events, which works
with React, Vue, rich text editors and the like and shows no UI. A few sites ignore simulated events; for them pass
`trusted: true` (Chrome only) and Choro sends real input through Chrome's debugger. Chrome shows a "being
debugged" bar while that runs.

**Dialogs.** Pass `dialog: "accept"` or `"dismiss"` (and `promptText`) to the action that opens an
`alert`/`confirm`/`prompt`, and Choro answers it in the page. Otherwise the next call reports the dialog and its
text, and `handle_dialog` answers it (in Chrome; in Firefox only the user can).

**Several agents at once.** Any number of agent sessions can share the browser. The first `choro-mcp` to start
owns the port and the others connect through it; when it exits, another one takes over. Each session has its own
current tab and can't touch tabs another session is working in. `list_tabs` shows which are whose.

### Chrome and Firefox

Everything works in both, except what needs Chrome's debugger API, which Firefox doesn't have: `trusted` input,
`handle_dialog` (use the `dialog` option instead), screenshots of elements larger than the window (Firefox gets the
visible part), and `evaluate` on pages whose Content Security Policy forbids `eval`. The Firefox build uses Manifest
V2, because Firefox lets Manifest V3 extensions take screenshots only right after the user clicks their icon.

## Security and privacy

Choro gives whoever controls the agent the same access to your browser that you have, including sites you're
logged into. Treat it like that.

- **Pairing.** The server and the extension only talk after both prove they know the pairing key (an HMAC
  challenge-response in both directions, bound to both nonces and the port; the key never crosses the connection).
  The key is kept in `~/.config/choro/pairing-key` (`$XDG_CONFIG_HOME/choro` if set; on Windows `%APPDATA%\choro`),
  readable only by you. Without it, nothing else — another program on your computer, another user, another
  extension — can command the extension or impersonate the server. `choro-mcp pair --new` makes a new key: running
  servers switch to it by themselves, and browsers need it pasted in again.
- **Local only.** The server listens on 127.0.0.1. Web pages can't connect to it: browsers mark their connections
  with the page's origin, which the server refuses.
- **Nothing leaves your machine.** Choro sends nothing anywhere except between the extension and the local server.
- **Only where an agent works.** The page hooks Choro uses (to see dialogs, popups and network bodies) are switched
  on only in tabs an agent works in, and network traffic is recorded only for those tabs, in memory. Cookies,
  tokens and password-like fields (also in URLs, form uploads and WebSocket messages) are hidden from agents unless
  they ask with `showSecrets`. A page an agent is working in can tell that Choro is there (its hooks are visible to
  the page's scripts); other pages see the hooks' inactive wrappers at most.
- **Switch it off** with *Allow agent control* in the popup.

Found a security problem? Please report it privately; see [SECURITY.md](SECURITY.md).

## Limits

- Browsers don't let extensions into their own pages (`chrome://`, `about:`), the extension stores, or other
  extensions. `file://` pages need *Allow access to file URLs* (Chrome).
- Chrome won't attach its debugger to a tab that contains a frame from another extension. Password managers such
  as LastPass add one to pages with login forms. There, `trusted` input and `handle_dialog` don't work; simulated
  input and the `dialog` option do. `list_frames` shows such frames.
- Cross-origin frames are reached through refs from a snapshot; `selector` and `name` search the page, its
  same-origin frames and shadow roots.
- "Leave site?" dialogs can only be answered by you. Chrome cancels a dialog when you switch to another tab.
- Screenshots need the browser window not to be minimized.
- Simulated clicks don't count as user gestures, so browsers may block the popups they open. Choro says so; a
  `trusted` click (Chrome) gets through.

## Development

```
extension/        the browser extension (one source for Chrome and Firefox)
  background.js   entry point; bg/ holds its modules (connection, sessions, commands, dialogs, network...)
  page.js         runs in pages: snapshots, refs, simulated input
  page-hooks.js   page-world hooks for dialogs, popups and network bodies (only while connected)
server/           the MCP server, published to npm as choro-mcp
tools/build.mjs   builds dist/chrome and dist/firefox (--zip for release archives)
test/             hard test pages, their web server, and the end-to-end test
```

```sh
cd server && npm install && npm test   # the server: pairing, sharing, hand-off (no browser needed)
node tools/build.mjs                    # dist/chrome and dist/firefox
node test/e2e.mjs                       # end to end in separate Chromium and Firefox instances
```

The end-to-end test builds the extension with a throwaway key, starts servers on a spare port and drives
`test/torture.html`, `torture2.html` and `network.html` in fresh, headless Chromium and Firefox profiles (your own
browser is never touched), including two agent sessions working at once. It needs python3 and `chromium` and
`firefox` on the PATH (or `CHROMIUM` / `FIREFOX` set to the binaries); a missing browser is skipped, except in CI.
`--headed` shows the browsers. The test pages can also be opened by hand: `python3 test/serve.py`, then
`http://127.0.0.1:8701/torture.html`.

## License

[MIT](LICENSE) © Ivo Georgief
