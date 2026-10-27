/**
 * Background Service Worker для Binance P2P Rate Tracker (USDT/UAH)
 *
 * Як працює:
 * 1. Опитує публічний ендпоінт Binance P2P (POST /bapi/c2c/v2/friendly/c2c/adv/search)
 *    із заданою користувачем частотою (напр. кожні 5, 10, 15, 30 або 60 секунд).
 * 2. Поєднує високочастотний setInterval (для інтервалів < 60 сек) та chrome.alarms (щоб будити
 *    Service Worker кожні 30 сек, якщо браузер перевів його в неактивний стан).
 * 3. Протягом кожної 5-хвилинки утримує АБСОЛЮТНИЙ МІНІМУМ ціни.
 * 4. Динамічно малює іконку розширення: ЯСКРАВО-ЗЕЛЕНА коли трекер запущений і СІРА коли зупинений.
 * 5. Щодня у вказану годину (або по кнопці) надсилає аналітичне зведення в Telegram.
 */

const ALARM_KEEPALIVE = 'p2p_rate_keepalive';

const DEFAULT_SETTINGS = {
  isTracking: true,
  pollIntervalSec: 15, // Частота опитування за замовчуванням: раз на 15 секунд
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
let currentIntervalSec = 15;
let isCollecting = false;

// Малювання кольорової (активної) або сірої (вимкненої) іконки розширення через OffscreenCanvas
function updateExtensionIcon(isActive, badgeText = null) {
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const size = 32;
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');

      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
      ctx.fillStyle = isActive ? '#0ECB81' : '#474D57';
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = isActive ? '#FCD535' : '#848E9C';
      ctx.stroke();

      ctx.strokeStyle = isActive ? '#181A20' : '#AEB4BC';
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
    chrome.action.setBadgeBackgroundColor({ color: '#0ECB81' });
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

  const sec = Math.max(3, Number(settings.pollIntervalSec) || 15);
  currentIntervalSec = sec;

  // Запускаємо таймер із обраною частотою в секундах
  activeTimerId = setInterval(() => {
    collectSample();
  }, sec * 1000);

  // Будильник кожні 0.5 хв (30 сек — мінімум у Chrome MV3), щоб піднімати Service Worker, якщо він заснув
  chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  initTracker();
});

chrome.runtime.onStartup.addListener(() => {
  initTracker();
});

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

  updateExtensionIcon(settings.isTracking, settings.isTracking ? '...' : 'OFF');
  configurePollingLoop(settings);
  if (settings.isTracking) {
    collectSample();
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) {
    // Якщо Service Worker прокинувся після сну — перезапускаємо інтервал і робимо замір
    const store = await chrome.storage.local.get(['trackerSettings']);
    const settings = { ...DEFAULT_SETTINGS, ...(store.trackerSettings || {}) };
    if (!activeTimerId && settings.isTracking) {
      configurePollingLoop(settings);
    }
    collectSample();
  }
});

// Відновлюємо цикл одразу при завантаженні воркера
initTracker();

function getFiveMinBucket(ts = Date.now()) {
  const FIVE_MIN_MS = 5 * 60 * 1000;
  return Math.floor(ts / FIVE_MIN_MS) * FIVE_MIN_MS;
}

async function fetchBestP2POffers(settings) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return [];
  }

  const payload = {
    fiat: 'UAH',
    page: 1,
    rows: 20,
    tradeType: 'BUY',
    asset: 'USDT',
    countries: [],
    proMerchantAds: false,
    shieldMerchantAds: false,
    filterType: 'tradable',
    periods: [],
    additionalKycVerifyFilter: 0,
    publisherType: null,
    payTypes: settings.payTypes && settings.payTypes.length ? settings.payTypes : [],
    classifies: ['mass', 'profession', 'fiat_trade'],
  };

  const endpoints = [
    'https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    'https://www.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
  ];

  let json = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        json = await res.json();
        break;
      }
    } catch (_) {
      // Якщо один із піддоменів тимчасово недоступний — пробуємо наступний
    }
  }

  if (!json) {
    return [];
  }
  const list = Array.isArray(json?.data) ? json.data : [];

  const validOffers = [];
  for (const item of list) {
    if (settings.skipPromoted && item.privilegeDesc) {
      continue;
    }
    const adv = item.adv;
    const advertiser = item.advertiser;
    if (!adv) continue;

    const price = parseFloat(adv.price);
    const minLimit = parseFloat(adv.minSingleTransAmount);
    const maxLimit = parseFloat(adv.dynamicMaxSingleTransAmount || adv.maxSingleTransAmount);
    const availableUSDT = parseFloat(adv.surplusAmount);

    if (isNaN(price) || isNaN(maxLimit)) continue;

    if (settings.minOrderLimitUAH && maxLimit < settings.minOrderLimitUAH) {
      continue;
    }

    const banks = Array.isArray(adv.tradeMethods)
      ? adv.tradeMethods.map((m) => m.tradeMethodName || m.identifier).join(', ')
      : '';

    validOffers.push({
      price,
      minLimit,
      maxLimit,
      availableUSDT,
      merchant: advertiser?.nickName || 'Unknown',
      banks,
    });
  }

  validOffers.sort((a, b) => a.price - b.price);

  // Фільтруємо аномальні ордери з помилковою ціною (напр. 44.00 грн при ринку 46.50 грн):
  // якщо в стакані є достатньо оголошень, обчислюємо медіану ТОП-5 (з 2-го по 6-й ордер)
  // і відкидаємо оголошення, які дешевші за ринкову медіану більше ніж на 1.5% (~0.70 грн).
  if (validOffers.length >= 4) {
    const refSlice = validOffers.slice(1, Math.min(6, validOffers.length));
    const refPrices = refSlice.map((o) => o.price).sort((a, b) => a - b);
    const refMedian = refPrices[Math.floor(refPrices.length / 2)];
    const maxAllowedDrop = refMedian * 0.015; // 1.5% відхилення вниз від найближчих конкурентів
    return validOffers.filter((o) => refMedian - o.price <= maxAllowedDrop);
  }

  return validOffers;
}

function getMedianValue(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Очищення масиву замірів від короткочасних аномальних/помилкових прострілів ціни (напр. 44.00 грн при ринку 46.40 грн)
function filterOutliersFromDataset(rawList) {
  if (!rawList || rawList.length === 0) return [];

  return rawList.map((item, idx) => {
    let price = item.minPrice;

    // 1. Якщо minPrice відірвався вниз від top5Avg тієї ж 5-хвилинки більше ніж на 0.55 грн
    if (item.top5Avg && item.top5Avg - price > 0.55) {
      price = Number((item.top5Avg - 0.12).toFixed(2));
    }

    // 2. Звірка з локальною медіаною сусідніх 5-хвилинок (±6 точок навколо)
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

async function sendDailyTelegramSummary(history, settings, isManual = false) {
  const tg = settings?.telegram || DEFAULT_SETTINGS.telegram;
  if (!tg.enabled || !tg.botToken || !tg.chatId) {
    return { ok: false, error: 'Telegram не налаштовано' };
  }

  // Спочатку очищаємо історію від випадкових/помилкових прострілів ціни
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
    isManual
      ? '📊 *Об’єктивне зведення P2P USDT/UAH (без аномалій)*'
      : '📊 *Щоденне зведення курсу P2P USDT/UAH (за 24 год, без аномалій)*',
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

async function checkAndSendDailyReportIfNeeded(history, settings) {
  const now = new Date();
  const currentHour = now.getHours();
  const targetHour =
    typeof settings.dailyReportHour === 'number' ? settings.dailyReportHour : 21;

  if (currentHour !== targetHour) return;

  const todayKey = now.toISOString().slice(0, 10);
  const store = await chrome.storage.local.get(['lastDailyReportDate']);
  if (store.lastDailyReportDate === todayKey) {
    return;
  }

  if (history.length < 3) return;

  const res = await sendDailyTelegramSummary(history, settings, false);
  if (res.ok) {
    await chrome.storage.local.set({ lastDailyReportDate: todayKey });
  }
}

async function collectSample() {
  if (isCollecting) return;
  isCollecting = true;
  try {
    const store = await chrome.storage.local.get(['trackerSettings', 'rateHistory']);
    const settings = {
      ...DEFAULT_SETTINGS,
      ...(store.trackerSettings || {}),
      telegram: {
        ...DEFAULT_SETTINGS.telegram,
        ...(store.trackerSettings?.telegram || {}),
      },
    };

    if (!settings.isTracking) {
      updateExtensionIcon(false);
      return;
    }

    const offers = await fetchBestP2POffers(settings);
    if (offers.length === 0) return;

    const best = offers[0];
    const top5Avg =
      offers.slice(0, Math.min(5, offers.length)).reduce((s, o) => s + o.price, 0) /
      Math.min(5, offers.length);

    const now = Date.now();
    const bucketTs = getFiveMinBucket(now);
    const history = Array.isArray(store.rateHistory) ? store.rateHistory : [];

    updateExtensionIcon(true, best.price.toFixed(1));

    const lastIdx = history.length - 1;
    if (lastIdx >= 0 && history[lastIdx].bucketTs === bucketTs) {
      const currentRecord = history[lastIdx];
      currentRecord.samples = (currentRecord.samples || 1) + 1;
      currentRecord.lastCheckTs = now;
      currentRecord.lastPrice = best.price;

      if (best.price < currentRecord.minPrice) {
        currentRecord.minPrice = best.price;
        currentRecord.minAtTs = now;
        currentRecord.merchant = best.merchant;
        currentRecord.minLimit = best.minLimit;
        currentRecord.maxLimit = best.maxLimit;
        currentRecord.banks = best.banks;
      }
      if (best.price > (currentRecord.maxPriceInBucket || best.price)) {
        currentRecord.maxPriceInBucket = best.price;
      }
      currentRecord.top5Avg = Number(top5Avg.toFixed(2));
      history[lastIdx] = currentRecord;
    } else {
      history.push({
        bucketTs,
        minAtTs: now,
        lastCheckTs: now,
        minPrice: best.price,
        maxPriceInBucket: best.price,
        lastPrice: best.price,
        top5Avg: Number(top5Avg.toFixed(2)),
        merchant: best.merchant,
        minLimit: best.minLimit,
        maxLimit: best.maxLimit,
        banks: best.banks,
        samples: 1,
      });
    }

    if (history.length > 20000) {
      history.splice(0, history.length - 20000);
    }

    await chrome.storage.local.set({
      rateHistory: history,
      lastSample: {
        ts: now,
        best,
        top5Avg: Number(top5Avg.toFixed(2)),
      },
    });

    await checkAndSendDailyReportIfNeeded(history, settings);
  } catch (err) {
    // Використовуємо console.debug замість console.error, щоб тимчасова втрата інтернету / сон ноутбука
    // не підсвічувала червону кнопку "Errors" у списку розширень chrome://extensions
    console.debug('[P2P Rate Tracker] Тимчасова помилка мережі:', err?.message || err);
  } finally {
    isCollecting = false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'FORCE_SAMPLE') {
    collectSample().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'UPDATE_SETTINGS') {
    chrome.storage.local.set({ trackerSettings: msg.settings }).then(() => {
      configurePollingLoop(msg.settings);
      if (!msg.settings.isTracking) {
        updateExtensionIcon(false);
        sendResponse({ ok: true });
      } else {
        collectSample().then(() => sendResponse({ ok: true }));
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
      const result = await sendDailyTelegramSummary(history, settings, true);
      sendResponse(result);
    });
    return true;
  }
});
