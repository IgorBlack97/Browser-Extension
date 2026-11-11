(() => {
  if (window.__ibkrXrayContent) return;
  window.__ibkrXrayContent = true;

  const pending = new Map();

  function countPositions(snapshot) {
    const byAccount = snapshot?.positionsByAccount || {};
    return Object.values(byAccount).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.source !== "ibkr-xray" || !data.snapshot) return;
    const waiter = data.requestId ? pending.get(data.requestId) : null;
    if (waiter) {
      pending.delete(data.requestId);
      waiter(data.snapshot);
    }
    if (!data.snapshot.error && countPositions(data.snapshot) > 0) {
      chrome.runtime.sendMessage({ type: "SNAPSHOT", snapshot: data.snapshot });
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "PULL") return;
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      sendResponse({
        ok: false,
        error: "Портал не відповів. Оновіть сторінку Client Portal після встановлення розширення.",
      });
    }, 20000);
    pending.set(requestId, (snapshot) => {
      clearTimeout(timer);
      sendResponse({ ok: true, snapshot });
    });
    window.postMessage({ source: "ibkr-xray-cmd", cmd: "pull", requestId }, location.origin);
    return true;
  });
})();
