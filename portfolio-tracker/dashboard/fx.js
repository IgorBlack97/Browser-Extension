import { accountCashLines, positionsFromSnapshot } from "./analyze.js";

const TTL_MS = 6 * 60 * 60 * 1000;
const SOURCES = [
  "https://api.frankfurter.dev/v1/latest?base=EUR",
  "https://api.frankfurter.app/latest?from=EUR",
];

const MINOR_UNITS = {
  GBX: ["GBP", 100],
  GBp: ["GBP", 100],
  ILA: ["ILS", 100],
  ZAC: ["ZAR", 100],
};

export function majorCurrency(code) {
  if (code == null) return null;
  const raw = String(code).trim();
  if (!raw) return null;
  const minor = MINOR_UNITS[raw] || MINOR_UNITS[raw.toUpperCase()];
  if (minor) return { code: minor[0], units: minor[1] };
  const upper = raw.toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) return null;
  return { code: upper, units: 1 };
}

export function toEur(amount, currency, rates) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return { eur: null, missing: true, currency: null, rate: null };
  const major = majorCurrency(currency);
  if (!major) return { eur: null, missing: true, currency: currency ? String(currency).toUpperCase() : null, rate: null };
  const inMajor = amount / major.units;
  if (major.code === "EUR") return { eur: inMajor, missing: false, currency: "EUR", rate: 1 };
  const perEur = rates?.[major.code];
  if (!perEur) return { eur: null, missing: true, currency: major.code, rate: null };
  return { eur: inMajor / perEur, missing: false, currency: major.code, rate: perEur };
}

export function baseCurrencyFromSnapshot(snapshot, accountId) {
  const found = new Set();
  const take = (id, code) => {
    if (accountId && accountId !== "all" && id && id !== accountId) return;
    const major = majorCurrency(code);
    if (major) found.add(major.code);
  };
  for (const account of snapshot?.accounts || []) {
    take(account.id || account.accountId, account.currency || account.baseCurrency);
  }
  for (const [id, summary] of Object.entries(snapshot?.summaryByAccount || {})) {
    if (!summary || typeof summary !== "object") continue;
    const net = summary.netliquidation ?? summary.netLiquidation;
    const code = (net && typeof net === "object" && (net.currency || net.currencyCode))
      || summary.currency
      || summary.baseCurrency;
    take(id, code);
  }
  return found.size === 1 ? [...found][0] : null;
}

export function applyEur(positions, table, baseCurrency) {
  const missing = [];
  const valued = (positions || []).map((position) => {
    let amount = position.nativeValue;
    let currency = position.nativeCurrency;
    let origin = "native";
    if (amount == null || !currency) {
      if (position.baseValue != null && baseCurrency) {
        amount = position.baseValue;
        currency = baseCurrency;
        origin = "base";
      }
    }
    const converted = toEur(amount, currency, table?.rates);
    if (converted.eur == null) {
      missing.push({ ticker: position.ticker, currency: converted.currency || currency || "?" });
      return { ...position, fxMissing: true, fxOrigin: origin };
    }
    const pnlAmount = origin === "base" ? position.pnlBase : position.pnlNative;
    const pnlCurrency = origin === "base" ? baseCurrency : currency;
    const pnl = pnlAmount == null ? null : toEur(pnlAmount, pnlCurrency, table.rates).eur;
    const dayCurrency = position.nativeCurrency || currency;
    const dayPnl = position.dayPnlNative == null ? null : toEur(position.dayPnlNative, dayCurrency, table.rates).eur;
    return {
      ...position,
      value: converted.eur,
      currency: "EUR",
      fxRate: converted.rate,
      fxOrigin: origin,
      fxSourceCurrency: converted.currency,
      fxMissing: false,
      pnl,
      dayPnl,
    };
  });
  return { positions: valued, missing };
}

async function fetchTable() {
  let lastError = null;
  for (const url of SOURCES) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data?.rates?.USD || !data.date) throw new Error("відповідь без курсу USD");
      return {
        at: Date.now(),
        date: data.date,
        rates: { EUR: 1, ...data.rates },
        source: "ECB",
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Курс ЄЦБ недоступний");
}

export async function loadEurRateTable(cached) {
  if (cached?.rates?.USD && Date.now() - cached.at < TTL_MS) {
    return { ...cached, stale: false };
  }
  try {
    const fresh = await fetchTable();
    return { ...fresh, stale: false };
  } catch (error) {
    if (cached?.rates?.USD) return { ...cached, stale: true };
    throw error;
  }
}

export function mergeAccountCash(positions, snapshot, accountId, table) {
  if ((positions || []).some((position) => position.assetClass === "CASH")) {
    return { positions, source: "positions" };
  }
  const lines = accountCashLines(snapshot, accountId);
  if (!lines.length) return { positions, source: "none" };
  const raw = lines.map((line) => ({
    accountId: line.accountId,
    ticker: line.currency,
    name: `Вільні ${line.currency}`,
    value: line.amount,
    nativeValue: line.amount,
    nativeCurrency: line.currency,
    currency: line.currency,
    assetClass: "CASH",
    baseValue: null,
    quantity: null,
    avgPrice: null,
    mktPrice: null,
    pnl: null,
    pnlNative: null,
    pnlBase: null,
    conid: null,
    sector: null,
    group: null,
  }));
  const applied = applyEur(raw, table, null);
  return { positions: [...positions, ...applied.positions], source: "account", missing: applied.missing };
}

export async function positionsInEur(snapshot, accountId, cachedTable) {
  const positions = positionsFromSnapshot(snapshot, accountId);
  const baseCurrency = baseCurrencyFromSnapshot(snapshot, accountId);
  const table = await loadEurRateTable(cachedTable);
  const applied = applyEur(positions, table, baseCurrency);
  return { ...applied, table, baseCurrency };
}
