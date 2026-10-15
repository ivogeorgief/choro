// Actions that act like a user: click, hover, type, press_key, submit_form, drag
// and fill_form. Each runs simulated input in the page by default, or real input
// through the debugger with `trusted`, and reports what it caused.

import { settleAfterAction, openedTabSince } from "./activity.js";
import { attachForInput, cdp, cdpClick, cdpDrag, cdpKey } from "./cdp.js";
import { elementRectTop } from "./frames.js";
import { FRAME_REF, runInPage } from "./inpage.js";
import { sleep } from "./util.js";

const FILL_RECHECK_MS = 600; // autofill extensions react to filled fields within a few hundred ms

// Runs an action with its `dialog` option in force: dialogs it opens are answered
// in the page (no debugger needed) instead of being shown.
export async function withDialogPolicy(tab, target, dialog, promptText, action) {
  if (!dialog) return action();
  await runInPage(tab, "setDialogPolicy", { ref: target.ref, accept: dialog === "accept", promptText });
  try {
    return await action();
  } finally {
    await runInPage(tab, "clearDialogPolicy", { ref: target.ref }).catch(() => {});
  }
}

export async function click(tab, { trusted, button = "left", doubleClick, offsetX, offsetY, ...target }) {
  const since = Date.now();
  let text, newTab;
  if (trusted) {
    await attachForInput(tab.id, "A trusted click");
    const r = await elementRectTop(tab, { ...target, forClick: true }, true);
    const x = offsetX != null ? r.left + offsetX : r.x;
    const y = offsetY != null ? r.top + offsetY : r.y;
    await cdpClick(tab.id, x, y, { button, clickCount: doubleClick ? 2 : 1 });
    ({ newTab } = r);
    text = `Clicked ${r.description} (trusted)`;
  } else {
    ({ text, newTab } = await runInPage(tab, "click", { ...target, button, doubleClick, offsetX, offsetY }));
  }
  let out = text + (await settleAfterAction(tab.id, tab.url, since));
  if (newTab && button === "left" && !openedTabSince(tab.id, since)) {
    out += "\nThe link opens in a new tab, but none appeared; the browser may have blocked it as a popup.";
  }
  return out;
}

export async function hover(tab, { trusted, ...target }) {
  if (!trusted) return runInPage(tab, "hover", target);
  await attachForInput(tab.id, "A trusted hover");
  const r = await elementRectTop(tab, target, true);
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
  return `Hovering ${r.description} (trusted)`;
}

export async function type(tab, { trusted, text, clear = true, submit, ...target }) {
  const since = Date.now();
  let out;
  if (trusted) {
    await attachForInput(tab.id, "Trusted typing");
    const desc = await runInPage(tab, "focus", { ...target, clear });
    await cdp(tab.id, "Input.insertText", { text });
    out = `Typed into ${desc} (trusted)`;
    if (submit) await cdpKey(tab.id, "Enter");
  } else {
    // Typing goes character by character: long texts get more time than other page work.
    out = await runInPage(tab, "type", { ...target, text, clear, submit }, 0, { timeoutMs: 10_000 + String(text).length * 30 });
  }
  return out + (submit ? await settleAfterAction(tab.id, tab.url, since) : "");
}

export async function pressKey(tab, { trusted, key, modifiers = [], ...target }) {
  const since = Date.now();
  let out;
  if (trusted) {
    await attachForInput(tab.id, "A trusted key press");
    if (target.ref || target.selector || target.name) await runInPage(tab, "focus", { ...target, clear: false });
    await cdpKey(tab.id, key, modifiers);
    out = `Pressed ${[...modifiers, key].join("+")} (trusted)`;
  } else {
    out = await runInPage(tab, "pressKey", { ...target, key, modifiers });
  }
  return out + (await settleAfterAction(tab.id, tab.url, since));
}

export async function submitForm(tab, target) {
  const since = Date.now();
  const out = await runInPage(tab, "submitForm", target);
  return out + (await settleAfterAction(tab.id, tab.url, since));
}

export async function drag(tab, { trusted, to, ...target }) {
  const since = Date.now();
  if (!to || !(to.ref || to.selector || to.name)) throw new Error("Give the drop target as to: {ref | selector | name}.");
  let out;
  if (trusted) {
    await attachForInput(tab.id, "A trusted drag");
    const a = await elementRectTop(tab, { ...target, forClick: true }, true);
    const b = await elementRectTop(tab, to, false);
    out = `Dragged ${a.description} onto ${b.description} (trusted ${await cdpDrag(tab.id, a, b)})`;
  } else {
    // Both ends must be in the same frame. A target given by selector or name is
    // looked up in the source's frame; a frame ref on it loses its prefix like the source's.
    const src = FRAME_REF.exec(target.ref || "");
    const dst = FRAME_REF.exec(to.ref || "");
    const srcFrame = src ? src[1] : null;
    const dstFrame = dst ? dst[1] : to.ref ? null : srcFrame;
    if (srcFrame !== dstFrame) {
      throw new Error("Drag and drop works within one frame; the element and the drop target are in different frames.");
    }
    out = await runInPage(tab, "drag", { ...target, to: dst ? { ...to, ref: dst[2] } : to });
  }
  return out + (await settleAfterAction(tab.id, tab.url, since));
}

export async function fillForm(tab, fields) {
  // Fields inside cross-origin frames are filled in their own frame.
  const top = fields.filter((f) => !FRAME_REF.test(f.ref || ""));
  const out = top.length ? [await runInPage(tab, "fillForm", { fields: top })] : [];
  if (top.length) {
    // Password managers and other autofill can fill fields again right after Choro does.
    await sleep(FILL_RECHECK_MS);
    const changed = await runInPage(tab, "changedFields", { fields: top }).catch(() => []);
    if (changed.length) {
      out.push(
        "Warning: these fields changed after Choro filled them (another extension, such as a password manager, " +
          `may have filled them again): ${changed.join(", ")}. Check them before submitting.`
      );
    }
  }
  for (const f of fields.filter((f) => FRAME_REF.test(f.ref || ""))) {
    const [, frameId, ref] = FRAME_REF.exec(f.ref);
    out.push(
      await runInPage(tab, "fillForm", { fields: [{ ...f, ref }] }, Number(frameId)).catch((err) => `FAILED ${f.ref}: ${err.message}`)
    );
  }
  return out.join("\n");
}
