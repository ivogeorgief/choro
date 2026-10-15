// Choro page script. Injected into the page's isolated world on demand; it is
// idempotent, so element refs stay stable across commands until the page
// navigates. Every command returns {ok, value} or {ok: false, error}.

(() => {
  // Idempotent per extension version: after an update, a copy left in an open
  // page by the previous version is replaced.
  const VERSION = chrome.runtime.getManifest().version;
  if (window.__choro?.version === VERSION) return;

  const DEFAULT_MAX_LENGTH = 40_000;

  const INTERACTIVE = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "select",
    "textarea",
    "summary",
    "[contenteditable='']",
    "[contenteditable='true']",
    "[onclick]",
    "[tabindex]:not([tabindex='-1'])",
    ...[
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "tab",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "textbox",
      "searchbox",
      "combobox",
      "slider",
      "spinbutton",
      "treeitem",
    ].map((r) => `[role=${r}]`),
  ].join(",");

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);
  const LANDMARKS = { NAV: "nav", HEADER: "header", FOOTER: "footer", MAIN: "main", ASIDE: "aside", FORM: "form", DIALOG: "dialog" };

  // --- refs ----------------------------------------------------------------

  const refs = new Map(); // "e12" -> WeakRef<Element>
  const elementRefs = new WeakMap(); // Element -> "e12"
  let refCounter = 0;

  function refFor(el) {
    let r = elementRefs.get(el);
    if (!r) {
      r = `e${++refCounter}`;
      elementRefs.set(el, r);
      refs.set(r, new WeakRef(el));
    }
    return r;
  }

  function resolve({ ref, selector, name } = {}, { optional = false } = {}) {
    if (ref) {
      const el = refs.get(ref)?.deref();
      if (!el || !el.isConnected) {
        throw new Error(`Element ref "${ref}" is no longer on the page. Take a new snapshot to get fresh refs.`);
      }
      return el;
    }
    if (selector) {
      const el = querySelectorDeep(selector);
      if (!el) throw new Error(`No element matches selector "${selector}".`);
      return el;
    }
    if (name) return findByName(name);
    if (optional) return null;
    throw new Error("Provide a ref (from snapshot), a selector or a name.");
  }

  // --- cross-origin frames ------------------------------------------------------
  // This script runs in every frame. A cross-origin frame's document is out of
  // reach from its parent, so during a snapshot the parent sends each one a token;
  // the background matches tokens to Chrome frame ids and snapshots the frames
  // separately, splicing them in where the parent left a marker.

  const FRAME_MARK = "\u0001frame:";
  let myFrameToken = null;
  const frameTokens = new Map(); // token -> WeakRef<iframe element>
  const tokenOfFrame = new WeakMap();

  // Only a real parent may hand out the token, and only once per document: the
  // page's own scripts can post messages too.
  window.addEventListener("message", (e) => {
    if (window.parent === window || e.source !== window.parent || myFrameToken) return;
    if (typeof e.data?.__choroFrameToken === "string") myFrameToken = e.data.__choroFrameToken;
  });

  function tokenFor(frame) {
    let t = tokenOfFrame.get(frame);
    if (!t) {
      t = crypto.randomUUID();
      tokenOfFrame.set(frame, t);
      frameTokens.set(t, new WeakRef(frame));
    }
    try {
      frame.contentWindow?.postMessage({ __choroFrameToken: t }, "*");
    } catch {
      /* frame gone */
    }
    return t;
  }

  // --- frames -------------------------------------------------------------------
  // Same-origin iframes (rich text editors, old-style app layouts) are reached
  // through their contentDocument; cross-origin ones stay out of reach.

  const isFrame = (el) => el.tagName === "IFRAME" || el.tagName === "FRAME";
  const docOf = (el) => el.ownerDocument || document;
  const winOf = (el) => docOf(el).defaultView || window;
  const styleOf = (el) => winOf(el).getComputedStyle(el);

  function frameDocOf(frame) {
    try {
      return frame.contentDocument || null;
    } catch {
      return null;
    }
  }

  function frameDocs(doc = document, out = []) {
    for (const f of doc.querySelectorAll("iframe, frame")) {
      const d = frameDocOf(f);
      if (d?.documentElement) {
        out.push(d);
        frameDocs(d, out);
      }
    }
    return out;
  }

  // The page, its same-origin frames, and every shadow root in them (open or closed).
  function allRoots() {
    const roots = [];
    const add = (root) => {
      roots.push(root);
      for (const el of root.querySelectorAll("*")) {
        const sr = shadowOf(el);
        if (sr) add(sr);
      }
    };
    for (const doc of [document, ...frameDocs()]) add(doc);
    return roots;
  }

  function querySelectorDeep(selector) {
    for (const root of allRoots()) {
      const el = root.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  // The focused element, looking inside same-origin iframes and shadow roots.
  function deepActive(doc = document) {
    let el = doc.activeElement;
    while (el) {
      const inner = isFrame(el) ? frameDocOf(el)?.activeElement : shadowOf(el)?.activeElement;
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  // An iframe given as a typing target means the editor inside it: its focused
  // field, or its body when the whole document is editable.
  function intoFrame(el) {
    while (isFrame(el)) {
      const doc = frameDocOf(el);
      if (!doc?.body) break;
      const active = doc.activeElement;
      el = active && active !== doc.body && (isTextField(active) || active.isContentEditable) ? active : doc.body;
    }
    return el;
  }

  // The file input an element stands for: the input itself, a label's control,
  // one inside it (drop zones often hold a hidden one), or, for a button or link,
  // the one file input in the nearest enclosing element that has any (an "Upload"
  // button next to a hidden input). null for a drop zone.
  function fileInputFor(el) {
    const isFile = (e) => e?.tagName === "INPUT" && e.type === "file";
    if (isFile(el)) return el;
    if (el.tagName === "LABEL" && isFile(el.control)) return el.control;
    const control = /^(BUTTON|A|LABEL)$/.test(el.tagName) || /^(button|link)$/.test(el.getAttribute("role") || "");
    for (let a = el, depth = 0; a && depth < (control ? 5 : 1); a = a.parentElement, depth++) {
      const inputs = [...a.querySelectorAll('input[type="file"]')];
      if (a.shadowRoot) inputs.push(...a.shadowRoot.querySelectorAll('input[type="file"]'));
      if (inputs.length === 1) return inputs[0];
      if (inputs.length > 1) {
        throw new Error(`${shortDesc(el)} is near ${inputs.length} file inputs; target one of them (snapshot lists them as "file").`);
      }
      if (a.tagName === "FORM") break;
    }
    return null;
  }

  // Focuses el, first focusing the frames that contain it.
  function focusDeep(el) {
    const frame = winOf(el).frameElement;
    if (frame) focusDeep(frame);
    if (el === docOf(el).body && el.isContentEditable) winOf(el).focus();
    else el.focus({ preventScroll: true });
  }

  // Viewport rect in the top page's coordinates (adds the offsets of containing frames).
  function topRect(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    for (let f = winOf(el).frameElement; f; f = winOf(f).frameElement) {
      const fr = f.getBoundingClientRect();
      const st = styleOf(f);
      left += fr.left + f.clientLeft + parseFloat(st.paddingLeft);
      top += fr.top + f.clientTop + parseFloat(st.paddingTop);
    }
    return { left, top, width: r.width, height: r.height };
  }

  // --- finding by name ----------------------------------------------------------

  // Finds the element a person would call `name`. Exact matches (ignoring case and
  // spacing) come from interactive elements' names, then from any element's own
  // text or label attributes. Partial matches are only taken from interactive
  // elements: partial text matches elsewhere hit unrelated prose. A hidden exact
  // match is reported rather than replaced by something else.
  let matchNote = ""; // appended to the command's result
  function findByName(name) {
    const want = clean(name, Infinity).toLowerCase();
    const exact = [];
    const partial = [];
    const docs = allRoots();
    for (const doc of docs) {
      for (const el of doc.querySelectorAll(INTERACTIVE)) {
        const t = accessibleName(el).toLowerCase();
        if (t === want) exact.push(el);
        else if (t && t.includes(want)) partial.push(el);
      }
    }
    for (const doc of docs) {
      const start = doc.body || doc.documentElement || (doc.nodeType === Node.DOCUMENT_FRAGMENT_NODE ? doc : null);
      if (!start) continue;
      const walker = (doc.ownerDocument || doc).createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        let el, text;
        if (n.nodeType === Node.TEXT_NODE) {
          el = n.parentElement;
          text = n.textContent;
        } else {
          el = n;
          text =
            n.getAttribute("aria-label") ||
            n.getAttribute("title") ||
            n.getAttribute("placeholder") ||
            (n.tagName === "INPUT" && ["submit", "button", "reset"].includes(n.type) ? n.value : "");
        }
        if (!el || !text || SKIP_TAGS.has(el.tagName)) continue;
        if (clean(text, Infinity).toLowerCase() === want) exact.push(el);
      }
    }
    const shown = (e) => isVisible(e) && !e.closest("[aria-hidden=true]");
    const targets = (list) => [...new Set(list.filter(shown).map(clickableAround))];
    let found = targets(exact);
    if (!found.length && exact.length) {
      throw new Error(
        `"${name}" is on the page but hidden (for example in a closed menu or collapsed section). Open it first; ` +
          "menus that open on hover need hover with trusted: true."
      );
    }
    let note = "";
    if (!found.length) {
      found = targets(partial);
      if (found.length) note = ` (partial match for "${name}")`;
    }
    if (!found.length) {
      throw new Error(
        `No visible element with the text or label "${name}". Take a snapshot to see what's on the page; ` +
          "in long or virtualized lists, scroll first."
      );
    }
    // Among several matches, what a person would mean comes first: an open dialog,
    // then the page's main content or a form, then anything else (e.g. text in an
    // email body that happens to read "Approve").
    const rank = (e) => {
      const dialogs = docOf(e).querySelectorAll("dialog[open], [role=dialog], [role=alertdialog]");
      if ([...dialogs].some((d) => composedContains(d, e))) return 0;
      return e.closest("main, [role=main], form") ? 1 : 2;
    };
    if (found.length > 1) found.sort((a, b) => rank(a) - rank(b));
    if (found.length > 1) note += ` (first of ${found.length} matches for "${name}"; use a ref to pick another)`;
    matchNote = note;
    return found[0];
  }

  const opensNewTab = (el) => el.closest("a[href]")?.target === "_blank";

  // Synthetic events reach elements a person can't click: disabled controls,
  // inert content, and everything behind a modal dialog.
  function assertClickable(el) {
    if (el.matches(":disabled")) {
      throw new Error(`${shortDesc(el)} is disabled. Wait for it to become enabled, or check what the form still needs.`);
    }
    if (el.closest("[inert]")) throw new Error(`${shortDesc(el)} is inert (blocked by an overlay or modal).`);
    const root = el.getRootNode();
    const modals = [...docOf(el).querySelectorAll("dialog:modal"), ...(root !== docOf(el) && root.querySelectorAll ? root.querySelectorAll("dialog:modal") : [])];
    if (modals.length && !modals.some((m) => composedContains(m, el))) {
      throw new Error(`${shortDesc(el)} is behind an open modal dialog (${shortDesc(modals.at(-1))}). Close or answer the modal first.`);
    }
  }

  function clickableAround(el) {
    const interactive = el.closest(INTERACTIVE);
    if (interactive) return interactive;
    // Text of a label means its control.
    const label = el.closest("label");
    if (label?.control) return label.control;
    // The outermost element of the pointer-cursor run starting at (or just above) el.
    let found = null;
    for (let n = el, i = 0; n && n !== docOf(el).body && i < 8; n = n.parentElement, i++) {
      if (styleOf(n).cursor === "pointer") found = n;
      else if (found) break;
    }
    return found || el;
  }

  // --- element description ---------------------------------------------------

  // Control characters are dropped and ref-like "[e12]" text is defused: page
  // text must not be able to forge the snapshot's frame markers or refs.
  const clean = (s, max = 200) => {
    const t = (s || "")
      .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "")
      .replace(/\[((?:f\d+:)?e\d+)\]/g, "($1)") // page text must not look like a ref Choro gave out
      .replace(/\s+/g, " ")
      .trim();
    return t.length > max ? t.slice(0, max) + "…" : t;
  };

  // Opacity is deliberately not checked: styled checkboxes and file inputs are
  // often opacity:0 under a custom-drawn control but are still what you click.
  function isVisible(el) {
    if (!el.checkVisibility || el.checkVisibility({ checkVisibilityCSS: true })) return true;
    return styleOf(el).display === "contents";
  }

  // Closed shadow roots: chrome.dom.openOrClosedShadowRoot in Chrome, the
  // Element.openOrClosedShadowRoot property in Firefox. Chrome's throws for
  // anything that isn't an HTMLElement (SVG, MathML), which can't host shadow
  // roots anyway; checked by namespace because elements inside iframes come from
  // another realm.
  const shadowOf = (el) => {
    if (el.namespaceURI !== "http://www.w3.org/1999/xhtml") return null;
    try {
      return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? el.openOrClosedShadowRoot ?? el.shadowRoot;
    } catch {
      return el.shadowRoot;
    }
  };

  function textOfIds(ids, root) {
    return ids
      .split(/\s+/)
      .map((id) => root.getElementById?.(id)?.innerText || "")
      .join(" ");
  }

  // Apps often build buttons from plain divs with click handlers attached by
  // script, which no attribute reveals. A pointer cursor does: take the outermost
  // element showing one (cursor is inherited, so its descendants show it too).
  let cursorMemo = new WeakMap();
  function cursorOf(el) {
    let c = cursorMemo.get(el);
    if (c === undefined) {
      c = styleOf(el).cursor;
      cursorMemo.set(el, c);
    }
    return c;
  }

  function isPointerTarget(el) {
    if (el.tagName === "BODY" || el.tagName === "HTML" || el.tagName === "LABEL") return false;
    if (cursorOf(el) !== "pointer") return false;
    const parent = el.parentElement || el.parentNode?.host;
    return !parent || cursorOf(parent) !== "pointer";
  }

  // The body of a document in design mode (iframe-based rich text editors).
  const isEditableDoc = (el) => el.tagName === "BODY" && docOf(el).designMode === "on";

  const isInteractive = (el) => el.matches(INTERACTIVE) || isEditableDoc(el) || isPointerTarget(el);

  // A label's text without the text of controls inside it (a <select> wrapped in
  // its label would otherwise be named after all of its options).
  function labelText(label) {
    const parts = [];
    const walker = docOf(label).createTreeWalker(label, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const control = n.parentElement?.closest("select, textarea, button, input, option");
      if (control && label.contains(control)) continue;
      parts.push(n.textContent);
    }
    return parts.join(" ");
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const t = clean(textOfIds(labelledBy, el.getRootNode()));
      if (t) return t;
    }
    if (el.labels?.length) {
      const t = clean([...el.labels].map(labelText).join(" "));
      if (t) return t;
    }
    if (el.tagName === "IMG") return clean(el.alt);
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) return clean(el.value);
    if (el.isContentEditable) {
      return clean(el.getAttribute("title") || el.getAttribute("aria-placeholder") || winOf(el).frameElement?.title || "");
    }
    const inner = clean(el.innerText, 100);
    if (inner) return inner;
    const img = el.querySelector?.("img[alt], svg[aria-label], [title]");
    return clean(
      el.getAttribute("title") ||
        el.getAttribute("placeholder") ||
        img?.getAttribute("alt") ||
        img?.getAttribute("aria-label") ||
        img?.getAttribute("title") ||
        ""
    );
  }

  function roleOf(el) {
    const role = el.getAttribute("role");
    if (role) return role;
    switch (el.tagName) {
      case "A":
        return "link";
      case "BUTTON":
        return "button";
      case "SELECT":
        return el.multiple ? "listbox" : "select";
      case "TEXTAREA":
        return "textarea";
      case "SUMMARY":
        return "summary";
      case "INPUT": {
        const t = el.type;
        if (["submit", "button", "reset", "image"].includes(t)) return "button";
        if (["checkbox", "radio", "range", "file", "color"].includes(t)) return t;
        if (["date", "datetime-local", "time", "month", "week"].includes(t)) return `input[${t}]`;
        return t === "text" ? "textbox" : `textbox[${t}]`;
      }
    }
    if (el.isContentEditable) return "editable";
    return "clickable";
  }

  function describe(el) {
    const role = roleOf(el);
    const parts = [role];
    const name = accessibleName(el);
    if (name) parts.push(JSON.stringify(name));
    parts.push(`[${refFor(el)}]`);

    if (el.tagName === "A") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`→ ${clean(href, 120)}`);
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      if (["checkbox", "radio"].includes(el.type)) {
        if (el.checked) parts.push("checked");
      } else if (el.type === "password") {
        if (el.value) parts.push('value="••••"');
      } else if (!["submit", "button", "reset", "image"].includes(el.type)) {
        if (el.value) parts.push(`value=${JSON.stringify(clean(el.value, 120))}`);
        if (el.placeholder && el.placeholder !== name) parts.push(`placeholder=${JSON.stringify(clean(el.placeholder, 80))}`);
      }
      if (el.required) parts.push("required");
      if (el.readOnly) parts.push("readonly");
    }
    if (el.tagName === "SELECT") {
      const opts = [...el.options];
      const selected = opts.filter((o) => o.selected).map((o) => clean(o.text, 60));
      if (selected.length) parts.push(`selected=${JSON.stringify(selected.join(", "))}`);
      const shown = opts.slice(0, 25).map((o) => clean(o.text, 40));
      parts.push(`options=${JSON.stringify(shown)}${opts.length > 25 ? ` (+${opts.length - 25} more)` : ""}`);
    }
    if (el.isContentEditable && !el.parentElement?.isContentEditable) {
      const t = clean(el.innerText, 120);
      if (t) parts.push(`value=${JSON.stringify(t)}`);
    }
    const expanded = el.getAttribute("aria-expanded");
    if (expanded) parts.push(`expanded=${expanded}`);
    const checked = el.getAttribute("aria-checked");
    if (checked && !el.matches("input")) parts.push(`checked=${checked}`);
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    return parts.join(" ");
  }

  const shortDesc = (el) => {
    const name = accessibleName(el);
    return `${roleOf(el)}${name ? ` "${clean(name, 60)}"` : ""} [${refFor(el)}]`;
  };

  // --- snapshot ---------------------------------------------------------------

  function snapshot({ selector, interactiveOnly = false, maxLength = DEFAULT_MAX_LENGTH } = {}) {
    const root = selector ? resolve({ selector }) : document.body || document.documentElement;
    cursorMemo = new WeakMap(); // styles change between snapshots
    for (const [r, weak] of refs) if (!weak.deref()) refs.delete(r); // only refs whose element is gone
    const lines = [];
    const emit = (depth, text) => lines.push("  ".repeat(depth) + text);

    // Whether a subtree contains anything that needs its own line (so it can't
    // be flattened into plain text). Memoized, so the whole walk stays O(n).
    const memo = new WeakMap();
    const STRUCTURAL = "h1,h2,h3,h4,h5,h6,img[alt],iframe,frame,tr";
    function hasStructureInside(el) {
      if (memo.has(el)) return memo.get(el);
      let found = !!shadowOf(el);
      for (const child of el.children) {
        if (found) break;
        found = isInteractive(child) || child.matches(STRUCTURAL) || child.tagName === "SLOT" || hasStructureInside(child);
      }
      memo.set(el, found);
      return found;
    }

    // Children in rendered order: a shadow root replaces the light DOM, and slots
    // render the light DOM nodes assigned to them.
    function childrenOf(el) {
      if (el.tagName === "SLOT") {
        const assigned = el.assignedNodes({ flatten: true });
        return assigned.length ? assigned : el.childNodes;
      }
      return (shadowOf(el) || el).childNodes;
    }

    function walkChildren(parent, depth) {
      for (const child of childrenOf(parent)) {
        if (child.nodeType === Node.TEXT_NODE) {
          if (interactiveOnly) continue;
          const t = clean(child.textContent, 1000);
          if (t) emit(depth, t);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child, depth);
        }
      }
    }

    function walk(el, depth) {
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.getAttribute("aria-hidden") === "true" || !isVisible(el)) return;

      if (isFrame(el)) {
        // Tracking and ad frames are often 0×0 but full of (invisible) content.
        const box = el.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) return;
        const src = el.src && !el.src.startsWith("javascript:") ? el.src : "";
        const label = clean(el.title || el.name || src, 120);
        const doc = frameDocOf(el);
        if (!doc?.body) {
          // Cross-origin: leave a marker for the background to fill with the frame's own snapshot.
          emit(depth, `[iframe${label ? ` ${JSON.stringify(label)}` : ""}]`);
          emit(depth + 1, FRAME_MARK + tokenFor(el));
          return;
        }
        // Same-origin: include its contents, headed by the frame if it has any.
        const start = lines.length;
        walk(doc.body, depth + 1);
        if (lines.length > start) lines.splice(start, 0, "  ".repeat(depth) + `[iframe${label ? ` ${JSON.stringify(label)}` : ""}]`);
        return;
      }

      if (isInteractive(el)) {
        emit(depth, describe(el));
        if (hasStructureInside(el)) walkChildren(el, depth + 1);
        return;
      }

      const heading = /^H([1-6])$/.exec(el.tagName);
      if (heading) {
        if (!interactiveOnly) emit(depth, `${"#".repeat(+heading[1])} ${clean(el.innerText, 300)}`);
        if (hasStructureInside(el)) walkChildren(el, depth + 1);
        return;
      }

      if (el.tagName === "IMG") {
        if (!interactiveOnly && el.alt) emit(depth, `img ${JSON.stringify(clean(el.alt, 120))}`);
        return;
      }

      // A label's text is already the name of its control; don't repeat it.
      if (el.tagName === "LABEL" && el.control) {
        for (const child of el.children) walk(child, depth);
        return;
      }

      const landmark = LANDMARKS[el.tagName] || (el.getAttribute("role") === "dialog" ? "dialog" : null);
      if (landmark) {
        const name = el.getAttribute("aria-label");
        emit(depth, `[${landmark}${name ? ` "${clean(name, 60)}"` : ""}]`);
        walkChildren(el, depth + 1);
        return;
      }

      // Leaf block with no interactive content: emit its text as one line.
      if (!hasStructureInside(el)) {
        if (interactiveOnly) return;
        const t =
          el.tagName === "TR"
            ? [...el.cells].map((c) => clean(c.innerText, 300)).filter(Boolean).join(" | ")
            : clean(el.innerText ?? el.textContent, 2000);
        if (t) emit(depth, el.tagName === "LI" ? `- ${t}` : el.tagName === "TR" ? `| ${t}` : t);
        return;
      }
      walkChildren(el, depth);
    }

    walk(root, 0);

    const focused = deepActive();
    const header =
      `Page: ${document.title}\nURL: ${location.href}\n` +
      `Scroll: ${Math.round(scrollY)} of ${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px\n` +
      (focused && focused !== document.body ? `Focused: ${shortDesc(focused)}\n` : "") +
      "\n";
    return truncate(header + dedupe(lines).join("\n"), maxLength);
  }

  // Drops a line repeating the one before it: a wrapper and its only child often
  // carry the same text. Repeated table rows and list items are real and stay.
  function dedupe(lines) {
    return lines.filter((l, i) => l !== lines[i - 1] || /^\s*[|-] /.test(l));
  }

  // Cuts at a line break when there is one nearby, so lines (and frame markers) stay whole.
  function truncate(text, maxLength = DEFAULT_MAX_LENGTH) {
    if (text.length <= maxLength) return text;
    const nl = text.lastIndexOf("\n", maxLength);
    const cut = nl > maxLength * 0.8 ? nl : maxLength;
    return text.slice(0, cut) + `\n… [truncated ${text.length - cut} characters; use selector or maxLength]`;
  }

  // --- event helpers ----------------------------------------------------------

  const BUTTONS = { left: 0, middle: 1, right: 2 };

  function center(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }

  function mouse(el, type, x, y, button = 0, extra = {}) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    return el.dispatchEvent(
      new Ctor(type, {
        bubbles: !["mouseenter", "mouseleave", "pointerenter", "pointerleave"].includes(type),
        cancelable: true,
        composed: true,
        view: winOf(el),
        clientX: x,
        clientY: y,
        button,
        buttons: type.endsWith("down") ? { 0: 1, 1: 4, 2: 2 }[button] : 0, // the bitmask is left=1, right=2, middle=4
        pointerId: 1, // a real mouse; libraries call setPointerCapture with it
        pointerType: "mouse",
        isPrimary: true,
        ...extra,
      })
    );
  }

  // Legacy key codes for named keys and US-layout punctuation; letters and digits use their character code.
  const NAMED_KEYS = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, " ": 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
  const PUNCTUATION = { ";": 186, ":": 186, "=": 187, "+": 187, ",": 188, "<": 188, "-": 189, _: 189, ".": 190, ">": 190, "/": 191, "?": 191, "`": 192, "~": 192, "[": 219, "{": 219, "\\": 220, "|": 220, "]": 221, "}": 221, "'": 222, '"': 222 };

  function key(el, type, keyName, modifiers = []) {
    const ch = keyName.length === 1 ? keyName : null;
    let code = keyName;
    if (ch) code = /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : /[0-9]/.test(ch) ? `Digit${ch}` : ch === " " ? "Space" : "";
    const keyCode = NAMED_KEYS[keyName] ?? PUNCTUATION[keyName] ?? (ch ? ch.toUpperCase().charCodeAt(0) : 0);
    // keyCode, which and charCode go in the init object: properties defined on the
    // event here, in Choro's isolated world, would be invisible to the page's scripts.
    const ev = new KeyboardEvent(type, {
      key: keyName,
      code,
      keyCode,
      which: type === "keypress" && ch ? ch.charCodeAt(0) : keyCode,
      charCode: type === "keypress" && ch ? ch.charCodeAt(0) : 0,
      bubbles: true,
      cancelable: true,
      composed: true,
      altKey: modifiers.includes("Alt"),
      ctrlKey: modifiers.includes("Control"),
      metaKey: modifiers.includes("Meta"),
      shiftKey: modifiers.includes("Shift") || (!!ch && ch !== ch.toLowerCase()),
    });
    return el.dispatchEvent(ev);
  }

  // Covering elements (cookie banners, overlays) are a common reason clicks "do nothing".
  function coverWarning(el, x, y) {
    let hit = docOf(el).elementFromPoint(x, y);
    // elementFromPoint stops at shadow hosts; descend into their shadow roots.
    for (let root = hit && shadowOf(hit); root; root = hit && shadowOf(hit)) {
      const inner = root.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit || composedContains(el, hit) || composedContains(hit, el)) return "";
    return `\nWarning: the element appears to be covered by ${shortDesc(hit.closest(INTERACTIVE) || hit)}.`;
  }

  // Like Node.contains, but also crosses shadow boundaries.
  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode || n.host) if (n === ancestor) return true;
    return false;
  }

  // Inputs whose value must be set whole: typing them a character at a time
  // passes through invalid partial values, which the browser throws away.
  const WHOLE_VALUE_TYPES = {
    date: "YYYY-MM-DD",
    time: "HH:MM",
    "datetime-local": "YYYY-MM-DDTHH:MM",
    month: "YYYY-MM",
    week: "YYYY-Www",
    color: "#rrggbb",
    range: "a number in range",
    number: "a number",
  };
  const isWholeValue = (el) => el.tagName === "INPUT" && el.type in WHOLE_VALUE_TYPES;

  const isTextField = (el) =>
    el.tagName === "TEXTAREA" ||
    (el.tagName === "INPUT" &&
      !isWholeValue(el) &&
      !["checkbox", "radio", "submit", "button", "reset", "image", "file"].includes(el.type));

  function assertEditable(el) {
    if (el.disabled) throw new Error(`${shortDesc(el)} is disabled.`);
    if (el.readOnly) throw new Error(`${shortDesc(el)} is read-only.`);
  }

  function setWholeValue(el, value) {
    assertEditable(el);
    focusDeep(el);
    setNativeValue(el, String(value));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (el.value !== String(value) && !(el.type === "color" && el.value === String(value).toLowerCase())) {
      throw new Error(
        `${shortDesc(el)} didn't accept "${value}" (it holds "${el.value}"); it expects ${WHOLE_VALUE_TYPES[el.type]}.`
      );
    }
  }

  // Editors that own their document (ProseMirror, Lexical, Slate) apply
  // beforeinput events to their own model and cancel the browser's editing.
  // execCommand doesn't send beforeinput, so send it first: if the editor
  // handles it, the browser's edit is skipped. Returns true if handled.
  function editorHandled(el, inputType, data = null) {
    const ev = new InputEvent("beforeinput", { bubbles: true, cancelable: true, composed: true, inputType, data });
    return !el.dispatchEvent(ev);
  }

  // Sets value through the native setter so frameworks like React notice the change.
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  function selectAllIn(el) {
    if (isTextField(el)) {
      try {
        el.select();
      } catch {
        /* e.g. type=email does not support selection; execCommand selectAll still works */
      }
    }
    docOf(el).execCommand("selectAll");
  }

  function clearField(el) {
    focusDeep(el);
    selectAllIn(el);
    if (!editorHandled(el, "deleteContentBackward")) docOf(el).execCommand("delete");
    if (isTextField(el) && el.value) {
      setNativeValue(el, "");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    }
  }

  // Returns how many characters didn't fit (maxlength).
  function typeText(el, text) {
    focusDeep(el);
    const max = isTextField(el) && el.maxLength >= 0 ? el.maxLength : Infinity;
    let dropped = 0;
    for (const ch of text) {
      if (isTextField(el) && el.value.length >= max && el.selectionStart === el.selectionEnd) {
        dropped++;
        continue;
      }
      // An input mask that cancels a key press rejects the character, as it would for a person.
      if (!key(el, "keydown", ch) || !key(el, "keypress", ch)) {
        key(el, "keyup", ch);
        continue;
      }
      // execCommand goes through the browser's real editing pipeline (input events,
      // undo stack, framework-friendly). Fall back to setting the value directly.
      if (!editorHandled(el, "insertText", ch)) {
        const before = isTextField(el) ? el.value : null;
        const ok = docOf(el).execCommand("insertText", false, ch);
        if (isTextField(el) && (!ok || el.value === before)) {
          // Insert at the caret (replacing any selection), as typing would.
          const start = el.selectionStart ?? before.length;
          const end = el.selectionEnd ?? start;
          setNativeValue(el, before.slice(0, start) + ch + before.slice(end));
          try {
            el.setSelectionRange(start + ch.length, start + ch.length);
          } catch {
            /* types without selection (email, number) */
          }
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
        }
      }
      key(el, "keyup", ch);
    }
    if (isTextField(el)) el.dispatchEvent(new Event("change", { bubbles: true }));
    return dropped;
  }

  // Implicit submission: what the browser does when Enter is pressed in a field.
  // Hidden submit buttons are skipped: forms often contain ones with unrelated
  // handlers (Google's search form starts with a hidden voice search "Stop recording").
  function implicitSubmit(form) {
    const submitter = [...form.querySelectorAll("button:not([type]), button[type=submit], input[type=submit], input[type=image]")].find(
      (b) => b.form === form && !b.disabled && isVisible(b)
    );
    if (submitter) submitter.click();
    else form.requestSubmit();
  }

  // Returns a note on what the default action did, for the command's result.
  // With submit=true (type's "submit" option), a textarea inside a form submits the
  // form instead of getting a line break: sites like Google use a textarea as a
  // one-line search box and only submit on trusted Enter presses.
  function pressEnter(el, { submit = false } = {}) {
    const notCancelled = key(el, "keydown", "Enter");
    key(el, "keypress", "Enter");
    let note = "";
    if (!notCancelled) {
      note = "the page handled the key";
    } else if (submit && el.tagName === "TEXTAREA" && el.form) {
      implicitSubmit(el.form);
      note = "submitted the form";
    } else if (el.tagName === "TEXTAREA" || el.isContentEditable) {
      docOf(el).execCommand("insertLineBreak");
      note = "inserted a line break";
    } else if (el.tagName === "INPUT" && el.form) {
      implicitSubmit(el.form);
      note = "submitted the form";
    } else if (el.matches("a[href], button, [role=button], [role=link]")) {
      el.click();
      note = "activated the element";
    }
    key(el, "keyup", "Enter");
    return note;
  }

  // `value` is one option (value or label) or, for multi-selects, a list: a list
  // selects exactly those options, a single value adds to the selection.
  function selectOption(el, value) {
    if (el.tagName !== "SELECT") throw new Error(`${shortDesc(el)} is not a <select>. For custom dropdowns, click it and then click the option.`);
    assertClickable(el);
    const opts = [...el.options].filter((o) => !o.disabled && !o.closest("optgroup[disabled]"));
    const find = (v) => {
      const want = String(v);
      const opt =
        opts.find((o) => o.value === want) ||
        opts.find((o) => clean(o.text) === clean(want)) ||
        opts.find((o) => clean(o.text).toLowerCase() === clean(want).toLowerCase()) ||
        opts.find((o) => clean(o.text).toLowerCase().includes(clean(want).toLowerCase()));
      if (!opt) throw new Error(`No option matching "${want}". Options: ${opts.map((o) => clean(o.text, 40)).join(" | ")}`);
      return opt;
    };
    const wanted = (Array.isArray(value) ? value : [value]).map(find);
    if (wanted.length > 1 && !el.multiple) throw new Error(`${shortDesc(el)} allows only one option.`);
    el.focus();
    if (el.multiple) {
      if (Array.isArray(value)) for (const o of opts) o.selected = false;
      for (const o of wanted) o.selected = true;
    } else {
      setNativeValue(el, wanted[0].value);
      wanted[0].selected = true;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    const now = [...el.selectedOptions].map((o) => `"${clean(o.text)}"`).join(", ");
    return `Selected ${now || "nothing"} in ${shortDesc(el)}`;
  }

  const isCheckable = (el) => el.type === "checkbox" || el.type === "radio" || el.hasAttribute("aria-checked");
  const isChecked = (el) => (el.tagName === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true");

  function setChecked(el, checked) {
    if (!isCheckable(el)) throw new Error(`${shortDesc(el)} is not a checkbox, radio or switch.`);
    assertClickable(el);
    const isOn = () => isChecked(el);
    if (isOn() !== checked) el.click();
    if (isOn() !== checked) throw new Error(`Could not set ${shortDesc(el)} to ${checked ? "checked" : "unchecked"}.`);
    return `${checked ? "Checked" : "Unchecked"} ${shortDesc(el)}`;
  }

  function scrollableAround(el) {
    for (let n = el; n && n !== docOf(el).documentElement; n = n.parentElement) {
      const oy = styleOf(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
    }
    const doc = docOf(el).scrollingElement;
    return doc && doc.scrollHeight > doc.clientHeight + 1 ? doc : null;
  }

  function findScroller() {
    const doc = document.scrollingElement || document.documentElement;
    if (doc.scrollHeight > innerHeight + 1) return doc;
    // Apps often scroll an inner container instead of the document.
    let best = doc;
    let bestArea = 0;
    for (const el of document.querySelectorAll("body *")) {
      if (el.scrollHeight <= el.clientHeight + 1) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll") continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  // --- commands ---------------------------------------------------------------

  let hiddenFixed = []; // [element, inline visibility, priority] hidden during a full-page screenshot

  // Every frame element on the page, including ones inside (open or closed)
  // shadow roots and inside same-origin frames.
  function allFrames(root = document, depth = 0, out = []) {
    const visit = (node, inShadow) => {
      for (const el of node.querySelectorAll("*")) {
        if (isFrame(el) || el.tagName === "EMBED" || el.tagName === "OBJECT") {
          out.push({ el, depth, inShadow });
          const d = isFrame(el) && frameDocOf(el);
          if (d?.documentElement) allFrames(d, depth + 1, out);
        }
        const sr = shadowOf(el);
        if (sr) visit(sr, true);
      }
    };
    visit(root, false);
    return out;
  }

  const frameUrl = (el) => el.src || el.data || el.getAttribute("src") || "";
  const extensionIdOf = (url) => /^(?:chrome-extension:\/\/([a-p]{32})|moz-extension:\/\/([0-9a-f-]{36}))/.exec(url)?.slice(1).find(Boolean) || null;

  const commands = {
    snapshot,

    // For the next few seconds, dialogs in this page (and its same-origin frames)
    // are answered by page-hooks.js instead of being shown.
    setDialogPolicy({ accept, promptText, ms = 10_000 }) {
      const detail = JSON.stringify({ accept, promptText, until: Date.now() + ms });
      for (const doc of [document, ...frameDocs()]) doc.defaultView?.dispatchEvent(new CustomEvent("__choro_policy", { detail }));
    },

    clearDialogPolicy() {
      for (const doc of [document, ...frameDocs()]) doc.defaultView?.dispatchEvent(new CustomEvent("__choro_policy", { detail: "null" }));
    },

    frameToken() {
      return myFrameToken;
    },

    // Frames that loaded after the snapshot missed their token: send it again.
    repostFrameTokens({ tokens }) {
      for (const t of tokens) {
        const f = frameTokens.get(t)?.deref();
        try {
          f?.contentWindow?.postMessage({ __choroFrameToken: t }, "*");
        } catch {
          /* frame gone */
        }
      }
    },

    // Where a cross-origin child frame's content starts, in this page's top coordinates.
    frameRect({ token, scroll = false }) {
      const f = frameTokens.get(token)?.deref();
      if (!f || !f.isConnected) throw new Error("That frame is no longer on the page. Take a new snapshot.");
      if (scroll) f.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
      const r = topRect(f);
      const st = styleOf(f);
      const [pl, pr, pt, pb] = [st.paddingLeft, st.paddingRight, st.paddingTop, st.paddingBottom].map(parseFloat);
      return {
        left: r.left + f.clientLeft + pl,
        top: r.top + f.clientTop + pt,
        width: f.clientWidth - pl - pr,
        height: f.clientHeight - pt - pb,
      };
    },

    listFrames() {
      const lines = allFrames().map(({ el, depth, inShadow }) => {
        const r = el.getBoundingClientRect();
        const url = frameUrl(el);
        const ext = extensionIdOf(url);
        const kind = ext ? `extension ${ext}` : frameDocOf(el)?.documentElement ? "same-origin" : "cross-origin";
        return (
          "  ".repeat(depth) +
          `${el.tagName.toLowerCase()} ${Math.round(r.width)}×${Math.round(r.height)} ${kind}` +
          `${inShadow ? " (in shadow root)" : ""} ${clean(url, 150) || "(no src)"}`
        );
      });
      return lines.length ? lines.join("\n") : "No frames on this page.";
    },

    getText({ maxLength, ...target }) {
      const el = resolve(target, { optional: true }) || document.body || document.documentElement;
      return truncate(el.innerText ?? el.textContent, maxLength);
    },

    getHtml({ maxLength, ...target }) {
      const el = resolve(target, { optional: true }) || document.documentElement;
      return truncate(el.outerHTML, maxLength);
    },

    elementRect({ scroll = true, forClick = false, ...target }) {
      const el = resolve(target);
      if (forClick) assertClickable(el);
      if (scroll) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = topRect(el);
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
        left: r.left,
        top: r.top,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        docX: r.left + scrollX,
        docY: r.top + scrollY,
        description: shortDesc(el),
        newTab: opensNewTab(el),
      };
    },

    pageMetrics() {
      const doc = document.scrollingElement || document.documentElement;
      return {
        scrollHeight: doc.scrollHeight,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        clientWidth: document.documentElement.clientWidth,
        devicePixelRatio,
        scrollX,
        scrollY,
      };
    },

    // Returns where the page actually ended up (it clamps at the bottom).
    scrollToY({ y, x = 0 }) {
      scrollTo({ left: x, top: y, behavior: "instant" });
      return scrollY;
    },

    hideFixed({ hide }) {
      if (!hide) {
        for (const [el, value, priority] of hiddenFixed) {
          if (value) el.style.setProperty("visibility", value, priority);
          else el.style.removeProperty("visibility");
        }
        hiddenFixed = [];
        return;
      }
      for (const el of document.querySelectorAll("body *")) {
        const pos = getComputedStyle(el).position;
        if ((pos === "fixed" || pos === "sticky") && getComputedStyle(el).visibility !== "hidden") {
          hiddenFixed.push([el, el.style.getPropertyValue("visibility"), el.style.getPropertyPriority("visibility")]);
          el.style.setProperty("visibility", "hidden", "important");
        }
      }
    },

    focus({ clear, ...target }) {
      const el = intoFrame(resolve(target));
      if (clear) assertEditable(el);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      focusDeep(el);
      if (clear) clearField(el);
      return shortDesc(el);
    },

    click({ button = "left", doubleClick, offsetX, offsetY, ...target }) {
      const el = resolve(target);
      assertClickable(el);
      let { x, y, rect } = center(el);
      if (offsetX != null) x = rect.left + offsetX;
      if (offsetY != null) y = rect.top + offsetY;
      const b = BUTTONS[button] ?? 0;
      const warning = coverWarning(el, x, y);
      mouse(el, "pointerover", x, y);
      mouse(el, "mouseover", x, y);
      mouse(el, "pointermove", x, y);
      mouse(el, "mousemove", x, y);
      const clicks = doubleClick ? 2 : 1;
      for (let i = 1; i <= clicks; i++) {
        mouse(el, "pointerdown", x, y, b);
        if (mouse(el, "mousedown", x, y, b, { detail: i }) && el.focus) el.focus({ preventScroll: true });
        mouse(el, "pointerup", x, y, b);
        mouse(el, "mouseup", x, y, b, { detail: i });
        if (button === "left") mouse(el, "click", x, y, b, { detail: i });
        else if (button === "middle") mouse(el, "auxclick", x, y, b);
      }
      if (doubleClick) mouse(el, "dblclick", x, y, b, { detail: 2 });
      if (button === "right") mouse(el, "contextmenu", x, y, b);
      return { text: `Clicked ${shortDesc(el)}${warning}`, newTab: opensNewTab(el) };
    },

    // Drags one element onto another: HTML5 drag and drop for draggable sources,
    // otherwise a pointer press-move-release (sortable lists, sliders, canvases).
    drag({ to, ...target }) {
      const src = resolve(target);
      const srcNote = matchNote;
      const dst = resolve(to);
      matchNote = srcNote + (matchNote && matchNote !== srcNote ? ` (target${matchNote})` : "");
      assertClickable(src);
      const a = center(src);
      const r = dst.getBoundingClientRect();
      const b = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      mouse(src, "pointerdown", a.x, a.y);
      mouse(src, "mousedown", a.x, a.y);
      // Links and images are draggable by default; only an explicit draggable=true means an HTML5 drag.
      if (src.closest("[draggable=true]")) {
        const dataTransfer = new DataTransfer();
        const drag = (el, type, p) =>
          el.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, dataTransfer })
          );
        drag(src, "dragstart", a);
        drag(dst, "dragenter", b);
        const accepted = !drag(dst, "dragover", b);
        if (accepted) drag(dst, "drop", b);
        drag(src, "dragend", b);
        return `Dragged ${shortDesc(src)} onto ${shortDesc(dst)}${accepted ? "" : " (the target did not accept the drop)"}`;
      }
      for (let i = 1; i <= 5; i++) {
        const p = { x: a.x + ((b.x - a.x) * i) / 5, y: a.y + ((b.y - a.y) * i) / 5 };
        const over = docOf(dst).elementFromPoint(p.x, p.y) || dst;
        mouse(over, "pointermove", p.x, p.y, 0, { buttons: 1 });
        mouse(over, "mousemove", p.x, p.y, 0, { buttons: 1 });
      }
      mouse(dst, "pointerup", b.x, b.y);
      mouse(dst, "mouseup", b.x, b.y);
      return `Dragged ${shortDesc(src)} to ${shortDesc(dst)} (pointer drag)`;
    },

    hover(target) {
      const el = resolve(target);
      const { x, y } = center(el);
      for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(el, t, x, y);
      return `Hovering ${shortDesc(el)}`;
    },

    type({ text, clear = true, submit, ...target }) {
      const el = intoFrame(resolve(target));
      el.scrollIntoView({ block: "center", behavior: "instant" });
      if (isWholeValue(el)) {
        setWholeValue(el, text);
        let out = `Set ${shortDesc(el)} to ${JSON.stringify(el.value)}`;
        if (submit) {
          const note = pressEnter(el, { submit: true });
          out += `; pressed Enter${note ? ` (${note})` : ""}`;
        }
        return out;
      }
      if (!isTextField(el) && !el.isContentEditable) {
        throw new Error(`${shortDesc(el)} is not a text field. Click it first if it opens an editor.`);
      }
      assertEditable(el);
      if (clear) clearField(el);
      const dropped = typeText(el, text);
      const value = isTextField(el) ? (el.type === "password" ? "••••" : el.value) : el.innerText;
      let out = `Typed into ${shortDesc(el)}; value is now ${JSON.stringify(clean(value, 300))}`;
      if (dropped) out += ` (the field takes at most ${el.maxLength} characters; the last ${dropped} were not typed)`;
      if (submit) {
        const note = pressEnter(el, { submit: true });
        out += `; pressed Enter${note ? ` (${note})` : ""}`;
      }
      return out;
    },

    fillForm({ fields }) {
      const results = [];
      for (const f of fields) {
        matchNote = "";
        try {
          const el = intoFrame(resolve(f));
          const note = matchNote;
          matchNote = "";
          if (isCheckable(el)) {
            results.push(setChecked(el, f.value === true || f.value === "true") + note);
          } else if (el.tagName === "SELECT") {
            results.push(selectOption(el, f.value) + note);
          } else if (isWholeValue(el)) {
            setWholeValue(el, f.value);
            results.push(`Set ${shortDesc(el)} to ${JSON.stringify(el.value)}${note}`);
          } else {
            if (!isTextField(el) && !el.isContentEditable) throw new Error(`${shortDesc(el)} is not a text field.`);
            assertEditable(el);
            clearField(el);
            const dropped = typeText(el, String(f.value));
            el.blur();
            results.push(`Filled ${shortDesc(el)}${dropped ? ` (only the first ${el.maxLength} characters fit)` : ""}${note}`);
          }
        } catch (err) {
          results.push(`FAILED ${f.ref || f.selector || JSON.stringify(f.name)}: ${err.message}`);
        }
      }
      matchNote = "";
      return results.join("\n");
    },

    // Which filled fields no longer hold what was put in them (e.g. a password
    // manager filled them again). Only says whether values match; never returns them.
    changedFields({ fields }) {
      const changed = [];
      for (const f of fields) {
        let el;
        try {
          el = intoFrame(resolve(f));
        } catch {
          continue;
        }
        const want = f.value;
        const now =
          isCheckable(el)
            ? isChecked(el) === (want === true || want === "true")
            : el.tagName === "SELECT"
              ? true // select options were matched by label or value; checked when chosen
              : isTextField(el) || isWholeValue(el)
                ? el.value.toLowerCase() === String(want).toLowerCase() || (el.maxLength > 0 && el.value === String(want).slice(0, el.maxLength))
                : clean(el.innerText, Infinity) === clean(String(want), Infinity);
        if (!now) changed.push(shortDesc(el));
      }
      return changed;
    },

    // files: [{name, type, data (base64)}], read from disk by the server.
    uploadFiles({ files, ...target }) {
      const el = resolve(target);
      const win = winOf(el);
      const bytesOf = new Map();
      const list = files.map((f) => {
        const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
        const file = new win.File([bytes], f.name, { type: f.type, lastModified: f.lastModified });
        bytesOf.set(file, bytes.buffer);
        return file;
      });
      const dt = new win.DataTransfer();
      for (const f of list) dt.items.add(f);
      const names = list.map((f) => f.name).join(", ");

      const input = fileInputFor(el);
      if (!input) {
        // No file input: a drag-and-drop zone. Files are dropped on it as a person would.
        assertClickable(el);
        // Firefox keeps a content script's objects apart from the page's: the page
        // would see an empty DataTransfer. There, the event is built from the page's own
        // constructors (wrappedJSObject), with the bytes cloned in.
        const page = win.wrappedJSObject;
        let drop = dt;
        let init = (type) => new win.DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: drop });
        if (page) {
          drop = new page.DataTransfer();
          for (const f of list) {
            const opts = cloneInto({ type: f.type, lastModified: f.lastModified }, page);
            drop.items.add(new page.File(cloneInto([new Uint8Array(bytesOf.get(f))], page), f.name, opts));
          }
          init = (type) => {
            const o = new page.Object();
            Object.assign(o, { bubbles: true, cancelable: true, composed: true });
            o.dataTransfer = drop;
            return new page.DragEvent(type, o);
          };
        }
        for (const type of ["dragenter", "dragover", "drop"]) el.dispatchEvent(init(type));
        return `Dropped ${names} onto ${shortDesc(el)} (it has no file input; check that the page took them)`;
      }
      if (input.disabled) throw new Error(`${shortDesc(input)} is disabled.`);
      if (list.length > 1 && !input.multiple) {
        throw new Error(`${shortDesc(input)} takes one file, not ${list.length}.`);
      }
      input.files = dt.files;
      input.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new win.Event("change", { bubbles: true }));
      const notes = [];
      const accept = (input.getAttribute("accept") || "").trim();
      if (accept) {
        const ok = (f) =>
          accept.split(",").some((a) => {
            a = a.trim().toLowerCase();
            if (a.startsWith(".")) return f.name.toLowerCase().endsWith(a);
            if (a.endsWith("/*")) return f.type.startsWith(a.slice(0, -1));
            return f.type === a;
          });
        const off = list.filter((f) => !ok(f)).map((f) => f.name);
        if (off.length) notes.push(`the input accepts ${accept}, which ${off.join(", ")} may not match`);
      }
      const via = input === el ? "" : ` (the file input of ${shortDesc(el)})`;
      return `Attached ${names} to ${shortDesc(input)}${via}${notes.length ? `; note: ${notes.join("; ")}` : ""}`;
    },

    selectOption({ value, ...target }) {
      return selectOption(resolve(target), value);
    },

    setChecked({ checked, ...target }) {
      return setChecked(resolve(target), checked);
    },

    pressKey({ key: keyName, modifiers = [], ...target }) {
      const given = resolve(target, { optional: true });
      const el = given ? intoFrame(given) : deepActive() || document.body;
      if (given) focusDeep(el);
      let note = "";
      if (keyName === "Enter" && modifiers.length === 0) {
        note = pressEnter(el);
      } else {
        const notCancelled = key(el, "keydown", keyName, modifiers);
        if (keyName.length === 1 && !modifiers.some((m) => m === "Control" || m === "Meta")) {
          key(el, "keypress", keyName, modifiers);
          if (notCancelled && (isTextField(el) || el.isContentEditable) && !editorHandled(el, "insertText", keyName)) {
            docOf(el).execCommand("insertText", false, keyName);
          }
        } else if (notCancelled && keyName === "Backspace" && (isTextField(el) || el.isContentEditable)) {
          if (!editorHandled(el, "deleteContentBackward")) docOf(el).execCommand("delete");
        }
        key(el, "keyup", keyName, modifiers);
      }
      return `Pressed ${[...modifiers, keyName].join("+")} on ${el === document.body ? "page" : shortDesc(el)}${note ? ` (${note})` : ""}`;
    },

    submitForm(target) {
      const el = resolve(target);
      const form = el.tagName === "FORM" ? el : el.form || el.closest("form");
      if (!form) throw new Error(`${shortDesc(el)} is not inside a form. Click its submit button instead.`);
      if (!form.checkValidity()) {
        const invalid = [...form.elements]
          .filter((f) => f.willValidate && !f.checkValidity())
          .map((f) => `${shortDesc(f)}: ${f.validationMessage}`);
        form.reportValidity();
        throw new Error(`Form is not valid:\n${invalid.join("\n")}`);
      }
      // Only submit buttons can be the submitter; requestSubmit throws for others.
      const submitter = (el.type === "submit" || el.type === "image") && el.form === form ? el : undefined;
      form.requestSubmit(submitter);
      const id = form.getAttribute("id"); // form.id would be an <input name="id"> if there is one
      return `Submitted form${id ? ` #${id}` : ""}`;
    },

    scroll({ direction, amount, ...target }) {
      let s;
      if (target.ref || target.selector || target.name) {
        const el = resolve(target);
        if (!direction) {
          el.scrollIntoView({ block: "center", behavior: "instant" });
          return `Scrolled ${shortDesc(el)} into view`;
        }
        // With a direction, scroll the element itself (or the nearest scrollable box around it).
        s = scrollableAround(el);
        if (!s) throw new Error(`Neither ${shortDesc(el)} nor anything around it scrolls.`);
      } else {
        s = findScroller();
      }
      const isDoc = s === document.scrollingElement || s === document.documentElement;
      const step = amount ?? (isDoc ? innerHeight : s.clientHeight) * 0.85;
      const moves = {
        down: [0, step],
        up: [0, -step],
        right: [step, 0],
        left: [-step, 0],
        top: [0, -s.scrollHeight],
        bottom: [0, s.scrollHeight],
      };
      const [dx, dy] = moves[direction || "down"];
      s.scrollBy({ left: dx, top: dy, behavior: "instant" });
      const max = s.scrollHeight - (isDoc ? innerHeight : s.clientHeight);
      return `Scrolled ${direction || "down"}${isDoc ? "" : " (inner container)"}; now at ${Math.round(s.scrollTop)} of ${Math.max(0, Math.round(max))}px`;
    },

    check({ selector, text, gone }) {
      let present;
      if (selector) {
        present = allRoots().some((root) => [...root.querySelectorAll(selector)].some(isVisible));
      } else if (text) {
        present = [document, ...frameDocs()].some((d) => (d.body || d.documentElement)?.innerText?.includes(text));
      } else {
        throw new Error("Provide selector or text.");
      }
      return gone ? !present : present;
    },
  };

  window.__choro = {
    version: VERSION,
    async run(method, args) {
      try {
        const fn = commands[method];
        if (!fn) throw new Error(`Unknown page command: ${method}`);
        matchNote = "";
        let value = await fn(args || {});
        if (matchNote) {
          if (typeof value === "string") value += matchNote;
          else if (typeof value?.text === "string") value = { ...value, text: value.text + matchNote };
          else if (typeof value?.description === "string") value = { ...value, description: value.description + matchNote };
        }
        return { ok: true, value };
      } catch (err) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
  };
})();
