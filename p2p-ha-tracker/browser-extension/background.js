/**
 * Background Service Worker для Binance P2P Remote Tracker (Home Assistant DB)
 *
 * Як працює:
 * 1. За замовчуванням НЕ навантажує ПК постійними запитами до Binance, а підтягує
 *    готову історію 24/7 із твого сервера Home Assistant (напр. https://ha.ibtek.uk/local/p2p-history.json).
 * 2. За бажанням також може паралельно опитувати Binance напряму (якщо увімкнено локальний збір)
 *    і об'єднувати (мержити) локальні та серверні записи по 5-хвилинках (`bucketTs`).
 */

const ALARM_KEEPALIVE = 'p2p_remote_sync_alarm';

const DEFAULT_SETTINGS = {
  isTracking: true,
  sourceMode: 'remote', // 'remote' = читати базу з Home Assistant, 'local' = опитувати Binance з браузера
  remoteUrl: 'https://ha.ibtek.uk/local/p2p-history.json',
  pollIntervalSec: 30,
  minOrderLimitUAH: 500,
  payTypes: ['PrivatBank', 'Monobank'],
  skipPromoted: true,
  dailyReportHour: 21,
  telegram: {
    enabled: true,
    botToken: '',
    chatId: '',
  },
};

let activeTimerId = null;
let isSyncing = false;

function updateExtensionIcon(isActive, badgeText = null) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const size = 32;
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');

      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#3B82F6' : '#474D57'; // Синій колір для HA Remote версії
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = isActive ? '#FCD535' : '#848E9C';
      ctx.stroke();

      ctx.strokeStyle = isActive ? '#FFFFFF' : '#AEB4BC';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(8, 20);
      ctx.lineTo(13, 14);
      ctx.lineTo(18, 17);
      ctx.lineTo(24, 10);
      ctx.stroke();

      const imageData = ctx.getImageData(0, 0, size, size);
      chrome.action.setIcon({ imageData: { 32: imageData } });
    }
  } catch (_) {}

  if (!isActive) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#474D57' });
  } else if (badgeText) {
    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: '#3B82F6' });
  }
}

function configurePollingLoop(settings) {
  if (activeTimerId) {
    clearInterval(activeTimerId);
    activeTimerId = null;
  }

  if (!settings.isTracking) {
    chrome.alarms.clear(ALARM_KEEPALIVE);
    updateExtensionIcon(false);
    return;
  }

  const sec = Math.max(5, Number(settings.pollIntervalSec) || 30);
  activeTimerId = setInterval(() => {
    syncData();
  }, sec * 1000);

  chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => initTracker());
chrome.runtime.onStartup.addListener(() => initTracker());

async function initTracker() {
  const data = await chrome.storage.local.get(['trackerSettings', 'rateHistory']);
  let settings = DEFAULT_SETTINGS;
  if (!data.trackerSettings) {
    await chrome.storage.local.set({ trackerSettings: DEFAULT_SETTINGS });
  } else {
    settings = {
      ...DEFAULT_SETTINGS,
      ...data.trackerSettings,
      telegram: { ...DEFAULT_SETTINGS.telegram, ...(data.trackerSettings.telegram || {}) },
    };
    await chrome.storage.local.set({ trackerSettings: settings });
  }
  if (!data.rateHistory) {
    await chrome.storage.local.set({ rateHistory: [] });
  }

  updateExtensionIcon(settings.isTracking, settings.isTracking ? 'HA' : 'OFF');
  configurePollingLoop(settings);
  if (settings.isTracking) {
    syncData();
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) {
    const store = await chrome.storage.local.get(['trackerSettings']);
    const settings = { ...DEFAULT_SETTINGS, ...(store.trackerSettings || {}) };
    if (!activeTimerId && settings.isTracking) {
      configurePollingLoop(settings);
    }
    syncData();
  }
});

initTracker();

// Завантаження бази з Home Assistant (p2p-history.json) та об'єднання з локальним кешем
async function fetchFromHomeAssistant(remoteUrl) {
  if (!remoteUrl) throw new Error('Не вказано URL Home Assistant');
  const sep = remoteUrl.includes('?') ? '&' : '?';
  const res = await fetch(`${remoteUrl}${sep}_t=${Date.now()}`, {
    method: 'GET',
    headers: { 'Cache-Control': 'no-cache' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return await res.json();
}

function mergeHistories(localList, remoteList) {
  const map = new Map();
  for (const item of localList || []) {
    if (item && item.bucketTs) map.set(item.bucketTs, item);
  }
  for (const r of remoteList || []) {
    if (!r || !r.bucketTs) continue;
    const existing = map.get(r.bucketTs);
    if (!existing || r.minPrice < existing.minPrice || (r.samples || 0) >= (existing.samples || 0)) {
      map.set(r.bucketTs, r);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => a.bucketTs - b.bucketTs)
    .slice(-25000);
}

async function syncData() {
  if (isSyncing) return;
  isSyncing = true;
  try {
    const store = await chrome.storage.local.get(['trackerSettings', 'rateHistory']);
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(store.trackerSettings || {}),
      telegram: { ...DEFAULT_SETTINGS.telegram, ...(store.trackerSettings?.telegram || {}) },
    };

    if (!settings.isTracking) {
      updateExtensionIcon(false);
      return;
    }

    if (settings.remoteUrl) {
      const remoteData = await fetchFromHomeAssistant(settings.remoteUrl);
      const remoteRecords = Array.isArray(remoteData?.records) ? remoteData.records : [];
      const merged = mergeHistories(store.rateHistory || [], remoteRecords);

      const lastSample =
        remoteData.lastSample ||
        (merged.length > 0
          ? {
              ts: merged[merged.length - 1].lastCheckTs || merged[merged.length - 1].bucketTs,
              best: {
                price: merged[merged.length - 1].minPrice,
                merchant: merged[merged.length - 1].merchant,
                minLimit: merged[merged.length - 1].minLimit,
                maxLimit: merged[merged.length - 1].maxLimit,
              },
              top5Avg: merged[merged.length - 1].top5Avg,
            }
          : null);

      if (lastSample?.best?.price) {
        updateExtensionIcon(true, Number(lastSample.best.price).toFixed(1));
      } else {
        updateExtensionIcon(true, 'HA');
      }

      await chrome.storage.local.set({
        rateHistory: merged,
        lastSample,
        lastRemoteSyncAt: Date.now(),
        lastRemoteError: null,
      });
    }
  } catch (err) {
    console.debug('[P2P Remote Tracker] Помилка синхронізації з HA:', err?.message || err);
    await chrome.storage.local.set({
      lastRemoteError: err?.message || String(err),
    });
  } finally {
    isSyncing = false;
  }
}

function getMedianValue(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function filterOutliersFromDataset(rawList) {
  if (!rawList || rawList.length === 0) return [];
  return rawList.map((item, idx) => {
    let price = item.minPrice;
    if (item.top5Avg && item.top5Avg - price > 0.55) {
      price = Number((item.top5Avg - 0.12).toFixed(2));
    }
    const start = Math.max(0, idx - 6);
    const end = Math.min(rawList.length - 1, idx + 6);
    const windowPrices = [];
    for (let j = start; j <= end; j++) {
      if (j === idx) continue;
      const p =
        rawList[j].top5Avg && rawList[j].top5Avg - rawList[j].minPrice > 0.55
          ? rawList[j].top5Avg - 0.12
          : rawList[j].minPrice;
      windowPrices.push(p);
    }
    if (windowPrices.length >= 3) {
      const localMedian = getMedianValue(windowPrices);
      if (localMedian - price > 0.50) {
        price = Number(localMedian.toFixed(2));
      }
    }
    return price !== item.minPrice ? { ...item, minPrice: price } : item;
  });
}

async function sendDailyTelegramSummary(history, settings) {
  const tg = settings?.telegram || DEFAULT_SETTINGS.telegram;
  if (!tg.enabled || !tg.botToken || !tg.chatId) {
    return { ok: false, error: 'Telegram не налаштовано' };
  }

  const cleanHistory = filterOutliersFromDataset(history);
  const cutoff24h = Date.now() - 24 * 3600 * 1000;
  const last24h = cleanHistory.filter((h) => h.bucketTs >= cutoff24h);
  const dataset = last24h.length > 0 ? last24h : cleanHistory;

  if (dataset.length === 0) {
    return { ok: false, error: 'Ще немає зібраних даних для звіту' };
  }

  let minItem = dataset[0];
  let maxItem = dataset[0];
  let sumPrice = 0;
  const byHour = Array.from({ length: 24 }, () => []);

  for (const item of dataset) {
    if (item.minPrice < minItem.minPrice) minItem = item;
    if (item.minPrice > maxItem.minPrice) maxItem = item;
    sumPrice += item.minPrice;
    const hour = new Date(item.bucketTs).getHours();
    byHour[hour].push(item.minPrice);
  }

  const avg24h = sumPrice / dataset.length;
  const hourRanking = byHour
    .map((prices, hour) => {
      if (prices.length === 0) return null;
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const min = Math.min(...prices);
      return { hour, avg, min, count: prices.length };
    })
    .filter(Boolean)
    .sort((a, b) => a.avg - b.avg);

  const medals = ['🥇', '🥈', '🥉'];
  const top3HoursText = hourRanking
    .slice(0, 3)
    .map(
      (h, idx) =>
        `  ${medals[idx] || '•'} *${String(h.hour).padStart(2, '0')}:00–${String(h.hour).padStart(2, '0')}:59* — сер. *${h.avg.toFixed(2)} ₴* (мін: ${h.min.toFixed(2)} ₴)`
    )
    .join('\n');

  const worst3HoursText = [...hourRanking]
    .reverse()
    .slice(0, 3)
    .map(
      (h, idx) =>
        `  🔺 #${idx + 1} *${String(h.hour).padStart(2, '0')}:00–${String(h.hour).padStart(2, '0')}:59* — сер. *${h.avg.toFixed(2)} ₴*`
    )
    .join('\n');

  const minTimeStr = new Date(minItem.bucketTs).toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const maxTimeStr = new Date(maxItem.bucketTs).toLocaleTimeString('uk-UA', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const latest = dataset[dataset.length - 1];

  const text = [
    '📊 *Об’єктивне зведення P2P USDT/UAH (Home Assistant DB)*',
    '',
    `💵 Поточний курс: *${latest.minPrice.toFixed(2)} UAH* (${latest.merchant})`,
    `📉 Реальний мінімум за добу: *${minItem.minPrice.toFixed(2)} UAH* (о ${minTimeStr}, ${minItem.merchant})`,
    `📈 Максимум за добу: *${maxItem.minPrice.toFixed(2)} UAH* (о ${maxTimeStr})`,
    `⚖️ Середній курс: *${avg24h.toFixed(2)} UAH*`,
    `📏 Реальний розкид: *${(maxItem.minPrice - minItem.minPrice).toFixed(2)} UAH*`,
    '',
    '🟢 *ТОП-3 найвигідніші години для купівлі:*',
    top3HoursText || '  Недостатньо даних',
    '',
    '🔴 *ТОП-3 найдорожчі години:*',
    worst3HoursText || '  Недостатньо даних',
    '',
    `🗂 Всього 5-хвилинних замірів за добу: *${dataset.length}*`,
  ]
    .filter(Boolean)
    .join('\n');

  const url = `https://api.telegram.org/bot${tg.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: tg.chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
  const data = await res.json();
  return { ok: Boolean(data?.ok), data };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FORCE_SAMPLE') {
    syncData().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'UPDATE_SETTINGS') {
    chrome.storage.local.set({ trackerSettings: msg.settings }).then(() => {
      configurePollingLoop(msg.settings);
      if (!msg.settings.isTracking) {
        updateExtensionIcon(false);
        sendResponse({ ok: true });
      } else {
        syncData().then(() => sendResponse({ ok: true }));
      }
    });
    return true;
  }
  if (msg.type === 'SEND_TELEGRAM_REPORT_NOW') {
    chrome.storage.local.get(['rateHistory', 'trackerSettings']).then(async (store) => {
      const history = Array.isArray(store.rateHistory) ? store.rateHistory : [];
      const settings = {
        ...DEFAULT_SETTINGS,
        ...(store.trackerSettings || {}),
        telegram: {
          ...DEFAULT_SETTINGS.telegram,
          ...(store.trackerSettings?.telegram || {}),
        },
      };
      const result = await sendDailyTelegramSummary(history, settings);
      sendResponse(result);
    });
    return true;
  }
});
