/**
 * Background Service Worker для Binance P2P Auto-Buy Bot.
 * Працює у фоні браузера, відправляє сповіщення в Telegram і підсвічує іконку розширення:
 * - Сіра (OFF) — коли плагін вимкнено (вікно приховане)
 * - Жовта (RDY / DEMO) — коли плагін активовано (вікно на P2P відкрите) або працює демо-режим
 * - Зелена (ON) — коли бот активно сканує і купує
 */

function updateBotIcon(pluginActive, enabled, demoMode = false) {
  const isActive = Boolean(pluginActive);
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const size = 32;
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');

      ctx.beginPath();
      ctx.arc(size / 2, size / 2, 14, 0, Math.PI * 2);
      if (!isActive) {
        ctx.fillStyle = '#474D57'; // Сірий — плагін вимкнено
      } else if (enabled) {
        ctx.fillStyle = demoMode ? '#FCD535' : '#0ECB81'; // Зелений (або жовтий у демо) — сканує
      } else {
        ctx.fillStyle = '#FCD535'; // Жовтий — плагін активовано (на паузі)
      }
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = isActive ? '#EAECEF' : '#848E9C';
      ctx.stroke();

      ctx.fillStyle = isActive ? '#181A20' : '#AEB4BC';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('B', size / 2, size / 2 + 1);

      const imageData = ctx.getImageData(0, 0, size, size);
      chrome.action.setIcon({ imageData: { 32: imageData } });
    }
  } catch (_) {}

  if (!isActive) {
    chrome.action.setBadgeText({ text: 'OFF' });
    chrome.action.setBadgeBackgroundColor({ color: '#474D57' });
  } else if (enabled) {
    chrome.action.setBadgeText({ text: demoMode ? 'DEMO' : 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: demoMode ? '#FCD535' : '#0ECB81' });
  } else {
    chrome.action.setBadgeText({ text: 'P2P' });
    chrome.action.setBadgeBackgroundColor({ color: '#FCD535' });
  }
}

async function syncIconWithStorage() {
  const res = await chrome.storage.local.get(['p2pBotConfig']);
  const cfg = res.p2pBotConfig || {};
  updateBotIcon(Boolean(cfg.pluginActive), Boolean(cfg.enabled), Boolean(cfg.demoMode));
}

chrome.runtime.onInstalled.addListener(syncIconWithStorage);
chrome.runtime.onStartup.addListener(syncIconWithStorage);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.p2pBotConfig) {
    const cfg = changes.p2pBotConfig.newValue || {};
    updateBotIcon(Boolean(cfg.pluginActive), Boolean(cfg.enabled), Boolean(cfg.demoMode));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SEND_TELEGRAM') {
    const { botToken, chatId, text, title, body } = message.payload;

    if (title && chrome.notifications) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'https://bin.bnbstatic.com/static/images/common/favicon.ico',
        title: title,
        message: body || 'Перевірте вкладку Binance!',
        priority: 2,
      });
    }

    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text,
        parse_mode: 'Markdown',
      }),
    })
      .then((res) => res.json())
      .then((data) => {
        sendResponse({ ok: true, data });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err) });
      });

    return true;
  }
});
