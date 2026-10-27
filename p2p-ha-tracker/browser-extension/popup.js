const statusBadge = document.getElementById('status-badge');
const curPrice = document.getElementById('cur-price');
const curMerchant = document.getElementById('cur-merchant');
const totalRecords = document.getElementById('total-records');
const syncStatus = document.getElementById('sync-status');
const inpRemoteUrl = document.getElementById('inp-remote-url');
const btnSyncNow = document.getElementById('btn-sync-now');
const btnDashboard = document.getElementById('btn-dashboard');
const btnToggle = document.getElementById('btn-toggle');

let currentSettings = {
  isTracking: true,
  remoteUrl: 'https://ha.ibtek.uk/local/p2p-history.json',
  pollIntervalSec: 30,
};

async function renderPopup() {
  const store = await chrome.storage.local.get([
    'trackerSettings',
    'rateHistory',
    'lastSample',
    'lastRemoteSyncAt',
    'lastRemoteError',
  ]);
  if (store.trackerSettings) {
    currentSettings = { ...currentSettings, ...store.trackerSettings };
  }
  const history = Array.isArray(store.rateHistory) ? store.rateHistory : [];
  const lastSample = store.lastSample;

  if (document.activeElement !== inpRemoteUrl) {
    inpRemoteUrl.value = currentSettings.remoteUrl || 'https://ha.ibtek.uk/local/p2p-history.json';
  }

  if (currentSettings.isTracking) {
    statusBadge.textContent = 'HA ONLINE';
    statusBadge.className = 'status-pill status-on';
    btnToggle.textContent = '⏸ Вимкнути авто-синхронізацію';
    btnToggle.className = 'btn btn-toggle-stop';
  } else {
    statusBadge.textContent = 'ПАУЗА';
    statusBadge.className = 'status-pill status-off';
    btnToggle.textContent = '▶️ Увімкнути авто-синхронізацію';
    btnToggle.className = 'btn btn-toggle-start';
  }

  if (lastSample && lastSample.best) {
    curPrice.textContent = `${Number(lastSample.best.price).toFixed(2)} ₴`;
    curMerchant.textContent = `${lastSample.best.merchant} (${lastSample.best.minLimit}-${lastSample.best.maxLimit} грн)`;
  } else if (history.length > 0) {
    const last = history[history.length - 1];
    curPrice.textContent = `${Number(last.minPrice).toFixed(2)} ₴`;
    curMerchant.textContent = `${last.merchant}`;
  }

  totalRecords.textContent = `Зібрано 5-хвилинок у базі: ${history.length}`;

  if (store.lastRemoteError) {
    syncStatus.style.color = '#F6465D';
    syncStatus.textContent = `⚠️ Помилка: ${store.lastRemoteError}`;
  } else if (store.lastRemoteSyncAt) {
    syncStatus.style.color = '#0ECB81';
    syncStatus.textContent = `✅ Синхронізовано з HA о ${new Date(store.lastRemoteSyncAt).toLocaleTimeString('uk-UA')}`;
  }
}

function saveSettings() {
  currentSettings = {
    ...currentSettings,
    remoteUrl: inpRemoteUrl.value.trim(),
  };
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: currentSettings }, () => {
    renderPopup();
  });
}

inpRemoteUrl.onchange = saveSettings;

btnSyncNow.onclick = () => {
  saveSettings();
  btnSyncNow.textContent = '⏳ Завантажуємо з Home Assistant...';
  chrome.runtime.sendMessage({ type: 'FORCE_SAMPLE' }, () => {
    btnSyncNow.textContent = '🔄 Підтягнути дані з Home Assistant зараз';
    renderPopup();
  });
};

btnToggle.onclick = () => {
  currentSettings = {
    ...currentSettings,
    isTracking: !currentSettings.isTracking,
  };
  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings: currentSettings }, () => {
    renderPopup();
  });
};

btnDashboard.onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') renderPopup();
});

renderPopup();
