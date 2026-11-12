import { analyze, tickersToResolve } from "./analyze.js";
import { dayReturn, layoutTreemap } from "./day.js";
import { loadResolutions } from "./tickerinside.js";

const app = document.querySelector("#app");
const moneyFmt = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const state = {
  report: null,
  resolutions: null,
  currency: "EUR",
  includeCash: false,
};

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));
}

function formatPct(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${pctFmt.format(value)}%`;
}

function formatSignedPct(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${pctFmt.format(value)}%`;
}

function inCurrency(usd) {
  if (usd == null || !Number.isFinite(usd)) return null;
  const usdPerEur = state.report?.usdPerEur;
  return state.currency === "EUR" && usdPerEur ? usd / usdPerEur : usd;
}

function money(usd) {
  const amount = inCurrency(usd);
  if (amount == null) return "—";
  return `${moneyFmt.format(amount)} ${state.currency}`;
}

function pointLabel(bucket) {
  if (!bucket) return "";
  const [date, hour] = bucket.split("T");
  const [, month, day] = (date || "").split("-");
  return `${day}.${month} ${hour || "00"}:00`;
}

function mixColor(from, to, amount) {
  const parse = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const start = parse(from);
  const end = parse(to);
  return `#${start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function tileColor(pct) {
  if (pct == null || !Number.isFinite(pct)) return "#3a4150";
  if (pct >= 0) return mixColor("#146b3a", "#22c55e", Math.min(pct / 3, 1));
  return mixColor("#5c6575", "#e11d48", Math.min(Math.abs(pct) / 3, 1));
}

function holdingsPositions() {
  return (state.report?.holdings || []).filter((item) => item.valueUsd).map((item) => ({
    ticker: item.ticker,
    name: item.name || item.ticker,
    value: item.valueUsd,
    currency: "USD",
    nativeValue: item.valueUsd,
    nativeCurrency: "USD",
    assetClass: "STK",
    group: /ETF|UCITS|FUND|TRUST/i.test(item.name || "") ? "ETFs" : null,
    dayChangePct: item.dayChangePct,
    quantity: item.quantity,
  }));
}

function cashPositions() {
  return (state.report?.cash || []).filter((item) => item.valueUsd).map((item) => ({
    ticker: item.currency,
    name: `Вільні ${item.currency}`,
    value: item.valueUsd,
    currency: "USD",
    nativeValue: item.amount,
    nativeCurrency: item.currency,
    assetClass: "CASH",
    dayChangePct: null,
  }));
}

function analysisPositions() {
  return state.includeCash ? [...holdingsPositions(), ...cashPositions()] : holdingsPositions();
}

function viaText(via, total) {
  return via.slice(0, 3).map((item) => {
    const share = total ? formatPct((item.value / total) * 100) : "";
    if (item.direct) return `окремо ${share}`;
    const proxy = item.proxy ? ` → ${item.proxy}` : "";
    return `${item.fund}${proxy} ${share}`;
  }).join(", ");
}

function render() {
  const report = state.report;
  const latest = report.latest || {};
  const cashUsd = latest.cashUsd || cashPositions().reduce((sum, item) => sum + item.value, 0);
  const investedUsd = latest.investedUsd || holdingsPositions().reduce((sum, item) => sum + item.value, 0);
  const balanceUsd = latest.totalUsd || investedUsd + cashUsd;
  const analysis = analyze(analysisPositions(), state.resolutions || {});
  const day = dayReturn(analysisPositions());
  const maxCompany = analysis.companies[0]?.pct || 1;
  const shown = analysis.companies.slice(0, 30);
  const tail = analysis.companies.slice(30);
  const tailValue = tail.reduce((sum, row) => sum + row.value, 0);
  const cashNative = (report.cash || []).map((item) => `${moneyFmt.format(item.amount)} ${item.currency}`).join(" + ");
  const rects = layoutTreemap(day.tiles, 1000, 280);
  const tiles = rects.map((rect) => {
    const compact = rect.w < 140 || rect.h < 78;
    return `<div class="tile" style="left:${(rect.x / 1000) * 100}%;top:${(rect.y / 280) * 100}%;width:${(rect.w / 1000) * 100}%;height:${(rect.h / 280) * 100}%;background:${tileColor(rect.pct)}"><strong>${esc(rect.ticker)}</strong>${compact ? "" : `<span>${formatSignedPct(rect.pct)}</span>`}</div>`;
  }).join("");
  const dayClass = day.dayPct > 0 ? "up" : day.dayPct < 0 ? "down" : "";
  const dayMoney = day.dayPnl == null ? "" : `${day.dayPnl > 0 ? "+" : ""}${money(day.dayPnl)}`;
  const bucketRows = analysis.buckets.map((bucket) => {
    const details = (analysis.details[bucket.id] || []).filter((row) => row.label && row.label !== bucket.label).slice(0, 6);
    const detailHtml = details.length
      ? `<div class="subrows">${details.map((row) => `<div><span>${esc(row.label)}</span><span>${formatPct(row.pct)} · ${esc(money(row.value))}</span></div>`).join("")}</div>`
      : "";
    return `<div class="legend-row"><i class="swatch" style="background:${bucket.color}"></i><span>${esc(bucket.label)}</span><span class="pct">${formatPct(bucket.pct)}</span><span class="money">${esc(money(bucket.value))}</span></div>${detailHtml}`;
  }).join("");
  const bar = analysis.buckets.filter((bucket) => bucket.value > 0).map((bucket) => `<i title="${esc(bucket.label)}" style="width:${Math.max(bucket.pct, 0.8)}%;background:${bucket.color}"></i>`).join("");
  const companyRows = shown.map((row) => `
    <tr>
      <td><strong>${esc(row.ticker)}</strong><div class="weight"><span style="width:${Math.max((row.pct / maxCompany) * 100, 2)}%"></span></div></td>
      <td class="num">${formatPct(row.pct)}</td>
      <td class="num">${esc(money(row.value))}</td>
      <td class="via">${esc(viaText(row.via, analysis.total))}</td>
    </tr>`).join("");

  document.querySelector("#updated").textContent = report.updatedAt
    ? `Суми в ${state.currency}${report.usdPerEur ? ` · 1 EUR = ${report.usdPerEur} USD` : ""} · ціни ${new Date(report.updatedAt).toLocaleString("uk-UA")}`
    : "Немає синхронізації";

  app.innerHTML = `
    <section class="kpis">
      <article class="card"><div class="kpi-label">Загальний баланс</div><div class="kpi-value">${esc(money(balanceUsd))}</div><div class="kpi-sub">включно з вільними ${esc(money(cashUsd))}</div></article>
      <article class="card"><div class="kpi-label">Сума позицій</div><div class="kpi-value">${esc(money(investedUsd))}</div><div class="kpi-sub">${(report.holdings || []).length} позицій</div></article>
      <article class="card"><div class="kpi-label">Акції наскрізь</div><div class="kpi-value">${formatPct(analysis.buckets.find((bucket) => bucket.id === "stocks")?.pct || 0)}</div><div class="kpi-sub">${analysis.companyCount} компаній у розкладі</div></article>
      <article class="card"><div class="kpi-label">Топ-10 компаній</div><div class="kpi-value">${formatPct(analysis.top10Pct)}</div><div class="kpi-sub">частка всього портфеля</div></article>
      <article class="card"><div class="kpi-label">Комісія фондів</div><div class="kpi-value">${analysis.expenseRatio == null ? "—" : `${pctFmt.format(analysis.expenseRatio)}%`}</div><div class="kpi-sub">середня зважена, лише фонди з файлом</div></article>
    </section>
    <section class="card day-card">
      <div class="day-head">
        <div class="kpi-label">Дохідність за день</div>
        <div class="day-change ${dayClass}">${day.dayPct == null ? "немає денної зміни" : `${formatSignedPct(day.dayPct)}${dayMoney ? ` · ${esc(dayMoney)}` : ""}`}</div>
      </div>
      ${tiles ? `<div class="treemap">${tiles}</div>` : `<p class="note">Карта з'явиться після першої оцінки цін.</p>`}
      ${day.missing.length ? `<p class="note">Без денної зміни: ${esc(day.missing.join(", "))}. Наступне годинне оновлення цін її додасть.</p>` : ""}
    </section>
    <div class="layout">
      <section class="card">
        <h2 class="section-title">Склад портфеля</h2>
        <button type="button" id="include-cash" class="check${state.includeCash ? " on" : ""}">
          <span class="box">${state.includeCash ? "✓" : ""}</span>
          Враховувати вільні гроші (${esc(money(cashUsd))}${cashNative ? ` · ${esc(cashNative)}` : ""})
        </button>
        ${state.includeCash ? "" : `<p class="note">Вільні гроші поза розподілом: ${esc(money(cashUsd))}${cashNative ? ` (${esc(cashNative)})` : ""}.</p>`}
        <div class="bar">${bar}</div>
        <div class="legend">${bucketRows || `<div class="empty">Немає даних.</div>`}</div>
      </section>
      <section class="card">
        <h2 class="section-title">X-Ray <span class="note">компанії всередині фондів і окремі акції</span></h2>
        <table>
          <thead><tr><th>Компанія</th><th class="num">Частка</th><th class="num">Сума</th><th>Звідки</th></tr></thead>
          <tbody>
            ${companyRows || `<tr><td colspan="4" class="empty">Рахую склади фондів…</td></tr>`}
            ${tail.length ? `<tr><td>Ще ${tail.length} компаній</td><td class="num">${formatPct(analysis.total ? (tailValue / analysis.total) * 100 : 0)}</td><td class="num">${esc(money(tailValue))}</td><td class="via">дрібні рядки нижче топ-30</td></tr>` : ""}
          </tbody>
        </table>
      </section>
    </div>
    <section class="card">
      <h2 class="section-title">Динаміка вартості <span class="note" id="chart-note"></span></h2>
      <canvas id="chart" width="1000" height="320"></canvas>
    </section>`;
  document.querySelector("#include-cash").addEventListener("click", () => {
    state.includeCash = !state.includeCash;
    render();
  });
  draw(state.includeCash ? report.history : report.investedHistory);
}

function draw(points) {
  const canvas = document.querySelector("#chart");
  const note = document.querySelector("#chart-note");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const rows = points || [];
  if (note) {
    note.textContent = rows.length
      ? `${rows.length} точок · ${pointLabel(rows[0].t)} — ${pointLabel(rows[rows.length - 1].t)}`
      : "ще немає точок";
  }
  if (!rows.length) {
    ctx.fillStyle = "#848E9C";
    ctx.font = "16px sans-serif";
    ctx.fillText("Ще немає жодної оцінки", 80, 48);
    return;
  }
  const values = rows.map((point) => inCurrency(point.usd));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const left = 88;
  const right = 16;
  const top = 16;
  const bottom = 36;
  const x = (index) => left + (rows.length === 1 ? 0.5 : index / (rows.length - 1)) * (width - left - right);
  const y = (value) => top + (1 - (value - min) / span) * (height - top - bottom);

  ctx.strokeStyle = "#2B3139";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, height - bottom);
  ctx.lineTo(width - right, height - bottom);
  ctx.stroke();

  ctx.fillStyle = "#848E9C";
  ctx.font = "13px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(moneyFmt.format(max), left - 8, y(max) + 4);
  if (max !== min) {
    const mid = min + span / 2;
    ctx.fillText(moneyFmt.format(mid), left - 8, y(mid) + 4);
    ctx.fillText(moneyFmt.format(min), left - 8, y(min) + 4);
  }

  ctx.textAlign = "center";
  const marks = rows.length === 1 ? [0] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
  [...new Set(marks)].forEach((index) => {
    ctx.fillText(pointLabel(rows[index].t), x(index), height - 12);
  });

  ctx.strokeStyle = "#FCD535";
  ctx.lineWidth = 2;
  ctx.beginPath();
  rows.forEach((point, index) => {
    const px = x(index);
    const py = y(inCurrency(point.usd));
    if (index === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  rows.forEach((point, index) => {
    ctx.fillStyle = "#FCD535";
    ctx.beginPath();
    ctx.arc(x(index), y(inCurrency(point.usd)), 3, 0, Math.PI * 2);
    ctx.fill();
  });
}

function paintCurrency() {
  for (const button of document.querySelectorAll("#ccy-toggle button")) {
    button.classList.toggle("active", button.dataset.ccy === state.currency);
  }
}

document.querySelector("#ccy-toggle").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-ccy]");
  if (!button) return;
  state.currency = button.dataset.ccy;
  paintCurrency();
  if (state.report) render();
});

async function main() {
  const response = await fetch("portfolio.json", { cache: "no-store" });
  state.report = await response.json();
  render();
  const tickers = tickersToResolve(holdingsPositions());
  const loaded = await loadResolutions(tickers);
  state.resolutions = loaded.resolutions;
  render();
}

main().catch((error) => {
  document.querySelector("#updated").textContent = error.message;
});
