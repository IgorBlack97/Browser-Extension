/**
 * Binance P2P (C2C) Fast Auto-Buy Bot (USDT/UAH)
 * Запуск: вставте цей код у консоль браузера (F12 -> Console) на сторінці Binance P2P.
 * Для зупинки введіть у консолі: stopP2PBot()
 * Для тесту Telegram введіть: testP2PTelegram()
 */
(() => {
  // ================= НАЛАШТУВАННЯ БОТА =================
  const CONFIG = {
    demoMode: false,                               // true = Демо-режим (тільки моніторинг і сповіщення в ТГ без покупки)
    maxPrice: 46.70,                               // Максимальна ціна USDT у грн (UAH), яка вас влаштовує
    minAmountUAH: 500,                             // Мінімальна сума покупки (грн)
    maxAmountUAH: 5000,                            // Максимальна сума покупки (грн)
    preferAmount: 'max',                           // 'max' — купувати максимум із доступного в діапазоні, 'min' — мінімум
    paymentMethods: [                              // Список бажаних банків за пріоритетом (якщо немає 1-го, обере 2-й)
      'Privat Bank (Universal Card)',
      'Monobank (Card)',
    ],
    skipPromoted: true,                            // Ігнорувати рекламні оголошення (Promoted Ad)

    // Інтервали роботи (мс)
    scanIntervalMs: 500,      // Таймер перевірки (основну миттєву реакцію робить MutationObserver при оновленні таблиці)
    autoRefreshListMs: 2000,  // Примусове оновлення списку ордерів кожні 2 сек
    formWaitTimeoutMs: 5000,  // Скільки чекати відкриття форми після кліку на перший Buy USDT

    // Налаштування Telegram для сповіщень
    telegram: {
      enabled: true,
      botToken: '', // Токен вашого бота від @BotFather
      chatId: '',   // Ваш Chat ID
    },
  };
  // =====================================================

  if (window.__p2pBotStop) {
    window.__p2pBotStop();
  }

  let isRunning = true;
  let isProcessingOrder = false;
  let scanScheduled = false;
  let lastRefreshTime = Date.now();
  let lastBadgeUpdateTime = 0;
  let scanCount = 0;
  const processedRowKeys = new Set();

  // --- ПАНЕЛЬ СТАТУСУ ПРЯМО НА ЕКРАНІ BINANCE ---
  let badge = document.getElementById('p2p-bot-status-badge');
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
    'box-shadow: 0 8px 24px rgba(0,0,0,0.6)',
    'min-width: 280px',
  ].join(';');
  badge.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <strong id="p2p-b-title" style="color:#FCD535;font-size:13px;">🤖 P2P Bot (АКТИВНИЙ)</strong>
      <button id="p2p-bot-stop-btn" style="background:#F6465D;color:#fff;border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;">Стоп</button>
    </div>
    <div>Ціль: <b>&le; ${CONFIG.maxPrice} UAH</b> | ${CONFIG.minAmountUAH}-${CONFIG.maxAmountUAH} грн</div>
    <div>Банки: <b>Privat Bank &rarr; Monobank</b></div>
    <div>Перевірок: <b id="p2p-b-scans">0</b></div>
    <div>Найкращий зараз: <span id="p2p-b-best" style="color:#0ECB81;">—</span></div>
    <div id="p2p-b-status" style="margin-top:4px;color:#848E9C;">Запуск...</div>
  `;
  document.body.appendChild(badge);
  badge.querySelector('#p2p-bot-stop-btn').onclick = () => stopBot('Зупинено кнопкою на екрані.');

  function updateBadge(statusText, bestOrderText = '—', borderColor = '#FCD535', force = false) {
    if (!badge) return;
    const now = Date.now();
    if (!force && now - lastBadgeUpdateTime < 300) return;
    lastBadgeUpdateTime = now;

    badge.style.borderColor = borderColor;
    const titleEl = badge.querySelector('#p2p-b-title');
    const scansEl = badge.querySelector('#p2p-b-scans');
    const bestEl = badge.querySelector('#p2p-b-best');
    const statusEl = badge.querySelector('#p2p-b-status');

    if (titleEl) titleEl.textContent = `🤖 P2P Bot (${isRunning ? 'АКТИВНИЙ' : 'ЗУПИНЕНО'})`;
    if (scansEl) scansEl.textContent = String(scanCount);
    if (bestEl && bestOrderText) bestEl.textContent = bestOrderText;
    if (statusEl && statusText) statusEl.textContent = statusText;
  }

  const log = (msg, style = 'color: #FCD535; font-weight: bold;') => {
    const formatted = `[P2P Bot ${new Date().toLocaleTimeString()}] ${msg}`;
    console.log(`%c${formatted}`, style);
    console.warn(formatted);
  };

  // Перевірка відповідності назви банку
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

  // Відправка в Telegram в обхід Content Security Policy (CSP connect-src) на Binance
  function sendTelegramBypassCSP(text) {
    const params = new URLSearchParams({
      chat_id: CONFIG.telegram.chatId,
      text: text,
      parse_mode: 'Markdown',
    });
    const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage?${params.toString()}`;

    const img = new Image();
    img.src = url;

    img.onerror = () => {
      try {
        const win = window.open(url, '_blank', 'width=100,height=100,left=9999,top=9999');
        if (win) {
          setTimeout(() => {
            try { win.close(); } catch (_) {}
          }, 1500);
        }
      } catch (_) {}
    };
  }

  // Відправка сповіщення в Telegram + гучний звуковий сигнал у браузері (~5 секунд)
  async function notifyOrderActivated(orderInfo) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const pattern = [587.33, 783.99, 1046.5, 783.99, 1046.5];
      const repeats = 5;

      for (let r = 0; r < repeats; r++) {
        const cycleOffset = r * 1.05;
        pattern.forEach((freq, idx) => {
          const startTime = ctx.currentTime + cycleOffset + idx * 0.16;
          const duration = 0.14;

          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.frequency.value = freq;
          osc.type = 'triangle';

          gain.gain.setValueAtTime(0.35, startTime);
          gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(startTime);
          osc.stop(startTime + duration);
        });
      }
    } catch (_) {}

    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('🚨 P2P Ордер активовано!', {
          body: `${orderInfo.price} UAH | Сума: ${orderInfo.buyAmount} UAH | ${orderInfo.chosenPayment || ''}`,
        });
      }
    } catch (_) {}

    if (!CONFIG.telegram.enabled || !CONFIG.telegram.botToken || CONFIG.telegram.botToken === 'YOUR_BOT_TOKEN') {
      log('Telegram не налаштовано (вкажіть botToken та chatId).', 'color: orange;');
      return;
    }

    const text = [
      '🚨 *P2P Ордер активовано!*',
      `👤 Продавець: *${orderInfo.merchant}*`,
      `💵 Ціна: *${orderInfo.price} UAH*`,
      `💰 Сума покупки: *${orderInfo.buyAmount} UAH*`,
      `💳 Обраний метод оплати: *${orderInfo.chosenPayment || CONFIG.paymentMethods[0]}*`,
      `📊 Ліміти ордера: ${orderInfo.orderMin} - ${orderInfo.orderMax} UAH`,
      `🏦 Банки продавця: ${orderInfo.payments}`,
      `⏰ Час: ${new Date().toLocaleTimeString()}`,
      '',
      '👉 Швидко перейдіть у вкладку Binance для завершення оплати!'
    ].join('\n');

    sendTelegramBypassCSP(text);
    log('✅ Запит на сповіщення в Telegram відправлено (в обхід CSP)!', 'color: #0ECB81; font-weight: bold;');
  }

  function parseNumber(str) {
    if (!str) return NaN;
    const cleaned = str.replace(/,/g, '').replace(/[^\d.]/g, '');
    return parseFloat(cleaned);
  }

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

  async function selectPaymentMethodInForm(expandedRow, preferredMethods) {
    const methods = Array.isArray(preferredMethods) && preferredMethods.length > 0
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

    const existingElements = new Set(document.querySelectorAll('*'));

    if (clickableTrigger) {
      clickableTrigger.click();
      log(`💳 Відкриваємо список способів оплати (пріоритет: ${methods.join(' -> ')})...`);
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
        if (el.closest('.whitespace-pre-wrap')) return false;
        if (el.closest('tr.bn-web-table-row')) return false;
        if (el.getClientRects().length === 0) return false;
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
      log(`✅ Обрано спосіб оплати: ${selectedMethodName}`, 'color: #0ECB81;');

      setTimeout(() => {
        const confirmBtn = Array.from(
          document.querySelectorAll('.bn-modal-wrap button, .bn-drawer-wrap button, [role="dialog"] button')
        ).find((b) => /confirm|ok|підтвердити/i.test(b.textContent.trim()));
        if (confirmBtn && !confirmBtn.disabled) {
          confirmBtn.click();
        }
      }, 80);

      return selectedMethodName;
    }

    log(`⚠️ Не вдалося автоматично знайти жоден із методів (${methods.join(', ')}) у списку.`, 'color: orange;');
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

    if (matchedMethods.length === 0) {
      return null;
    }

    const effectiveMin = Math.max(CONFIG.minAmountUAH, order.orderMin);
    const effectiveMax = Math.min(CONFIG.maxAmountUAH, order.orderMax);

    if (effectiveMin > effectiveMax) {
      return null;
    }

    const buyAmount = CONFIG.preferAmount === 'min' ? effectiveMin : effectiveMax;
    return {
      ...order,
      buyAmount,
      matchedMethods,
      chosenPayment: matchedMethods[0],
    };
  }

  let pendingRefreshTimeout = null;

  function checkAndDismissOfflineAdModal(targetOrder = null) {
    const confirmBtn = document.querySelector('button.ConfirmModal-confirm-btn');
    if (!confirmBtn) return false;

    const msgEl = document.querySelector('.ConfirmModal-message');
    const errorReason = msgEl?.textContent.trim() || 'This Ad is now offline. Please choose another Ad.';

    confirmBtn.click();
    log(`⚠️ Ордер недоступний (${errorReason}). Натиснуто Accept, продовжуємо пошук!`, 'color: orange; font-weight: bold;');

    if (CONFIG.telegram.enabled && CONFIG.telegram.botToken && CONFIG.telegram.botToken !== 'YOUR_BOT_TOKEN') {
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
      sendTelegramBypassCSP(text);
    }

    updateBadge('⚠️ Ордер вже неактивний (Offline). Шукаємо далі...', '—', '#FCD535', true);
    return true;
  }

  async function executeBuy(targetOrder) {
    isProcessingOrder = true;
    processedRowKeys.add(targetOrder.rowKey);

    if (pendingRefreshTimeout) {
      clearTimeout(pendingRefreshTimeout);
      pendingRefreshTimeout = null;
    }

    updateBadge(
      `🎯 Купуємо у ${targetOrder.merchant} за ${targetOrder.price} UAH (${targetOrder.buyAmount} грн, ${targetOrder.chosenPayment})...`,
      `${targetOrder.price} UAH`,
      '#0ECB81',
      true
    );

    log(
      `🎯 Знайдено ордер! Продавець: ${targetOrder.merchant} | Ціна: ${targetOrder.price} UAH | Сума: ${targetOrder.buyAmount} UAH | Банк: ${targetOrder.chosenPayment}`,
      'color: #0ECB81; font-weight: bold; font-size: 14px;'
    );

    // Відправляємо сповіщення в Telegram ОДРАЗУ (ДО кліку на кнопку Buy, щоб перезавантаження сторінки не обірвало запит!)
    notifyOrderActivated(targetOrder);

    // 1. Клікаємо на першу кнопку "Buy USDT" у рядку ордера
    targetOrder.buyBtn.click();

    // 2. Чекаємо появи розгорнутої форми з полем вводу суми #C2CofferBuy_amount_input
    let adWentOffline = false;
    const amountInput = await waitForElement(() => {
      if (checkAndDismissOfflineAdModal(targetOrder)) {
        adWentOffline = true;
        return null;
      }
      const inp = document.querySelector('input#C2CofferBuy_amount_input');
      if (inp) return inp;
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
      log('❌ Не вдалося дочекатися поля вводу суми (#C2CofferBuy_amount_input). Продовжуємо пошук...', 'color: #F6465D;');
      isProcessingOrder = false;
      return;
    }

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
      log(`✍️ Введено суму: ${finalAmountToEnter} UAH`);
    };

    // 3. Вводимо суму в поле "You Pay" (UAH)
    fillAmount(amountInput);

    // 4. Обираємо спосіб оплати за пріоритетом (спочатку Privat Bank, якщо немає — Monobank (Card))
    const expandedRow = document.querySelector('tr.bn-web-table-expanded-row');
    const actuallySelected = await selectPaymentMethodInForm(expandedRow, targetOrder.matchedMethods);
    if (actuallySelected) {
      targetOrder.chosenPayment = actuallySelected;
    }

    if (checkAndDismissOfflineAdModal(targetOrder)) {
      isProcessingOrder = false;
      lastRefreshTime = 0;
      triggerListRefreshIfNeeded();
      return;
    }

    // 5. Чекаємо, поки фінальна кнопка "Buy USDT" у формі стане активною, і тиснемо її
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
      log(`🚀 Натиснуто фінальну кнопку Buy USDT (${targetOrder.chosenPayment})! Перевіряємо відкриття угоди...`, 'color: #0ECB81; font-weight: bold; font-size: 16px;');

      const offlineAfterClick = await waitForElement(() => {
        return document.querySelector('button.ConfirmModal-confirm-btn');
      }, 2500);

      if (offlineAfterClick && checkAndDismissOfflineAdModal(targetOrder)) {
        isProcessingOrder = false;
        lastRefreshTime = 0;
        triggerListRefreshIfNeeded();
        return;
      }

      updateBadge(`🚀 Ордер створено (${targetOrder.chosenPayment})!`, `${targetOrder.price} UAH`, '#0ECB81', true);
      stopBot('Ордер успішно активовано. Бота зупинено.');
    } else {
      log(
        '⚠️ Суму введено, але фінальна кнопка Buy USDT ще не активна. Сповіщаємо в Telegram!',
        'color: orange; font-weight: bold;'
      );
      updateBadge('⚠️ Форма заповнена! Натисніть Buy USDT вручну!', `${targetOrder.price} UAH`, 'orange', true);
      stopBot('Форма відкрита та заповнена. Завершіть підтвердження вручну.');
    }
  }

  let refreshCount = 0;

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
    if (document.querySelector('tr.bn-web-table-expanded-row')) {
      return;
    }

    lastRefreshTime = Date.now();
    refreshCount++;

    clearSearchAmountInputIfNeeded();

    const sortByTradesOpt = document.querySelector(
      '#C2CofferListFilter_dropdown_sortBy_trades, #C2CofferListFilter_dropdown_sortBy_completion'
    );
    const sortByPriceOpt = document.querySelector('#C2CofferListFilter_dropdown_sortBy_price');

    if (sortByTradesOpt && sortByPriceOpt) {
      sortByTradesOpt.click();
      if (pendingRefreshTimeout) clearTimeout(pendingRefreshTimeout);
      pendingRefreshTimeout = setTimeout(() => {
        pendingRefreshTimeout = null;
        if (!isProcessingOrder && !document.querySelector('tr.bn-web-table-expanded-row')) {
          sortByPriceOpt.click();
        }
      }, 350);
    }
  }

  let lastOrderKeysSignature = '';

  function scanTable(forceScan = false) {
    scanScheduled = false;
    if (!isRunning || isProcessingOrder) return;

    const rows = document.querySelectorAll('tr.bn-web-table-row');
    if (rows.length === 0) {
      triggerListRefreshIfNeeded();
      return;
    }

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

    updateBadge('🔍 Скануємо таблицю...', bestStr);

    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if (a.price !== b.price) return a.price - b.price;
        const aPriority = CONFIG.paymentMethods.indexOf(a.chosenPayment);
        const bPriority = CONFIG.paymentMethods.indexOf(b.chosenPayment);
        return aPriority - bPriority;
      });

      if (CONFIG.demoMode) {
        for (const match of candidates) {
          processedRowKeys.add(match.rowKey);
          notifyOrderActivated(match);
          log(
            `📊 [ДЕМО] Знайдено ордер: ${match.merchant} | ${match.price} UAH | Сума: ${match.buyAmount} UAH | Банк: ${match.chosenPayment}`
          );
        }
        updateBadge(
          `📊 Демо: знайдено ${candidates[0].price} UAH (${candidates[0].merchant})`,
          bestStr,
          '#FCD535',
          true
        );
        triggerListRefreshIfNeeded();
        return;
      }

      executeBuy(candidates[0]);
      return;
    }

    triggerListRefreshIfNeeded();
  }

  function scheduleScan(mutations) {
    if (!isRunning || isProcessingOrder || scanScheduled) return;
    if (Array.isArray(mutations)) {
      const hasExternalMutation = mutations.some(
        (m) => !badge || !badge.contains(m.target)
      );
      if (!hasExternalMutation) return;
    }
    scanScheduled = true;
    requestAnimationFrame(scanTable);
  }

  const observer = new MutationObserver(scheduleScan);

  const tbody = document.querySelector('.AdvTableList tbody') || document.querySelector('.AdvTableList');
  if (tbody) {
    observer.observe(tbody, { childList: true });
  }

  const intervalId = setInterval(() => scanTable(false), CONFIG.scanIntervalMs);

  function stopBot(reason = 'Зупинено користувачем.') {
    isRunning = false;
    observer.disconnect();
    clearInterval(intervalId);
    updateBadge(`🛑 ${reason}`, '—', '#F6465D', true);
    log(`🛑 ${reason}`, 'color: #F6465D; font-weight: bold;');
  }

  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  window.stopP2PBot = stopBot;
  window.__p2pBotStop = stopBot;
  window.testP2PTelegram = () =>
    notifyOrderActivated({
      merchant: 'TEST_MERCHANT',
      price: CONFIG.maxPrice,
      buyAmount: CONFIG.minAmountUAH,
      orderMin: CONFIG.minAmountUAH,
      orderMax: CONFIG.maxAmountUAH,
      chosenPayment: CONFIG.paymentMethods[0],
      payments: CONFIG.paymentMethods.join(', '),
    });

  log(
    `✅ Бот запущено! Шукаємо USDT <= ${CONFIG.maxPrice} UAH | Сума: ${CONFIG.minAmountUAH} - ${CONFIG.maxAmountUAH} UAH | Банки: ${CONFIG.paymentMethods.join(' -> ')}. Для зупинки: stopP2PBot()`
  );
  scanTable();
})();
