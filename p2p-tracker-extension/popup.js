const statusBadge = document.getElementById('status-badge');
const curPrice = document.getElementById('cur-price');
const curMerchant = document.getElementById('cur-merchant');
const totalRecords = document.getElementById('total-records');
const selPollInterval = document.getElementById('sel-poll-interval');
const inpMinLimit = document.getElementById('inp-min-limit');
const inpTgEnabled = document.getElementById('inp-tg-enabled');
const inpTgToken = document.getElementById('inp-tg-token');
const inpTgChat = document.getElementById('inp-tg-chat');
const btnToggle = document.getElementById('btn-toggle');
const btnDashboard = document.getElementById('btn-dashboard');
const btnTg = document.getElementById('btn-tg');

let currentSettings = {
  isTracking: true,
  pollIntervalSec: 15,
  minOrderLimitUAH: 500,
  telegram: {
    enabled: true,
    botToken: '',
    chatId: '',
  },
};

async function renderPopup() {
  const store = await chrome.storage.local.get(['trackerSettings', 'rateHistory', 'lastSample']);
  if (store.trackerSettings) {
    currentSettings = {
      ...currentSettings,
      ...store.trackerSettings,
      telegram: {
        ...currentSettings.telegram,
        ...(store.trackerSettings.telegram || {}),
      },
    };
  }
  const history = Array.isArray(store.rateHistory) ? store.rateHistory : [];
  const lastSample = store.lastSample;

  if (selPollInterval) {
    selPollInterval.value = String(currentSettings.pollIntervalSec || 15);
  }
  if (inpMinLimit && document.activeElement !== inpMinLimit) {
    inpMinLimit.value = currentSettings.minOrderLimitUAH || 500;
  }
  inpTgEnabled.checked = currentSettings.telegram.enabled !== false;
  if (document.activeElement !== inpTgToken) {
    inpTgToken.value = currentSettings.telegram.botToken || '';
  }
  if (document.activeElement !== inpTgChat) {
    inpTgChat.value = currentSettings.telegram.chatId || '';
  }

  if (currentSettings.isTracking) {
    statusBadge.textContent = `АКТИВНИЙ (${currentSettings.pollIntervalSec || 15}с)`;
    statusBadge.className = 'status-pill status-on';
    btnToggle.textContent = '⏸ Зупинити збір курсу';
    btnToggle.className = 'btn btn-toggle-stop';
  } else {
    statusBadge.textContent = 'ЗУПИНЕНО';
    statusBadge.className = 'status-pill status-off';
    btnToggle.textContent = '▶️ Запустити збір курсу';
    btnToggle.className = 'btn btn-toggle-start';
  }

  if (lastSample && lastSample.best) {
    curPrice.textContent = `${lastSample.best.price.toFixed(2)} ₴`;
    curMerchant.textContent = `${lastSample.best.merchant} (${lastSample.best.minLimit}-${lastSample.best.maxLimit} грн) • ${new Date(lastSample.ts).toLocaleTimeString('uk-UA')}`;
  } else if (history.length > 0) {
    const last = history[history.length - 1];
    curPrice.textContent = `${last.minPrice.toFixed(2)} ₴`;
    curMerchant.textContent = `${last.merchant}`;
  }

  totalRecords.textContent = `Зібрано 5-хвилинок: ${history.length}`;
}

function saveSettings() {
  currentSettings = {
    ...currentSettings,
    pollIntervalSec: parseInt(selPollInterval.value, 10) || 15,
    minOrderLimitUAH: parseFloat(inpMinLimit.value) || 500,
    telegram: {
      enabled: Boolean(inpTgEnabled.checked),
      botToken: inpTgToken.value.trim(),
      chatId: inpTgChat.value.trim(),
    },
  };
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: currentSettings }, () => {
    renderPopup();
  });
}

inpTgToken.onfocus = () => { inpTgToken.type = 'text'; };
inpTgToken.onblur = () => { inpTgToken.type = 'password'; saveSettings(); };
selPollInterval.onchange = saveSettings;
inpMinLimit.onchange = saveSettings;
inpTgEnabled.onchange = saveSettings;
inpTgToken.onchange = saveSettings;
inpTgChat.onchange = saveSettings;

btnToggle.onclick = () => {
  const nextSettings = {
    ...currentSettings,
    isTracking: !currentSettings.isTracking,
  };
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: nextSettings }, () => {
    renderPopup();
  });
};

btnDashboard.onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
};

btnTg.onclick = () => {
  saveSettings();
  btnTg.textContent = '⏳ Надсилаємо...';
  chrome.runtime.sendMessage({ type: 'SEND_TELEGRAM_REPORT_NOW' }, (res) => {
    btnTg.textContent = res && res.ok ? '✅ Надіслано!' : '❌ Помилка (перевірте токен/дані)';
    setTimeout(() => {
      btnTg.textContent = '✈️ Надіслати зведення в ТГ';
    }, 2000);
  });
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.lastSample || changes.rateHistory)) {
    renderPopup();
  }
});

renderPopup();
