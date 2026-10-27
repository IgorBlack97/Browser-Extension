const statusPill = document.getElementById('status-pill');
const masterToggleBox = document.getElementById('master-toggle-box');
const inpPluginActive = document.getElementById('inp-plugin-active');
const inpPrice = document.getElementById('inp-price');
const inpMin = document.getElementById('inp-min');
const inpMax = document.getElementById('inp-max');
const inpDemo = document.getElementById('inp-demo');
const inpTgEnabled = document.getElementById('inp-tg-enabled');
const inpTgToken = document.getElementById('inp-tg-token');
const inpTgChat = document.getElementById('inp-tg-chat');
const btnTestTg = document.getElementById('btn-test-tg');
const btnToggle = document.getElementById('btn-toggle');

let config = {
  pluginActive: false, // Чи увімкнений сам плагін (чи показувати вікно на сторінці P2P)
  enabled: false,      // Чи запущене активне сканування таблиці
  demoMode: false,
  maxPrice: 46.7,
  minAmountUAH: 500,
  maxAmountUAH: 5000,
  telegram: {
    enabled: true,
    botToken: '',
    chatId: '',
  },
};

async function loadConfig() {
  const res = await chrome.storage.local.get(['p2pBotConfig']);
  if (res.p2pBotConfig) {
    config = {
      ...config,
      ...res.p2pBotConfig,
      telegram: {
        ...config.telegram,
        ...(res.p2pBotConfig.telegram || {}),
      },
    };
  }
  inpPluginActive.checked = Boolean(config.pluginActive);
  inpPrice.value = config.maxPrice;
  inpMin.value = config.minAmountUAH;
  inpMax.value = config.maxAmountUAH;
  inpDemo.checked = Boolean(config.demoMode);
  inpTgEnabled.checked = config.telegram.enabled !== false;
  inpTgToken.value = config.telegram.botToken || '';
  inpTgChat.value = config.telegram.chatId || '';
  renderState();
}

function renderState() {
  masterToggleBox.className = config.pluginActive ? 'master-toggle active' : 'master-toggle';

  if (!config.pluginActive) {
    statusPill.textContent = 'ВИМКНЕНО';
    statusPill.className = 'pill pill-off';
    btnToggle.textContent = '▶️ Активувати і запустити';
    btnToggle.className = 'btn btn-start';
  } else if (config.enabled) {
    statusPill.textContent = config.demoMode ? 'ДЕМО' : 'СКАНУЄ';
    statusPill.className = 'pill pill-on';
    btnToggle.textContent = '⏸ Зупинити сканування';
    btnToggle.className = 'btn btn-stop';
  } else {
    statusPill.textContent = 'УВІМКНЕНО (ПАУЗА)';
    statusPill.className = 'pill pill-ready';
    btnToggle.textContent = '▶️ Запустити сканування';
    btnToggle.className = 'btn btn-start';
  }
}

function saveChanges() {
  config.pluginActive = Boolean(inpPluginActive.checked);
  if (!config.pluginActive) {
    // Якщо вимкнули плагін — автоматично зупиняємо і сканування
    config.enabled = false;
  }
  config.maxPrice = parseFloat(inpPrice.value) || config.maxPrice;
  config.minAmountUAH = parseFloat(inpMin.value) || config.minAmountUAH;
  config.maxAmountUAH = parseFloat(inpMax.value) || config.maxAmountUAH;
  config.demoMode = Boolean(inpDemo.checked);
  config.telegram = {
    enabled: Boolean(inpTgEnabled.checked),
    botToken: inpTgToken.value.trim(),
    chatId: inpTgChat.value.trim(),
  };
  chrome.storage.local.set({ p2pBotConfig: config });
  renderState();
}

inpTgToken.onfocus = () => { inpTgToken.type = 'text'; };
inpTgToken.onblur = () => { inpTgToken.type = 'password'; saveChanges(); };

inpPluginActive.onchange = saveChanges;
inpPrice.onchange = saveChanges;
inpMin.onchange = saveChanges;
inpMax.onchange = saveChanges;
inpDemo.onchange = saveChanges;
inpTgEnabled.onchange = saveChanges;
inpTgToken.onchange = saveChanges;
inpTgChat.onchange = saveChanges;

btnTestTg.onclick = () => {
  saveChanges();
  if (!config.telegram.botToken || !config.telegram.chatId) {
    alert('Вкажіть Bot Token та Chat ID!');
    return;
  }
  btnTestTg.textContent = '⏳ Надсилаємо...';
  chrome.runtime.sendMessage(
    {
      type: 'SEND_TELEGRAM',
      payload: {
        botToken: config.telegram.botToken,
        chatId: config.telegram.chatId,
        text: '🔔 *Тестове сповіщення P2P Auto-Buy Bot!*\nВаші ключі Telegram налаштовані успішно.',
        title: '🔔 Тест P2P Bot',
        body: 'Ключі Telegram працюють коректно!',
      },
    },
    (res) => {
      btnTestTg.textContent = res && res.ok ? '✅ Успішно надіслано!' : '❌ Помилка (перевірте токен)';
      setTimeout(() => {
        btnTestTg.textContent = '🔔 Перевірити сповіщення Telegram';
      }, 2500);
    }
  );
};

btnToggle.onclick = () => {
  if (!config.pluginActive) {
    config.pluginActive = true;
    inpPluginActive.checked = true;
    config.enabled = true;
  } else {
    config.enabled = !config.enabled;
  }
  saveChanges();
};

loadConfig();
