/**
 * Page-level Network Hook (MAIN world, document_start).
 * Перехоплює запити /bapi/c2c/v2/friendly/c2c/adv/search перед відправкою на сервер Binance
 * і видаляє поле transAmount (та order), щоб зміна поля суми в UI використовувалась ВИКЛЮЧНО
 * як тригер оновлення кожні 2 секунди, але сервер повертав УСІ ордери без фільтрації за сумою!
 */
(() => {
  function sanitizeSearchBody(bodyStr) {
    if (typeof bodyStr !== 'string' || !bodyStr.includes('"fiat"')) return bodyStr;
    try {
      const data = JSON.parse(bodyStr);
      delete data.transAmount;
      delete data.order;
      return JSON.stringify(data);
    } catch (_) {
      return bodyStr;
    }
  }

  // 1. Перехоплення window.fetch
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (
          url.includes('/bapi/c2c/v2/friendly/c2c/adv/search') &&
          init &&
          typeof init.body === 'string'
        ) {
          init = { ...init, body: sanitizeSearchBody(init.body) };
        }
      } catch (_) {}
      return origFetch.call(this, input, init);
    };
  }

  // 2. Перехоплення XMLHttpRequest
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__p2pUrl = typeof url === 'string' ? url : '';
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (
        this.__p2pUrl &&
        this.__p2pUrl.includes('/bapi/c2c/v2/friendly/c2c/adv/search') &&
        typeof body === 'string'
      ) {
        body = sanitizeSearchBody(body);
      }
    } catch (_) {}
    return origSend.call(this, body);
  };
})();
