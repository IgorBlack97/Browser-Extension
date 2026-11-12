import { SUGGESTED_PROXIES } from "./proxies.js";

const TTL_MS = 12 * 60 * 60 * 1000;
const API = "https://tickerinside.com/api/v1";

export function slimFund(data) {
  if (!data || data.error || data.notFund || (!data.name && !data.holdings && !data.composition)) {
    return {
      notFund: true,
      reason: data?.reason || "not_covered",
      message: data?.message || "",
      error: data?.error === true,
    };
  }
  const category = data.category && typeof data.category === "object"
    ? {
      id: data.category.id || null,
      label: data.category.label || null,
      group: data.category.group || null,
      asset_class: data.category.asset_class || null,
    }
    : null;
  return {
    name: data.name || data.ticker || "",
    ticker: String(data.ticker || "").toUpperCase(),
    holdings: data.holdings || {},
    holdings_kind: data.holdings_kind || null,
    stock_pct: data.stock_pct ?? null,
    composition: Array.isArray(data.composition) ? data.composition : [],
    category,
    holdings_as_of: data.holdings_as_of || data.report_date || null,
    expense_ratio: typeof data.expense_ratio === "number" ? data.expense_ratio : null,
    source_layer: data.source_layer || null,
  };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: true, message: text.slice(0, 180) };
  }
}

async function fetchOne(ticker) {
  try {
    const response = await fetch(`${API}/fund/${encodeURIComponent(ticker.toLowerCase())}.json`);
    const data = await readJson(response);
    if (!response.ok || data.error === "not_covered") {
      return {
        notFund: true,
        reason: data.reason || "not_covered",
        message: data.message || "",
        error: response.status >= 500,
      };
    }
    return slimFund(data);
  } catch (error) {
    return { notFund: true, error: true, reason: "network", message: error.message || "мережа" };
  }
}

async function mapPool(items, limit, fn) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
}

function remember(funds, cache, ticker, fund) {
  funds[ticker] = fund;
  if (!fund.error) cache[ticker] = { at: Date.now(), fund };
}

async function fetchInto(tickers, funds, cache, onProgress) {
  const missing = [];
  for (const ticker of tickers) {
    const cached = cache[ticker];
    if (cached && Date.now() - cached.at < TTL_MS && cached.fund) {
      funds[ticker] = cached.fund;
    } else {
      missing.push(ticker);
    }
  }
  for (let offset = 0; offset < missing.length; offset += 8) {
    const part = missing.slice(offset, offset + 8);
    const got = new Set();
    try {
      const response = await fetch(`${API}/batch?funds=${part.join(",")}`);
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
      for (const [rawKey, fund] of Object.entries(data.funds || {})) {
        const key = String(fund?.ticker || rawKey).toUpperCase();
        const slim = slimFund(fund);
        remember(funds, cache, key, slim);
        got.add(key);
        const asked = String(rawKey).toUpperCase();
        if (asked !== key) {
          funds[asked] = slim;
          got.add(asked);
        }
      }
      for (const row of data.not_covered || []) {
        const key = String(row.ticker || "").toUpperCase();
        if (!key) continue;
        remember(funds, cache, key, {
          notFund: true,
          reason: row.reason || "not_covered",
          message: row.message || "",
        });
        got.add(key);
      }
    } catch (error) {
      for (const ticker of part) {
        if (!funds[ticker]) {
          funds[ticker] = { notFund: true, error: true, reason: "network", message: error.message || "мережа" };
        }
      }
      if (onProgress) onProgress();
      continue;
    }
    const left = part.filter((ticker) => !got.has(ticker) && !funds[ticker]);
    await mapPool(left, 3, async (ticker) => {
      remember(funds, cache, ticker, await fetchOne(ticker));
    });
    if (onProgress) onProgress();
  }
}

export async function loadResolutions(tickers, { aliases = {}, cache = {}, onProgress } = {}) {
  const fresh = { ...cache };
  const unique = [...new Set(tickers.filter(Boolean).map((ticker) => String(ticker).toUpperCase()))];
  const plan = unique.map((ticker) => {
    const alias = aliases[ticker] ? cleanAlias(aliases[ticker]) : "";
    return { ticker, alias, dataTicker: alias || ticker };
  });
  const funds = {};
  const first = [...new Set(plan.map((item) => item.dataTicker))];
  await fetchInto(first, funds, fresh, onProgress);

  const second = [];
  for (const item of plan) {
    if (item.alias) continue;
    const got = funds[item.ticker];
    if (got && !got.notFund) continue;
    const suggestion = SUGGESTED_PROXIES[item.ticker];
    if (suggestion?.proxy && !funds[suggestion.proxy]) second.push(suggestion.proxy);
  }
  if (second.length) await fetchInto([...new Set(second)], funds, fresh, onProgress);

  const resolutions = {};
  for (const item of plan) {
    const primary = funds[item.dataTicker];
    if (item.alias && primary && !primary.notFund && !primary.error) {
      resolutions[item.ticker] = { fund: primary, proxy: item.alias, note: `ваш відповідник ${item.alias}` };
      continue;
    }
    if (primary && !primary.notFund && !primary.error) {
      resolutions[item.ticker] = { fund: primary, proxy: null, note: null };
      continue;
    }
    const suggestion = !item.alias ? SUGGESTED_PROXIES[item.ticker] : null;
    if (primary?.reason === "has_security_file" && !(suggestion && funds[suggestion.proxy] && !funds[suggestion.proxy].notFund)) {
      resolutions[item.ticker] = { stock: true };
      continue;
    }
    const proxied = suggestion ? funds[suggestion.proxy] : null;
    if (proxied && !proxied.notFund && !proxied.error) {
      resolutions[item.ticker] = { fund: proxied, proxy: suggestion.proxy, note: suggestion.note };
      continue;
    }
    if (primary?.error || proxied?.error) {
      resolutions[item.ticker] = { error: true, message: primary?.message || proxied?.message || "TickerInside недоступний" };
      continue;
    }
    resolutions[item.ticker] = { unknown: true };
  }
  return { resolutions, cache: fresh };
}

function cleanAlias(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
}
