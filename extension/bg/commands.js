// The commands the server can send, one per MCP tool, and their dispatch.

import * as actions from "./actions.js";
import { navigateAndWait, settleAfterAction, waitForLoad } from "./activity.js";
import { cdp, holdTab, releaseTab } from "./cdp.js";
import { answerDialog, describeDialog, forgetDialog, openDialog, pageWork, ruleOrigin, setDialogRule } from "./dialogs.js";
import { snapshotWithFrames } from "./frames.js";
import { ensurePageHooks, evaluateInPage, runInPage, setTabHooks } from "./inpage.js";
import { listRequests, requestDetails, waitForRequest } from "./network.js";
import { screenshot } from "./screenshots.js";
import { assertNotOthers, claimTab, getTab, tabUsage } from "./sessions.js";
import { describeTab, HAS_DEBUGGER, isScriptable, noDebuggerError, normalizeUrl, sleep, withTimeout } from "./util.js";

const MAX_WAIT_MS = 120_000;

const commands = {
  async list_tabs(_, ctx) {
    const tabs = await chrome.tabs.query({});
    const usage = await tabUsage(ctx.session);
    return tabs.map((t) => ({ ...describeTab(t), current: t.id === usage.current, usedBy: usage.usedBy(t.id) }));
  },

  async open_tab({ url, active = true }, ctx) {
    const tab = await chrome.tabs.create({ url: normalizeUrl(url), active });
    await claimTab(tab.id, ctx.session);
    ctx.use(tab.id);
    return { opened: describeTab((await waitForLoad(tab.id)) || tab) };
  },

  async select_tab({ tabId }, ctx) {
    const tab = await getTab(tabId, ctx);
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    return { selected: describeTab(await chrome.tabs.get(tab.id)) };
  },

  async close_tab({ tabId }, ctx) {
    if (!(await chrome.tabs.get(tabId).catch(() => null))) throw new Error(`No tab with id ${tabId}. Use list_tabs to see open tabs.`);
    await assertNotOthers(tabId, ctx.session);
    await chrome.tabs.remove(tabId);
    return `Closed tab ${tabId}`;
  },

  async navigate({ url, tabId }, ctx) {
    const tab = await getTab(tabId, ctx);
    const { tab: loaded, note } = await navigateAndWait(tab, () => chrome.tabs.update(tab.id, { url: normalizeUrl(url) }));
    return { navigated: describeTab(loaded), ...(note && { note }) };
  },

  async go_back({ tabId }, ctx) {
    const tab = await getTab(tabId, ctx);
    const { tab: loaded, note } = await navigateAndWait(tab, () => chrome.tabs.goBack(tab.id));
    return { tab: describeTab(loaded), ...(note && { note }) };
  },

  async go_forward({ tabId }, ctx) {
    const tab = await getTab(tabId, ctx);
    const { tab: loaded, note } = await navigateAndWait(tab, () => chrome.tabs.goForward(tab.id));
    return { tab: describeTab(loaded), ...(note && { note }) };
  },

  async reload({ tabId }, ctx) {
    const tab = await getTab(tabId, ctx);
    const { tab: loaded, note } = await navigateAndWait(tab, () => chrome.tabs.reload(tab.id));
    return { tab: describeTab(loaded), ...(note && { note }) };
  },

  async snapshot({ tabId, ...args }, ctx) {
    return snapshotWithFrames(await getTab(tabId, ctx), args);
  },

  async list_frames({ tabId }, ctx) {
    return runInPage(await getTab(tabId, ctx), "listFrames");
  },

  async get_text({ tabId, ...args }, ctx) {
    return runInPage(await getTab(tabId, ctx), "getText", args);
  },

  async get_html({ tabId, ...args }, ctx) {
    return runInPage(await getTab(tabId, ctx), "getHtml", args);
  },

  // The page's HTML as the server sent it (not the live DOM; get_html has that),
  // or a script, stylesheet or other text file by URL.
  async get_source({ tabId, url, maxLength = 100_000 }, ctx) {
    const tab = await getTab(tabId, ctx);
    const pageUrl = tab.url || tab.pendingUrl || "";
    let target;
    try {
      target = url ? new URL(url, pageUrl).href : pageUrl.split("#")[0];
    } catch {
      throw new Error(`Not a valid URL: ${url}`);
    }
    if (!/^https?:/.test(target)) throw new Error(`get_source reads http(s) addresses; this is ${target || "an empty tab"}.`);
    let res = null;
    // From the page first (its origin and cookies, and the browser cache), then from here (no CORS limits).
    if (isScriptable(pageUrl)) {
      const [r] = await pageWork(tab.id, () =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (u) => {
            try {
              const r = await fetch(u, { credentials: "include", cache: "force-cache" });
              return { ok: true, status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
            } catch (err) {
              return { ok: false, error: String(err) };
            }
          },
          args: [target],
        })
      ).catch(() => [null]);
      if (r?.result?.ok) res = r.result;
    }
    if (!res) {
      let r;
      try {
        r = await fetch(target, { credentials: "include", cache: "force-cache" });
      } catch (err) {
        throw new Error(`Couldn't fetch ${target}: ${err.message}`);
      }
      res = { status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
    }
    if (res.type && !/text|json|xml|javascript|css|svg|html|csv|yaml/i.test(res.type)) return `${target} is ${res.type}, not text.`;
    const note = url
      ? ""
      : "\n(Fetched again from the server or cache, so it can differ from what is shown, e.g. after a form " +
        "submission. get_html shows the live page.)";
    const max = Math.max(1, Math.floor(maxLength));
    const body = res.text.length > max ? `${res.text.slice(0, max)}\n… [truncated ${res.text.length - max} characters; raise maxLength]` : res.text;
    return `Source of ${target} (HTTP ${res.status}, ${res.type || "unknown type"}, ${res.text.length} characters)${note}\n\n${body}`;
  },

  async screenshot({ tabId, ...opts }, ctx) {
    return screenshot(await getTab(tabId, ctx), opts);
  },

  async click({ tabId, dialog, promptText, ...args }, ctx) {
    const tab = await getTab(tabId, ctx);
    return actions.withDialogPolicy(tab, args, dialog, promptText, () => actions.click(tab, args));
  },

  async type({ tabId, dialog, promptText, ...args }, ctx) {
    const tab = await getTab(tabId, ctx);
    return actions.withDialogPolicy(tab, args, dialog, promptText, () => actions.type(tab, args));
  },

  async press_key({ tabId, dialog, promptText, ...args }, ctx) {
    const tab = await getTab(tabId, ctx);
    return actions.withDialogPolicy(tab, args, dialog, promptText, () => actions.pressKey(tab, args));
  },

  async submit_form({ tabId, dialog, promptText, ...args }, ctx) {
    const tab = await getTab(tabId, ctx);
    return actions.withDialogPolicy(tab, args, dialog, promptText, () => actions.submitForm(tab, args));
  },

  async hover({ tabId, ...args }, ctx) {
    return actions.hover(await getTab(tabId, ctx), args);
  },

  async drag({ tabId, ...args }, ctx) {
    return actions.drag(await getTab(tabId, ctx), args);
  },

  async fill_form({ tabId, fields }, ctx) {
    return actions.fillForm(await getTab(tabId, ctx), fields);
  },

  async select_option({ tabId, ...args }, ctx) {
    return runInPage(await getTab(tabId, ctx), "selectOption", args);
  },

  // The server read the files from disk; they arrive as base64.
  async upload_file({ tabId, files, ...target }, ctx) {
    if (!Array.isArray(files) || !files.length || !files.every((f) => typeof f?.name === "string" && typeof f?.data === "string")) {
      throw new Error("No files to upload.");
    }
    const tab = await getTab(tabId, ctx);
    const since = Date.now();
    const size = files.reduce((n, f) => n + f.data.length, 0);
    const text = await runInPage(tab, "uploadFiles", { ...target, files }, 0, { timeoutMs: 15_000 + size / 50_000 });
    return text + (await settleAfterAction(tab.id, tab.url, since));
  },

  async set_checked({ tabId, ...args }, ctx) {
    return runInPage(await getTab(tabId, ctx), "setChecked", args);
  },

  async scroll({ tabId, ...args }, ctx) {
    return runInPage(await getTab(tabId, ctx), "scroll", args);
  },

  async wait_for({ tabId, timeoutMs = 10_000, ...args }, ctx) {
    if (!args.selector && !args.text) throw new Error("Give wait_for a selector or a text to wait for.");
    const tab = await getTab(tabId, ctx);
    const limit = Math.min(timeoutMs, MAX_WAIT_MS);
    const deadline = Date.now() + limit;
    // Polled from here rather than inside the page, so waiting survives navigations.
    while (true) {
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current) throw new Error("The tab was closed while waiting.");
      if (current.status === "complete" && isScriptable(current.url)) {
        let met = false;
        try {
          met = await runInPage(current, "check", args);
        } catch (err) {
          // Waiting won't help with a dialog, a bad selector or a page Choro can't access.
          if (/^The page is blocked by|not a valid selector|Cannot access|doesn't let extensions/.test(err.message)) throw err;
        }
        if (met) return `Condition met on ${current.url}`;
      }
      if (Date.now() > deadline) throw new Error(`Timed out after ${limit}ms waiting for ${JSON.stringify(args)}`);
      await sleep(250);
    }
  },

  async network_requests({ tabId, ...opts }, ctx) {
    return listRequests((await getTab(tabId, ctx)).id, opts);
  },

  async network_request({ tabId, id, ...opts }, ctx) {
    return requestDetails((await getTab(tabId, ctx)).id, id, opts);
  },

  async wait_for_request({ tabId, timeoutMs = 15_000, ...opts }, ctx) {
    return waitForRequest((await getTab(tabId, ctx)).id, opts, Math.min(timeoutMs, MAX_WAIT_MS));
  },

  async handle_dialog({ tabId, accept, promptText, reload = false }, ctx) {
    const since = Date.now();
    const tab = await getTab(tabId, ctx);
    const res = await answerDialog(tab, accept, promptText, { canReload: reload });
    if (res.reload) {
      // Leaving the page closes its dialog; the page's unsaved state goes with it.
      forgetDialog(tab.id);
      const { tab: loaded, note } = await navigateAndWait(tab, () => chrome.tabs.reload(tab.id));
      forgetDialog(tab.id);
      return `Couldn't answer ${res.text}, so reloaded the tab to close it (unsaved changes on the page are lost). ` +
        `Page: ${loaded?.title ?? ""} — ${loaded?.url ?? tab.url}${note ? `\n${note}` : ""}`;
    }
    return res.answered ? res.text + (await settleAfterAction(tab.id, tab.url, since)) : res.text;
  },

  async set_dialog_rule({ tabId, answer, promptText }, ctx) {
    const tab = await getTab(tabId, ctx);
    if (answer === "off") {
      await setDialogRule(tab.id, null);
      await setTabHooks(tab.id, true);
      return `Dialogs in tab ${tab.id} are no longer answered automatically.`;
    }
    const origin = ruleOrigin(tab.url);
    if (!origin || origin === "null" || !isScriptable(tab.url)) throw new Error(`Choro can't watch dialogs on ${tab.url}.`);
    const accept = answer === "accept";
    await setDialogRule(tab.id, { accept, promptText: promptText ?? null, origin });
    // A page loaded before Choro connected has no hooks yet (a page frozen by a dialog can't get them now).
    await withTimeout(ensurePageHooks(tab.id), 2_000, () => new Error("busy")).catch(() => {});
    await setTabHooks(tab.id, true);
    const how = accept
      ? `accepted (OK${promptText != null ? `, prompts answered with ${JSON.stringify(promptText)}` : ", prompts keep their default text"})`
      : "dismissed (Cancel; alerts are closed)";
    let text =
      `From now on, dialogs in tab ${tab.id} are ${how} in the page and never shown, until set_dialog_rule with ` +
      `answer: "off" or the tab leaves ${origin}. Each one is reported in the next action's result.`;
    // One already open: answer it now if Choro can.
    const open = openDialog(tab.id);
    if (open) {
      const res = await answerDialog(tab, accept, promptText, { canReload: true }).catch((err) => ({ text: err.message }));
      text += res.answered
        ? `\n${res.text}.`
        : `\nThe page is already showing ${describeDialog(open)}, which opened before the rule; ` +
          "handle_dialog can answer it (or reload: true closes it by reloading the tab).";
    }
    return text;
  },

  async evaluate({ tabId, expression }, ctx) {
    const tab = await getTab(tabId, ctx);
    if (isScriptable(tab.url)) {
      const [res] = await pageWork(tab.id, () =>
        chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: evaluateInPage, args: [expression] })
      );
      const out = res?.result;
      if (out && !out.blocked) {
        if ("error" in out) throw new Error(out.error);
        return out.value === undefined ? `(${out.type})` : out.value;
      }
      // The page's CSP or Trusted Types forbid eval; the debugger isn't bound by them.
      if (!HAS_DEBUGGER) throw noDebuggerError("This page forbids running code from text (its Content Security Policy); getting around that");
    }
    const res = await cdp(tab.id, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    return res.result.value === undefined ? `(${res.result.type})` : res.result.value;
  },
};

export async function handleCommand(method, params) {
  if (!Object.hasOwn(commands, method)) throw new Error(`Unknown command: ${method}`);
  const { _session, ...args } = params;
  if (typeof _session !== "string") throw new Error("Command without a session; is the Choro server up to date?");
  // Tabs the command works in are held until it ends, so the debugger stays
  // attached for the whole command and is detached (removing Chrome's "being
  // debugged" bar) once nothing needs it any more.
  const tabs = new Set();
  const ctx = {
    session: _session,
    use(tabId) {
      if (tabs.has(tabId)) return;
      tabs.add(tabId);
      holdTab(tabId);
    },
  };
  try {
    return await commands[method](args, ctx);
  } finally {
    for (const tabId of tabs) releaseTab(tabId);
  }
}
