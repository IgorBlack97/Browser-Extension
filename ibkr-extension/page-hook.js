(() => {
  if (window.__ibkrXrayInstalled) return;
  window.__ibkrXrayInstalled = true;

  const state = {
    accounts: [],
    positions: new Map(),
    summary: {},
    ledger: {},
    allocation: {},
    base: "",
    auth: "",
  };
  let postTimer = 0;
  const quotes = new Map();
  const cashTries = new Map();

  function isLedger(data) {
    return Object.entries(data).some(([key, row]) => (
      /^[A-Z]{3}$/i.test(key)
      && row
      && typeof row === "object"
      && (row.cashbalance != null || row.cashBalance != null || row.settledcash != null)
    ));
  }

  function quoteNumber(value) {
    if (value == null || value === "") return null;
    const parsed = Number(String(value).replace("%", "").replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function rememberQuotes(snaps) {
    for (const snap of Array.isArray(snaps) ? snaps : []) {
      if (!snap || typeof snap !== "object") continue;
      const id = snap.conid ?? snap.conId ?? snap["6008"];
      if (id == null) continue;
      const quote = {
        changePercent: quoteNumber(snap.changePercent ?? snap.changePct ?? snap["83"]),
        dailyPnl: quoteNumber(snap.dailyPnl ?? snap.dayPnl ?? snap["78"]),
        priceChange: quoteNumber(snap.priceChange ?? snap["82"]),
      };
      if (quote.changePercent == null && quote.dailyPnl == null && quote.priceChange == null) continue;
      quotes.set(String(id), quote);
    }
  }

  function withQuote(row) {
    const quote = row?.conid == null ? null : quotes.get(String(row.conid));
    if (!quote) return row;
    return {
      ...row,
      changePercent: row.changePercent ?? quote.changePercent,
      dailyPnl: row.dailyPnl ?? quote.dailyPnl,
      priceChange: row.priceChange ?? quote.priceChange,
    };
  }

  function watchUrl(url) {
    const text = String(url || "");
    return interesting(text) || /marketdata\/snapshot/i.test(text);
  }

  function interesting(url) {
    const text = String(url || "");
    if (!/portfolio/i.test(text)) return false;
    return /positions|accounts|allocation|summary|ledger/i.test(text);
  }

  function baseFrom(url) {
    const text = String(url || "");
    const index = text.search(/\/portfolio2?\//i);
    if (index <= 0) return "";
    return text.slice(0, index);
  }

  function accountFrom(url) {
    const match = String(url || "").match(/\/portfolio2?\/([^/?]+)\/(?:combo\/)?(?:positions|summary|allocation|ledger)/i);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function looksLikeAccounts(list) {
    const row = list[0];
    if (!row || typeof row !== "object") return false;
    const id = row.id || row.accountId;
    return Boolean(id) && row.mktValue == null && row.marketValue == null && row.position == null;
  }

  function looksLikePositions(list) {
    if (!list.length) return true;
    const row = list[0];
    if (!row || typeof row !== "object") return false;
    return row.conid != null || row.contractDesc || row.mktValue != null || row.marketValue != null
      || (row.position != null && (row.secType || row.assetClass || row.description));
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

  function rememberAuth(input, init) {
    try {
      const headers = new Headers(
        (init && init.headers) || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
      );
      const auth = headers.get("authorization");
      if (auth) state.auth = auth;
    } catch {
      /* The portal request still proceeds with its own headers. */
    }
  }

  function addPositions(list, fallbackAccount, replaceAccount) {
    const seed = fallbackAccount || (list[0] && (list[0].acctId || list[0].accountId)) || "default";
    if (replaceAccount) {
      for (const key of [...state.positions.keys()]) {
        if (key.startsWith(`${seed}|`) || key.startsWith(`${replaceAccount}|`)) state.positions.delete(key);
      }
    }
    for (const row of list) {
      if (!row || typeof row !== "object") continue;
      const account = row.acctId || row.accountId || seed;
      const id = row.conid != null
        ? String(row.conid)
        : `${row.contractDesc || row.ticker || row.description || ""}:${row.position ?? ""}`;
      state.positions.set(`${account}|${id}`, row);
    }
  }

  function absorb(url, data) {
    const base = baseFrom(url);
    if (base) state.base = base;
    const account = accountFrom(url);

    if (/marketdata\/snapshot/i.test(url) && Array.isArray(data)) {
      rememberQuotes(data);
      if (state.positions.size) schedulePost();
      return;
    }
    if (/\/accounts(?:\?|$)/i.test(url) && Array.isArray(data) && looksLikeAccounts(data)) {
      state.accounts = data;
      schedulePost();
      return;
    }
    if (/allocation/i.test(url) && data && typeof data === "object" && !Array.isArray(data)) {
      state.allocation[account || "default"] = data;
      schedulePost();
      return;
    }
    if (data && typeof data === "object" && !Array.isArray(data) && (/ledger/i.test(url) || isLedger(data))) {
      state.ledger[account || "default"] = data;
      schedulePost();
      return;
    }
    if (/summary/i.test(url) && data && typeof data === "object" && !Array.isArray(data)) {
      state.summary[account || "default"] = data;
      schedulePost();
      return;
    }

    const list = positionList(data);
    if (!list || !looksLikePositions(list)) return;
    addPositions(list, account, /portfolio2\//i.test(url) ? (account || "default") : "");
    if (list.length) schedulePost();
  }

  function buildSnapshot() {
    const positionsByAccount = {};
    for (const [key, row] of state.positions) {
      const account = row.acctId || row.accountId || key.split("|")[0] || "default";
      (positionsByAccount[account] ||= []).push(withQuote(row));
    }
    return {
      source: "portal",
      origin: location.origin,
      accounts: state.accounts,
      positionsByAccount,
      summaryByAccount: state.summary,
      ledgerByAccount: state.ledger,
      allocationByAccount: state.allocation,
    };
  }

  function post(snapshot, requestId) {
    window.postMessage({
      source: "ibkr-xray",
      requestId: requestId || null,
      snapshot,
    }, location.origin);
  }

  function knownAccountIds() {
    const ids = new Set();
    for (const row of state.positions.values()) {
      const id = row.acctId || row.accountId;
      if (id) ids.add(id);
    }
    for (const account of state.accounts) {
      const id = account.id || account.accountId;
      if (id) ids.add(id);
    }
    return [...ids];
  }

  async function ensureCash(accountId) {
    if (!accountId || state.ledger[accountId] || state.summary[accountId]) return;
    if ((cashTries.get(accountId) || 0) >= 3) return;
    cashTries.set(accountId, (cashTries.get(accountId) || 0) + 1);
    const origin = location.origin;
    const bases = [];
    for (const base of [
      state.base,
      `${origin}/portal.proxy/v1/api`,
      `${origin}/portal.proxy/v1/portal`,
      `${origin}/v1/api`,
      `${origin}/v1/portal`,
    ]) {
      if (base && !bases.includes(base)) bases.push(base);
    }
    const headers = { accept: "application/json" };
    if (state.auth) headers.authorization = state.auth;
    const encoded = encodeURIComponent(accountId);
    for (const base of bases) {
      try {
        const ledger = await getJson(`${base}/portfolio/${encoded}/ledger`, headers);
        if (ledger && typeof ledger === "object") {
          state.ledger[accountId] = ledger;
          schedulePost();
          return;
        }
      } catch {
        /* Try the next gateway path. */
      }
      try {
        const summary = await getJson(`${base}/portfolio/${encoded}/summary`, headers);
        if (summary && typeof summary === "object") {
          state.summary[accountId] = summary;
          schedulePost();
          return;
        }
      } catch {
        /* Try the next gateway path. */
      }
    }
  }

  function schedulePost() {
    clearTimeout(postTimer);
    postTimer = setTimeout(() => {
      if (!state.positions.size) return;
      for (const id of knownAccountIds()) ensureCash(id);
      post(buildSnapshot(), null);
    }, 700);
  }

  async function attachLiveQuotes(base, headers, list) {
    const conids = [...new Set(list.map((row) => row?.conid).filter((id) => id != null))];
    if (!conids.length) return list.map(withQuote);
    const url = `${base}/iserver/marketdata/snapshot?conids=${conids.join(",")}&fields=31,78,82,83`;
    try {
      let snaps = await getJson(url, headers);
      const empty = !Array.isArray(snaps) || snaps.every((snap) => snap["78"] == null && snap["82"] == null && snap["83"] == null);
      if (empty) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        snaps = await getJson(url, headers);
      }
      rememberQuotes(snaps);
    } catch {
      /* The day's move is optional. Positions still render without it. */
    }
    return list.map(withQuote);
  }

  async function getJson(url, headers) {
    const response = await origFetch(url, { credentials: "include", headers });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.json();
  }

  async function pull(requestId) {
    const origin = location.origin;
    const bases = [];
    for (const base of [
      state.base,
      `${origin}/portal.proxy/v1/api`,
      `${origin}/portal.proxy/v1/portal`,
      `${origin}/v1/api`,
      `${origin}/v1/portal`,
    ]) {
      if (base && !bases.includes(base)) bases.push(base);
    }

    const headers = { accept: "application/json" };
    if (state.auth) headers.authorization = state.auth;
    let lastError = "Портал не віддав рахунки. Відкрийте сторінку Portfolio — позиції підхопляться з відповіді сайту.";

    for (const base of bases) {
      try {
        const accounts = await getJson(`${base}/portfolio/accounts`, headers);
        if (!Array.isArray(accounts) || !accounts.length || !looksLikeAccounts(accounts)) continue;
        state.accounts = accounts;
        state.base = base;
        for (const account of accounts) {
          const id = account.id || account.accountId;
          if (!id) continue;
          const encoded = encodeURIComponent(id);
          let list = null;
          try {
            list = positionList(await getJson(`${base}/portfolio2/${encoded}/positions`, headers));
          } catch {
            list = null;
          }
          if (!list?.length) {
            try {
              const combo = positionList(await getJson(`${base}/portfolio/${encoded}/combo/positions?nocache=true`, headers));
              if (combo?.length) list = combo;
            } catch {
              /* The website portfolio view uses this path; the gateway often does not. */
            }
          }
          if (!list?.length) {
            list = [];
            for (let page = 0; page < 30; page += 1) {
              const chunk = positionList(await getJson(`${base}/portfolio/${encoded}/positions/${page}`, headers)) || [];
              if (!chunk.length) break;
              list.push(...chunk);
              if (chunk.length < 20) break;
            }
          }
          for (const key of [...state.positions.keys()]) {
            if (key.startsWith(`${id}|`)) state.positions.delete(key);
          }
          addPositions(await attachLiveQuotes(base, headers, list), id, "");
          try {
            state.summary[id] = await getJson(`${base}/portfolio/${encoded}/summary`, headers);
          } catch {
            /* Summary is optional. */
          }
          try {
            state.ledger[id] = await getJson(`${base}/portfolio/${encoded}/ledger`, headers);
          } catch {
            /* Ledger is optional. Cash can also arrive inside the summary. */
          }
          try {
            state.allocation[id] = await getJson(`${base}/portfolio/${encoded}/allocation`, headers);
          } catch {
            /* Allocation is optional. */
          }
        }
        post(buildSnapshot(), requestId);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = /failed to fetch|networkerror|load failed/i.test(message)
          ? "Ця сторінка не віддає портфель. Відкрийте Portfolio в Client Portal і повторіть."
          : message;
      }
    }

    if (state.positions.size) {
      post(buildSnapshot(), requestId);
      return;
    }
    post({
      source: "portal",
      origin: location.origin,
      error: lastError,
      accounts: state.accounts,
      positionsByAccount: {},
      summaryByAccount: state.summary,
      ledgerByAccount: state.ledger,
      allocationByAccount: state.allocation,
    }, requestId);
  }

  const origFetch = window.fetch.bind(window);

  function installNetHooks() {
    if (window.__ibkrXrayNet) return;
    window.__ibkrXrayNet = true;

    window.fetch = function ibkrXrayFetch(input, init) {
      let url = "";
      try {
        rememberAuth(input, init);
        url = typeof input === "string" ? input : (input && input.url) || "";
      } catch {
        /* Reading the request must not block it. */
      }
      let promise;
      try {
        promise = origFetch(input, init);
      } catch (error) {
        return Promise.reject(error);
      }
      if (!watchUrl(url) || !promise || typeof promise.then !== "function") return promise;
      promise.then((response) => {
        try {
          response.clone().json().then((data) => {
            try { absorb(url, data); } catch { /* ignore */ }
          }).catch(() => {});
        } catch {
          /* Cloning a non-JSON body must not affect the portal. */
        }
      }, () => {
        /* A failed portfolio request stays the page's concern and is not an extension error. */
      });
      return promise;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function ibkrXrayOpen(method, url) {
      try { this.__ibkrXrayUrl = url; } catch { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function ibkrXraySend() {
      try {
        this.addEventListener("load", () => {
          try {
            const url = String(this.__ibkrXrayUrl || "");
            if (!watchUrl(url)) return;
            const text = this.responseText;
            if (!text || (text[0] !== "{" && text[0] !== "[")) return;
            absorb(url, JSON.parse(text));
          } catch {
            /* A non-JSON portfolio response is ignored. */
          }
        });
      } catch {
        /* Observing XHR must not stop the request. */
      }
      return origSend.apply(this, arguments);
    };
  }

  function pageMightHoldPortfolio() {
    const host = location.hostname;
    if (host === "localhost" || host.endsWith(".ibkr.com")) return true;
    if (/^(gd|nd|md)cdyn\./i.test(host)) return true;
    return /portal|sso|login|AccountManagement|\/am\b|clientportal|cpweb/i.test(
      `${location.pathname}${location.search}${location.hash}`,
    );
  }

  function arm() {
    if (pageMightHoldPortfolio()) installNetHooks();
  }

  arm();
  window.addEventListener("hashchange", arm);
  window.addEventListener("popstate", arm);
  try {
    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = function ibkrXrayPush() {
      const result = origPush.apply(this, arguments);
      arm();
      return result;
    };
    history.replaceState = function ibkrXrayReplace() {
      const result = origReplace.apply(this, arguments);
      arm();
      return result;
    };
  } catch {
    /* History can stay untouched if the page sealed it. */
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== "ibkr-xray-cmd" || data.cmd !== "pull") return;
    pull(data.requestId);
  });
})();
