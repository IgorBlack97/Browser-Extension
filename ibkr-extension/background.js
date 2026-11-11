function countPositions(snapshot) {
  const byAccount = snapshot?.positionsByAccount || {};
  return Object.values(byAccount).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

function isPositionRow(row) {
  return Boolean(row) && typeof row === "object" && (
    row.conid != null || row.contractDesc || row.ticker || row.mktValue != null || row.marketValue != null
    || (row.position != null && (row.secType || row.assetClass || row.description))
  );
}

function positionList(data) {
  if (Array.isArray(data)) {
    const nested = data.flatMap((row) => (Array.isArray(row?.positions) ? row.positions : []));
    if (nested.some(isPositionRow)) return nested.filter(isPositionRow);
    return data;
  }
  if (!data || typeof data !== "object") return null;
  if (Array.isArray(data.positions)) return positionList(data.positions);
  if (Array.isArray(data.portfolio)) return data.portfolio;
  const values = Object.values(data).filter(isPositionRow);
  return values.length ? values : null;
}

function filled(value) {
  return Boolean(value) && typeof value === "object" && Object.keys(value).length > 0;
}

async function saveSnapshot(snapshot) {
  const previous = await chrome.storage.local.get("snapshot");
  const old = previous.snapshot || {};
  const stored = {
    ...snapshot,
    ledgerByAccount: filled(snapshot.ledgerByAccount) ? snapshot.ledgerByAccount : (old.ledgerByAccount || {}),
    summaryByAccount: filled(snapshot.summaryByAccount) ? snapshot.summaryByAccount : (old.summaryByAccount || {}),
    allocationByAccount: filled(snapshot.allocationByAccount) ? snapshot.allocationByAccount : (old.allocationByAccount || {}),
    syncedAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ snapshot: stored });
  const count = countPositions(stored);
  await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 999)) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#3B82F6" });
  return stored;
}

const PORTAL_URLS = [
  "https://*.interactivebrokers.com/*",
  "https://interactivebrokers.com/*",
  "https://*.interactivebrokers.co.uk/*",
  "https://*.interactivebrokers.eu/*",
  "https://*.interactivebrokers.com.hk/*",
  "https://*.interactivebrokers.com.au/*",
  "https://*.interactivebrokers.ca/*",
  "https://*.interactivebrokers.com.sg/*",
  "https://*.ibkr.com/*",
  "https://localhost:5000/*",
  "http://localhost:5000/*",
];

async function pullPortal() {
  const tabs = await chrome.tabs.query({ url: PORTAL_URLS });
  const tab = tabs.find((item) => item.active) || tabs[0];
  if (!tab?.id) {
    return {
      ok: false,
      error: "Немає відкритої вкладки Client Portal. Увійдіть на портал IBKR і відкрийте Portfolio.",
    };
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "PULL" });
    if (response?.ok && response.snapshot && !response.snapshot.error && countPositions(response.snapshot) > 0) {
      const snapshot = await saveSnapshot({ ...response.snapshot, source: response.snapshot.source || "portal" });
      return { ok: true, snapshot };
    }
    if (response?.snapshot?.error) return { ok: false, error: response.snapshot.error };
    return {
      ok: false,
      error: response?.error || "Позицій не знайдено. Відкрийте сторінку Portfolio і зачекайте, поки вона довантажиться.",
    };
  } catch {
    return {
      ok: false,
      error: "Вкладка IBKR не відповідає. Оновіть сторінку порталу після встановлення розширення.",
    };
  }
}

async function pullGateway(gatewayUrl) {
  let base = String(gatewayUrl || "").trim().replace(/\/$/, "");
  if (!base) return { ok: false, error: "Вкажіть адресу Client Portal Gateway." };
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  if (!/\/v1\/(?:api|portal)$/i.test(base)) base += "/v1/api";

  try {
    const accountsResponse = await fetch(`${base}/portfolio/accounts`, { credentials: "include" });
    if (!accountsResponse.ok) {
      return {
        ok: false,
        error: `Gateway відповів ${accountsResponse.status}. Відкрийте його у вкладці, підтвердіть сертифікат, увійдіть і натисніть «Зчитати з вкладки».`,
      };
    }
    const accounts = await accountsResponse.json();
    if (!Array.isArray(accounts) || !accounts.length) {
      return { ok: false, error: "Gateway не повернув рахунків. Спершу увійдіть у нього." };
    }
    const positionsByAccount = {};
    const summaryByAccount = {};
    const ledgerByAccount = {};
    for (const account of accounts) {
      const id = account.id || account.accountId;
      if (!id) continue;
      const encoded = encodeURIComponent(id);
      let list = null;
      try {
        const fresh = await fetch(`${base}/portfolio2/${encoded}/positions`, { credentials: "include" });
        if (fresh.ok) list = positionList(await fresh.json());
      } catch {
        list = null;
      }
      if (!list?.length) {
        try {
          const combo = await fetch(`${base}/portfolio/${encoded}/combo/positions?nocache=true`, { credentials: "include" });
          if (combo.ok) {
            const parsed = positionList(await combo.json());
            if (parsed?.length) list = parsed;
          }
        } catch {
          /* Optional website-shaped endpoint. */
        }
      }
      if (!list?.length) {
        list = [];
        for (let page = 0; page < 30; page += 1) {
          const pageResponse = await fetch(`${base}/portfolio/${encoded}/positions/${page}`, { credentials: "include" });
          if (!pageResponse.ok) break;
          const chunk = positionList(await pageResponse.json()) || [];
          if (!chunk.length) break;
          list.push(...chunk);
          if (chunk.length < 20) break;
        }
      }
      positionsByAccount[id] = list;
      try {
        const summaryResponse = await fetch(`${base}/portfolio/${encoded}/summary`, { credentials: "include" });
        if (summaryResponse.ok) summaryByAccount[id] = await summaryResponse.json();
      } catch {
        /* Summary is optional. */
      }
      try {
        const ledgerResponse = await fetch(`${base}/portfolio/${encoded}/ledger`, { credentials: "include" });
        if (ledgerResponse.ok) ledgerByAccount[id] = await ledgerResponse.json();
      } catch {
        /* Ledger is optional. */
      }
    }
    const snapshot = await saveSnapshot({
      source: "gateway",
      origin: base,
      accounts,
      positionsByAccount,
      summaryByAccount,
      ledgerByAccount,
      allocationByAccount: {},
    });
    if (!countPositions(snapshot)) return { ok: false, error: "Gateway відповів, але позицій у рахунках немає." };
    return { ok: true, snapshot };
  } catch {
    return {
      ok: false,
      error: "Не вдалося відкрити gateway. Для самопідписаного сертифіката відкрийте https://localhost:5000 у вкладці й зчитайте портфель звідти.",
    };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;
  if (message.type === "SNAPSHOT" && message.snapshot && countPositions(message.snapshot) > 0) {
    saveSnapshot(message.snapshot).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "PULL_PORTAL") {
    pullPortal().then(sendResponse);
    return true;
  }
  if (message.type === "PULL_GATEWAY") {
    pullGateway(message.url).then(sendResponse);
    return true;
  }
  if (message.type === "SAVE_SNAPSHOT" && message.snapshot) {
    saveSnapshot(message.snapshot).then((snapshot) => sendResponse({ ok: true, snapshot }));
    return true;
  }
});
