import { mergeAccountCash, positionsInEur } from "./lib/fx.js";

const statusEl = document.querySelector("#status");
const totalEl = document.querySelector("#total");
const balanceEl = document.querySelector("#balance");
const metaEl = document.querySelector("#meta");
const messageEl = document.querySelector("#message");
const gatewayEl = document.querySelector("#gateway");
const pullBtn = document.querySelector("#pull");
const gatewayBtn = document.querySelector("#pull-gateway");

const money = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });

function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function nativeMix(positions) {
  const counts = new Map();
  for (const position of positions) {
    const code = position.nativeCurrency || "?";
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([code, count]) => `${count} ${code}`);
  return `${positions.length} позицій: ${parts.join(", ")}`;
}

function sourceLabel(source) {
  if (source === "portal") return "Client Portal";
  if (source === "gateway") return "Gateway";
  if (source === "manual") return "вставлені вручну";
  if (source === "demo") return "приклад";
  return source || "";
}

async function render(snapshot) {
  if (!snapshot) {
    statusEl.textContent = "НЕМАЄ ДАНИХ";
    statusEl.className = "status";
    totalEl.textContent = "—";
    balanceEl.textContent = "";
    metaEl.textContent = "Увійдіть у Client Portal і відкрийте Portfolio.";
    return;
  }
  const when = formatWhen(snapshot.syncedAt);
  const source = sourceLabel(snapshot.source);
  try {
    const stored = await chrome.storage.local.get("fxCache");
    const fx = await positionsInEur(snapshot, "all", stored.fxCache);
    if (!fx.table.stale) {
      await chrome.storage.local.set({
        fxCache: { at: fx.table.at, date: fx.table.date, rates: fx.table.rates, source: fx.table.source },
      });
    }
    const converted = fx.positions.filter((position) => !position.fxMissing && position.assetClass !== "CASH");
    const eurSum = converted.reduce((total, position) => total + position.value, 0);
    const usdRate = fx.table.rates?.USD;
    const usdSum = usdRate ? eurSum * usdRate : null;
    const merged = mergeAccountCash(fx.positions, snapshot, "all", fx.table);
    const balanceEur = merged.positions
      .filter((position) => !position.fxMissing)
      .reduce((total, position) => total + position.value, 0);
    const balanceUsd = usdRate ? balanceEur * usdRate : null;
    statusEl.textContent = fx.positions.length ? "Є ПОЗИЦІЇ" : "ПОРОЖНЬО";
    statusEl.className = fx.positions.length ? "status on" : "status";
    totalEl.textContent = usdSum == null ? "—" : `${money.format(usdSum)} USD`;
    balanceEl.textContent = balanceUsd == null
      ? ""
      : (merged.source === "none"
        ? "вільні гроші не зчитані"
        : `${money.format(balanceUsd)} USD`);
    const rateDate = fx.table.date ? ` · ЄЦБ ${fx.table.date}` : "";
    metaEl.textContent = `${nativeMix(fx.positions)} · сума в USD${source ? ` · ${source}` : ""}${when ? ` · ${when}` : ""}${rateDate}`;
  } catch {
    statusEl.textContent = "Є ПОЗИЦІЇ";
    statusEl.className = "status on";
    totalEl.textContent = "—";
    balanceEl.textContent = "";
    metaEl.textContent = `Курс євро не завантажився.${source ? ` ${source}.` : ""}${when ? ` ${when}` : ""}`;
  }
}

async function load() {
  const stored = await chrome.storage.local.get(["snapshot", "gatewayUrl"]);
  gatewayEl.value = stored.gatewayUrl || "https://localhost:5000";
  render(stored.snapshot);
}

function setBusy(button, busy) {
  button.disabled = busy;
  pullBtn.disabled = busy;
  gatewayBtn.disabled = busy;
}

pullBtn.addEventListener("click", async () => {
  messageEl.textContent = "Читаю відкриту вкладку…";
  setBusy(pullBtn, true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "PULL_PORTAL" });
    if (!response?.ok) {
      messageEl.textContent = response?.error || "Не вдалося зчитати портфель.";
      return;
    }
    render(response.snapshot);
    messageEl.textContent = "Позиції збережено в цьому браузері.";
  } finally {
    setBusy(pullBtn, false);
  }
});

gatewayBtn.addEventListener("click", async () => {
  const url = gatewayEl.value.trim();
  await chrome.storage.local.set({ gatewayUrl: url });
  messageEl.textContent = "Звертаюсь до gateway…";
  setBusy(gatewayBtn, true);
  try {
    const response = await chrome.runtime.sendMessage({ type: "PULL_GATEWAY", url });
    if (!response?.ok) {
      messageEl.textContent = response?.error || "Gateway не відповів.";
      return;
    }
    render(response.snapshot);
    messageEl.textContent = "Позиції з gateway збережено.";
  } finally {
    setBusy(gatewayBtn, false);
  }
});

document.querySelector("#open").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

gatewayEl.addEventListener("change", () => {
  chrome.storage.local.set({ gatewayUrl: gatewayEl.value.trim() });
});

load();
