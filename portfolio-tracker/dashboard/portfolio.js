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
  chart: { grain: "hour", range: "all", start: 0, end: 0 },
  returnSpan: "day",
};

const RETURN_SPANS = {
  day: { field: "dayChangePct", label: "день", missing: "денної зміни", scale: 3 },
  month: { field: "monthChangePct", label: "місяць", missing: "місячної зміни", scale: 8, note: "Зміна ціни за останні 30 днів." },
  year: { field: "yearChangePct", label: "рік", missing: "річної зміни", scale: 20, note: "Зміна ціни за останні 365 днів." },
  all: { field: "allChangePct", label: "весь час", missing: "зміни від купівлі", scale: 40, note: "Від середньої ціни купівлі." },
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

function countLabel(count, grain) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  const form = (one, few, many) => (mod100 >= 11 && mod100 <= 14 ? many : mod10 === 1 ? one : mod10 >= 2 && mod10 <= 4 ? few : many);
  if (grain === "month") return form("місяць", "місяці", "місяців");
  if (grain === "day") return form("день", "дні", "днів");
  return form("година", "години", "годин");
}

function pointLabel(bucket, grain = state.chart.grain) {
  if (!bucket) return "";
  const [date, hour] = String(bucket).split("T");
  const [year, month, day] = (date || "").split("-");
  if (grain === "month") return `${month}.${year}`;
  if (grain === "day") return `${day}.${month}.${year}`;
  return `${day}.${month} ${hour || "00"}:00`;
}

function mixColor(from, to, amount) {
  const parse = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const start = parse(from);
  const end = parse(to);
  return `#${start.map((channel, index) => Math.round(channel + (end[index] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function tileColor(pct, scale = 3) {
  if (pct == null || !Number.isFinite(pct)) return "#3a4150";
  if (pct >= 0) return mixColor("#146b3a", "#22c55e", Math.min(pct / scale, 1));
  return mixColor("#5c6575", "#e11d48", Math.min(Math.abs(pct) / scale, 1));
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
    monthChangePct: item.monthChangePct,
    yearChangePct: item.yearChangePct,
    allChangePct: item.allChangePct,
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
  const span = RETURN_SPANS[state.returnSpan] || RETURN_SPANS.day;
  const day = dayReturn(analysisPositions(), span.field);
  const maxCompany = analysis.companies[0]?.pct || 1;
  const shown = analysis.companies.slice(0, 30);
  const tail = analysis.companies.slice(30);
  const tailValue = tail.reduce((sum, row) => sum + row.value, 0);
  const cashNative = (report.cash || []).map((item) => `${moneyFmt.format(item.amount)} ${item.currency}`).join(" + ");
  const rects = layoutTreemap(day.tiles, 1000, 280);
  const tiles = rects.map((rect) => {
    const compact = rect.w < 140 || rect.h < 78;
    return `<div class="tile" style="left:${(rect.x / 1000) * 100}%;top:${(rect.y / 280) * 100}%;width:${(rect.w / 1000) * 100}%;height:${(rect.h / 280) * 100}%;background:${tileColor(rect.pct, span.scale)}"><strong>${esc(rect.ticker)}</strong>${compact ? "" : `<span>${formatSignedPct(rect.pct)}</span>`}</div>`;
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
        <div class="kpi-label">Дохідність за ${span.label}</div>
        <div class="ccy-toggle" id="return-span">
          <button type="button" data-span="day">День</button>
          <button type="button" data-span="month">Місяць</button>
          <button type="button" data-span="year">Рік</button>
          <button type="button" data-span="all">Весь час</button>
        </div>
        <div class="day-change ${dayClass}">${day.dayPct == null ? `немає ${span.missing}` : `${formatSignedPct(day.dayPct)}${dayMoney ? ` · ${esc(dayMoney)}` : ""}`}</div>
      </div>
      ${tiles ? `<div class="treemap">${tiles}</div>` : `<p class="note">Карта з'явиться після першої оцінки цін.</p>`}
      ${span.note ? `<p class="note">${span.note}</p>` : ""}
      ${day.missing.length ? `<p class="note">Без ${span.missing}: ${esc(day.missing.join(", "))}. Наступне годинне оновлення цін її додасть.</p>` : ""}
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
      <div class="chart-toolbar">
        <h2>Динаміка вартості</h2>
        <div class="ccy-toggle" id="grain">
          <button type="button" data-grain="hour">Години</button>
          <button type="button" data-grain="day">Дні</button>
          <button type="button" data-grain="month">Місяці</button>
        </div>
        <div class="ccy-toggle" id="range">
          <button type="button" data-range="1d">1Д</button>
          <button type="button" data-range="7d">7Д</button>
          <button type="button" data-range="1m">1М</button>
          <button type="button" data-range="all">Усе</button>
        </div>
      </div>
      <div class="chart-wrap">
        <canvas id="chart"></canvas>
        <div id="chart-tip" class="chart-tip" hidden></div>
      </div>
      <p class="note" id="chart-note"></p>
    </section>`;
  document.querySelector("#include-cash").addEventListener("click", () => {
    state.includeCash = !state.includeCash;
    render();
  });
  document.querySelector("#return-span").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-span]");
    if (!button || button.dataset.span === state.returnSpan) return;
    state.returnSpan = button.dataset.span;
    render();
  });
  for (const button of document.querySelectorAll("#return-span button")) {
    button.classList.toggle("active", button.dataset.span === state.returnSpan);
  }
  bindChart();
}

function bucketTime(bucket) {
  const [date, hour = "00"] = String(bucket || "").split("T");
  const parsed = new Date(`${date}T${hour.padStart(2, "0")}:00:00`);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

function aggregate(points, grain) {
  if (grain === "hour") return points;
  const grouped = new Map();
  for (const point of points) {
    const key = grain === "month" ? point.t.slice(0, 7) : point.t.slice(0, 10);
    grouped.set(key, point);
  }
  return [...grouped.values()];
}

function applyRange(points, range) {
  if (!points.length) return { start: 0, end: 0 };
  if (range === "all" || points.length < 2) return { start: 0, end: points.length - 1 };
  const last = bucketTime(points[points.length - 1].t);
  const span = range === "1d" ? 86400000 : range === "7d" ? 7 * 86400000 : 30 * 86400000;
  const cutoff = last - span;
  let start = 0;
  for (let index = 0; index < points.length; index += 1) {
    if (bucketTime(points[index].t) >= cutoff) {
      start = index;
      break;
    }
  }
  return { start, end: points.length - 1 };
}

function clampView(count) {
  const view = state.chart;
  const last = Math.max(0, count - 1);
  if (view.end <= view.start) {
    const next = applyRange(state.chart.rows || [], view.range);
    view.start = next.start;
    view.end = next.end;
  }
  const minSpan = count <= 2 ? last : Math.min(4, last);
  if (view.end - view.start < minSpan) view.end = Math.min(last, view.start + minSpan);
  if (view.start < 0) {
    view.end -= view.start;
    view.start = 0;
  }
  if (view.end > last) {
    view.start = Math.max(0, view.start - (view.end - last));
    view.end = last;
  }
}

function refreshSeries() {
  const source = aggregate(
    state.includeCash ? state.report.history || [] : state.report.investedHistory || [],
    state.chart.grain,
  );
  state.chart.rows = source;
  if (!state.chart.ready || state.chart.end > source.length - 1) {
    const next = applyRange(source, state.chart.range);
    state.chart.start = next.start;
    state.chart.end = next.end;
    state.chart.ready = true;
  }
  clampView(source.length);
  paintChartToggles();
  drawChart();
}

function bindChart() {
  const canvas = document.querySelector("#chart");
  const tip = document.querySelector("#chart-tip");
  if (!canvas) return;
  refreshSeries();

  document.querySelector("#grain").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-grain]");
    if (!button || button.dataset.grain === state.chart.grain) return;
    state.chart.grain = button.dataset.grain;
    state.chart.ready = false;
    state.chart.hover = null;
    tip.hidden = true;
    refreshSeries();
  });
  document.querySelector("#range").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-range]");
    if (!button) return;
    state.chart.range = button.dataset.range;
    state.chart.ready = false;
    state.chart.hover = null;
    tip.hidden = true;
    refreshSeries();
  });

  const zoomAt = (fraction, factor) => {
    const view = state.chart;
    const full = Math.max(1, (view.rows || []).length - 1);
    const span = Math.max(view.end - view.start, 0.001);
    const next = Math.min(full, Math.max(Math.min(4, full), span / factor));
    const focus = view.start + span * fraction;
    view.start = focus - next * fraction;
    view.end = view.start + next;
    view.range = "custom";
    clampView(view.rows.length);
    paintChartToggles();
    drawChart();
  };
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    zoomAt(fraction, event.deltaY > 0 ? 0.85 : 1.18);
  }, { passive: false });

  let drag = null;
  canvas.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, start: state.chart.start, end: state.chart.end };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const rect = canvas.getBoundingClientRect();
    if (drag && Math.abs(event.clientX - drag.x) > 3) {
      const span = drag.end - drag.start;
      const shift = ((drag.x - event.clientX) / rect.width) * span;
      state.chart.start = drag.start + shift;
      state.chart.end = drag.end + shift;
      state.chart.range = "custom";
      clampView(state.chart.rows.length);
      paintChartToggles();
    }
    showTip(event.clientX - rect.left, event.clientY - rect.top);
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  canvas.addEventListener("pointerleave", () => {
    drag = null;
    state.chart.hover = null;
    tip.hidden = true;
    drawChart();
  });
  canvas.addEventListener("dblclick", () => {
    state.chart.range = "all";
    state.chart.ready = false;
    refreshSeries();
  });
}

function paintChartToggles() {
  for (const button of document.querySelectorAll("#grain button")) {
    button.classList.toggle("active", button.dataset.grain === state.chart.grain);
  }
  for (const button of document.querySelectorAll("#range button")) {
    button.classList.toggle("active", button.dataset.range === state.chart.range);
  }
}

function chartLayout() {
  const canvas = document.querySelector("#chart");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 1000;
  const height = 360;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height, left: 72, right: 16, top: 18, bottom: 42 };
}

function drawChart() {
  const canvas = document.querySelector("#chart");
  const note = document.querySelector("#chart-note");
  const rows = state.chart.rows || [];
  if (!canvas) return;
  const { ctx, width, height, left, right, top, bottom } = chartLayout();
  ctx.clearRect(0, 0, width, height);
  if (note) {
    const from = rows[Math.max(0, Math.round(state.chart.start))] || rows[0];
    const to = rows[Math.min(rows.length - 1, Math.round(state.chart.end))] || rows[0];
    note.textContent = rows.length
      ? `${pointLabel(from?.t)} — ${pointLabel(to?.t)} · ${rows.length} ${countLabel(rows.length, state.chart.grain)}. Колесо звужує, перетягування рухає, подвійне клацання показує весь період.`
      : "Ще немає точок.";
  }
  if (!rows.length) {
    ctx.fillStyle = "#848E9C";
    ctx.font = "15px sans-serif";
    ctx.fillText("Ще немає оцінок", left, 48);
    return;
  }
  const start = state.chart.start;
  const end = state.chart.end;
  const visible = [];
  for (let index = Math.floor(start); index <= Math.ceil(end); index += 1) {
    if (rows[index]) visible.push({ ...rows[index], index });
  }
  if (visible.length < 2 || end <= start) {
    const point = visible[0] || rows[0];
    const value = inCurrency(point.usd);
    ctx.fillStyle = "#FCD535";
    ctx.beginPath();
    ctx.arc(left + 8, height / 2, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.textAlign = "left";
    ctx.fillStyle = "#EAECEF";
    ctx.font = "14px sans-serif";
    ctx.fillText(`${moneyFmt.format(value)} ${state.currency}`, left + 22, height / 2 - 2);
    ctx.fillStyle = "#848E9C";
    ctx.font = "12px sans-serif";
    ctx.fillText(pointLabel(point.t), left + 22, height / 2 + 16);
    return;
  }
  const values = visible.map((point) => inCurrency(point.usd));
  let min = Math.min(...values);
  let max = Math.max(...values);
  const pad = (max - min) * 0.12 || Math.max(max * 0.01, 1);
  min -= pad;
  max += pad;
  const span = max - min || 1;
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const xOf = (index) => left + ((index - start) / (end - start)) * plotW;
  const yOf = (value) => top + (1 - (value - min) / span) * plotH;

  ctx.strokeStyle = "#2B3139";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#848E9C";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  for (const value of [max, min + span / 2, min]) {
    const y = yOf(value);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(width - right, y);
    ctx.stroke();
    ctx.fillText(moneyFmt.format(value), left - 8, y + 4);
  }

  const labelCount = Math.max(2, Math.min(5, visible.length));
  for (let step = 0; step < labelCount; step += 1) {
    const index = Math.round(start + (end - start) * (step / (labelCount - 1)));
    const point = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!point) continue;
    const edge = step === 0 ? "left" : step === labelCount - 1 ? "right" : "center";
    ctx.textAlign = edge;
    const labelX = step === 0 ? left : step === labelCount - 1 ? width - right : xOf(index);
    ctx.fillText(pointLabel(point.t), labelX, height - 16);
  }

  const coords = visible.map((point) => [xOf(point.index), yOf(inCurrency(point.usd))]);
  const floor = yOf(min);
  ctx.beginPath();
  coords.forEach(([px, py], order) => (order === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.lineTo(coords[coords.length - 1][0], floor);
  ctx.lineTo(coords[0][0], floor);
  ctx.closePath();
  ctx.fillStyle = "rgba(252, 213, 53, 0.10)";
  ctx.fill();
  ctx.beginPath();
  ctx.strokeStyle = "#FCD535";
  ctx.lineWidth = 2;
  coords.forEach(([px, py], order) => (order === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
  ctx.stroke();

  const hover = state.chart.hover;
  if (hover == null || !rows[hover]) return;
  const hx = xOf(hover);
  const hy = yOf(inCurrency(rows[hover].usd));
  ctx.strokeStyle = "#848E9C";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(hx, top);
  ctx.lineTo(hx, height - bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#FCD535";
  ctx.beginPath();
  ctx.arc(hx, hy, 4.5, 0, Math.PI * 2);
  ctx.fill();
}

function showTip(localX, localY) {
  const tip = document.querySelector("#chart-tip");
  const canvas = document.querySelector("#chart");
  const rows = state.chart.rows || [];
  const width = canvas.clientWidth || 1000;
  const left = 72;
  const right = 16;
  const start = state.chart.start;
  const end = state.chart.end;
  const plotW = width - left - right;
  if (!rows.length || end <= start || localX < left || localX > width - right) {
    if (state.chart.hover != null) {
      state.chart.hover = null;
      tip.hidden = true;
      drawChart();
    }
    return;
  }
  const fraction = (localX - left) / plotW;
  const index = Math.round(start + fraction * (end - start));
  const safe = Math.min(rows.length - 1, Math.max(0, index));
  const point = rows[safe];
  const previous = safe > 0 ? rows[safe - 1] : null;
  state.chart.hover = safe;
  const delta = previous ? inCurrency(point.usd) - inCurrency(previous.usd) : null;
  const pct = delta != null && inCurrency(previous.usd) ? (delta / inCurrency(previous.usd)) * 100 : null;
  const moved = delta != null && Math.abs(delta) >= 0.5;
  tip.hidden = false;
  tip.innerHTML = `<strong>${esc(money(point.usd))}</strong>${esc(pointLabel(point.t))}${moved ? `<div class="${delta >= 0 ? "up" : "down"}">${delta >= 0 ? "+" : ""}${moneyFmt.format(delta)} ${state.currency}${pct == null ? "" : ` · ${formatSignedPct(pct)}`}</div>` : ""}`;
  tip.style.left = `${Math.min(width - 176, Math.max(8, localX + 14))}px`;
  tip.style.top = `${Math.max(8, localY - 28)}px`;
  drawChart();
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
