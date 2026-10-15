// Screenshots. The visible area comes from tabs.captureVisibleTab; full pages are
// scrolled and stitched; elements are cropped from a capture. Only elements larger
// than the window need the debugger (Chrome), which can capture beyond it.

import { cdp } from "./cdp.js";
import { pageWork } from "./dialogs.js";
import { elementRectTop } from "./frames.js";
import { runInPage } from "./inpage.js";
import { HAS_DEBUGGER, sleep } from "./util.js";

const CAPTURE_INTERVAL_MS = 550; // captureVisibleTab allows at most 2 calls per second
const MAX_CANVAS_PX = 16_000; // stitched height, in device pixels (canvases top out near 32k)

// Captures run one at a time: two sessions capturing in the same window would
// otherwise get each other's tab, and the rate limit would be exceeded.
let queue = Promise.resolve();
let lastCaptureAt = 0;

function captureVisible(tab, options) {
  const run = queue.then(async () => {
    const wait = lastCaptureAt + CAPTURE_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    let current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current) throw new Error("The tab was closed.");
    if (!current.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(150);
    }
    lastCaptureAt = Date.now();
    const shot = await pageWork(tab.id, () => chrome.tabs.captureVisibleTab(current.windowId, options));
    // If the user switched tabs meanwhile, the picture may show another tab: don't hand that out.
    current = await chrome.tabs.get(tab.id).catch(() => null);
    if (!current?.active) throw new Error("The tab stopped being the visible one while capturing; try again.");
    return shot;
  });
  queue = run.catch(() => {});
  return run;
}

async function captureBitmap(tab) {
  const dataUrl = await captureVisible(tab, { format: "png" });
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

async function canvasToBase64(canvas, mimeType, quality) {
  const blob = await canvas.convertToBlob({ type: mimeType, quality: mimeType === "image/jpeg" ? quality / 100 : undefined });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Scrolls through the page capturing the viewport, and stitches the captures.
// Fixed and sticky elements (headers, cookie bars) are hidden after the first
// capture so they don't repeat down the image.
async function stitchFullPage(tab, mimeType, quality) {
  const m = await runInPage(tab, "pageMetrics");
  const height = Math.min(m.scrollHeight, Math.floor(MAX_CANVAS_PX / (m.devicePixelRatio || 1)));
  let canvas, ctx, scale;
  try {
    for (let y = 0; y < height; y += m.viewportHeight) {
      const actualY = await runInPage(tab, "scrollToY", { y });
      if (y > 0) await runInPage(tab, "hideFixed", { hide: true });
      await sleep(100); // let lazy content and scroll-linked effects render
      const bitmap = await captureBitmap(tab);
      if (!canvas) {
        scale = bitmap.width / m.viewportWidth;
        // clientWidth leaves out the page's scrollbar, which would repeat down the image.
        canvas = new OffscreenCanvas(Math.round((m.clientWidth || m.viewportWidth) * scale), Math.round(height * scale));
        ctx = canvas.getContext("2d");
      }
      ctx.drawImage(bitmap, 0, Math.round(actualY * scale));
      if (actualY + m.viewportHeight >= height) break;
    }
  } finally {
    await runInPage(tab, "hideFixed", { hide: false }).catch(() => {});
    await runInPage(tab, "scrollToY", { y: m.scrollY, x: m.scrollX }).catch(() => {});
  }
  const note = m.scrollHeight > height ? `\nThe page is ${m.scrollHeight}px tall; captured the first ${height}px.` : "";
  return { data: await canvasToBase64(canvas, mimeType, quality), note };
}

export async function screenshot(tab, { fullPage, ref, format = "jpeg", quality = 70 }) {
  const mimeType = `image/${format}`;
  const text = `${tab.title} — ${tab.url}`;

  if (ref) {
    const r = await elementRectTop(tab, { ref }, true);
    const fits = r.left >= 0 && r.top >= 0 && r.left + r.width <= r.viewportWidth && r.top + r.height <= r.viewportHeight;
    if (!fits && HAS_DEBUGGER) {
      // Larger than the window: only the debugger can capture beyond the viewport.
      const shot = await cdp(tab.id, "Page.captureScreenshot", {
        format,
        quality: format === "jpeg" ? quality : undefined,
        captureBeyondViewport: true,
        clip: { x: r.docX, y: r.docY, width: Math.max(1, r.width), height: Math.max(1, r.height), scale: 1 },
      });
      return { image: { data: shot.data, mimeType }, text };
    }
    // Crop to the part of the element inside the window.
    const left = Math.max(0, r.left);
    const top = Math.max(0, r.top);
    const width = Math.max(1, Math.min(r.left + r.width, r.viewportWidth) - left);
    const height = Math.max(1, Math.min(r.top + r.height, r.viewportHeight) - top);
    const bitmap = await captureBitmap(tab);
    const scale = bitmap.width / r.viewportWidth;
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    canvas.getContext("2d").drawImage(bitmap, -left * scale, -top * scale);
    const note = fits ? "" : "\nThe element is larger than the window; this shows the part inside it.";
    return { image: { data: await canvasToBase64(canvas, mimeType, quality), mimeType }, text: text + note };
  }

  if (fullPage) {
    const { data, note } = await stitchFullPage(tab, mimeType, quality);
    return { image: { data, mimeType }, text: text + note };
  }

  const dataUrl = await captureVisible(tab, { format, quality: format === "jpeg" ? quality : undefined });
  return { image: { data: dataUrl.split(",")[1], mimeType }, text };
}
