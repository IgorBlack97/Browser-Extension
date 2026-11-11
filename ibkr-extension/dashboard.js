import {
  analyze,
  parseManual,
  positionsFromSnapshot,
  readIbkrAllocation,
  readSummary,
  tickersToResolve,
} from "./lib/analyze.js";
import { SUGGESTED_PROXIES } from "./lib/proxies.js";
import { loadResolutions } from "./lib/tickerinside.js";
import { dayReturn, layoutTreemap } from "./lib/day.js";
import { mergeAccountCash, positionsInEur, toEur } from "./lib/fx.js";

const app = document.querySelector("#app");
const accountSelect = document.querySelector("#account");
const money = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const state = {
  snapshot: null,
  aliases: {},
  fundCache: {},
  accountId: "all",
  reportCurrency: "EUR",
  includeCash: false,
  view: null,
  prepared: null,
  running: false,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatMoney(value, currency) {
  if (value == null || !Number.isFinite(value)) return "—";
  const formatted = money.format(value);
  return currency ? `${formatted} ${currency}` : formatted;
}

function formatSignedPct(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${pctFmt.format(value)}%`;
}

function mixColor(from, to, amount) {
  const parse = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const start = parse(from);
  const end = parse(to);
  const mixed = start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function tileColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return "#3a4150";
  if (pct >= 0) return mixColor("#146b3a", "#22c55e", Math.min(pct / 3, 1));
  return mixColor("#5c6575", "#e11d48", Math.min(Math.abs(pct) / 3, 1));
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${pctFmt.format(value)}%`;
}

function formatWhen(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("uk-UA", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

function sourceLabel(source) {
  if (source === "portal") return "Client Portal";
  if (source === "gateway") return "Gateway";
  if (source === "manual") return "вставлені вручну";
  if (source === "demo") return "приклад";
  return "невідоме джерело";
}

function accountsOf(snapshot) {
  const map = new Map();
  for (const account of snapshot?.accounts || []) {
    const id = account.id || account.accountId;
    if (!id) continue;
    map.set(id, account.accountTitle || account.accountVan || account.displayName || id);
  }
  for (const id of Object.keys(snapshot?.positionsByAccount || {})) {
    if (!map.has(id)) map.set(id, id);
  }
  return [...map.entries()];
}

function summaryFor(snapshot, accountId) {
  const summaries = snapshot?.summaryByAccount || {};
  const ids = !accountId || accountId === "all" ? Object.keys(summaries) : [accountId];
  let total = 0;
  let seen = false;
  const currencies = new Set();
  for (const id of ids) {
    const read = readSummary(summaries[id]);
    if (read.total == null) continue;
    seen = true;
    total += read.total;
    if (read.currency) currencies.add(read.currency);
  }
  return {
    total: seen ? total : null,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}

function fillAccounts() {
  const accounts = accountsOf(state.snapshot);
  accountSelect.replaceChildren();
  if (accounts.length < 2) {
    accountSelect.hidden = true;
    if (accounts.length === 1) state.accountId = accounts[0][0];
    return;
  }
  accountSelect.hidden = false;
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "Усі рахунки";
  accountSelect.appendChild(all);
  for (const [id, title] of accounts) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = title === id ? id : `${title} (${id})`;
    accountSelect.appendChild(option);
  }
  if (![...accountSelect.options].some((option) => option.value === state.accountId)) {
    state.accountId = "all";
  }
  accountSelect.value = state.accountId;
}

function demoSnapshot() {
  return {
    source: "demo",
    syncedAt: new Date().toISOString(),
    accounts: [{ id: "demo", accountTitle: "Приклад", currency: "USD" }],
    positionsByAccount: {
      demo: [
        { contractDesc: "VOO", fullName: "Vanguard S&P 500 ETF", mktValue: 40000, currency: "USD", assetClass: "STK", group: "ETFs" },
        { contractDesc: "QQQ", fullName: "Invesco QQQ Trust", mktValue: 15000, currency: "USD", assetClass: "STK", group: "ETFs" },
        { contractDesc: "BND", fullName: "Vanguard Total Bond Market ETF", mktValue: 20000, currency: "USD", assetClass: "STK", group: "ETFs" },
        { contractDesc: "GLD", fullName: "SPDR Gold Shares", mktValue: 8000, currency: "USD", assetClass: "STK", group: "ETFs" },
        { contractDesc: "AAPL", fullName: "Apple Inc", mktValue: 5000, currency: "USD", assetClass: "STK" },
        { contractDesc: "USD", mktValue: 2000, currency: "USD", assetClass: "CASH" },
      ],
    },
    summaryByAccount: { demo: { netliquidation: { amount: 90000, currency: "USD" } } },
    allocationByAccount: {},
  };
}

async function persistSnapshot(snapshot) {
  const response = await chrome.runtime.sendMessage({ type: "SAVE_SNAPSHOT", snapshot });
  state.snapshot = response?.snapshot || snapshot;
  fillAccounts();
}

function renderMessage(html) {
  app.innerHTML = `<section class="card">${html}</section>${importCard()}`;
  bindImport();
}

function importCard() {
  return `
    <section class="card" style="margin-top:16px">
      <h2 class="section-title">Свої позиції</h2>
      <p class="note" style="margin-top:0">Один рядок: тікер і сума. Готівку позначте кодом валюти. Приклад нижче можна замінити своїм списком.</p>
      <textarea id="manual">AGGU 350 USD
EGLN 715 EUR
GOOGL 280 USD
VWCE 1500 EUR
USD 200</textarea>
      <div class="tools" style="margin-top:10px">
        <button id="use-manual" class="primary" type="button">Порахувати цей список</button>
        <button id="use-demo" type="button">Приклад VOO / QQQ / BND / GLD</button>
      </div>
    </section>`;
}

function bindImport() {
  document.querySelector("#use-manual")?.addEventListener("click", async () => {
    const positions = parseManual(document.querySelector("#manual").value);
    if (!positions.length) return;
    await persistSnapshot({
      source: "manual",
      accounts: [{ id: "manual", accountTitle: "Вставлений список" }],
      positionsByAccount: { manual: positions },
      summaryByAccount: {},
      allocationByAccount: {},
    });
    run();
  });
  document.querySelector("#use-demo")?.addEventListener("click", async () => {
    await persistSnapshot(demoSnapshot());
    run();
  });
}

function viaText(via, total) {
  return via.slice(0, 3).map((item) => {
    const share = total ? formatPct((item.value / total) * 100) : "";
    if (item.direct) return `окремо ${share}`;
    const proxy = item.proxy ? ` → ${item.proxy}` : "";
    return `${item.fund}${proxy} ${share}`;
  }).join(", ");
}

function renderAnalysis(analysis, snapshot, fx, cashInfo = { lines: [], included: true }) {
  state.view = { analysis, snapshot, fx };
  const currency = state.reportCurrency === "USD" && fx.table.rates?.USD ? "USD" : "EUR";
  const usdRate = fx.table.rates?.USD || null;
  const moneyFromEur = (eurValue) => {
    if (eurValue == null || !Number.isFinite(eurValue)) return "—";
    if (currency === "USD") return formatMoney(eurValue * usdRate, "USD");
    return formatMoney(eurValue, "EUR");
  };
  const cashLines = cashInfo.lines || [];
  const cashTotal = cashLines.reduce((sum, line) => sum + (Number.isFinite(line.value) && !line.fxMissing ? line.value : 0), 0);
  const booked = state.prepared?.positions || [];
  const securitiesTotal = booked.length
    ? booked.filter((position) => position.assetClass !== "CASH" && !position.fxMissing).reduce((sum, position) => sum + position.value, 0)
    : (cashInfo.included ? analysis.total - cashTotal : analysis.total);
  const balanceTotal = booked.length
    ? booked.filter((position) => !position.fxMissing).reduce((sum, position) => sum + position.value, 0)
    : securitiesTotal + cashTotal;
  const cashNative = cashLines
    .filter((line) => line.nativeValue != null && line.nativeCurrency)
    .map((line) => formatMoney(line.nativeValue, line.nativeCurrency))
    .join(" + ");
  const summary = summaryFor(snapshot, state.accountId);
  const summaryEur = summary.total != null && summary.currency
    ? toEur(summary.total, summary.currency, fx.table.rates).eur
    : null;
  const rateText = usdRate
    ? `1 EUR = ${new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(usdRate)} USD`
    : "";
  const maxCompany = analysis.companies[0]?.pct || 1;
  const shown = analysis.companies.slice(0, 30);
  const tail = analysis.companies.slice(30);
  const tailValue = tail.reduce((sum, row) => sum + row.value, 0);
  const dates = [...new Set(Object.values(analysis.holdingsAsOf))].sort();
  const allocation = readIbkrAllocation(
    (snapshot.allocationByAccount || {})[state.accountId] || Object.values(snapshot.allocationByAccount || {})[0],
  );
  const hasPnl = analysis.positions.some((position) => position.pnl != null);

  const bucketRows = analysis.buckets.map((bucket) => {
    const details = (analysis.details[bucket.id] || [])
      .filter((row) => row.label && row.label !== bucket.label)
      .slice(0, 6);
    const detailHtml = details.length
      ? `<div class="subrows">${details.map((row) => `<div><span>${esc(row.label)}</span><span>${formatPct(row.pct)} · ${esc(moneyFromEur(row.value))}</span></div>`).join("")}</div>`
      : "";
    return `
      <div class="legend-row">
        <i class="swatch" style="background:${bucket.color}"></i>
        <span>${esc(bucket.label)}</span>
        <span class="pct">${formatPct(bucket.pct)}</span>
        <span class="money">${esc(moneyFromEur(bucket.value))}</span>
      </div>
      ${detailHtml}`;
  }).join("");

  const bar = analysis.buckets
    .filter((bucket) => bucket.value > 0)
    .map((bucket) => `<i title="${esc(bucket.label)} ${formatPct(bucket.pct)}" style="width:${Math.max(bucket.pct, 0.8)}%;background:${bucket.color}"></i>`)
    .join("");

  const companyRows = shown.map((row) => `
    <tr>
      <td>
        <strong>${esc(row.ticker)}</strong>
        <div class="weight"><span style="width:${Math.max((row.pct / maxCompany) * 100, 2)}%"></span></div>
      </td>
      <td class="num">${formatPct(row.pct)}</td>
      <td class="num">${esc(moneyFromEur(row.value))}</td>
      <td class="via">${esc(viaText(row.via, analysis.total))}</td>
    </tr>`).join("");

  const positionRows = analysis.positions.map((position) => `
    <tr>
      <td><strong>${esc(position.ticker)}</strong><div class="name">${esc(position.name || "")}</div></td>
      <td class="num">${position.fxMissing ? esc(formatMoney(position.value, position.nativeCurrency || "")) : esc(moneyFromEur(position.value))}${position.nativeCurrency && position.nativeCurrency !== currency && position.nativeValue != null ? `<div class="name">${esc(formatMoney(position.nativeValue, position.nativeCurrency))}</div>` : ""}</td>
      <td class="num">${formatPct(analysis.total ? (position.value / analysis.total) * 100 : 0)}</td>
      <td>${esc(analysis.bucketLabel[position.bucket] || position.bucket)}${position.proxy ? ` <span class="tag">${esc(position.proxy)}</span>` : ""}<div class="name">${esc(position.dataNote || "")}</div></td>
      ${hasPnl ? `<td class="num">${position.pnl == null ? "—" : esc(moneyFromEur(position.pnl))}</td>` : ""}
    </tr>`).join("");

  const uncovered = analysis.uncovered.filter((row) => row.fundLike || row.network);
  const aliasHtml = uncovered.map((row) => `
    <div class="alias">
      <span>${esc(row.ticker)} · ${esc(moneyFromEur(row.value))}</span>
      <input data-alias-for="${esc(row.ticker)}" placeholder="${esc(SUGGESTED_PROXIES[row.ticker]?.proxy || "US-тікер")}" value="${esc(state.aliases[row.ticker] || "")}">
    </div>`).join("");

  const ibkrHtml = allocation.length
    ? `<section class="card" style="margin-top:16px">
        <h2 class="section-title">Як це бачить IBKR</h2>
        <p class="note" style="margin-top:0">Брокер кладе ETF у «акції» і не розкриває компанії всередині. Цифри нижче — його класи, не X-Ray.</p>
        ${allocation.map((row) => `<div class="legend-row"><i class="swatch" style="background:#474D57"></i><span>${esc(row.label)}</span><span class="pct">${formatPct(row.pct)}</span><span class="money">${esc(formatMoney(row.value, fx.baseCurrency || ""))}</span></div>`).join("")}
      </section>`
    : "";

  const warnings = [];
  if (fx.missing?.length) {
    const names = [...new Set(fx.missing.map((row) => `${row.ticker} (${row.currency})`))].join(", ");
    warnings.push(`Без курсу в євро: ${names}. Ці суми не перераховані і змішуються з євро.`);
  }
  if (fx.table.stale) warnings.push("Свіжий курс ЄЦБ не завантажився, суми пораховані збереженим курсом.");
  if (analysis.residualEquity && analysis.residualEquity.value < 0) {
    warnings.push("Ваги всередині фонду вийшли більші за його ринкову вартість. Так буває у фондів із плечем: їх не варто читати як звичайні акції.");
  }
  if (snapshot.source === "demo") warnings.push("Це приклад, не ваш рахунок.");

  const day = dayReturn(analysis.positions);
  const mapW = 1000;
  const mapH = 280;
  const tiles = layoutTreemap(day.tiles, mapW, mapH).map((rect) => {
    const compact = rect.w < 140 || rect.h < 78;
    return `<div class="tile" style="left:${(rect.x / mapW) * 100}%;top:${(rect.y / mapH) * 100}%;width:${(rect.w / mapW) * 100}%;height:${(rect.h / mapH) * 100}%;background:${tileColor(rect.pct)}">
      <strong>${esc(rect.ticker)}</strong>
      ${compact ? "" : `<span>${formatSignedPct(rect.pct)}</span>`}
    </div>`;
  }).join("");
  const dayClass = day.dayPct > 0 ? "up" : day.dayPct < 0 ? "down" : "";
  const dayMoney = day.dayPnl == null ? "" : `${day.dayPnl > 0 ? "+" : ""}${moneyFromEur(day.dayPnl)}`;

  app.innerHTML = `
    <div class="note" style="margin:0 0 12px">Суми аналізу в ${currency}${fx.table.date ? ` · курс ЄЦБ на ${esc(fx.table.date)}` : ""}${rateText ? ` · ${esc(rateText)}` : ""}. Джерело позицій: ${esc(sourceLabel(snapshot.source))}${snapshot.syncedAt ? ` · ${esc(formatWhen(snapshot.syncedAt))}` : ""}${dates.length ? ` · файли фондів ${esc(dates[0])}${dates.length > 1 ? ` … ${esc(dates[dates.length - 1])}` : ""}` : ""}</div>
    ${warnings.map((text) => `<div class="warn">${esc(text)}</div>`).join("")}
    <section class="kpis">
      <article class="card"><div class="kpi-label">Загальний баланс</div><div class="kpi-value">${esc(moneyFromEur(balanceTotal))}</div><div class="kpi-sub">${cashLines.length ? `включно з вільними ${esc(moneyFromEur(cashTotal))}` : "вільні гроші не зчитані"}</div></article>
      <article class="card"><div class="kpi-label">Сума позицій</div><div class="kpi-value">${esc(moneyFromEur(securitiesTotal))}</div><div class="kpi-sub">${summaryEur != null ? `Net liquidation ${esc(moneyFromEur(summaryEur))}${summary.currency && summary.currency !== currency ? ` · у брокера ${esc(formatMoney(summary.total, summary.currency))}` : ""}` : `${analysis.positions.length} позицій`}</div></article>
      <article class="card"><div class="kpi-label">Акції наскрізь</div><div class="kpi-value">${formatPct(analysis.buckets.find((bucket) => bucket.id === "stocks")?.pct || 0)}</div><div class="kpi-sub">${analysis.companyCount} компаній у розкладі</div></article>
      <article class="card"><div class="kpi-label">Топ-10 компаній</div><div class="kpi-value">${formatPct(analysis.top10Pct)}</div><div class="kpi-sub">частка всього портфеля</div></article>
      <article class="card"><div class="kpi-label">Комісія фондів</div><div class="kpi-value">${analysis.expenseRatio == null ? "—" : `${pctFmt.format(analysis.expenseRatio)}%`}</div><div class="kpi-sub">середня зважена, лише фонди з файлом</div></article>
    </section>
    <section class="card day-card">
      <div class="day-head">
        <div class="kpi-label">Дохідність за день</div>
        <div class="day-change ${dayClass}">${day.dayPct == null ? "немає денної зміни" : `${formatSignedPct(day.dayPct)}${dayMoney ? ` · ${esc(dayMoney)}` : ""}`}</div>
      </div>
      ${tiles ? `<div class="treemap">${tiles}</div>` : ""}
      ${day.missing.length ? `<p class="note">Без ціни за сьогодні: ${esc(day.missing.join(", "))}. Зчитайте портфель ще раз, коли ринок уже дав зміну.</p>` : ""}
    </section>
    <div class="layout">
      <section class="card">
        <h2 class="section-title">Склад портфеля</h2>
        <button type="button" id="include-cash" class="check${state.includeCash ? " on" : ""}" aria-pressed="${state.includeCash ? "true" : "false"}">
          <span class="box">${state.includeCash ? "✓" : ""}</span>
          ${cashLines.length ? `Враховувати вільні гроші (${esc(moneyFromEur(cashTotal))}${cashNative ? ` · ${esc(cashNative)}` : ""})` : "Враховувати вільні гроші"}
        </button>
        ${cashLines.length && !cashInfo.included ? `<p class="note">Вільні гроші поза розподілом: ${esc(moneyFromEur(cashTotal))}${cashNative ? ` (${esc(cashNative)})` : ""}.</p>` : ""}
        ${cashLines.length ? "" : `<p class="note">Вільний баланс ще не прийшов з порталу. Відкрийте Balances і зчитайте портфель ще раз.</p>`}
        <div class="bar">${bar}</div>
        <div class="legend">${bucketRows || `<div class="empty">Немає суми для розкладу.</div>`}</div>
        ${analysis.residualEquity && analysis.residualEquity.value > 0 ? `<p class="note">Ще ${esc(moneyFromEur(analysis.residualEquity.value))} (${formatPct(analysis.residualEquity.pct)}) акцій лишились дрібними рядками файлів і не потрапили в іменовані компанії.</p>` : ""}
      </section>
      <section class="card">
        <h2 class="section-title">X-Ray <span class="note">компанії всередині фондів і окремі акції</span></h2>
        <table>
          <thead><tr><th>Компанія</th><th class="num">Частка</th><th class="num">Сума</th><th>Звідки</th></tr></thead>
          <tbody>
            ${companyRows || `<tr><td colspan="4" class="empty">Немає акцій, які вдалося розкласти.</td></tr>`}
            ${tail.length ? `<tr><td>Ще ${tail.length} компаній</td><td class="num">${formatPct(analysis.total ? (tailValue / analysis.total) * 100 : 0)}</td><td class="num">${esc(moneyFromEur(tailValue))}</td><td class="via">дрібні рядки нижче топ-30</td></tr>` : ""}
          </tbody>
        </table>
      </section>
    </div>
    <section class="card">
      <h2 class="section-title">Позиції</h2>
      <table>
        <thead><tr><th>Інструмент</th><th class="num">Вартість</th><th class="num">Частка</th><th>Клас</th>${hasPnl ? `<th class="num">Нереалізований PnL</th>` : ""}</tr></thead>
        <tbody>${positionRows}</tbody>
      </table>
      ${uncovered.length ? `<div class="note"><strong>Без файлу TickerInside.</strong> Впишіть US-тікер-відповідник і оновіть аналіз. Відповідник — той самий клас активу, не копія фонду.${aliasHtml}<div class="tools" style="margin-top:10px"><button id="save-aliases" class="blue" type="button">Застосувати відповідники</button></div></div>` : ""}
    </section>
    ${ibkrHtml}
    ${importCard()}`;
  document.querySelector("#include-cash")?.addEventListener("click", () => {
    state.includeCash = !state.includeCash;
    chrome.storage.local.set({ includeCash: state.includeCash });
    renderPrepared();
  });
  bindImport();
  document.querySelector("#save-aliases")?.addEventListener("click", async () => {
    for (const input of document.querySelectorAll("[data-alias-for]")) {
      const ticker = input.getAttribute("data-alias-for");
      const value = input.value.trim().toUpperCase();
      if (value) state.aliases[ticker] = value;
      else delete state.aliases[ticker];
    }
    await chrome.storage.local.set({ aliases: state.aliases });
    run();
  });
}

async function run() {
  if (state.running) return;
  const snapshot = state.snapshot;
  if (!snapshot) {
    renderMessage(`<h2 class="section-title">Портфеля ще немає</h2>
      <p>Відкрийте <strong>Client Portal</strong>, увійдіть і зайдіть на Portfolio. Потім натисніть «Зчитати з вкладки IBKR». Якщо портал уже відкритий, оновіть його сторінку після встановлення розширення: інакше перехоплення відповідей не встигне стати.</p>
      <p class="note">Можна нічого не підключати й вставити тікери з сумами нижче.</p>`);
    return;
  }
  const probe = positionsFromSnapshot(snapshot, state.accountId);
  if (!probe.length) {
    renderMessage("<h2 class=\"section-title\">У цьому рахунку немає позицій із ринковою вартістю</h2>");
    return;
  }
  state.running = true;
  document.querySelector("#refresh").disabled = true;
  app.innerHTML = `<section class="card"><p>Зводжу валюти в євро і завантажую файли фондів…</p></section>`;
  try {
    const fx = await positionsInEur(snapshot, state.accountId, state.fxCache);
    state.fxCache = fx.table;
    try {
      await chrome.storage.local.set({
        fxCache: { at: fx.table.at, date: fx.table.date, rates: fx.table.rates, source: fx.table.source },
      });
    } catch {
      /* The rate table is small; the view still renders if storage rejects it. */
    }
    const tickers = tickersToResolve(fx.positions);
    const { resolutions, cache } = await loadResolutions(tickers, {
      aliases: state.aliases,
      cache: state.fundCache,
    });
    state.fundCache = cache;
    try {
      await chrome.storage.local.set({ fundCache: cache });
    } catch {
      /* A large holdings cache is optional. The view still renders. */
    }
    const merged = mergeAccountCash(fx.positions, snapshot, state.accountId, fx.table);
    state.prepared = { positions: merged.positions, resolutions, snapshot, fx };
    renderPrepared();
  } catch (error) {
    renderMessage(`<h2 class="section-title">Не вдалося побудувати аналіз</h2><p>${esc(error.message || error)}</p>`);
  } finally {
    state.running = false;
    document.querySelector("#refresh").disabled = false;
  }
}

function paintToggle() {
  for (const button of document.querySelectorAll("#ccy-toggle button")) {
    button.classList.toggle("active", button.dataset.ccy === state.reportCurrency);
  }
}

function renderPrepared() {
  const prepared = state.prepared;
  if (!prepared) return;
  const cash = prepared.positions.filter((position) => String(position.assetClass || "").toUpperCase() === "CASH");
  const used = state.includeCash
    ? prepared.positions
    : prepared.positions.filter((position) => String(position.assetClass || "").toUpperCase() !== "CASH");
  renderAnalysis(analyze(used, prepared.resolutions), prepared.snapshot, prepared.fx, {
    lines: cash,
    included: state.includeCash && cash.length > 0,
  });
}

async function init() {
  const stored = await chrome.storage.local.get(["snapshot", "aliases", "fundCache", "fxCache", "accountFilter", "reportCurrency", "includeCash"]);
  state.snapshot = stored.snapshot || null;
  state.aliases = stored.aliases || {};
  state.fundCache = stored.fundCache || {};
  state.fxCache = stored.fxCache || null;
  state.accountId = stored.accountFilter || "all";
  state.reportCurrency = stored.reportCurrency === "USD" ? "USD" : "EUR";
  state.includeCash = stored.includeCash === true;
  paintToggle();
  fillAccounts();
  run();
}

document.querySelector("#ccy-toggle").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-ccy]");
  if (!button || button.dataset.ccy === state.reportCurrency) return;
  if (button.dataset.ccy === "USD" && state.view && !state.view.fx.table.rates?.USD) return;
  state.reportCurrency = button.dataset.ccy;
  chrome.storage.local.set({ reportCurrency: state.reportCurrency });
  paintToggle();
  if (state.prepared) renderPrepared();
});
document.querySelector("#refresh").addEventListener("click", () => run());
document.querySelector("#pull").addEventListener("click", async () => {
  const button = document.querySelector("#pull");
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "PULL_PORTAL" });
    if (!response?.ok) {
      renderMessage(`<h2 class="section-title">Портал не віддав позиції</h2><p>${esc(response?.error || "Невідома помилка")}</p>`);
      return;
    }
    state.snapshot = response.snapshot;
    fillAccounts();
    run();
  } finally {
    button.disabled = false;
  }
});
accountSelect.addEventListener("change", () => {
  state.accountId = accountSelect.value;
  chrome.storage.local.set({ accountFilter: state.accountId });
  run();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.snapshot || state.running) return;
  state.snapshot = changes.snapshot.newValue;
  fillAccounts();
  run();
});

init();
