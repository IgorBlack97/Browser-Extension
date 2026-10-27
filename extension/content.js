/**
 * Content Script розширення Binance P2P Fast Auto-Buy Bot (USDT/UAH)
 * Автоматично підключається на сторінці Binance P2P + відслідковує відкриття сторінки ордера.
 */
(() => {
  const DEFAULT_CONFIG = {
    pluginActive: false, // Загальний тогл плагіна: чи показувати вікно на сторінці P2P
    enabled: false,      // За замовчуванням вимкнено, вмикається кнопкою "Старт" на панелі
    demoMode: false,     // Демо-режим: тільки моніторинг та сповіщення в ТГ без кліків та покупки
    maxPrice: 46.70,
    minAmountUAH: 500,
    maxAmountUAH: 5000,
    preferAmount: 'max',
    paymentMethods: [
      'Privat Bank (Universal Card)',
      'Monobank (Card)',
    ],
    skipPromoted: true,
    scanIntervalMs: 500,
    autoRefreshListMs: 2000,
    formWaitTimeoutMs: 5000,
    telegram: {
      enabled: true,
      botToken: '',
      chatId: '',
    },
  };

  let CONFIG = { ...DEFAULT_CONFIG };
  let isRunning = false;
  let isProcessingOrder = false;
  let scanScheduled = false;
  let lastRefreshTime = Date.now();
  let lastBadgeUpdateTime = 0;
  let scanCount = 0;
  let refreshCount = 0;
  let demoFoundCount = 0;
  const processedRowKeys = new Set();

  function isExtensionContextValid() {
    try {
      return typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // Перевіряємо, чи ми знаходимось саме на сторінці P2P або на сторінці відкритої P2P-угоди
  function isOnP2POrOrderPage() {
    const host = location.hostname;
    const path = location.pathname;
    if (host === 'c2c.binance.com' || host === 'p2p.binance.com') return true;
    if (
      path.includes('/p2p') ||
      path.includes('/c2c') ||
      path.includes('/fiatOrderDetail') ||
      path.includes('/orderDetail')
    ) {
      return true;
    }
    if (document.querySelector('.AdvTableList')) return true;
    return false;
  }

  function syncUIVisibility() {
    const shouldShow = Boolean(CONFIG.pluginActive) && isOnP2POrOrderPage();
    if (shouldShow) {
      if (!badge || !document.body.contains(badge)) {
        initUI();
      }
      checkIfOnOrderDetailPage();
      if (CONFIG.enabled && !isRunning) {
        startBot();
      }
    } else {
      if (isRunning) {
        isRunning = false;
        if (observer) observer.disconnect();
        if (intervalId) clearInterval(intervalId);
      }
      if (badge) {
        badge.remove();
        badge = null;
      }
    }
  }

  // Завантажуємо збережені налаштування з chrome.storage.local
  if (isExtensionContextValid() && chrome.storage?.local) {
    try {
      chrome.storage.local.get(['p2pBotConfig'], (res) => {
        if (chrome.runtime.lastError) return;
        if (res && res.p2pBotConfig) {
          CONFIG = {
            ...DEFAULT_CONFIG,
            ...res.p2pBotConfig,
            scanIntervalMs: DEFAULT_CONFIG.scanIntervalMs,
            autoRefreshListMs: DEFAULT_CONFIG.autoRefreshListMs,
            telegram: { ...DEFAULT_CONFIG.telegram, ...(res.p2pBotConfig.telegram || {}) },
          };
        }
        syncUIVisibility();
      });
    } catch (_) {
      syncUIVisibility();
    }
  } else {
    syncUIVisibility();
  }

  function saveConfig() {
    if (!isExtensionContextValid()) return;
    try {
      chrome.storage.local.set({ p2pBotConfig: CONFIG });
    } catch (_) {}
  }

  // Якщо сторінка перезавантажилась на сторінку самої угоди (fiatOrderDetail) — додатково шлемо підтвердження з прямим посиланням!
  function checkIfOnOrderDetailPage() {
    if (location.href.includes('fiatOrderDetail') || location.href.includes('orderDetail')) {
      const lastOrderKey = sessionStorage.getItem('__p2p_notified_order_url');
      if (lastOrderKey !== location.href) {
        sessionStorage.setItem('__p2p_notified_order_url', location.href);
        sendTelegramViaBackground(
          [
            '✅ *УГОДУ ВІДКРИТО НА BINANCE!*',
            `🔗 [Відкрити сторінку угоди](${location.href})`,
            `⏰ Час: ${new Date().toLocaleTimeString()}`,
            '',
            '👉 Перейдіть у браузер для оплати продавцю!'
          ].join('\n'),
          '✅ Угоду відкрито на Binance!',
          'Сторінка оплати ордера вже відкрита у вкладці.'
        );
        playAlertSound();
      }
    }
  }

  // Гучний і довгий звуковий сигнал (триває ~5 секунд, 5 серій переливів)
  function playAlertSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const pattern = [587.33, 783.99, 1046.5, 783.99, 1046.5]; // D5 - G5 - C6 - G5 - C6
      const repeats = 5; // 5 повторів по ~1 секунді = ~5 секунд звучання

      for (let r = 0; r < repeats; r++) {
        const cycleOffset = r * 1.05;
        pattern.forEach((freq, idx) => {
          const startTime = ctx.currentTime + cycleOffset + idx * 0.16;
          const duration = 0.14;

          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.frequency.value = freq;
          osc.type = 'triangle'; // Більш насичений і помітний звук, ніж звичайний sine

          gain.gain.setValueAtTime(0.35, startTime);
          gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(startTime);
          osc.stop(startTime + duration);
        });
      }
    } catch (_) {}
  }

  // Миттєва відправка в Background Service Worker (працює навіть під час перезавантаження вкладки!)
  function sendTelegramViaBackground(text, title, body) {
    if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken) return;

    if (isExtensionContextValid() && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: 'SEND_TELEGRAM',
          payload: {
            botToken: CONFIG.telegram.botToken,
            chatId: CONFIG.telegram.chatId,
            text,
            title,
            body,
          },
        });
        return;
      } catch (_) {}
    }

    // Фолбек, якщо розширення було перезавантажене без оновлення сторінки Binance
    const params = new URLSearchParams({
      chat_id: CONFIG.telegram.chatId,
      text: text,
      parse_mode: 'Markdown',
    });
    const img = new Image();
    img.src = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage?${params.toString()}`;
  }

  function notifyOrderAttempt(orderInfo, stageLabel = '🎯 Знайдено ордер — купуємо!') {
    playAlertSound();
    const text = [
      `🚨 *${stageLabel}*`,
      `👤 Продавець: *${orderInfo.merchant}*`,
      `💵 Ціна: *${orderInfo.price} UAH*`,
      `💰 Сума покупки: *${orderInfo.buyAmount} UAH*`,
      `💳 Обраний банк: *${orderInfo.chosenPayment || CONFIG.paymentMethods[0]}*`,
      `📊 Ліміти ордера: ${orderInfo.orderMin} - ${orderInfo.orderMax} UAH`,
      `🏦 Банки продавця: ${orderInfo.payments}`,
      `⏰ Час: ${new Date().toLocaleTimeString()}`,
      '',
      '👉 Швидко перейдіть у вкладку Binance!'
    ].join('\n');

    sendTelegramViaBackground(
      text,
      stageLabel,
      `${orderInfo.price} UAH | ${orderInfo.buyAmount} грн | ${orderInfo.chosenPayment}`
    );
  }

  // --- UI ПАНЕЛЬ НА СТОРІНЦІ ---
  let badge = null;

  function initUI() {
    badge = document.getElementById('p2p-bot-status-badge');
    if (badge) badge.remove();

    badge = document.createElement('div');
    badge.id = 'p2p-bot-status-badge';
    badge.style.cssText = [
      'position: fixed',
      'bottom: 16px',
      'right: 16px',
      'z-index: 999999',
      'background: #181A20',
      'color: #EAECEF',
      'border: 2px solid #FCD535',
      'border-radius: 10px',
      'padding: 12px 16px',
      'font-family: monospace, sans-serif',
      'font-size: 12px',
      'line-height: 1.5',
      'box-shadow: 0 8px 24px rgba(0,0,0,0.65)',
      'min-width: 295px',
    ].join(';');

    badge.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <strong id="p2p-ext-title" style="color:#FCD535;font-size:13px;">🤖 P2P Bot (ПАУЗА)</strong>
        <div style="display:flex;gap:6px;align-items:center;">
          <button id="p2p-ext-test-btn" title="Тест Telegram" style="background:#2B3139;color:#EAECEF;border:1px solid #474D57;border-radius:4px;padding:2px 6px;cursor:pointer;font-size:11px;">🔔 Тест ТГ</button>
          <button id="p2p-ext-toggle-btn" style="background:#0ECB81;color:#fff;border:none;border-radius:4px;padding:2px 10px;cursor:pointer;font-size:11px;font-weight:bold;">Старт</button>
          <button id="p2p-ext-close-btn" title="Вимкнути плагін і сховати вікно" style="background:transparent;color:#848E9C;border:none;cursor:pointer;font-size:14px;padding:0 2px;line-height:1;">✕</button>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:8px;">
        <div>
          <div style="color:#848E9C;font-size:10px;">Макс. ціна</div>
          <input id="p2p-inp-price" type="number" step="0.01" value="${CONFIG.maxPrice}" style="width:100%;background:#2B3139;color:#fff;border:1px solid #474D57;border-radius:4px;padding:3px 5px;font-size:12px;">
        </div>
        <div>
          <div style="color:#848E9C;font-size:10px;">Мін. грн</div>
          <input id="p2p-inp-min" type="number" step="50" value="${CONFIG.minAmountUAH}" style="width:100%;background:#2B3139;color:#fff;border:1px solid #474D57;border-radius:4px;padding:3px 5px;font-size:12px;">
        </div>
        <div>
          <div style="color:#848E9C;font-size:10px;">Макс. грн</div>
          <input id="p2p-inp-max" type="number" step="100" value="${CONFIG.maxAmountUAH}" style="width:100%;background:#2B3139;color:#fff;border:1px solid #474D57;border-radius:4px;padding:3px 5px;font-size:12px;">
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:6px;margin-bottom:6px;cursor:pointer;background:#2B3139;padding:4px 8px;border-radius:5px;border:1px solid #474D57;">
        <input id="p2p-inp-demo" type="checkbox" ${CONFIG.demoMode ? 'checked' : ''} style="cursor:pointer;accent-color:#FCD535;">
        <span style="font-size:11px;color:#FCD535;font-weight:bold;">📊 Демо-режим (тільки моніторинг в ТГ без покупки)</span>
      </label>
      <div>Банки: <b>Privat Bank &rarr; Monobank</b></div>
      <div>Оновлень (2с): <b id="p2p-ext-refreshes">0</b> | Змін: <b id="p2p-ext-scans">0</b> | Знайдено: <b id="p2p-ext-found" style="color:#FCD535;">0</b></div>
      <div>Найкращий зараз: <span id="p2p-ext-best" style="color:#0ECB81;">—</span></div>
      <div id="p2p-ext-status" style="margin-top:4px;color:#848E9C;">Натисніть "Старт" для запуску</div>
    `;

    document.body.appendChild(badge);

    const priceInp = badge.querySelector('#p2p-inp-price');
    const minInp = badge.querySelector('#p2p-inp-min');
    const maxInp = badge.querySelector('#p2p-inp-max');
    const demoInp = badge.querySelector('#p2p-inp-demo');

    const onInputChange = () => {
      CONFIG.maxPrice = parseFloat(priceInp.value) || CONFIG.maxPrice;
      CONFIG.minAmountUAH = parseFloat(minInp.value) || CONFIG.minAmountUAH;
      CONFIG.maxAmountUAH = parseFloat(maxInp.value) || CONFIG.maxAmountUAH;
      CONFIG.demoMode = Boolean(demoInp.checked);
      saveConfig();
      updateBadge(null, null, null, true);
    };

    priceInp.addEventListener('change', onInputChange);
    minInp.addEventListener('change', onInputChange);
    maxInp.addEventListener('change', onInputChange);
    demoInp.addEventListener('change', onInputChange);

    badge.querySelector('#p2p-ext-toggle-btn').onclick = (e) => {
      onInputChange();
      if (document.activeElement && badge.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      e.currentTarget.blur();
      if (isRunning) {
        stopBot('Зупинено користувачем.');
      } else {
        startBot();
      }
    };

    badge.querySelector('#p2p-ext-test-btn').onclick = () => {
      notifyOrderAttempt(
        {
          merchant: 'TEST_MERCHANT',
          price: CONFIG.maxPrice,
          buyAmount: CONFIG.minAmountUAH,
          orderMin: CONFIG.minAmountUAH,
          orderMax: CONFIG.maxAmountUAH,
          chosenPayment: CONFIG.paymentMethods[0],
          payments: CONFIG.paymentMethods.join(', '),
        },
        '🔔 Тестове сповіщення P2P Bot'
      );
      updateBadge('🔔 Тест відправлено в Telegram!', null, null, true);
    };

    badge.querySelector('#p2p-ext-close-btn').onclick = () => {
      CONFIG.pluginActive = false;
      CONFIG.enabled = false;
      saveConfig();
      syncUIVisibility();
    };
  }

  function updateBadge(statusText, bestOrderText = null, borderColor = null, force = false) {
    if (!badge) return;
    const now = Date.now();
    // Оновлюємо DOM бейджа не частіше ніж раз на 300 мс (або при force), щоб не навантажувати браузер
    if (!force && now - lastBadgeUpdateTime < 300) return;
    lastBadgeUpdateTime = now;

    const titleEl = badge.querySelector('#p2p-ext-title');
    const toggleBtn = badge.querySelector('#p2p-ext-toggle-btn');
    const refreshesEl = badge.querySelector('#p2p-ext-refreshes');
    const scansEl = badge.querySelector('#p2p-ext-scans');
    const foundEl = badge.querySelector('#p2p-ext-found');
    const bestEl = badge.querySelector('#p2p-ext-best');
    const statusEl = badge.querySelector('#p2p-ext-status');

    const modeLabel = isRunning
      ? CONFIG.demoMode
        ? 'ДЕМО-МОНІТОРИНГ'
        : 'АКТИВНИЙ'
      : 'ПАУЗА';
    const nextTitle = `🤖 P2P Bot (${modeLabel})`;
    if (titleEl && titleEl.textContent !== nextTitle) {
      titleEl.textContent = nextTitle;
      titleEl.style.color = isRunning ? '#0ECB81' : '#FCD535';
    }
    if (toggleBtn) {
      const nextBtnText = isRunning ? 'Стоп' : 'Старт';
      if (toggleBtn.textContent !== nextBtnText) {
        toggleBtn.textContent = nextBtnText;
        toggleBtn.style.background = isRunning ? '#F6465D' : '#0ECB81';
      }
    }
    if (refreshesEl) refreshesEl.textContent = String(refreshCount);
    if (scansEl) scansEl.textContent = String(scanCount);
    if (foundEl) foundEl.textContent = String(demoFoundCount);
    if (bestOrderText !== null && bestEl && bestEl.textContent !== bestOrderText) {
      bestEl.textContent = bestOrderText;
    }
    if (statusText && statusEl && statusEl.textContent !== statusText) {
      statusEl.textContent = statusText;
    }
    if (borderColor && badge.style.borderColor !== borderColor) {
      badge.style.borderColor = borderColor;
    }
  }

  // --- ЛОГІКА ПАРСИНГУ ТА ПОКУПКИ ---
  function matchesBankName(text, targetMethod) {
    const t = (text || '').trim().toLowerCase();
    const target = (targetMethod || '').trim().toLowerCase();
    if (!t || !target) return false;
    if (t === target) return true;
    if (target.includes('privat') && t.includes('privat bank')) return true;
    if (target.includes('monobank') && t.includes('monobank (card)')) return true;
    if (target.includes('monobank') && t === 'monobank') return true;
    return false;
  }

  function parseNumber(str) {
    if (!str) return NaN;
    const cleaned = str.replace(/,/g, '').replace(/[^\d.]/g, '');
    return parseFloat(cleaned);
  }

  // Коректний ввід тексту в React-інпут (щоб спрацював внутрішній стейт Binance)
  function setReactInputValue(input, value) {
    input.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    ).set;
    nativeInputValueSetter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  // Очікування появи елемента в DOM
  function waitForElement(selectorFn, timeout = CONFIG.formWaitTimeoutMs) {
    return new Promise((resolve) => {
      const start = performance.now();
      const check = () => {
        const el = selectorFn();
        if (el) return resolve(el);
        if (performance.now() - start >= timeout) return resolve(null);
        requestAnimationFrame(check);
      };
      check();
    });
  }

  // Автоматичний вибір методу оплати за пріоритетом (1. Privat Bank -> 2. Monobank (Card)) у розгорнутій формі
  async function selectPaymentMethodInForm(expandedRow, preferredMethods) {
    const methods =
      Array.isArray(preferredMethods) && preferredMethods.length > 0
        ? preferredMethods
        : CONFIG.paymentMethods;

    const scope = expandedRow || document;
    const formText = scope.textContent || '';

    if (!formText.includes('Set my payment method')) {
      for (const m of methods) {
        if (formText.toLowerCase().includes(m.toLowerCase())) {
          return m;
        }
      }
      return methods[0];
    }

    const triggerLabel = Array.from(scope.querySelectorAll('div, span')).find(
      (el) => el.children.length === 0 && el.textContent.trim() === 'Set my payment method'
    );
    const clickableTrigger =
      triggerLabel?.closest('.cursor-pointer') || triggerLabel?.parentElement || triggerLabel;

    // Запам'ятовуємо всі елементи, які були до кліку, щоб не клікнути на прихований фільтр у шапці сторінки або тултіп у таблиці
    const existingElements = new Set(document.querySelectorAll('*'));

    if (clickableTrigger) {
      clickableTrigger.click();
    } else {
      return methods[0];
    }

    let selectedMethodName = null;
    const optionEl = await waitForElement(() => {
      const candidates = Array.from(
        document.querySelectorAll(
          '.bn-modal-wrap *, .bn-drawer-wrap *, .bn-bubble-content *, .bn-select-overlay *, [role="dialog"] *, [role="listbox"] *, tr.bn-web-table-expanded-row *'
        )
      ).filter((el) => {
        if (el === triggerLabel || el.children.length !== 0) return false;
        // Ігноруємо опис умов продавця ("Advertisers' Terms")
        if (el.closest('.whitespace-pre-wrap')) return false;
        // Ігноруємо звичайні рядки таблиці ордерів (там є приховані тултіпи банків)
        if (el.closest('tr.bn-web-table-row')) return false;
        // Елемент має бути реально видимим на екрані (не прихований дропдаун верхнього фільтра!)
        if (el.getClientRects().length === 0) return false;
        // Або це новий елемент, який з'явився після кліку, або він всередині модального вікна
        if (
          existingElements.has(el) &&
          !el.closest('.bn-modal-wrap, .bn-drawer-wrap, [role="dialog"]')
        ) {
          return false;
        }
        return true;
      });

      if (candidates.length === 0) return null;

      for (const targetMethod of methods) {
        for (const el of candidates) {
          if (matchesBankName(el.textContent, targetMethod)) {
            selectedMethodName = targetMethod;
            return (
              el.closest('[role="option"]') ||
              el.closest('.bn-select-option') ||
              el.closest('.cursor-pointer') ||
              el.parentElement
            );
          }
        }
      }
      return null;
    }, 2500);

    if (optionEl) {
      optionEl.click();
      setTimeout(() => {
        const confirmBtn = Array.from(
          document.querySelectorAll(
            '.bn-modal-wrap button, .bn-drawer-wrap button, [role="dialog"] button'
          )
        ).find((b) => /confirm|ok|підтвердити/i.test(b.textContent.trim()));
        if (confirmBtn && !confirmBtn.disabled) {
          confirmBtn.click();
        }
      }, 80);
      return selectedMethodName;
    }

    return null;
  }

  function parseOrderRow(row) {
    const rowKey = row.getAttribute('data-row-key') || '';
    if (
      CONFIG.skipPromoted &&
      (row.classList.contains('AdvTableList__promoted-row') ||
        row.classList.contains('AdvTableList__promoted-header-row') ||
        rowKey.includes('Promoted'))
    ) {
      return null;
    }

    const buyBtn = row.querySelector('button#C2CofferList_btn_buy');
    if (!buyBtn || buyBtn.disabled || buyBtn.getAttribute('aria-disabled') === 'true') {
      return null;
    }

    const priceEl = row.querySelector('td[aria-colindex="2"] .headline5');
    const price = parseNumber(priceEl?.textContent);
    if (isNaN(price)) return null;

    const col3 = row.querySelector('td[aria-colindex="3"]');
    if (!col3) return null;

    const uahTexts = Array.from(col3.querySelectorAll('div'))
      .map((d) => d.textContent.trim())
      .filter((t) => t.endsWith('UAH') && !t.includes('-'));

    if (uahTexts.length < 2) return null;
    const orderMin = parseNumber(uahTexts[0]);
    const orderMax = parseNumber(uahTexts[uahTexts.length - 1]);
    if (isNaN(orderMin) || isNaN(orderMax)) return null;

    const merchant =
      row.querySelector('.merchantName-nickname')?.textContent.trim() || 'Невідомий';
    const paymentList = Array.from(row.querySelectorAll('.PaymentMethodItem__text')).map((el) =>
      el.textContent.trim()
    );
    const payments = paymentList.join(', ');

    return {
      row,
      rowKey,
      buyBtn,
      price,
      orderMin,
      orderMax,
      merchant,
      paymentList,
      payments,
    };
  }

  function evaluateOrder(order) {
    if (order.price > CONFIG.maxPrice) return null;

    const matchedMethods = CONFIG.paymentMethods.filter((targetMethod) =>
      order.paymentList.some((p) => matchesBankName(p, targetMethod))
    );

    if (matchedMethods.length === 0) return null;

    const effectiveMin = Math.max(CONFIG.minAmountUAH, order.orderMin);
    const effectiveMax = Math.min(CONFIG.maxAmountUAH, order.orderMax);

    if (effectiveMin > effectiveMax) return null;

    const buyAmount = CONFIG.preferAmount === 'min' ? effectiveMin : effectiveMax;
    return {
      ...order,
      buyAmount,
      matchedMethods,
      chosenPayment: matchedMethods[0],
    };
  }

  // Перевірка та автоматичне закриття модального вікна помилки ("This Ad is now offline. Please choose another Ad.")
  function checkAndDismissOfflineAdModal(targetOrder = null) {
    const confirmBtn = document.querySelector('button.ConfirmModal-confirm-btn');
    if (!confirmBtn) return false;

    const msgEl = document.querySelector('.ConfirmModal-message');
    const errorReason = msgEl?.textContent.trim() || 'This Ad is now offline. Please choose another Ad.';

    confirmBtn.click();

    const text = [
      '⚠️ *Не вдалося відкрити ордер (оголошення вже неактивне)*',
      targetOrder ? `👤 Продавець: *${targetOrder.merchant}*` : '',
      targetOrder ? `💵 Ціна: *${targetOrder.price} UAH* | Сума: *${targetOrder.buyAmount} UAH*` : '',
      `💬 Причина: _${errorReason}_`,
      `⏰ Час: ${new Date().toLocaleTimeString()}`,
      '',
      '🔄 *Бот автоматично закрив вікно і продовжує пошук наступного ордера!*'
    ]
      .filter(Boolean)
      .join('\n');

    sendTelegramViaBackground(
      text,
      '⚠️ Ордер вже розкупили / неактивний',
      'Бот натиснув Accept і продовжує пошук.'
    );

    updateBadge(
      '⚠️ Ордер вже неактивний (Offline). Шукаємо далі...',
      null,
      '#FCD535',
      true
    );

    return true;
  }

  let pendingRefreshTimeout = null;
  let lastRefreshClickAt = 0;

  async function executeBuy(targetOrder) {
    isProcessingOrder = true;
    processedRowKeys.add(targetOrder.rowKey);

    // МИТТЄВО скасовуємо будь-який відкладений клік автооновлення, щоб він не закрив/скинув форму покупки!
    if (pendingRefreshTimeout) {
      clearTimeout(pendingRefreshTimeout);
      pendingRefreshTimeout = null;
    }

    updateBadge(
      `🎯 Купуємо у ${targetOrder.merchant} за ${targetOrder.price} UAH (${targetOrder.buyAmount} грн)...`,
      `${targetOrder.price} UAH`,
      '#0ECB81',
      true
    );

    // НАДСИЛАЄМО СПОВІЩЕННЯ В TELEGRAM ОДРАЗУ ПРИ ЗНАХОДЖЕННІ ОРДЕРА (ДО ПЕРЕЗАВАНТАЖЕННЯ СТОРІНКИ!)
    notifyOrderAttempt(targetOrder, '🎯 Знайдено ордер — відкриваємо угоду!');

    // 1. Клікаємо на першу кнопку "Buy USDT"
    targetOrder.buyBtn.click();

    // 2. Чекаємо появи розгорнутої форми (або появи вікна "This Ad is now offline")
    let adWentOffline = false;
    let amountInput = await waitForElement(() => {
      if (checkAndDismissOfflineAdModal(targetOrder)) {
        adWentOffline = true;
        return null;
      }
      const inp = document.querySelector('input#C2CofferBuy_amount_input');
      if (inp) return inp;
      // Якщо рядок оновився в таблиці і форма закрилась — повторно тиснемо Buy USDT у цьому рядку
      const freshRow = document.querySelector(`tr[data-row-key="${targetOrder.rowKey}"]`);
      const freshBtn = freshRow?.querySelector('button#C2CofferList_btn_buy');
      if (freshBtn && !document.querySelector('tr.bn-web-table-expanded-row')) {
        freshBtn.click();
      }
      return null;
    }, 3000);

    if (adWentOffline || checkAndDismissOfflineAdModal(targetOrder)) {
      isProcessingOrder = false;
      lastRefreshTime = 0;
      triggerListRefreshIfNeeded();
      return;
    }

    if (!amountInput) {
      updateBadge('❌ Форма не відкрилась, шукаємо далі...', null, '#FCD535', true);
      isProcessingOrder = false;
      return;
    }

    // Функція введення суми (викликаємо зараз і повторно після вибору банку, якщо React перезавантажив форму)
    const fillAmount = (inp) => {
      let finalAmountToEnter = targetOrder.buyAmount;
      const placeholder = inp.getAttribute('placeholder') || '';
      if (placeholder.includes('-')) {
        const parts = placeholder.split('-');
        const liveMin = parseNumber(parts[0]);
        const liveMax = parseNumber(parts[1]);
        if (!isNaN(liveMin) && !isNaN(liveMax)) {
          if (finalAmountToEnter > liveMax) {
            finalAmountToEnter = Math.floor(liveMax);
          }
          if (finalAmountToEnter < liveMin && liveMin <= CONFIG.maxAmountUAH) {
            finalAmountToEnter = Math.ceil(liveMin);
          }
        }
      }
      setReactInputValue(inp, finalAmountToEnter);
    };

    // 3. Вводимо суму
    fillAmount(amountInput);

    // 4. Обираємо спосіб оплати (Privat -> Monobank)
    const expandedRow = document.querySelector('tr.bn-web-table-expanded-row');
    const actuallySelected = await selectPaymentMethodInForm(
      expandedRow,
      targetOrder.matchedMethods
    );
    if (actuallySelected) {
      targetOrder.chosenPayment = actuallySelected;
    }

    if (checkAndDismissOfflineAdModal(targetOrder)) {
      isProcessingOrder = false;
      lastRefreshTime = 0;
      triggerListRefreshIfNeeded();
      return;
    }

    // Підстраховка: якщо під час відкриття форми прилетіла відповідь від попереднього adv/search і скинула інпут суми — заповнюємо його знову
    const currentAmountInput = document.querySelector('input#C2CofferBuy_amount_input');
    if (currentAmountInput && !currentAmountInput.value) {
      fillAmount(currentAmountInput);
    }

    // 5. Чекаємо, поки фінальна кнопка "Buy USDT" стане активною, і тиснемо її
    const finalBuyBtn = await waitForElement(() => {
      if (checkAndDismissOfflineAdModal(targetOrder)) {
        adWentOffline = true;
        return null;
      }
      const inp = document.querySelector('input#C2CofferBuy_amount_input');
      if (inp && !inp.value) {
        fillAmount(inp);
      }
      const rowScope = document.querySelector('tr.bn-web-table-expanded-row') || document;
      const btn = rowScope.querySelector('button.bn-button__buy.data-size-large');
      if (
        btn &&
        !btn.classList.contains('inactive') &&
        btn.getAttribute('aria-disabled') !== 'true' &&
        !btn.disabled
      ) {
        return btn;
      }
      return null;
    }, 3500);

    if (adWentOffline || checkAndDismissOfflineAdModal(targetOrder)) {
      isProcessingOrder = false;
      lastRefreshTime = 0;
      triggerListRefreshIfNeeded();
      return;
    }

    if (finalBuyBtn) {
      finalBuyBtn.click();
      updateBadge(
        `🚀 Клікнули Buy USDT (${targetOrder.chosenPayment}), перевіряємо відкриття угоди...`,
        `${targetOrder.price} UAH`,
        '#0ECB81',
        true
      );

      // Чекаємо до 2.5 сек після фінального кліку: або сторінка перейде на угоду, або вискочить "This Ad is now offline"
      const offlineAfterClick = await waitForElement(() => {
        return document.querySelector('button.ConfirmModal-confirm-btn');
      }, 2500);

      if (offlineAfterClick && checkAndDismissOfflineAdModal(targetOrder)) {
        // Ордер не встиг відкритися (хтось забрав раніше) — продовжуємо роботу бота!
        isProcessingOrder = false;
        lastRefreshTime = 0;
        triggerListRefreshIfNeeded();
        return;
      }

      stopBot('Ордер активовано! Переходьте до оплати.');
      updateBadge(
        `🚀 Ордер створено (${targetOrder.chosenPayment})!`,
        `${targetOrder.price} UAH`,
        '#0ECB81',
        true
      );
    } else {
      stopBot('Форма заповнена. Завершіть клік вручну.');
      updateBadge(
        '⚠️ Форма заповнена! Натисніть Buy USDT вручну!',
        `${targetOrder.price} UAH`,
        'orange',
        true
      );
    }
  }

  function clearSearchAmountInputIfNeeded() {
    const searchAmountInput = document.querySelector('input#C2Csearchamount_searchbox_amount');
    if (searchAmountInput && searchAmountInput.value !== '') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      ).set;
      nativeSetter.call(searchAmountInput, '');
      searchAmountInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchAmountInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function triggerListRefreshIfNeeded() {
    if (!CONFIG.autoRefreshListMs || Date.now() - lastRefreshTime < CONFIG.autoRefreshListMs) {
      return;
    }
    // Не оновлюємо таблицю, якщо вже розгорнута форма покупки або курсор стоїть у текстовому полі налаштувань бота
    if (document.querySelector('tr.bn-web-table-expanded-row')) {
      return;
    }
    if (
      badge &&
      document.activeElement &&
      document.activeElement.tagName === 'INPUT' &&
      badge.contains(document.activeElement)
    ) {
      return;
    }

    lastRefreshTime = Date.now();
    refreshCount++;

    // Очищаємо поле суми, якщо там щось залишилось
    clearSearchAmountInputIfNeeded();

    // Оновлюємо список через перемикання сортування (Completed order number -> через 350 мс назад на Price,
    // щоб пройти 300 мс debounce React-компонента Binance і гарантовано викликати запит adv/search)
    const sortByTradesOpt = document.querySelector(
      '#C2CofferListFilter_dropdown_sortBy_trades, #C2CofferListFilter_dropdown_sortBy_completion'
    );
    const sortByPriceOpt = document.querySelector('#C2CofferListFilter_dropdown_sortBy_price');

    if (sortByTradesOpt && sortByPriceOpt) {
      lastRefreshClickAt = Date.now();
      sortByTradesOpt.click();
      if (pendingRefreshTimeout) clearTimeout(pendingRefreshTimeout);
      pendingRefreshTimeout = setTimeout(() => {
        pendingRefreshTimeout = null;
        if (!isProcessingOrder && !document.querySelector('tr.bn-web-table-expanded-row')) {
          lastRefreshClickAt = Date.now();
          sortByPriceOpt.click();
        }
      }, 350);
    }

    const refreshesEl = badge?.querySelector('#p2p-ext-refreshes');
    if (refreshesEl) refreshesEl.textContent = String(refreshCount);
  }

  let lastOrderKeysSignature = '';

  function scanTable(forceScan = false) {
    scanScheduled = false;
    if (!isRunning || isProcessingOrder) return;

    // Якщо на екрані висить модальне вікно "This Ad is now offline" — закриваємо його і продовжуємо
    if (checkAndDismissOfflineAdModal()) {
      lastRefreshTime = 0;
      triggerListRefreshIfNeeded();
      return;
    }

    const rows = document.querySelectorAll('tr.bn-web-table-row');
    if (rows.length === 0) {
      triggerListRefreshIfNeeded();
      return;
    }

    // Перевіряємо, чи реально змінився список ордерів у таблиці (за їхніми data-row-key та цінами)
    const currentSignature = Array.from(rows)
      .map((r) => {
        const key = r.getAttribute('data-row-key') || '';
        const p = r.querySelector('td[aria-colindex="2"] .headline5')?.textContent || '';
        return `${key}:${p}`;
      })
      .join('|');

    if (!forceScan && currentSignature === lastOrderKeysSignature) {
      triggerListRefreshIfNeeded();
      return;
    }
    lastOrderKeysSignature = currentSignature;

    scanCount++;
    const candidates = [];
    let bestSeen = null;

    for (const row of rows) {
      const parsed = parseOrderRow(row);
      if (!parsed) continue;

      if (!bestSeen || parsed.price < bestSeen.price) {
        bestSeen = parsed;
      }

      if (processedRowKeys.has(parsed.rowKey)) continue;

      const matched = evaluateOrder(parsed);
      if (matched) {
        candidates.push(matched);
      }
    }

    const bestStr = bestSeen
      ? `${bestSeen.price} UAH (${bestSeen.orderMin}-${bestSeen.orderMax} грн)`
      : 'немає рядків';

    updateBadge('🔍 Скануємо таблицю...', bestStr, '#0ECB81');

    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if (a.price !== b.price) return a.price - b.price;
        const aPriority = CONFIG.paymentMethods.indexOf(a.chosenPayment);
        const bPriority = CONFIG.paymentMethods.indexOf(b.chosenPayment);
        return aPriority - bPriority;
      });

      // У демо-режимі НЕ купуємо і НЕ зупиняємо бота, а логуємо всі знайдені підходящі ордери в Telegram і моніторимо далі!
      if (CONFIG.demoMode) {
        for (const match of candidates) {
          processedRowKeys.add(match.rowKey);
          demoFoundCount++;
          notifyOrderAttempt(
            match,
            `📊 [ДЕМО #${demoFoundCount}] Знайдено вигідний ордер (без покупки)`
          );
        }
        const top = candidates[0];
        updateBadge(
          `📊 Демо: знайдено ${top.price} UAH у ${top.merchant} (${top.buyAmount} грн)`,
          bestStr,
          '#FCD535',
          true
        );
        triggerListRefreshIfNeeded();
        return;
      }

      demoFoundCount++;
      executeBuy(candidates[0]);
      return;
    }

    triggerListRefreshIfNeeded();
  }

  function scheduleScan(mutations) {
    if (!isRunning || isProcessingOrder || scanScheduled) return;

    // Ігноруємо мутації всередині самої панелі бота, щоб ніколи не виникало рекурсивного циклу!
    if (Array.isArray(mutations)) {
      const hasExternalMutation = mutations.some(
        (m) => !badge || !badge.contains(m.target)
      );
      if (!hasExternalMutation) return;
    }

    scanScheduled = true;
    requestAnimationFrame(scanTable);
  }

  let observer = null;
  let intervalId = null;

  function startBot() {
    isRunning = true;
    isProcessingOrder = false;
    lastOrderKeysSignature = '';
    lastRefreshTime = 0;
    CONFIG.enabled = true;
    saveConfig();

    if (observer) observer.disconnect();
    observer = new MutationObserver(scheduleScan);
    const tbody = document.querySelector('.AdvTableList tbody') || document.querySelector('.AdvTableList');
    if (tbody) {
      // Стежимо ТІЛЬКИ за додаванням/видаленням рядків у tbody таблиці (без subtree на всю сторінку!)
      observer.observe(tbody, { childList: true });
    }

    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(() => scanTable(false), CONFIG.scanIntervalMs);

    updateBadge('🔍 Скануємо таблицю...', null, '#0ECB81', true);
    scanTable(true);
  }

  function stopBot(reason = 'Зупинено.') {
    isRunning = false;
    CONFIG.enabled = false;
    saveConfig();

    if (observer) observer.disconnect();
    if (intervalId) clearInterval(intervalId);

    updateBadge(`🛑 ${reason}`, null, '#FCD535', true);
  }

  // Синхронізація зі спливаючим підменю на іконці розширення (popup.html)
  if (isExtensionContextValid() && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.p2pBotConfig?.newValue) {
        const next = changes.p2pBotConfig.newValue;
        CONFIG.pluginActive = Boolean(next.pluginActive);
        CONFIG.maxPrice = next.maxPrice ?? CONFIG.maxPrice;
        CONFIG.minAmountUAH = next.minAmountUAH ?? CONFIG.minAmountUAH;
        CONFIG.maxAmountUAH = next.maxAmountUAH ?? CONFIG.maxAmountUAH;
        CONFIG.demoMode = Boolean(next.demoMode);
        if (next.telegram) {
          CONFIG.telegram = { ...CONFIG.telegram, ...next.telegram };
        }

        syncUIVisibility();

        if (badge) {
          const priceInp = badge.querySelector('#p2p-inp-price');
          const minInp = badge.querySelector('#p2p-inp-min');
          const maxInp = badge.querySelector('#p2p-inp-max');
          const demoInp = badge.querySelector('#p2p-inp-demo');
          if (priceInp && document.activeElement !== priceInp) priceInp.value = CONFIG.maxPrice;
          if (minInp && document.activeElement !== minInp) minInp.value = CONFIG.minAmountUAH;
          if (maxInp && document.activeElement !== maxInp) maxInp.value = CONFIG.maxAmountUAH;
          if (demoInp) demoInp.checked = CONFIG.demoMode;
        }

        if (CONFIG.pluginActive && isOnP2POrOrderPage()) {
          if (next.enabled && !isRunning) {
            startBot();
          } else if (!next.enabled && isRunning) {
            stopBot('Зупинено через меню розширення.');
          } else {
            updateBadge(null, null, null, true);
          }
        }
      }
    });
  }

  // Відслідковуємо переходи між сторінками всередині SPA Binance (напр. зі Spot на P2P і навпаки)
  let lastCheckedHref = location.href;
  setInterval(() => {
    if (location.href !== lastCheckedHref) {
      lastCheckedHref = location.href;
      syncUIVisibility();
    }
  }, 1000);
})();
