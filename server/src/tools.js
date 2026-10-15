// The MCP tools. Each one is forwarded to the browser extension, which does the work.

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const count = (what, max) => z.number().int().positive().max(max).optional().describe(what);

const tabId = z
  .number()
  .int()
  .optional()
  .describe(
    "Target tab id (from list_tabs). Defaults to the tab this session last worked with, or the active tab. Tabs " +
      "another agent session is using are off limits."
  );
const ref = z
  .string()
  .optional()
  .describe('Element ref from the latest snapshot, e.g. "e12", or "f3:e12" inside a cross-origin frame. Preferred over selector.');
const selector = z.string().optional().describe("CSS selector, used when no ref is given. Also searches same-origin iframes and shadow roots.");
const name = z
  .string()
  .optional()
  .describe(
    'Target the element by its visible text or label (e.g. "Send"), used when no ref or selector is given. Exact ' +
      "matches win; partial matches only count for buttons, links and fields. Useful for script-driven buttons."
  );
const dialog = z
  .enum(["accept", "dismiss"])
  .optional()
  .describe(
    "How to answer alert/confirm/prompt dialogs this action opens. They are answered in the page and never shown; " +
      "this works in every browser and on every page. Without it, a dialog blocks the page until handle_dialog."
  );
const promptText = z.string().optional().describe('Text to answer a prompt dialog with (with dialog: "accept")');
const trusted = z
  .boolean()
  .optional()
  .describe(
    "Send real (isTrusted) input through Chrome's debugger instead of simulated events, for sites that ignore " +
      "simulated ones. Chrome shows a 'being debugged' bar meanwhile. Not available in Firefox."
  );
const maxLength = (def) => count(`Truncate to this many characters (default ${def})`, 10_000_000);
const timeoutMs = (def) => count(`Default ${def}, at most 120000`, 120_000);

const MAX_UPLOAD_MB = 32;

const MIME = {
  ".txt": "text/plain", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".js": "text/javascript", ".json": "application/json", ".xml": "application/xml", ".md": "text/markdown",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".xpi": "application/x-xpinstall", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".avif": "image/avif",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4", ".webm": "video/webm",
  ".mov": "video/quicktime", ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

// Work done here, in the agent's own server, before a call goes to the browser.
// upload_file: the files are read from this computer's disk (the extension can't read files).
export const PREPARE = {
  async upload_file({ paths, ...args }) {
    const files = [];
    let total = 0;
    for (const p of paths) {
      if (!path.isAbsolute(p)) throw new Error(`Give an absolute path, not "${p}".`);
      const st = await fs.stat(p).catch(() => null);
      if (!st) throw new Error(`No file at ${p}.`);
      if (!st.isFile()) throw new Error(`${p} is not a regular file.`);
      total += st.size;
      if (total > MAX_UPLOAD_MB * 1024 * 1024) throw new Error(`The files come to more than ${MAX_UPLOAD_MB} MB, the most upload_file sends.`);
      files.push({
        name: path.basename(p),
        type: MIME[path.extname(p).toLowerCase()] ?? "",
        lastModified: Math.round(st.mtimeMs),
        data: (await fs.readFile(p)).toString("base64"),
      });
    }
    return { ...args, files };
  },
};

// [name, description, input schema, call timeout (ms)]
export const TOOLS = [
  [
    "list_tabs",
    "List all open browser tabs with their ids, titles and URLs, which one is active, and which are used by this " +
      "session or another agent session sharing the browser.",
    {},
  ],
  [
    "open_tab",
    "Open a new tab at the given URL and wait for it to load. The new tab becomes this session's default target.",
    {
      url: z.string().describe('URL to open; "localhost:3000" and "example.com" work too'),
      active: z.boolean().optional().describe("Make it the visible tab (default true)"),
    },
  ],
  [
    "select_tab",
    "Make a tab this session's default target and the visible tab in its window (the window itself is not raised).",
    { tabId: z.number().int() },
  ],
  ["close_tab", "Close a tab (not one another agent session is using).", { tabId: z.number().int() }],
  ["navigate", "Navigate a tab to a URL and wait for the page to load.", { url: z.string(), tabId }],
  ["go_back", "Go back in the tab's history and wait for the page to load.", { tabId }],
  ["go_forward", "Go forward in the tab's history and wait for the page to load.", { tabId }],
  ["reload", "Reload the tab and wait for the page to load.", { tabId }],
  [
    "snapshot",
    "Get a structured text outline of the page: headings, text, and every interactive element (links, buttons, " +
      "inputs, selects, script-driven clickable elements...) tagged with a ref like [e12] that other tools accept. " +
      "Includes the contents of iframes, cross-origin ones too (their refs look like f3:e12). Take a new snapshot " +
      "after the page changes; refs from older snapshots may stop working.",
    {
      tabId,
      selector: z.string().optional().describe("Only snapshot this subtree"),
      interactiveOnly: z.boolean().optional().describe("List only interactive elements (shorter output)"),
      maxLength: maxLength(40000),
    },
  ],
  [
    "list_frames",
    "List every frame on the page (iframes, including hidden ones and ones inside shadow roots) with size, URL and " +
      "whether Choro can see inside it (same-origin), not (cross-origin), or it belongs to another extension.",
    { tabId },
  ],
  ["get_text", "Get the visible text of the page or of one element.", { tabId, ref, selector, name, maxLength: maxLength(40000) }],
  ["get_html", "Get the live HTML of the page or of one element.", { tabId, ref, selector, name, maxLength: maxLength(40000) }],
  [
    "get_source",
    "Read source code: without url, the page's HTML as the server sent it (get_html shows the live, script-modified " +
      "page instead); with url, a script, stylesheet or other text file (relative URLs resolve against the page).",
    {
      tabId,
      url: z.string().optional().describe("A file to read instead of the page, e.g. a script URL from network_requests"),
      maxLength: maxLength(100000),
    },
  ],
  [
    "screenshot",
    "Take a screenshot of the tab: the visible area by default, the whole page, or one element. The tab becomes the " +
      "visible one in its window; the window must not be minimized.",
    {
      tabId,
      fullPage: z.boolean().optional().describe("Capture the whole page (scrolls and stitches; very long pages are cut)"),
      ref: z.string().optional().describe("Capture only this element"),
      format: z.enum(["png", "jpeg"]).optional().describe("Default jpeg"),
      quality: z.number().int().min(1).max(100).optional().describe("JPEG quality, default 70"),
    },
  ],
  [
    "click",
    "Click an element and report what it caused (navigation, new tabs, dialogs, network requests). Clicks a person " +
      "couldn't make (disabled elements, elements behind a modal) are refused.",
    {
      tabId,
      ref,
      selector,
      name,
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
      offsetX: z.number().optional().describe("Click this many px from the element's left edge instead of its center (e.g. on a canvas)"),
      offsetY: z.number().optional().describe("Click this many px from the element's top edge instead of its center"),
      trusted,
      dialog,
      promptText,
    },
  ],
  ["hover", "Move the mouse over an element (CSS :hover menus need trusted: true).", { tabId, ref, selector, name, trusted }],
  [
    "type",
    "Type text into an input, textarea or editor (contenteditable, rich text editors, an editor in an iframe). " +
      "Date, time, color, range and number inputs are set to the whole value at once.",
    {
      tabId,
      ref,
      selector,
      name,
      text: z.string().describe("Text to type, or for date/time/color/range/number inputs the value, e.g. 2026-10-07, 14:30, #ff0000, 70"),
      clear: z.boolean().optional().describe("Clear the field first (default true)"),
      submit: z
        .boolean()
        .optional()
        .describe("Press Enter after typing. In a textarea inside a form (e.g. Google's search box) this submits the form."),
      trusted,
      dialog,
      promptText,
    },
  ],
  [
    "press_key",
    'Press a key, optionally with modifiers, on the focused element or a given one. Examples: "Enter", "Tab", "Escape", "ArrowDown", "a".',
    {
      tabId,
      ref,
      selector,
      name,
      key: z.string(),
      modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
      trusted,
      dialog,
      promptText,
    },
  ],
  [
    "fill_form",
    "Fill several fields at once. Each field is given by ref, selector or name; checkboxes, radios and switches take " +
      "true/false, selects an option value or label. Fields that change again right after (e.g. a password manager " +
      "refilling them) are reported.",
    {
      tabId,
      fields: z.array(
        z.object({
          ref: z.string().optional(),
          selector: z.string().optional(),
          name: z.string().optional(),
          value: z.union([z.string(), z.boolean(), z.number()]),
        })
      ),
    },
  ],
  [
    "select_option",
    "Choose an option in a <select> element by value or visible label.",
    {
      tabId,
      ref,
      selector,
      name,
      value: z
        .union([z.string(), z.array(z.string())])
        .describe("Option value or label. For a multi-select, a list selects exactly those options; a single value adds one."),
    },
  ],
  ["set_checked", "Check or uncheck a checkbox, radio or switch.", { tabId, ref, selector, name, checked: z.boolean() }],
  [
    "upload_file",
    "Attach local files to a file input, as if chosen in the file dialog (which never opens). The target can be the " +
      "<input type=file> (snapshot lists it as \"file\", even when hidden) or the button, label or area that stands " +
      "for it; an area with no file input (a drag-and-drop zone) gets the files dropped onto it. At most " +
      `${MAX_UPLOAD_MB} MB in all.`,
    {
      tabId,
      ref,
      selector,
      name,
      paths: z.array(z.string()).min(1).max(20).describe("Absolute paths of the files, on the computer running the agent"),
    },
    60_000,
  ],
  [
    "submit_form",
    "Submit the form containing the given element (or the form itself), reporting fields that fail validation.",
    { tabId, ref, selector, name, dialog, promptText },
  ],
  [
    "drag",
    "Drag an element onto another: HTML5 drag and drop for draggable elements, otherwise a pointer drag " +
      "(sortable lists, sliders). Both must be in the same frame.",
    {
      tabId,
      ref,
      selector,
      name,
      to: z
        .object({ ref: z.string().optional(), selector: z.string().optional(), name: z.string().optional() })
        .describe("The drop target, by ref, selector or name"),
      trusted,
    },
  ],
  [
    "scroll",
    "Scroll the page, scroll an element into view, or (element plus direction) scroll inside that element, e.g. a feed.",
    {
      tabId,
      ref: z.string().optional().describe("The element to scroll into view, or to scroll inside (with direction)"),
      selector: z.string().optional().describe("Like ref, by CSS selector"),
      name: z.string().optional().describe("Like ref, by visible text or label"),
      direction: z.enum(["up", "down", "left", "right", "top", "bottom"]).optional(),
      amount: z.number().positive().optional().describe("Pixels to scroll (default: about one screen)"),
    },
  ],
  [
    "wait_for",
    "Wait until a CSS selector or a piece of text appears on the page (or disappears, with gone: true). Give one of the two.",
    { tabId, selector: z.string().optional(), text: z.string().optional(), gone: z.boolean().optional(), timeoutMs: timeoutMs(10000) },
    125_000,
  ],
  [
    "handle_dialog",
    "Accept or dismiss a JavaScript dialog (alert, confirm, prompt) that is blocking the page. Other tools report " +
      "when one is, with its text. A dialog Choro couldn't take over can only be dismissed; in Firefox only the user " +
      "can answer it (pass dialog to the action instead).",
    {
      tabId,
      accept: z.boolean().describe("true = OK, false = Cancel"),
      promptText: z.string().optional().describe("Text to enter in a prompt dialog before accepting"),
    },
  ],
  [
    "evaluate",
    "Run a JavaScript expression in the page and return its (JSON-serializable) result. Promises are awaited.",
    { tabId, expression: z.string() },
  ],
  [
    "network_requests",
    "List the network requests of a tab this session works in (page loads, fetch/XHR, scripts, images, " +
      "WebSockets...), newest last, with status and timing. Filter to find e.g. the API call a click caused.",
    {
      tabId,
      url: z.string().optional().describe("Only URLs containing this text"),
      type: z
        .string()
        .optional()
        .describe('Only this kind: "api" (fetch and XHR), "main_frame", "sub_frame", "script", "stylesheet", "image", "font", "websocket", "media", "other"'),
      method: z.string().optional().describe("Only this HTTP method, e.g. POST"),
      status: z.string().optional().describe('Only these: "failed" (errors and 4xx/5xx), a class like "4xx", or a code like "404"'),
      sinceLastAction: z.boolean().optional().describe("Only requests since the last click, typing, key press or navigation"),
      limit: count("Show at most this many (the newest; default 50)", 500),
    },
  ],
  [
    "network_request",
    "Details of one request from network_requests: request and response headers, request body, response body " +
      "(text from fetch/XHR), timing, and messages for WebSockets. Cookies, tokens and password-like fields are hidden " +
      "unless showSecrets is set.",
    {
      tabId,
      id: z.string().describe('Request id from network_requests, e.g. "r12"'),
      showSecrets: z.boolean().optional().describe("Show cookies, tokens and password-like values"),
      maxLength: maxLength(20000),
    },
  ],
  [
    "wait_for_request",
    "Wait until a request matching the filters finishes after the last action (e.g. after clicking Save, wait for " +
      "the POST to /api/save).",
    {
      tabId,
      url: z.string().optional().describe("URL contains this text"),
      method: z.string().optional(),
      type: z.string().optional().describe('e.g. "api" for fetch/XHR'),
      status: z.string().optional().describe('e.g. "failed", "2xx", "500"'),
      includeEarlier: z.boolean().optional().describe("Also accept a request that finished before the last action"),
      timeoutMs: timeoutMs(15000),
    },
    125_000,
  ],
];

// Converts an extension result into MCP content. Only screenshots return images.
export function toContent(toolName, result) {
  if (toolName === "screenshot" && result?.image?.data) {
    const content = [{ type: "image", data: result.image.data, mimeType: result.image.mimeType }];
    if (result.text) content.push({ type: "text", text: result.text });
    return content;
  }
  const text = typeof result === "string" ? result : result === undefined ? "ok" : JSON.stringify(result, null, 2);
  return [{ type: "text", text }];
}
