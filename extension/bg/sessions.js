// Agent sessions and the tabs they use.
//
// Several agent sessions can share the browser (the server's hub tags each call
// with its session). Each session has its own current tab, and a tab a session
// works in is off limits to the others while that session lives. The state is
// kept in storage.session so it survives the background being suspended.

let tabState = null; // { current: {session: tabId}, owners: {tabId: session}, live: [session] }
let loading = null;
let onOwnerChange = () => {}; // (tabId, newOwner | null, oldOwner | null)

// background.js: switch a tab's page hooks and network log as it becomes (or stops being) an agent's.
export const watchOwners = (fn) => (onOwnerChange = fn);

// One load shared by everyone, so concurrent callers at wake-up don't each load
// their own copy and overwrite each other's changes.
async function sessionState() {
  loading ??= chrome.storage.session.get("tabState").then((r) => {
    tabState = r.tabState || { current: {}, owners: {}, live: [] };
    return tabState;
  });
  return loading;
}
sessionState();

const save = () => chrome.storage.session.set({ tabState });

const isLive = (st, session) => st.live.includes(session);

// The live session (other than `session`) holding the tab, if any.
function otherOwner(st, tabId, session) {
  const owner = st.owners[tabId];
  return owner && owner !== session && isLive(st, owner) ? owner : null;
}

// For the network log, which must decide synchronously: is a live session
// working in this tab? Only those tabs are recorded.
export const isAgentTab = (tabId) => {
  const owner = tabState?.owners[tabId];
  return !!owner && tabState.live.includes(owner);
};

export async function setSessions(ids) {
  const st = await sessionState();
  st.live = ids;
  for (const [tab, owner] of Object.entries(st.owners)) {
    if (ids.includes(owner)) continue;
    delete st.owners[tab];
    onOwnerChange(Number(tab), null, owner);
  }
  for (const session of Object.keys(st.current)) if (!ids.includes(session)) delete st.current[session];
  await save();
}

const inUse = (tabId) =>
  new Error(`Tab ${tabId} is in use by another agent session. Pick a free tab from list_tabs, or open one with open_tab.`);

export async function claimTab(tabId, session) {
  const st = await sessionState();
  if (otherOwner(st, tabId, session)) throw inUse(tabId);
  const before = st.owners[tabId] ?? null;
  st.owners[tabId] = session;
  if (before !== session) onOwnerChange(tabId, session, before);
  st.current[session] = tabId;
  await save();
}

export async function assertNotOthers(tabId, session) {
  if (otherOwner(await sessionState(), tabId, session)) throw inUse(tabId);
}

// list_tabs: who uses each tab, from this session's point of view.
export async function tabUsage(session) {
  const st = await sessionState();
  return {
    current: st.current[session],
    usedBy: (tabId) => (st.owners[tabId] === session ? "you" : otherOwner(st, tabId, session) ? "another session" : null),
  };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const st = await sessionState();
  delete st.owners[tabId];
  for (const [session, id] of Object.entries(st.current)) if (id === tabId) delete st.current[session];
  await save();
});

// Tabs a session's actions open (links, window.open) belong to that session.
chrome.tabs.onCreated.addListener(async (t) => {
  if (t.openerTabId == null) return;
  const st = await sessionState();
  const owner = st.owners[t.openerTabId];
  if (owner && !st.owners[t.id]) {
    st.owners[t.id] = owner;
    onOwnerChange(t.id, owner, null);
    await save();
  }
});

// Resolves the tab a command targets: explicit id > the session's current tab >
// the active tab (if no other session holds it), and claims it for the session.
export async function getTab(tabId, ctx) {
  const tab = await resolveTab(tabId, ctx.session);
  ctx.use?.(tab.id);
  return tab;
}

async function resolveTab(tabId, session) {
  const st = await sessionState();
  if (tabId != null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error(`No tab with id ${tabId}. Use list_tabs to see open tabs.`);
    await claimTab(tab.id, session);
    return tab;
  }
  const current = st.current[session];
  if (current != null) {
    const tab = await chrome.tabs.get(current).catch(() => null);
    if (tab) {
      await claimTab(tab.id, session);
      return tab;
    }
  }
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!active) throw new Error("No active tab found. Use open_tab to open one.");
  if (otherOwner(st, active.id, session)) {
    throw new Error(
      "This session has no tab yet, and the active tab is in use by another agent session. Use open_tab, or " +
        "select_tab with a free tab from list_tabs."
    );
  }
  await claimTab(active.id, session);
  return active;
}
