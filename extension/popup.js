// Firefox's api.* uses callbacks in Manifest V2; its browser.* returns promises.
const api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
const $ = (id) => document.getElementById(id);

const LABELS = { connected: "Connected", connecting: "Connecting…", disconnected: "Not connected", unpaired: "Not paired" };

function render({ status, lastError }) {
  $("status").className = "row " + status;
  $("statusText").textContent = LABELS[status] || status;
  $("message").textContent = status === "connected" ? "" : lastError || "";
}

async function renderKey() {
  const { pairingKey } = await api.storage.local.get("pairingKey");
  $("key").value = "";
  $("key").placeholder = pairingKey ? "paired (paste a new key to change it)" : "paste the key here";
}

api.runtime.onMessage.addListener((msg) => {
  if (msg.type === "status") render(msg);
});

(async () => {
  const { port = 8765, enabled = true } = await api.storage.local.get(["port", "enabled"]);
  $("port").value = port;
  $("enabled").checked = enabled;
  await renderKey();
  render((await api.runtime.sendMessage({ type: "getStatus" }).catch(() => null)) || { status: "disconnected" });
})();

$("pair").addEventListener("click", async () => {
  const key = $("key").value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(key)) {
    $("message").textContent = "That doesn't look like a pairing key (64 characters, 0-9 and a-f).";
    return;
  }
  await api.storage.local.set({ pairingKey: key });
  await renderKey();
  api.runtime.sendMessage({ type: "reconnect" });
});
$("key").addEventListener("keydown", (e) => e.key === "Enter" && $("pair").click());

$("save").addEventListener("click", async () => {
  const port = Number($("port").value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    $("message").textContent = "The port must be a whole number from 1 to 65535.";
    return;
  }
  await api.storage.local.set({ port });
  api.runtime.sendMessage({ type: "reconnect" });
});

$("enabled").addEventListener("change", async (e) => {
  await api.storage.local.set({ enabled: e.target.checked });
  api.runtime.sendMessage({ type: e.target.checked ? "reconnect" : "disable" });
});
