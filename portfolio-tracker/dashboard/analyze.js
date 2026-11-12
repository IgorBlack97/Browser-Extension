import { ASSET_CLASS_HINTS, SUGGESTED_PROXIES } from "./proxies.js";

export const BUCKETS = [
  { id: "stocks", label: "Акції", color: "#3B82F6" },
  { id: "bonds", label: "Облігації", color: "#A78BFA" },
  { id: "gold", label: "Золото", color: "#FCD535" },
  { id: "commodity", label: "Сировина", color: "#F59E0B" },
  { id: "crypto", label: "Крипто", color: "#F97316" },
  { id: "cash", label: "Готівка", color: "#0ECB81" },
  { id: "derivatives", label: "Похідні", color: "#F6465D" },
  { id: "other", label: "Інше", color: "#848E9C" },
];

const BUCKET_LABEL = Object.fromEntries(BUCKETS.map((b) => [b.id, b.label]));

const CASH_CODES = new Set([
  "USD", "EUR", "GBP", "CHF", "CAD", "JPY", "AUD", "HKD", "SGD", "PLN", "UAH",
  "SEK", "NOK", "DKK", "CZK", "HUF", "CNH", "CNY", "NZD", "MXN", "ZAR", "TRY", "ILS",
]);

const DERIVATIVE_CLASSES = new Set(["OPT", "FUT", "WAR", "CFD", "IOPT", "FOP", "DERIV"]);

const IBKR_CLASS = {
  STK: "Акції",
  BOND: "Облігації",
  CASH: "Готівка",
  OPT: "Опціони",
  FUT: "Ф'ючерси",
  FUND: "Фонди",
  BILL: "Векселі",
  WAR: "Варранти",
  CFD: "CFD",
};

export function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  let text = String(value).trim().replace(/\s/g, "");
  if (!text) return null;
  const hasComma = text.includes(",");
  const hasDot = text.includes(".");
  if (hasComma && hasDot) {
    if (text.lastIndexOf(",") > text.lastIndexOf(".")) {
      text = text.replace(/\./g, "").replace(",", ".");
    } else {
      text = text.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = text.split(",");
    if (parts.length === 2 && parts[1].length <= 2) text = `${parts[0]}.${parts[1]}`;
    else text = text.replace(/,/g, "");
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function cleanTicker(raw) {
  if (raw == null) return "";
  let text = String(raw).trim().toUpperCase().replace(/\s+/g, " ");
  if (!text) return "";
  if (text === "BRK B" || text === "BRK/B") return "BRK.B";
  text = text.split(" ")[0].replace(/[^A-Z0-9.]/g, "");
  text = text.replace(/\.(LSEETF|LSE|IBIS|AEB|SBF|SWB|MIL|NASDAQ|NYSE|ARCA)$/i, "");
  return text;
}

function firstNum(...values) {
  for (const value of values) {
    const parsed = num(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function readDayPnl(raw) {
  return firstNum(raw.dailyPnl, raw.dayPnl, raw.dailyPNL, raw.dpl, raw["78"], raw.dayPnlNative);
}

function readDayChangePct(raw) {
  const explicit = firstNum(
    ...[
      raw.changePercent, raw.changePct, raw.percentChange, raw.pctChange,
      raw.dayChangePercent, raw.dailyChangePercent, raw.dayChangePct, raw["83"],
    ].map((value) => (typeof value === "string" ? value.replace("%", "") : value)),
  );
  if (explicit != null) return explicit;
  const delta = firstNum(raw.priceChange, raw["82"]);
  const price = firstNum(raw.mktPrice, raw.marketPrice, raw.lastPrice, raw["31"]);
  if (delta != null && price != null && price !== delta) {
    const previous = price - delta;
    if (previous) return (delta / previous) * 100;
  }
  const daily = readDayPnl(raw);
  const value = firstNum(raw.mktValue, raw.marketValue, raw.marketValueLocal, raw.nativeValue, raw.value);
  if (daily != null && value != null && value !== daily) return (daily / (value - daily)) * 100;
  return null;
}

function nonzero(...values) {
  for (const value of values) {
    const parsed = num(value);
    if (parsed != null && parsed !== 0) return parsed;
  }
  return null;
}

function isDerivative(raw, assetClass) {
  if (DERIVATIVE_CLASSES.has(assetClass)) return true;
  const desc = String(raw.contractDesc || raw.description || "").toUpperCase();
  return /\s/.test(desc) && /\b\d{2}[A-Z]{3}\d{2}\b/.test(desc);
}

export function normalizeRaw(raw, accountId) {
  if (!raw || typeof raw !== "object") return null;
  const assetClass = String(raw.assetClass || raw.secType || raw.asset_class || "").toUpperCase();
  const derivative = isDerivative(raw, assetClass);
  const cashClass = assetClass === "CASH";
  const desc = raw.contractDesc || raw.ticker || raw.symbol || raw.localSymbol || raw.description || "";
  let ticker = cleanTicker(cashClass ? (raw.currency || desc || "CASH") : desc);
  if (!ticker) return null;
  const nativeCurrency = String(
    raw.nativeCurrency || raw.currency || raw.listingCurrency || raw.tradeCurrency || (cashClass ? ticker : ""),
  ).trim().toUpperCase() || null;
  const nativeValue = nonzero(raw.mktValue, raw.marketValue, raw.marketValueLocal, raw.nativeValue, raw.value);
  const baseValue = nonzero(raw.baseMktValue, raw.marketValueInBase);
  const value = nativeValue ?? baseValue;
  if (value == null || value === 0) return null;
  let kind = assetClass || "STK";
  if (cashClass) kind = "CASH";
  else if (derivative) kind = assetClass || "DERIV";
  return {
    accountId: raw.acctId || raw.accountId || accountId || "default",
    ticker,
    name: raw.fullName || raw.name || raw.contractDesc || raw.description || ticker,
    value,
    currency: nativeCurrency,
    nativeValue,
    nativeCurrency,
    baseValue,
    localCurrency: nativeCurrency,
    assetClass: kind,
    quantity: num(raw.position ?? raw.quantity),
    avgPrice: num(raw.avgPrice ?? raw.avgCost),
    mktPrice: num(raw.mktPrice ?? raw.marketPrice),
    pnl: null,
    pnlNative: num(raw.unrealizedPnl ?? raw.pnlNative),
    pnlBase: num(raw.baseUnrealizedPnl ?? raw.pnlBase),
    dayChangePct: readDayChangePct(raw),
    dayPnlNative: readDayPnl(raw),
    conid: raw.conid ?? null,
    sector: raw.sector || null,
    group: raw.group || null,
  };
}

export function positionsFromSnapshot(snapshot, accountFilter) {
  const byAccount = snapshot?.positionsByAccount || {};
  const ids = !accountFilter || accountFilter === "all" ? Object.keys(byAccount) : [accountFilter];
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    for (const raw of byAccount[id] || []) {
      const position = normalizeRaw(raw, id);
      if (!position) continue;
      const key = `${position.accountId}|${position.conid ?? ""}|${position.ticker}|${position.assetClass}|${position.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(position);
    }
  }
  return out;
}

export function parseManual(text) {
  const positions = [];
  for (const line of String(text || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/[,;\t]| +/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 2) continue;
    const ticker = cleanTicker(parts[0]);
    const value = num(parts[1]);
    if (!ticker || value == null || value === 0) continue;
    const hint = (parts[2] || "").toLowerCase();
    const hintedCurrency = /^[a-z]{3}$/i.test(parts[2] || "") ? parts[2].toUpperCase() : null;
    const cashWord = hint === "cash" || hint === "готівка";
    const cash = cashWord || CASH_CODES.has(ticker);
    const nameStart = cashWord || hintedCurrency ? 3 : 2;
    const name = parts.slice(nameStart).join(" ");
    positions.push({
      accountId: "manual",
      ticker,
      name: name || ticker,
      value,
      currency: hintedCurrency || (cash ? ticker : null),
      assetClass: cash ? "CASH" : "STK",
      quantity: null,
      avgPrice: null,
      mktPrice: null,
      pnl: null,
      conid: null,
      sector: null,
      group: null,
    });
  }
  return positions;
}

function readCashPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const ledger = [];
  for (const [key, row] of Object.entries(payload)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    if (key.toUpperCase() === "BASE") continue;
    const code = String(row.currency || key || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) continue;
    const amount = num(row.cashbalance ?? row.cashBalance ?? row.settledcash ?? row.settledCash);
    if (amount == null || amount === 0) continue;
    if (!("cashbalance" in row) && !("cashBalance" in row) && !("settledcash" in row) && !("settledCash" in row)) continue;
    ledger.push({ currency: code, amount });
  }
  if (ledger.length) return ledger;

  if (Array.isArray(payload.cashBalances || payload.cashbalances)) {
    const rows = [];
    for (const row of payload.cashBalances || payload.cashbalances) {
      const currency = String(row?.currency || "").trim().toUpperCase();
      const amount = num(row?.balance ?? row?.cashBalance ?? row?.amount ?? row?.cashbalance);
      if (amount != null && amount !== 0 && /^[A-Z]{3}$/.test(currency)) rows.push({ currency, amount });
    }
    if (rows.length) return rows;
  }

  const cashKeys = Object.keys(payload).filter((key) => /^totalcashvalue(-[a-z])?$/i.test(key));
  const plain = cashKeys.find((key) => key.toLowerCase() === "totalcashvalue");
  const chosen = plain ? [plain] : cashKeys;
  const totals = [];
  for (const key of chosen) {
    const row = payload[key];
    if (row && typeof row === "object") {
      const amount = num(row.amount ?? row.value);
      const currency = String(row.currency || payload.currency || "").trim().toUpperCase();
      if (amount != null && amount !== 0 && /^[A-Z]{3}$/.test(currency)) totals.push({ currency, amount });
    } else {
      const amount = num(row);
      const currency = String(payload.currency || payload.baseCurrency || "").trim().toUpperCase();
      if (amount != null && amount !== 0 && /^[A-Z]{3}$/.test(currency)) totals.push({ currency, amount });
    }
  }
  return totals;
}

function linesForAccounts(snapshot, accountId) {
  const ledger = snapshot?.ledgerByAccount || {};
  const summary = snapshot?.summaryByAccount || {};
  const ids = !accountId || accountId === "all"
    ? [...new Set([...Object.keys(ledger), ...Object.keys(summary)])]
    : [accountId];
  const lines = [];
  for (const id of ids) {
    const found = readCashPayload(ledger[id]);
    const rows = found.length ? found : readCashPayload(summary[id]);
    for (const row of rows) lines.push({ ...row, accountId: id });
  }
  return lines;
}

export function accountCashLines(snapshot, accountId) {
  const lines = linesForAccounts(snapshot, accountId);
  if (lines.length || !accountId || accountId === "all") return lines;
  const every = linesForAccounts(snapshot, "all");
  const ids = new Set(every.map((line) => line.accountId));
  return ids.size <= 1 ? every : lines;
}

export function readSummary(summary) {
  if (!summary || typeof summary !== "object") return { total: null, currency: null };
  const net = summary.netliquidation ?? summary.netLiquidation;
  if (net && typeof net === "object") {
    return { total: num(net.amount ?? net.value), currency: net.currency || summary.currency || null };
  }
  if (typeof net === "number" || typeof net === "string") {
    return { total: num(net), currency: summary.currency || summary.baseCurrency || null };
  }
  return { total: null, currency: summary.currency || summary.baseCurrency || null };
}

export function readIbkrAllocation(allocation) {
  const asset = allocation?.assetClass || allocation?.assetclass;
  if (!asset || typeof asset !== "object") return [];
  const longBook = asset.long || {};
  const shortBook = asset.short || {};
  const keys = new Set([...Object.keys(longBook), ...Object.keys(shortBook)]);
  const rows = [];
  for (const key of keys) {
    const value = (num(longBook[key]) || 0) - (num(shortBook[key]) || 0);
    if (!value) continue;
    rows.push({ key, label: IBKR_CLASS[key] || key, value });
  }
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return rows
    .map((row) => ({ ...row, pct: total ? (row.value / total) * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

function bucketForCategory(fund) {
  const asset = fund?.category?.asset_class;
  const id = String(fund?.category?.id || "");
  const label = String(fund?.category?.label || "").toLowerCase();
  if (asset === "equity") return "stocks";
  if (asset === "bond") return "bonds";
  if (asset === "crypto") return "crypto";
  if (asset === "commodity") {
    if (id.includes("gold") || label.includes("gold")) return "gold";
    return "commodity";
  }
  return null;
}

function bucketForComposition(item, fund) {
  const kind = String(item.kind || "").toLowerCase();
  const label = String(item.label || "").toLowerCase();
  if (kind.includes("crypto") || label.includes("bitcoin") || label.includes("ethereum")) return "crypto";
  if (kind.includes("metal") || kind === "commodity" || kind === "physical_metal") {
    if (label.includes("gold")) return "gold";
    return "commodity";
  }
  if (kind.includes("money_market") || kind === "cash" || kind.includes("repurchase") || kind.includes("treasury_bill")) {
    return "cash";
  }
  if (
    kind.includes("bond") || kind.includes("treasury") || kind.includes("mortgage") ||
    kind.includes("debt") || kind.includes("municipal") || kind.includes("agency") || kind.includes("note")
  ) {
    return "bonds";
  }
  if (kind.includes("stock") || kind.includes("equity") || kind.includes("preferred")) return "stocks";
  return bucketForCategory(fund) || "other";
}

function allocateFund(value, fund) {
  const composition = Array.isArray(fund.composition)
    ? fund.composition.filter((item) => typeof item.pct === "number" && item.pct > 0)
    : [];
  if (composition.length) {
    const parts = [];
    let used = 0;
    for (const item of composition) {
      used += item.pct;
      parts.push({
        bucket: bucketForComposition(item, fund),
        label: item.label || item.kind || null,
        value: (value * item.pct) / 100,
      });
    }
    if (used < 98) {
      parts.push({
        bucket: bucketForCategory(fund) || "other",
        label: "Решта",
        value: (value * (100 - used)) / 100,
      });
    }
    return parts;
  }
  return [{ bucket: bucketForCategory(fund) || "other", label: null, value }];
}

function isCompanyKey(key) {
  return /^[A-Z0-9]{1,6}([.-][A-Z]{1,4})?$/.test(key);
}

function looksLikeFund(position) {
  if (SUGGESTED_PROXIES[position.ticker]) return true;
  if (/ETF/i.test(position.group || "")) return true;
  return /ETF|UCITS|FUND|INDEX|TRUST|ISHARES|VANGUARD|SPDR|INVESCO|WISDOMTREE|LYXOR|AMUNDI|XTRACKERS/i
    .test(`${position.name || ""} ${position.ticker || ""}`);
}

function dominantBucket(parts) {
  let best = parts[0]?.bucket || "other";
  let bestValue = -Infinity;
  for (const part of parts) {
    if (part.value > bestValue) {
      bestValue = part.value;
      best = part.bucket;
    }
  }
  return best;
}

function resolutionFor(ticker, resolved) {
  if (!resolved) return null;
  if (resolved instanceof Map) return resolved.get(ticker) || null;
  return resolved[ticker] || null;
}

export function analyze(positions, resolved) {
  const list = (positions || []).filter((position) => position && typeof position.value === "number" && position.value !== 0);
  const total = list.reduce((sum, position) => sum + position.value, 0);
  const bucketValues = Object.fromEntries(BUCKETS.map((bucket) => [bucket.id, 0]));
  const detailMap = {};
  const companies = new Map();
  let equityAssigned = 0;
  const enriched = [];
  const uncovered = [];
  const proxies = [];
  let expenseWeighted = 0;
  let expenseBase = 0;
  const holdingsAsOf = {};
  const currencies = new Set();

  function addDetail(bucket, label, value) {
    bucketValues[bucket] = (bucketValues[bucket] || 0) + value;
    if (!label) return;
    detailMap[bucket] ||= new Map();
    detailMap[bucket].set(label, (detailMap[bucket].get(label) || 0) + value);
  }

  function addCompany(ticker, value, via) {
    if (!value) return;
    let row = companies.get(ticker);
    if (!row) {
      row = { ticker, value: 0, via: [] };
      companies.set(ticker, row);
    }
    row.value += value;
    if (via) row.via.push(via);
  }

  for (const position of list) {
    if (position.currency) currencies.add(position.currency);
    const info = {
      ...position,
      bucket: "other",
      dataNote: "",
      asOf: null,
      proxy: null,
    };

    if (position.assetClass === "CASH" || (CASH_CODES.has(position.ticker) && position.assetClass === "CASH")) {
      addDetail("cash", position.ticker, position.value);
      info.bucket = "cash";
      info.dataNote = "Готівка";
      enriched.push(info);
      continue;
    }

    if (DERIVATIVE_CLASSES.has(position.assetClass)) {
      addDetail("derivatives", position.assetClass, position.value);
      info.bucket = "derivatives";
      info.dataNote = "Похідний інструмент, без look-through";
      enriched.push(info);
      continue;
    }

    if (position.assetClass === "BOND" || position.assetClass === "BILL") {
      const bucket = position.assetClass === "BILL" ? "cash" : "bonds";
      addDetail(bucket, position.name || position.ticker, position.value);
      info.bucket = bucket;
      info.dataNote = position.assetClass === "BILL" ? "Короткий папір" : "Окрема облігація";
      enriched.push(info);
      continue;
    }

    const resolvedRow = resolutionFor(position.ticker, resolved);
    const fund = resolvedRow?.fund || null;

    if (resolvedRow?.error) {
      addDetail("other", position.ticker, position.value);
      info.bucket = "other";
      info.dataNote = resolvedRow.message || "Не вдалося завантажити TickerInside";
      uncovered.push({ ticker: position.ticker, name: position.name, value: position.value, network: true });
      enriched.push(info);
      continue;
    }

    if (fund && !fund.notFund) {
      if (String(fund.source_layer || "").includes("derivative")) {
        addDetail("derivatives", fund.name || position.ticker, position.value);
        info.bucket = "derivatives";
        info.dataNote = "Фонд на деривативах. Його акційні рядки не показують реальну експозицію.";
      } else {
        const parts = allocateFund(position.value, fund);
        for (const part of parts) addDetail(part.bucket, part.label, part.value);
        info.bucket = dominantBucket(parts);
        equityAssigned += addEquityLookthrough(position, fund, addCompany, resolvedRow?.proxy || null);
        if (fund.expense_ratio != null && position.value > 0) {
          expenseWeighted += fund.expense_ratio * position.value;
          expenseBase += position.value;
        }
        if (fund.holdings_as_of) holdingsAsOf[position.ticker] = fund.holdings_as_of;
        info.asOf = fund.holdings_as_of || null;
        info.proxy = resolvedRow?.proxy || null;
        info.dataNote = resolvedRow?.proxy
          ? `Наближення через ${resolvedRow.proxy}. ${resolvedRow.note || ""}`.trim()
          : (fund.name || "Файл фонду TickerInside");
        if (resolvedRow?.proxy) {
          proxies.push({ ticker: position.ticker, proxy: resolvedRow.proxy, note: resolvedRow.note || "" });
        }
      }
      enriched.push(info);
      continue;
    }

    const hint = ASSET_CLASS_HINTS[position.ticker];
    if (hint && (!fund || fund.notFund) && !resolvedRow?.stock) {
      addDetail(hint.bucket, hint.label || position.ticker, position.value);
      info.bucket = hint.bucket;
      info.dataNote = hint.note;
      enriched.push(info);
      continue;
    }

    if (resolvedRow?.stock && !looksLikeFund(position)) {
      addDetail("stocks", null, position.value);
      addCompany(position.ticker, position.value, { fund: null, value: position.value, direct: true, proxy: null });
      equityAssigned += position.value;
      info.bucket = "stocks";
      info.dataNote = "Окрема акція";
      enriched.push(info);
      continue;
    }

    if (!resolvedRow || resolvedRow.unknown || fund?.notFund) {
      if (looksLikeFund(position)) {
        addDetail("other", position.ticker, position.value);
        info.bucket = "other";
        info.dataNote = "Немає файлу фонду в TickerInside. Задайте відповідник, якщо знаєте US-тікер.";
        uncovered.push({ ticker: position.ticker, name: position.name, value: position.value, fundLike: true });
      } else {
        addDetail("stocks", null, position.value);
        addCompany(position.ticker, position.value, { fund: null, value: position.value, direct: true, proxy: null });
        equityAssigned += position.value;
        info.bucket = "stocks";
        info.dataNote = "Немає в TickerInside, зараховано як окрема акція";
        uncovered.push({ ticker: position.ticker, name: position.name, value: position.value, assumedStock: true });
      }
      enriched.push(info);
    }
  }

  const companyRows = [...companies.values()]
    .map((row) => ({
      ticker: row.ticker,
      value: row.value,
      pct: total ? (row.value / total) * 100 : 0,
      via: mergeVia(row.via),
    }))
    .sort((a, b) => b.value - a.value);

  const stocksValue = bucketValues.stocks || 0;
  const residual = stocksValue - equityAssigned;
  const buckets = BUCKETS
    .map((bucket) => ({
      ...bucket,
      value: bucketValues[bucket.id] || 0,
      pct: total ? ((bucketValues[bucket.id] || 0) / total) * 100 : 0,
    }))
    .filter((bucket) => Math.abs(bucket.value) > 1e-6);

  const details = {};
  for (const [bucket, labels] of Object.entries(detailMap)) {
    details[bucket] = [...labels.entries()]
      .map(([label, value]) => ({ label, value, pct: total ? (value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  }

  const top10 = companyRows.slice(0, 10).reduce((sum, row) => sum + row.value, 0);

  return {
    total,
    mixedCurrency: currencies.size > 1,
    currencies: [...currencies],
    buckets,
    details,
    companies: companyRows,
    companyCount: companyRows.length,
    residualEquity: Math.abs(residual) > Math.max(1, Math.abs(total) * 0.002)
      ? { value: residual, pct: total ? (residual / total) * 100 : 0 }
      : null,
    top10Pct: total ? (top10 / total) * 100 : 0,
    positions: enriched.sort((a, b) => b.value - a.value),
    uncovered,
    proxies,
    expenseRatio: expenseBase > 0 ? expenseWeighted / expenseBase : null,
    holdingsAsOf,
    lookedThroughPct: total ? (equityAssigned / total) * 100 : 0,
    bucketLabel: BUCKET_LABEL,
  };
}

function addEquityLookthrough(position, fund, addCompany, proxy) {
  if (String(fund.source_layer || "").includes("derivative")) return 0;
  const asset = fund.category?.asset_class;
  const kind = fund.holdings_kind;
  if (asset === "bond" || kind === "bond") return 0;
  let assigned = 0;
  for (const [key, weight] of Object.entries(fund.holdings || {})) {
    if (typeof weight !== "number" || !weight || !isCompanyKey(key)) continue;
    const value = (position.value * weight) / 100;
    assigned += value;
    addCompany(key, value, { fund: position.ticker, value, direct: false, proxy });
  }
  return assigned;
}

function mergeVia(via) {
  const merged = new Map();
  for (const item of via) {
    const key = item.direct ? "direct" : `${item.fund}|${item.proxy || ""}`;
    const prev = merged.get(key) || { fund: item.fund, value: 0, direct: !!item.direct, proxy: item.proxy || null };
    prev.value += item.value;
    merged.set(key, prev);
  }
  return [...merged.values()].sort((a, b) => b.value - a.value);
}

export function tickersToResolve(positions) {
  const tickers = [];
  for (const position of positions) {
    if (position.assetClass === "CASH" || position.assetClass === "BOND" || position.assetClass === "BILL") continue;
    if (ASSET_CLASS_HINTS[position.ticker]) continue;
    if (DERIVATIVE_CLASSES.has(position.assetClass)) continue;
    tickers.push(position.ticker);
  }
  return [...new Set(tickers)];
}
