/**
 * Dashboard script для відображення графіка 5-хвилинок, аналізу по годинах доби,
 * відправки зведень у Telegram та живого автозапису в локальний файл проекту (bin/p2p-history.json).
 */

const inpMinLimit = document.getElementById('inp-min-limit');
const selPollInterval = document.getElementById('sel-poll-interval');
const selRange = document.getElementById('sel-range');
const selReportHour = document.getElementById('sel-report-hour');
const inpTgToken = document.getElementById('inp-tg-token');
const inpTgChat = document.getElementById('inp-tg-chat');
const btnRefresh = document.getElementById('btn-refresh');
const btnExport = document.getElementById('btn-export');
const btnClear = document.getElementById('btn-clear');
const btnLinkFile = document.getElementById('btn-link-file');
const btnTgReport = document.getElementById('btn-tg-report');
const fileSyncStatus = document.getElementById('file-sync-status');
const selOverlayMode = document.getElementById('sel-overlay-mode');
const selOverlayStep = document.getElementById('sel-overlay-step');
const chkFilterOutliers = document.getElementById('chk-filter-outliers');
const inpRemoteUrl = document.getElementById('inp-remote-url');
const haSyncStatus = document.getElementById('ha-sync-status');

let cachedHistory = [];
let fullHistory = [];
let linkedFileHandle = null;
const hiddenOverlayDays = new Set();

function getMedian(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Очищення історичних даних від одноразових помилкових/фейкових ордерів (напр. 44.00 грн при ринку 46.40 грн)
function getEffectiveHistory(rawList) {
  if (!rawList || rawList.length === 0) return [];
  const filterEnabled = chkFilterOutliers ? chkFilterOutliers.checked : true;
  if (!filterEnabled) return rawList;

  return rawList.map((item, idx) => {
    // 1. Якщо в одному 5-хвилинному слоті є top5Avg і minPrice відірвався від нього більш ніж на 0.55 грн:
    // значить це був поодинокий ордер з помилковою ціною, а реальний стакан стояв на рівні top5Avg.
    let price = item.minPrice;
    if (item.top5Avg && item.top5Avg - price > 0.55) {
      // Відновлюємо об'єктивну ціну найкращого ринкового ордера з top5Avg
      price = Number((item.top5Avg - 0.12).toFixed(2));
    }

    // 2. Додаткова перевірка відносно сусідніх 5-хвилинок (±6 точок навколо):
    const start = Math.max(0, idx - 6);
    const end = Math.min(rawList.length - 1, idx + 6);
    const windowPrices = [];
    for (let j = start; j <= end; j++) {
      if (j === idx) continue;
      const p = rawList[j].top5Avg && rawList[j].top5Avg - rawList[j].minPrice > 0.55
        ? rawList[j].top5Avg - 0.12
        : rawList[j].minPrice;
      windowPrices.push(p);
    }

    if (windowPrices.length >= 3) {
      const localMedian = getMedian(windowPrices);
      // Якщо точка провалюється більше ніж на 0.50 грн нижче сусідніх замірів — згладжуємо її до локальної медіани
      if (localMedian - price > 0.50) {
        price = Number(localMedian.toFixed(2));
      }
    }

    if (price !== item.minPrice) {
      return {
        ...item,
        rawMinPrice: item.minPrice,
        minPrice: price,
        isOutlierFiltered: true,
      };
    }
    return item;
  });
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Запис повної історії у вибраний локальний файл проекту (напр. /Users/igor/Desktop/Homeworks/bin/p2p-history.json)
async function syncHistoryToFile(historyData) {
  if (!linkedFileHandle) return;
  try {
    const writable = await linkedFileHandle.createWritable();
    const payload = {
      updatedAt: new Date().toISOString(),
      totalBuckets: historyData.length,
      records: historyData,
    };
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
    fileSyncStatus.innerHTML = `<span style="color:#0ECB81;">✅ Автозапис активний: <b>${linkedFileHandle.name}</b> (оновлено о ${new Date().toLocaleTimeString()})</span>`;
  } catch (err) {
    console.error('[P2P Tracker] Помилка запису у файл:', err);
    fileSyncStatus.innerHTML = `<span style="color:#F6465D;">⚠️ Помилка запису у файл: ${err.message}</span>`;
  }
}

async function loadAndRender() {
  const data = await chrome.storage.local.get([
    'trackerSettings',
    'rateHistory',
    'lastSample',
    'lastRemoteSyncAt',
    'lastRemoteError',
  ]);
  const settings = data.trackerSettings || {
    minOrderLimitUAH: 500,
    dailyReportHour: 21,
    pollIntervalSec: 30,
    remoteUrl: 'https://ha.ibtek.uk/local/p2p-history.json',
  };
  if (inpMinLimit) inpMinLimit.value = settings.minOrderLimitUAH || 500;
  if (selPollInterval) {
    selPollInterval.value = String(settings.pollIntervalSec || 30);
  }
  if (inpRemoteUrl && document.activeElement !== inpRemoteUrl) {
    inpRemoteUrl.value = settings.remoteUrl || 'https://ha.ibtek.uk/local/p2p-history.json';
  }
  if (haSyncStatus) {
    if (data.lastRemoteError) {
      haSyncStatus.style.color = '#F6465D';
      haSyncStatus.textContent = `⚠️ Помилка HA: ${data.lastRemoteError}`;
    } else if (data.lastRemoteSyncAt) {
      haSyncStatus.style.color = '#0ECB81';
      haSyncStatus.textContent = `✅ Синхронізовано з HA о ${new Date(data.lastRemoteSyncAt).toLocaleTimeString('uk-UA')}`;
    }
  }
  if (typeof settings.dailyReportHour === 'number') {
    selReportHour.value = String(settings.dailyReportHour);
  }
  if (inpTgToken && document.activeElement !== inpTgToken) {
    inpTgToken.value = settings.telegram?.botToken || '';
  }
  if (inpTgChat && document.activeElement !== inpTgChat) {
    inpTgChat.value = settings.telegram?.chatId || '';
  }

  const rawAllHistory = Array.isArray(data.rateHistory) ? data.rateHistory : [];
  fullHistory = getEffectiveHistory(rawAllHistory);
  const hoursBack = parseInt(selRange.value, 10) || 24;
  const cutoff = Date.now() - hoursBack * 3600 * 1000;

  cachedHistory = fullHistory.filter((item) => item.bucketTs >= cutoff);

  renderKPIs(cachedHistory, data.lastSample);
  renderChart(cachedHistory);
  renderDailyOverlayChart(fullHistory);
  renderHourlyHeatmap(cachedHistory);
  renderTable(cachedHistory);

  if (linkedFileHandle) {
    syncHistoryToFile(rawAllHistory);
  }
}

function renderKPIs(history, lastSample) {
  const curEl = document.getElementById('kpi-current');
  const curSub = document.getElementById('kpi-current-sub');
  const minEl = document.getElementById('kpi-min');
  const minSub = document.getElementById('kpi-min-sub');
  const maxEl = document.getElementById('kpi-max');
  const maxSub = document.getElementById('kpi-max-sub');

  if (lastSample && lastSample.best) {
    curEl.textContent = `${lastSample.best.price.toFixed(2)} ₴`;
    curSub.textContent = `${lastSample.best.merchant} (${lastSample.best.minLimit}-${lastSample.best.maxLimit} грн) о ${new Date(lastSample.ts).toLocaleTimeString()}`;
  } else if (history.length > 0) {
    const last = history[history.length - 1];
    curEl.textContent = `${last.minPrice.toFixed(2)} ₴`;
    curSub.textContent = `Останній замір: ${formatTime(last.bucketTs)}`;
  }

  if (history.length === 0) {
    minEl.textContent = '—';
    minSub.textContent = 'Немає даних';
    maxEl.textContent = '—';
    maxSub.textContent = 'Немає даних';
    return;
  }

  let minItem = history[0];
  let maxItem = history[0];

  for (const h of history) {
    if (h.minPrice < minItem.minPrice) minItem = h;
    if (h.minPrice > maxItem.minPrice) maxItem = h;
  }

  minEl.textContent = `${minItem.minPrice.toFixed(2)} ₴`;
  minSub.textContent = `${formatTime(minItem.bucketTs)} (${minItem.merchant})`;

  maxEl.textContent = `${maxItem.minPrice.toFixed(2)} ₴`;
  maxSub.textContent = `${formatTime(maxItem.bucketTs)} (${maxItem.merchant})`;
}

function renderHourlyHeatmap(history) {
  const grid = document.getElementById('hourly-grid');
  const bestHourEl = document.getElementById('kpi-best-hour');
  const bestHourSub = document.getElementById('kpi-best-hour-sub');
  grid.innerHTML = '';

  const byHour = Array.from({ length: 24 }, () => []);
  for (const h of history) {
    const hour = new Date(h.bucketTs).getHours();
    byHour[hour].push(h.minPrice);
  }

  const hourStats = byHour.map((prices, hour) => {
    if (prices.length === 0) return { hour, avg: null, min: null, count: 0 };
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const min = Math.min(...prices);
    return { hour, avg, min, count: prices.length };
  });

  const validStats = hourStats.filter((s) => s.avg !== null);
  const sortedAsc = [...validStats].sort((a, b) => a.avg - b.avg || a.min - b.min);
  const sortedDesc = [...validStats].sort((a, b) => b.avg - a.avg || b.min - a.min);

  const bestHourObj = sortedAsc[0] || null;

  // ТОП-3 найкращі (найдешевші) години та ТОП-3 найгірші (найдорожчі) години
  const bestRanks = new Map();
  const worstRanks = new Map();

  sortedAsc.slice(0, Math.min(3, sortedAsc.length)).forEach((s, idx) => {
    bestRanks.set(s.hour, idx); // 0 = 1-ше місце, 1 = 2-ге місце, 2 = 3-тє місце
  });

  sortedDesc.slice(0, Math.min(3, sortedDesc.length)).forEach((s, idx) => {
    // Не фарбуємо в червоний, якщо всього мало годин і вона вже в зеленому ТОП-3
    if (!bestRanks.has(s.hour)) {
      worstRanks.set(s.hour, idx); // 0 = найдорожча, 1 = 2-га найдорожча, 2 = 3-тя найдорожча
    }
  });

  // Відтінки для 1-го, 2-го та 3-го місця (від найяскравішого до м'якшого)
  const GREEN_STYLES = [
    { text: '#0ECB81', border: '#0ECB81', bg: 'rgba(14, 203, 129, 0.18)', badge: '🥇 #1' },
    { text: '#34D399', border: 'rgba(52, 211, 153, 0.65)', bg: 'rgba(14, 203, 129, 0.10)', badge: '🥈 #2' },
    { text: '#6EE7B7', border: 'rgba(110, 231, 183, 0.45)', bg: 'rgba(14, 203, 129, 0.05)', badge: '🥉 #3' },
  ];

  const RED_STYLES = [
    { text: '#F6465D', border: '#F6465D', bg: 'rgba(246, 70, 93, 0.18)', badge: '🔺 #1' },
    { text: '#FB7185', border: 'rgba(251, 113, 133, 0.65)', bg: 'rgba(246, 70, 93, 0.10)', badge: '🔺 #2' },
    { text: '#FDA4AF', border: 'rgba(253, 164, 175, 0.45)', bg: 'rgba(246, 70, 93, 0.05)', badge: '🔺 #3' },
  ];

  if (bestHourObj) {
    const top3Str = sortedAsc
      .slice(0, 3)
      .map((s) => `${String(s.hour).padStart(2, '0')}:00`)
      .join(', ');
    bestHourEl.textContent = top3Str;
    bestHourSub.textContent = `#1: ${String(bestHourObj.hour).padStart(2, '0')}:00 (${bestHourObj.avg.toFixed(2)} ₴, мін ${bestHourObj.min.toFixed(2)} ₴)`;
  } else {
    bestHourEl.textContent = '—';
    bestHourSub.textContent = 'Недостатньо даних';
  }

  for (const s of hourStats) {
    const box = document.createElement('div');
    box.className = 'hour-box';
    const label = `${String(s.hour).padStart(2, '0')}:00`;

    if (s.avg === null) {
      box.innerHTML = `<div class="h-time">${label}</div><div class="h-price" style="color:#474D57;">—</div>`;
    } else {
      let priceColor = '#EAECEF';
      let rankTag = '';

      if (bestRanks.has(s.hour)) {
        const rank = bestRanks.get(s.hour);
        const st = GREEN_STYLES[rank];
        priceColor = st.text;
        box.style.borderColor = st.border;
        box.style.background = st.bg;
        rankTag = `<span style="color:${st.text};font-weight:bold;margin-left:3px;">${st.badge}</span>`;
      } else if (worstRanks.has(s.hour)) {
        const rank = worstRanks.get(s.hour);
        const st = RED_STYLES[rank];
        priceColor = st.text;
        box.style.borderColor = st.border;
        box.style.background = st.bg;
        rankTag = `<span style="color:${st.text};font-weight:bold;margin-left:3px;">${st.badge}</span>`;
      }

      box.innerHTML = `
        <div class="h-time">${label} (${s.count})${rankTag}</div>
        <div class="h-price" style="color:${priceColor};">${s.avg.toFixed(2)} ₴</div>
        <div style="font-size:10px;color:#848E9C;">мін ${s.min.toFixed(2)}</div>
      `;
    }
    grid.appendChild(box);
  }
}

function renderChart(history) {
  const canvas = document.getElementById('priceChart');
  const countEl = document.getElementById('chart-count');
  countEl.textContent = `${history.length} замірів (по 5 хв)`;

  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (history.length === 0) {
    ctx.fillStyle = '#848E9C';
    ctx.font = '14px monospace';
    ctx.fillText('Очікуємо перших замірів курсу...', W / 2 - 120, H / 2);
    return;
  }

  const prices = history.map((h) => h.minPrice);
  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);
  if (minP === maxP) {
    minP -= 0.2;
    maxP += 0.2;
  } else {
    const pad = (maxP - minP) * 0.1;
    minP -= pad;
    maxP += pad;
  }

  const padL = 55;
  const padR = 20;
  const padT = 20;
  const padB = 35;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  ctx.strokeStyle = '#2B3139';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#848E9C';
  ctx.font = '11px monospace';

  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = padT + (plotH * i) / steps;
    const val = maxP - ((maxP - minP) * i) / steps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    ctx.fillText(val.toFixed(2), 8, y + 4);
  }

  ctx.strokeStyle = '#FCD535';
  ctx.lineWidth = 2;
  ctx.beginPath();

  history.forEach((h, idx) => {
    const x =
      history.length === 1
        ? padL + plotW / 2
        : padL + (plotW * idx) / (history.length - 1);
    const y = padT + plotH - ((h.minPrice - minP) / (maxP - minP)) * plotH;
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const labelStep = Math.max(1, Math.floor(history.length / 6));
  history.forEach((h, idx) => {
    const x =
      history.length === 1
        ? padL + plotW / 2
        : padL + (plotW * idx) / (history.length - 1);
    const y = padT + plotH - ((h.minPrice - minP) / (maxP - minP)) * plotH;

    ctx.fillStyle = '#0ECB81';
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();

    if (idx % labelStep === 0 || idx === history.length - 1) {
      const tStr = new Date(h.bucketTs).toLocaleTimeString('uk-UA', {
        hour: '2-digit',
        minute: '2-digit',
      });
      ctx.fillStyle = '#848E9C';
      ctx.fillText(tStr, x - 16, H - 10);
    }
  });
}

// Графік накладання днів (00:00 – 24:00) для порівняння добових патернів і кореляції по годинах
const DAY_PALETTE = [
  '#0ECB81', // Зелений (найновіший день / сьогодні)
  '#FCD535', // Жовтий (вчора)
  '#3B82F6', // Синій
  '#A855F7', // Фіолетовий
  '#F97316', // Помаранчевий
  '#EC4899', // Рожевий
  '#14B8A6', // Бірюзовий
  '#EF4444', // Червоний
];

function getLocalDayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatDayLabel(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const dateObj = new Date(y, m - 1, d);
  const weekday = dateObj.toLocaleDateString('uk-UA', { weekday: 'short' });
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')} (${weekday})`;
}

function renderDailyOverlayChart(allHistory) {
  const canvas = document.getElementById('dailyOverlayChart');
  const legendEl = document.getElementById('overlay-legend');
  if (!canvas || !legendEl) return;

  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!allHistory || allHistory.length === 0) {
    legendEl.innerHTML = '';
    ctx.fillStyle = '#848E9C';
    ctx.font = '14px monospace';
    ctx.fillText('Недостатньо даних для накладання днів...', W / 2 - 140, H / 2);
    return;
  }

  const mode = selOverlayMode ? selOverlayMode.value : 'raw'; // 'raw' | 'delta'
  const stepMin = selOverlayStep ? parseInt(selOverlayStep.value, 10) || 15 : 15; // 5 | 15 | 60
  const slotsPerDay = Math.floor(1440 / stepMin);

  // Групуємо всі записи за локальною датою YYYY-MM-DD
  const daysMap = new Map();
  for (const item of allHistory) {
    const key = getLocalDayKey(item.bucketTs);
    if (!daysMap.has(key)) {
      daysMap.set(key, []);
    }
    daysMap.get(key).push(item);
  }

  // Беремо останні 8 днів
  const sortedDayKeys = Array.from(daysMap.keys()).sort().slice(-8);

  const daySeriesList = sortedDayKeys.map((dayKey, idx) => {
    const records = daysMap.get(dayKey);
    const dayAvg = records.reduce((s, r) => s + r.minPrice, 0) / records.length;
    const slots = Array.from({ length: slotsPerDay }, () => []);

    for (const r of records) {
      const d = new Date(r.bucketTs);
      const minuteOfDay = d.getHours() * 60 + d.getMinutes();
      const slotIdx = Math.min(slotsPerDay - 1, Math.floor(minuteOfDay / stepMin));
      const val = mode === 'delta' ? r.minPrice - dayAvg : r.minPrice;
      slots[slotIdx].push(val);
    }

    const points = slots.map((vals, slotIdx) => {
      if (vals.length === 0) return null;
      // Використовуємо медіану слота (замість Math.min), щоб при погодинній або 15-хвилинній агрегації
      // графік показував реальний стійкий курс цієї години, а не випадковий секундний простріл!
      const representativeVal = vals.length >= 3 ? getMedian(vals) : Math.min(...vals);
      return {
        slotIdx,
        minuteOfDay: slotIdx * stepMin,
        value: representativeVal,
      };
    });

    const colorIdx = (sortedDayKeys.length - 1 - idx) % DAY_PALETTE.length;
    return {
      dayKey,
      label: formatDayLabel(dayKey),
      color: DAY_PALETTE[colorIdx],
      dayAvg,
      count: records.length,
      points,
      isLatest: idx === sortedDayKeys.length - 1,
    };
  });

  // Інтерактивна легенда (клік по дню вмикає/вимикає його лінію на графіку)
  legendEl.innerHTML = '';
  for (const s of daySeriesList) {
    const isHidden = hiddenOverlayDays.has(s.dayKey);
    const chip = document.createElement('button');
    chip.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'gap:6px',
      'padding:4px 10px',
      'border-radius:99px',
      'font-size:12px',
      'cursor:pointer',
      `border:1px solid ${isHidden ? '#2B3139' : s.color}`,
      `background:${isHidden ? '#181A20' : 'rgba(255,255,255,0.04)'}`,
      `opacity:${isHidden ? '0.45' : '1'}`,
    ].join(';');
    chip.innerHTML = `
      <span style="width:10px;height:10px;border-radius:50%;background:${s.color};display:inline-block;"></span>
      <b>${s.label}</b>
      <span style="color:#848E9C;font-size:11px;">(сер. ${s.dayAvg.toFixed(2)}₴, ${s.count} т.)</span>
    `;
    chip.onclick = () => {
      if (hiddenOverlayDays.has(s.dayKey)) {
        hiddenOverlayDays.delete(s.dayKey);
      } else {
        hiddenOverlayDays.add(s.dayKey);
      }
      renderDailyOverlayChart(allHistory);
    };
    legendEl.appendChild(chip);
  }

  const avgLegend = document.createElement('span');
  avgLegend.style.cssText =
    'display:inline-flex;align-items:center;gap:6px;padding:4px 10px;color:#EAECEF;font-size:12px;';
  avgLegend.innerHTML = `<span style="width:18px;border-top:2px dashed #EAECEF;display:inline-block;"></span> <b>Середній профіль (усі дні)</b>`;
  legendEl.appendChild(avgLegend);

  const visibleSeries = daySeriesList.filter((s) => !hiddenOverlayDays.has(s.dayKey));

  // Середній профіль рахуємо по ВСІХ днях (daySeriesList), щоб він залишався на графіку навіть коли всі окремі дні вимкнено!
  const avgProfilePoints = [];
  for (let slotIdx = 0; slotIdx < slotsPerDay; slotIdx++) {
    const vals = [];
    for (const s of daySeriesList) {
      const pt = s.points[slotIdx];
      if (pt !== null) vals.push(pt.value);
    }
    if (vals.length > 0) {
      const avgVal = vals.reduce((a, b) => a + b, 0) / vals.length;
      avgProfilePoints.push({
        slotIdx,
        minuteOfDay: slotIdx * stepMin,
        value: avgVal,
      });
    }
  }

  const allValues = [];
  for (const s of visibleSeries) {
    for (const pt of s.points) {
      if (pt !== null) allValues.push(pt.value);
    }
  }
  for (const pt of avgProfilePoints) {
    allValues.push(pt.value);
  }

  if (allValues.length === 0) {
    ctx.fillStyle = '#848E9C';
    ctx.font = '14px monospace';
    ctx.fillText('Немає даних для побудови графіка.', W / 2 - 140, H / 2);
    return;
  }

  let minY = Math.min(...allValues);
  let maxY = Math.max(...allValues);
  if (minY === maxY) {
    minY -= 0.2;
    maxY += 0.2;
  } else {
    const pad = (maxY - minY) * 0.1;
    minY -= pad;
    maxY += pad;
  }

  const padL = 62;
  const padR = 24;
  const padT = 20;
  const padB = 36;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const xForMinute = (minOfDay) => padL + (plotW * minOfDay) / 1440;
  const yForValue = (val) => padT + plotH - ((val - minY) / (maxY - minY)) * plotH;

  ctx.strokeStyle = '#2B3139';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#848E9C';
  ctx.font = '11px monospace';

  const ySteps = 5;
  for (let i = 0; i <= ySteps; i++) {
    const y = padT + (plotH * i) / ySteps;
    const val = maxY - ((maxY - minY) * i) / ySteps;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
    const label =
      mode === 'delta' ? `${val >= 0 ? '+' : ''}${val.toFixed(2)}₴` : `${val.toFixed(2)}`;
    ctx.fillText(label, 6, y + 4);
  }

  if (mode === 'delta' && minY < 0 && maxY > 0) {
    const yZero = yForValue(0);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, yZero);
    ctx.lineTo(W - padR, yZero);
    ctx.stroke();
    ctx.restore();
  }

  for (let h = 0; h <= 24; h++) {
    const x = xForMinute(h * 60);
    ctx.strokeStyle = h % 3 === 0 ? '#2B3139' : 'rgba(43, 49, 57, 0.45)';
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + plotH);
    ctx.stroke();

    if (h % 2 === 0) {
      const hLabel = `${String(h).padStart(2, '0')}:00`;
      ctx.fillStyle = '#848E9C';
      ctx.fillText(hLabel, x - 15, H - 10);
    }
  }

  for (const s of visibleSeries) {
    const validPts = s.points.filter((p) => p !== null);
    if (validPts.length === 0) continue;

    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.isLatest ? 2.6 : 1.8;
    ctx.beginPath();

    validPts.forEach((pt, i) => {
      const x = xForMinute(pt.minuteOfDay);
      const y = yForValue(pt.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = s.color;
    for (const pt of validPts) {
      const x = xForMinute(pt.minuteOfDay);
      const y = yForValue(pt.value);
      ctx.beginPath();
      ctx.arc(x, y, s.isLatest ? 3 : 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (avgProfilePoints.length > 0) {
    ctx.save();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = visibleSeries.length === 0 ? 2.8 : 2.2;
    ctx.setLineDash(visibleSeries.length === 0 ? [] : [6, 4]);
    ctx.beginPath();
    avgProfilePoints.forEach((pt, i) => {
      const x = xForMinute(pt.minuteOfDay);
      const y = yForValue(pt.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    if (visibleSeries.length === 0) {
      ctx.fillStyle = '#FFFFFF';
      for (const pt of avgProfilePoints) {
        const x = xForMinute(pt.minuteOfDay);
        const y = yForValue(pt.value);
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

function renderTable(history) {
  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = '';

  const reversed = [...history].reverse().slice(0, 300);
  for (const row of reversed) {
    const tr = document.createElement('tr');
    const spread =
      row.maxPriceInBucket && row.maxPriceInBucket !== row.minPrice
        ? `${row.minPrice.toFixed(2)} – ${row.maxPriceInBucket.toFixed(2)}`
        : `${row.minPrice.toFixed(2)}`;

    tr.innerHTML = `
      <td>${formatTime(row.bucketTs)}</td>
      <td><span class="badge-low">${row.minPrice.toFixed(2)} ₴</span></td>
      <td>${row.top5Avg ? row.top5Avg.toFixed(2) + ' ₴' : '—'}</td>
      <td style="color:#848E9C;">${spread} ₴</td>
      <td><b>${row.merchant || '—'}</b></td>
      <td>${row.minLimit || 0} – ${row.maxLimit || 0} грн</td>
      <td style="color:#848E9C;font-size:12px;">${row.banks || '—'}</td>
      <td>${row.samples || 1}</td>
    `;
    tbody.appendChild(tr);
  }
}

// Підключення локального файлу проекту для прямого автозапису з браузера
btnLinkFile.onclick = async () => {
  try {
    if (!window.showSaveFilePicker) {
      alert('Ваш браузер не підтримує File System Access API. Використовуйте кнопку Скачати CSV.');
      return;
    }
    linkedFileHandle = await window.showSaveFilePicker({
      suggestedName: 'p2p-history.json',
      types: [
        {
          description: 'JSON History File',
          accept: { 'application/json': ['.json'] },
        },
      ],
    });
    await syncHistoryToFile(fullHistory);
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
    }
  }
};

// Миттєва відправка аналітичного звіту в Telegram
btnTgReport.onclick = () => {
  const origText = btnTgReport.textContent;
  btnTgReport.textContent = '⏳ Надсилаємо...';
  chrome.runtime.sendMessage({ type: 'SEND_TELEGRAM_REPORT_NOW' }, (res) => {
    if (res && res.ok) {
      btnTgReport.textContent = '✅ Надіслано в Telegram!';
    } else {
      btnTgReport.textContent = '❌ Помилка відправки';
    }
    setTimeout(() => {
      btnTgReport.textContent = origText;
    }, 2500);
  });
};

function saveDashboardTelegramSettings() {
  chrome.storage.local.get(['trackerSettings'], (res) => {
    const prev = res.trackerSettings || {};
    const next = {
      ...prev,
      dailyReportHour: parseInt(selReportHour.value, 10),
      telegram: {
        ...(prev.telegram || {}),
        enabled: true,
        botToken: inpTgToken.value.trim(),
        chatId: inpTgChat.value.trim(),
      },
    };
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next });
  });
}

if (inpTgToken) {
  inpTgToken.onfocus = () => { inpTgToken.type = 'text'; };
  inpTgToken.onblur = () => { inpTgToken.type = 'password'; saveDashboardTelegramSettings(); };
  inpTgToken.onchange = saveDashboardTelegramSettings;
}
if (inpTgChat) {
  inpTgChat.onchange = saveDashboardTelegramSettings;
}

selReportHour.onchange = saveDashboardTelegramSettings;

btnRefresh.onclick = () => {
  btnRefresh.textContent = '⏳ Оновлюємо...';
  chrome.runtime.sendMessage({ type: 'FORCE_SAMPLE' }, () => {
    btnRefresh.textContent = '🔄 Оновити зараз';
    loadAndRender();
  });
};

selRange.onchange = () => loadAndRender();
if (chkFilterOutliers) chkFilterOutliers.onchange = () => loadAndRender();
if (selOverlayMode) selOverlayMode.onchange = () => renderDailyOverlayChart(fullHistory);
if (selOverlayStep) selOverlayStep.onchange = () => renderDailyOverlayChart(fullHistory);

if (selPollInterval) {
  selPollInterval.onchange = () => {
    const sec = parseInt(selPollInterval.value, 10) || 15;
    chrome.storage.local.get(['trackerSettings'], (res) => {
      const next = { ...(res.trackerSettings || {}), pollIntervalSec: sec };
      chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next }, () => {
        loadAndRender();
      });
    });
  };
}

inpMinLimit.onchange = () => {
  const val = parseFloat(inpMinLimit.value) || 500;
  chrome.storage.local.get(['trackerSettings'], (res) => {
    const next = { ...(res.trackerSettings || {}), minOrderLimitUAH: val };
    chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next }, () => {
      loadAndRender();
    });
  });
};

btnExport.onclick = () => {
  if (!cachedHistory.length) return alert('Немає записів для експорту.');
  const headers = [
    'Timestamp',
    'DateTime',
    'Hour',
    'MinPrice_UAH',
    'Top5Avg_UAH',
    'MaxPriceIn5m_UAH',
    'Merchant',
    'MinLimit_UAH',
    'MaxLimit_UAH',
    'Banks',
    'Samples',
  ];
  const rows = cachedHistory.map((r) => {
    const dt = new Date(r.bucketTs);
    return [
      r.bucketTs,
      dt.toISOString(),
      dt.getHours(),
      r.minPrice,
      r.top5Avg || '',
      r.maxPriceInBucket || '',
      `"${(r.merchant || '').replace(/"/g, '""')}"`,
      r.minLimit || '',
      r.maxLimit || '',
      `"${(r.banks || '').replace(/"/g, '""')}"`,
      r.samples || 1,
    ].join(',');
  });

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `binance_p2p_usdt_uah_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

btnClear.onclick = async () => {
  if (!confirm('Очистити всю зібрану історію курсу?')) return;
  await chrome.storage.local.set({ rateHistory: [] });
  loadAndRender();
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.rateHistory || changes.lastSample)) {
    loadAndRender();
  }
});

if (inpRemoteUrl) {
  inpRemoteUrl.onchange = () => {
    const urlVal = inpRemoteUrl.value.trim();
    chrome.storage.local.get(['trackerSettings'], (res) => {
      const next = { ...(res.trackerSettings || {}), remoteUrl: urlVal };
      chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: next }, () => {
        loadAndRender();
      });
    });
  };
}

// Одразу при відкритті дашборду підтягуємо свіжу базу з Home Assistant
loadAndRender();
chrome.runtime.sendMessage({ type: 'FORCE_SAMPLE' });
