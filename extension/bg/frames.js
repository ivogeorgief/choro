// Cross-origin frames.
//
// page.js runs in every frame. A parent's snapshot leaves a marker (with a token
// it also sent to the frame by postMessage) where a cross-origin frame is; the
// frame's own snapshot is spliced in there, its refs prefixed with the browser's
// frame id ("f12:e5").

import { pageWork } from "./dialogs.js";
import { runInPage } from "./inpage.js";
import { sleep } from "./util.js";

const FRAME_MARK_RE = /^( *)\u0001frame:([0-9a-f-]{36})(?:@(\d+))?$/gm;
const frameParents = new Map(); // "tabId:frameId" -> {parentFrameId, token}

function forgetTab(tabId) {
  for (const key of frameParents.keys()) if (key.startsWith(`${tabId}:`)) frameParents.delete(key);
}
chrome.tabs.onRemoved.addListener(forgetTab);
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => frameId === 0 && forgetTab(tabId));

async function frameIdsByToken(tabId) {
  const results = await pageWork(tabId, () =>
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (typeof window.__choro?.run === "function" ? window.__choro.run("frameToken") : null),
    })
  ).catch(() => []);
  const map = new Map();
  for (const r of results) if (r.result?.value) map.set(r.result.value, r.frameId);
  return map;
}

async function replaceAsync(text, re, fn) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(text.slice(last, m.index), await fn(...m));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts.join("");
}

export async function snapshotWithFrames(tab, args) {
  // Every frame must be listening before the parent hands out tokens.
  await pageWork(tab.id, () => chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["page.js"] })).catch(
    (err) => {
      if (/^The page is blocked/.test(err.message)) throw err;
    }
  );
  let text = await runInPage(tab, "snapshot", args);
  const { interactiveOnly, maxLength } = args;
  for (let round = 0; round < 4 && text.includes("\u0001frame:"); round++) {
    await sleep(50); // tokens travel by postMessage
    const ids = await frameIdsByToken(tab.id);
    text = await replaceAsync(text, FRAME_MARK_RE, async (_, indent, token, parent) => {
      const frameId = ids.get(token);
      if (frameId == null) return `${indent}(contents not available)`;
      frameParents.set(`${tab.id}:${frameId}`, { parentFrameId: Number(parent || 0), token });
      let inner;
      try {
        inner = await runInPage(tab, "snapshot", { interactiveOnly, maxLength }, frameId); // refs come back as f<id>:e<n>
      } catch (err) {
        return `${indent}(contents not available: ${err.message})`;
      }
      const start = inner.indexOf("\n\n");
      const body = start === -1 ? "" : inner.slice(start + 2); // drop the frame's Page/URL header
      return body
        .split("\n")
        .filter(Boolean)
        .map((line) => indent + line)
        .join("\n")
        .replace(/(\u0001frame:[0-9a-f-]{36})$/gm, `$1@${frameId}`);
    });
  }
  text = text.replace(FRAME_MARK_RE, "$1(contents not available)");
  // Each frame was cut to maxLength on its own; the whole must fit too.
  const max = args.maxLength ?? 40_000;
  if (text.length > max) {
    const nl = text.lastIndexOf("\n", max);
    const cut = nl > max * 0.8 ? nl : max;
    text = text.slice(0, cut) + `\n… [truncated ${text.length - cut} characters; use selector or maxLength]`;
  }
  return text;
}

// Where a cross-origin frame's content starts, in the top page's coordinates.
// Each enclosing frame is scrolled into view first, so the point is on screen.
// The point must lie inside every enclosing frame's visible box: an element a
// frame placed outside its own box would otherwise send a trusted click to the
// page around the frame.
async function frameOffset(tab, frameId, point) {
  let { x, y } = point;
  let left = 0;
  let top = 0;
  for (let id = frameId; id !== 0; ) {
    const info = frameParents.get(`${tab.id}:${id}`);
    if (!info) throw new Error("Choro doesn't know where that frame is. Take a new snapshot.");
    const r = await runInPage(tab, "frameRect", { token: info.token, scroll: true }, info.parentFrameId);
    if (x < 0 || y < 0 || x > r.width || y > r.height) {
      throw new Error("That element is outside the visible area of its frame, so a click there would land outside the frame.");
    }
    x += r.left;
    y += r.top;
    left += r.left;
    top += r.top;
    id = info.parentFrameId;
  }
  return { left, top };
}

// elementRect in the top page's coordinates, also for elements in cross-origin frames.
export async function elementRectTop(tab, target, scroll) {
  const m = /^f(\d+):e\d+$/.exec(target.ref || "");
  if (!m) return runInPage(tab, "elementRect", { ...target, scroll });
  const r = await runInPage(tab, "elementRect", { ...target, scroll });
  const o = await frameOffset(tab, Number(m[1]), { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  const t = await runInPage(tab, "pageMetrics");
  const left = r.left + o.left;
  const top = r.top + o.top;
  return {
    ...r,
    left,
    top,
    x: left + r.width / 2,
    y: top + r.height / 2,
    docX: left + t.scrollX,
    docY: top + t.scrollY,
    viewportWidth: t.viewportWidth,
    viewportHeight: t.viewportHeight,
  };
}
